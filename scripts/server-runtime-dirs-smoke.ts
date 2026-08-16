import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const runtimeScript = fs.readFileSync(path.join(root, 'scripts/server-ensure-runtime-dirs.sh'), 'utf8');
const agentRules = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');

for (const marker of [
  'public/uploads',
  'public/uploads/assets',
  'public/uploads/thumbs',
  'public/videos',
  'public/videos/thumbnails',
  'storage/backups',
]) {
  assert.match(runtimeScript, new RegExp(marker.replaceAll('/', '\\/')), `runtime dir script must include ${marker}`);
}

assert.match(runtimeScript, /sudo -u "\$RUN_USER" test -w "\$dir"/, 'runtime dir script must verify app user write permission');
assert.match(runtimeScript, /\[\[ -L "\$APP_DIR\/storage" && ! -e "\$APP_DIR\/storage" \]\]/, 'runtime dir script must handle broken storage symlink from old deploys');
assert.match(agentRules, /public\/videos/, 'deployment rules must preserve public/videos as runtime output');
assert.match(agentRules, /server-ensure-runtime-dirs\.sh/, 'deployment rules must run runtime dir guard after rsync');

console.log('[server-runtime-dirs-smoke] ok');
