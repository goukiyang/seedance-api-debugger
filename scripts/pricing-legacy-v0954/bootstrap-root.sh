#!/usr/bin/env bash
set -euo pipefail
umask 077

# This prepares engineering inputs only. It never installs a production marker.
fail() { printf '%s\n' "RATE-G19 bootstrap: $*" >&2; exit 1; }
[[ $# -eq 2 ]] || fail 'expected <realCandidateRoot> <nonexistentFixtureRoot>'
[[ $(uname -s) == Linux && $(id -u) == 0 ]] || fail 'real Linux root is required'
for command in realpath findmnt chattr lsattr stat install date; do
  command -v "$command" >/dev/null || fail "missing runtime utility: $command"
done
uid=${RATE_G19_FIXTURE_UID:?set the non-root build UID}
gid=${RATE_G19_FIXTURE_GID:?set the build GID}
source_sha=${RATE_G19_FIXTURE_SOURCE_SHA:?set the candidate source SHA}
[[ $uid =~ ^[1-9][0-9]*$ && $gid =~ ^[0-9]+$ ]] || fail 'invalid build UID/GID'
[[ $source_sha =~ ^[a-f0-9]{40}$ ]] || fail 'source SHA must be 40 lowercase hex characters'
candidate=$(realpath -e -- "$1")
[[ $candidate == "$1" && -d $candidate && -f $candidate/src/lib/pricing/isolation.ts ]] || fail 'candidate must be an existing canonical source root'
[[ $2 == /* && $2 == "$candidate"/.role-tests/* ]] || fail 'fixture must be under this candidate .role-tests'
fixture=$(realpath -m -- "$2")
[[ $fixture == "$2" && $fixture != "$candidate/.role-tests" ]] || fail 'fixture path must be canonical and separate'
[[ $candidate != *[!a-zA-Z0-9_./:-]* && $fixture != *[!a-zA-Z0-9_./:-]* ]] || fail 'unsupported characters in source/fixture path'
[[ ! -e $fixture && ! -L $fixture ]] || fail 'refusing to reuse or overwrite an existing fixture directory'
parent=$(dirname -- "$fixture")
[[ -d $parent && $(realpath -e -- "$parent") == "$parent" ]] || fail 'the engine must create a canonical parent first'
mount=$(findmnt -n -o TARGET --target "$parent")
[[ $mount == /data || $mount == /data/* ]] || fail 'fixture must be on a real mounted /data volume'
[[ -w $parent ]] || fail 'fixture parent is not writable'
installed_at=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
strict=$(printf '{"schema":"pricing-writer-isolation.v1","protocol":"pricing-policy-v1","guard":"reject-legacy-image-writers","installedAt":"%s"}' "$installed_at")
install -d -m 0700 -o "$uid" -g "$gid" -- "$fixture" "$fixture/storage" "$fixture/g19-marker-cases"
trap 'printf "RATE-G19 bootstrap failed; retain %s for root inspection. Never run ordinary recursive cleanup before clearing fixture immutable files.\n" "$fixture" >&2' ERR

write_marker() {
  local root=$1 contents=$2 immutable=$3 file
  install -d -m 0700 -o "$uid" -g "$gid" -- "$root" "$root/storage"
  file=$root/storage/image-studio-drain
  printf '%s\n' "$contents" > "$file"
  chown 0:0 -- "$file"
  chmod 0444 -- "$file"
  [[ $(stat -c '%u:%a:%h' -- "$file") == 0:444:1 ]] || fail 'root marker metadata differs'
  if [[ $immutable == yes ]]; then chattr +i -- "$file"; fi
  local attributes recorded_path
  read -r attributes recorded_path < <(lsattr -d -- "$file")
  [[ $recorded_path == "$file" ]] || fail 'lsattr returned another path'
  if [[ $immutable == yes ]]; then
    [[ $attributes == *i* ]] || fail 'filesystem did not retain the real immutable flag'
  else
    [[ $attributes != *i* ]] || fail 'unprotected control unexpectedly immutable'
  fi
}
write_marker "$fixture" "$strict" yes
write_marker "$fixture/g19-marker-cases/ordinary" 'ordinary-release-drain' no
write_marker "$fixture/g19-marker-cases/unprotected" "$strict" no
write_marker "$fixture/g19-marker-cases/wrong-schema" "${strict/pricing-writer-isolation.v1/pricing-writer-isolation.invalid}" yes
write_marker "$fixture/g19-marker-cases/extra-field" "${strict%?},\"extra\":true}" yes
manifest=$fixture/g19-bootstrap.json
printf '{"schema":"pricing-legacy-bootstrap.v1","candidateRoot":"%s","fixtureRoot":"%s","source":"%s","uid":%s,"gid":%s,"installedAt":"%s","markers":{"strict":"%s/storage/image-studio-drain","ordinary":"%s/g19-marker-cases/ordinary/storage/image-studio-drain","unprotected":"%s/g19-marker-cases/unprotected/storage/image-studio-drain","wrong-schema":"%s/g19-marker-cases/wrong-schema/storage/image-studio-drain","extra-field":"%s/g19-marker-cases/extra-field/storage/image-studio-drain"}}\n' \
  "$candidate" "$fixture" "$source_sha" "$uid" "$gid" "$installed_at" "$fixture" "$fixture" "$fixture" "$fixture" "$fixture" > "$manifest"
chown 0:0 -- "$manifest"
chmod 0444 -- "$manifest"
trap - ERR
printf '%s\n' "$manifest"
printf 'Root cleanup required after receipt capture: clear +i only on the strict, wrong-schema and extra-field marker paths recorded in %s, then remove this engineering directory.\n' "$manifest" >&2
