#!/bin/zsh
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export NEXT_TELEMETRY_DISABLED=1
export NEXT_PUBLIC_BASE_URL="${NEXT_PUBLIC_BASE_URL:-https://sd2.youdoodesign.com}"

project_dir="/Volumes/Data/Projects/video-api-debugger-v12-full-todo"
lock_dir="/tmp/youdoo-sd2-finalize-pending-videos.lock"
lock_pid_file="${lock_dir}/pid"

if ! mkdir "${lock_dir}" 2>/dev/null; then
  if [[ -f "${lock_pid_file}" ]]; then
    lock_pid="$(cat "${lock_pid_file}" 2>/dev/null || true)"
    if [[ -n "${lock_pid}" ]] && kill -0 "${lock_pid}" 2>/dev/null; then
      echo "$(date '+%Y-%m-%dT%H:%M:%S%z') sd2-finalize: previous run still active; skip"
      exit 0
    fi
  fi

  echo "$(date '+%Y-%m-%dT%H:%M:%S%z') sd2-finalize: removing stale lock"
  rm -rf "${lock_dir}"
  mkdir "${lock_dir}"
fi
echo "$$" > "${lock_pid_file}"
trap 'rm -rf "${lock_dir}" 2>/dev/null || true' EXIT INT TERM

cd "${project_dir}"

if [[ ! -x ./node_modules/.bin/tsx ]]; then
  echo "$(date '+%Y-%m-%dT%H:%M:%S%z') sd2-finalize: missing tsx; skip"
  exit 0
fi

npm run video:finalize-pending -- --limit 10 --max-seconds 1800 --cache-timeout-seconds 900 --missing-local-max-age-days 2
