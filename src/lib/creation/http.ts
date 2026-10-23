import { NextResponse } from 'next/server';
import { getSession, AuthError, type SessionUser } from '@/lib/auth/session';
import { CreationError } from './contract';
export async function creationHttp(action: (user: SessionUser) => Promise<unknown>) {
  const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
  try {
    const user = await getSession();
    if (!user || user.status !== 'active' || user.expires_at && user.expires_at.getTime() <= Date.now()) return NextResponse.json({ error: '请先登录' }, { status: 401, headers });
    return NextResponse.json(await action(user), { headers });
  } catch (error) {
    const known = error instanceof CreationError || error instanceof AuthError;
    return NextResponse.json({ error: known ? error.message : '操作结果暂时无法确认，请保留原请求号并查询',
      code: error instanceof CreationError ? error.code : 'creation_result_unknown', stage: 'creation',
      ...(error instanceof CreationError ? { field: error.field, action: error.action } : {}) },
    { status: known ? error.status : 503, headers });
  }
}
export async function creationBody(request: Request): Promise<Record<string, unknown>> {
  const expected = request.headers.get('x-app-session-user');
  if (expected) { const user = await getSession(); if (!user || user.id !== expected) throw new CreationError('账号已变化，请回到原账号核对原请求', 409, 'creation_actor_changed', 'account', 'query_original'); }
  const text = await request.text();
  if (text.length > 262144) throw new CreationError('请求过大', 413, 'creation_input_invalid');
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new CreationError('请求内容无效，原输入已保留', 400, 'creation_input_invalid'); }
}
