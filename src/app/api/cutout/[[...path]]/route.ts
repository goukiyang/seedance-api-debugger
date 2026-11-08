import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { proxyCutout } from '@/lib/cutout/proxy';
import { readModelAccessSettings } from '@/lib/pricing/model-access.server';
import { supplementaryModelEnabled } from '@/lib/pricing/model-availability-contract';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: { path?: string[] } };
async function proxy(request: NextRequest, context: Context) {
  const user = await getSession();
  const path = context.params.path || [], route = path.join('/');
  const capabilities = request.method === 'GET' && ['health', 'capabilities', 'v1/capabilities', 'models'].includes(route);
  let createsModelJob = request.method === 'POST' && ['cutout', 'characters/split-cutout', 'tasks', 'characters/tasks'].includes(route);
  if (user && request.method === 'POST' && route === 'v1/jobs') {
    const input = await request.clone().json().catch(() => null);
    createsModelJob = ['cutout', 'characters'].includes(input?.kind);
  }
  let enabled = true;
  if (user && (capabilities || createsModelJob)) {
    try { enabled = supplementaryModelEnabled(await readModelAccessSettings(), 'cutout', 'all'); }
    catch { return Response.json({ success: false, message: '模型开放状态暂时无法确认，尚未提交任务', submission_made: false }, { status: 503 }); }
  }
  if (createsModelJob && !enabled) return Response.json({ success: false, error: 'MODEL_CLOSED',
    message: '抠图模型已在费率页关闭，原图和历史任务保留', submission_made: false }, { status: 409 });
  const response = await proxyCutout(request, path, user);
  if (capabilities && !enabled && response.ok) {
    const payload = await response.json();
    return Response.json({ ...payload, models: [], ...(payload.integration ? { integration: { ...payload.integration,
      ready: false, message: '抠图模型已在费率页关闭，仍可查看历史结果' } } : {}) }, { headers: response.headers });
  }
  return response;
}
export const GET = proxy;
export const HEAD = proxy;
export const POST = proxy;
export const DELETE = proxy;
