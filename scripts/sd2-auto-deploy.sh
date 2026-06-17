#!/bin/zsh
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export NEXT_TELEMETRY_DISABLED=1

repo_dir="${SD2_AUTO_DEPLOY_REPO:-/Volumes/Data/Projects/video-api-debugger-v12-full-todo}"
remote="${SD2_AUTO_DEPLOY_REMOTE:-origin}"
branch="${SD2_AUTO_DEPLOY_BRANCH:-codex/v12-full-todo}"
site_id="${SD2_AUTO_DEPLOY_SITE_ID:-sd2}"
sites_bin="${SD2_AUTO_DEPLOY_SITES_BIN:-/Users/gouki-youdoo/.youdoo/bin/youdoo-sites}"
state_dir="${SD2_AUTO_DEPLOY_STATE_DIR:-/Users/gouki-youdoo/.youdoo/runtime/sd2-auto-deploy-state}"
lock_dir="${SD2_AUTO_DEPLOY_LOCK_DIR:-/tmp/sd2-auto-deploy.lock}"
public_base="${SD2_AUTO_DEPLOY_PUBLIC_BASE:-https://sd2.youdoodesign.com}"
local_config_url="${SD2_AUTO_DEPLOY_LOCAL_CONFIG_URL:-http://127.0.0.1:3000/api/config}"
health_wait_seconds="${SD2_AUTO_DEPLOY_HEALTH_WAIT_SECONDS:-75}"

log() {
  printf '%s sd2-auto-deploy: %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"
}

cleanup() {
  local exit_code="$?"
  if [[ -d "${lock_dir}" ]]; then
    rmdir "${lock_dir}" 2>/dev/null || true
  fi
  if [[ "${exit_code}" != "0" ]]; then
    log "failed exit_code=${exit_code}"
  fi
}
trap cleanup EXIT

if ! mkdir "${lock_dir}" 2>/dev/null; then
  log "skip: another deploy run is active"
  exit 0
fi

mkdir -p "${state_dir}"

cd "${repo_dir}"

current_branch="$(git rev-parse --abbrev-ref HEAD)"
if [[ "${current_branch}" != "${branch}" ]]; then
  log "skip: current branch ${current_branch} is not ${branch}"
  exit 0
fi

if [[ -n "$(git status --porcelain)" ]]; then
  log "skip: working tree is dirty; auto deploy requires a clean checkout"
  git status --short
  exit 0
fi

git fetch --quiet "${remote}" "${branch}"

local_commit="$(git rev-parse HEAD)"
remote_commit="$(git rev-parse "${remote}/${branch}")"

if [[ "${local_commit}" == "${remote_commit}" ]]; then
  log "noop: ${branch} already at ${local_commit}"
  printf '%s\n' "${local_commit}" > "${state_dir}/last-seen-commit.txt"
  exit 0
fi

if ! git merge-base --is-ancestor "${local_commit}" "${remote_commit}"; then
  log "skip: remote ${remote}/${branch} is not a fast-forward from local ${local_commit}"
  exit 0
fi

previous_build_id="$(tr -d '\n' < .next-prod/BUILD_ID 2>/dev/null || true)"
log "deploy start: ${local_commit} -> ${remote_commit}; previous_build=${previous_build_id:-none}"

git merge --ff-only "${remote}/${branch}"

if [[ "${SD2_AUTO_DEPLOY_DRY_RUN:-0}" == "1" ]]; then
  log "dry-run: merged to $(git rev-parse HEAD), deploy commands skipped"
  exit 0
fi

if [[ -x ./node_modules/.bin/tsc ]]; then
  ./node_modules/.bin/tsc --noEmit --pretty false
else
  log "skip typecheck: ./node_modules/.bin/tsc not found"
fi

"${sites_bin}" build "${site_id}"
new_build_id="$(tr -d '\n' < .next-prod/BUILD_ID)"
"${sites_bin}" restart "${site_id}"
"${sites_bin}" status "${site_id}"

curl -fsS "${local_config_url}" >/dev/null
curl -fsS "${public_base}/api/config" >/dev/null
curl -fsS "${public_base}/login" >/dev/null
curl -fsS "${public_base}/_next/static/${new_build_id}/_buildManifest.js" >/dev/null

sleep "${health_wait_seconds}"
"${sites_bin}" status "${site_id}"

printf '%s\n' "${remote_commit}" > "${state_dir}/last-deployed-commit.txt"
printf '%s\n' "${new_build_id}" > "${state_dir}/last-build-id.txt"
log "deploy ok: commit=${remote_commit}; build=${new_build_id}"
