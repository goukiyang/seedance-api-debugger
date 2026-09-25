#!/usr/bin/env bash
set -Eeuo pipefail

# Old builds do not enforce personal-canvas ownership or revision fencing.
# Close their affected routes before restoring code; never restore the live database.
app=/srv/video-api-debugger/app
previous=${1:?Usage: rollback-personal-canvas.sh previous-build-directory previous-commit}
commit=${2:?Missing previous commit}
[[ "$previous" == "$app"/.next-prod-before-* ]]
[[ "$commit" =~ ^[a-f0-9]{40}$ ]]
test -s "$previous/BUILD_ID"
source_dir="/srv/video-api-debugger/releases/$commit"
test -s "$source_dir/package.json"
systemctl stop sd2-gray.service
node <<'NODE'
const fs = require('fs');
const path = fs.realpathSync('/etc/nginx/sites-enabled/sd2.youdooart.com');
const text = fs.readFileSync(path, 'utf8');
const marker = '# personal-canvas-safe-rollback';
if (!text.includes(marker)) {
  const anchor = '  location / {\n    proxy_pass http://127.0.0.1:3302;';
  if (text.split(anchor).length !== 2) throw new Error('Unexpected nginx config; service remains stopped');
  const routes = [
    '^~ /api/tools/ultimate-canvas/', '^~ /tools/ultimate-canvas',
    '= /api/assets/generate', '= /api/tasks/create', '= /api/ip/tasks/create',
  ];
  const block = `  ${marker}\n` + routes.map(route =>
    `  location ${route} { default_type application/json; add_header Retry-After 600 always; return 503 '{"error":"canvas_maintenance","message":"画布正在维护，请稍后重试"}'; }\n`
  ).join('');
  fs.copyFileSync(path, `${path}.before-personal-canvas-rollback-${Date.now()}`);
  fs.writeFileSync(`${path}.candidate`, text.replace(anchor, block + '\n' + anchor));
  fs.renameSync(`${path}.candidate`, path);
}
NODE
nginx -t
systemctl reload nginx
if test -d "$app/.next-prod"; then mv "$app/.next-prod" "$app/.next-prod-held-$(date +%s)"; fi
mv "$previous" "$app/.next-prod"
rsync -a --delete --chown=gouki:gouki --exclude='.env*' --exclude=node_modules --exclude='.next*' \
  --exclude=storage --exclude=public/uploads --exclude=public/videos --exclude='*.db*' --exclude='*.sqlite*' \
  --exclude=.git --exclude='.deployed-*' --exclude=tmp --exclude=logs --exclude=.superpowers "$source_dir/" "$app/"
DEPLOYED_COMMIT="$commit" node <<'NODE'
const fs = require('fs');
const app = '/srv/video-api-debugger/app';
fs.writeFileSync(`${app}/.deployed-commit`, process.env.DEPLOYED_COMMIT + '\n');
fs.writeFileSync(`${app}/.deployed-version`, JSON.parse(fs.readFileSync(`${app}/package.json`)).version + '\n');
NODE
systemctl start sd2-gray.service
systemctl is-active sd2-gray.service
printf '%s\n' 'Code restored with canvas and generation submissions blocked. Database retained. Keep the nginx guard until an owner-safe build is deployed.'
