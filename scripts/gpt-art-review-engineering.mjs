import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {reviewFixture} from './gpt-review-engineering.mjs';
const require=createRequire(import.meta.url),sharp=require('sharp');
const f=await reviewFixture(),scope='c'.repeat(64),completed=[],failures=[];
const image=async(n,compressionLevel=6)=>'data:image/png;base64,'+(await sharp({create:{width:192,height:128,channels:4,background:{r:(n*17)%255,g:(n*29)%255,b:(n*43)%255,alpha:1}}}).png({compressionLevel}).toBuffer()).toString('base64');
const original=await image(1),token=await f.authorize();
async function check(name,run){try{await run();completed.push(name);console.log('PASS '+name);}catch(error){failures.push({name,error:error.stack});console.error('FAIL '+name+' '+error.message);}}
async function task(){
  const base={id:randomUUID(),scope,device:'art-fixture-device',cid:'same-art-cid',messageId:'user-original',kind:'art',title:'美术自动流',goal:'减少设施堆砌，让地形更连贯；保留人物和明快色调',text:'用户原提问',images:[],reference:[original]};
  const post=(op,more={},user)=>f.api({...base,op,...more},user),created=await post('create');assert.ok(created.ok,created.data.error);assert.equal(created.data.task.phase,'feedback');assert.equal(created.data.task.art.stage,'analysis');
  const delivery=randomUUID(),claim=await post('claim',{version:created.data.task.version,delivery});assert.ok(claim.ok,claim.data.error);
  const linked=await f.link(delivery,token);assert.ok(linked.result._meta.sd2ReviewProof);assert.ok((await post('confirm',linked.result._meta.sd2ReviewProof)).ok);
  const get=()=>f.q.getTask('review-a',scope,base.id),connection=(await get()).task.connected;
  assert.ok((await post('ack',{version:(await get()).task.version,delivery})).ok);
  const submit=(ticket,text,images=[],ids=images.map((_,i)=>'fixture-file-'+ticket+'-'+i),read=async()=>images)=>f.q.revisionForTool('review-a',ticket,text,ids,read,connection);
  return {base,post,get,delivery,connection,submit};
}
const analysis=JSON.stringify({problem:'原图中轨道与围栏过密，地形之间缺乏联系',cause:'轨道密度和断裂地貌让场景更像游乐设施',direction:'连接中央地貌并减少重复轨道，保留人物造型和明快色调',check:'按新旧图中央地形连续性和人物轮廓逐项核对'});
const recap=JSON.stringify({problem:'对照几次成图，中央地形依然被轨道分割',cause:'原方向成立，但只删除设施未改变地形断裂的方法有问题',direction:'从最好版连接中央地貌并增加洞口，不继续只删轨道',check:'沿中央两处断面检查路线连续性，同时核对人物保留'});
const mcpImage=(delivery,text,refs)=>f.rpc('tools/call',{name:'submit_revision',arguments:{delivery,text,...Object.fromEntries(refs.map((ref,i)=>[i?'image'+(i+1):'image',ref]))},_meta:{'openai/subject':'fixture-subject-private-chat-A','openai/session':'private-chat-A'}},token);
async function recover(n,op='resume'){
  const current=(await n.get()).task,explicit=await n.post(op,{version:current.version});assert.ok(explicit.ok,explicit.data.error);
  assert.equal(explicit.data.task.sourceConfirmed,true);assert.ok(explicit.data.task.art.wakeId);
  const args={version:explicit.data.task.version,wakeId:explicit.data.task.art.wakeId},result=await n.post('recover',args);assert.ok(result.ok,result.data.error);
  return {args,result};
}
try{
  await check('analysis -> initial image -> nine revisions -> two automatic recaps -> user decision in one task',async()=>{
    const calls=f.modelCalls.length,n=await task();assert.equal(f.modelCalls.length,calls,'initial create must not judge the source text');
    let next=await n.submit(n.delivery,analysis);assert.equal(next.status,'continue');assert.equal(next.stage,'image');assert.match(next.instructions,/真正生成第一张/);
    const replay=await n.submit(n.delivery,analysis);assert.equal(replay.delivery,next.delivery);assert.equal((await n.get()).task.art.receipts.length,1);
    const firstTicket=next.delivery;
    for(let i=0;i<10;i++){
      const ticket=next.delivery,bitmap=await image(i+10);next=await n.submit(ticket,'本轮实际改图 '+i,[bitmap]);
      assert.equal(next.changes,i);assert.notEqual(next.status,'pass');
      const saved=(await n.get()).task;assert.equal(saved.art.totalChanges,i);assert.equal(saved.rounds.length,i+2);assert.equal(saved.art.bestRound,1);
      assert.equal(saved.rounds[0].result,undefined,'baseline is not an art verdict');
      if(i===3||i===6){
        assert.equal(next.stage,'recap');assert.equal(next.status,'continue');assert.match(next.instructions,/检查原方向、逻辑和方法/);
        const old=next.delivery;next=await n.submit(old,recap);
        assert.equal(next.status,'continue');assert.equal(next.stage,'image');assert.equal(next.changes,i);assert.equal(next.cycleChanges,0);
      }
    }
    assert.equal(next.status,'stop');assert.equal(next.stage,'done');assert.equal(next.cycle,2);
    const final=(await n.get()).task;assert.equal(final.phase,'input');assert.equal(final.art.recaps.length,2);assert.equal(final.art.receipts.length,13);assert.equal(final.art.totalChanges,9);assert.equal(final.art.cycleChanges,3);assert.equal(final.goal,n.base.goal);
    const detail=(await n.post('get')).data.task;assert.equal(detail.reference.length,1);assert.equal(detail.bestImages.length,1);assert.equal(detail.art.receipts,undefined);assert.equal(detail.rounds[0].baseline,true);
    const old=await n.submit(firstTicket,'本轮实际改图 0',[await image(10)]);assert.equal(old.status,'stop');assert.equal(old.delivery,undefined);
    const listing=(await n.post('list')).data.rows.find(r=>r.id===n.base.id);assert.equal(listing.changes,9);assert.equal(listing.art.recapCount,2);assert.equal(listing.art.analysis,undefined);assert.equal(listing.reference,undefined);
    assert.equal(f.modelCalls.length-calls,10,'one independent image judge per real image only');
    assert.ok(f.modelInputs.at(-1).此前最好图片数===1);assert.ok(f.modelInputs.at(-1).参考图数===1);
  });
  await check('real OAuth source binding and MCP file callback can pass the first actual image',async()=>{
    f.control.artVerdict={decision:'pass',reason:'目标已达成',evidence:'地形连通且人物保留',change:'',actualImage:true,better:true};
    const n=await task(),first=await f.submit(n.delivery,analysis,token);assert.equal(first.result.structuredContent.status,'continue');
    const next=first.result.structuredContent.delivery,png=Buffer.from((await image(40)).split(',')[1],'base64'),prior=global.fetch;
    global.fetch=async(url,options)=>{assert.equal(String(url),'https://files.oaiusercontent.com/art-fixture.png');assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');return new Response(png,{headers:{'content-type':'image/png'}});};
    try{
      const result=await f.rpc('tools/call',{name:'submit_revision',arguments:{delivery:next,text:'实际改图',image:{file_id:'mcp-art-file',download_url:'https://files.oaiusercontent.com/art-fixture.png'}},_meta:{'openai/subject':'fixture-subject-private-chat-A','openai/session':'private-chat-A'}},token);
      assert.equal(result.result.structuredContent.status,'pass');assert.equal(result.result.structuredContent.changes,0);assert.equal((await n.get()).task.phase,'passed');
    }finally{global.fetch=prior;f.control.artVerdict=null;}
  });
  await check('missing, undecodable, SVG, original re-encoding and duplicate bitmaps never add revisions',async()=>{
    for(const sample of [[],['data:image/png;base64,'+Buffer.from('89504e470d0a1a0a0000000000000000','hex').toString('base64')],['data:image/svg+xml;base64,'+Buffer.from('<svg/>').toString('base64')],[await image(1,9)]]){
      const n=await task(),next=await n.submit(n.delivery,analysis);
      await assert.rejects(n.submit(next.delivery,'未收到可用成图',sample),/必须交回|未完整解码|可查看|仍是原图/);
      assert.equal((await n.get()).task.art.totalChanges,0);assert.equal((await n.get()).task.rounds.length,1);
    }
    const n=await task(),next=await n.submit(n.delivery,analysis),ticket=next.delivery;
    const bitmap=await image(52),done=await n.submit(ticket,'第一张实际图',[bitmap]);assert.equal(done.changes,0);
    await assert.rejects(n.submit(done.delivery,'换文件名但没有改图',[bitmap]),/已经提交/);
    assert.equal((await n.get()).task.rounds.length,2);assert.equal((await n.get()).task.art.totalChanges,0);
    const retry=await n.submit(ticket,'第一张实际图',[bitmap]);assert.equal(retry.delivery,done.delivery);
    await assert.rejects(n.submit(ticket,'同号不同正文',[bitmap]),/不同的内容/);
  });
  await check('three distinct invalid submissions stop; exact retry and unknown transfer do not exhaust quota',async()=>{
    const n=await task(),next=await n.submit(n.delivery,analysis),ticket=next.delivery;
    await assert.rejects(n.submit(ticket,'无图1'),/必须交回/);
    await assert.rejects(n.submit(ticket,'无图1'),/同一提交/);assert.equal((await n.get()).task.art.invalid.requests.length,1);
    await assert.rejects(n.submit(ticket,'网络结果未知',[],['unread-file'],async()=>{throw Error('isolated transfer unknown');}),/transfer unknown/);assert.equal((await n.get()).task.art.invalid.requests.length,1);
    await assert.rejects(n.submit(ticket,'无图2'),/必须交回/);
    const stop=await n.submit(ticket,'原图3',[await image(1,9)]);assert.equal(stop.status,'stop');const held=(await n.get()).task;assert.equal(held.phase,'error');assert.equal(held.art.totalChanges,0);assert.equal(held.rounds.length,1);
    let reads=0;assert.equal((await n.submit(ticket,'无图4',[],['never-read'],async()=>{reads++;return [];})).status,'stop');assert.equal(reads,0);
    const waking=await recover(n,'retry'),delivery=waking.result.data.delivery;assert.notEqual(delivery,ticket);assert.equal(waking.result.data.task.phase,'delivering');
    assert.ok((await n.post('ack',{version:waking.result.data.task.version,delivery})).ok);
    assert.equal((await n.submit(ticket,'旧票据不得复活')).status,'stop');
    const accepted=await n.submit(delivery,'补齐实际图',[await image(58)]);assert.equal(accepted.status,'revise');assert.equal(accepted.changes,0);assert.equal((await n.get()).task.art.invalid,undefined);
  });
  await check('account/workspace/session mismatch and pause during upload preserve original state',async()=>{
    const n=await task(),next=await n.submit(n.delivery,analysis),ticket=next.delivery;
    assert.equal((await n.post('get',{}, {user:'review-b'})).status,404);assert.equal((await n.post('get',{scope:'d'.repeat(64)})).status,404);
    let reads=0;await assert.rejects(f.q.revisionForTool('review-a',ticket,'实际图',['wrong-file'],async()=>{reads++;return [original];},'different-connection'),/原对话/);assert.equal(reads,0);
    let entered,release;const waiting=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
    const pending=n.submit(ticket,'迟到图',[],['late-image'],async()=>{entered();await gate;return [await image(65)];});await waiting;
    const before=(await n.get()).task;assert.ok((await n.post('pause',{version:before.version})).ok);release();const stopped=await pending;assert.equal(stopped.status,'stop');assert.equal(stopped.delivery,undefined);
    const after=(await n.get()).task;assert.equal(after.phase,'paused');assert.equal(after.art.totalChanges,0);assert.equal(after.rounds.length,1);assert.equal(after.art.receipts.length,1);
  });
  await check('concurrent receipt while judging returns pending; a newer pause wins over late verdict',async()=>{
    const n=await task(),next=await n.submit(n.delivery,analysis),ticket=next.delivery,bitmap=await image(77);let entered,release;
    const waiting=new Promise(resolve=>{entered=resolve;});f.control.defaultGate=new Promise(resolve=>{release=resolve;});f.control.onDefault=entered;
    const pending=n.submit(ticket,'待判定图',[bitmap]);await waiting;
    const duplicate=await n.submit(ticket,'待判定图',[bitmap]);assert.equal(duplicate.status,'pending');assert.equal(duplicate.delivery,ticket);
    const before=(await n.get()).task;assert.ok((await n.post('pause',{version:before.version})).ok);release();const result=await pending;
    assert.equal(result.status,'stop');assert.equal(result.delivery,undefined);assert.equal((await n.get()).task.phase,'paused');assert.equal((await n.get()).task.rounds.length,2);
    f.control.defaultGate=null;f.control.onDefault=null;
  });
  await check('a diagram cannot pass and an unverified visual verdict is not accepted',async()=>{
    const n=await task(),next=await n.submit(n.delivery,analysis);
    f.control.artVerdict={decision:'pass',reason:'只是一张示意图',evidence:'没有实际场景修改',change:'',actualImage:false,better:true};
    const rejected=await n.submit(next.delivery,'示意图',[await image(90)]);assert.notEqual(rejected.status,'pass');assert.equal((await n.get()).task.art.bestRound,undefined);
    f.control.artVerdict={decision:'pass',reason:'未经看图确认',evidence:'只根据文字',change:''};
    const invalid=await n.submit(rejected.delivery,'另一图',[await image(91)]);assert.equal(invalid.status,'stop');assert.equal((await n.get()).task.phase,'error');
    f.control.artVerdict=null;
  });
  await check('semantic non-art images have a separate cross-ticket bound and the first actual image remains draft zero',async()=>{
    const n=await task();let next=await n.submit(n.delivery,analysis);
    const diagram={decision:'pass',reason:'只有带注释的线路结构示意',evidence:'没有实际的场景作品',change:'',actualImage:false,better:true};
    f.control.artVerdict=diagram;
    for(let i=0;i<2;i++){
      const ticket=next.delivery,pic=await image(100+i);next=await n.submit(ticket,'线路示意 '+i,[pic]);assert.equal(next.changes,0);assert.equal(next.cycleChanges,0);
      const before=(await n.get()).task;assert.equal(before.art.bestRound,undefined);assert.equal(before.art.invalidVisuals,i+1);
      const replay=await n.submit(ticket,'线路示意 '+i,[pic]);assert.equal(replay.delivery,next.delivery);assert.equal((await n.get()).task.art.invalidVisuals,i+1);
    }
    f.control.artVerdict=null;
    next=await n.submit(next.delivery,'第一张真实修改图',[await image(102)]);assert.equal(next.changes,0);assert.equal((await n.get()).task.art.bestRound,3);
    next=await n.submit(next.delivery,'第一张真实修改后的修订',[await image(103)]);assert.equal(next.changes,1);
    f.control.artVerdict=diagram;
    next=await n.submit(next.delivery,'再次误交示意',[await image(104)]);assert.equal(next.status,'stop');assert.equal(next.changes,1);assert.equal((await n.get()).task.art.invalidVisuals,3);
    assert.equal((await n.get()).task.phase,'error');assert.equal((await n.get()).task.art.bestRound,3);
    const allBad=await task();let bad=await allBad.submit(allBad.delivery,analysis);
    for(let i=0;i<3;i++)bad=await allBad.submit(bad.delivery,'无真实成图 '+i,[await image(110+i)]);
    assert.equal(bad.status,'stop');assert.equal(bad.changes,0);assert.equal((await allBad.get()).task.art.bestRound,undefined);assert.match(bad.message,/尚无可保留/);assert.doesNotMatch(bad.message,/已保留.*最好/);
    f.control.artVerdict=null;
  });
  await check('real MCP distinguishes oversized and unsupported images from unknown transfers and deduplicates invalid receipts',async()=>{
    const n=await task(),next=await n.submit(n.delivery,analysis),ticket=next.delivery,prior=global.fetch;
    const ref=name=>({file_id:name,download_url:'https://files.oaiusercontent.com/'+name});let downloads=0;
    global.fetch=async(url)=>{
      downloads++;const name=new URL(url).pathname;
      if(name==='/unknown')throw Error('fixture network unknown');
      if(name==='/http503')return new Response('temporary failure',{status:503,headers:{'content-type':'text/plain'}});
      if(name==='/oversize-header')return new Response('small placeholder',{headers:{'content-type':'image/png','content-length':String(2097153)}});
      if(name==='/oversize-stream')return new Response(Buffer.alloc(2097153),{headers:{'content-type':'image/png'}});
      return new Response('<svg/>',{headers:{'content-type':'image/svg+xml'}});
    };
    try{
      for(const name of ['unknown','http503'])assert.equal((await mcpImage(ticket,'未知传输',[ref(name)])).result.isError,true);
      assert.equal((await n.get()).task.art.invalid,undefined,'network and HTTP failure are not known invalid materials');
      const first=await mcpImage(ticket,'超限一',[ref('oversize-header')]);assert.equal(first.result.isError,true);assert.match(first.result.content[0].text,/超过 2 MB/);assert.equal((await n.get()).task.art.invalid.requests.length,1);
      const reads=downloads,replay=await mcpImage(ticket,'超限一',[ref('oversize-header')]);assert.equal(replay.result.isError,true);assert.match(replay.result.content[0].text,/同一提交/);assert.equal((await n.get()).task.art.invalid.requests.length,1);assert.equal(downloads,reads,'known invalid exact replay is not downloaded again');
      const second=await mcpImage(ticket,'超限二',[ref('oversize-stream')]);assert.equal(second.result.isError,true);assert.equal((await n.get()).task.art.invalid.requests.length,2);
      const third=await mcpImage(ticket,'不支持格式',[ref('unsupported')]);assert.equal(third.result.structuredContent.status,'stop');assert.equal((await n.get()).task.phase,'error');assert.equal((await n.get()).task.art.totalChanges,0);assert.equal((await n.get()).task.rounds.length,1);
    }finally{global.fetch=prior;}
  });
  await check('art accepts one main deliverable while retaining multiple original references and legacy multi-image drafts',async()=>{
    const n=await task(),next=await n.submit(n.delivery,analysis);let reads=0;
    await assert.rejects(n.submit(next.delivery,'混交两张',[],['main','diagram'],async()=>{reads++;return [await image(120),await image(121)];}),/一张主成品/);assert.equal(reads,0);
    await assert.rejects(n.submit(next.delivery,'一号读出两张',[],['one-file'],async()=>[await image(122),await image(123)]),/一张主成品/);
    assert.equal((await n.get()).task.rounds.length,1);assert.equal((await n.get()).task.art.totalChanges,0);
    const base={...n.base,id:randomUUID(),reference:[original,await image(124)]};
    const manyRefs=await f.api({...base,op:'create'});assert.ok(manyRefs.ok,manyRefs.data.error);assert.equal((await f.q.getTask('review-a',scope,base.id)).task.reference.length,2);
    const legacy={...base,id:randomUUID(),kind:undefined,text:'甲项已交付。乙项已交付。',images:[await image(125),await image(126)]};
    const legacyResult=await f.api({...legacy,op:'create'});assert.ok(legacyResult.ok,legacyResult.data.error);assert.equal((await f.q.getTask('review-a',scope,legacy.id)).task.rounds[0].draft.images.length,2);
  });
  await check('analysis and recap reject empty acknowledgements without accepting receipts or consuming cycles',async()=>{
    const n=await task();await assert.rejects(n.submit(n.delivery,'收到'),/实质内容/);
    let saved=(await n.get()).task;assert.equal(saved.art.stage,'analysis');assert.equal(saved.art.receipts.length,0);assert.equal(saved.art.totalChanges,0);
    await assert.rejects(n.submit(n.delivery,JSON.stringify({problem:'这是足够长度的同一句话',cause:'这是足够长度的同一句话',direction:'这是足够长度的同一句话',check:'这是足够长度的同一句话'})),/实质内容/);
    let next=await n.submit(n.delivery,analysis);
    for(let i=0;i<4;i++)next=await n.submit(next.delivery,'实际图 '+i,[await image(130+i)]);
    assert.equal(next.stage,'recap');saved=(await n.get()).task;const count=saved.art.receipts.length;
    await assert.rejects(n.submit(next.delivery,'收到，接下来会继续改'),/实质内容/);
    saved=(await n.get()).task;assert.equal(saved.art.receipts.length,count);assert.equal(saved.art.cycle,0);assert.equal(saved.art.recaps.length,0);assert.equal(saved.art.cycleChanges,3);
    const resumed=await n.submit(next.delivery,recap);assert.equal(resumed.stage,'image');assert.equal(resumed.cycle,1);assert.equal(resumed.cycleChanges,0);
  });
  await check('pause during judge then explicit resume rejudges once and issues a fresh idempotent original-session ticket',async()=>{
    const n=await task(),next=await n.submit(n.delivery,analysis),ticket=next.delivery,pic=await image(140);let entered,release;
    const waiting=new Promise(resolve=>{entered=resolve;});f.control.defaultGate=new Promise(resolve=>{release=resolve;});f.control.onDefault=entered;
    const pending=n.submit(ticket,'暂停中的实际图',[pic]);await waiting;
    const before=(await n.get()).task;assert.ok((await n.post('pause',{version:before.version})).ok);release();assert.equal((await pending).status,'stop');
    f.control.defaultGate=null;f.control.onDefault=null;const paused=(await n.get()).task;assert.equal(paused.art.totalChanges,0);assert.equal(paused.rounds[1].result,undefined);
    const resume=await n.post('resume',{version:paused.version});assert.ok(resume.ok);const args={version:resume.data.task.version,wakeId:resume.data.task.art.wakeId};
    for(const wrong of [{device:'other-device'},{cid:'other-cid'},{messageId:'other-source'},{wakeId:randomUUID()}])assert.equal((await n.post('recover',{...args,...wrong})).status,409);
    assert.equal((await n.post('recover',args,{user:'review-b'})).status,404);
    let reads=0;assert.equal((await n.submit(ticket,'暂停中的实际图',[pic],undefined,async()=>{reads++;return [pic];})).status,'stop');assert.equal(reads,0);
    const calls=f.modelCalls.length,recovered=await n.post('recover',args);assert.ok(recovered.ok,recovered.data.error);assert.equal(recovered.data.task.phase,'delivering');assert.notEqual(recovered.data.delivery,ticket);assert.match(recovered.data.instructions,/真实图像制作/);assert.equal(f.modelCalls.length,calls+1);
    const duplicate=await n.post('recover',args);assert.ok(duplicate.ok);assert.equal(duplicate.data.delivery,recovered.data.delivery);assert.equal(f.modelCalls.length,calls+1);
    const current=(await n.get()).task;assert.equal(current.connected,n.connection);assert.equal(current.goal,n.base.goal);assert.equal(current.art.totalChanges,0);assert.equal(current.art.bestRound,1);
    assert.equal((await n.post('status')).data.task.sourceConfirmed,true);assert.equal((await n.post('get')).data.task.connected,undefined);
    await assert.rejects(f.q.revisionForTool('review-a',recovered.data.delivery,'跨会话',['cross-session'],async()=>[await image(141)],'wrong-session'),/原对话/);
    assert.ok((await n.post('ack',{version:current.version,delivery:current.delivery})).ok);
    const continuing=await n.submit(current.delivery,'恢复后新的实际图',[await image(142)]);assert.equal(continuing.changes,1);assert.equal(continuing.status,'revise');
  });
  await check('a new pause wins over a recovery judge and retry uses the retained actual image without a new generation',async()=>{
    const n=await task(),next=await n.submit(n.delivery,analysis);f.control.artVerdict={decision:'pass',reason:'缺少必要看图字段',evidence:'未确认实际成图',change:''};
    const bad=await n.submit(next.delivery,'待补审稿结论',[await image(150)]);assert.equal(bad.status,'stop');assert.equal((await n.get()).task.phase,'error');
    f.control.artVerdict=null;const failed=(await n.get()).task,retry=await n.post('retry',{version:failed.version});assert.ok(retry.ok);
    let entered,release;const waiting=new Promise(resolve=>{entered=resolve;});f.control.defaultGate=new Promise(resolve=>{release=resolve;});f.control.onDefault=entered;
    const args={version:retry.data.task.version,wakeId:retry.data.task.art.wakeId},pending=n.post('recover',args);await waiting;
    const during=(await n.get()).task;assert.ok((await n.post('pause',{version:during.version})).ok);release();const result=await pending;
    assert.ok(result.ok);assert.equal(result.data.task.phase,'paused');assert.equal(result.data.delivery,undefined);assert.equal((await n.get()).task.art.totalChanges,0);
    f.control.defaultGate=null;f.control.onDefault=null;
    const restored=await recover(n);assert.equal(restored.result.data.task.phase,'delivering');assert.equal((await n.get()).task.rounds.length,2);assert.equal((await n.get()).task.art.totalChanges,0);
  });
  await check('pause before first dispatch still follows initial source proof instead of bypassing connection checks',async()=>{
    const seed=await task(),base={...seed.base,id:randomUUID()},post=(op,more={})=>f.api({...base,op,...more});
    const created=await post('create');assert.ok(created.ok);assert.equal(created.data.task.sourceConfirmed,false);
    const paused=await post('pause',{version:created.data.task.version}),resumed=await post('resume',{version:paused.data.task.version});assert.ok(resumed.ok);assert.ok(resumed.data.task.art.wakeId);
    assert.equal((await post('recover',{version:resumed.data.task.version,wakeId:resumed.data.task.art.wakeId})).status,409);
    const delivery=randomUUID(),claim=await post('claim',{version:resumed.data.task.version,delivery});assert.ok(claim.ok,claim.data.error);assert.equal(claim.data.task.art.wakeId,undefined);
    const link=await f.link(delivery,token);assert.ok((await post('confirm',link.result._meta.sd2ReviewProof)).ok);
    const current=(await f.q.getTask('review-a',scope,base.id)).task;assert.ok((await post('ack',{version:current.version,delivery})).ok);
    const result=await f.submit(delivery,analysis,token);assert.equal(result.result.structuredContent.status,'continue');assert.equal(result.result.structuredContent.stage,'image');
  });
  await check('an already bound paused task returns structured MCP stop even before its first receipt',async()=>{
    const n=await task(),before=(await n.get()).task,calls=f.modelCalls.length;assert.equal(before.art.receipts.length,0);
    assert.ok((await n.post('pause',{version:before.version})).ok);
    const late=await f.submit(n.delivery,analysis,token);assert.equal(late.result.isError,undefined);assert.equal(late.result.structuredContent.status,'stop');assert.equal(late.result.structuredContent.delivery,undefined);
    assert.match(late.result.structuredContent.message,/暂停|结束/);assert.equal((await n.get()).task.art.receipts.length,0);assert.equal(f.modelCalls.length,calls);
    const wrong=await f.submit(n.delivery,analysis,token,'wrong-session');assert.equal(wrong.result.isError,true,'structured stop must not disclose task to another native session');
  });
  await check('initial command paused before pairing recovers with a new unbound ticket and still requires real source confirmation',async()=>{
    const seed=await task(),base={...seed.base,id:randomUUID()},post=(op,more={},owner)=>f.api({...base,op,...more},owner);
    const created=await post('create'),oldDelivery=randomUUID(),claim=await post('claim',{version:created.data.task.version,delivery:oldDelivery});assert.ok(claim.ok);
    const oldProof=(await f.link(oldDelivery,token)).result._meta.sd2ReviewProof;assert.ok(oldProof);
    const current=(await f.q.getTask('review-a',scope,base.id)).task,paused=await post('pause',{version:current.version}),resumed=await post('resume',{version:paused.data.task.version});assert.ok(resumed.ok);
    assert.equal(resumed.data.task.sourceConfirmed,false);assert.equal(resumed.data.task.art.wakeVersion,paused.data.task.version);
    const args={version:resumed.data.task.version,wakeId:resumed.data.task.art.wakeId};
    for(const wrong of [{device:'another-device'},{cid:'another-cid'},{messageId:'another-source'},{wakeId:randomUUID()}])assert.equal((await post('recover',{...args,...wrong})).status,409);
    assert.equal((await post('recover',args,{user:'review-b'})).status,404);
    const recovered=await post('recover',args);assert.ok(recovered.ok,recovered.data.error);assert.equal(recovered.data.task.phase,'delivering');assert.equal(recovered.data.task.sourceConfirmed,false);assert.notEqual(recovered.data.delivery,oldDelivery);assert.equal(recovered.data.task.art.wakeVersion,paused.data.task.version);
    assert.equal((await f.submit(recovered.data.delivery,analysis,token)).result.isError,true,'new ticket alone does not prove the source conversation');
    assert.equal((await post('confirm',oldProof)).status,409,'old widget proof cannot authorize the new ticket');
    assert.equal((await f.link(oldDelivery,token)).result.isError,true,'old ticket cannot be paired after recovery');
    const proof=(await f.link(recovered.data.delivery,token)).result._meta.sd2ReviewProof;assert.ok(proof);assert.ok((await post('confirm',proof)).ok);
    const bound=(await f.q.getTask('review-a',scope,base.id)).task;assert.ok(bound.connected);assert.ok((await post('ack',{version:bound.version,delivery:recovered.data.delivery})).ok);
    const submitted=await f.submit(recovered.data.delivery,analysis,token);assert.equal(submitted.result.structuredContent.status,'continue');assert.equal(submitted.result.structuredContent.stage,'image');
  });
  await check('lost resume and retry responses can be reconciled only against the exact original action version',async()=>{
    const n=await task(),before=(await n.get()).task,paused=await n.post('pause',{version:before.version});assert.ok(paused.ok);
    const originalVersion=paused.data.task.version;
    await n.post('resume',{version:originalVersion}); // Simulate a response lost before the client persists it.
    const authoritative=(await n.post('status')).data.task;assert.ok(authoritative.art.wakeId);assert.equal(authoritative.art.wakeVersion,originalVersion);
    const retried=await n.post('resume',{version:originalVersion});assert.ok(retried.ok);assert.equal(retried.data.task.art.wakeId,authoritative.art.wakeId);assert.equal(retried.data.task.version,authoritative.version);
    assert.equal((await n.post('resume',{version:randomUUID()})).status,409);assert.equal((await n.post('retry',{version:originalVersion})).status,409);
    const recovered=await n.post('recover',{version:authoritative.version,wakeId:authoritative.art.wakeId});assert.ok(recovered.ok);assert.equal(recovered.data.task.art.wakeVersion,originalVersion);
    const second=await n.post('resume',{version:originalVersion});assert.ok(second.ok);assert.equal(second.data.task.version,recovered.data.task.version);assert.equal(second.data.task.art.wakeId,authoritative.art.wakeId);
    assert.ok((await n.post('ack',{version:second.data.task.version,delivery:recovered.data.delivery})).ok);
    const imageStage=await n.submit(recovered.data.delivery,analysis);assert.equal(imageStage.stage,'image');
    await assert.rejects(n.submit(imageStage.delivery,'无图一'));
    await assert.rejects(n.submit(imageStage.delivery,'无图二'));
    assert.equal((await n.submit(imageStage.delivery,'无图三')).status,'stop');
    const error=(await n.get()).task;await n.post('retry',{version:error.version});
    const read=(await n.post('get')).data.task;assert.equal(read.art.wakeVersion,error.version);const retry=await n.post('retry',{version:error.version});assert.ok(retry.ok);assert.equal(retry.data.task.art.wakeId,read.art.wakeId);assert.equal(retry.data.task.version,read.version);
  });
}finally{f.control.defaultGate=null;f.control.onDefault=null;await f.close();}
if(failures.length)throw new AggregateError(failures.map(x=>Error(x.name+': '+x.error)),'Art review engineering failed');
console.log(JSON.stringify({ok:true,completed,productionWrites:0,paidImageCalls:0,judgeTransport:'isolated fixture',imageDecode:'actual Sharp',storage:'actual temporary SQLite'}));
