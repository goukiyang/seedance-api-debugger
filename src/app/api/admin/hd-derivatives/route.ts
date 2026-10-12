import { getSession } from '@/lib/auth/session';
import { hdControl, hdStatus, listHdJobs, retryHdKey, setHdControl } from '@/lib/media/hd-derivatives';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
async function status() {
  const value = await hdStatus();
  return { ...value, canResume: value.control.paused && ['admin_pause', 'operator_pause'].includes(value.control.reason || ''),
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
  if (!body || !['pause', 'resume', 'retry'].includes(body.action)) return Response.json({ error: '操作无效' }, { status: 400, headers });
  const control = await hdControl();
  let retrySummary: { queued: number; held: number } | undefined;
  if (body.action === 'pause') {
    // An ordinary pause must not relabel an integrity/capacity stop as safe to resume.
    if (!control.paused) await setHdControl(true, 'admin_pause');
  } else if (body.action === 'resume') {
    if (!control.paused || !['admin_pause', 'operator_pause'].includes(control.reason || '')) {
      return Response.json({ error: '本次安全暂停需先核对原因并完成小批校验，不能直接继续' }, { status: 409, headers });
    }
    await setHdControl(false);
  } else {
    retrySummary = { queued: 0, held: 0 };
    for (const job of await listHdJobs()) if (job.status === 'failed' && job.reason === 'temporary_io') {
      try { if (await retryHdKey(job.key, job.version)) retrySummary.queued++; else retrySummary.held++; }
      catch { retrySummary.held++; }
    }
  }
  return Response.json({ ...await status(), ...(retrySummary ? { retrySummary } : {}) }, { headers });
}
