#!/usr/bin/env bash
set -euo pipefail
commit="$1"; base="$2"; destination="$3"
[[ "$commit" =~ ^[a-f0-9]{40}$ && "$base" =~ ^[a-f0-9]{40}$ ]] || exit 76
mkdir -p "$destination"
temp=$(mktemp -d)
trap 'rm -rf "$temp"' EXIT
revisions=("$commit" "$base")
if [[ "${4:-}" = --source-only ]]; then revisions=("$commit"); fi
for rev in "${revisions[@]}"; do
  mkdir "$temp/$rev"
  git archive "$rev" src scripts prisma public ops/feishu-credit-gateway.mjs package.json package-lock.json next.config.js tsconfig.json next-env.d.ts .eslintrc.json | tar --exclude='.env*' --exclude='public/uploads' --exclude='public/videos' --exclude='*.db*' --exclude='*.sqlite*' -xf - -C "$temp/$rev"
  tar -czf "$destination/$rev.tar.gz" -C "$temp/$rev" .
  if tar -tzf "$destination/$rev.tar.gz" | rg '(^|/)(\.env[^/]*|node_modules|\.next[^/]*|storage)(/|$)|^\./public/(uploads|videos)(/|$)|\.(db|sqlite|sqlite3)(-|/|$)'; then exit 76; fi
  shasum -a 256 "$destination/$rev.tar.gz"
done
