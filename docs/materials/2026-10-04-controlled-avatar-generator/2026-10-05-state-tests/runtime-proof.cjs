const fs=require('fs'),path=require('path'),crypto=require('crypto'),{execFileSync}=require('child_process'),assert=require('assert/strict');
const commit='907a7a2b4d2a16c60206900045170bd4e3fd7cad';
const app='/srv/video-api-debugger/app',release='/srv/video-api-debugger/releases/'+commit;
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function files(root,dir){return fs.readdirSync(path.join(root,dir),{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(root,path.join(dir,e.name)):[path.join(dir,e.name)]);}
const expected=['src','scripts','prisma'].flatMap(d=>files(release,d)).concat(['package.json','package-lock.json','next.config.js','tsconfig.json','.eslintrc.json']);
const drift=expected.filter(p=>!fs.existsSync(path.join(app,p))||sha(path.join(release,p))!==sha(path.join(app,p)));
assert.equal(drift.length,0,'Runtime source differs');
assert.equal(fs.readFileSync(path.join(app,'.deployed-commit'),'utf8').trim(),commit);
const build=fs.readFileSync(path.join(app,'.next-prod/BUILD_ID'),'utf8').trim();
assert.equal(build,fs.readFileSync(path.join(release,'.next-prod-candidate/BUILD_ID'),'utf8').trim());
const services=['sd2-gray.service','sd2-image-studio.service'].map(id=>{
  const raw=execFileSync('systemctl',['show',id,'-p','ActiveState','-p','SubState','-p','MainPID','-p','WorkingDirectory'],{encoding:'utf8'});
  const state=Object.fromEntries(raw.trim().split('\n').map(line=>{const at=line.indexOf('=');return[line.slice(0,at),line.slice(at+1)];}));
  assert.equal(state.ActiveState,'active');assert.equal(state.SubState,'running');return{id,...state};
});
assert.equal(services[1].MainPID,'259902','Worker unexpectedly restarted');
const links=['storage','public/uploads','public/videos'].map(p=>{assert(fs.lstatSync(path.join(app,p)).isSymbolicLink());return{path:p,target:fs.readlinkSync(path.join(app,p))};});
assert(!fs.existsSync(path.join(app,'storage/image-studio-drain')));
const rollback=[
  {version:'0.42.2',source:'/srv/video-api-debugger/releases/ad65015c14b20577b8e19ab77239cd7e10458d7c-avatar-rollback',build:path.join(app,'.next-prod-prev-avatar-907a7a2'),id:'nS8nR1E0dMsv12y2vj6jr'},
  {version:'0.42.1',source:'/srv/video-api-debugger/releases/2c895eef1d5e15e5349f326e68038c76c42c81b8-avatar-rollback',build:path.join(app,'.next-prod-prev-avatar-ad65015'),id:'BaWLKa1vTqBaQDtynG4MU'},
  {version:'0.42.0',source:'/srv/video-api-debugger/releases/82fe2cb8aba5bbda7c4007249b0a6884f813d438-avatar-rollback',build:path.join(app,'.next-prod-prev-avatar-2c895ee'),id:'ZFdnS_3WyEES4aw7_V_vA'},
  {version:'0.41.1',source:'/srv/video-api-debugger/releases/2b1c4cfea7d0eeb9e99e0cf0b712056742c59536-avatar-rollback',build:path.join(app,'.next-prod-prev-avatar-82fe2cb'),id:'TVyNICHldwYntu2SSA7Po'},
  {version:'0.41.0',build:path.join(app,'.next-prod-prev-avatar-2b1c4cf'),id:'HCmFzUDsnr43fQC62KZlg'}
];
for(const r of rollback){assert.equal(fs.readFileSync(path.join(r.build,'BUILD_ID'),'utf8').trim(),r.id);if(r.source){assert(fs.existsSync(r.source));assert.equal(require(path.join(r.source,'package.json')).version,r.version);}}
console.log(JSON.stringify({commit,version:require(path.join(app,'package.json')).version,build,checkedAt:new Date().toISOString(),sourceMatchesCandidate:true,checkedSourceFiles:expected.length,services,workerUnchanged:true,links,drainAbsent:true,rollback},null,2));
