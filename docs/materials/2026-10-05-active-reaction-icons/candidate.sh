#!/usr/bin/env bash
set -euo pipefail
commit="$1"; source_sha="$2"; base="$3"; rollback_sha="$4"; old_build="$5"; archive_dir="$6"
app=/srv/video-api-debugger/app
release="/srv/video-api-debugger/releases/$commit"
baseline="/srv/video-api-debugger/releases/$base-active-reaction-icons-rollback"
exec 9>/srv/video-api-debugger/deploy.lock
flock -n 9 || exit 75
test "$(cat "$app/.deployed-commit")" = "$base"
test "$(cat "$app/.next-prod/BUILD_ID")" = "$old_build"
test "$(node -p "require('$app/package.json').version")" = 0.43.3
test "$(systemctl show sd2-image-studio.service -p MainPID --value)" = 259902
systemctl is-active --quiet sd2-gray.service
systemctl is-active --quiet sd2-image-studio.service
printf '%s  %s/source-%s.tar.gz\n' "$source_sha" "$archive_dir" "$commit" | sha256sum -c -
printf '%s  %s/rollback-%s.tar.gz\n' "$rollback_sha" "$archive_dir" "$base" | sha256sum -c -
test ! -e "$release"
test ! -e "$baseline"
mkdir "$release" "$baseline"
tar -xzf "$archive_dir/source-$commit.tar.gz" -C "$release"
tar -xzf "$archive_dir/rollback-$base.tar.gz" -C "$baseline"
proof="$release/docs/materials/2026-10-05-active-reaction-icons/source-proof.mjs"
node "$proof" compare "$baseline" "$app" "$commit" "$archive_dir/baseline-source.json"
node "$proof" boundary "$baseline" "$release" "$commit" "$archive_dir/source-boundary.json"
node "$proof" source "$release" unused "$commit" "$archive_dir/candidate-source.json"
ln -s "$app/node_modules" "$release/node_modules"
cd "$release"
log="$archive_dir/build.log"
set +e
NEXT_DIST_DIR=.next-prod-candidate npm run build >"$log" 2>&1
code=$?
set -e
printf 'CANDIDATE_BUILD_EXIT=%s\n' "$code"
if (( code != 0 )); then tail -n 100 "$log" >&2; exit "$code"; fi
node "$proof" candidate "$release" unused "$commit" "$archive_dir/candidate.json"
test "$(cat "$app/.deployed-commit")" = "$base"
test "$(cat "$app/.next-prod/BUILD_ID")" = "$old_build"
test "$(systemctl show sd2-image-studio.service -p MainPID --value)" = 259902
printf 'CANDIDATE_SUCCESS commit=%s build=%s\n' "$commit" "$(cat .next-prod-candidate/BUILD_ID)"
