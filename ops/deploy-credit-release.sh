#!/usr/bin/env bash
set -euo pipefail
umask 077
commit=${1:?commit required}
expected=${2:?previous commit required}
approver=${3:?approver required}
[[ "$commit" =~ ^[a-f0-9]{40}$ && "$expected" =~ ^[a-f0-9]{40}$ && "$approver" =~ ^[a-z0-9]+$ ]]
app=/srv/video-api-debugger/app
release=/srv/video-api-debugger/releases/$commit
backup=/srv/video-api-debugger/backups/credits-$commit
nginx=/etc/nginx/sites-available/artreview.youdooart.com
test "$(cat "$app/.deployed-commit")" = "$expected"
test -f "$release/ops/feishu-credit-gateway.mjs"
test ! -e "$backup"
test ! -e /etc/systemd/system/sd2-gray.service.d/credits.conf
test ! -e /etc/systemd/system/sd2-credit-gateway.service
test ! -e /etc/systemd/system/sd2-credit-delivery.service
test ! -e /etc/systemd/system/sd2-credit-delivery.timer
systemctl is-active --quiet sd2-gray.service
systemctl is-active --quiet artreview-feishu-relay.service
test "$(sqlite3 -readonly /data/video-api-debugger/var-lib/dev.db "SELECT count(*) FROM User WHERE id='$approver' AND role='admin' AND status='active' AND feishu_open_id IS NOT NULL;")" = 1
mkdir -p "$backup/source"
excludes=(--exclude='.env*' --exclude='.git' --exclude='node_modules' --exclude='.next*' --exclude='storage' --exclude='public/uploads' --exclude='public/videos' --exclude='*.db*' --exclude='*.sqlite*' --exclude='.deployed-commit')
rsync -a "${excludes[@]}" "$app/" "$backup/source/"
cp "$nginx" "$backup/nginx.conf"
sqlite3 /data/video-api-debugger/var-lib/dev.db ".timeout 10000" ".backup '$backup/before.db'"
test "$(sqlite3 -readonly "$backup/before.db" 'PRAGMA quick_check;')" = ok
cat "$app/.next-prod/BUILD_ID" > "$backup/previous-build-id"
switched=0
rollback() {
  trap - ERR
  systemctl disable --now sd2-credit-delivery.timer sd2-credit-gateway.service 2>/dev/null || true
  cp "$backup/nginx.conf" "$nginx"
  nginx -t && systemctl reload nginx
  rm -f /etc/systemd/system/sd2-gray.service.d/credits.conf /etc/systemd/system/sd2-credit-delivery.service.d/credits.conf
  rm -f /etc/systemd/system/sd2-credit-gateway.service /etc/systemd/system/sd2-credit-delivery.service /etc/systemd/system/sd2-credit-delivery.timer
  systemctl daemon-reload
  if [ "$switched" = 1 ]; then
    mv "$app/.next-prod" "$app/.next-failed-$commit"
    mv "$backup/previous-build" "$app/.next-prod"
  fi
  rsync -a --delete "${excludes[@]}" "$backup/source/" "$app/"
  bash "$app/scripts/server-ensure-runtime-dirs.sh" "$app"
  printf '%s\n' "$expected" > "$app/.deployed-commit"
  systemctl restart sd2-gray.service
  echo 'CREDIT_RELEASE_FAILED_ROLLED_BACK; additive tables preserved, balances unchanged by deployment' >&2
  exit 1
}
trap rollback ERR
rsync -a --delete "${excludes[@]}" "$release/" "$app/"
bash "$app/scripts/server-ensure-runtime-dirs.sh" "$app"
chown -R gouki:gouki "$app/prisma"
chown gouki:gouki "$app"
chown gouki:gouki "$app/tsconfig.json" "$app/next-env.d.ts"
cd "$app"
runuser -u gouki -- ./node_modules/.bin/prisma generate
runuser -u gouki -- env NEXT_DIST_DIR=.next-prod-candidate-credit npm run build
test -s .next-prod-candidate-credit/BUILD_ID
test -f .next-prod-candidate-credit/server/app/api/me/credit-requests/route.js
test -f .next-prod-candidate-credit/server/app/api/release/route.js
test "$(sqlite3 -readonly /data/video-api-debugger/var-lib/dev.db "SELECT count(*) FROM sqlite_master WHERE name IN ('CreditRequest','CreditRequestDelivery');")" = 0
{ printf '.bail on\n.timeout 10000\nPRAGMA foreign_keys=ON;\nBEGIN IMMEDIATE;\n'; cat prisma/migrations/20260915120000_credit_requests/migration.sql; printf '\nCOMMIT;\n'; } | sqlite3 /data/video-api-debugger/var-lib/dev.db
install -m 644 ops/sd2-credit-gateway.service /etc/systemd/system/
install -m 644 ops/sd2-credit-delivery.service /etc/systemd/system/
install -m 644 ops/sd2-credit-delivery.timer /etc/systemd/system/
mkdir -p /etc/systemd/system/sd2-gray.service.d /etc/systemd/system/sd2-credit-delivery.service.d
printf '[Service]\nEnvironment=CREDIT_REQUESTS_ENABLED=true\nEnvironment=CREDIT_CALLBACK_MODE=relay-v1\nEnvironment=CREDIT_REQUEST_APPROVER_ID=%s\n' "$approver" > /etc/systemd/system/sd2-gray.service.d/credits.conf
cp /etc/systemd/system/sd2-gray.service.d/credits.conf /etc/systemd/system/sd2-credit-delivery.service.d/credits.conf
systemctl daemon-reload
systemctl start sd2-credit-gateway.service
curl --retry 5 --retry-connrefused --retry-delay 1 -fsS http://127.0.0.1:8790/health
systemctl is-active --quiet sd2-credit-gateway.service
test "$(cat "$app/.deployed-commit")" = "$expected"
test "$(cat .next-prod/BUILD_ID)" = "$(cat "$backup/previous-build-id")"
cmp "$nginx" "$backup/nginx.conf"
mv .next-prod "$backup/previous-build"
mv .next-prod-candidate-credit .next-prod
switched=1
systemctl restart sd2-gray.service
curl --retry 8 --retry-connrefused --retry-delay 1 -fsS http://127.0.0.1:3302/api/release
systemd-run --quiet --wait --pipe --collect --property=User=gouki --property=EnvironmentFile=/home/gouki/10-sites/artreview-pro/shared/env/artreview-pro.env /usr/bin/node "$app/ops/credit-release-probe.mjs" --approver "$approver"
NGINX_TARGET="$nginx" node --input-type=module -e '
import fs from "node:fs";
const path=process.env.NGINX_TARGET, text=fs.readFileSync(path,"utf8");
const pattern=/(location = \/webhooks\/feishu\/card-actions\s*\{\s*proxy_pass http:\/\/127\.0\.0\.1:)8788/;
if(!pattern.test(text)) throw Error("unexpected nginx configuration");
fs.writeFileSync(path,text.replace(pattern,(_match,prefix)=>`${prefix}8790`));'
nginx -t
systemctl reload nginx
systemd-run --quiet --wait --pipe --collect --property=User=gouki --property=EnvironmentFile=/home/gouki/10-sites/artreview-pro/shared/env/artreview-pro.env /usr/bin/node "$app/ops/credit-release-probe.mjs" --approver "$approver" --public
systemctl enable --now sd2-credit-gateway.service sd2-credit-delivery.timer
printf '%s\n' "$commit" > .deployed-commit
systemctl is-active sd2-gray.service sd2-credit-gateway.service sd2-credit-delivery.timer artreview-feishu-relay.service
echo "CREDIT_RELEASE_SWITCHED $commit rollback=$backup"
