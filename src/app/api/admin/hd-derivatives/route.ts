import { getSession } from '@/lib/auth/session';
import { hdControl, hdStatus, listHdJobs, recheckHdResources, retryHdKey, setHdControl } from '@/lib/media/hd-derivatives';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
async function status() {
  const value = await hdStatus();
  return { ...value, canResume: value.control.state === 'manual_pause' || value.control.state === 'resource_wait' || value.control.reason === 'load_guard',
    retryableCount: (await listHdJobs()).filter(job => job.status === 'failed' && job.reason === 'temporary_io').length };
}
export async function GET() {
  const user = await getSession();
  if (!user || user.role !== 'admin') return Response.json({ error: '无权访问' }, { status: 403, headers });
  return Response.json(await status(), { headers });
}
export async function POST(request: Request) {
  const user = await getSession();
  if (!user || user.role !== 'admin') return Response.json({ error: '无权访问' }, { status: 403, headers });
  if (request.headers.get('origin') !== new URL(request.url).origin) return Response.json({ error: '请求来源无效' }, { status: 403, headers });
  const body = await request.json().catch(() => null);
  if (!body || !['pause', 'resume', 'recheck', 'retry'].includes(body.action)) return Response.json({ error: '操作无效' }, { status: 400, headers });
  const control = await hdControl();
  if (typeof body.token !== 'string' || body.token !== control.token) return Response.json({ error: '状态已变化，请刷新状态后再操作' }, { status: 409, headers });
  let retrySummary: { queued: number; held: number } | undefined;
  try {
  if (body.action === 'pause') {
    // An ordinary pause must not relabel an integrity/capacity stop as safe to resume.
    await setHdControl(true, 'admin_pause', control.token);
  } else if (body.action === 'resume' || body.action === 'recheck') {
    const result = await recheckHdResources({ expectedToken: control.token, allowManualResume: true });
    if (result.conflict) throw new Error('hd_control_conflict');
  } else {
    retrySummary = { queued: 0, held: 0 };
    for (const job of await listHdJobs()) if (job.status === 'failed' && job.reason === 'temporary_io') {
      try { if (await retryHdKey(job.key, job.version)) retrySummary.queued++; else retrySummary.held++; }
      catch { retrySummary.held++; }
    }
  }
  return Response.json({ ...await status(), ...(retrySummary ? { retrySummary } : {}) }, { headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return Response.json({ error: message === 'hd_hard_pause_requires_review'
      ? '需要先处理文件校验、空间或读取异常，再由维护人员核对恢复。原图仍可查看和下载。'
      : message === 'hd_control_conflict' ? '状态已变化，请刷新状态后再操作'
        : '本次操作未能确认完成，请刷新状态后再核对，原状态已保留' }, { status: 409, headers });
  }
}
