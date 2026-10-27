import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const runtime = fs.readFileSync(path.join(root, 'scripts/server-ensure-runtime-dirs.sh'), 'utf8');
const preflight = fs.readFileSync(path.join(root, 'ops/server/sd2/preflight.sh'), 'utf8');
const rules = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
for (const marker of ['SD2_SHARED_ROOT', '/data/video-api-debugger/var-lib',
  'uploads/assets', 'uploads/thumbs', 'videos/thumbnails', 'storage/backups', 'storage/media-outlet', '-m 2750']) {
  assert(runtime.includes(marker), marker);
}
assert.match(runtime, /\[\[ -e "\$APP_DIR\/public\/\$name" \|\| -L "\$APP_DIR\/public\/\$name" \]\]/);
assert.doesNotMatch(runtime, /rsync|rm -|cp -|chown -R|chmod 77/);
assert.match(runtime, /runuser -u "\$RUN_USER" -- test -w/);
assert.match(runtime, /ln -s "\$SHARED_ROOT\/storage" "\$APP_DIR\/storage"/);
assert.match(runtime, /test "\$\(stat -c %d \/data\)" != "\$\(stat -c %d \/\)"/);
assert.match(preflight, /managed-releases/);
assert.match(preflight, /test ! -e "\$app\/public\/\$name"/);
assert.match(preflight, /curl_code prod_config "\$PROD_ORIGIN\/api\/config" 401/);
assert.match(preflight, /sd2-image-studio.service sd2-finalize-pending.timer sd2-video-delivery.timer sd2-backup.timer/);
assert.match(rules, /server-ensure-runtime-dirs\.sh/);
assert.match(rules, /nginx.*internal/);
for (const file of ['scripts/server-ensure-runtime-dirs.sh', 'ops/server/sd2/preflight.sh']) {
  assert.equal(spawnSync('bash', ['-n', path.join(root, file)]).status, 0, file);
}
console.log('PASS candidate media roots are private, preparation preserves originals, nginx only reads protected delivery cache');
