#!/usr/bin/env bash
set -euo pipefail

commit="$1"
base="$2"
old_build="$3"
app=/srv/video-api-debugger/app
release="/srv/video-api-debugger/releases/$commit"
baseline="/srv/video-api-debugger/releases/$base-generation-toolbar-rollback"
short="${commit:0:7}"
stage="$app/.next-prod-candidate-generation-toolbar-$short"
previous="$app/.next-prod-prev-generation-toolbar-$short"
exec 9>/srv/video-api-debugger/deploy.lock
flock -n 9 || { printf 'Another server release holds deploy.lock\n'; exit 75; }
test "$(cat "$app/.deployed-commit")" = "$base"
test "$(cat "$app/.next-prod/BUILD_ID")" = "$old_build"
test -s "$release/.next-prod-candidate/BUILD_ID"
test "$(node -p "require('$release/package.json').version")" = 0.43.3
test "$(node -p "require('$app/package.json').version")" = 0.43.2
test ! -e "$previous"
for link in storage public/uploads public/videos; do test -L "$app/$link"; done

node - "$baseline" "$app" <<'JS'
const fs=require('fs'),path=require('path'),crypto=require('crypto');const [baseline,app]=process.argv.slice(2);
function files(root,dir){return fs.readdirSync(path.join(root,dir),{withFileTypes:true}).flatMap(e=>{const p=path.join(dir,e.name);if(e.name.startsWith('.env')||/\.(db|sqlite|sqlite3)(-|$)/.test(e.name))return [];return e.isDirectory()?files(root,p):e.isFile()?[p]:[];});}
const dirs=['src','scripts','prisma'];const expected=dirs.flatMap(d=>files(baseline,d)).concat(['package.json','package-lock.json','next.config.js','tsconfig.json','.eslintrc.json']);const current=dirs.flatMap(d=>files(app,d));
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');const drift=expected.filter(p=>!fs.existsSync(path.join(app,p))||sha(path.join(baseline,p))!==sha(path.join(app,p))).concat(current.filter(p=>!expected.includes(p)));
if(drift.length)throw Error('Server source drift; refusing switch: '+JSON.stringify(drift));console.log(JSON.stringify({sourceMatchesBase:true,checkedFiles:expected.length}));
JS

node - "$baseline" "$release" <<'JS'
const fs=require('fs'),path=require('path'),crypto=require('crypto');const [base,next]=process.argv.slice(2);
const allowed=new Set(['package.json','src/lib/release.ts','src/app/image-studio/studio.tsx','src/app/tools/avatar-studio/studio.tsx']);
function files(root,dir){return fs.readdirSync(path.join(root,dir),{withFileTypes:true}).flatMap(e=>{const p=path.join(dir,e.name);if(e.name.startsWith('.env')||/\.(db|sqlite|sqlite3)(-|$)/.test(e.name))return [];return e.isDirectory()?files(root,p):e.isFile()?[p]:[];});}
const paths=[...new Set(['src','scripts','prisma'].flatMap(d=>[...files(base,d),...files(next,d)]))].concat(['package.json','package-lock.json','next.config.js','tsconfig.json','.eslintrc.json']);
const sha=p=>fs.existsSync(p)?crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'):null;
const changed=[...new Set(paths)].filter(p=>sha(path.join(base,p))!==sha(path.join(next,p)));
if(changed.some(p=>!allowed.has(p)))throw Error('Release exceeds web-only source boundary: '+JSON.stringify(changed));
console.log(JSON.stringify({webOnlyPatch:true,changedSource:changed}));
JS

cd "$release"
node docs/materials/2026-10-05-generation-toolbar/source-proof.mjs "$release"
new_build=$(cat .next-prod-candidate/BUILD_ID)
if [[ -e "$stage" ]]; then
  test "$(cat "$stage/BUILD_ID")" = "$new_build"
else
  mkdir "$stage"
  rsync -a "$release/.next-prod-candidate/" "$stage/"
fi
if (( EUID == 0 )); then chown -R gouki:gouki "$stage"; fi
test "$(cat "$stage/BUILD_ID")" = "$new_build"

excludes=(--exclude='.env*' --exclude='.git' --exclude=node_modules --exclude='.next*' --exclude=storage --exclude=public/uploads --exclude=public/videos --exclude='*.db*' --exclude='*.sqlite*' --exclude='.deployed-*')
sync_source() {
  if (( EUID == 0 )); then rsync -a --delete --chown=gouki:gouki "${excludes[@]}" "$baseline/" "$app/"; else rsync -a --delete "${excludes[@]}" "$baseline/" "$app/"; fi
}
source_started=0
switched=0
worker_pid=$(systemctl show sd2-image-studio.service -p MainPID --value)
systemctl is-active --quiet sd2-image-studio.service
rollback() {
  code=$?
  trap - ERR INT TERM
  if (( source_started )); then
    printf 'ROLLBACK_START\n'
    systemctl stop sd2-gray.service || true
    sync_source
    if (( switched )); then
      if test -e "$app/.next-prod"; then mv "$app/.next-prod" "$app/.next-prod-failed-generation-toolbar-$short-$(date +%s)"; fi
      mv "$previous" "$app/.next-prod"
    fi
    printf '%s\n' "$base" > "$app/.deployed-commit"
    chown gouki:gouki "$app/.deployed-commit"
    systemctl start sd2-gray.service
    printf 'ROLLBACK_DONE %s %s\n' "$base" "$old_build"
  fi
  exit "$code"
}
trap rollback ERR INT TERM

systemctl stop sd2-gray.service
source_started=1
if (( EUID == 0 )); then rsync -a --delete --chown=gouki:gouki "${excludes[@]}" "$release/" "$app/"; else rsync -a --delete "${excludes[@]}" "$release/" "$app/"; fi
for link in storage public/uploads public/videos; do
  test -L "$app/$link"
  case "$(readlink -f "$app/$link")" in /data/video-api-debugger/var-lib/*) ;; *) exit 76 ;; esac
done
for directory in public/uploads/assets public/uploads/thumbs public/videos/thumbnails storage/backups; do
  runuser -u gouki -- test -d "$app/$directory"
  runuser -u gouki -- test -w "$app/$directory"
done
mv "$app/.next-prod" "$previous"
switched=1
mv "$stage" "$app/.next-prod"
printf '%s\n' "$commit" > "$app/.deployed-commit"
chown gouki:gouki "$app/.deployed-commit"
systemctl start sd2-gray.service

healthy=0
for ((i=0;i<60;i++)); do
  if curl --fail --silent http://127.0.0.1:3302/api/release | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{try{process.exit(JSON.parse(s).version==='0.43.3'?0:1)}catch{process.exit(1)}})"; then healthy=1; break; fi
  sleep 1
done
test "$healthy" = 1
systemctl is-active --quiet sd2-gray.service
test "$(cat "$app/.next-prod/BUILD_ID")" = "$new_build"
test "$(node -p "require('$app/package.json').version")" = 0.43.3
test "$(systemctl show sd2-image-studio.service -p MainPID --value)" = "$worker_pid"
systemctl is-active --quiet sd2-image-studio.service

node - "$app" "$commit" "$new_build" <<'JS'
const fs=require('fs'),path=require('path'),crypto=require('crypto');const [app,commit,build]=process.argv.slice(2),checks=[];
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
(async()=>{
  for(const pathname of ['/api/release','/api/health','/api/config','/login']){
    const response=await fetch(`https://sd2.youdooart.com${pathname}`,{signal:AbortSignal.timeout(12000),cache:'no-store'});
    if(response.status!==200||response.headers.get('x-sd2-origin')!=='server-42-193')throw Error('Public check failed: '+pathname+' '+response.status);
    if(pathname==='/api/release'){const release=await response.json();if(release.version!=='0.43.3'||release.channel!=='production'||release.summary!=='')throw Error('Public release version/channel or anonymous summary boundary mismatch');}
    else if(pathname==='/api/health'){if(!(await response.json()).ok)throw Error('Public health check failed');}
    else await response.arrayBuffer();
    checks.push({pathname,status:response.status,origin:response.headers.get('x-sd2-origin')});
  }
  for(const pathname of ['/template-studio?type=image','/tools/avatar-studio']){
    const route=await fetch(`https://sd2.youdooart.com${pathname}`,{signal:AbortSignal.timeout(12000),cache:'no-store'});
    if(!route.ok)throw Error('Public route not reachable: '+pathname+' '+route.status);
    checks.push({pathname,status:route.status,finalPath:new URL(route.url).pathname,authRedirect:new URL(route.url).pathname==='/login'});
  }
  const buildDir=path.join(app,'.next-prod'),manifest=JSON.parse(fs.readFileSync(path.join(buildDir,'app-build-manifest.json'),'utf8'));
  const files=manifest.pages['/template-studio/page']||[];
  const selected=files.filter(file=>file.endsWith('.js')&&['生成图片','补充想生成的画面'].some(marker=>fs.readFileSync(path.join(buildDir,file),'utf8').includes(marker)));
  if(!selected.some(file=>fs.readFileSync(path.join(buildDir,file),'utf8').includes('生成图片'))||!selected.some(file=>fs.readFileSync(path.join(buildDir,file),'utf8').includes('补充想生成的画面')))throw Error('Candidate route chunks missing generation markers');
  for(const file of [...new Set(selected)]){
    const response=await fetch(`https://sd2.youdooart.com/_next/${file}`,{signal:AbortSignal.timeout(12000),cache:'no-store'}),received=Buffer.from(await response.arrayBuffer()),expected=fs.readFileSync(path.join(buildDir,file));
    if(response.status!==200||sha(received)!==sha(expected))throw Error('Public static chunk differs from candidate: '+file);
    checks.push({route:'/template-studio/page',file,status:response.status,sha256:sha(received),matchesCandidate:true,containsGenerationButton:expected.includes(Buffer.from('生成图片')),containsSupplementPrompt:expected.includes(Buffer.from('补充想生成的画面'))});
  }
  const avatarFiles=(manifest.pages['/tools/avatar-studio/page']||[]).filter(file=>file.endsWith('.js')&&fs.readFileSync(path.join(buildDir,file),'utf8').includes('生成时按正文理解人物并提交图片'));
  if(!avatarFiles.length)throw Error('Avatar compiled one-click change is missing');
  for(const file of avatarFiles){
    const response=await fetch(`https://sd2.youdooart.com/_next/${file}`,{signal:AbortSignal.timeout(12000),cache:'no-store'}),received=Buffer.from(await response.arrayBuffer()),expected=fs.readFileSync(path.join(buildDir,file));
    if(response.status!==200||sha(received)!==sha(expected))throw Error('Public avatar static differs from candidate: '+file);
    checks.push({route:'/tools/avatar-studio/page',file,status:response.status,sha256:sha(received),matchesCandidate:true,containsOneClickChange:true});
  }
  const proof={commit,version:'0.43.3',build,workerPid:'unchanged',checks,checkedAt:new Date().toISOString(),evidenceLimit:'HTTP and static build proof only; no logged-in DOM or visual acceptance'};
  fs.writeFileSync(`/tmp/sd2-generation-toolbar-public-${commit}.json`,JSON.stringify(proof,null,2));
  console.log(JSON.stringify(proof));
})().catch(error=>{console.error(error.message);process.exitCode=1;});
JS

trap - ERR INT TERM
printf 'SWITCH_SUCCESS commit=%s build=%s previousBuild=%s rollbackSource=%s rollbackBuild=%s\n' "$commit" "$new_build" "$old_build" "$baseline" "$previous"
