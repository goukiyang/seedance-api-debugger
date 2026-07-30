import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(
  path.join(process.cwd(), 'src/lib/video/task-finalizer.ts'),
  'utf8',
);

assert.match(
  source,
  /async function persistProviderStatusError/,
  'provider status error persistence must be centralized so it can inspect the latest task state',
);
assert.match(
  source,
  /const latestTask = await prisma\.videoTask\.findUnique/,
  'provider error persistence must reload the latest task before writing fallback status',
);
assert.match(
  source,
  /if \(isTerminalLocalStatus\(latestTask\.local_status\)\)/,
  'provider error persistence must preserve terminal task state',
);
assert.match(
  source,
  /try \{\s*await recordOfficialProviderCharge/,
  'official provider charge recording must not be allowed to demote a finalized task',
);
assert.doesNotMatch(
  source,
  /const fallbackStatus = isTerminalLocalStatus\(task\.local_status\) \? task\.local_status : 'running';/,
  'finalizer must not decide fallback status from the stale task snapshot',
);

console.log('task-finalizer-terminal-guard smoke passed');
