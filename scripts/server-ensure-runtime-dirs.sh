#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${1:-/srv/video-api-debugger/app}"
RUN_USER="${SD2_RUN_USER:-gouki}"
RUN_GROUP="${SD2_RUN_GROUP:-gouki}"

if [[ ! -d "$APP_DIR" ]]; then
  echo "app directory not found: $APP_DIR" >&2
  exit 1
fi

# 旧发布包可能把本机 Mac 的 storage 软链带到服务器；坏软链没有数据，先替换为服务器本地目录。
if [[ -L "$APP_DIR/storage" && ! -e "$APP_DIR/storage" ]]; then
  rm "$APP_DIR/storage"
fi

install -d -o "$RUN_USER" -g "$RUN_GROUP" -m 775 \
  "$APP_DIR/public/uploads" \
  "$APP_DIR/public/uploads/assets" \
  "$APP_DIR/public/uploads/thumbs" \
  "$APP_DIR/public/videos" \
  "$APP_DIR/public/videos/thumbnails" \
  "$APP_DIR/storage/backups"

chmod 775 \
  "$APP_DIR/public/uploads" \
  "$APP_DIR/public/uploads/assets" \
  "$APP_DIR/public/uploads/thumbs" \
  "$APP_DIR/public/videos" \
  "$APP_DIR/public/videos/thumbnails" \
  "$APP_DIR/storage/backups"

for dir in \
  "$APP_DIR/public/uploads" \
  "$APP_DIR/public/uploads/assets" \
  "$APP_DIR/public/uploads/thumbs" \
  "$APP_DIR/public/videos" \
  "$APP_DIR/public/videos/thumbnails" \
  "$APP_DIR/storage/backups"; do
  sudo -u "$RUN_USER" test -w "$dir"
done

stat -c '%U %G %a %n' \
  "$APP_DIR/public/uploads" \
  "$APP_DIR/public/uploads/assets" \
  "$APP_DIR/public/uploads/thumbs" \
  "$APP_DIR/public/videos" \
  "$APP_DIR/public/videos/thumbnails" \
  "$APP_DIR/storage/backups"
