#!/usr/bin/env bash
set -euo pipefail

PROD_ORIGIN="${PROD_ORIGIN:-https://sd2.youdoodesign.com}"
GRAY_ORIGIN="${GRAY_ORIGIN:-https://sd2-server.youdoodesign.com}"
TOOLS_ORIGIN="${TOOLS_ORIGIN:-https://tools.youdoodesign.com}"
SERVER="${SERVER:-root@42.193.221.253}"

curl_headers="$(curl -sS -o /tmp/sd2-observe-health.body -D - "${PROD_ORIGIN}/api/health" | tr -d '\r')"
printf '%s\n' "${curl_headers}" | awk 'BEGIN{IGNORECASE=1}/^HTTP\//{print}/^content-type:/{print}/^x-sd2-origin:/{print}'
printf '%s\n' "${curl_headers}" | grep -qi '^x-sd2-origin: server-42-193$'

for url in \
  "${PROD_ORIGIN}/login" \
  "${PROD_ORIGIN}/register" \
  "${GRAY_ORIGIN}/api/health" \
  "${TOOLS_ORIGIN}/"; do
  code="$(curl -sS -o /tmp/sd2-observe.body -w '%{http_code}' "${url}")"
  printf 'http=%s %s\n' "${code}" "${url}"
done

ssh "${SERVER}" 'set -euo pipefail
echo "--- services ---"
systemctl is-active sd2-gray.service cloudflared-seedance2-server.service nginx
systemctl is-enabled sd2-finalize-pending.timer sd2-video-delivery.timer sd2-backup.timer
systemctl list-timers "sd2-*" --all --no-pager

echo "--- db ---"
sqlite3 /var/lib/video-api-debugger/dev.db "
pragma integrity_check;
select '"'"'VideoTask'"'"', count(*) from VideoTask;
select '"'"'Asset'"'"', count(*) from Asset;
select '"'"'User'"'"', count(*) from User;
select '"'"'succeeded_missing_local'"'"', count(*) from VideoTask where local_status='"'"'succeeded'"'"' and (local_video_path is null or local_video_path='"'"''"'"');
select '"'"'delivery_queued'"'"', count(*) from VideoTask where delivery_status='"'"'queued'"'"';
select '"'"'failed'"'"', count(*) from VideoTask where local_status='"'"'failed'"'"';
"

echo "--- media ---"
printf "uploads_files="; find /var/lib/video-api-debugger/uploads -type f | wc -l
printf "mp4_files="; find /var/lib/video-api-debugger/videos -type f -name "*.mp4" | wc -l
printf "upload_thumb_files="; find /var/lib/video-api-debugger/uploads/thumbs -type f 2>/dev/null | wc -l
printf "video_thumb_files="; find /var/lib/video-api-debugger/videos/thumbnails -type f 2>/dev/null | wc -l

echo "--- disk ---"
df -h / /var/lib/video-api-debugger | tail -n +2
du -sh /var/lib/video-api-debugger/backups /var/lib/video-api-debugger/backups/daily 2>/dev/null || true

echo "--- recent backup ---"
ls -lt /var/lib/video-api-debugger/backups/daily 2>/dev/null | head -n 8 || true
'
