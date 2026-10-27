import { route as declaredRoute } from '@/lib/http/route';
import { getSession } from '@/lib/auth/session';
import { hdControl, hdStatus, isHdRetryableFailure, listHdJobs, recheckHdResources, retryHdKey, setHdControl } from '@/lib/media/hd-derivatives';
import type { HdControl, HdResourceSample } from '@/lib/media/hd-resource-state';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
const reasonCodes = new Set(['admin_pause', 'operator_pause', 'capacity_guard', 'load_guard', 'resource_wait', 'resource_busy',
  'resource_sample_unknown', 'storage_check_unknown', 'source_missing', 'source_unreadable', 'source_incompatible',
  'multi_frame', 'pixel_limit', 'high_bit_depth', 'wide_gamut', 'unverified_color_profile', 'existing_webp', 'original_smaller',
  'source_changed', 'decode_or_source_failed', 'temporary_io', 'encode_timeout', 'output_integrity', 'published_integrity',
  'discovery_source_failure', 'retry_limit', 'worker_integrity_failure', 'hd_publish_control_hold', 'worker_interrupted',
  'unknown_failure', 'source_boundary', 'unknown_publication', 'lock_identity_unknown', 'storage_boundary']);
const publicReason = (reason?: string) => reason === undefined ? undefined : reasonCodes.has(reason) ? reason : 'unknown_failure';
const publicResource = (sample?: HdResourceSample) => sample ? { checkedAt: sample.checkedAt, load1: sample.load1,
  cpuCount: sample.cpuCount, availableMemory: sample.availableMemory, capacitySafe: sample.capacitySafe,
  result: sample.result, reason: publicReason(sample.reason) } : undefined;
function publicControl(control: HdControl) {
  return { paused: control.paused, state: control.state, reason: publicReason(control.reason), updatedAt: control.updatedAt,
    protocol: control.protocol, revision: control.revision, token: control.token,
    wait: control.wait ? { since: control.wait.since, stableSince: control.wait.stableSince, stableSamples: control.wait.stableSamples,
      checks: control.wait.checks, nextCheckAt: control.wait.nextCheckAt } : undefined,
    resource: publicResource(control.resource), history: control.history?.map(item => ({ at: item.at, state: item.state,
      reason: publicReason(item.reason), revision: item.revision, resource: publicResource(item.resource) })) };
}
async function status() {
  const value = await hdStatus();
  const { processing, ...snapshot } = value;
  const reasons: Record<string, number> = {};
  for (const [reason, count] of Object.entries(value.reasons)) {
    const code = publicReason(reason)!;
    reasons[code] = (reasons[code] || 0) + count;
  }
  return { ...snapshot, control: publicControl(value.control), reasons, resource: publicResource(value.resource || undefined) || null,
    // Queue identities and execution tokens stay in the private manifest. The
    // administrator needs the current phase and actual progress, not file paths.
    processing: processing ? { stage: processing.stage, startedAt: processing.startedAt,
      lastProgressAt: processing.lastProgressAt, attempt: processing.attempt, attemptLimit: processing.attemptLimit } : null,
    canResume: value.control.state === 'manual_pause' || value.control.state === 'resource_wait' || value.control.reason === 'load_guard',
    retryableCount: (await listHdJobs()).filter(isHdRetryableFailure).length };
}
export const GET = declaredRoute({ access: 'admin', rateLimit: false, unauthenticatedStatus: 403 }, async function GET() {
  const user = await getSession();
  if (!user || user.role !== 'admin') return Response.json({ error: '无权访问' }, { status: 403, headers });
  try { return Response.json(await status(), { headers }); }
  catch {
    return Response.json({ error: '暂时无法读取高清状态，请刷新后再操作。原有任务与原图保持不变。' }, { status: 503, headers });
  }
});
export const POST = declaredRoute({ access: 'admin', rateLimit: false, unauthenticatedStatus: 403 }, async function POST(request: Request) {
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
    for (const job of await listHdJobs()) if (isHdRetryableFailure(job)) {
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
});
