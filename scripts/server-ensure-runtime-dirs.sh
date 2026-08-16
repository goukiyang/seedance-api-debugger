#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${1:-/srv/video-api-debugger/app}"
RUN_USER="${SD2_RUN_USER:-gouki}"
RUN_GROUP="${SD2_RUN_GROUP:-gouki}"
SHARED_ROOT="${SD2_SHARED_ROOT:-/var/lib/video-api-debugger}"

if [[ ! -d "$APP_DIR" ]]; then
  echo "app directory not found: $APP_DIR" >&2
  exit 1
fi

copy_existing_runtime_data() {
  local source_dir="$1"
  local target_dir="$2"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a "$source_dir"/ "$target_dir"/
  else
    cp -a "$source_dir"/. "$target_dir"/
  fi
}

migrate_runtime_path_to_shared() {
  local app_path="$1"
  local shared_path="$2"

  install -d -o "$RUN_USER" -g "$RUN_GROUP" -m 775 "$shared_path"

  # 旧发布包可能把本机 Mac 的软链带到服务器；坏软链没有数据，先替换为服务器本地持久目录。
  if [[ -L "$app_path" && ! -e "$app_path" ]]; then
    rm "$app_path"
  fi

  if [[ -L "$app_path" ]]; then
    local current_target
    current_target="$(readlink "$app_path" 2>/dev/null || true)"
    if [[ "$current_target" != "$shared_path" ]]; then
      rm "$app_path"
    fi
  fi

  if [[ -d "$app_path" && ! -L "$app_path" ]]; then
    copy_existing_runtime_data "$app_path" "$shared_path"
    rm -rf "$app_path"
  elif [[ -e "$app_path" && ! -L "$app_path" ]]; then
    echo "runtime path is not a directory: $app_path" >&2
    exit 1
  fi

  ln -sfn "$shared_path" "$app_path"
  chown -h "$RUN_USER:$RUN_GROUP" "$app_path"
}

install -d -o "$RUN_USER" -g "$RUN_GROUP" -m 775 \
  "$APP_DIR/public" \
  "$SHARED_ROOT/uploads" \
  "$SHARED_ROOT/uploads/assets" \
  "$SHARED_ROOT/uploads/thumbs" \
  "$SHARED_ROOT/videos" \
  "$SHARED_ROOT/videos/thumbnails" \
  "$SHARED_ROOT/storage" \
  "$SHARED_ROOT/storage/backups"

migrate_runtime_path_to_shared "$APP_DIR/public/uploads" "$SHARED_ROOT/uploads"
migrate_runtime_path_to_shared "$APP_DIR/public/videos" "$SHARED_ROOT/videos"
migrate_runtime_path_to_shared "$APP_DIR/storage" "$SHARED_ROOT/storage"

install -d -o "$RUN_USER" -g "$RUN_GROUP" -m 775 \
  "$SHARED_ROOT/uploads" \
  "$SHARED_ROOT/uploads/assets" \
  "$SHARED_ROOT/uploads/thumbs" \
  "$SHARED_ROOT/videos" \
  "$SHARED_ROOT/videos/thumbnails" \
  "$SHARED_ROOT/storage/backups"

chown -R "$RUN_USER:$RUN_GROUP" \
  "$SHARED_ROOT/uploads" \
  "$SHARED_ROOT/videos" \
  "$SHARED_ROOT/storage"

chmod 775 \
  "$SHARED_ROOT/uploads" \
  "$SHARED_ROOT/uploads/assets" \
  "$SHARED_ROOT/uploads/thumbs" \
  "$SHARED_ROOT/videos" \
  "$SHARED_ROOT/videos/thumbnails" \
  "$SHARED_ROOT/storage/backups"

for dir in \
  "$APP_DIR/public/uploads" \
  "$APP_DIR/public/uploads/assets" \
  "$APP_DIR/public/uploads/thumbs" \
  "$APP_DIR/public/videos" \
  "$APP_DIR/public/videos/thumbnails" \
  "$APP_DIR/storage/backups"; do
  sudo -u "$RUN_USER" test -w "$dir"
done

for link_path in \
  "$APP_DIR/public/uploads" \
  "$APP_DIR/public/videos" \
  "$APP_DIR/storage"; do
  if [[ ! -L "$link_path" ]]; then
    echo "runtime path is not linked to shared storage: $link_path" >&2
    exit 1
  fi
done

stat -Lc '%U %G %a %n' \
  "$APP_DIR/public/uploads" \
  "$APP_DIR/public/uploads/assets" \
  "$APP_DIR/public/uploads/thumbs" \
  "$APP_DIR/public/videos" \
  "$APP_DIR/public/videos/thumbnails" \
  "$APP_DIR/storage/backups"

stat -c '%N' \
  "$APP_DIR/public/uploads" \
  "$APP_DIR/public/videos" \
  "$APP_DIR/storage"
