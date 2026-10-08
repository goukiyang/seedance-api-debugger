import assert from 'node:assert/strict';
import { planCutoutJobQuery, refreshCutoutHistoryForQuery, type CutoutJobReadOutcome } from '../src/lib/cutout/job-query';
import type { CutoutJob, CutoutStatus } from '../src/lib/cutout/types';

function job(status: CutoutStatus): CutoutJob {
  return { job_id: 'restored-job', kind: 'cutout', status, created_at: 10, updated_at: 20 };
}

function plan(outcome: CutoutJobReadOutcome, currentJob: CutoutJob | null = null, failureCount = 0) {
  return planCutoutJobQuery({ jobId: 'restored-job', currentJob, outcome, failureCount, now: 25_000 });
}

async function main() {
  let checks = 0;
  for (const status of ['succeeded', 'failed', 'canceled'] as const) {
    assert.deepEqual(plan({ kind: 'updated', job: job(status) }), { delayMs: null, refreshHistory: true });
    checks++;
  }

  assert.deepEqual(plan({ kind: 'in-flight' }), { delayMs: 3500, refreshHistory: false },
    'a restored job id without loaded details remains eligible for foreground polling'); checks++;
  assert.deepEqual(plan({ kind: 'request-failed', status: 0 }, null, 1), { delayMs: 5000, refreshHistory: false },
    'a first network failure remains retryable when the restored id has no details yet'); checks++;
  assert.deepEqual(plan({ kind: 'request-failed', status: 503 }, null, 2), { delayMs: 10_000, refreshHistory: false },
    'transient server failures use bounded backoff'); checks++;

  for (const status of [401, 403, 404]) {
    assert.deepEqual(plan({ kind: 'request-failed', status }), { delayMs: null, refreshHistory: false },
      `HTTP ${status} does not trigger an automatic retry loop`);
    checks++;
  }

  assert.deepEqual(plan({ kind: 'stale' }), { delayMs: null, refreshHistory: false },
    'stale account or selection responses do not schedule follow-up work'); checks++;
  const refreshedOffsets: number[] = [];
  const currentLoader = { current: async () => { refreshedOffsets.push(0); } };
  let acceptReply!: (outcome: CutoutJobReadOutcome) => void;
  const pendingReply = new Promise<CutoutJobReadOutcome>(resolve => { acceptReply = resolve; });
  const pendingRefresh = pendingReply.then(outcome => refreshCutoutHistoryForQuery(plan(outcome, job('running')), currentLoader));
  currentLoader.current = async () => { refreshedOffsets.push(12); };
  acceptReply({ kind: 'updated', job: job('succeeded') });
  await pendingRefresh;
  assert.deepEqual(refreshedOffsets, [12], 'late terminal reply refreshes the current history page, not the old offset'); checks++;
  await refreshCutoutHistoryForQuery(plan({ kind: 'stale' }), currentLoader);
  assert.deepEqual(refreshedOffsets, [12], 'stale outcomes cannot trigger history reads'); checks++;
  console.log(JSON.stringify({ passed: true, checks, scope: 'cutout job query recovery decisions', realImageJobs: 0, fees: 0 }));
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
