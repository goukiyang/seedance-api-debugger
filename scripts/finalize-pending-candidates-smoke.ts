import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  isStaleSubmittedWithoutProvider,
  selectFinalizeCandidates,
  taskFinalizeReason,
  type PendingFinalizeCandidate,
} from '../src/lib/video/finalize-pending-candidates';

function task(
  id: string,
  localStatus: string,
  createdAt: string,
  updatedAt: string,
  completedAt: string | null = null,
): PendingFinalizeCandidate {
  return {
    id,
    local_status: localStatus,
    local_video_path: null,
    result_video_url: localStatus === 'succeeded' ? `https://example.com/${id}.mp4` : null,
    created_at: new Date(createdAt),
    updated_at: new Date(updatedAt),
    completed_at: completedAt ? new Date(completedAt) : null,
  };
}

const candidates = selectFinalizeCandidates([
  task('old-succeeded-missing-local', 'succeeded', '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z', '2026-05-01T01:00:00Z'),
  task('recent-succeeded-missing-local', 'succeeded', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', '2026-07-01T01:00:00Z'),
  task('newer-running', 'running', '2026-07-01T02:00:00Z', '2026-07-01T02:30:00Z'),
  task('older-running', 'running', '2026-06-29T02:00:00Z', '2026-06-29T02:30:00Z'),
  task('submitted', 'submitted', '2026-07-01T03:00:00Z', '2026-07-01T03:30:00Z'),
], 4);

assert.deepEqual(
  candidates.map((candidate) => candidate.id),
  [
    'older-running',
    'newer-running',
    'submitted',
    'recent-succeeded-missing-local',
  ],
);

assert.equal(taskFinalizeReason(candidates[0]), 'needs_provider_status_refresh');
assert.equal(taskFinalizeReason(candidates[3]), 'succeeded_missing_local_video');

const now = new Date('2026-07-01T04:00:00Z');
assert.equal(isStaleSubmittedWithoutProvider({
  ...task('stale-orphan', 'submitted', '2026-07-01T03:00:00Z', '2026-07-01T03:00:00Z'),
  provider_task_id: null,
}, now, 30), true);
assert.equal(isStaleSubmittedWithoutProvider({
  ...task('fresh-orphan', 'submitted', '2026-07-01T03:45:00Z', '2026-07-01T03:45:00Z'),
  provider_task_id: null,
}, now, 30), false);
assert.equal(isStaleSubmittedWithoutProvider({
  ...task('has-provider-id', 'submitted', '2026-07-01T03:00:00Z', '2026-07-01T03:00:00Z'),
  provider_task_id: 'provider-task',
}, now, 30), false);

const finalizeScriptSource = fs.readFileSync(
  path.join(process.cwd(), 'scripts/finalize-pending-videos.ts'),
  'utf8',
);
const prismaSource = fs.readFileSync(
  path.join(process.cwd(), 'src/lib/prisma.ts'),
  'utf8',
);
assert.match(
  finalizeScriptSource,
  /--missing-local-limit/,
  'missing local video backfill must have an independent per-run limit',
);
assert.match(
  finalizeScriptSource,
  /Math\.min\(remainingLimit,\s*missingLocalLimitPerRun\)/,
  'missing local video backfill must not consume the whole finalizer batch',
);
assert.match(
  prismaSource,
  /\$queryRawUnsafe\('PRAGMA busy_timeout = 5000'\)/,
  'SQLite connections must wait briefly instead of failing immediately when another upload or worker holds the database lock',
);
assert.doesNotMatch(
  prismaSource,
  /journal_mode\\s*=\\s*WAL/i,
  'WAL migration must remain a separate planned change, not be silently forced during upload repair',
);

console.log('finalize-pending-candidates smoke passed');
