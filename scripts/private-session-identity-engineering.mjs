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
const db={user:{
 findUnique:async args=>accounts.get(args.where.id)||[...accounts.values()].find(user=>user.email===args.where.email)||null,
 findFirst:async args=>[...accounts.values()].find(user=>args.where.OR.some(condition=>Object.entries(condition).every(([key,value])=>user[key]===value)))||null,
 findMany:async args=>[...accounts.values()].filter(user=>args.where.OR.some(condition=>Object.entries(condition).every(([key,value])=>user[key]===value))).slice(0,args.take),
 update:async args=>{Object.assign(accounts.get(args.where.id),args.data);return {...accounts.get(args.where.id)};},
 updateMany:async args=>{const user=accounts.get(args.where.id);if(!user||user.password_hash!==args.where.password_hash||user.status!==args.where.status)return {count:0};Object.assign(user,args.data);return {count:1};}
},operationLog:{create:async()=>({})},$transaction:async action=>action(db)};
let transportCalls=0, rejectExchange=false;
async function fixtureTransport(url){
 transportCalls++;const endpoint=new URL(url);
 assert.equal(endpoint.hostname,'feishu.fixture.invalid');
 if(endpoint.pathname.endsWith('/oauth/token'))return Response.json(rejectExchange?{code:1}:{data:{access_token:'synthetic-access-token'}});
 if(endpoint.pathname.endsWith('/user_info'))return Response.json({data:{open_id:'subject',tenant_key:'tenant',name:'author'}});
 if(endpoint.pathname.endsWith('/tenant_access_token/internal'))return Response.json({tenant_access_token:'synthetic-tenant-token'});
 if(endpoint.pathname.startsWith('/open-apis/contact/v3/users/'))return Response.json({data:{user:{open_id:'subject',name:'author'}}});
 throw Error('Unexpected synthetic transport');
}
const jar=new Map(), cookieWrites=[], cache=new Map();
const store={get:name=>jar.has(name)?{value:jar.get(name)}:undefined,delete:name=>{jar.delete(name);cookieWrites.push({name,deleted:true});},set(...args){cookieWrites.push(args);}};
function load(relative){
 const file=path.resolve(root,relative);if(cache.has(file))return cache.get(file).exports;
 const mod={exports:{}};cache.set(file,mod);
 const localRequire=id=>{
  if(id==='server-only')return {};
  if(id==='next/headers')return {cookies:async()=>store};
  if(id==='@/lib/prisma')return {prisma:db};
  if(id==='@/lib/credits/policy')return {grantInitialCredits:()=>{throw Error('No account creation allowed');}};
  if(id==='@/lib/users/profiles')return {getDefaultFeatureProfileId:()=>null,INTERNAL_EMAIL_FEATURE_PROFILE_ID:'internal_email_authorized'};
  if(id.startsWith('@/')||id.startsWith('.')){
   const base=id.startsWith('@/')?path.join(root,'src',id.slice(2)):path.resolve(path.dirname(file),id);
   const found=[base,base+'.ts',base+'.tsx',base+'.js',path.join(base,'index.ts')].find(f=>fs.existsSync(f)&&fs.statSync(f).isFile());
   if(!found)throw Error('Unresolved fixture source: '+id);return load(path.relative(root,found));
  }
  return require(id);
 };
 const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 new Function('require','module','exports','__filename','__dirname','fetch',code)(localRequire,mod,mod.exports,file,path.dirname(file),fixtureTransport);
 return mod.exports;
}
const checks=[], readerOnly=process.argv.includes('--reader-compat'), realNow=Date.now, now=Date.UTC(2026,9,30);Date.now=()=>now;
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
 Object.assign(process.env,{FEISHU_LOGIN_ENABLED:'true',FEISHU_APP_ID:'fixture-app',FEISHU_APP_SECRET:'fixture-secret',
  FEISHU_REDIRECT_URI:'https://site.fixture.invalid/api/auth/feishu/callback',FEISHU_OPENAPI_BASE_URL:'https://feishu.fixture.invalid',
  FEISHU_ALLOWED_TENANT_KEY:'',FEISHU_ALLOWED_DEPARTMENT_IDS:'',NEXT_PUBLIC_BASE_URL:'https://site.fixture.invalid'});
 const feishu=load('src/lib/auth/feishu.ts');
 const readPrimary=async value=>{jar.clear();jar.set('session',value);return session.getSession();};
 const canEdit=value=>identity.privatePromptCapabilities(value,origins).canEditPrivatePrompt;
 const oauth=readerOnly?{token:session.bindVerifiedFeishuSession(await session.createSession('author'),{tenant:'tenant',subject:'subject'})}:await feishu.loginWithFeishuCode('synthetic-code');
 assert.equal(canEdit(await readPrimary(oauth.token)),true);
 assert.equal(canEdit(await session.getSessionByToken(oauth.token)),true);
 assert.equal(jar.has(identity.PRIVATE_IDENTITY_COOKIE),false);
 checks.push(readerOnly?'recovery reader accepts a signed primary-only OAuth session with private capability':'actual OAuth code exchange path returns a primary-only session with private capability');
 Date.now=()=>now+9*60*60*1000;assert.equal(canEdit(await readPrimary(oauth.token)),true);Date.now=()=>now;
 checks.push('primary-only OAuth session restores after eight hours without reauthorization or cookie writes');
 if(!readerOnly){
 const byCode=load('src/app/api/auth/feishu/login-by-code/route.ts');
 const codeResponse=await byCode.POST({url:'https://site.fixture.invalid/api/auth/feishu/login-by-code',json:async()=>({code:'synthetic-code'})});
 assert.equal(codeResponse.status,200);assert.equal(canEdit(await readPrimary(codeResponse.cookies.get('session').value)),true);
 assert.equal(codeResponse.cookies.get(identity.PRIVATE_IDENTITY_COOKIE).value,'');
 const state=feishu.createFeishuOAuthState('/generate'), callback=load('src/app/api/auth/feishu/callback/route.ts');
 const callbackUrl=new URL('https://site.fixture.invalid/api/auth/feishu/callback');callbackUrl.searchParams.set('code','synthetic-code');callbackUrl.searchParams.set('state',state.state);
 const callbackResponse=await callback.GET({url:callbackUrl.href,nextUrl:callbackUrl,cookies:{get:name=>name===feishu.FEISHU_STATE_COOKIE?{value:state.cookieValue}:undefined}});
 assert.equal(callbackResponse.status,303);assert.equal(canEdit(await readPrimary(callbackResponse.cookies.get('session').value)),true);
 assert.equal(callbackResponse.cookies.get(identity.PRIVATE_IDENTITY_COOKIE).value,'');
 checks.push('both actual OAuth routes set the same trusted primary session; no second identity cookie is needed');
 const plainProfile={openId:'subject',tenantKey:'tenant',userId:null,unionId:null,employeeNo:null,name:'author',enName:null,avatarUrl:null,mobile:null,email:null,departmentIds:[],raw:{}};
 const cli=await feishu.loginWithFeishuProfile(plainProfile);assert.equal(canEdit(await readPrimary(cli.token)),false);
 const password=load('src/lib/auth/password.ts');accounts.get('author').password_hash=password.hashPassword('offline-fixture');
 const passwordLogin=await session.login('author','offline-fixture');assert(!('error' in passwordLogin));assert.equal(canEdit(await readPrimary(passwordLogin.token)),false);
 checks.push('actual password and CLI profile login paths never acquire OAuth provenance from stored Feishu fields');
 rejectExchange=true;await assert.rejects(feishu.loginWithFeishuCode('synthetic-rejected-code'));rejectExchange=false;
 checks.push('rejected OAuth code exchange cannot create a verified site session');
 }
 const decoded=Buffer.from(oauth.token.split('.')[0],'base64').toString('utf8').split('~');
 const provenance=JSON.parse(Buffer.from(decoded[2],'base64url').toString('utf8'));
 const signPayload=parts=>{const body=Buffer.from(parts.join('~')).toString('base64');return body+'.'+createHmac('sha256',process.env.SESSION_SECRET).update(body).digest('base64');};
 assert.equal(await session.getSessionByToken(oauth.token+'x'),null);
 const changedBody=Buffer.from(Buffer.from(oauth.token.split('.')[0],'base64').toString('utf8').replace('author','admin')).toString('base64');
 assert.equal(await session.getSessionByToken(changedBody+'.'+oauth.token.split('.')[1]),null);
 for(const changed of [{...provenance,source:'cli'},{...provenance,expiresAt:provenance.expiresAt+1},{...provenance,issuedAt:now+1},{...provenance,unexpected:true}]){
  assert.equal(await session.getSessionByToken(signPayload([decoded[0],decoded[1],Buffer.from(JSON.stringify(changed)).toString('base64url')])),null);
 }
 Date.now=()=>provenance.expiresAt;assert.equal(await session.getSessionByToken(oauth.token),null);Date.now=()=>now;
 checks.push('signed source shape, tampering, account substitution and fixed seven-day expiry are enforced');
 const oldTenant=accounts.get('author').feishu_tenant_key;accounts.get('author').feishu_tenant_key=null;
 const noBinding=identity.privatePromptCapabilities(await readPrimary(oauth.token),origins);
 assert.equal(noBinding.canEditPrivatePrompt,false);assert.equal(noBinding.requiresIdentityVerification,false);assert(noBinding.identityReason);
 accounts.get('author').feishu_tenant_key=oldTenant;
 const originalSecret=process.env.SESSION_SECRET;process.env.SESSION_SECRET='weak';
 const unavailable=identity.privatePromptCapabilities(await readPrimary(oauth.token),origins);
 assert.equal(unavailable.canEditPrivatePrompt,false);assert.equal(unavailable.requiresIdentityVerification,false);assert(unavailable.identityReason);
 process.env.SESSION_SECRET=originalSecret;
 checks.push('verified OAuth source with unavailable binding or identity signer gives a permission reason, never another login loop');
 policy.identities[0].subject='changed-subject';write(process.env.PRIVATE_PROMPTS_POLICY_FILE,policy);
 const mismatchUser=await readPrimary(oauth.token), mismatch=identity.privatePromptCapabilities(mismatchUser,origins);
 assert.equal(mismatch.canEditPrivatePrompt,false);assert.equal(mismatch.requiresIdentityVerification,false);assert.match(mismatch.identityReason,/不匹配/);
 assert.throws(()=>identity.requirePrivatePromptIdentity(mismatchUser,origins),error=>error.code==='PRIVATE_PROMPT_PERMISSION_REQUIRED');
 policy.identities[0].subject='subject';write(process.env.PRIVATE_PROMPTS_POLICY_FILE,policy);
 checks.push('current controlled identity mismatch revokes capability and reports the real permission cause');
 const savedIdentities=policy.identities,savedKinds=policy.authorKinds,savedOrigins=policy.origins;
 policy.identities=policy.identities.filter(value=>value.userId!=='author');policy.authorKinds=policy.authorKinds.filter(value=>value.ownerId!=='author');policy.origins=[origins[0]];
 write(process.env.PRIVATE_PROMPTS_POLICY_FILE,policy);
 const unregistered=identity.privatePromptCapabilities(await readPrimary(oauth.token),origins);
 assert.equal(unregistered.requiresIdentityVerification,false);assert.equal(unregistered.canEditPrivatePrompt,false);assert.match(unregistered.identityReason,/未开通/);
 policy.identities=savedIdentities;policy.authorKinds=savedKinds;policy.origins=savedOrigins;write(process.env.PRIVATE_PROMPTS_POLICY_FILE,policy);
 checks.push('an identity absent from controlled policy is not invited to repeat an ineffective verification');
 const originalPolicyFile=process.env.PRIVATE_PROMPTS_POLICY_FILE;process.env.PRIVATE_PROMPTS_POLICY_FILE=path.join(fixture,'missing-policy.json');
 const noPolicy=readerOnly?{token:session.bindVerifiedFeishuSession(await session.createSession('author'),{tenant:'tenant',subject:'subject'})}:await feishu.loginWithFeishuCode('synthetic-code');assert(await readPrimary(noPolicy.token));
 process.env.PRIVATE_PROMPTS_POLICY_FILE=originalPolicyFile;
 assert.equal(canEdit(await readPrimary(noPolicy.token)),true);
 checks.push('signed OAuth provenance survives unavailable private policy and is authorized afresh when policy is available');
 const binding=load('src/lib/auth/session-account-binding.ts'),savedAccount={...accounts.get('author')};
 const granted={...savedAccount,feature_profile_id:'internal_email_authorized'};granted.password_hash=binding.maintainAccountSessionBinding(savedAccount,granted,load('src/lib/auth/password.ts').hashPassword('bound-offline-fixture'));
 accounts.set('author',granted);
 const tracked=session.bindVerifiedFeishuSession(await session.createSession('author'),{tenant:'tenant',subject:'subject'});
 assert.equal(canEdit(await readPrimary(tracked)),true);granted.role='admin';assert.equal(await session.getSessionByToken(tracked),null);accounts.set('author',savedAccount);
 checks.push('account-bound role and permission changes still invalidate signed OAuth sessions');
 accounts.get('author').status='disabled';jar.set('session',token);jar.set(identity.PRIVATE_IDENTITY_COOKIE,proof);
 assert.equal(await session.getSession(),null);accounts.get('author').status='active';checks.push('disabled account cannot restore an otherwise signed identity');
 const logout=load('src/app/api/auth/logout/route.ts');await logout.POST();
 assert.equal(jar.has('session'),false);assert.equal(jar.has(identity.PRIVATE_IDENTITY_COOKIE),false);assert.equal(await session.getSession(),null);
 checks.push('logout clears ordinary and private cookies together');
 console.log(JSON.stringify({passed:true,readerCompatibilityOnly:readerOnly,checks,syntheticTransportCalls:transportCalls,productionDatabaseAccess:0,networkRequests:0,realCredentialsRead:0,browserActions:0,businessWrites:0,functionalAcceptance:false},null,2));
}finally{Date.now=realNow;}
