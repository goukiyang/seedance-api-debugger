import { randomUUID } from 'node:crypto';
import { FEEDBACK_NOTIFICATION_TYPE, LEASE_MS, SEND_WINDOW_MS,
  feedbackPrisma as prisma, feedbackConfig, feedbackDeliveryMessage, parseFeedbackDelivery, validFeedbackRecipient, type FeedbackDelivery } from './notification';

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
  for (const job of jobs) {
    if (claimedCount >= Math.max(1, Math.min(10, limit))) break;
    let meta = parseFeedbackDelivery(job.metadata_json);
    if (!meta || job.id !== meta.uuid || meta.state !== 'pending') {
      await prisma.notification.updateMany({ where: { id: job.id, status: 'pending', metadata_json: job.metadata_json },
        data: { status: 'failed', error_message: 'feedback_metadata_invalid' } });
      result.failed++; continue;
    }
    const now = Date.now();
    if (meta.leaseUntil && meta.leaseUntil > now) continue;
    const expired = meta.firstSendAt !== null && (now < meta.firstSendAt || now - meta.firstSendAt >= SEND_WINDOW_MS);
    if (!expired && meta.nextAttemptAt > now) continue;
    const previous = job.metadata_json;
    meta = { ...meta, leaseToken: randomUUID(), leaseUntil: now + LEASE_MS, attempts: meta.attempts + 1 };
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
      const message = feedbackDeliveryMessage(meta, job.body);
      if (!message) throw new DeliveryError('feedback_payload_invalid', false, false);
      // Legacy pending rows keep their text, frozen before IO just like new cards.
      if (!meta.message) await persist({ ...meta, message }, 'pending', null);
      const token = await feedbackTenantToken();
      // Recheck immediately before send; no network call holds a SQLite transaction.
      const current = await prisma.user.findUnique({ where: { id: config.recipientId }, select: {
        id: true, status: true, role: true, expires_at: true, feishu_open_id: true, feishu_tenant_key: true,
      } });
      if (!validFeedbackRecipient(current, config)) throw new DeliveryError('feedback_identity_changed', false, false);
      if (meta.firstSendAt !== null && Date.now() - meta.firstSendAt >= SEND_WINDOW_MS) throw new DeliveryError('feedback_delivery_window_closed', meta.ambiguousSend, false);
      priorSendAmbiguity = meta.ambiguousSend;
      // A crash after starting IO is unknown; an explicit rejection clears only this attempt.
      await persist({ ...meta, firstSendAt: meta.firstSendAt ?? Date.now(), ambiguousSend: true }, 'pending', null);
      const response = await feishuRequest('im/v1/messages?receive_id_type=open_id', {
        receive_id: current!.feishu_open_id, msg_type: message.msgType, content: message.content, uuid: meta.uuid,
      }, token, meta.firstSendAt! + SEND_WINDOW_MS, meta.leaseUntil!);
      const receipt = response.data as { message_id?: unknown } | undefined;
      if (typeof receipt?.message_id !== 'string' || !receipt.message_id) throw new DeliveryError('feedback_receipt_unknown', true);
      await persist({ ...meta, state: 'sent', leaseToken: null, leaseUntil: null, receiptId: receipt.message_id }, 'sent', null, new Date());
      result.sent++;
    } catch (error) {
      const failure = error instanceof DeliveryError ? error : new DeliveryError('feedback_delivery_unavailable', meta.firstSendAt !== null);
      // Once a send may have happened, do not reset its uuid or safety clock.
      const ambiguousSend = (priorSendAmbiguity ?? meta.ambiguousSend) || failure.ambiguous;
      const windowClosed = meta.firstSendAt !== null && (Date.now() < meta.firstSendAt || Date.now() - meta.firstSendAt >= SEND_WINDOW_MS);
      const terminal = !failure.retryable || windowClosed || meta.attempts >= 12;
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
