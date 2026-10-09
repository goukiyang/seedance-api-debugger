import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { AuthError, getSession, type SessionUser } from '@/lib/auth/session';
import { CanvasDocumentError } from '@/lib/canvas-documents';
import { assertRoleUser } from './permissions';
import { record, RoleError, type JsonRecord } from './types';

export async function roleRoute(request: NextRequest, mutate: boolean,
  action: (user: SessionUser, body: JsonRecord) => Promise<unknown>) {
  const json = (value: unknown, status = 200) => NextResponse.json(value, { status, headers: { 'Cache-Control': 'private, no-store' } });
  try {
    const user = await getSession();
    if (!user) throw new AuthError('未登录', 401);
    assertRoleUser(user);
    let body: JsonRecord = {};
    if (mutate) {
      // Same-site is an additional CSRF boundary; no Host/proxy inference grants cross-origin access.
      const origin = request.headers.get('origin'), site = request.headers.get('sec-fetch-site');
      if (site === 'cross-site' || (origin && new URL(origin).host !== request.headers.get('host'))) throw new RoleError('请求来源不匹配', 403, 'invalid_origin');
      const reader = request.body?.getReader();
      if (!reader) throw new RoleError('缺少请求内容');
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const part = await reader.read(); if (part.done) break;
          size += part.value.byteLength;
          if (size > 512 * 1024) { await reader.cancel(); throw new RoleError('请求过大', 413); }
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!record(parsed)) throw new RoleError('请求须为对象');
      body = parsed;
    }
    const result = await action(user, body);
    return result instanceof Response ? result : json(result);
  } catch (error) {
    if (error instanceof RoleError || error instanceof CanvasDocumentError) return json({ error: error.message, code: error.code, ...error.details }, error.status);
    if (error instanceof AuthError) return json({ error: error.message }, error.status);
    if (error instanceof SyntaxError || error instanceof TypeError) return json({ error: '请求格式无效' }, 400);
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2021') return json({ error: '角色存储尚未启用，原画布功能不受影响', code: 'role_storage_pending' }, 503);
    // Never log a Prisma error body containing private role/task material.
    console.error('[CanvasRoles]', error instanceof Error ? error.name : 'UnknownError');
    return json({ error: '角色操作未确认，请保留草稿和原请求编号查询回执', code: 'role_operation_unconfirmed' }, 500);
  }
}
