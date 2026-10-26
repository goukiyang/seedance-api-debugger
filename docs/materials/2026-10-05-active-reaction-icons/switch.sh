#!/usr/bin/env bash
set -euo pipefail
commit="$1"; base="$2"; old_build="$3"; archive_dir="$4"
app=/srv/video-api-debugger/app
release="/srv/video-api-debugger/releases/$commit"
baseline="/srv/video-api-debugger/releases/$base-active-reaction-icons-rollback"
short="${commit:0:7}"
stage="$app/.next-prod-candidate-active-reaction-icons-$short"
previous="$app/.next-prod-prev-active-reaction-icons-$short"
proof="$release/docs/materials/2026-10-05-active-reaction-icons/source-proof.mjs"
exec 9>/srv/video-api-debugger/deploy.lock
flock -n 9 || exit 75
test "$(cat "$app/.deployed-commit")" = "$base"
test "$(cat "$app/.next-prod/BUILD_ID")" = "$old_build"
test "$(node -p "require('$app/package.json').version")" = 0.43.3
test "$(node -p "require('$release/package.json').version")" = 0.43.4
test ! -e "$previous"
test ! -e "$stage"
node "$proof" compare "$baseline" "$app" "$commit" "$archive_dir/pre-switch-source.json"
node "$proof" boundary "$baseline" "$release" "$commit" "$archive_dir/pre-switch-boundary.json"
node "$proof" candidate "$release" unused "$commit" "$archive_dir/pre-switch-candidate.json"
for link in storage public/uploads public/videos; do
  test -L "$app/$link"
  case "$(readlink -f "$app/$link")" in /data/video-api-debugger/var-lib/*) ;; *) exit 76 ;; esac
done
worker_pid=$(systemctl show sd2-image-studio.service -p MainPID --value)
test "$worker_pid" = 259902
systemctl is-active --quiet sd2-image-studio.service
new_build=$(cat "$release/.next-prod-candidate/BUILD_ID")
mkdir "$stage"
rsync -a "$release/.next-prod-candidate/" "$stage/"
if (( EUID == 0 )); then chown -R gouki:gouki "$stage"; fi
test "$(cat "$stage/BUILD_ID")" = "$new_build"
excludes=(--exclude='.env*' --exclude='.git' --exclude=node_modules --exclude='.next*' --exclude=storage --exclude=public/uploads --exclude=public/videos --exclude='*.db*' --exclude='*.sqlite*' --exclude='.deployed-*')
sync_source() {
  if (( EUID == 0 )); then rsync -a --delete --chown=gouki:gouki "${excludes[@]}" "$1/" "$app/"; else rsync -a --delete "${excludes[@]}" "$1/" "$app/"; fi
}
source_started=0; switched=0
rollback() {
  code=$?
  trap - ERR INT TERM
  if (( source_started )); then
    printf 'ROLLBACK_START\n'
    systemctl stop sd2-gray.service || true
    sync_source "$baseline"
    if (( switched )); then
      if test -e "$app/.next-prod"; then mv "$app/.next-prod" "$app/.next-prod-failed-active-reaction-icons-$short-$(date +%s)"; fi
      mv "$previous" "$app/.next-prod"
    fi
    printf '%s\n' "$base" > "$app/.deployed-commit"
    if (( EUID == 0 )); then chown gouki:gouki "$app/.deployed-commit"; fi
    systemctl start sd2-gray.service
    test "$(cat "$app/.next-prod/BUILD_ID")" = "$old_build"
    printf 'ROLLBACK_DONE %s %s\n' "$base" "$old_build"
  fi
  exit "$code"
}
trap rollback ERR INT TERM
systemctl stop sd2-gray.service
source_started=1
sync_source "$release"
for link in storage public/uploads public/videos; do
  test -L "$app/$link"
  case "$(readlink -f "$app/$link")" in /data/video-api-debugger/var-lib/*) ;; *) exit 76 ;; esac
done
for directory in public/uploads/assets public/uploads/thumbs public/videos/thumbnails storage/backups; do
  if (( EUID == 0 )); then runuser -u gouki -- test -d "$app/$directory"; runuser -u gouki -- test -w "$app/$directory"; else test -d "$app/$directory"; test -w "$app/$directory"; fi
done
mv "$app/.next-prod" "$previous"
switched=1
mv "$stage" "$app/.next-prod"
printf '%s\n' "$commit" > "$app/.deployed-commit"
if (( EUID == 0 )); then chown gouki:gouki "$app/.deployed-commit"; fi
systemctl start sd2-gray.service
healthy=0
for ((i=0;i<60;i++)); do
  if curl --fail --silent http://127.0.0.1:3302/api/release | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{try{process.exit(JSON.parse(s).version==='0.43.4'?0:1)}catch{process.exit(1)}})"; then healthy=1; break; fi
  sleep 1
done
test "$healthy" = 1
systemctl is-active --quiet sd2-gray.service
systemctl is-active --quiet sd2-image-studio.service
test "$(systemctl show sd2-image-studio.service -p MainPID --value)" = "$worker_pid"
test "$(cat "$app/.next-prod/BUILD_ID")" = "$new_build"
node "$proof" compare "$release" "$app" "$commit" "$archive_dir/server-source.json"
node "$proof" public "$app" unused "$commit" "$archive_dir/public.json"
node - "$app" "$base" "$commit" "$old_build" "$new_build" "$previous" "$baseline" "$archive_dir" <<'JS'
const fs=require('fs'),path=require('path');const [app,base,commit,oldBuild,buildId,rollbackBuild,rollbackSource,out]=process.argv.slice(2);
fs.writeFileSync(path.join(out,'runtime.json'),JSON.stringify({base,commit,oldBuild,buildId,rollbackBuild,rollbackSource,workerPid:259902,workerRestarted:false,persistentLinks:Object.fromEntries(['storage','public/uploads','public/videos'].map(file=>[file,fs.readlinkSync(path.join(app,file))])),businessCalls:0,paidCalls:0,databaseWrites:0},null,2));
JS
trap - ERR INT TERM
printf 'SWITCH_SUCCESS commit=%s build=%s previousBuild=%s rollbackSource=%s rollbackBuild=%s\n' "$commit" "$new_build" "$old_build" "$baseline" "$previous"
