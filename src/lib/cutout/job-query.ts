import type { CutoutJob } from './types';

export type CutoutJobReadOutcome =
  | { kind: 'updated'; job: CutoutJob }
  | { kind: 'request-failed'; status: number }
  | { kind: 'in-flight' | 'ignored' | 'stale' };

export type CutoutJobQueryPlan = { delayMs: number | null; refreshHistory: boolean };

// A response may complete after the history page changes. Resolve the loader
// at completion time, not from the polling effect's old page closure.
export function refreshCutoutHistoryForQuery(
  plan: CutoutJobQueryPlan,
  loader: { current: (() => Promise<void>) | null },
) {
  if (plan.refreshHistory) return loader.current?.();
}

function isTerminalStatus(status: CutoutJob['status']) {
  return status === 'succeeded' || status === 'failed' || status === 'canceled';
}

function activeDelay(job: CutoutJob, now: number) {
  if (job.status === 'running') return 3500;
  const waitedSeconds = Math.max(0, now / 1000 - job.created_at);
  if (waitedSeconds < 30) return 3500;
  if (waitedSeconds < 120) return 7500;
  return 15_000;
}

function currentDelay(job: CutoutJob | null, now: number) {
  if (!job) return 3500;
  if (isTerminalStatus(job.status)) return null;
  return activeDelay(job, now);
}

export function planCutoutJobQuery(args: {
  jobId: string;
  currentJob: CutoutJob | null;
  outcome: CutoutJobReadOutcome;
  failureCount: number;
  now: number;
}): CutoutJobQueryPlan {
  const { jobId, outcome } = args;
  const currentJob = args.currentJob?.job_id === jobId ? args.currentJob : null;
  if (!jobId || outcome.kind === 'stale') return { delayMs: null, refreshHistory: false };

  if (outcome.kind === 'updated') {
    if (isTerminalStatus(outcome.job.status)) return { delayMs: null, refreshHistory: true };
    return { delayMs: activeDelay(outcome.job, args.now), refreshHistory: false };
  }

  if (outcome.kind === 'request-failed') {
    const retryable = outcome.status === 0 || outcome.status >= 500;
    if (!retryable) return { delayMs: null, refreshHistory: false };
    const failures = Math.max(1, args.failureCount);
    return {
      delayMs: Math.min(5000 * (2 ** Math.min(failures - 1, 3)), 30_000),
      refreshHistory: false,
    };
  }

  if (currentJob && isTerminalStatus(currentJob.status)) return { delayMs: null, refreshHistory: true };
  return { delayMs: currentDelay(currentJob, args.now), refreshHistory: false };
}
