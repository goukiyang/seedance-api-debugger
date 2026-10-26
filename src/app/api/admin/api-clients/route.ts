import { NextRequest, NextResponse } from 'next/server';
import { getAdminUser } from '@/lib/auth/api-helpers';
import { AuthError } from '@/lib/auth/session';
import { CustomerApiError, readJson } from '@/lib/customer-api/auth';
import { apiAdminSnapshot, mutateApiAdmin } from '@/lib/customer-api/admin';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' };
async function handle(request: NextRequest) {
  try {
    const admin = await getAdminUser(request);
    if (request.headers.get('x-app-session-user') !== admin.id) throw new AuthError('账号已变化，请重新打开客户 API。', 409);
    if (request.method === 'GET') return NextResponse.json({ actor_id: admin.id, ...await apiAdminSnapshot(
      request.nextUrl.searchParams.get('id') || undefined, request.nextUrl.searchParams.get('cursor') || undefined,
      request.nextUrl.searchParams.get('key_cursor') || undefined) as object }, { headers });
    let origin: URL;
    try { origin = new URL(request.headers.get('origin') || ''); } catch { throw new AuthError('请在本站操作。', 403); }
    if (!['https:', 'http:'].includes(origin.protocol) || origin.host !== request.headers.get('host') || request.headers.get('sec-fetch-site') === 'cross-site') throw new AuthError('请求来源无效。', 403);
    return NextResponse.json(await mutateApiAdmin(admin.id, await readJson(request)), { headers });
  } catch (error) {
    if (error instanceof AuthError || error instanceof CustomerApiError) return NextResponse.json({ error: error.message,
      code: error instanceof CustomerApiError ? error.code : 'ADMIN_REQUIRED' }, { status: error.status, headers });
    return NextResponse.json({ error: '操作结果暂未确认，请保留当前输入并核对原操作。', code: 'OPERATION_UNKNOWN' }, { status: 503, headers });
  }
}
export const GET = handle;
export const POST = handle;
