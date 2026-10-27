#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${1:?pass the exact managed candidate directory}"
RUN_USER="${SD2_RUN_USER:-gouki}"
RUN_GROUP="${SD2_RUN_GROUP:-gouki}"
SHARED_ROOT="${SD2_SHARED_ROOT:-/data/video-api-debugger/var-lib}"
DELIVERY_GROUP="${SD2_DELIVERY_GROUP:-www-data}"

test -d "$APP_DIR"
test "$(readlink -f "$SHARED_ROOT")" = "$SHARED_ROOT"
test "$(stat -c %d /data)" != "$(stat -c %d /)"
test "$(stat -c %d "$SHARED_ROOT")" = "$(stat -c %d /data)"

# Never copy, delete or relink legacy runtime data during candidate preparation.
for name in uploads videos; do
  if [[ -e "$APP_DIR/public/$name" || -L "$APP_DIR/public/$name" ]]; then
    printf 'private media must not be in the candidate static tree: %s\n' "$name" >&2
    exit 1
  fi
done

for relative in uploads/assets uploads/thumbs videos/thumbnails storage/backups storage/studio-thumbnails storage/supplier-media; do
  if [[ ! -d "$SHARED_ROOT/$relative" ]]; then
    install -d -o "$RUN_USER" -g "$RUN_GROUP" -m 750 "$SHARED_ROOT/$relative"
  fi
  runuser -u "$RUN_USER" -- test -w "$SHARED_ROOT/$relative"
done

# Only this derivative cache is nginx-readable; HD and original permissions stay untouched.
if [[ ! -d "$SHARED_ROOT/storage/media-outlet" ]]; then
  install -d -o "$RUN_USER" -g "$DELIVERY_GROUP" -m 2750 "$SHARED_ROOT/storage/media-outlet"
fi
test "$(stat -c %U "$SHARED_ROOT/storage/media-outlet")" = "$RUN_USER"
test "$(stat -c %G "$SHARED_ROOT/storage/media-outlet")" = "$DELIVERY_GROUP"
test "$(stat -c %a "$SHARED_ROOT/storage/media-outlet")" = 2750
runuser -u "$RUN_USER" -- test -w "$SHARED_ROOT/storage/media-outlet"
runuser -u "$DELIVERY_GROUP" -- test -x "$SHARED_ROOT/storage/media-outlet"

if [[ -L "$APP_DIR/storage" ]]; then
  test "$(readlink -f "$APP_DIR/storage")" = "$SHARED_ROOT/storage"
elif [[ -e "$APP_DIR/storage" ]]; then
  echo 'candidate storage must be absent or the verified persistent symlink' >&2
  exit 1
else
  ln -s "$SHARED_ROOT/storage" "$APP_DIR/storage"
  chown -h "$RUN_USER:$RUN_GROUP" "$APP_DIR/storage"
fi
printf 'private media roots ready; no originals copied or permissions widened\n'
