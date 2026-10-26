import { NextResponse } from 'next/server';
import { AuthError, getSession } from '@/lib/auth/session';
import { ReactionError } from './content';

export async function reactionUser(request?: Request) {
  const user = await getSession();
  if (!user) throw new ReactionError('请先登录', 401);
  if (user.status !== 'active' || (user.expires_at && user.expires_at <= new Date())) throw new ReactionError('账号暂不可用', 403);
  if (request && !['GET', 'HEAD'].includes(request.method)) {
    const origin = request.headers.get('origin');
    const host = request.headers.get('host');
    if (!origin || new URL(origin).host !== host) throw new ReactionError('请在本站操作', 403);
    if (!request.headers.get('content-type')?.startsWith('application/json')) throw new ReactionError('请求格式无效', 415);
  }
  return user;
}
export const reactionJson = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
export function reactionError(error: unknown) {
  if (error instanceof ReactionError || error instanceof AuthError) return reactionJson({ error: error.message }, error.status);
  if (error instanceof SyntaxError) return reactionJson({ error: '请求格式无效' }, 400);
  console.error('[content-reactions]', error instanceof Error ? error.name : 'unknown');
  return reactionJson({ error: '喜欢暂时不可用，请稍后重试' }, 503);
}
