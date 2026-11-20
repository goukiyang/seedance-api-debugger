import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createDirectoryFixture} from './gpt-directory-engineering.mjs';
const require=createRequire(import.meta.url),next=require('next/server');
export async function reviewFixture(){
  const fx=await createDirectoryFixture(),{load,db}=fx,modelInputs=[];
  await db.$executeRawUnsafe('CREATE TABLE "User" (id TEXT PRIMARY KEY,status TEXT,expires_at DATETIME,password_hash TEXT)');
  for(const who of ['review-a','review-b'])await db.$executeRaw`INSERT INTO "User" (id,status,password_hash) VALUES (${who},'active','fixture-only')`;
  const judge={getMuskApiSettings:async()=>({default_model:'isolated-judge'}),isMuskApiReady:()=>true,createMuskChatCompletion:async({messages})=>{
    const m=JSON.parse(messages[1].content[0].text);modelInputs.push(m);
    const decision=m.当前完整稿.includes('乙项已交付')?'pass':'revise',final=m.历轮结果.length===3;
    const v={decision,reason:decision==='pass'?'两个要求都已完成':'缺少乙项',evidence:m.当前完整稿,change:decision==='pass'?'':'请交付乙项'};
    if(final&&decision!=='pass')v.recap={goal:'同时交付甲乙',diagnosis:'反复只修改甲，方向偏离乙',direction:'先完成乙',experiment:'新增乙项说明',check:'核对甲乙各有一句成品'};
    return {content:JSON.stringify(v),model:'isolated-judge'};
  }};
  const q=load('src/lib/bridge/gpt-review.ts',{'node:crypto':crypto,'@/lib/prisma':{prisma:db},'@/lib/integrations/musk':judge,'@/lib/pricing/model-access.server':{assertSupplementaryModelEnabled:async()=>{}}});
  const grant=load('src/lib/bridge/review-oauth.ts',{'node:crypto':crypto,'@/lib/prisma':{prisma:db}});
  const request=load('src/lib/bridge/review-request.ts',{'./gpt-review':q}),image=load('src/lib/bridge/review-tool-image.ts',{'./gpt-review':q});
  const pairing=load('src/lib/bridge/review-pairing.ts',{'node:crypto':crypto,'@/lib/prisma':{prisma:db},'./gpt-review':q});
  const common={'@/lib/bridge/review-pairing':pairing,'next/server':next,'@/lib/bridge/gpt-review':q,'@/lib/bridge/review-request':request,'@/lib/bridge/review-oauth':grant};
  const routes=load('src/app/api/bridge/gpt-reviews/route.ts',{...common,'@/lib/bridge/panel-token':{getBridgeUser:async r=>({id:r.headers.get('x-fixture-user')}),isAllowedShellOrigin:s=>s==='chrome-extension://fixture'}});
  const mcp=load('src/app/api/bridge/review-mcp/route.ts',{...common,'node:crypto':crypto,'@/lib/bridge/review-tool-image':image});
  const oauth=load('src/app/api/bridge/review-connect/[action]/route.ts',{...common,'node:crypto':crypto,'@/lib/auth/session':{getSession:async()=>({id:'review-a',name:'隔离账号'})}});
  async function api(b,{user='review-a',expected=user,scope=b.scope}={}){
    const read=['get','list','status','recaps'].includes(b.op),url=new URL(grant.ISSUER+'/api/bridge/gpt-reviews');
    url.searchParams.set('scope',scope);if(['get','status'].includes(b.op)&&b.id)url.searchParams.set('id',b.id);if(b.op==='status')url.searchParams.set('summary','1');if(b.op==='recaps')url.searchParams.set('recaps','1');
    const req=new next.NextRequest(url,{method:read?'GET':'POST',headers:{'x-fixture-user':user,'x-sd2-user-id':expected,Origin:'chrome-extension://fixture'},...(!read?{body:JSON.stringify(b)}:{})});
    const r=await routes[read?'GET':'POST'](req);return {ok:r.ok,status:r.status,data:await r.json()};
  }
  async function rpc(method,params,token){
    const req=new next.NextRequest(grant.RESOURCE,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
    const r=await mcp.POST(req);return {status:r.status,challenge:r.headers.get('www-authenticate'),...await r.json()};
  }
  async function authorize(user='review-a'){
    const verifier=crypto.randomBytes(32).toString('base64url'),challenge=crypto.createHash('sha256').update(verifier).digest('base64url');
    const params=new URLSearchParams({client_id:grant.CLIENT,resource:grant.RESOURCE,redirect_uri:grant.CALLBACK,response_type:'code',state:'fixture-state',scope:grant.SCOPE,code_challenge:challenge,code_challenge_method:'S256'});
    const code=await grant.grantCode(user,grant.params(params));
    const form=new URLSearchParams({grant_type:'authorization_code',code,client_id:grant.CLIENT,redirect_uri:grant.CALLBACK,resource:grant.RESOURCE,code_verifier:verifier});
    const endpoint=grant.ISSUER+'/api/bridge/review-connect/token';
    const exchange=async f=>oauth.POST(new next.NextRequest(endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:f.toString()}),{params:{action:'token'}});
    const wrong=new URLSearchParams(form);wrong.set('code_verifier',crypto.randomBytes(32).toString('base64url'));assert.ok(!(await exchange(wrong)).ok);
    const answer=await exchange(form);assert.equal(answer.status,200);assert.ok(!(await exchange(form)).ok);
    return (await answer.json()).access_token;
  }
  const submit=(delivery,text,token,session='private-chat-A')=>rpc('tools/call',{name:'submit_revision',arguments:{delivery,text},_meta:{'openai/subject':'fixture-subject-'+session,'openai/session':session}},token);
  const link=(delivery,token,session='private-chat-A')=>rpc('tools/call',{name:'link_review',arguments:{delivery},_meta:{'openai/subject':'fixture-subject-'+session,'openai/session':session}},token);
  return {...fx,modelInputs,q,grant,api,rpc,authorize,submit,link};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const f=await reviewFixture(),scope='a'.repeat(64),base={scope,device:'test-device',cid:'same-conversation',messageId:'original-1',title:'交付甲乙',goal:'成品须含甲乙两项',text:'甲项已交付',images:[]};
  try{
    const init=await f.rpc('initialize',{protocolVersion:'2025-06-18'});assert.equal(init.result.capabilities.tools.constructor,Object);
    const list=await f.rpc('tools/list',{});assert.deepEqual(list.result.tools.map(t=>t.name),['link_review','submit_revision']);
    const token=await f.authorize(),other=await f.authorize('review-b');
    const id=crypto.randomUUID();const post=(op,more={},owner)=>f.api({...base,id,op,...more},owner);
    const first=await post('create');assert.equal(first.data.task.phase,'feedback');assert.equal((await post('create')).data.task.id,id);assert.equal(f.modelInputs.length,1);
    assert.equal((await post('get',{}, {user:'review-b'})).status,404);assert.equal((await post('get',{scope:'b'.repeat(64)})).status,404);
    assert.equal((await post('get',{}, {user:'review-b',expected:'review-a'})).status,409);
    assert.equal((await post('status')).data.task.rounds,undefined);
    const delivery=crypto.randomUUID();assert.equal((await post('claim',{version:first.data.task.version,delivery,cid:'other'})).status,409);
    const claimed=await post('claim',{version:first.data.task.version,delivery});assert.equal(claimed.data.delivery,delivery);
    assert.equal((await post('claim',{version:first.data.task.version,delivery})).data.delivery,delivery);
    const unauth=await f.submit(delivery,'乙项已交付');assert.ok(unauth.result.isError);assert.match(unauth.result._meta['mcp/www_authenticate'][0],/resource_metadata/);
    assert.equal((await f.submit(delivery,'乙项已交付',other)).result.isError,true);
    const ack=await post('ack',{version:claimed.data.task.version,delivery});assert.equal(ack.data.task.phase,'awaiting');
    const paused=await post('pause',{version:ack.data.task.version});assert.equal((await f.submit(delivery,'乙项已交付',token)).result.isError,true);
    await post('resume',{version:paused.data.task.version});
    const secondChat=await f.link(delivery,token,'wrong-chat');assert.ok(secondChat.result._meta.sd2ReviewProof);
    assert.ok((await f.submit(delivery,'乙项已交付',token,'wrong-chat')).result.isError);
    const pair=await f.link(delivery,token);assert.ok(!JSON.stringify(pair.result.content).includes(pair.result._meta.sd2ReviewProof.nonce));
    assert.equal((await post('confirm',{...pair.result._meta.sd2ReviewProof,cid:'somewhere-else'})).status,409);
    assert.ok((await post('confirm',pair.result._meta.sd2ReviewProof)).ok);
    assert.ok((await f.submit(delivery,'乙项已交付',token,'wrong-chat')).result.isError);
    const ok=await f.submit(delivery,'甲项已交付。乙项已交付。',token);assert.equal(ok.result.structuredContent.status,'pass');
    await f.submit(delivery,'甲项已交付。乙项已交付。',token);assert.equal(f.modelInputs.length,2);
    assert.equal((await f.submit(delivery,'甲项已交付。乙项已交付。',token,'other-chat')).result.isError,true);
    const row=(await post('get')).data.task;assert.deepEqual(row.rounds.map(r=>r.result.decision),['revise','pass']);assert.equal(row.changes,1);
    const id2=crypto.randomUUID(),key2=crypto.randomUUID();const two=await post('create',{id:id2,messageId:'original-2'});await post('claim',{id:id2,version:two.data.task.version,delivery:key2});
    const proof2=(await f.link(key2,token)).result._meta.sd2ReviewProof;assert.ok((await post('confirm',{...proof2,id:id2})).ok);
    let ticket=key2,previous;
    for(let n=1;n<=3;n++){const receipt=ticket,r=await f.submit(ticket,'甲项尝试 '+n,token);const v=r.result.structuredContent;assert.equal(v.changes,n);assert.equal(v.status,n<3?'revise':'stop');
      if(n===1){previous=receipt;assert.equal((await f.submit(receipt,'甲项尝试 1',token,'wrong')).result.isError,true);}
      if(n===2){const old=await f.submit(previous,'甲项尝试 1',token);assert.equal(old.result.structuredContent.delivery,undefined);}
      ticket=v.delivery;if(n===3)assert.ok(v.review.recap.check);}
    const recap=(await post('get',{id:id2})).data.task;assert.equal(recap.phase,'retrospective');assert.equal(recap.rounds.length,4);
    assert.equal((await post('recaps')).data.rows[0].id,id2);assert.equal((await post('list')).data.total,2);
    assert.ok((await f.storage.readBridgeStorageUsage('review-a')).categories.find(r=>r.kind==='reviews').bytes>0);
    assert.throws(()=>f.q.parseVerdict('这版应该可以了',false));assert.throws(()=>f.q.parseVerdict('{"decision":"revise","reason":"x","evidence":"x","change":"x"}',true));
    console.log('PASS scoped create / one record / judge / feedback / actual changed draft / pass; real SQLite; simulated model');
    console.log('PASS two owners and workspaces with equal CID, other chat callback, pause/replay, three revisions and retrospective, storage projection, OAuth PKCE single use');
  }finally{await f.close();}
}
