import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth/api-helpers';
import { AuthError, type SessionUser } from '@/lib/auth/session';
import { MultiviewError } from './multiview';
import { MultiviewPresetError } from './multiview-preset.server';
import { assertMultiviewSettingsActor, MultiviewSettingsError } from './multiview-settings.server';

export const multiviewSettingsHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' };
export async function multiviewSettingsRoute(request: NextRequest, mutate: boolean,
  action: (user: SessionUser, body: Record<string, unknown>) => Promise<unknown>) {
  const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: multiviewSettingsHeaders });
  try {
    const user = await getSessionUser(request);
    await assertMultiviewSettingsActor(user);
    const owner = request.headers.get('x-app-session-user');
    if (owner !== null && owner !== user.id) throw new MultiviewSettingsError('账号已变化，请回当前账号重新打开设置。', 409, 'MULTIVIEW_SETTINGS_SESSION_CHANGED');
    let body: Record<string, unknown> = {};
    if (mutate) {
      const origin = request.headers.get('origin');
      let sameOrigin = false;
      try { sameOrigin = Boolean(origin && new URL(origin).host === request.headers.get('host')); } catch {}
      if (!sameOrigin || request.headers.get('sec-fetch-site') === 'cross-site') throw new AuthError('请求来源无效', 403);
      const reader = request.body?.getReader();
      if (!reader) throw new MultiviewSettingsError('设置请求为空。');
      const chunks: Uint8Array[] = []; let bytes = 0;
      try {
        while (true) {
          const next = await reader.read(); if (next.done) break;
          bytes += next.value.length;
          if (bytes > 196608) { await reader.cancel(); throw new MultiviewSettingsError('设置内容过大，未保存或截断。', 413); }
          chunks.push(next.value);
        }
      } finally { reader.releaseLock(); }
      let value: unknown;
      try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new MultiviewSettingsError('设置格式无效，原输入保留。'); }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MultiviewSettingsError('设置须为对象。');
      body = value as Record<string, unknown>;
    }
    return json(await action(user, body));
  } catch (error) {
    if (error instanceof MultiviewSettingsError) return json({ error: error.message, code: error.code,
      ...(mutate && error.notCommitted ? { notCommitted: true } : {}) }, error.status);
    if (error instanceof AuthError || error instanceof MultiviewError || error instanceof MultiviewPresetError) {
      return json({ error: error.message, ...(error instanceof MultiviewPresetError ? { code: error.code } : {}),
        ...(mutate ? { notCommitted: true } : {}) }, error.status);
    }
    return json({ error: '设置操作结果暂时无法确认，请保留输入并核对原保存编号。', code: 'MULTIVIEW_SETTINGS_SAVE_UNKNOWN' }, 503);
  }
}
