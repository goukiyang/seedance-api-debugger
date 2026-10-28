import { createHmac, timingSafeEqual } from 'node:crypto';

export const FEEDBACK_CARD_SOURCE = 'sd2_feedback_ack_v1';
export function verifyFeedbackRelay(raw: string, headers: Headers, now = Date.now()) {
  const secret = process.env.FEISHU_APP_SECRET;
  const timestamp = headers.get('x-sd2-feedback-time') || '';
  const signature = headers.get('x-sd2-feedback-signature') || '';
  if (!secret || !process.env.FEISHU_APP_ID || !process.env.FEISHU_ALLOWED_TENANT_KEY
    || Buffer.byteLength(raw) > 32768 || !/^\d{13}$/.test(timestamp)
    || Math.abs(now - Number(timestamp)) > 60000 || !/^[a-f0-9]{64}$/.test(signature)) throw new Error('invalid_feedback_relay');
  const expected = createHmac('sha256', secret).update(`sd2-feedback-relay-v1\n${timestamp}\n${raw}`).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) throw new Error('invalid_feedback_relay');
  const payload = JSON.parse(raw);
  if (payload.header?.app_id !== process.env.FEISHU_APP_ID || payload.header?.tenant_key !== process.env.FEISHU_ALLOWED_TENANT_KEY
    || payload.header?.event_type !== 'card.action.trigger' || payload.event?.action?.value?.source !== FEEDBACK_CARD_SOURCE
    || payload.event.operator?.tenant_key && payload.event.operator.tenant_key !== process.env.FEISHU_ALLOWED_TENANT_KEY) throw new Error('invalid_feedback_source');
  return { event: payload.event, context: payload.context };
}
