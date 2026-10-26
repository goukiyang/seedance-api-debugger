#!/usr/bin/env bash
set -euo pipefail

commit="$1"
source_sha="$2"
base="$3"
rollback_sha="$4"
old_build="$5"
archive_dir="$6"
app=/srv/video-api-debugger/app
release="/srv/video-api-debugger/releases/$commit"
baseline="/srv/video-api-debugger/releases/$base-generation-toolbar-rollback"
test "$(cat "$app/.deployed-commit")" = "$base"
test "$(cat "$app/.next-prod/BUILD_ID")" = "$old_build"
test "$(node -p "require('$app/package.json').version")" = 0.43.2
exec 9>/srv/video-api-debugger/deploy.lock
flock -n 9 || { printf 'Another server release holds deploy.lock\n'; exit 75; }

printf '%s  %s/source-%s.tar.gz\n' "$source_sha" "$archive_dir" "$commit" | sha256sum -c -
printf '%s  %s/rollback-%s.tar.gz\n' "$rollback_sha" "$archive_dir" "$base" | sha256sum -c -
test ! -e "$release"
mkdir "$release"
tar -xzf "$archive_dir/source-$commit.tar.gz" -C "$release"
if test -e "$baseline"; then
  test -d "$baseline"
  test ! -L "$baseline"
  printf 'REUSE_SAME_BATCH_ROLLBACK_SOURCE %s\n' "$baseline"
else
  mkdir "$baseline"
  tar -xzf "$archive_dir/rollback-$base.tar.gz" -C "$baseline"
fi

node - "$baseline" "$app" <<'JS'
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const [baseline,app]=process.argv.slice(2);
function files(root,dir){return fs.readdirSync(path.join(root,dir),{withFileTypes:true}).flatMap(e=>{const name=path.join(dir,e.name);if(e.name.startsWith('.env')||/\.(db|sqlite|sqlite3)(-|$)/.test(e.name))return [];return e.isDirectory()?files(root,name):e.isFile()?[name]:[];});}
const dirs=['src','scripts','prisma'];
const expected=dirs.flatMap(d=>files(baseline,d)).concat(['package.json','package-lock.json','next.config.js','tsconfig.json','.eslintrc.json']);
const current=dirs.flatMap(d=>files(app,d));
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const drift=expected.filter(p=>!fs.existsSync(path.join(app,p))||sha(path.join(baseline,p))!==sha(path.join(app,p))).concat(current.filter(p=>!expected.includes(p)));
if(drift.length)throw Error('Server source drift outside runtime DB files: '+JSON.stringify(drift));
console.log(JSON.stringify({liveSourceMatchesRollbackArchive:true,checkedFiles:expected.length}));
JS

test "$(node -p "require('$release/package.json').version")" = 0.43.3
ln -s "$app/node_modules" "$release/node_modules"
cd "$release"
node docs/materials/2026-10-05-generation-toolbar/source-proof.mjs "$release"
log="/tmp/sd2-generation-toolbar-build-$commit.log"
if ! NEXT_DIST_DIR=.next-prod-candidate npm run build >"$log" 2>&1; then
  tail -n 100 "$log" >&2
  exit 1
fi
test -s .next-prod-candidate/BUILD_ID
node - "$release" "$commit" <<'JS'
const fs=require('fs'),path=require('path');
const [root,commit]=process.argv.slice(2),build=path.join(root,'.next-prod-candidate');
const routes=JSON.parse(fs.readFileSync(path.join(build,'server/app-paths-manifest.json'),'utf8'));
if(!routes['/template-studio/page'])throw Error('Candidate lacks /template-studio/page');
if(!routes['/tools/avatar-studio/page'])throw Error('Candidate lacks /tools/avatar-studio/page');
const manifest=JSON.parse(fs.readFileSync(path.join(build,'app-build-manifest.json'),'utf8'));
const files=manifest.pages['/template-studio/page']||[];
const chunks=files.filter(f=>f.endsWith('.js')).map(file=>({file,content:fs.readFileSync(path.join(build,file),'utf8')}));
const toolbarChunks=chunks.filter(c=>c.content.includes('生成图片'));
const promptChunks=chunks.filter(c=>c.content.includes('补充想生成的画面'));
if(!toolbarChunks.length||!promptChunks.length)throw Error('Target route is missing compiled generation toolbar or prompt text');
console.log(JSON.stringify({route:'/template-studio/page',compiledToolbarChunks:toolbarChunks.map(c=>c.file),compiledPromptChunks:promptChunks.map(c=>c.file)}));
const avatarFiles=manifest.pages['/tools/avatar-studio/page']||[];
const avatarChunks=avatarFiles.filter(f=>f.endsWith('.js')).filter(file=>fs.readFileSync(path.join(build,file),'utf8').includes('生成时按正文理解人物并提交图片'));
if(!avatarChunks.length)throw Error('Avatar route is missing compiled one-click generation change');
const proof={commit,version:require(path.join(root,'package.json')).version,buildId:fs.readFileSync(path.join(build,'BUILD_ID'),'utf8').trim(),route:'/template-studio/page',compiledToolbarChunks:toolbarChunks.map(c=>c.file),compiledPromptChunks:promptChunks.map(c=>c.file),avatarRoute:'/tools/avatar-studio/page',avatarChunks,checkedAt:new Date().toISOString()};
fs.writeFileSync(`/tmp/sd2-generation-toolbar-candidate-${commit}.json`,JSON.stringify(proof,null,2));
JS
printf 'CANDIDATE_BUILD_SUCCESS commit=%s build=%s\n' "$commit" "$(cat .next-prod-candidate/BUILD_ID)"
