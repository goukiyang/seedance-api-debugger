import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const runtimeScript = fs.readFileSync(path.join(root, 'scripts/server-ensure-runtime-dirs.sh'), 'utf8');
const agentRules = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');

for (const marker of [
  'SD2_SHARED_ROOT',
  '/var/lib/video-api-debugger',
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
assert.match(runtimeScript, /\[\[ -L "\$app_path" && ! -e "\$app_path" \]\]/, 'runtime dir script must handle broken runtime symlinks from old deploys');
assert.match(runtimeScript, /migrate_runtime_path_to_shared "\$APP_DIR\/public\/uploads" "\$SHARED_ROOT\/uploads"/, 'runtime dir script must link public/uploads to shared storage');
assert.match(runtimeScript, /migrate_runtime_path_to_shared "\$APP_DIR\/public\/videos" "\$SHARED_ROOT\/videos"/, 'runtime dir script must link public/videos to shared storage');
assert.match(runtimeScript, /migrate_runtime_path_to_shared "\$APP_DIR\/storage" "\$SHARED_ROOT\/storage"/, 'runtime dir script must link storage to shared storage');
assert.match(runtimeScript, /chown "\$RUN_USER:\$RUN_GROUP" "\$APP_DIR" "\$APP_DIR\/public"/, 'runtime dir script must keep app root writable for candidate builds');
assert.match(runtimeScript, /for dir in \\\n  "\$APP_DIR"/, 'runtime dir script must verify app root write permission');
assert.match(runtimeScript, /runtime path is not linked to shared storage/, 'runtime dir script must fail when symlink protection is missing');
assert.match(agentRules, /public\/videos/, 'deployment rules must preserve public/videos as runtime output');
assert.match(agentRules, /\/var\/lib\/video-api-debugger/, 'deployment rules must mention persistent runtime storage');
assert.match(agentRules, /server-ensure-runtime-dirs\.sh/, 'deployment rules must run runtime dir guard after rsync');

console.log('[server-runtime-dirs-smoke] ok');
