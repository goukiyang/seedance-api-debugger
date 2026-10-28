import { randomUUID } from 'node:crypto';
import type { Notification, Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { feedbackTenantToken } from '@/lib/feedback/delivery';
import { LEASE_MS, SEND_WINDOW_MS } from '@/lib/feedback/notification';
import { authorizedVideoFeishuTask, videoFeishuBinding } from './feishu-notification';
import { prepareVideoFeishuSource, videoFeishuSourceStamp, type PreparedVideoFeishuSource } from './feishu-source';
import { uploadVideoFeishuFile, uploadVideoFeishuCover, sendVideoFeishuMessage } from './feishu-transport';
import { VIDEO_FEISHU_TYPE, VIDEO_FEISHU_SITE, VIDEO_FEISHU_ATTEMPTS, VideoFeishuError, parseVideoFeishuEvent,
  videoFeishuSameOriginal, type VideoFeishuStep } from './feishu-contract';

type Db = Prisma.TransactionClient;
type Row = Pick<Notification, 'id' | 'type' | 'channel' | 'status' | 'target_user_id' | 'metadata_json'>;
const WORK_LEASE_MS = LEASE_MS * 4;
const CONSUMER_KEY = 'video.feishu.consumer-lease.v1';
const waiting = new Set(['draft', 'created', 'queued', 'submitted', 'pending', 'running', 'processing']);
const failed = new Set(['failed', 'cancelled', 'canceled']);
const safeError = (error: unknown) => error instanceof VideoFeishuError ? error : new VideoFeishuError('delivery_temporarily_unavailable', 503, false, true);

/** Per-row CAS is also used by cancellation. No transaction or database connection is held during I/O. */
export async function deliverVideoFeishuNotification(db: Db, row: Row, heartbeat: () => Promise<boolean> = async () => true) {
  if (row.type !== VIDEO_FEISHU_TYPE || row.channel !== 'feishu' || row.status !== 'pending') return 'ignored';
  const parsed = parseVideoFeishuEvent(row.metadata_json);
  if (!parsed || parsed.eventId !== row.id || parsed.actorId !== row.target_user_id) {
    await db.notification.updateMany({ where: { id: row.id, type: VIDEO_FEISHU_TYPE, status: 'pending', metadata_json: row.metadata_json },
      data: { status: 'failed', error_message: 'video_feishu_invalid_event' } });
    return 'failed';
  }
  if (parsed.state !== 'pending' || parsed.nextAttemptAt > Date.now() || (parsed.leaseUntil || 0) > Date.now()) {
    // Rotate a bounded scan past future-due rows rather than starving later ready events.
    await db.notification.updateMany({ where: { id: row.id, type: VIDEO_FEISHU_TYPE, status: 'pending', metadata_json: row.metadata_json }, data: { updated_at: new Date() } });
    return 'waiting';
  }
  const meta = parsed, lease = randomUUID();
  let raw = row.metadata_json, owned = false, source: PreparedVideoFeishuSource | null = null;
  const save = async (terminal = false) => {
    if (!await heartbeat()) { owned = false; throw new VideoFeishuError('delivery_lease_lost', 409); }
    meta.leaseToken = terminal ? null : lease;
    meta.leaseUntil = terminal ? null : Date.now() + WORK_LEASE_MS;
    for (const step of [meta.video, meta.explanation]) {
      step.leaseToken = step.state === 'sending' && !terminal ? lease : null;
      step.leaseUntil = step.leaseToken ? meta.leaseUntil : null;
    }
    const next = JSON.stringify(meta);
    if (!parseVideoFeishuEvent(next)) throw new VideoFeishuError('notification_state_invalid', 503);
    const result = await db.notification.updateMany({ where: { id: row.id, type: VIDEO_FEISHU_TYPE, channel: 'feishu', status: 'pending', metadata_json: raw },
      data: { metadata_json: next, ...(terminal ? { status: meta.state === 'sent' ? 'sent' : 'failed', sent_at: meta.state === 'sent' ? new Date() : null,
        error_message: meta.state === 'sent' ? null : `video_feishu_${meta.reason}` } : {}) } });
    if (result.count !== 1) { owned = false; throw new VideoFeishuError('delivery_lease_lost', 409); }
    raw = next; owned = !terminal;
  };
  const terminal = async (reason: string) => {
    const unknown = [meta.video, meta.explanation].some(step => step.firstSendAt !== null && !step.receiptId && step.ambiguous);
    meta.state = unknown ? 'unknown' : 'failed'; meta.reason = reason;
    for (const step of [meta.video, meta.explanation]) if (!step.receiptId && step.state !== 'skipped') step.state = step.ambiguous ? 'unknown' : 'failed';
    await save(true);
    return meta.state;
  };
  const defer = async (reason: string, delay = 60_000) => {
    meta.reason = reason; meta.nextAttemptAt = Date.now() + delay; await save(); return 'deferred';
  };
  try {
    await save();
    // A crashed upload has no idempotency key. Never turn its unknown receipt into another upload.
    for (const part of ['upload', 'cover'] as const) if (meta[part].state === 'uploading') meta[part].state = 'unknown';
    const fresh = async () => {
      const current = await authorizedVideoFeishuTask(db, meta.actorId, meta.taskId);
      if (videoFeishuBinding(current.actor) !== meta.identity) throw new VideoFeishuError('binding_changed', 409);
      return current;
    };
    const initial = await fresh();
    if ([meta.video, meta.explanation].some(step => !step.receiptId && step.firstSendAt !== null
      && (Date.now() - step.firstSendAt >= SEND_WINDOW_MS || step.attempts >= VIDEO_FEISHU_ATTEMPTS))) return await terminal('message_window_ended');
    if (waiting.has(initial.task.local_status)) return await defer('generation_not_ready', 5 * 60_000);
    if (failed.has(initial.task.local_status)) return await terminal('generation_not_completed');
    if (initial.task.local_status !== 'succeeded') return await defer('generation_state_unconfirmed', 5 * 60_000);
    if (initial.task.delivery_status === 'failed' && !initial.task.local_video_path && !initial.task.public_video_url) return await terminal('original_save_failed');
    source = await prepareVideoFeishuSource(initial.task);
    const stamp = videoFeishuSourceStamp(initial.task, source.origin);
    if (!videoFeishuSameOriginal(meta, source)) return await terminal('original_changed');
    meta.sourceVersion = source.version; meta.contentHash = source.hash;
    const authority = async () => {
      const current = await fresh();
      if (current.task.local_status !== 'succeeded' || videoFeishuSourceStamp(current.task, source!.origin) !== stamp || !await source!.current()) throw new VideoFeishuError('original_changed', 409);
      if (!await heartbeat()) throw new VideoFeishuError('delivery_lease_lost', 409);
      return current.actor.feishu_open_id!;
    };
    if (source.mode === 'link' || meta.upload.state === 'unknown') {
      if (meta.video.firstSendAt !== null || meta.video.receiptId) return await terminal('original_delivery_unconfirmed');
      meta.mode = 'link'; meta.reason = meta.upload.state === 'unknown' ? 'file_upload_unknown_link_only' : source.reason;
      meta.video.state = 'skipped';
      if (meta.upload.state === 'pending') meta.upload.state = 'skipped';
    }
    await save();
    const token = await feedbackTenantToken();
    if (meta.mode === 'video' && meta.upload.state !== 'ready') {
      if (!source.video || !source.durationMs || meta.upload.state !== 'pending') return await terminal('original_not_ready');
      await authority();
      meta.externalStartedAt ??= Date.now(); meta.upload.state = 'uploading'; meta.upload.startedAt = Date.now(); meta.upload.attempts++;
      await save();
      try {
        meta.upload.key = await uploadVideoFeishuFile(token, meta.taskId, source.video, source.durationMs); meta.upload.state = 'ready';
      } catch (error) {
        const failure = safeError(error);
        if (!failure.ambiguous) return await terminal('file_upload_rejected');
        meta.upload.state = 'unknown'; meta.mode = 'link'; meta.video.state = 'skipped'; meta.reason = 'file_upload_unknown_link_only';
      }
      await save();
    }
    if (meta.mode === 'video' && !meta.video.receiptId && meta.cover.state === 'pending') {
      if (!source.cover) { meta.cover.state = 'skipped'; await save(); }
      else {
        await authority(); meta.cover.state = 'uploading'; meta.cover.startedAt = Date.now(); meta.cover.attempts++; await save();
        try { meta.cover.key = await uploadVideoFeishuCover(token, source.cover); meta.cover.state = 'ready'; }
        catch { meta.cover.state = 'unknown'; /* Optional cover upload is never blindly repeated. */ }
        await save();
      }
    }
    const send = async (part: 'video' | 'explanation') => {
      const step: VideoFeishuStep = meta[part];
      if (step.receiptId) return true;
      if (step.attempts >= VIDEO_FEISHU_ATTEMPTS || step.firstSendAt !== null && Date.now() - step.firstSendAt >= SEND_WINDOW_MS) {
        await terminal('message_window_ended'); return false;
      }
      const openId = await authority();
      meta.externalStartedAt ??= Date.now(); step.firstSendAt ??= Date.now(); step.state = 'sending'; step.attempts++;
      const previouslyAmbiguous = step.ambiguous;
      step.ambiguous = true; await save();
      let receipt: string;
      try {
        const content = part === 'video' ? { file_key: meta.upload.key!, ...(meta.cover.state === 'ready' ? { image_key: meta.cover.key! } : {}) }
          : { text: `任务 ${meta.taskId}\n${meta.mode === 'link' ? '本次仅发送查看链接，未发送视频附件。' : '视频已发送。'}\n${VIDEO_FEISHU_SITE}/tasks/${encodeURIComponent(meta.taskId)}` };
        receipt = await sendVideoFeishuMessage(token, openId, step.uuid, part === 'video' ? 'media' : 'text', content,
          step.firstSendAt! + SEND_WINDOW_MS, meta.leaseUntil!);
      } catch (error) {
        const failure = safeError(error);
        step.ambiguous = previouslyAmbiguous || failure.ambiguous;
        step.state = step.ambiguous ? 'sending' : 'pending';
        if (!failure.retryable && !step.ambiguous) await terminal('message_rejected');
        else if (step.attempts >= VIDEO_FEISHU_ATTEMPTS || Date.now() - step.firstSendAt! >= SEND_WINDOW_MS) await terminal('message_window_ended');
        else await defer(step.ambiguous ? 'message_receipt_unknown' : 'message_retry_pending');
        return false;
      }
      step.receiptId = receipt; step.state = 'sent'; step.ambiguous = false; await save(); return true;
    };
    if (meta.mode === 'video' && !await send('video')) return meta.state;
    if (!await send('explanation')) return meta.state;
    meta.state = 'sent'; await save(true); return 'sent';
  } catch (error) {
    const failure = safeError(error);
    if (!owned || failure.code === 'delivery_lease_lost') return 'lease_lost';
    if (failure.retryable) {
      meta.preparations++;
      if (failure.code === 'original_not_ready' && meta.preparations >= VIDEO_FEISHU_ATTEMPTS) return await terminal('original_wait_ended');
      if (meta.preparations >= VIDEO_FEISHU_ATTEMPTS) return await terminal('preparation_attempts_ended');
      return await defer(failure.code, 5 * 60_000);
    }
    return await terminal(failure.code);
  } finally {
    try { await source?.close(); } finally {
      if (owned) {
        // Release only the last durable state. A failed receipt CAS must remain unknown, not become an unsaved success/terminal state.
        const durable = parseVideoFeishuEvent(raw)!;
        durable.leaseToken = null; durable.leaseUntil = null;
        for (const step of [durable.video, durable.explanation]) { step.leaseToken = null; step.leaseUntil = null; }
        await db.notification.updateMany({ where: { id: row.id, type: VIDEO_FEISHU_TYPE, status: 'pending', metadata_json: raw }, data: { metadata_json: JSON.stringify(durable) } });
      }
    }
  }
}

let processing = false;
/** Lead wires this into the existing worker. The singleton CAS lease bounds all processes to one active delivery. */
export async function processVideoFeishuDeliveries(limit = 1) {
  if (processing) return { scanned: 0, processed: 0 };
  processing = true;
  const token = randomUUID(); let leaseRaw: string | null = null;
  const heartbeat = async () => {
    const next = JSON.stringify({ version: 1, token, until: Date.now() + WORK_LEASE_MS });
    if (leaseRaw === null) {
      const row = await prisma.platformSetting.findUnique({ where: { key: CONSUMER_KEY } });
      if (!row) {
        try { await prisma.platformSetting.create({ data: { key: CONSUMER_KEY, value_json: next } }); leaseRaw = next; return true; }
        catch (error) { if ((error as { code?: string }).code === 'P2002') return false; throw error; }
      }
      let previous: { version?: unknown; until?: unknown };
      try { previous = JSON.parse(row.value_json); } catch { return false; }
      if (previous.version !== 1 || !Number.isSafeInteger(previous.until) || Number(previous.until) > Date.now()) return false;
      leaseRaw = row.value_json;
    }
    const result = await prisma.platformSetting.updateMany({ where: { key: CONSUMER_KEY, value_json: leaseRaw }, data: { value_json: next } });
    if (result.count !== 1) { leaseRaw = null; return false; }
    leaseRaw = next; return true;
  };
  try {
    if (!await heartbeat()) return { scanned: 0, processed: 0 };
    const rows = await prisma.notification.findMany({ where: { type: VIDEO_FEISHU_TYPE, channel: 'feishu', status: 'pending' },
      orderBy: [{ updated_at: 'asc' }, { id: 'asc' }], take: 50,
      select: { id: true, type: true, channel: true, status: true, target_user_id: true, metadata_json: true } });
    const bounded = Number.isSafeInteger(limit) ? Math.max(1, Math.min(50, limit)) : 1;
    let processed = 0;
    for (const row of rows) {
      const result = await deliverVideoFeishuNotification(prisma, row, heartbeat);
      if (!['ignored', 'waiting'].includes(result)) processed++;
      if (processed >= bounded || result === 'lease_lost') break;
    }
    return { scanned: rows.length, processed };
  } finally {
    try {
      if (leaseRaw) await prisma.platformSetting.updateMany({ where: { key: CONSUMER_KEY, value_json: leaseRaw },
        data: { value_json: JSON.stringify({ version: 1, token: null, until: 0 }) } });
    } finally { processing = false; }
  }
}
