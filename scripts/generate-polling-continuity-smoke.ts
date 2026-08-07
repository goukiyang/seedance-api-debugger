import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function assertPollingContinuity(source: string, label: string) {
  assert.match(
    source,
    /const POLLABLE_TASK_STATUSES = new Set\(\['submitted', 'running'\]\)/,
    `${label} must define the statuses that should keep polling`,
  );
  assert.match(
    source,
    /function collectPollableTaskIds/,
    `${label} must collect still-running tasks from recently loaded task lists`,
  );
  assert.match(
    source,
    /setActivePollingTaskIds\(\(current\) => mergePollingTaskIds\(pollableTaskIds, current\)\)/,
    `${label} must restore polling when recent task lists contain unfinished tasks`,
  );
  assert.match(
    source,
    /\/api\/video\/status\/\$\{taskId\}\?refresh=true/,
    `${label} must ask the backend to refresh provider status while polling`,
  );
  assert.doesNotMatch(
    source,
    /MAX_POLLS/,
    `${label} must not stop polling because of a fixed poll count`,
  );
}

assertPollingContinuity(
  readSource('src/components/generate/GeneratePageClient.tsx'),
  'GeneratePageClient',
);

assertPollingContinuity(
  readSource('src/components/templates/TemplateGenerateClient.tsx'),
  'TemplateGenerateClient',
);

console.log('generate polling continuity smoke passed');
