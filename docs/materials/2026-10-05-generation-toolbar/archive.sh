#!/usr/bin/env bash
set -euo pipefail

commit="$1"
base="$2"
[[ "$commit" =~ ^[a-f0-9]{40}$ ]]
[[ "$base" =~ ^[a-f0-9]{40}$ ]]
archive_dir="/tmp/sd2-generation-toolbar-${commit}"
test ! -e "$archive_dir"
mkdir -p "$archive_dir"
tmp=$(mktemp -d "/tmp/sd2-generation-toolbar-archive.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

make_archive() {
  local rev="$1" name="$2"
  git archive --format=tar "$rev" | tar --exclude='.env*' --exclude='node_modules' --exclude='.next*' \
    --exclude='storage' --exclude='public/uploads' --exclude='public/videos' --exclude='*.db*' --exclude='*.sqlite*' \
    -xf - -C "$tmp"
  tar -czf "$archive_dir/$name" -C "$tmp" .
  find "$tmp" -mindepth 1 -delete
  if tar -tzf "$archive_dir/$name" | rg '(^|/)(\.env[^/]*|node_modules|\.next[^/]*|storage|uploads|videos)(/|$)|\.(db|sqlite|sqlite3)(-|/|$)'; then
    printf 'Unsafe runtime path in archive: %s\n' "$name" >&2
    exit 76
  fi
  shasum -a 256 "$archive_dir/$name"
}

make_archive "$commit" "source-${commit}.tar.gz"
make_archive "$base" "rollback-${base}.tar.gz"
printf 'ARCHIVES_READY %s\n' "$archive_dir"
