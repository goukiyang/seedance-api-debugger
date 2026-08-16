import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.join(process.cwd(), 'scripts/backfill-video-thumbnails.ts'), 'utf8');

assert.match(source, /--tasks-only/, 'backfill script must support task-only thumbnail repair');
assert.match(source, /--assets-only/, 'backfill script must support asset-only thumbnail repair');
assert.match(source, /--max-candidates=/, 'backfill script must support bounded candidate batches');
assert.match(source, /function parseMaxCandidates/, 'backfill script must parse max candidate batches');
assert.match(source, /mode === 'execute' && runAssets/, 'task-only execution must not require database backup');
assert.match(source, /maxCandidates=\$\{maxCandidates \?\? 'all'\} tasks=\$\{runTasks\} assets=\$\{runAssets\}/, 'backfill output must show selected repair scopes and batch cap');
assert.match(source, /backfillTaskThumbnails\(mode, limit, maxCandidates\)/, 'task thumbnail repair path must stay available');
assert.match(source, /backfillAssetThumbnails\(mode, limit, maxCandidates\)/, 'asset thumbnail repair path must stay available');

console.log('[backfill-video-thumbnails-options-smoke] ok');
