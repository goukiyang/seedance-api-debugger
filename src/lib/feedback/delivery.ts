import { randomUUID } from 'node:crypto';
import { FEEDBACK_NOTIFICATION_TYPE, LEASE_MS, SEND_WINDOW_MS,
  feedbackPrisma as prisma, feedbackConfig, feedbackDeliveryMessage, feedbackImageCard, parseFeedbackDelivery, validFeedbackRecipient, type FeedbackDelivery } from './notification';
import { attachmentSelect, feedbackAttachmentStillValid, FeedbackImageError, FEEDBACK_IMAGE_ATTEMPTS,
  readFeedbackImage, uploadFeedbackImage, type FeedbackAttachment } from './attachments';

class DeliveryError extends Error {
  constructor(public code: string, public ambiguous = false, public retryable = true) { super(code); }
}

async function feishuRequest(path: string, body: unknown, token?: string, deadline?: number, leaseUntil?: number) {
  let response: Response;
  let data: Record<string, unknown>;
  if (token && (deadline === undefined || leaseUntil === undefined || Date.now() < deadline - SEND_WINDOW_MS
    || Date.now() >= deadline || Date.now() >= leaseUntil)) {
    throw new DeliveryError('feedback_delivery_unknown', true, false);
  }
  try {
    response = await fetch(`https://open.feishu.cn/open-apis/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(8000), cache: 'no-store', redirect: 'error',
    });
    data = await response.json();
  } catch { throw new DeliveryError('feishu_network_unknown', Boolean(token)); }
  const code = typeof data.code === 'number' ? data.code : null;
  if (response.ok && code === 0) return data;
  if (response.status >= 500 || code === null) throw new DeliveryError(`feishu_http_${response.status}`, Boolean(token));
  const retryable = response.status === 429 || code === 99991400 || code === 99991663 || code === 99991668;
  throw new DeliveryError(`feishu_${code}`, false, retryable);
}

export async function feedbackTenantToken() {
  const config = feedbackConfig();
  const data = await feishuRequest('auth/v3/tenant_access_token/internal', { app_id: config.appId, app_secret: config.appSecret });
  if (typeof data.tenant_access_token !== 'string' || !data.tenant_access_token) throw new DeliveryError('feishu_token_missing');
  return data.tenant_access_token;
}

export async function processFeedbackDeliveries(limit = 10) {
  const config = feedbackConfig();
  if (!config.enabled) return { enabled: false, sent: 0, failed: 0, unknown: 0 };
  if (!config.recipientId) throw new DeliveryError('feedback_recipient_configuration_invalid', false, false);
  const jobs = await prisma.notification.findMany({
    where: { channel: 'feishu', type: FEEDBACK_NOTIFICATION_TYPE, status: 'pending', target_user_id: config.recipientId },
    orderBy: { updated_at: 'asc' }, take: 100,
  });
  const result = { enabled: true, sent: 0, failed: 0, unknown: 0 };
  let claimedCount = 0;
  let uploadBudget = 4;
  let byteBudget = 40 * 1024 * 1024;
  for (const job of jobs) {
    if (claimedCount >= Math.max(1, Math.min(10, limit))) break;
    const parsed = parseFeedbackDelivery(job.metadata_json);
    if (!parsed || job.id !== parsed.uuid || parsed.state !== 'pending') {
      await prisma.notification.updateMany({ where: { id: job.id, status: 'pending', metadata_json: job.metadata_json },
        data: { status: 'failed', error_message: 'feedback_metadata_invalid' } });
      result.failed++; continue;
    }
    let meta: FeedbackDelivery = parsed;
    const now = Date.now();
    if (meta.leaseUntil && meta.leaseUntil > now) continue;
    const expired = meta.firstSendAt !== null && (now < meta.firstSendAt || now - meta.firstSendAt >= SEND_WINDOW_MS);
    if (!expired && meta.nextAttemptAt > now) continue;
    const previous = job.metadata_json;
    const preparing = meta.version === 2 && !meta.message;
    meta = { ...meta, leaseToken: randomUUID(), leaseUntil: now + LEASE_MS, attempts: meta.attempts + (preparing ? 0 : 1),
      ...(preparing ? { preparation: { ...meta.preparation!, cycles: Math.min(100, meta.preparation!.cycles + 1) } } : {}) };
    let owned = JSON.stringify(meta);
    const claim = await prisma.notification.updateMany({
      where: { id: job.id, status: 'pending', metadata_json: previous }, data: { metadata_json: owned },
    });
    if (!claim.count) continue;
    claimedCount++;
    const persist = async (next: FeedbackDelivery, status: 'pending' | 'failed' | 'sent', error: string | null, sentAt?: Date) => {
      const serialized = JSON.stringify(next);
      const updated = await prisma.notification.updateMany({ where: { id: job.id, status: 'pending', metadata_json: owned },
        data: { metadata_json: serialized, status, error_message: error, ...(sentAt ? { sent_at: sentAt } : {}) } });
      if (!updated.count) throw new DeliveryError('feedback_lease_lost', true, false);
      owned = serialized; meta = next;
    };
    let priorSendAmbiguity: boolean | null = null;
    try {
      if (expired || (meta.attempts > 12 && meta.firstSendAt !== null)) throw new DeliveryError('feedback_delivery_window_closed', meta.ambiguousSend, false);
      if (meta.attempts > 12) throw new DeliveryError('feedback_attempts_exhausted', false, false);
      const recipient = await prisma.user.findUnique({ where: { id: config.recipientId }, select: {
        id: true, status: true, role: true, expires_at: true, feishu_open_id: true, feishu_tenant_key: true,
      } });
      if (!validFeedbackRecipient(recipient, config) || meta.identity !== config.identity) throw new DeliveryError('feedback_identity_changed', false, false);
      let token: string | undefined;
      const getToken = async () => token ?? (token = await feedbackTenantToken());
      const attachmentValid = async (item: FeedbackAttachment) => {
        const owner = await prisma.user.findUnique({ where: { id: item.ownerId }, select: { status: true, expires_at: true } });
        return Boolean(owner && owner.status === 'active' && (!owner.expires_at || owner.expires_at.getTime() > Date.now()))
          && feedbackAttachmentStillValid(await prisma.asset.findUnique({ where: { id: item.assetId }, select: attachmentSelect }), item);
      };
      if (meta.version === 2) {
        const feedback = await prisma.feedback.findUnique({ where: { id: meta.feedbackId }, select: { user_id: true } });
        if (!feedback || feedback.user_id !== meta.preparation!.authorId) throw new DeliveryError('feedback_attachment_owner_changed', false, false);
      }
      if (preparing) {
        const replaceAttachment = async (index: number, item: FeedbackAttachment) => {
          const attachments = meta.preparation!.attachments;
          await persist({ ...meta, preparation: { ...meta.preparation!, attachments: {
            ...attachments, items: attachments.items.map((current, at) => at === index ? item : current),
          } } }, 'pending', null);
        };
        let batchCount = 0;
        for (let index = 0; index < meta.preparation!.attachments.items.length; index++) {
          let item = meta.preparation!.attachments.items[index];
          if (item.state === 'skipped') continue;
          if (item.state === 'uploading') {
            // An expired upload intent has no recoverable key. Never blindly upload it again.
            await replaceAttachment(index, { ...item, state: 'skipped', errorCode: 'attachment_upload_unknown' });
            continue;
          }
          if (Date.now() >= meta.preparation!.until || meta.preparation!.cycles >= 100) {
            if (item.state === 'pending') await replaceAttachment(index, { ...item, state: 'skipped', errorCode: 'attachment_preparation_timeout' });
            continue;
          }
          if (item.state === 'pending' && (item.nextAttemptAt > Date.now() || batchCount >= 2 || uploadBudget <= 0 || byteBudget < item.size)) continue;
          if (!await attachmentValid(item)) {
            await replaceAttachment(index, { ...item, state: 'skipped', imageKey: null, errorCode: 'attachment_changed' });
            continue;
          }
          if (item.state === 'ready') continue;
          try {
            const buffer = await readFeedbackImage(item);
            const imageToken = await getToken();
            item = { ...item, state: 'uploading', attempts: item.attempts + 1 };
            await replaceAttachment(index, item);
            const currentRecipient = await prisma.user.findUnique({ where: { id: config.recipientId }, select: {
              id: true, status: true, role: true, expires_at: true, feishu_open_id: true, feishu_tenant_key: true,
            } });
            if (!validFeedbackRecipient(currentRecipient, config)) throw new DeliveryError('feedback_identity_changed', false, false);
            if (!await attachmentValid(item)) throw new FeedbackImageError('attachment_changed');
            batchCount++; uploadBudget--; byteBudget -= item.size;
            const imageKey = await uploadFeedbackImage(buffer, item.mime, imageToken, meta.leaseUntil!);
            await replaceAttachment(index, { ...item, state: 'ready', imageKey, errorCode: null });
          } catch (error) {
            if (!(error instanceof FeedbackImageError)) throw error;
            const retry = error.retryable && item.attempts < FEEDBACK_IMAGE_ATTEMPTS;
            await replaceAttachment(index, { ...item, state: retry ? 'pending' : 'skipped', imageKey: null, errorCode: error.code,
              nextAttemptAt: Date.now() + Math.min(120_000, 15_000 * 2 ** Math.max(0, item.attempts - 1)) });
            if (error.code === 'attachment_upload_permission') {
              for (let at = index + 1; at < meta.preparation!.attachments.items.length; at++) {
                const next = meta.preparation!.attachments.items[at];
                if (next.state === 'pending') await replaceAttachment(at, { ...next, state: 'skipped', errorCode: error.code });
              }
            }
          }
        }
        const pending = meta.preparation!.attachments.items.filter(item => item.state === 'pending');
        if (pending.length) {
          await persist({ ...meta, leaseToken: null, leaseUntil: null,
            nextAttemptAt: Math.max(Date.now() + 1000, Math.min(...pending.map(item => item.nextAttemptAt))) }, 'pending', null);
          continue;
        }
        // Recheck all prepared images before fixing the only message for this event.
        for (let index = 0; index < meta.preparation!.attachments.items.length; index++) {
          const item = meta.preparation!.attachments.items[index];
          if (item.state === 'ready' && !await attachmentValid(item)) await replaceAttachment(index, {
            ...item, state: 'skipped', imageKey: null, errorCode: 'attachment_changed',
          });
        }
        const card = feedbackImageCard(meta);
        if (!card) throw new DeliveryError('feedback_payload_invalid', false, false);
        await persist({ ...meta, message: card, attempts: 1 }, 'pending', null);
      }
      const message = feedbackDeliveryMessage(meta, job.body);
      if (!message) throw new DeliveryError('feedback_payload_invalid', false, false);
      // Legacy pending rows keep their text, frozen before IO just like new cards.
      if (!meta.message) await persist({ ...meta, message }, 'pending', null);
      token = await getToken();
      // Recheck immediately before send; no network call holds a SQLite transaction.
      const current = await prisma.user.findUnique({ where: { id: config.recipientId }, select: {
        id: true, status: true, role: true, expires_at: true, feishu_open_id: true, feishu_tenant_key: true,
      } });
      if (!validFeedbackRecipient(current, config)) throw new DeliveryError('feedback_identity_changed', false, false);
      if (meta.version === 2) {
        for (const item of meta.preparation!.attachments.items) {
          if (item.state === 'ready' && !await attachmentValid(item)) throw new DeliveryError('feedback_frozen_attachment_changed', false, false);
        }
      }
      const requestBody = { receive_id: current!.feishu_open_id, msg_type: message.msgType, content: message.content, uuid: meta.uuid };
      if (Buffer.byteLength(JSON.stringify(requestBody), 'utf8') > 30_000) throw new DeliveryError('feedback_payload_too_large', false, false);
      if (meta.firstSendAt !== null && Date.now() - meta.firstSendAt >= SEND_WINDOW_MS) throw new DeliveryError('feedback_delivery_window_closed', meta.ambiguousSend, false);
      priorSendAmbiguity = meta.ambiguousSend;
      // A crash after starting IO is unknown; an explicit rejection clears only this attempt.
      await persist({ ...meta, firstSendAt: meta.firstSendAt ?? Date.now(), ambiguousSend: true }, 'pending', null);
      const response = await feishuRequest('im/v1/messages?receive_id_type=open_id', requestBody, token, meta.firstSendAt! + SEND_WINDOW_MS, meta.leaseUntil!);
      const receipt = response.data as { message_id?: unknown } | undefined;
      if (typeof receipt?.message_id !== 'string' || !receipt.message_id) throw new DeliveryError('feedback_receipt_unknown', true);
      await persist({ ...meta, state: 'sent', leaseToken: null, leaseUntil: null, receiptId: receipt.message_id }, 'sent', null, new Date());
      result.sent++;
    } catch (error) {
      const failure = error instanceof DeliveryError ? error : new DeliveryError('feedback_delivery_unavailable', meta.firstSendAt !== null);
      // Once a send may have happened, do not reset its uuid or safety clock.
      const ambiguousSend = (priorSendAmbiguity ?? meta.ambiguousSend) || failure.ambiguous;
      const windowClosed = meta.firstSendAt !== null && (Date.now() < meta.firstSendAt || Date.now() - meta.firstSendAt >= SEND_WINDOW_MS);
      const preparationClosed = meta.version === 2 && !meta.message && (Date.now() >= meta.preparation!.until || meta.preparation!.cycles >= 100);
      const terminal = !failure.retryable || windowClosed || meta.attempts >= 12 || preparationClosed;
      const state = terminal ? (meta.firstSendAt !== null && ambiguousSend ? 'unknown' : 'failed') : 'pending';
      const lastErrorCode = failure.code === 'feedback_delivery_window_closed' ? meta.lastErrorCode || failure.code : failure.code;
      await persist({ ...meta, state, ambiguousSend, lastErrorCode, leaseToken: null, leaseUntil: null,
        nextAttemptAt: Date.now() + Math.min(600_000, 15_000 * 2 ** Math.min(meta.attempts - 1, 6)) },
      terminal ? 'failed' : 'pending', state === 'unknown' ? 'feedback_delivery_unknown_manual_check' : failure.code);
      if (state === 'unknown') result.unknown++;
      else if (state === 'failed') result.failed++;
    }
  }
  return result;
}
