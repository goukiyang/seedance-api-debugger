#!/usr/bin/env bash
set -euo pipefail
commit="$1"
short="${commit:0:7}"
base=2c895eef1d5e15e5349f326e68038c76c42c81b8
app=/srv/video-api-debugger/app
release=/srv/video-api-debugger/releases/$commit
baseline=/srv/video-api-debugger/releases/$base-avatar-rollback
stage=$app/.next-prod-candidate-avatar-$short
previous=$app/.next-prod-prev-avatar-$short
drain=$app/storage/image-studio-drain
exec 9>/srv/video-api-debugger/deploy.lock
flock -n 9 || { printf 'Another release holds deploy.lock\n'; exit 75; }
test "$(cat "$app/.deployed-commit")" = "$base"
test -s "$release/.next-prod-candidate/BUILD_ID"
test ! -e "$stage"
test ! -e "$previous"
test ! -e "$drain"
test "$(node -p "require('$release/package.json').version")" = 0.42.2
for link in storage public/uploads public/videos; do test -L "$app/$link"; done
old_build=$(cat "$app/.next-prod/BUILD_ID")
new_build=$(cat "$release/.next-prod-candidate/BUILD_ID")
mkdir "$stage"
rsync -a --chown=gouki:gouki "$release/.next-prod-candidate/" "$stage/"
test "$(cat "$stage/BUILD_ID")" = "$new_build"
excludes=(--exclude='.env*' --exclude='.git' --exclude=node_modules --exclude='.next*' --exclude=storage --exclude=dist --exclude='*.db*' --exclude='*.sqlite*' --exclude=public/uploads --exclude=public/videos --exclude='.deployed-*')
verify_source() {
  node - "$baseline" "$app" <<'JS'
const fs=require('fs'),path=require('path'),crypto=require('crypto');const [baseline,app]=process.argv.slice(2);
function files(root,dir){let out=[];for(const e of fs.readdirSync(path.join(root,dir),{withFileTypes:true})){const p=path.join(dir,e.name);if(e.name.startsWith('.env')||/\.(db|sqlite|sqlite3)(-|$)/.test(e.name))continue;if(e.isDirectory())out.push(...files(root,p));else if(e.isFile())out.push(p);}return out;}
const dirs=['src','scripts','prisma'];const expected=dirs.flatMap(d=>files(baseline,d)).concat(['package.json','package-lock.json','next.config.js','tsconfig.json','.eslintrc.json']);const current=dirs.flatMap(d=>files(app,d));const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const drift=expected.filter(p=>!fs.existsSync(path.join(app,p))||sha(path.join(baseline,p))!==sha(path.join(app,p))).concat(current.filter(p=>!expected.includes(p)));if(drift.length){console.log(JSON.stringify({sourceDrift:drift}));process.exit(76);}console.log(JSON.stringify({switchSourceBaselineMatches:true,checkedFiles:expected.length}));
JS
}
verify_source
source_started=0
switched=0
rollback() {
  code=$?
  trap - ERR INT TERM
  if (( source_started )); then
    printf 'ROLLBACK_START\n'
    systemctl stop sd2-gray.service || true
    rsync -a --delete --chown=gouki:gouki "${excludes[@]}" "$baseline/" "$app/"
    if (( switched )); then
      if test -e "$app/.next-prod"; then mv "$app/.next-prod" "$app/.next-prod-failed-avatar-$short-$(date +%s)"; fi
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
worker_pid=$(systemctl show sd2-image-studio.service -p MainPID --value)
systemctl is-active --quiet sd2-image-studio.service
# The patch whitelist excludes queue/worker code; do not interrupt image tasks.
node - "$baseline" "$release" <<'JS'
const fs=require('fs'),path=require('path'),crypto=require('crypto');const [base,next]=process.argv.slice(2);
const allowed=new Set(['src/lib/release.ts','src/app/tools/avatar-studio/studio.tsx']);
function files(root,d){return fs.readdirSync(path.join(root,d),{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(root,path.join(d,e.name)):[path.join(d,e.name)]);}
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');const all=[...new Set(['src','scripts','prisma'].flatMap(d=>[...files(base,d),...files(next,d)]))];
const changed=all.filter(p=>!fs.existsSync(path.join(base,p))||!fs.existsSync(path.join(next,p))||sha(path.join(base,p))!==sha(path.join(next,p)));
if(changed.some(p=>!allowed.has(p)))throw Error('Patch exceeds web-only source boundary');console.log(JSON.stringify({webOnlyPatch:true,changedSource:changed}));
JS
test "$(cat "$app/.deployed-commit")" = "$base"
test "$(cat "$app/.next-prod/BUILD_ID")" = "$old_build"
verify_source
systemctl stop sd2-gray.service
source_started=1
rsync -a --delete --chown=gouki:gouki "${excludes[@]}" "$release/" "$app/"
for link in storage public/uploads public/videos; do test -L "$app/$link"; done
mv "$app/.next-prod" "$previous"
switched=1
mv "$stage" "$app/.next-prod"
printf '%s\n' "$commit" > "$app/.deployed-commit"
chown gouki:gouki "$app/.deployed-commit"
systemctl start sd2-gray.service
healthy=0
for ((i=0;i<60;i++)); do
  if curl --fail --silent http://127.0.0.1:3302/api/release | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{try{process.exit(JSON.parse(s).version==='0.42.2'?0:1)}catch{process.exit(1)}})"; then healthy=1;break;fi
  sleep 1
done
test "$healthy" = 1
systemctl is-active --quiet sd2-gray.service
test "$(cat "$app/.next-prod/BUILD_ID")" = "$new_build"
test "$(node -p "require('$app/package.json').version")" = 0.42.2
node - "$app" "$commit" "$new_build" <<'JS'
const fs=require('fs'),crypto=require('crypto');const [app,commit,build]=process.argv.slice(2);
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
(async()=>{
  const checks=[];
  for(const pathname of ['/api/release','/api/health','/api/config','/login']){
    const response=await fetch(`https://sd2.youdooart.com${pathname}`,{signal:AbortSignal.timeout(12000),cache:'no-store'});const origin=response.headers.get('x-sd2-origin');
    if(response.status!==200||origin!=='server-42-193')throw Error('Public release check failed: '+pathname+' '+response.status+' '+origin);
    if(pathname==='/api/release'){const release=await response.json();if(release.version!=='0.42.2'||release.channel!=='production')throw Error('Public version differs');}
    else if(pathname==='/api/health'){if(!(await response.json()).ok)throw Error('Public service health failed');}
    else await response.arrayBuffer();
    checks.push({pathname,status:response.status,origin});
  }
  const manifest=JSON.parse(fs.readFileSync(`${app}/.next-prod/app-build-manifest.json`,'utf8'));
  for(const route of ['/tools/avatar-studio/page']){
    const files=manifest.pages[route];if(!files?.length)throw Error('Missing public route assets '+route);
    const pickerFiles=files.filter(f=>f.endsWith('.js')&&fs.readFileSync(`${app}/.next-prod/${f}`,'utf8').includes('免费重检原回复')&&fs.readFileSync(`${app}/.next-prod/${f}`,'utf8').includes('force:'));
    if(!pickerFiles.length)throw Error('Missing avatar refresh chunk '+route);
    for(const file of pickerFiles){
      const response=await fetch(`https://sd2.youdooart.com/_next/${file}`,{signal:AbortSignal.timeout(12000)});const received=Buffer.from(await response.arrayBuffer());const expected=fs.readFileSync(`${app}/.next-prod/${file}`);
      if(response.status!==200||sha(received)!==sha(expected))throw Error('Public avatar refresh static differs '+file);
      checks.push({route,file,status:response.status,sha256:sha(received),matchesCandidate:true});
    }
  }
  const proof={commit,version:'0.42.2',build,checkedAt:new Date().toISOString(),checks};fs.writeFileSync('/tmp/sd2-avatar-paid-refresh-public-proof.json',JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
JS
test "$(systemctl show sd2-image-studio.service -p MainPID --value)" = "$worker_pid"
systemctl is-active --quiet sd2-image-studio.service
trap - ERR INT TERM
printf 'SWITCH_SUCCESS commit=%s build=%s previousBuild=%s rollbackSource=%s rollbackBuild=%s\n' "$commit" "$new_build" "$old_build" "$baseline" "$previous"
