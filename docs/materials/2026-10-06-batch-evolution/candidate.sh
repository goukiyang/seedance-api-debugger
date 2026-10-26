#!/usr/bin/env bash
set -euo pipefail
commit="$1"; base="$2"; old_build="$3"; source_sha="$4"; rollback_sha="$5"; uploaded="$6"
app=/srv/video-api-debugger/app
release="/srv/video-api-debugger/releases/$commit"
baseline="/srv/video-api-debugger/releases/$base-batch-evolution-rollback-source"
exec 9>/srv/video-api-debugger/deploy.lock
flock -n 9 || exit 75
test "$(cat "$app/.deployed-commit")" = "$base"
test "$(cat "$app/.next-prod/BUILD_ID")" = "$old_build"
printf '%s  %s/%s.tar.gz\n' "$source_sha" "$uploaded" "$commit" | sha256sum -c -
printf '%s  %s/%s.tar.gz\n' "$rollback_sha" "$uploaded" "$base" | sha256sum -c -
test ! -e "$release"
mkdir "$release"
tar -xzf "$uploaded/$commit.tar.gz" -C "$release"
if ! test -e "$baseline"; then mkdir "$baseline"; tar -xzf "$uploaded/$base.tar.gz" -C "$baseline"; fi
node "$uploaded/source-proof.mjs" "$baseline" "$app"
test "$(node -p "require('$release/package.json').version")" = 0.45.0
ln -s "$app/node_modules" "$release/node_modules"
chown -R gouki:gouki "$release"
cd "$release"
node scripts/check-batch-evolution-source.mjs > "$uploaded/static-source-server.json"
runuser -u gouki -- env NEXT_DIST_DIR=.next-prod-candidate npm run build > "$uploaded/build-server.log" 2>&1
test -s .next-prod-candidate/BUILD_ID
node "$uploaded/artifact-proof.mjs" "$release" .next-prod-candidate "$commit" > "$uploaded/candidate.json"
printf 'CANDIDATE_SUCCESS %s %s\n' "$commit" "$(cat .next-prod-candidate/BUILD_ID)"
