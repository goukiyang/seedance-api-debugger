import { NextRequest, NextResponse } from 'next/server';
import { getSession, AuthError, type SessionUser } from '@/lib/auth/session';
import { MultiviewError } from './multiview';
import { MultiviewWorkError } from './multiview-works';
import { apiErrorResponse } from '@/lib/http/api-error';
import { PaginationError } from '@/lib/pagination/cursor';

export const multiviewWorkHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' };
export async function multiviewWorkRoute(request: NextRequest, mutate: boolean,
  action: (user: SessionUser, body: Record<string, unknown>) => Promise<unknown>) {
  const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: multiviewWorkHeaders });
  try {
    const user = await getSession();
    if (!user) throw new AuthError('请先登录', 401);
    const expectedOwner = request.headers.get('x-app-session-user');
    if (expectedOwner !== null && expectedOwner !== user.id) throw new MultiviewWorkError('账号已变化，请回到当前账号重新打开作品。', 409, 'WORK_SESSION_CHANGED', { notCommitted: true });
    let body: Record<string, unknown> = {};
    if (mutate) {
      const origin = request.headers.get('origin');
      let sameOrigin = false;
      try { sameOrigin = Boolean(origin && new URL(origin).host === request.headers.get('host')); } catch {}
      if (request.headers.get('sec-fetch-site') === 'cross-site' || !sameOrigin) throw new AuthError('请求来源无效', 403);
      const reader = request.body?.getReader();
      if (!reader) throw new MultiviewWorkError('保存内容无效。');
      const chunks: Uint8Array[] = []; let bytes = 0;
      try {
        while (true) {
          const part = await reader.read(); if (part.done) break;
          bytes += part.value.length;
          if (bytes > 65536) { await reader.cancel(); throw new MultiviewWorkError('作品设置过大，未保存或截断。', 413, 'WORK_INVALID', { notCommitted: true }); }
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
      let parsed: unknown;
      try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new MultiviewWorkError('作品请求格式无效，原输入保留。', 400, 'WORK_INVALID', { notCommitted: true }); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new MultiviewWorkError('保存内容须为对象。');
      body = parsed as Record<string, unknown>;
    }
    const result = await action(user, body);
    return result instanceof Response ? result : json(result);
  } catch (error) {
    if (error instanceof PaginationError) return json({ error: error.message }, error.status);
    if (error instanceof MultiviewWorkError) return json({ error: error.message, code: error.code, ...error.details }, error.status);
    if (error instanceof AuthError || error instanceof MultiviewError) return json({ error: error.message }, error.status);
    const diagnostic = await apiErrorResponse(error).json() as { errorId?: string };
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2021') return json({ error: '作品存储尚未就绪，请稍后重试，原生成与选帧功能仍可用。', code: 'WORK_STORAGE_PENDING', errorId: diagnostic.errorId }, 503);
    return json({ error: '作品操作结果暂时无法确认，请保留本机修改并查询原保存编号。', code: 'WORK_SAVE_UNKNOWN', errorId: diagnostic.errorId }, 503);
  }
}
