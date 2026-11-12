import { NextRequest, NextResponse } from 'next/server';
import { getAdminUser } from '@/lib/auth/api-helpers';
import { AuthError } from '@/lib/auth/session';
import { ExternalStudioAccessError, getExternalStudioAccessAdmin, getExternalStudioAccessOperation,
  saveExternalStudioAccess } from '@/lib/image-studio/external-access.server';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' };
async function route(request: NextRequest, mutate: boolean) {
  try {
    const actor = await getAdminUser(request);
    const sessionOwner = request.headers.get('x-app-session-user');
    if (sessionOwner !== null && sessionOwner !== actor.id) throw new ExternalStudioAccessError('账号已变化，请重新打开设置', 409);
    if (!mutate) {
      const requestId = request.nextUrl.searchParams.get('requestId');
      return NextResponse.json(requestId ? await getExternalStudioAccessOperation(actor, requestId)
        : await getExternalStudioAccessAdmin(actor, { q: request.nextUrl.searchParams.get('q') || undefined,
          after: request.nextUrl.searchParams.get('after') || undefined }), { headers });
    }
    let origin: URL;
    try { origin = new URL(request.headers.get('origin') || ''); } catch { throw new AuthError('请在本站操作', 403); }
    if (!['http:', 'https:'].includes(origin.protocol) || origin.host !== request.headers.get('host')
      || request.headers.get('sec-fetch-site') === 'cross-site') throw new AuthError('请求来源无效', 403);
    if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || '')) throw new ExternalStudioAccessError('请提交JSON内容', 415);
    const text = await request.text();
    if (Buffer.byteLength(text) > 128 * 1024) throw new ExternalStudioAccessError('设置内容过大', 413);
    let body: unknown;
    try { body = JSON.parse(text); } catch { throw new ExternalStudioAccessError('设置内容无法读取'); }
    return NextResponse.json(await saveExternalStudioAccess(actor, body), { headers });
  } catch (error) {
    if (error instanceof AuthError || error instanceof ExternalStudioAccessError) {
      return NextResponse.json({ error: error.message }, { status: error.status, headers });
    }
    console.warn('[ExternalStudioAccess]', { operation: mutate ? 'save' : 'read', code: 'unavailable' });
    return NextResponse.json({ error: '结果暂时无法确认，当前修改已保留；请核对原保存编号' }, { status: 503, headers });
  }
}
export const GET = (request: NextRequest) => route(request, false);
export const POST = (request: NextRequest) => route(request, true);
