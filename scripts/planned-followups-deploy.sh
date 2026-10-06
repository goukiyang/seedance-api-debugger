#!/usr/bin/env bash
set -euo pipefail
mode="$1"; commit="$2"; base="$3"; old_build="$4"; uploaded="$5"; source_sha="$6"; base_sha="$7"
app=/srv/video-api-debugger/app
release="/srv/video-api-debugger/releases/$commit"
baseline="/srv/video-api-debugger/releases/$base-followups-rollback-source"
short="${commit:0:12}"
exec 9>/srv/video-api-debugger/deploy.lock
flock -n 9 || exit 75
test "$(cat "$app/.deployed-commit")" = "$base"
test "$(cat "$app/.next-prod/BUILD_ID")" = "$old_build"
if test "$mode" = candidate; then
  available=$(df -Pk "$app" | awk 'NR==2 {print $4}')
  old_size=$(du -sk "$app/.next-prod" | awk '{print $1}')
  old_cache=0
  if test -d "$app/.next-prod/cache"; then old_cache=$(du -sk "$app/.next-prod/cache" | awk '{print $1}'); fi
  # Build on the actual release filesystem; reserve one future stage on the app filesystem.
  release_available=$(df -Pk "$(dirname "$release")" | awk 'NR==2 {print $4}')
  test "$release_available" -gt "$((old_size * 2 + 512000))"
  test "$available" -gt "$((old_size - old_cache + 512000))"
  printf '%s  %s/%s.tar.gz\n' "$source_sha" "$uploaded" "$commit" | sha256sum -c -
  printf '%s  %s/%s.tar.gz\n' "$base_sha" "$uploaded" "$base" | sha256sum -c -
  test ! -e "$release"
  mkdir "$release"
  tar -xzf "$uploaded/$commit.tar.gz" -C "$release"
  if ! test -e "$baseline"; then mkdir "$baseline"; tar -xzf "$uploaded/$base.tar.gz" -C "$baseline"; fi
  node "$uploaded/planned-followups-source-proof.mjs" "$baseline" "$app"
  test "$(node -p "require('$release/package.json').version")" = 0.51.0
  ln -s "$app/node_modules" "$release/node_modules"
  chown -R gouki:gouki "$release"
  cd "$release"
  runuser -u gouki -- env NEXT_DIST_DIR=.next-prod-candidate npm run build > "$uploaded/build-server.log" 2>&1
  node "$uploaded/planned-followups-artifact-proof.mjs" "$release" .next-prod-candidate "$commit" > "$uploaded/candidate.json"
  printf 'CANDIDATE_OK %s %s\n' "$commit" "$(cat .next-prod-candidate/BUILD_ID)"
  exit 0
fi
test "$mode" = switch
node "$uploaded/planned-followups-source-proof.mjs" "$baseline" "$app"
node "$uploaded/planned-followups-artifact-proof.mjs" "$release" .next-prod-candidate "$commit" > "$uploaded/candidate.json"
for entry in storage public/uploads public/videos; do test -L "$app/$entry"; done
stage="$app/.next-prod-candidate-followups-$short"
previous="$app/.next-prod-prev-followups-$short"
test ! -e "$stage"; test ! -e "$previous"
available=$(df -Pk "$app" | awk 'NR==2 {print $4}')
if test "$(stat -c %d "$release/.next-prod-candidate")" = "$(stat -c %d "$app")"; then
  test "$available" -gt 512000
  mv "$release/.next-prod-candidate" "$stage"
else
  candidate_size=$(du -sk "$release/.next-prod-candidate" | awk '{print $1}')
  candidate_cache=0
  if test -d "$release/.next-prod-candidate/cache"; then candidate_cache=$(du -sk "$release/.next-prod-candidate/cache" | awk '{print $1}'); fi
  test "$available" -gt "$((candidate_size - candidate_cache + 512000))"
  mkdir "$stage"
  # Next's rebuild cache is not needed by next start; retain it on the release disk.
  rsync -a --exclude='/cache/' "$release/.next-prod-candidate/" "$stage/"
  test "$(df -Pk "$app" | awk 'NR==2 {print $4}')" -gt 512000
fi
chown -R gouki:gouki "$stage"
new_build=$(cat "$stage/BUILD_ID")
node "$uploaded/planned-followups-artifact-proof.mjs" "$release" "$stage" "$commit" > "$uploaded/staged.json"
old_worker_pid=$(systemctl show sd2-image-studio.service -p MainPID --value)
old_worker_invocation=$(systemctl show sd2-image-studio.service -p InvocationID --value)
excludes=(--exclude='.env*' --exclude='.git' --exclude=node_modules --exclude='.next*' --exclude=storage --exclude=public --exclude='*.db*' --exclude='*.sqlite*' --exclude='.deployed-*' --exclude='*.log' --include='/src/***' --include='/scripts/***' --include='/ops/***' --include='/prisma/***' --include='/package.json' --include='/package-lock.json' --include='/next.config.js' --include='/tsconfig.json' --include='/next-env.d.ts' --include='/.eslintrc.json' --exclude='*')
public_files=(index.html style-gallery.js style-gallery.css canvas-styles.js like-button.css like-button.LICENSE.txt)
sync_public() {
  local from="$1"
  if test -f "$from/public/styles/loading.css"; then
    mkdir -p "$app/public/styles"
    install -o gouki -g gouki -m 644 "$from/public/styles/loading.css" "$app/public/styles/loading.css"
  fi
  for file in "${public_files[@]}"; do
    if test -f "$from/public/tools/ultimate-canvas/$file"; then
      install -o gouki -g gouki -m 644 "$from/public/tools/ultimate-canvas/$file" "$app/public/tools/ultimate-canvas/$file"
    fi
  done
}
sync_home() {
  local from="$1"
  if test -d "$from/public/home"; then
    mkdir -p "$app/public/home"
    for name in video canvas templates avatar cutout; do install -o gouki -g gouki -m 644 "$from/public/home/$name.png" "$app/public/home/$name.png"; done
  fi
}
source_started=0; switched=0
rollback() {
  code=$?; trap - ERR INT TERM
  if (( source_started )); then
    systemctl stop sd2-gray.service || true
    rsync -a --delete --chown=gouki:gouki "${excludes[@]}" "$baseline/" "$app/"
    sync_public "$baseline"
    sync_home "$baseline"
    if (( switched )); then
      if test -e "$app/.next-prod"; then mv "$app/.next-prod" "$app/.next-prod-failed-followups-$short"; fi
      mv "$previous" "$app/.next-prod"
    fi
    printf '%s\n' "$base" > "$app/.deployed-commit"; chown gouki:gouki "$app/.deployed-commit"
    systemctl start sd2-gray.service
  fi
  printf 'ROLLED_BACK %s\n' "$base"
  exit "$code"
}
trap rollback ERR INT TERM
systemctl stop sd2-gray.service
source_started=1
rsync -a --delete --chown=gouki:gouki "${excludes[@]}" "$release/" "$app/"
sync_public "$release"
sync_home "$release"
node "$uploaded/planned-followups-source-proof.mjs" "$release" "$app"
for entry in storage public/uploads public/videos; do
  test -L "$app/$entry"
  case "$(readlink -f "$app/$entry")" in /data/video-api-debugger/var-lib/*) ;; *) exit 76 ;; esac
done
mv "$app/.next-prod" "$previous"; switched=1
mv "$stage" "$app/.next-prod"
printf '%s\n' "$commit" > "$app/.deployed-commit"; chown gouki:gouki "$app/.deployed-commit"
systemctl start sd2-gray.service
healthy=0
for ((i=0;i<60;i++)); do
  if curl --fail --silent http://127.0.0.1:3302/api/release | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{try{process.exit(JSON.parse(s).version==='0.51.0'?0:1)}catch{process.exit(1)}})"; then healthy=1; break; fi
  sleep 1
done
test "$healthy" = 1
test "$(cat "$app/.next-prod/BUILD_ID")" = "$new_build"
systemctl is-active --quiet sd2-gray.service sd2-image-studio.service
test "$(systemctl show sd2-image-studio.service -p MainPID --value)" = "$old_worker_pid"
test "$(systemctl show sd2-image-studio.service -p InvocationID --value)" = "$old_worker_invocation"
node "$uploaded/planned-followups-artifact-proof.mjs" "$app" .next-prod "$commit" > "$uploaded/runtime.json"
printf 'SWITCH_OK commit=%s build=%s rollback=%s worker_retained=true\n' "$commit" "$new_build" "$previous"
trap - ERR INT TERM
