import { randomUUID } from 'node:crypto';
import type { Notification, Prisma } from '@prisma/client';
import { feedbackTenantToken } from '@/lib/feedback/delivery';
import { LEASE_MS, SEND_WINDOW_MS } from '@/lib/feedback/notification';
import { VideoFeishuError, type VideoFeishuStep } from '@/lib/video/feishu-contract';
import { videoFeishuBinding } from '@/lib/video/feishu-notification';
import { uploadImageFeishuFile, uploadImageFeishuOriginal, sendVideoFeishuMessage } from '@/lib/video/feishu-transport';
import { authorizedImageFeishuTask } from './feishu-notification';
import { imageFeishuSourceStamp, prepareImageFeishuSource } from './feishu-source';
import { resolveImageFeishuNavigation, imageFeishuNavigationPost, feishuPayloadHash } from './feishu-navigation';
import { studioTaskHasViewableOutput } from './dimension-mismatch';
import { IMAGE_FEISHU_ORIGINAL_TYPE, parseOriginalImageFeishuEvent, originalImageFeishuTemplate, originalImageFeishuPayload, originalImageFeishuFileName, originalImageFeishuCanUpgrade, originalImageFeishuCanRetry, originalImageFeishuV2Fields, originalImageFeishuV2Template } from './feishu-original-contract';

type Db = Prisma.TransactionClient;
type Row = Pick<Notification, 'id' | 'type' | 'channel' | 'status' | 'target_user_id' | 'metadata_json'>;
const WORK_LEASE_MS = LEASE_MS * 4;
const safeError = (error: unknown) => error instanceof VideoFeishuError ? error : new VideoFeishuError('image_original_unavailable', 503, false, true);
/** Only an explicit original-delivery event is consumed here; automatic notices remain independent. */
export async function deliverOriginalImageFeishuNotification(db: Db, row: Row, heartbeat: () => Promise<boolean> = async () => true) {
  if (row.type !== IMAGE_FEISHU_ORIGINAL_TYPE || row.channel !== 'feishu' || row.status !== 'pending') return 'ignored';
  const parsed = parseOriginalImageFeishuEvent(row.metadata_json);
  if (!parsed || parsed.eventId !== row.id || parsed.actorId !== row.target_user_id) {
    await db.notification.updateMany({ where: { id: row.id, type: IMAGE_FEISHU_ORIGINAL_TYPE, status: 'pending', metadata_json: row.metadata_json },
      data: { status: 'failed', error_message: 'image_feishu_invalid_event' } }); return 'failed';
  }
  let meta = parsed;
  if (meta.state !== 'pending' || meta.nextAttemptAt > Date.now() || (meta.leaseUntil || 0) > Date.now()) return 'waiting';
  const legacyUploadRetry = meta.version === 1 && meta.reason === 'image_upload_rejected' && meta.upload.attempts > 0
    && meta.upload.key === null && originalImageFeishuCanRetry({ ...meta, state: 'failed' });
  const lease = randomUUID(); let raw = row.metadata_json, owned = false;
  const save = async (terminal = false) => {
    if (!await heartbeat()) { owned = false; throw new VideoFeishuError('delivery_lease_lost', 409); }
    meta.leaseToken = terminal ? null : lease; meta.leaseUntil = terminal ? null : Date.now() + WORK_LEASE_MS;
    for (const step of [meta.message, ...(meta.version === 2 ? [meta.navigationStep] : [])]) {
      step.leaseToken = !terminal && step.state === 'sending' ? lease : null; step.leaseUntil = step.leaseToken ? meta.leaseUntil : null;
    }
    const next = JSON.stringify(meta); if (!parseOriginalImageFeishuEvent(next)) throw new VideoFeishuError('notification_state_invalid', 503);
    let changed;
    try { changed = await db.notification.updateMany({ where: { id: row.id, type: IMAGE_FEISHU_ORIGINAL_TYPE, channel: 'feishu', status: 'pending', metadata_json: raw },
      data: { metadata_json: next, ...(terminal ? { status: meta.state === 'sent' ? 'sent' : 'failed', sent_at: meta.state === 'sent' ? new Date() : null,
        error_message: meta.state === 'sent' ? null : `image_feishu_${meta.reason}` } : {}) } }); }
    catch { owned = false; throw new VideoFeishuError('delivery_lease_lost', 503); }
    if (changed.count !== 1) { owned = false; throw new VideoFeishuError('delivery_lease_lost', 409); }
    raw = next; owned = !terminal;
  };
  const terminal = async (reason: string) => {
    const unknown = meta.upload.state === 'unknown' || [meta.message, ...(meta.version === 2 ? [meta.navigationStep] : [])].some(step => !step.receiptId && (step.ambiguous || step.state === 'unknown'));
    meta.state = unknown ? 'unknown' : 'failed'; meta.reason = reason;
    if (!meta.message.receiptId) meta.message.state = meta.message.ambiguous || meta.message.state === 'unknown' ? 'unknown' : 'failed';
    if (meta.version === 2 && meta.mode === 'file' && !meta.navigationStep.receiptId) meta.navigationStep.state = meta.navigationStep.ambiguous || meta.navigationStep.state === 'unknown' ? 'unknown' : 'failed';
    await save(true); return meta.state;
  };
  try {
    await save();
    if (meta.upload.state === 'uploading' || meta.upload.state === 'unknown') { meta.upload.state = 'unknown'; return await terminal('image_upload_unknown'); }
    // A previous message intent without a durable receipt stays unknown; never start another send.
    if (!meta.message.receiptId && meta.message.firstSendAt !== null) return await terminal('message_receipt_unknown');
    if (meta.version === 2 && !meta.navigationStep.receiptId && (meta.navigationStep.ambiguous || meta.navigationStep.state === 'unknown')) return await terminal('navigation_receipt_unknown');
    const fresh = async () => {
      const current = await authorizedImageFeishuTask(db, meta.actorId, meta.taskId);
      if (videoFeishuBinding(current.actor) !== meta.identity) throw new VideoFeishuError('binding_changed', 409);
      if (!studioTaskHasViewableOutput(current.task)) throw new VideoFeishuError('generation_not_completed', 409);
      return current;
    };
    const initial = await fresh(), source = await prepareImageFeishuSource(initial, 'original'), stamp = imageFeishuSourceStamp(initial);
    const original = { version: source.version, contentHash: source.contentHash, assetId: source.assetId, size: source.size,
      width: source.width, height: source.height, mimeType: source.mimeType, extension: source.extension };
    if (meta.source && JSON.stringify(meta.source) !== JSON.stringify(original)) return await terminal('original_changed');
    if (!meta.source) { meta.source = original; meta.mode = source.mode === 'image' ? 'image' : 'file';
      if (meta.version === 1) meta.template = originalImageFeishuTemplate(meta.mode, original); }
    if (meta.mode === 'file' && meta.version === 1 && meta.upload.state !== 'ready') {
      if (!originalImageFeishuCanUpgrade(meta) && !legacyUploadRetry) return await terminal('legacy_file_name_unavailable');
      meta = { ...meta, ...originalImageFeishuV2Fields(meta.taskId) };
    }
    if (meta.version === 2) {
      const fileName = meta.mode === 'file' ? originalImageFeishuFileName(original) : null;
      if (meta.mode === 'file' && !fileName) return await terminal('image_original_unavailable');
      meta.fileName = fileName;
      if (!meta.navigation) meta.navigation = await resolveImageFeishuNavigation(db, initial.task, source.assetId);
      meta.template = originalImageFeishuV2Template(meta.mode!, original, meta.navigation); meta.templateSha256 = feishuPayloadHash(meta.template);
      if (meta.mode === 'file') { meta.navigationPayload = imageFeishuNavigationPost(meta.navigation); meta.navigationPayloadSha256 = feishuPayloadHash(meta.navigationPayload); }
      else meta.navigationStep.state = 'skipped';
    }
    const authority = async () => {
      const current = await fresh();
      if (imageFeishuSourceStamp(current) !== stamp || !await source.current()) throw new VideoFeishuError('original_changed', 409);
      if (!await heartbeat()) throw new VideoFeishuError('delivery_lease_lost', 409);
      return current.actor.feishu_open_id!;
    };
    await save(); const token = await feedbackTenantToken();
    if (meta.upload.state !== 'ready') {
      if (!source.file || meta.upload.state !== 'pending' || meta.upload.attempts >= 12) return await terminal('image_original_unavailable');
      await authority(); meta.externalStartedAt ??= Date.now(); meta.upload.state = 'uploading'; meta.upload.startedAt = Date.now(); meta.upload.attempts++; await save();
      try { meta.upload.key = meta.mode === 'file' ? await uploadImageFeishuFile(token, source.file, meta.fileName!) : await uploadImageFeishuOriginal(token, source.file, source.extension); meta.upload.state = 'ready'; }
      catch (error) { const failure = safeError(error); meta.upload.state = failure.ambiguous ? 'unknown' : 'pending'; await save(); return await terminal(failure.ambiguous ? 'image_upload_unknown' : 'image_upload_rejected'); }
      await save();
    }
    if (!meta.payload) { meta.payload = originalImageFeishuPayload(meta.mode!, meta.template!, meta.upload.key!);
      if (meta.version === 2) meta.payloadSha256 = feishuPayloadHash(meta.payload); await save(); }
    const send = async (step: VideoFeishuStep, type: 'file' | 'interactive' | 'post', payload: string, navigation = false) => {
      if (step.receiptId) return true;
      if (step.attempts >= 12 || step.firstSendAt !== null && Date.now() - step.firstSendAt >= SEND_WINDOW_MS) {
        await terminal(navigation ? 'navigation_message_window_ended' : 'message_window_ended'); return false;
      }
      const openId = await authority(); step.firstSendAt ??= Date.now(); step.state = 'sending'; step.attempts++; step.ambiguous = true; await save();
      let receipt;
      try { receipt = await sendVideoFeishuMessage(token, openId, step.uuid, type, JSON.parse(payload), step.firstSendAt + SEND_WINDOW_MS, meta.leaseUntil!); }
      catch (error) { const failure = safeError(error); step.ambiguous = failure.ambiguous;
        await terminal(navigation ? failure.ambiguous ? 'navigation_receipt_unknown' : 'navigation_message_rejected' : failure.ambiguous ? 'message_receipt_unknown' : 'message_rejected'); return false; }
      step.receiptId = receipt; step.ambiguous = false; step.state = 'sent'; await save(); return true;
    };
    if (!await send(meta.message, meta.mode === 'file' ? 'file' : 'interactive', meta.payload!)) return meta.state;
    if (meta.version === 2 && meta.mode === 'file' && !await send(meta.navigationStep, 'post', meta.navigationPayload! , true)) return meta.state;
    meta.message.state = 'sent'; meta.state = 'sent'; meta.reason = null; await save(true); return 'sent';
  } catch (error) {
    const failure = safeError(error); if (!owned || failure.code === 'delivery_lease_lost') return 'lease_lost';
    if (!failure.retryable) return await terminal(failure.code);
    meta.preparations++;
    if (meta.preparations >= 12) return await terminal('preparation_attempts_ended');
    meta.reason = failure.code; meta.nextAttemptAt = Date.now() + 60_000; await save(); return 'deferred';
  } finally {
    if (owned) {
      const durable = parseOriginalImageFeishuEvent(raw)!; durable.leaseToken = null; durable.leaseUntil = null;
      for (const step of [durable.message, ...(durable.version === 2 ? [durable.navigationStep] : [])]) { step.leaseToken = null; step.leaseUntil = null; }
      await db.notification.updateMany({ where: { id: row.id, type: IMAGE_FEISHU_ORIGINAL_TYPE, status: 'pending', metadata_json: raw }, data: { metadata_json: JSON.stringify(durable) } });
    }
  }
}
