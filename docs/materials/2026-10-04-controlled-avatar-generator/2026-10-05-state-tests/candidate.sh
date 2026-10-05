#!/usr/bin/env bash
set -euo pipefail
commit="$1"
archive_sha="$2"
base=ad65015c14b20577b8e19ab77239cd7e10458d7c
app=/srv/video-api-debugger/app
release=/srv/video-api-debugger/releases/$commit
baseline=/srv/video-api-debugger/releases/$base-avatar-rollback
exec 9>/srv/video-api-debugger/deploy.lock
flock -n 9 || { printf 'Another server release holds deploy.lock\n'; exit 75; }
test "$(cat "$app/.deployed-commit")" = "$base"
printf '%s  %s\n' "$archive_sha" "/tmp/sd2-avatar-$commit.tar.gz" | sha256sum -c -
printf '%s  %s\n' 3491d2115ada76b70ad8271a8125f4cf3cba0f5fd661c0f148c388cbdb95bf7c "/tmp/sd2-avatar-$base.tar.gz" | sha256sum -c -
test ! -e "$release"
mkdir "$release"
tar -xzf "/tmp/sd2-avatar-$commit.tar.gz" -C "$release"
if test ! -e "$baseline"; then
  mkdir "$baseline"
  tar -xzf "/tmp/sd2-avatar-$base.tar.gz" -C "$baseline"
fi
node - "$baseline" "$app" <<'JS'
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const [baseline,app]=process.argv.slice(2);
const dirs=['src','scripts','prisma'];
function files(root,dir){let out=[];for(const e of fs.readdirSync(path.join(root,dir),{withFileTypes:true})){const p=path.join(dir,e.name);if(e.name.startsWith('.env')||/\.(db|sqlite|sqlite3)(-|$)/.test(e.name))continue;if(e.isDirectory())out.push(...files(root,p));else if(e.isFile())out.push(p);}return out;}
const expected=dirs.flatMap(d=>files(baseline,d)).concat(['package.json','package-lock.json','next.config.js','tsconfig.json','.eslintrc.json']);
const current=dirs.flatMap(d=>files(app,d));
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const drift=expected.filter(p=>!fs.existsSync(path.join(app,p))||sha(path.join(baseline,p))!==sha(path.join(app,p))).concat(current.filter(p=>!expected.includes(p)));
if(drift.length){console.log(JSON.stringify({sourceDrift:drift}));process.exit(76);}
console.log(JSON.stringify({sourceBaselineMatches:true,checkedFiles:expected.length}));
JS
test "$(node -p "require('$release/package.json').version")" = 0.42.3
ln -s "$app/node_modules" "$release/node_modules"
cd "$release"
NEXT_DIST_DIR=.next-prod-candidate npm run build > /tmp/sd2-avatar-state-repair-server-build-$commit.log 2>&1
test -s .next-prod-candidate/BUILD_ID
node - <<'JS'
const fs=require('fs');const a=JSON.parse(fs.readFileSync('.next-prod-candidate/server/app-paths-manifest.json','utf8'));
for(const route of ['/tools/avatar-studio/page','/tools/avatar-studio/configs/page','/api/avatar-studio/route','/api/avatar-studio/handoff/route','/api/assets/library/removal/route'])if(!a[route])throw Error('Missing candidate route '+route);
const manifest=JSON.parse(fs.readFileSync('.next-prod-candidate/app-build-manifest.json','utf8'));
const avatarChunks=manifest.pages['/tools/avatar-studio/page'].filter(file=>file.endsWith('.js')&&fs.readFileSync('.next-prod-candidate/'+file,'utf8').includes('不能微调或新建人物')&&fs.readFileSync('.next-prod-candidate/'+file,'utf8').includes('force:'));
if(!avatarChunks.length)throw Error('Missing compiled avatar credit refresh');
console.log(JSON.stringify({version:require('./package.json').version,buildId:fs.readFileSync('.next-prod-candidate/BUILD_ID','utf8').trim(),routesPresent:true,avatarRefreshChunks:avatarChunks}));
JS
printf 'CANDIDATE_BUILD_SUCCESS %s\n' "$commit"
