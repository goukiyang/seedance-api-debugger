import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {reviewFixture} from './gpt-review-engineering.mjs';
const require=createRequire(import.meta.url),sharp=require('sharp'),f=await reviewFixture();
const scope='d'.repeat(64),token=await f.authorize(),other=await f.authorize('review-b');
const reference='data:image/png;base64,'+(await sharp({create:{width:192,height:128,channels:3,background:'#bcd3b7'}}).png().toBuffer()).toString('base64');
const analysis=JSON.stringify({problem:'门口被前景的大树遮挡，不能完整看到入口',cause:'树冠遮挡入口，路径在河边中断',direction:'移开树并连通路径，保留房屋与河流',check:'检查门口完整可见以及路径是否连续'});
const connection=session=>createHash('sha256').update(JSON.stringify(['review-a','fixture-subject-'+session,session,''])).digest('hex');
async function task(kind='text'){
  const base={id:randomUUID(),scope,device:'source-pending-device',cid:'source-pending-cid',messageId:randomUUID(),title:'连接异步确认',goal:'甲乙均已交付',text:'甲项已交付',images:[],...(kind==='art'?{kind,reference:[reference]}:{})};
  const post=(op,more={})=>f.api({...base,op,...more});
  const created=await post('create'),delivery=randomUUID();assert.ok(created.ok,created.data.error);
  const claim=await post('claim',{version:created.data.task.version,delivery});assert.ok(claim.ok);
  assert.ok((await post('ack',{version:claim.data.task.version,delivery})).ok);
  return {base,post,delivery,get:()=>f.q.getTask('review-a',scope,base.id)};
}
const completed=[],failures=[];
async function check(name,run){try{await run();completed.push(name);console.log('PASS '+name);}catch(e){failures.push(name);console.error('FAIL '+name+' '+e.stack);}}
try{
  await check('missing link, wrong owner and unregistered connection remain errors',async()=>{
    const n=await task();
    assert.equal((await f.submit(n.delivery,'甲项已交付。乙项已交付。',token)).result.isError,true);
    await f.link(n.delivery,token);
    assert.equal((await f.submit(n.delivery,'甲项已交付。乙项已交付。',other)).result.isError,true);
    assert.equal((await f.submit(n.delivery,'甲项已交付。乙项已交付。',token,'unlinked-chat')).result.isError,true);
  });
  await check('pending art submission neither downloads files nor accepts or counts a draft',async()=>{
    const n=await task('art');await f.link(n.delivery,token);
    const before=await n.get(),calls=f.modelCalls.length;let downloads=0;
    const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{downloads++;throw Error('unexpected file download before confirmation');};
    try{
      const result=await f.rpc('tools/call',{name:'submit_revision',arguments:{delivery:n.delivery,text:analysis,image:{file_id:'file-pending',download_url:'https://files.oaiusercontent.com/pending.png'}},_meta:{'openai/subject':'fixture-subject-private-chat-A','openai/session':'private-chat-A'}},token);
      assert.equal(result.result.isError,undefined);assert.equal(result.result.structuredContent.status,'pending');
      assert.equal(result.result.structuredContent.delivery,n.delivery);
      assert.deepEqual(Object.keys(result.result.structuredContent).sort(),['delivery','message','retryAfterMs','status']);
      assert.equal(downloads,0);assert.equal(f.modelCalls.length,calls);assert.equal((await n.get()).raw,before.raw);
    }finally{globalThis.fetch=originalFetch;}
  });
  await check('delayed native confirmation continues the same submission once without regenerating',async()=>{
    const n=await task('art'),proof=(await f.link(n.delivery,token)).result._meta.sd2ReviewProof;
    const submit=f.submit(n.delivery,analysis,token);
    await new Promise(resolve=>setTimeout(resolve,80));assert.ok((await n.post('confirm',proof)).ok);
    const response=(await submit).result;assert.equal(response.isError,undefined,JSON.stringify(response.content));
    const result=response.structuredContent;assert.equal(result.status,'continue');assert.equal(result.stage,'image');
    const saved=(await n.get()).task;assert.equal(saved.art.totalChanges,0);assert.equal(saved.art.receipts.length,1);assert.equal(saved.art.receipts[0].delivery,n.delivery);
    assert.equal(saved.connected,connection('private-chat-A'));
    const repeat=(await f.submit(n.delivery,analysis,token)).result.structuredContent;
    assert.equal(repeat.delivery,result.delivery);assert.equal((await n.get()).task.art.receipts.length,1);
  });
  await check('pending text retries reuse the same ticket and enter normal judgement after confirmation',async()=>{
    const n=await task(),proof=(await f.link(n.delivery,token)).result._meta.sd2ReviewProof,before=await n.get();
    const waiting=await f.pairing.awaitSourceConfirmation('review-a',n.delivery,connection('private-chat-A'),0);
    assert.equal(waiting.status,'pending');assert.equal((await n.get()).raw,before.raw);
    assert.ok((await n.post('confirm',proof)).ok);
    const result=(await f.submit(n.delivery,'甲项已交付。乙项已交付。',token)).result.structuredContent;assert.equal(result.status,'pass');assert.equal(result.changes,1);
  });
  await check('wrong conversation cannot confirm, and a different connection cannot submit after binding',async()=>{
    const n=await task(),wrong=(await f.link(n.delivery,token,'other-chat')).result._meta.sd2ReviewProof;
    assert.equal((await n.post('confirm',{...wrong,cid:'wrong-cid'})).status,409);
    assert.equal((await n.get()).task.connected,undefined);
    const proof=(await f.link(n.delivery,token)).result._meta.sd2ReviewProof;assert.ok((await n.post('confirm',proof)).ok);
    assert.equal((await f.submit(n.delivery,'甲项已交付。乙项已交付。',token,'other-chat')).result.isError,true);
    assert.equal((await n.get()).task.rounds.length,1);
  });
  await check('expired pending proof is rejected without a task write',async()=>{
    const n=await task();await f.link(n.delivery,token);const conn=connection('private-chat-A');
    const key='bridge_gpt_review_link:'+createHash('sha256').update(n.delivery+':'+conn).digest('hex');
    const row=await f.db.userPreference.findUnique({where:{user_id_key:{user_id:'review-a',key}}});
    await f.db.userPreference.updateMany({where:{user_id:'review-a',key,value_json:row.value_json},data:{value_json:JSON.stringify({...JSON.parse(row.value_json),expires:Date.now()-1})}});
    const before=await n.get();assert.equal((await f.submit(n.delivery,'甲项已交付。乙项已交付。',token)).result.isError,true);assert.equal((await n.get()).raw,before.raw);
  });
  await check('pause and a changed delivery during pending wait prevent late acceptance',async()=>{
    for(const change of ['pause','delivery']){
      const n=await task('art');await f.link(n.delivery,token);const before=await n.get();
      const run=f.submit(n.delivery,analysis,token);await new Promise(resolve=>setTimeout(resolve,80));
      if(change==='pause')assert.ok((await n.post('pause',{version:before.task.version})).ok);
      else await f.db.userPreference.updateMany({where:{user_id:'review-a',key:f.q.REVIEW_PREFIX+scope+':'+n.base.id,value_json:before.raw},data:{value_json:JSON.stringify({...before.task,delivery:randomUUID(),version:randomUUID()})}});
      const frozen=await n.get();assert.equal((await run).result.isError,true);assert.equal((await n.get()).raw,frozen.raw);assert.equal(frozen.task.art.receipts.length,0);
    }
  });
  await check('concurrent pre-confirmation submissions accept one identical artifact',async()=>{
    const n=await task('art'),proof=(await f.link(n.delivery,token)).result._meta.sd2ReviewProof;
    const a=f.submit(n.delivery,analysis,token),b=f.submit(n.delivery,analysis,token);await new Promise(resolve=>setTimeout(resolve,80));assert.ok((await n.post('confirm',proof)).ok);
    const results=await Promise.all([a,b]);assert.ok(results.every(r=>r.result.structuredContent?.status==='continue'),JSON.stringify(results.map(r=>r.result)));
    assert.equal(new Set(results.map(r=>r.result.structuredContent.delivery)).size,1);assert.equal((await n.get()).task.art.receipts.length,1);assert.equal((await n.get()).task.art.totalChanges,0);
  });
  if(failures.length)throw Error(failures.length+' source-confirmation groups failed');
  console.log('PASS '+completed.length+' source-confirmation groups; isolated SQLite only; no production writes or paid calls');
}finally{await f.close();}
