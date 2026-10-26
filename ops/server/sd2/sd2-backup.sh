#!/usr/bin/env bash
set -euo pipefail

DB_PATH="${DB_PATH:-/var/lib/video-api-debugger/dev.db}"
BACKUP_ROOT="${BACKUP_ROOT:-/var/lib/video-api-debugger/backups/daily}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"

stamp="$(date '+%Y%m%d-%H%M%S')"
mkdir -p "${BACKUP_ROOT}"

tmp_db="${BACKUP_ROOT}/dev.db.${stamp}.sqlite3.tmp"
out_db="${BACKUP_ROOT}/dev.db.${stamp}.sqlite3.gz"
manifest="${BACKUP_ROOT}/dev.db.${stamp}.manifest.txt"

cleanup() {
  rm -f "${tmp_db}"
}
trap cleanup EXIT

sqlite3 "${DB_PATH}" ".backup '${tmp_db}'"

integrity="$(sqlite3 "${tmp_db}" 'pragma integrity_check;')"
if [[ "${integrity}" != "ok" ]]; then
  echo "[sd2-backup] integrity_check failed: ${integrity}" >&2
  exit 1
fi

video_tasks="$(sqlite3 "${tmp_db}" 'select count(*) from VideoTask;')"
assets="$(sqlite3 "${tmp_db}" 'select count(*) from Asset;')"
users="$(sqlite3 "${tmp_db}" 'select count(*) from User;')"
missing_local="$(sqlite3 "${tmp_db}" "select count(*) from VideoTask where local_status='succeeded' and (local_video_path is null or local_video_path='');")"

gzip -c "${tmp_db}" > "${out_db}"
sha256sum "${out_db}" > "${out_db}.sha256"

cat > "${manifest}" <<EOF
created_at=$(date '+%Y-%m-%dT%H:%M:%S%z')
db_path=${DB_PATH}
backup=${out_db}
sha256_file=${out_db}.sha256
integrity_check=${integrity}
VideoTask=${video_tasks}
Asset=${assets}
User=${users}
succeeded_missing_local=${missing_local}
retention_days=${RETENTION_DAYS}
EOF

chmod 640 "${out_db}" "${out_db}.sha256" "${manifest}"

find "${BACKUP_ROOT}" -type f \( \
  -name 'dev.db.*.sqlite3.gz' -o \
  -name 'dev.db.*.sqlite3.gz.sha256' -o \
  -name 'dev.db.*.manifest.txt' \
\) -mtime "+${RETENTION_DAYS}" -delete

echo "[sd2-backup] ok backup=${out_db} VideoTask=${video_tasks} Asset=${assets} User=${users} succeeded_missing_local=${missing_local}"
