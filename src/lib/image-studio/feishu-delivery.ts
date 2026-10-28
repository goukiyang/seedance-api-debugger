import { randomUUID } from 'node:crypto';
import type { Notification, Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { feedbackTenantToken } from '@/lib/feedback/delivery';
import { LEASE_MS, SEND_WINDOW_MS } from '@/lib/feedback/notification';
import { videoFeishuBinding } from '@/lib/video/feishu-notification';
import { VideoFeishuError, VIDEO_FEISHU_SITE } from '@/lib/video/feishu-contract';
import { uploadImageFeishuOriginal, sendVideoFeishuMessage } from '@/lib/video/feishu-transport';
import { studioTaskHasViewableOutput } from './dimension-mismatch';
import { publicPricingTaskState } from './pricing-state';
import { authorizedImageFeishuTask } from './feishu-notification';
import { imageFeishuSourceStamp, prepareImageFeishuSource } from './feishu-source';
import { IMAGE_FEISHU_TYPE, IMAGE_FEISHU_ATTEMPTS, parseImageFeishuEvent } from './feishu-contract';

type Db = Prisma.TransactionClient;
type Row = Pick<Notification, 'id' | 'type' | 'channel' | 'status' | 'target_user_id' | 'metadata_json'>;
const WORK_LEASE_MS = LEASE_MS * 4;
const CONSUMER_KEY = 'image.feishu.consumer-lease.v1';
const safeError = (error: unknown) => error instanceof VideoFeishuError ? error : new VideoFeishuError('image_original_unavailable', 503, false, true);

/** One durable event per real output task. No source prompt/reference enters any transport payload. */
export async function deliverImageFeishuNotification(db: Db, row: Row, heartbeat: () => Promise<boolean> = async () => true) {
  if (row.type !== IMAGE_FEISHU_TYPE || row.channel !== 'feishu' || row.status !== 'pending') return 'ignored';
  const meta = parseImageFeishuEvent(row.metadata_json);
  if (!meta || meta.eventId !== row.id || meta.actorId !== row.target_user_id) {
    await db.notification.updateMany({ where: { id: row.id, type: IMAGE_FEISHU_TYPE, status: 'pending', metadata_json: row.metadata_json },
      data: { status: 'failed', error_message: 'image_feishu_invalid_event' } }); return 'failed';
  }
  if (meta.state !== 'pending' || meta.nextAttemptAt > Date.now() || (meta.leaseUntil || 0) > Date.now()) {
    await db.notification.updateMany({ where: { id: row.id, type: IMAGE_FEISHU_TYPE, status: 'pending', metadata_json: row.metadata_json }, data: { updated_at: new Date() } });
    return 'waiting';
  }
  const lease = randomUUID(); let raw = row.metadata_json, owned = false;
  const save = async (terminal = false) => {
    if (!await heartbeat()) { owned = false; throw new VideoFeishuError('delivery_lease_lost', 409); }
    meta.leaseToken = terminal ? null : lease; meta.leaseUntil = terminal ? null : Date.now() + WORK_LEASE_MS;
    for (const step of [meta.image, meta.explanation]) { step.leaseToken = !terminal && step.state === 'sending' ? lease : null; step.leaseUntil = step.leaseToken ? meta.leaseUntil : null; }
    const next = JSON.stringify(meta);
    if (!parseImageFeishuEvent(next)) throw new VideoFeishuError('notification_state_invalid', 503);
    const changed = await db.notification.updateMany({ where: { id: row.id, type: IMAGE_FEISHU_TYPE, channel: 'feishu', status: 'pending', metadata_json: raw },
      data: { metadata_json: next, ...(terminal ? { status: meta.state === 'sent' ? 'sent' : 'failed', sent_at: meta.state === 'sent' ? new Date() : null,
        error_message: meta.state === 'sent' ? null : `image_feishu_${meta.reason}` } : {}) } });
    if (changed.count !== 1) { owned = false; throw new VideoFeishuError('delivery_lease_lost', 409); }
    raw = next; owned = !terminal;
  };
  const terminal = async (reason: string) => {
    const unknown = meta.upload.state === 'unknown' || [meta.image, meta.explanation].some(s => !s.receiptId && s.ambiguous);
    meta.state = unknown ? 'unknown' : 'failed'; meta.reason = reason;
    for (const s of [meta.image, meta.explanation]) if (!s.receiptId && s.state !== 'skipped') s.state = s.ambiguous ? 'unknown' : 'failed';
    await save(true); return meta.state;
  };
  const defer = async (reason: string, delay = 60_000) => { meta.reason = reason; meta.nextAttemptAt = Date.now() + delay; await save(); return 'deferred'; };
  try {
    await save();
    // Image upload has no idempotency key. A crashed/ambiguous upload must never become another upload or a fallback link.
    if (meta.upload.state === 'uploading' || meta.upload.state === 'unknown') { meta.upload.state = 'unknown'; return await terminal('image_upload_unknown'); }
    const fresh = async () => {
      const current = await authorizedImageFeishuTask(db, meta.actorId, meta.taskId);
      if (videoFeishuBinding(current.actor) !== meta.identity) throw new VideoFeishuError('binding_changed', 409);
      return current;
    };
    const initial = await fresh();
    if ([meta.image, meta.explanation].some(s => !s.receiptId && s.firstSendAt !== null
      && (Date.now() - s.firstSendAt >= SEND_WINDOW_MS || s.attempts >= IMAGE_FEISHU_ATTEMPTS))) return await terminal('message_window_ended');
    if (!studioTaskHasViewableOutput(initial.task)) {
      if (['failed', 'cancelled', 'canceled'].includes(publicPricingTaskState(initial.task.status))) return await terminal('generation_not_completed');
      if (Date.now() - meta.createdAt >= 24 * 60 * 60_000) return await terminal('generation_wait_ended');
      return await defer('generation_not_ready', 5 * 60_000);
    }
    const source = await prepareImageFeishuSource(initial), stamp = imageFeishuSourceStamp(initial);
    if (meta.sourceVersion && meta.sourceVersion !== source.version || meta.contentHash && meta.contentHash !== source.contentHash
      || meta.assetId && meta.assetId !== source.assetId) return await terminal('original_changed');
    meta.sourceVersion = source.version; meta.contentHash = source.contentHash; meta.assetId = source.assetId;
    const authority = async () => {
      const current = await fresh();
      if (!studioTaskHasViewableOutput(current.task) || imageFeishuSourceStamp(current) !== stamp || !await source.current()) throw new VideoFeishuError('original_changed', 409);
      if (!await heartbeat()) throw new VideoFeishuError('delivery_lease_lost', 409);
      return current.actor.feishu_open_id!;
    };
    if (source.mode === 'link') {
      if (meta.image.firstSendAt !== null || meta.image.receiptId || meta.upload.startedAt !== null) return await terminal('original_delivery_unconfirmed');
      meta.mode = 'link'; meta.reason = source.reason; meta.upload.state = 'skipped'; meta.image.state = 'skipped';
    }
    await save(); const token = await feedbackTenantToken();
    if (meta.mode === 'image' && meta.upload.state !== 'ready') {
      if (!source.file || meta.upload.state !== 'pending' || meta.upload.attempts >= IMAGE_FEISHU_ATTEMPTS) return await terminal('image_original_unavailable');
      await authority(); meta.externalStartedAt ??= Date.now(); meta.upload.state = 'uploading'; meta.upload.startedAt = Date.now(); meta.upload.attempts++; await save();
      try { meta.upload.key = await uploadImageFeishuOriginal(token, source.file, source.extension); meta.upload.state = 'ready'; }
      catch (error) { const failure = safeError(error); meta.upload.state = failure.ambiguous ? 'unknown' : 'pending'; await save(); return await terminal(failure.ambiguous ? 'image_upload_unknown' : 'image_upload_rejected'); }
      await save();
    }
    const send = async (part: 'image' | 'explanation') => {
      const step = meta[part]; if (step.receiptId) return true;
      if (step.attempts >= IMAGE_FEISHU_ATTEMPTS || step.firstSendAt !== null && Date.now() - step.firstSendAt >= SEND_WINDOW_MS) {
        await terminal('message_window_ended'); return false;
      }
      const openId = await authority(); meta.externalStartedAt ??= Date.now(); step.firstSendAt ??= Date.now(); step.state = 'sending'; step.attempts++;
      const wasAmbiguous = step.ambiguous; step.ambiguous = true; await save();
      try {
        const link = `${VIDEO_FEISHU_SITE}/template-studio?type=image&taskId=${encodeURIComponent(meta.taskId)}${initial.task.module_id ? `&moduleId=${encodeURIComponent(initial.task.module_id)}` : ''}`;
        const content = part === 'image' ? { image_key: meta.upload.key! }
          : { text: `任务 ${meta.taskId}\n${meta.mode === 'link' ? '本次仅发送查看链接，未发送图片消息。' : '图片已发送。'}\n${link}` };
        const receipt = await sendVideoFeishuMessage(token, openId, step.uuid, part === 'image' ? 'image' : 'text', content, step.firstSendAt + SEND_WINDOW_MS, meta.leaseUntil!);
        step.receiptId = receipt; step.state = 'sent'; step.ambiguous = false; await save(); return true;
      } catch (error) {
        const failure = safeError(error); step.ambiguous = wasAmbiguous || failure.ambiguous; step.state = step.ambiguous ? 'sending' : 'pending';
        if (!failure.retryable && !step.ambiguous) await terminal('message_rejected');
        else if (step.attempts >= IMAGE_FEISHU_ATTEMPTS || Date.now() - step.firstSendAt! >= SEND_WINDOW_MS) await terminal('message_window_ended');
        else await defer(step.ambiguous ? 'message_receipt_unknown' : 'message_retry_pending');
        return false;
      }
    };
    if (meta.mode === 'image' && !await send('image')) return meta.state;
    if (!await send('explanation')) return meta.state;
    meta.state = 'sent'; await save(true); return 'sent';
  } catch (error) {
    const failure = safeError(error);
    if (!owned || failure.code === 'delivery_lease_lost') return 'lease_lost';
    if (!failure.retryable) return await terminal(failure.code);
    meta.preparations++;
    if (meta.preparations >= IMAGE_FEISHU_ATTEMPTS) return await terminal('preparation_attempts_ended');
    return await defer(failure.code, 5 * 60_000);
  } finally {
    if (owned) {
      const durable = parseImageFeishuEvent(raw)!;
      durable.leaseToken = null; durable.leaseUntil = null;
      for (const s of [durable.image, durable.explanation]) { s.leaseToken = null; s.leaseUntil = null; }
      await db.notification.updateMany({ where: { id: row.id, type: IMAGE_FEISHU_TYPE, status: 'pending', metadata_json: raw }, data: { metadata_json: JSON.stringify(durable) } });
    }
  }
}

let processing = false;
export async function processImageFeishuDeliveries(limit = 1) {
  if (processing) return { scanned: 0, processed: 0 };
  processing = true; const token = randomUUID(); let leaseRaw: string | null = null;
  const heartbeat = async () => {
    const next = JSON.stringify({ version: 1, token, until: Date.now() + WORK_LEASE_MS });
    if (leaseRaw === null) {
      const row = await prisma.platformSetting.findUnique({ where: { key: CONSUMER_KEY } });
      if (!row) {
        try { await prisma.platformSetting.create({ data: { key: CONSUMER_KEY, value_json: next } }); leaseRaw = next; return true; }
        catch (error) { if ((error as { code?: string }).code === 'P2002') return false; throw error; }
      }
      let old: { version?: unknown; until?: unknown }; try { old = JSON.parse(row.value_json); } catch { return false; }
      if (old.version !== 1 || !Number.isSafeInteger(old.until) || Number(old.until) > Date.now()) return false;
      leaseRaw = row.value_json;
    }
    if ((await prisma.platformSetting.updateMany({ where: { key: CONSUMER_KEY, value_json: leaseRaw }, data: { value_json: next } })).count !== 1) { leaseRaw = null; return false; }
    leaseRaw = next; return true;
  };
  try {
    if (!await heartbeat()) return { scanned: 0, processed: 0 };
    const rows = await prisma.notification.findMany({ where: { type: IMAGE_FEISHU_TYPE, channel: 'feishu', status: 'pending' },
      orderBy: [{ updated_at: 'asc' }, { id: 'asc' }], take: 50,
      select: { id: true, type: true, channel: true, status: true, target_user_id: true, metadata_json: true } });
    let processed = 0; const bound = Number.isSafeInteger(limit) ? Math.max(1, Math.min(50, limit)) : 1;
    for (const row of rows) {
      const result = await deliverImageFeishuNotification(prisma, row, heartbeat);
      if (!['ignored', 'waiting'].includes(result)) processed++;
      if (processed >= bound || result === 'lease_lost') break;
    }
    return { scanned: rows.length, processed };
  } finally {
    try { if (leaseRaw) await prisma.platformSetting.updateMany({ where: { key: CONSUMER_KEY, value_json: leaseRaw }, data: { value_json: JSON.stringify({ version: 1, token: null, until: 0 }) } }); }
    finally { processing = false; }
  }
}
