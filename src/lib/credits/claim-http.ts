import { NextRequest, NextResponse } from 'next/server';
import { AuthError } from '@/lib/auth/session';
import { CreditClaimError } from './claim-campaigns';

export function claimJson(value: unknown, status = 200) {
  return NextResponse.json(value, { status, headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
}
export function claimFailure(error: unknown) {
  const known = error instanceof CreditClaimError || error instanceof AuthError;
  return claimJson({ error: known ? error.message : '未能确认操作结果，请刷新核对后重试' }, known ? error.status : 503);
}
export function checkClaimActor(request: NextRequest, userId: string, required = false) {
  const owner = request.headers.get('x-app-session-user');
  if ((required || owner !== null) && owner !== userId) throw new CreditClaimError('登录账号已变化，请刷新页面后操作', 409);
}
export async function readClaimBody(request: NextRequest, userId: string) {
  checkClaimActor(request, userId, true);
  const origin = request.headers.get('origin');
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host');
  if (!origin || new URL(origin).host !== host || request.headers.get('sec-fetch-site') === 'cross-site') throw new CreditClaimError('请求来源无效', 403);
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new CreditClaimError('请求格式无效', 415);
  const reader = request.body?.getReader();
  if (!reader) throw new CreditClaimError('请求内容为空');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 8192) { await reader.cancel(); throw new CreditClaimError('请求过大', 413); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new CreditClaimError('请求内容无效'); }
}
