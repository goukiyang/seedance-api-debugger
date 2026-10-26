import 'server-only';
import type { SessionUser } from '@/lib/auth/session';
import { proxyCutout } from '@/lib/cutout/proxy';
import { isCutoutJob } from '@/lib/cutout/receipt';
import { cutoutResultContent, parseCutoutResultKey } from '@/lib/cutout/result-content';
import type { CutoutJob } from '@/lib/cutout/types';

export type CutoutContentContext = { userId: string; jobs: Map<string, Promise<CutoutJob | null>> };
export const createCutoutContentContext = (userId: string): CutoutContentContext => ({ userId, jobs: new Map() });

async function readJob(user: SessionUser, jobId: string): Promise<CutoutJob | null> {
  const response = await proxyCutout(new Request(`http://127.0.0.1/api/cutout/v1/jobs/${encodeURIComponent(jobId)}`), ['v1', 'jobs', jobId], user);
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status >= 500) throw new Error('cutout_result_read_unavailable');
    return null;
  }
  const value: unknown = await response.json();
  return isCutoutJob(value, { id: jobId }) ? value : null;
}

export async function resolveCutoutResult(user: SessionUser, key: string, context?: CutoutContentContext) {
  const identity = parseCutoutResultKey(key);
  if (!identity || user.role !== 'admin') return null;
  // Only one resolution request may reuse a DTO. The original proxy enforces the current business binding.
  const requestContext = context?.userId === user.id ? context : createCutoutContentContext(user.id);
  let job = requestContext.jobs.get(identity.jobId);
  if (!job) { job = readJob(user, identity.jobId); requestContext.jobs.set(identity.jobId, job); }
  const dto = await job;
  const result = dto ? cutoutResultContent(dto, identity.selector) : null;
  return result ? { ...result, jobId: identity.jobId } : null;
}
