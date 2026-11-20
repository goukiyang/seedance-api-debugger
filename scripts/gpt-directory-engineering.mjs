import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(path.join(root,'package.json'));
const ts=require('typescript'),{PrismaClient}=require(process.env.GPT_DIRECTORY_PRISMA_CLIENT || '@prisma/client'),{NextRequest,NextResponse}=require('next/server');
export async function createDirectoryFixture() {
  const parent=process.env.GPT_DIRECTORY_QA||'D:/MYDR/cdoex/sd2/.cache/qa/gpt-account-directory-20261118';
  fs.mkdirSync(parent,{recursive:true});
  const database=path.join(parent,'directory-'+randomUUID()+'.db').replaceAll('\\','/');
  const db=new PrismaClient({datasources:{db:{url:'file:'+database}}});
  await db.$executeRawUnsafe('CREATE TABLE "UserPreference" ("id" TEXT NOT NULL PRIMARY KEY, "user_id" TEXT NOT NULL, "key" TEXT NOT NULL, "value_json" TEXT NOT NULL, "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" DATETIME NOT NULL)');
  await db.$executeRawUnsafe('CREATE UNIQUE INDEX "UserPreference_user_id_key_key" ON "UserPreference"("user_id", "key")');
  for (const sql of [
    'CREATE TABLE "BridgeQueuePreset" (id TEXT PRIMARY KEY, owner_id TEXT, name TEXT, items_json TEXT, client_id TEXT, team_id TEXT, copied_from TEXT)',
    'CREATE TABLE "BridgeQueuePresetLike" (id TEXT PRIMARY KEY, preset_id TEXT, user_id TEXT)',
    'CREATE TABLE "OperationLog" (id TEXT PRIMARY KEY, operator_id TEXT, action TEXT, target_type TEXT, target_id TEXT, detail TEXT)',
    'CREATE TABLE "Feedback" (id TEXT PRIMARY KEY, user_id TEXT, content TEXT, image_urls_json TEXT, page_url TEXT, pathname TEXT, user_agent TEXT, admin_note TEXT)',
    'CREATE TABLE "PlatformSetting" (key TEXT PRIMARY KEY, value_json TEXT, updated_by TEXT)',
    'CREATE TABLE "Notification" (id TEXT PRIMARY KEY, type TEXT, target_user_id TEXT, title TEXT, body TEXT, metadata_json TEXT, error_message TEXT)',
    'CREATE TABLE "Asset" (id TEXT PRIMARY KEY, owner_id TEXT, original_url TEXT, hash TEXT, file_size INTEGER)'
  ]) await db.$executeRawUnsafe(sql);
  function load(file,imports) {
    const source=fs.readFileSync(path.join(root,file),'utf8');
    const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
    const module={exports:{}};
    new Function('require','module','exports',compiled)(name=>{if(name in imports)return imports[name];throw Error('Unexpected dependency '+name);},module,module.exports);
    return module.exports;
  }
  const service=load('src/lib/bridge/gpt-directory.ts',{'node:crypto':{randomUUID},'@/lib/prisma':{prisma:db,retrySqliteBusy:async run=>run()}});
  const storage=load('src/lib/bridge/storage-usage.ts',{'@/lib/prisma':{prisma:db},'@/lib/assets/site-url':load('src/lib/assets/site-url.ts',{})});
  const identity={getBridgeUser:async request=>{const id=request.headers.get('x-fixture-session');return id?{id}:null;},isAllowedShellOrigin:origin=>origin==='chrome-extension://nkflamhogbmmfbjjkajhofaejlddjffc'};
  const storageRoutes=load('src/app/api/bridge/storage-usage/route.ts',{'next/server':{NextRequest,NextResponse},'@/lib/bridge/storage-usage':storage,'@/lib/bridge/panel-token':identity});
  const routes=load('src/app/api/bridge/gpt-directory/route.ts',{'next/server':{NextRequest,NextResponse},'@/lib/bridge/gpt-directory':service,'@/lib/bridge/panel-token':{
    getBridgeUser:async request=>{const id=request.headers.get('x-fixture-session');return id?{id}:null;},
    isAllowedShellOrigin:origin=>origin==='chrome-extension://nkflamhogbmmfbjjkajhofaejlddjffc'
  }});
  const server=http.createServer(async(req,res)=>{
    try {
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const request=new NextRequest('http://127.0.0.1'+req.url,{method:req.method,headers:req.headers,...(req.method==='PATCH'?{body:Buffer.concat(chunks)}:{})});
      const response=await (req.url.startsWith('/api/bridge/storage-usage')?storageRoutes:routes)[req.method](request);
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());
    }catch(error){res.writeHead(500);res.end(JSON.stringify({ok:false,error:error.message}));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {service,routes,storage,db,load,url:'http://127.0.0.1:'+server.address().port+'/api/bridge/gpt-directory',storageUrl:'http://127.0.0.1:'+server.address().port+'/api/bridge/storage-usage',database,close:async()=>{await new Promise(resolve=>server.close(resolve));await db.$disconnect();}};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const fixture=await createDirectoryFixture(),scope='a'.repeat(64),project={id:'g-p-one',name:'项目一',color:'rgb(173,123,249)',icon:''};
  const request=async(user,body,version='')=>{
    const response=await fetch(fixture.url+(body?'':'?scope='+scope+'&version='+version),{method:body?'PATCH':'GET',headers:{'X-Fixture-Session':user,'X-SD2-User-ID':user,Origin:'chrome-extension://nkflamhogbmmfbjjkajhofaejlddjffc','Content-Type':'application/json'},...(body?{body:JSON.stringify({scope,...body})}:{})});
    return {status:response.status,data:await response.json()};
  };
  try {
    const saved=await request('alice',{projects:[{base:null,value:project}],conversations:[]});assert.equal(saved.status,200);assert.equal(saved.data.directory.projects.length,1);
    assert.equal((await request('alice',null,saved.data.revision)).data.unchanged,true);assert.equal((await request('bob')).data.unchanged,true);console.log('ok real SQLite private storage, version-only read and different account isolation');
    const version=saved.data.directory.projects[0].version;
    const renamed=await request('alice',{projects:[{base:version,value:{...project,name:'新名称'}}],conversations:[]});
    const stale=await request('alice',{projects:[{base:version,value:{...project,name:'旧设备名称'}}],conversations:[]});assert.equal(stale.data.directory.projects[0].name,'新名称');assert.deepEqual(stale.data.conflicts,['g-p-one']);assert.equal(stale.data.revision,renamed.data.revision);console.log('ok stale device cannot overwrite a newer name');
    for(const value of [{...project,cover:'data:image/png;base64,AQID'},{...project,body:'private prompt'},{...project,icon:'<svg onload=alert(1)>'}])assert.equal((await request('alice',{projects:[{base:version,value}],conversations:[]})).status,400);console.log('ok covers, prompts and executable icon markup are rejected');
    const wrong=await fetch(fixture.url+'?scope='+scope,{headers:{'X-Fixture-Session':'bob','X-SD2-User-ID':'alice'}});assert.equal(wrong.status,409);
    const anonymous=await fetch(fixture.url+'?scope='+scope);assert.equal(anonymous.status,401);
    const forbidden=await fetch(fixture.url,{method:'PATCH',headers:{'X-Fixture-Session':'alice','X-SD2-User-ID':'alice',Origin:'https://attacker.invalid'},body:JSON.stringify({scope,projects:[],conversations:[]})});assert.equal(forbidden.status,403);console.log('ok session switch, missing session and foreign origin stop before directory access');
  } finally {await fixture.close();}
}
