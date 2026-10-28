import { randomUUID } from 'node:crypto';
import { feedbackPrisma as prisma, feedbackConfig, LEASE_MS, SEND_WINDOW_MS } from './notification';
import { DeliveryError, feedbackTenantToken, feishuRequest } from './delivery';
import { feedbackAuthorBinding, feedbackRetestNotificationId, FEEDBACK_RETEST_TYPE } from './lifecycle';
import { feedbackRoundKey, parseFeedbackRound, readFeedbackFlow, validFeedbackId } from './flow-state';

type RetestDelivery = {
  version: 1; feedbackId: string; round: number; uuid: string; identity: string;
  state: 'pending' | 'sent' | 'failed' | 'unknown'; attempts: number; nextAttemptAt: number;
  firstSendAt: number | null; leaseToken: string | null; leaseUntil: number | null;
  receiptId: string | null; ambiguousSend: boolean; lastErrorCode: string | null;
  message: { msgType: 'interactive'; content: string };
};
function parse(raw: string | null): RetestDelivery | null {
  try {
    if (!raw || raw.length > 40_000) return null;
    const m = JSON.parse(raw) as RetestDelivery;
    const time = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
    if (m.version !== 1 || !validFeedbackId(m.feedbackId) || !Number.isSafeInteger(m.round) || m.round < 1
      || m.uuid !== feedbackRetestNotificationId(m.feedbackId, m.round) || !/^[a-f0-9]{64}$/.test(m.identity)
      || !['pending', 'sent', 'failed', 'unknown'].includes(m.state) || !time(m.attempts) || !time(m.nextAttemptAt)
      || m.firstSendAt !== null && !time(m.firstSendAt) || m.leaseUntil !== null && !time(m.leaseUntil)
      || m.leaseToken !== null && typeof m.leaseToken !== 'string' || typeof m.ambiguousSend !== 'boolean'
      || m.receiptId !== null && typeof m.receiptId !== 'string' || m.lastErrorCode !== null && typeof m.lastErrorCode !== 'string'
      || m.message?.msgType !== 'interactive' || typeof m.message.content !== 'string' || !m.message.content) return null;
    return m;
  } catch { return null; }
}

export async function processFeedbackRetestDeliveries(limit = 3) {
  const config = feedbackConfig();
  const result = { enabled: Boolean(config.enabled && config.appId && config.appSecret && config.tenant), sent: 0, failed: 0, unknown: 0 };
  if (!result.enabled) return result;
  const jobs = await prisma.notification.findMany({ where: { type: FEEDBACK_RETEST_TYPE, channel: 'feishu', status: 'pending' },
    orderBy: { updated_at: 'asc' }, take: 50 });
  let claimed = 0;
  for (const job of jobs) {
    if (claimed >= Math.max(1, Math.min(10, limit))) break;
    let meta = parse(job.metadata_json);
    if (!meta || meta.uuid !== job.id || meta.state !== 'pending' || !job.target_user_id) {
      await prisma.notification.updateMany({ where: { id: job.id, status: 'pending', metadata_json: job.metadata_json },
        data: { status: 'failed', error_message: 'feedback_retest_metadata_invalid' } });
      result.failed++; continue;
    }
    const now = Date.now();
    if (meta.leaseUntil !== null && meta.leaseUntil > now) continue;
    const closed = meta.firstSendAt !== null && (now < meta.firstSendAt || now - meta.firstSendAt >= SEND_WINDOW_MS);
    if (!closed && meta.nextAttemptAt > now) continue;
    meta = { ...meta, leaseToken: randomUUID(), leaseUntil: now + LEASE_MS, attempts: meta.attempts + 1 };
    let owned = JSON.stringify(meta);
    const claim = await prisma.notification.updateMany({ where: { id: job.id, status: 'pending', metadata_json: job.metadata_json }, data: { metadata_json: owned } });
    if (!claim.count) continue;
    claimed++;
    const persist = async (next: RetestDelivery, status: 'pending' | 'failed' | 'sent', error: string | null) => {
      const serialized = JSON.stringify(next);
      const write = await prisma.notification.updateMany({ where: { id: job.id, status: 'pending', metadata_json: owned },
        data: { metadata_json: serialized, status, error_message: error, ...(status === 'sent' ? { sent_at: new Date() } : {}) } });
      if (write.count !== 1) throw new DeliveryError('feedback_retest_lease_lost', true, false);
      meta = next; owned = serialized;
    };
    const freshRecipient = async () => {
      const feedback = await prisma.feedback.findUnique({ where: { id: meta!.feedbackId }, select: { user_id: true } });
      const roundRow = await prisma.platformSetting.findUnique({ where: { key: feedbackRoundKey(meta!.feedbackId, meta!.round) } });
      const round = roundRow && parseFeedbackRound(roundRow.value_json, meta!.feedbackId, meta!.round);
      const user = await prisma.user.findUnique({ where: { id: job.target_user_id! }, select: {
        id: true, status: true, expires_at: true, feishu_open_id: true, feishu_tenant_key: true,
      } });
      if (!user || feedback?.user_id !== job.target_user_id || !round || round.notificationId !== job.id
        || feedbackAuthorBinding(user) !== meta!.identity) throw new DeliveryError('feedback_retest_recipient_changed', false, false);
      if (round.review) throw new DeliveryError('feedback_retest_already_reviewed', false, false);
      const { flow } = await readFeedbackFlow(prisma, meta!.feedbackId);
      if (flow.currentRound !== meta!.round) throw new DeliveryError('feedback_retest_superseded', false, false);
      return user;
    };
    let priorAmbiguity = meta.ambiguousSend;
    try {
      if (closed || meta.attempts > 12) throw new DeliveryError('feedback_retest_window_closed', meta.ambiguousSend, false);
      await freshRecipient();
      const token = await feedbackTenantToken();
      const recipient = await freshRecipient();
      const body = { receive_id: recipient.feishu_open_id, msg_type: meta.message.msgType, content: meta.message.content, uuid: meta.uuid };
      if (Buffer.byteLength(JSON.stringify(body), 'utf8') > 30_000) throw new DeliveryError('feedback_retest_payload_too_large', false, false);
      priorAmbiguity = meta.ambiguousSend;
      await persist({ ...meta, firstSendAt: meta.firstSendAt ?? Date.now(), ambiguousSend: true }, 'pending', null);
      const response = await feishuRequest('im/v1/messages?receive_id_type=open_id', body, token, meta.firstSendAt! + SEND_WINDOW_MS, meta.leaseUntil!);
      const receipt = response.data as { message_id?: unknown } | undefined;
      if (typeof receipt?.message_id !== 'string' || !receipt.message_id) throw new DeliveryError('feedback_retest_receipt_unknown', true);
      await persist({ ...meta, state: 'sent', receiptId: receipt.message_id, leaseToken: null, leaseUntil: null }, 'sent', null);
      result.sent++;
    } catch (error) {
      const failure = error instanceof DeliveryError ? error : new DeliveryError('feedback_retest_unavailable', meta.firstSendAt !== null);
      const ambiguous = priorAmbiguity || failure.ambiguous;
      const windowClosed = meta.firstSendAt !== null && (Date.now() < meta.firstSendAt || Date.now() - meta.firstSendAt >= SEND_WINDOW_MS);
      const terminal = !failure.retryable || windowClosed || meta.attempts >= 12;
      const state = terminal ? meta.firstSendAt !== null && ambiguous ? 'unknown' : 'failed' : 'pending';
      await persist({ ...meta, state, ambiguousSend: ambiguous, lastErrorCode: failure.code, leaseToken: null, leaseUntil: null,
        nextAttemptAt: Date.now() + Math.min(600_000, 15_000 * 2 ** Math.min(6, meta.attempts - 1)) },
      terminal ? 'failed' : 'pending', state === 'unknown' ? 'feedback_retest_delivery_unknown' : failure.code);
      if (state === 'unknown') result.unknown++;
      if (state === 'failed') result.failed++;
    }
  }
  return result;
}
