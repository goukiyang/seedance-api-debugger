import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHmac, randomBytes } from 'node:crypto';

// Real signing/session functions, synthetic identities and keys; no network or real database.
const root=fs.realpathSync(process.cwd()), require=createRequire(path.join(root,'package.json')), ts=require('typescript');
const fixture=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'private-session-lifetime-')));
fs.chmodSync(fixture,0o700);
const write=(file,value)=>fs.writeFileSync(file,Buffer.isBuffer(value)?value:JSON.stringify(value),{mode:0o600});
Object.assign(process.env,{NODE_ENV:'test',PRIVATE_PROMPTS_FIXTURE_ROOT:fixture,PRIVATE_PROMPTS_POLICY_FILE:path.join(fixture,'policy.json'),
  PRIVATE_PROMPTS_MIN_STATE:'compatible-read',PRIVATE_PROMPTS_CONSUMER_ID:'fixture',PRIVATE_PROMPTS_RUNTIME_REVISION:'a'.repeat(40),SESSION_SECRET:randomBytes(48).toString('hex')});
const policy={schema:'private-prompt-policy.v1',revision:'fixture-policy',state:'compatible-read',minimumReader:1,
 identities:[{userId:'author',tenant:'tenant',subject:'subject'},{userId:'admin',tenant:'tenant',subject:'admin-subject',administrator:true}],
 origins:[],authorKinds:[{ownerId:'author',kinds:['skill']},{ownerId:'admin',kinds:['skill']}],destinations:[],consumers:['fixture'],
 keys:Object.fromEntries(['body','index','backup'].map(domain=>{const file=path.join(fixture,domain+'.key');write(file,randomBytes(32));return [domain,{active:domain,files:{[domain]:file}}];})),
 activation:{inventoryId:'inventory',restoreId:'restore',writerFenceId:'fence',attestationFile:path.join(fixture,'consumers.json')},
 migrationVerified:{inventoryId:'inventory',restoreId:'restore',remainingPlaintext:0}};
write(process.env.PRIVATE_PROMPTS_POLICY_FILE,policy);
write(policy.activation.attestationFile,{schema:'private-prompt-consumers.v1',policyRevision:policy.revision,...policy.activation,
 consumers:[{id:'fixture',reader:1,permissionContract:1,sourceRevision:'a'.repeat(40)}]});
const accounts=new Map(['author','admin'].map(id=>[id,{id,name:id,username:id,email:id+'@fixture.invalid',password_hash:'synthetic',role:id==='admin'?'admin':'user',account_type:'internal',user_profile:'other',feature_profile_id:null,status:'active',expires_at:null,
 feishu_open_id:id==='admin'?'admin-subject':'subject',feishu_tenant_key:'tenant'}]));
const jar=new Map(), cookieWrites=[], cache=new Map();
const store={get:name=>jar.has(name)?{value:jar.get(name)}:undefined,delete:name=>{jar.delete(name);cookieWrites.push({name,deleted:true});},set(...args){cookieWrites.push(args);}};
function load(relative){
 const file=path.resolve(root,relative);if(cache.has(file))return cache.get(file).exports;
 const mod={exports:{}};cache.set(file,mod);
 const localRequire=id=>{
  if(id==='server-only')return {};
  if(id==='next/headers')return {cookies:async()=>store};
  if(id==='next/server')return {NextResponse:{json:value=>({value})}};
  if(id==='@/lib/prisma')return {prisma:{user:{findUnique:async args=>accounts.get(args.where.id)||null}}};
  if(id.startsWith('@/')||id.startsWith('.')){
   const base=id.startsWith('@/')?path.join(root,'src',id.slice(2)):path.resolve(path.dirname(file),id);
   const found=[base,base+'.ts',base+'.tsx',base+'.js',path.join(base,'index.ts')].find(f=>fs.existsSync(f)&&fs.statSync(f).isFile());
   if(!found)throw Error('Unresolved fixture source: '+id);return load(path.relative(root,found));
  }
  return require(id);
 };
 const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 new Function('require','module','exports','__filename','__dirname','fetch',code)(localRequire,mod,mod.exports,file,path.dirname(file),()=>{throw Error('Network forbidden');});
 return mod.exports;
}
const checks=[], realNow=Date.now, now=Date.UTC(2026,9,30);Date.now=()=>now;
try{
 const identity=load('src/lib/security/private-prompt-identity.server.ts'), session=load('src/lib/auth/session.ts'), cookies=load('src/lib/auth/session-cookie.ts');
 assert.equal(identity.PRIVATE_IDENTITY_SECONDS,7*24*60*60);assert.equal(identity.PRIVATE_IDENTITY_SECONDS,cookies.SESSION_COOKIE_MAX_AGE);
 const token=await session.createSession('author');
 const proof=identity.signVerifiedFeishuIdentity({userId:'author',role:'user',tenant:'tenant',subject:'subject'},token);
 const payload=JSON.parse(Buffer.from(proof.split('.')[0],'base64url').toString());
 assert.equal(payload.expiresAt-payload.issuedAt,cookies.SESSION_COOKIE_MAX_AGE*1000);
 const set=[];cookies.setSessionCookie({cookies:{set:(...args)=>set.push(args)}},token);
 assert.equal(set[0][2].maxAge,identity.PRIVATE_IDENTITY_SECONDS);checks.push('fresh verified proof and ordinary cookie share fixed seven-day lifetime');
 const origins=[{kind:'skill',id:'video-group:new',ownerId:'author'}];
 jar.set('session',token);jar.set(identity.PRIVATE_IDENTITY_COOKIE,proof);
 Date.now=()=>now+9*60*60*1000;
 const user=await session.getSession();assert(user);assert.equal(identity.privatePromptCapabilities(user,origins).canEditPrivatePrompt,true);
 assert.equal(cookieWrites.length,0);checks.push('same signed Feishu session remains usable after eight hours without renewal or new SSO');
 // A correctly signed legacy fixture keeps its original eight-hour deadline.
 const legacyPayload={...payload,expiresAt:now+8*60*60*1000};
 const legacyBody=Buffer.from(JSON.stringify(legacyPayload)).toString('base64url');
 const legacy=legacyBody+'.'+createHmac('sha256',process.env.SESSION_SECRET).update('private-prompt-feishu-proof.v1\0').update(legacyBody).digest('base64url');
 Date.now=()=>now+7*60*60*1000;assert.equal(identity.authenticatePrivateIdentity({id:'author',role:'user'},legacy,token),true);
 Date.now=()=>now+9*60*60*1000;jar.set(identity.PRIVATE_IDENTITY_COOKIE,legacy);
 const legacyUser=await session.getSession();assert(legacyUser);assert.equal(identity.privatePromptCapabilities(legacyUser,origins).canEditPrivatePrompt,false);
 assert.equal(cookieWrites.length,0);checks.push('legacy eight-hour expiry is preserved; expired proof is never renewed');
 jar.delete(identity.PRIVATE_IDENTITY_COOKIE);const ordinary=await session.getSession();assert(ordinary);
 assert.equal(identity.privatePromptCapabilities(ordinary,origins).canEditPrivatePrompt,false);checks.push('ordinary login and database Feishu fields never mint a private identity');
 Date.now=()=>now;const anotherToken=await session.createSession('author');
 assert.equal(identity.authenticatePrivateIdentity({id:'author',role:'user'},proof,anotherToken),false);
 assert.equal(identity.authenticatePrivateIdentity({id:'admin',role:'admin'},proof,token),false);
 assert.equal(identity.authenticatePrivateIdentity({id:'author',role:'user'},proof+'tampered',token),false);
 checks.push('new password/session nonce, account switch and tampered proof are rejected');
 Date.now=()=>payload.expiresAt;assert.equal(identity.authenticatePrivateIdentity({id:'author',role:'user'},proof,token),false);
 Date.now=()=>now-1;assert.equal(identity.authenticatePrivateIdentity({id:'author',role:'user'},proof,token),false);
 checks.push('fixed signed expiry and future-issued proofs remain enforced');
 Date.now=()=>now;const originalIdentities=policy.identities;policy.identities=[];write(process.env.PRIVATE_PROMPTS_POLICY_FILE,policy);
 assert.equal(identity.authenticatePrivateIdentity({id:'author',role:'user'},proof,token),false);
 policy.identities=originalIdentities;write(process.env.PRIVATE_PROMPTS_POLICY_FILE,policy);checks.push('current controlled identity revocation still applies');
 accounts.get('author').status='disabled';jar.set('session',token);jar.set(identity.PRIVATE_IDENTITY_COOKIE,proof);
 assert.equal(await session.getSession(),null);accounts.get('author').status='active';checks.push('disabled account cannot restore an otherwise signed identity');
 const logout=load('src/app/api/auth/logout/route.ts');await logout.POST();
 assert.equal(jar.has('session'),false);assert.equal(jar.has(identity.PRIVATE_IDENTITY_COOKIE),false);assert.equal(await session.getSession(),null);
 checks.push('logout clears ordinary and private cookies together');
 console.log(JSON.stringify({passed:true,checks,productionDatabaseAccess:0,networkRequests:0,realCredentialsRead:0,browserActions:0,businessWrites:0,functionalAcceptance:false},null,2));
}finally{Date.now=realNow;}
