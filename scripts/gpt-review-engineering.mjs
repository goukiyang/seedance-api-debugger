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
  const privacy=load('src/lib/security/private-prompts.server.ts',{'server-only':{},'node:fs':require('node:fs'),'node:crypto':crypto,'node:path':path,'../image-studio/process-provenance':{}});
  const auth=load('src/lib/auth/session.ts',{'crypto':crypto,'next/headers':{},'@/lib/prisma':{prisma:db},'./password':{},'./session-account-binding':{},'@/lib/security/private-prompt-identity.server':{}});
  const control={failure:null,fallbackFailure:null,catalog:['gpt-fixture-fallback'],allowedModels:[],approved:new Set(['gpt-fixture-default','gpt-fixture-fallback']),disabled:new Set(),defaultGate:null,onDefault:null,artVerdict:null},modelCalls=[];
  const musk=load('src/lib/integrations/musk.ts',{'node:timers/promises':{},'@/lib/prisma':{prisma:db},'@/lib/security/private-credentials.server':{},'@/lib/security/private-prompts.server':privacy,'@/lib/security/private-prompt-send.server':{privateCredentialSendOrigins:()=>[{}],assertPrivateSend:({model})=>{if(!control.approved.has(model))throw new privacy.PrivatePromptError();}}});
  const localPrivacy={...privacy,privatePromptPolicy:()=>({destinations:[{provider:'musk',models:control.catalog}]})};
  const judge={MuskApiError:musk.MuskApiError,getMuskApiSettings:async()=>({enabled:true,base_url:'https://fixture.invalid/',api_key:'fixture-only',default_model:'gpt-fixture-default',allowed_models:control.allowedModels}),isMuskApiReady:()=>true,resolveMuskChatModels:musk.resolveMuskChatModels,createMuskChatCompletion:async({messages,model})=>{
    modelCalls.push(model);
    if(model==='gpt-fixture-default'&&control.defaultGate){control.onDefault();await control.defaultGate;}
    const failure=model==='gpt-fixture-default'?control.failure:control.fallbackFailure;
    if(failure)throw failure;

    const m=JSON.parse(messages[1].content[0].text);modelInputs.push(m);
    if(m.前置分析!==undefined){const v=control.artVerdict||{decision:'revise',reason:'画面仍有设施堆砌',evidence:'中央地形尚未连接',change:'让中央地形连成整体，保留人物造型',actualImage:true,better:false};return {content:JSON.stringify(v),model};}
    const decision=m.当前完整稿.includes('乙项已交付')?'pass':'revise',final=m.历轮结果.length===3;
    const v={decision,reason:decision==='pass'?'两个要求都已完成':'缺少乙项',evidence:m.当前完整稿,change:decision==='pass'?'':'请交付乙项'};
    if(final&&decision!=='pass')v.recap={goal:'同时交付甲乙',diagnosis:'反复只修改甲，方向偏离乙',direction:'先完成乙',experiment:'新增乙项说明',check:'核对甲乙各有一句成品'};
    return {content:JSON.stringify(v),model};
  }};
  const artImage=load('src/lib/bridge/gpt-art-image.ts',{'node:crypto':crypto,sharp:require('sharp')});
  const q=load('src/lib/bridge/gpt-review.ts',{'node:crypto':crypto,'./gpt-art-image':artImage,'@/lib/prisma':{prisma:db},'@/lib/auth/session':auth,'@/lib/security/private-prompts.server':localPrivacy,'@/lib/integrations/musk':judge,'@/lib/pricing/model-access.server':{assertSupplementaryModelEnabled:async(_kind,model)=>{if(control.disabled.has(model))throw new auth.AuthError('该模型已在费率页关闭',403);}}});
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
  async function authorize(user='review-a',redirect=grant.CALLBACK){
    const verifier=crypto.randomBytes(32).toString('base64url'),challenge=crypto.createHash('sha256').update(verifier).digest('base64url');
    const params=new URLSearchParams({client_id:grant.CLIENT,resource:grant.RESOURCE,redirect_uri:redirect,response_type:'code',state:'fixture-state',scope:grant.SCOPE,code_challenge:challenge,code_challenge_method:'S256'});
    for(const invalid of ['https://example.com/callback',redirect+'?extra=1',redirect+'/', 'https://chatgpt.com/connector/oauth/*']){
      const bad=new URLSearchParams(params);bad.set('redirect_uri',invalid);assert.throws(()=>grant.params(bad),grant.GrantError);
    }
    const duplicate=new URLSearchParams(params);duplicate.append('redirect_uri',redirect);assert.throws(()=>grant.params(duplicate),grant.GrantError);
    let code;
    if(user==='review-a'){
      const endpoint=grant.ISSUER+'/api/bridge/review-connect/authorize?'+params;
      const consent=await oauth.GET(new next.NextRequest(endpoint),{params:{action:'authorize'}});assert.equal(consent.status,200);
      assert.ok(consent.headers.get('content-security-policy').includes(redirect));
      assert.equal(consent.headers.get('referrer-policy'),'strict-origin');
      const nonce=(await consent.text()).match(/name="nonce" value="([^"]+)"/)[1];
      for(const origin of [undefined,'null','https://attacker.invalid',grant.ISSUER+'.attacker.invalid']){
        const denied=await oauth.POST(new next.NextRequest(endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',...(origin?{Origin:origin}:{}),Cookie:consent.headers.get('set-cookie').split(';')[0]},body:new URLSearchParams({nonce,choice:'allow'}).toString()}),{params:{action:'authorize'}});
        assert.equal(denied.status,403);
      }
      const allowed=await oauth.POST(new next.NextRequest(endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Origin:grant.ISSUER,Cookie:consent.headers.get('set-cookie').split(';')[0]},body:new URLSearchParams({nonce,choice:'allow'}).toString()}),{params:{action:'authorize'}});
      assert.equal(allowed.status,303);const location=new URL(allowed.headers.get('location'));
      assert.equal(location.origin+location.pathname,redirect);assert.equal(location.searchParams.get('state'),'fixture-state');assert.equal(location.searchParams.get('iss'),grant.ISSUER);
      code=location.searchParams.get('code');assert.ok(code);
    }else code=await grant.grantCode(user,grant.params(params));
    const form=new URLSearchParams({grant_type:'authorization_code',code,client_id:grant.CLIENT,redirect_uri:redirect,resource:grant.RESOURCE,code_verifier:verifier});
    const endpoint=grant.ISSUER+'/api/bridge/review-connect/token';
    const exchange=async f=>oauth.POST(new next.NextRequest(endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:f.toString()}),{params:{action:'token'}});
    const wrong=new URLSearchParams(form);wrong.set('code_verifier',crypto.randomBytes(32).toString('base64url'));assert.ok(!(await exchange(wrong)).ok);
    for(const invalid of [redirect===grant.CALLBACK?grant.CHATGPT_CALLBACK:grant.CALLBACK,'https://example.com/callback',redirect+'?extra=1','https://chatgpt.com/connector/oauth/*']){
      const bad=new URLSearchParams(form);bad.set('redirect_uri',invalid);assert.ok(!(await exchange(bad)).ok);
    }
    const duplicateToken=new URLSearchParams(form);duplicateToken.append('redirect_uri',redirect);assert.ok(!(await exchange(duplicateToken)).ok);
    const answer=await exchange(form);assert.equal(answer.status,200);assert.ok(!(await exchange(form)).ok);
    return (await answer.json()).access_token;
  }
  const submit=(delivery,text,token,session='private-chat-A')=>rpc('tools/call',{name:'submit_revision',arguments:{delivery,text},_meta:{'openai/subject':'fixture-subject-'+session,'openai/session':session}},token);
  const link=(delivery,token,session='private-chat-A')=>rpc('tools/call',{name:'link_review',arguments:{delivery},_meta:{'openai/subject':'fixture-subject-'+session,'openai/session':session}},token);
  return {...fx,modelInputs,modelCalls,control,musk,auth,privacy,q,grant,pairing,api,rpc,authorize,submit,link};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const f=await reviewFixture(),scope='a'.repeat(64),base={scope,device:'test-device',cid:'same-conversation',messageId:'original-1',title:'交付甲乙',goal:'成品须含甲乙两项',text:'甲项已交付',images:[]};
  try{
    const init=await f.rpc('initialize',{protocolVersion:'2025-06-18'});assert.equal(init.result.capabilities.tools.constructor,Object);
    const list=await f.rpc('tools/list',{});assert.deepEqual(list.result.tools.map(t=>t.name),['link_review','submit_revision']);
    await f.authorize();
    const token=await f.authorize('review-a',f.grant.CHATGPT_CALLBACK),other=await f.authorize('review-b');
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
    const waitingOtherChat=(await f.submit(delivery,'乙项已交付',token,'wrong-chat')).result;
    assert.equal(waitingOtherChat.structuredContent.status,'pending');
    assert.equal((await f.q.getTask('review-a',scope,id)).task.connected,undefined,'a pending link never authorizes another chat');
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
    for(const outcome of ['revise','pass','paused','resumed']){
      const pendingId=crypto.randomUUID(),pendingDelivery=crypto.randomUUID();
      const created=await post('create',{id:pendingId,messageId:'inflight-'+outcome});
      const sent=await post('claim',{id:pendingId,version:created.data.task.version,delivery:pendingDelivery});
      assert.ok((await post('ack',{id:pendingId,version:sent.data.task.version,delivery:pendingDelivery})).ok);
      const proof=(await f.link(pendingDelivery,token)).result._meta.sd2ReviewProof;
      assert.ok((await post('confirm',{...proof,id:pendingId})).ok);
      let entered,release;
      const inJudge=new Promise(resolve=>{entered=resolve;});
      f.control.defaultGate=new Promise(resolve=>{release=resolve;});f.control.onDefault=entered;
      const text=outcome==='pass'?'甲项已交付。乙项已交付。':'甲项已修订',calls=f.modelCalls.length;
      const original=f.submit(pendingDelivery,text,token);
      try{
        await inJudge;
        const judging=(await f.q.getTask('review-a',scope,pendingId)).task;assert.equal(judging.phase,'judging');
        const repeated=(await f.submit(pendingDelivery,text,token)).result.structuredContent;
        assert.equal(repeated.status,'pending');assert.equal(repeated.delivery,pendingDelivery);
        assert.equal(f.modelCalls.length,calls+1);assert.equal(judging.rounds.length,2);
        assert.ok((await f.submit(pendingDelivery,text+' changed',token)).result.isError,'same ticket cannot replace its accepted revision');
        assert.ok((await f.submit(pendingDelivery,text,token,'other-chat')).result.isError);
        if(outcome==='paused'||outcome==='resumed'){
          const paused=await post('pause',{id:pendingId,version:judging.version});assert.ok(paused.ok);
          if(outcome==='resumed')assert.ok((await post('resume',{id:pendingId,version:paused.data.task.version})).ok);
        }
        release();
        const result=(await original).result.structuredContent;
        assert.equal(result.status,outcome==='paused'?'stop':outcome==='resumed'?'pending':outcome);
        if(outcome==='revise')assert.notEqual(result.delivery,pendingDelivery);
        const final=(await f.q.getTask('review-a',scope,pendingId)).task;
        assert.equal(final.rounds.length,2);assert.equal(final.phase,outcome==='paused'?'paused':outcome==='resumed'?'ready':outcome==='pass'?'passed':'awaiting');
        assert.equal(f.modelCalls.length,calls+1);
        if(outcome==='resumed'){
          assert.equal(result.delivery,pendingDelivery);assert.equal(final.rounds.at(-1).result,undefined,'late pre-pause verdict cannot be adopted after resume');
          f.control.defaultGate=null;
          const continued=(await f.submit(pendingDelivery,text,token)).result.structuredContent;
          assert.equal(continued.status,'revise');assert.equal(continued.changes,1);assert.equal(f.modelCalls.length,calls+2);
        }
      }finally{release();f.control.defaultGate=null;f.control.onDefault=null;await original;}
    }
    console.log('PASS text in-flight same-ticket replay stays pending; one judge and revision; final revise/pass and pause remain authoritative');
    async function boundText(name){
      const id=crypto.randomUUID(),delivery=crypto.randomUUID();
      const created=await post('create',{id,messageId:name});
      const sent=await post('claim',{id,version:created.data.task.version,delivery});
      assert.ok((await post('ack',{id,version:sent.data.task.version,delivery})).ok);
      const proof=(await f.link(delivery,token)).result._meta.sd2ReviewProof;
      assert.ok((await post('confirm',{...proof,id})).ok);
      return {id,delivery,saved:await f.q.getTask('review-a',scope,id)};
    }
    {
      const name='executor-completed-without-return',n=await boundText(name),calls=f.modelCalls.length;
      const stop={id:n.id,version:n.saved.task.version,messageId:name,delivery:n.delivery,code:'result_missing',excerpt:'原对话已结束，但没有交回本轮产物。'};
      for(const bad of [{device:'another-device'},{cid:'another-cid'},{messageId:'another-source'},{delivery:crypto.randomUUID()}])assert.equal((await post('execution-stop',{...stop,...bad})).status,409);
      const halted=await post('execution-stop',stop);assert.ok(halted.ok,halted.data.error);assert.equal(halted.data.task.phase,'input');assert.equal(halted.data.task.executionStop.code,'result_missing');
      const full=(await f.q.getTask('review-a',scope,n.id)).task;assert.equal(full.rounds.length,1);assert.equal(full.rounds[0].result.decision,'revise');assert.equal(f.modelCalls.length,calls);
      const current=(await f.api({...base,op:'status',id:n.id})).data.task;assert.equal(current.executionStop.code,'result_missing');
      const listing=(await f.api({...base,op:'list'})).data.rows.find(r=>r.id===n.id);assert.equal(listing.executionStop.code,'result_missing');
      assert.equal((await post('retry',{id:n.id,version:full.version})).status,409);assert.equal((await post('resume',{id:n.id,version:full.version})).status,409);
      const late=await f.submit(n.delivery,'甲项已交付。\n乙项已交付。',token);assert.ok(late.result.isError||late.result.structuredContent?.status==='stop');assert.equal((await f.q.getTask('review-a',scope,n.id)).task.rounds.length,1);
      const paused=await boundText('executor-pause-wins'),p=await post('pause',{id:paused.id,version:paused.saved.task.version});assert.ok(p.ok);
      assert.equal((await post('execution-stop',{...stop,id:paused.id,version:paused.saved.task.version,messageId:'executor-pause-wins',delivery:paused.delivery})).status,409);
      assert.equal((await f.q.getTask('review-a',scope,paused.id)).task.phase,'paused');
      const progressed=await boundText('executor-new-result-wins');await f.q.receiveRevision('review-a',progressed.saved,{delivery:progressed.delivery,messageId:'new-result',text:'新稿已交回',images:[],requestKey:'new-result-request'},progressed.saved.task.connected);
      assert.equal((await post('execution-stop',{...stop,id:progressed.id,version:progressed.saved.task.version,messageId:'executor-new-result-wins',delivery:progressed.delivery})).status,409);
      assert.equal((await f.q.getTask('review-a',scope,progressed.id)).task.rounds.length,2);
      console.log('PASS real SQLite executor stop is scoped, non-retrying, preserves rounds, and loses to pause/new result');
    }
    {
      const {id,delivery,saved}=await boundText('simultaneous-first-receipt'),text='甲项并发修订';
      let inputCount=0,inputsReady,releaseInputs,judgeReady,releaseJudge;
      const bothInputs=new Promise(resolve=>{inputsReady=resolve;}),inputGate=new Promise(resolve=>{releaseInputs=resolve;});
      const entered=new Promise(resolve=>{judgeReady=resolve;});f.control.onDefault=judgeReady;f.control.defaultGate=new Promise(resolve=>{releaseJudge=resolve;});
      const readImages=async()=>{if(++inputCount===2)inputsReady();await inputGate;return [];};
      const calls=f.modelCalls.length,run=()=>f.q.revisionForTool('review-a',delivery,text,[],readImages,saved.task.connected);
      const a=run(),b=run();
      try{
        await bothInputs;releaseInputs();await entered;
        const waiting=await Promise.race([a,b]);assert.equal(waiting.status,'pending');assert.equal(waiting.delivery,delivery);
        releaseJudge();const results=await Promise.all([a,b]);assert.deepEqual(results.map(r=>r.status).sort(),['pending','revise']);
        const final=(await f.q.getTask('review-a',scope,id)).task;assert.equal(final.rounds.length,2);assert.equal(f.modelCalls.length,calls+1);
      }finally{releaseInputs();releaseJudge();f.control.defaultGate=null;f.control.onDefault=null;await Promise.allSettled([a,b]);}
    }
    {
      const {id,delivery,saved}=await boundText('simultaneous-next-ticket'),text='甲项等待下一轮';
      const requestKey=crypto.createHash('sha256').update(JSON.stringify([delivery,text,[]])).digest('hex');
      await f.q.receiveRevision('review-a',saved,{delivery,messageId:'revision-'+delivery,text,images:[],requestKey},saved.task.connected);
      await f.q.judgeReview('review-a',await f.q.getTask('review-a',scope,id));
      const calls=f.modelCalls.length,replies=await Promise.all([f.submit(delivery,text,token),f.submit(delivery,text,token)]);
      const outcomes=replies.map(r=>r.result.structuredContent);assert.ok(outcomes.every(r=>r?.status==='revise'));
      assert.equal(outcomes[0].delivery,outcomes[1].delivery);assert.notEqual(outcomes[0].delivery,delivery);
      assert.equal((await f.q.getTask('review-a',scope,id)).task.rounds.length,2);assert.equal(f.modelCalls.length,calls);
    }
    console.log('PASS text concurrent first receipt and next-ticket publication reuse the accepted draft and authoritative ticket');
    assert.throws(()=>f.q.parseVerdict('这版应该可以了',false));assert.throws(()=>f.q.parseVerdict('{"decision":"revise","reason":"x","evidence":"x","change":"x"}',true));
    const retryId=crypto.randomUUID();
    f.control.failure=new f.musk.MuskApiError('fixture first-draft failure',502,'musk_api_empty_content');
    const failedFirst=await post('create',{id:retryId});assert.ok(failedFirst.ok,failedFirst.data.error);assert.equal(failedFirst.data.task.phase,'error');assert.equal(failedFirst.data.task.art,undefined);
    let savedFirst=(await f.q.getTask('review-a',scope,retryId)).task;assert.equal(savedFirst.delivery,undefined);assert.equal(savedFirst.art,undefined);
    f.control.failure=null;
    const retriedFirst=await post('retry',{id:retryId,version:savedFirst.version});assert.ok(retriedFirst.ok,retriedFirst.data.error);assert.equal(retriedFirst.data.task.phase,'ready');assert.equal(retriedFirst.data.task.art,undefined);
    savedFirst=(await f.q.getTask('review-a',scope,retryId)).task;assert.equal(savedFirst.art,undefined);assert.equal(savedFirst.delivery,undefined);
    const judgedFirst=await post('judge',{id:retryId,version:savedFirst.version});assert.ok(judgedFirst.ok,judgedFirst.data.error);assert.equal(judgedFirst.data.task.phase,'feedback');assert.equal(judgedFirst.data.task.art,undefined);
    const finalFirst=(await f.q.getTask('review-a',scope,retryId)).task;assert.equal(finalFirst.art,undefined);assert.equal(finalFirst.rounds.length,1);assert.equal(finalFirst.rounds[0].result.decision,'revise');
    console.log('PASS legacy first-draft model failure before ticket -> retry -> normal judge; never creates art state');
    const previousFetch=global.fetch;let directoryRequests=0;global.fetch=async()=>{directoryRequests++;throw Error('Unexpected directory request');};
    try{
    const unavailable=()=>new f.musk.MuskApiError('upstream private diagnostic',503,'musk_api_model_unavailable');
    async function judged(){
      const task=await f.q.startReview('review-a',{...base,id:crypto.randomUUID()});
      const start=f.modelCalls.length;
      const result=await f.q.judgeReview('review-a',await f.q.getTask('review-a',scope,task.id));
      return {result,calls:f.modelCalls.slice(start)};
    }
    f.control.failure=unavailable();
    f.control.catalog=['gpt-fixture-unapproved','gpt-fixture-fallback'];
    let check=await judged();assert.equal(check.result.phase,'feedback');assert.equal(check.result.rounds[0].model,'gpt-fixture-fallback');assert.deepEqual(check.calls,['gpt-fixture-default','gpt-fixture-fallback']);
    f.control.disabled.add('gpt-fixture-fallback');check=await judged();assert.equal(check.result.phase,'error');assert.match(check.result.note,/没有已获许可/);assert.deepEqual(check.calls,['gpt-fixture-default']);f.control.disabled.clear();
    f.control.catalog=[];check=await judged();assert.equal(check.result.phase,'error');assert.deepEqual(check.calls,['gpt-fixture-default']);
    f.control.catalog=['gpt-fixture-fallback','gpt-fixture-never'];f.control.fallbackFailure=unavailable();check=await judged();assert.equal(check.result.phase,'error');assert.deepEqual(check.calls,['gpt-fixture-default','gpt-fixture-fallback']);assert.ok(!check.result.note.includes('private diagnostic'));f.control.fallbackFailure=null;
    for(const error of [new f.musk.MuskApiError('secret upstream body',502,'musk_api_empty_content'),new f.privacy.PrivatePromptError()]){
      f.control.failure=error;check=await judged();assert.equal(check.result.phase,'error');assert.deepEqual(check.calls,['gpt-fixture-default']);assert.ok(!check.result.note.includes('secret'));assert.notEqual(check.result.note,'验收服务暂时未返回完整结论，可重试当前稿件');
    }
    f.control.failure=null;f.control.disabled.add('gpt-fixture-default');check=await judged();assert.equal(check.result.phase,'error');assert.deepEqual(check.calls,[]);assert.match(check.result.note,/关闭/);
    f.control.disabled.clear();f.control.failure=unavailable();f.control.catalog=['gpt-fixture-fallback'];
    for(const newClaim of [false,true]){
      let releaseDefault,enteredDefault;
      const entered=new Promise(resolve=>{enteredDefault=resolve;});
      f.control.defaultGate=new Promise(resolve=>{releaseDefault=resolve;});f.control.onDefault=enteredDefault;
      const task=await f.q.startReview('review-a',{...base,id:crypto.randomUUID()});
      const start=f.modelCalls.length,pending=f.q.judgeReview('review-a',await f.q.getTask('review-a',scope,task.id));
      await entered;
      const claim=await f.q.getTask('review-a',scope,task.id);assert.equal(claim.task.phase,'judging');
      const paused=await f.q.updateReview('review-a',claim,{op:'pause',version:claim.task.version});
      let newer,finishNew;
      if(newClaim){
        await f.q.updateReview('review-a',await f.q.getTask('review-a',scope,task.id),{op:'resume',version:paused.version});
        let enteredNew;const claimed=new Promise(resolve=>{enteredNew=resolve;});
        newer=f.q.judgeReview('review-a',await f.q.getTask('review-a',scope,task.id),async()=>{enteredNew();return new Promise(resolve=>{finishNew=resolve;});});
        await claimed;
      }
      const expected=await f.q.getTask('review-a',scope,task.id);assert.equal(expected.task.phase,newClaim?'judging':'paused');assert.notEqual(expected.task.version,claim.task.version);
      releaseDefault();const after=await pending;
      assert.equal(after.phase,expected.task.phase);assert.equal(after.version,expected.task.version);assert.deepEqual(f.modelCalls.slice(start),['gpt-fixture-default']);
      if(newer){finishNew({result:{decision:'revise',reason:'fixture',evidence:'fixture',change:'fixture'},model:'new-claim-fixture'});await newer;}
      f.control.defaultGate=null;f.control.onDefault=null;
    }
    assert.equal(directoryRequests,0);
    console.log('PASS actual resolver uses local approved candidates with zero directory fetch; paused and changed judging claim dispatch no fallback');
    }finally{global.fetch=previousFetch;}

    console.log('PASS actual runJudge bounded approved-model fallback / actual model recorded / closed and empty catalog / no loop / specific safe errors; simulated model transport');
    console.log('PASS scoped create / one record / judge / feedback / actual changed draft / pass; real SQLite; simulated model');
    console.log('PASS two owners and workspaces with equal CID, other chat callback, pause/replay, three revisions and retrospective, storage projection, OAuth exact registered callbacks / bound redirects / PKCE single use');
  }finally{await f.close();}
}
