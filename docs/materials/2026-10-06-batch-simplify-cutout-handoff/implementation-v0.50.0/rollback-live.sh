#!/usr/bin/env bash
set -euo pipefail
app=/srv/video-api-debugger/app
commit=391f7414f99a3aaccb5b3133432858f5b8bee8d3
base=9adbaa2d77798c05d9e8a463337e7feccbe1e66a
baseline=/srv/video-api-debugger/releases/$base-followups-rollback-source
previous=$app/.next-prod-prev-followups-391f7414f99a
failed=$app/.next-prod-failed-followups-391f7414f99a-public
exec 9>/srv/video-api-debugger/deploy.lock
flock -n 9
test "$(cat "$app/.deployed-commit")" = "$commit"
test "$(cat "$previous/BUILD_ID")" = qm5JfAJ6THxzn3X5MOiUZ
test ! -e "$failed"
worker_pid=$(systemctl show sd2-image-studio.service -p MainPID --value)
worker_invocation=$(systemctl show sd2-image-studio.service -p InvocationID --value)
systemctl stop sd2-gray.service
rsync -a --delete --chown=gouki:gouki --exclude='.env*' --exclude='.git' --exclude=node_modules --exclude='.next*' --exclude=storage --exclude=public --exclude='*.db*' --exclude='*.sqlite*' --exclude='.deployed-*' --exclude='*.log' --include='/src/***' --include='/scripts/***' --include='/ops/***' --include='/prisma/***' --include='/package.json' --include='/package-lock.json' --include='/next.config.js' --include='/tsconfig.json' --include='/next-env.d.ts' --include='/.eslintrc.json' --exclude='*' "$baseline/" "$app/"
for file in index.html style-gallery.js style-gallery.css canvas-styles.js like-button.css like-button.LICENSE.txt; do
  install -o gouki -g gouki -m 644 "$baseline/public/tools/ultimate-canvas/$file" "$app/public/tools/ultimate-canvas/$file"
done
install -o gouki -g gouki -m 644 "$baseline/public/styles/loading.css" "$app/public/styles/loading.css"
mv "$app/.next-prod" "$failed"
mv "$previous" "$app/.next-prod"
printf '%s\n' "$base" > "$app/.deployed-commit"
chown gouki:gouki "$app/.deployed-commit"
systemctl start sd2-gray.service
systemctl is-active sd2-gray.service sd2-image-studio.service
test "$(systemctl show sd2-image-studio.service -p MainPID --value)" = "$worker_pid"
test "$(systemctl show sd2-image-studio.service -p InvocationID --value)" = "$worker_invocation"
node /tmp/sd2-followups-eb39d374613e/planned-followups-source-proof.mjs "$baseline" "$app"
printf 'ROLLBACK_RESTORED commit=%s build=%s worker_retained=true\n' "$base" "$(cat "$app/.next-prod/BUILD_ID")"
