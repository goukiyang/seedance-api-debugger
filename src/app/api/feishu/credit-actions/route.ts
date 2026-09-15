import { NextRequest, NextResponse } from 'next/server';
import { verifyCreditCallback } from '@/lib/feishu/credit-callback';
import { handleCreditDecision } from '@/lib/credits/requests';
import { CreditRequestError } from '@/lib/credits/request-rules';
import { CREDIT_CARD_SOURCE, verifyCreditRelay } from '@/lib/feishu/credit-relay';

export const runtime = 'nodejs';
export async function POST(request: NextRequest) {
  let verified;
  try {
    if (Number(request.headers.get('content-length') || 0) > 32768) return NextResponse.json({ error: 'request_too_large' }, { status: 413 });
    const reader = request.body?.getReader();
    if (!reader) throw new Error('missing_body');
    const chunks: Uint8Array[] = []; let length = 0;
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.length;
      if (length > 32768) { await reader.cancel(); return NextResponse.json({ error: 'request_too_large' }, { status: 413 }); }
      chunks.push(value);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    verified = process.env.CREDIT_CALLBACK_MODE === 'relay-v1'
      ? verifyCreditRelay(raw, request.headers) : verifyCreditCallback(raw, request.headers, {
      encryptKey: process.env.FEISHU_CREDIT_ENCRYPT_KEY || '', verificationToken: process.env.FEISHU_CREDIT_VERIFICATION_TOKEN || '',
      appId: process.env.FEISHU_APP_ID || '', tenantKey: process.env.FEISHU_ALLOWED_TENANT_KEY || '',
    });
  } catch {
    return NextResponse.json({ error: 'callback_verification_failed' }, { status: 401 });
  }
  if ('challenge' in verified && verified.challenge) return NextResponse.json({ challenge: verified.challenge });
  try {
    const event = verified.event;
    const value = event?.action?.value;
    if (!value || value.source !== CREDIT_CARD_SOURCE || typeof value.requestId !== 'string' || !['prepare', 'confirm', 'back', 'reject'].includes(value.action)) throw new CreditRequestError('卡片操作无效');
    const result = await handleCreditDecision({ requestId: value.requestId, action: value.action,
      openId: event.operator?.open_id, nonce: value.nonce, amount: value.amount, confirmationNonce: value.confirmationNonce });
    return NextResponse.json({ toast: { type: 'success', content: result.message }, card: { type: 'raw', data: result.card } });
  } catch (error) {
    return NextResponse.json({ toast: { type: 'error', content: error instanceof CreditRequestError ? error.message : '暂未完成，请稍后重试或在网站查看申请' } });
  }
}
