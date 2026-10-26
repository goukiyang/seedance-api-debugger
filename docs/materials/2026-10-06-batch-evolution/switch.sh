#!/usr/bin/env bash
set -euo pipefail
commit="$1"; base="$2"; old_build="$3"; uploaded="$4"
app=/srv/video-api-debugger/app
release="/srv/video-api-debugger/releases/$commit"
baseline="/srv/video-api-debugger/releases/$base-batch-evolution-rollback-source"
short="${commit:0:12}"
stage="$app/.next-prod-candidate-batch-$short"
previous="$app/.next-prod-prev-batch-$short"
drain="$app/storage/image-studio-drain"
exec 9>/srv/video-api-debugger/deploy.lock
flock -n 9 || exit 75
test "$(cat "$app/.deployed-commit")" = "$base"
test "$(cat "$app/.next-prod/BUILD_ID")" = "$old_build"
node "$uploaded/source-proof.mjs" "$baseline" "$app"
node "$uploaded/artifact-proof.mjs" "$release" .next-prod-candidate "$commit" > "$uploaded/candidate.json"
test ! -e "$previous"
test ! -e "$stage"
test ! -e "$drain"
for link in storage public/uploads public/videos; do test -L "$app/$link"; done
mkdir "$stage"
rsync -a "$release/.next-prod-candidate/" "$stage/"
chown -R gouki:gouki "$stage"
new_build=$(cat "$stage/BUILD_ID")
excludes=(--exclude='.env*' --exclude='.git' --exclude=node_modules --exclude='.next*' --exclude=storage --exclude=public --exclude='*.db*' --exclude='*.sqlite*' --exclude='.deployed-*' --exclude='*.log' --include='/src/***' --include='/scripts/***' --include='/prisma/***' --include='/package.json' --include='/package-lock.json' --include='/next.config.js' --include='/tsconfig.json' --include='/next-env.d.ts' --include='/.eslintrc.json' --exclude='*')
source_started=0; switched=0; worker_stopped=0; own_drain=0
rollback() {
  code=$?; trap - ERR INT TERM
  printf 'ROLLBACK_START\n'
  if (( source_started )); then
    systemctl stop sd2-gray.service || true
    systemctl stop sd2-image-studio.service || true
    rsync -a --delete --chown=gouki:gouki "${excludes[@]}" "$baseline/" "$app/"
    if (( switched )); then
      if test -e "$app/.next-prod"; then mv "$app/.next-prod" "$app/.next-prod-failed-batch-$short-$(date +%s)"; fi
      mv "$previous" "$app/.next-prod"
    fi
    printf '%s\n' "$base" > "$app/.deployed-commit"
    chown gouki:gouki "$app/.deployed-commit"
    systemctl start sd2-gray.service
  fi
  if (( own_drain )); then rm "$drain"; fi
  if (( worker_stopped || own_drain )); then systemctl start sd2-image-studio.service; fi
  printf 'ROLLBACK_DONE %s\n' "$base"
  exit "$code"
}
trap rollback ERR INT TERM
old_worker_pid=$(systemctl show sd2-image-studio.service -p MainPID --value)
touch "$drain"; chown gouki:gouki "$drain"; own_drain=1
systemctl stop sd2-image-studio.service
worker_stopped=1
running=$(sqlite3 -readonly /data/video-api-debugger/var-lib/dev.db "SELECT count(*) FROM ImageStudioTask WHERE status='running';")
test "$running" = 0
printf 'WORKER_DRAIN_CONFIRMED accepted_running=%s\n' "$running"
systemctl stop sd2-gray.service
source_started=1
rsync -a --delete --chown=gouki:gouki "${excludes[@]}" "$release/" "$app/"
for link in storage public/uploads public/videos; do
  test -L "$app/$link"
  case "$(readlink -f "$app/$link")" in /data/video-api-debugger/var-lib/*) ;; *) exit 76 ;; esac
done
node "$uploaded/source-proof.mjs" "$release" "$app"
mv "$app/.next-prod" "$previous"; switched=1
mv "$stage" "$app/.next-prod"
printf '%s\n' "$commit" > "$app/.deployed-commit"; chown gouki:gouki "$app/.deployed-commit"
systemctl start sd2-gray.service
healthy=0
for ((i=0;i<60;i++)); do
  if curl --fail --silent http://127.0.0.1:3302/api/release | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{try{process.exit(JSON.parse(s).version==='0.45.0'?0:1)}catch{process.exit(1)}})"; then healthy=1; break; fi
  sleep 1
done
test "$healthy" = 1
test "$(cat "$app/.next-prod/BUILD_ID")" = "$new_build"
rm "$drain"; own_drain=0
systemctl start sd2-image-studio.service
systemctl is-active --quiet sd2-gray.service sd2-image-studio.service
sleep 3
systemctl is-active --quiet sd2-image-studio.service
new_worker_pid=$(systemctl show sd2-image-studio.service -p MainPID --value)
test "$new_worker_pid" != 0
test "$new_worker_pid" != "$old_worker_pid"
node "$uploaded/artifact-proof.mjs" "$app" .next-prod "$commit" public > "$uploaded/public.json"
curl --fail --silent http://127.0.0.1:3302/api/config > "$uploaded/origin-config.json"
printf 'SWITCH_SUCCESS commit=%s build=%s rollback_commit=%s rollback_build=%s worker_reloaded=true worker_pid_before=%s worker_pid_after=%s\n' "$commit" "$new_build" "$base" "$old_build" "$old_worker_pid" "$new_worker_pid"
trap - ERR INT TERM
