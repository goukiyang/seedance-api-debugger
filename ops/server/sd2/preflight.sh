#!/usr/bin/env bash
set -euo pipefail

GRAY_ORIGIN="${GRAY_ORIGIN:-https://sd2-server.youdoodesign.com}"
PROD_ORIGIN="${PROD_ORIGIN:-https://sd2.youdooart.com}"
TOOLS_ORIGIN="${TOOLS_ORIGIN:-https://tools.youdoodesign.com}"
SERVER="${SERVER:-root@42.193.221.253}"

curl_code() {
  local label="$1"
  local url="$2"
  local code
  code="$(curl -sS -o /tmp/sd2-preflight.body -w '%{http_code}' "$url")"
  printf '%s=%s %s\n' "$label" "$code" "$url"
  test "$code" = "200"
}

curl_code gray_config "$GRAY_ORIGIN/api/config"
curl_code gray_health "$GRAY_ORIGIN/api/health"
curl_code gray_login "$GRAY_ORIGIN/login"
curl_code gray_register "$GRAY_ORIGIN/register"
curl_code prod_config "$PROD_ORIGIN/api/config"
curl_code tools_home "$TOOLS_ORIGIN/"

if [ "${EXPECT_PROD_ON_SERVER:-0}" = "1" ]; then
  prod_header="$(curl -sS -o /tmp/sd2-preflight-prod.body -D - "$PROD_ORIGIN/api/health" | tr -d '\r')"
  printf '%s\n' "$prod_header" | grep -qi '^x-sd2-origin: server-42-193$'
  printf 'prod_origin_header=server-42-193 %s/api/health\n' "$PROD_ORIGIN"
fi

ssh "$SERVER" 'set -euo pipefail
systemctl is-active sd2-gray.service
systemctl is-active cloudflared-seedance2-server.service
systemctl is-enabled sd2-finalize-pending.timer sd2-video-delivery.timer 2>/dev/null || true
ss -ltnp | grep ":3302"
test -L /var/lib/video-api-debugger
test "$(readlink -f /var/lib/video-api-debugger)" = /data/video-api-debugger/var-lib
test -L /srv/video-api-debugger/app/public/uploads
test "$(readlink -f /srv/video-api-debugger/app/public/uploads)" = /data/video-api-debugger/var-lib/uploads
test -L /srv/video-api-debugger/app/public/videos
test "$(readlink -f /srv/video-api-debugger/app/public/videos)" = /data/video-api-debugger/var-lib/videos
test -L /srv/video-api-debugger/app/storage
test "$(readlink -f /srv/video-api-debugger/app/storage)" = /data/video-api-debugger/var-lib/storage
test -d /data/video-api-debugger/var-lib/uploads/assets
test -d /data/video-api-debugger/var-lib/uploads/thumbs
test -d /data/video-api-debugger/var-lib/videos/thumbnails
test -d /data/video-api-debugger/var-lib/storage/backups
runuser -u gouki -- test -w /srv/video-api-debugger/app
runuser -u gouki -- test -w /data/video-api-debugger/var-lib/uploads/assets
runuser -u gouki -- test -w /data/video-api-debugger/var-lib/videos/thumbnails
runuser -u gouki -- test -w /data/video-api-debugger/var-lib/storage/backups
sqlite3 /var/lib/video-api-debugger/dev.db "pragma integrity_check; select count(*) from VideoTask; select count(*) from Asset; select count(*) from User;"
find /var/lib/video-api-debugger/uploads -type f | wc -l
find /var/lib/video-api-debugger/videos -name "*.mp4" -type f | wc -l
find /var/lib/video-api-debugger/videos/thumbnails -type f | wc -l
df -h / | tail -n 1
'
