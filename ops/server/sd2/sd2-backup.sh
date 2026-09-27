#!/usr/bin/env bash
set -euo pipefail
umask 077

DB_PATH="${DB_PATH:-/var/lib/video-api-debugger/dev.db}"
BACKUP_ROOT="${BACKUP_ROOT:-/var/lib/video-api-debugger/backups/daily}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
APP_DIR="${APP_DIR:-/srv/video-api-debugger/app}"
ANIMATION_STORAGE_ROOT="${ANIMATION_STORAGE_ROOT:-${APP_DIR}/storage/animation}"

if [[ ! "${RETENTION_DAYS}" =~ ^[0-9]+$ ]]; then
  echo "[sd2-backup] RETENTION_DAYS must be a non-negative integer" >&2
  exit 1
fi

mkdir -p "${BACKUP_ROOT}"

if ! command -v flock >/dev/null 2>&1; then
  echo "[sd2-backup] flock is required for non-overlapping backups" >&2
  exit 1
fi
lock_file="${BACKUP_ROOT}/.sd2-backup.lock"
if [[ -L "${lock_file}" ]]; then
  echo "[sd2-backup] backup lock path must not be a symlink" >&2
  exit 1
fi
exec 9>>"${lock_file}"
if ! flock -n 9; then
  echo "[sd2-backup] another backup is already running; refusing duplicate run" >&2
  exit 1
fi

collision=1
for ((attempt = 0; attempt < 60; attempt++)); do
  stamp="$(date '+%Y%m%d-%H%M%S')"
  tmp_db="${BACKUP_ROOT}/dev.db.${stamp}.sqlite3.tmp"
  out_db="${BACKUP_ROOT}/dev.db.${stamp}.sqlite3.gz"
  out_animation="${BACKUP_ROOT}/dev.db.${stamp}.animation.tar.gz"
  manifest="${BACKUP_ROOT}/dev.db.${stamp}.manifest.txt"
  collision=0
  for candidate in "${tmp_db}" "${out_db}" "${out_db}.sha256" "${out_animation}" "${manifest}"; do
    if [[ -e "${candidate}" || -L "${candidate}" ]]; then
      collision=1
      break
    fi
  done
  if [[ "${collision}" == "0" ]]; then
    break
  fi
  sleep 1
done
if [[ "${collision}" != "0" ]]; then
  echo "[sd2-backup] could not allocate a unique backup timestamp" >&2
  exit 1
fi

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

animation_backup="none"
animation_snapshot_sha256="none"
animation_tables="$(sqlite3 "${tmp_db}" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('AnimationFile', 'AnimationExport');")"
if [[ "${animation_tables}" == "1" ]]; then
  echo "[sd2-backup] incomplete animation schema; database copy retained=${out_db}" >&2
  exit 1
elif [[ "${animation_tables}" == "2" ]]; then
  animation_rows="$(sqlite3 "${tmp_db}" 'SELECT (SELECT COUNT(*) FROM AnimationFile) + (SELECT COUNT(*) FROM AnimationExport);')"
  if [[ "${animation_rows}" -gt 0 ]]; then
    helper="${APP_DIR}/scripts/animation-backup.py"
    if ! animation_result="$(python3 "${helper}" --create \
      --snapshot "${tmp_db}" \
      --animation-root "${ANIMATION_STORAGE_ROOT}" \
      --output "${out_animation}")"; then
      echo "[sd2-backup] animation archive failed; database copy retained=${out_db}; retention cleanup skipped" >&2
      exit 1
    fi
    printf '%s\n' "${animation_result}"
    animation_snapshot_sha256="${animation_result##*database_sha256=}"
    if [[ ! "${animation_snapshot_sha256}" =~ ^[a-f0-9]{64}$ ]]; then
      echo "[sd2-backup] animation archive did not return a bound database hash; database copy retained=${out_db}" >&2
      exit 1
    fi
    if ! compressed_snapshot_digest="$(gzip -cd "${out_db}" | sha256sum)"; then
      echo "[sd2-backup] database backup could not be checked against the animation archive; database copy retained=${out_db}" >&2
      exit 1
    fi
    compressed_snapshot_sha256="${compressed_snapshot_digest%% *}"
    if [[ "${compressed_snapshot_sha256}" != "${animation_snapshot_sha256}" ]]; then
      echo "[sd2-backup] animation archive and database backup snapshots differ; database copy retained=${out_db}; retention cleanup skipped" >&2
      exit 1
    fi
    animation_backup="${out_animation}"
  else
    echo "[sd2-backup] animation backup skipped: no referenced resources in snapshot"
  fi
else
  echo "[sd2-backup] animation backup skipped: legacy schema has no animation tables"
fi

cat > "${manifest}" <<EOF
created_at=$(date '+%Y-%m-%dT%H:%M:%S%z')
db_path=${DB_PATH}
backup=${out_db}
sha256_file=${out_db}.sha256
animation_backup=${animation_backup}
animation_snapshot_sha256=${animation_snapshot_sha256}
integrity_check=${integrity}
VideoTask=${video_tasks}
Asset=${assets}
User=${users}
succeeded_missing_local=${missing_local}
retention_days=${RETENTION_DAYS}
EOF

chmod 640 "${out_db}" "${out_db}.sha256" "${manifest}"

while IFS= read -r -d '' old_manifest; do
  old_name="${old_manifest##*/}"
  if [[ ! "${old_name}" =~ ^dev\.db\.([0-9]{8}-[0-9]{6})\.manifest\.txt$ ]]; then
    continue
  fi
  old_stamp="${BASH_REMATCH[1]}"
  old_db="${BACKUP_ROOT}/dev.db.${old_stamp}.sqlite3.gz"
  old_sha="${old_db}.sha256"
  old_animation="${BACKUP_ROOT}/dev.db.${old_stamp}.animation.tar.gz"
  if [[ -L "${old_manifest}" ]]; then
    continue
  fi
  recorded_db=""
  recorded_sha=""
  recorded_animation=""
  while IFS='=' read -r key value; do
    case "${key}" in
      backup) recorded_db="${value}" ;;
      sha256_file) recorded_sha="${value}" ;;
      animation_backup) recorded_animation="${value}" ;;
    esac
  done < "${old_manifest}"
  if [[ "${recorded_db}" != "${old_db}" || "${recorded_sha}" != "${old_sha}" ]]; then
    continue
  fi
  if [[ ! -s "${old_db}" || -L "${old_db}" || ! -s "${old_sha}" || -L "${old_sha}" ]]; then
    continue
  fi
  if [[ "${recorded_animation}" == "${old_animation}" ]]; then
    if [[ ! -s "${old_animation}" || -L "${old_animation}" ]]; then
      continue
    fi
    rm -- "${old_animation}"
  elif [[ -n "${recorded_animation}" && "${recorded_animation}" != "none" ]]; then
    continue
  fi
  rm -- "${old_db}" "${old_sha}" "${old_manifest}"
done < <(find "${BACKUP_ROOT}" -type f -name 'dev.db.*.manifest.txt' -mtime "+${RETENTION_DAYS}" -print0)

echo "[sd2-backup] ok backup=${out_db} animation_backup=${animation_backup} animation_snapshot_sha256=${animation_snapshot_sha256} VideoTask=${video_tasks} Asset=${assets} User=${users} succeeded_missing_local=${missing_local}"
