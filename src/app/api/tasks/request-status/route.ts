import { route as apiRoute } from '@/lib/http/route';
import { cookieOrCodexIdentity } from '@/lib/http/route-identities';
import { apiErrorResponse } from '@/lib/http/api-error';
import { NextRequest, NextResponse } from 'next/server';
import { AuthError, getSession } from '@/lib/auth/session';
import { assertFeatureAllowed } from '@/lib/access/feature-guard';
import { prisma } from '@/lib/prisma';
import { assertCanViewTask } from '@/lib/projects/permissions';
import { VOLCENGINE_IP_VIDEO_PROVIDER } from '@/lib/provider/volcengine-ip';
import { readMultiviewRequestReceipt, closeUnacceptedMultiviewRequest } from '@/lib/video/multiview-request-receipt';
import { resolveSitePublicBaseUrl } from '@/lib/assets/site-url';
import { authenticateCodexVideoApi, hasCodexApiAuthSignal, CodexApiAuthError } from '@/lib/integrations/codex';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie, Authorization' };
const taskSelect = { id: true, user_id: true, owner_user_id: true, local_status: true, project_id: true,
  video_card_id: true, retention_status: true, provider: true } as const;

async function requestError(error: unknown) {
  const response = apiErrorResponse(error);
  return NextResponse.json({ ...await response.json(), safeToResubmit: false }, { status: response.status, headers });
}

export const GET = apiRoute({ access: 'user', identity: async request => {
  try {
    const user = await cookieOrCodexIdentity(request);
    return user || NextResponse.json({ error: '请先登录', safeToResubmit: false }, { status: 401, headers });
  } catch (error) {
    if (error instanceof CodexApiAuthError) return NextResponse.json({ error: error.message, safeToResubmit: false }, { status: error.status, headers });
    return requestError(error);
  }
}, rateLimit: false }, async function GET(request: NextRequest) {
  try {
    const codex = hasCodexApiAuthSignal(request) ? await authenticateCodexVideoApi(request) : null;
    const user = codex?.user || await getSession();
    if (!user || user.status !== 'active') return NextResponse.json({ error: '请先登录', safeToResubmit: false }, { status: 401, headers });
    const expectedActor = request.headers.get('x-app-session-user');
    if (expectedActor && expectedActor !== user.id) return NextResponse.json({ error: '账号已变化，请切回原账号查询原请求', code: 'pricing_actor_changed', safeToResubmit: false }, { status: 409, headers });
    if (!(codex && user.account_type === 'internal')) assertFeatureAllowed(user, 'standard_generate', '外部账号请使用原 IP 任务查询入口');
    const key = request.nextUrl.searchParams.get('idempotency_key')?.trim();
    if (!key || key.length > 200) return NextResponse.json({ error: '请求号无效', safeToResubmit: false }, { status: 400, headers });
    const task = await prisma.videoTask.findUnique({
      where: { user_id_idempotency_key: { user_id: user.id, idempotency_key: key } },
      select: taskSelect,
    });
    if (task) await assertCanViewTask(user, task);
    if (task?.provider === VOLCENGINE_IP_VIDEO_PROVIDER) return NextResponse.json({ error: '请通过原 IP 任务查询入口确认', safeToResubmit: false }, { status: 400, headers });
    if (task) return NextResponse.json({ task: { id: task.id, status: task.local_status, project_id: task.project_id, video_card_id: task.video_card_id },
      lookup: 'found', safeToResubmit: false }, { headers });
    const stored = await readMultiviewRequestReceipt(user.id, key);
    return NextResponse.json({ task: null, lookup: stored?.receipt?.state || (stored ? 'pending' : 'not_found'), safeToResubmit: false,
      ...(stored?.receipt ? { request_receipt: stored.receipt, new_request_allowed: true } : {}) }, { headers });
  } catch (error) {
    if (error instanceof CodexApiAuthError) return NextResponse.json({ error: error.message, safeToResubmit: false }, { status: error.status, headers });
    if (error instanceof AuthError) return NextResponse.json({ error: error.message, safeToResubmit: false }, { status: error.status, headers });
    return requestError(error);
  }
});

async function closeBody(request: NextRequest) {
  const reader = request.body?.getReader();
  if (!reader || Number(request.headers.get('content-length')) > 4096) { await reader?.cancel(); return null; }
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.length; if (bytes > 4096) return null;
      chunks.push(next.value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>; } catch { return null; }
  } finally { await reader.cancel().catch(() => undefined); }
}

export const POST = apiRoute({ access: 'user', rateLimit: false }, async function POST(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user || user.status !== 'active') return NextResponse.json({ error: '请先登录', safeToResubmit: false }, { status: 401, headers });
    assertFeatureAllowed(user, 'standard_generate', '外部账号请使用原 IP 任务查询入口');
    let sameOrigin = false;
    try {
      // Production uses the configured public site, not Next's HTTP origin behind nginx.
      const trustedOrigin = new URL(resolveSitePublicBaseUrl() || request.nextUrl.origin).origin;
      const origin = new URL(request.headers.get('origin') || '');
      sameOrigin = ['https:', 'http:'].includes(origin.protocol) && !origin.username && !origin.password && origin.origin === trustedOrigin;
    } catch {}
    if (!sameOrigin) return NextResponse.json({ error: '请求来源无效', safeToResubmit: false }, { status: 403, headers });
    const body = await closeBody(request);
    const key = typeof body?.idempotency_key === 'string' ? body.idempotency_key.trim() : '';
    if (!body || body.action !== 'close_unaccepted' || Object.keys(body).some(field => !['action', 'idempotency_key'].includes(field))
      || !key || key.length > 200 || body.idempotency_key !== key) {
      return NextResponse.json({ error: '结束原提交的请求无效', safeToResubmit: false }, { status: 400, headers });
    }
    const result = await closeUnacceptedMultiviewRequest(user.id, key);
    if (result.kind === 'task') {
      const task = await prisma.videoTask.findUnique({ where: { user_id_idempotency_key: { user_id: user.id, idempotency_key: key } }, select: taskSelect });
      if (!task || task.id !== result.taskId) throw new Error('task changed');
      await assertCanViewTask(user, task);
      if (task.provider === VOLCENGINE_IP_VIDEO_PROVIDER) return NextResponse.json({ error: '请通过原 IP 任务查询入口确认', safeToResubmit: false }, { status: 400, headers });
      return NextResponse.json({ task: { id: task.id, status: task.local_status, project_id: task.project_id, video_card_id: task.video_card_id },
        lookup: 'found', safeToResubmit: false }, { headers });
    }
    if (result.kind === 'unknown') return NextResponse.json({ task: null, lookup: 'pending',
      error: '已发现原受理或费用关联记录，本次没有结束。请继续核对原请求。', safeToResubmit: false }, { status: 409, headers });
    return NextResponse.json({ task: null, lookup: result.receipt.state, request_receipt: result.receipt,
      new_request_allowed: true, safeToResubmit: false }, { headers });
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message, safeToResubmit: false }, { status: error.status, headers });
    return requestError(error);
  }
});
