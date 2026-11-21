import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {reviewFixture} from './gpt-review-engineering.mjs';
const require=createRequire(import.meta.url),sharp=require('sharp');
const f=await reviewFixture(),scope='d'.repeat(64),passed=[],failed=[];
const image=async n=>'data:image/png;base64,'+(await sharp({create:{width:192,height:128,channels:4,background:{r:n*17%255,g:n*31%255,b:n*47%255,alpha:1}}}).png().toBuffer()).toString('base64');
const original=await image(1),token=await f.authorize();
const analysis=JSON.stringify({problem:'小屋主体和门被树冠遮挡，近岸路径没有桥梁',cause:'树冠占据中心，水面两侧缺少连续通行结构',direction:'移动树木并建设落地木桥，保留小屋与画面风格',check:'核对屋顶与完整门口，沿石路木桥走到远岸门前'});
const recap=JSON.stringify({problem:'几轮调整后小屋清楚但桥头仍未与石路相接',cause:'只处理桥面而未统筹两岸的高度及地形关系',direction:'保留已改善的小屋，从桥头重新安排落地路径',check:'核对两端支撑、近岸石路、远岸门口是否连续'});
async function check(name,run){try{await run();passed.push(name);console.log('PASS '+name);}catch(error){failed.push({name,error:error.stack});console.error('FAIL '+name+' '+error.message);}}
async function task(queued=true){
  const base={id:randomUUID(),scope,device:'queue-original-device',cid:'queue-original-cid',messageId:'queue-source-user',kind:'art',...(queued?{executor:'queue-v1'}:{}),title:'原创小屋自动流',goal:'露出小屋和门，并建设连接两岸路径的木桥',text:'原图与原目标',images:[],reference:[original]};
  const post=(op,fields={},user)=>{const b={...base,op,...fields};if(!['create','resume','retry'].includes(op))delete b.executor;return f.api(b,user);};
  const created=await post('create');assert.ok(created.ok,created.data.error);
  const delivery=randomUUID(),claim=await post('claim',{version:created.data.task.version,delivery});assert.ok(claim.ok,claim.data.error);
  const pair=await f.link(delivery,token);assert.ok((await post('confirm',pair.result._meta.sd2ReviewProof)).ok);
  const get=async()=>(await f.q.getTask('review-a',scope,base.id)).task,connection=(await get()).connected;
  assert.ok((await post('ack',{version:(await get()).version,delivery})).ok);
  const submit=(ticket,text,pictures=[])=>f.q.revisionForTool('review-a',ticket,text,pictures.map((_,i)=>'queue-file-'+ticket+'-'+i),async()=>pictures,connection);
  return {base,post,get,delivery,submit};
}
async function next(n){
  const current=await n.get();assert.equal(current.phase,'feedback');assert.equal(current.art.executor,'queue-v1');assert.equal(current.art.wake.op,'advance');
  const fields={version:current.version,wakeId:current.art.wake.id},claim=await n.post('recover',fields);assert.ok(claim.ok,claim.data.error);
  assert.equal(claim.data.task.phase,'delivering');assert.ok(claim.data.delivery);assert.notEqual(claim.data.delivery,current.delivery);
  const again=await n.post('recover',fields);assert.ok(again.ok,again.data.error);assert.equal(again.data.delivery,claim.data.delivery,'lost response recovers the same durable delivery');assert.equal(again.data.task.version,claim.data.task.version);
  assert.ok((await n.post('ack',{version:claim.data.task.version,delivery:claim.data.delivery})).ok);
  return claim.data.delivery;
}
try{
  await check('accepted analysis queues a durable next step without handing it to the model',async()=>{
    const n=await task(),r=await n.submit(n.delivery,analysis),t=await n.get();
    assert.equal(r.status,'continue');assert.equal(r.handoff,'queue');assert.equal(r.delivery,undefined);assert.equal(r.instructions,undefined);
    assert.equal(t.phase,'feedback');assert.equal(t.delivery,n.delivery);assert.equal(t.art.stage,'image');assert.equal(t.art.wake.op,'advance');assert.equal(t.art.totalChanges,0);
    const again=await n.submit(n.delivery,analysis),same=await n.get();assert.equal(again.handoff,'queue');assert.equal(same.version,t.version);assert.equal(same.art.wake.id,t.art.wake.id);assert.equal(same.art.receipts.length,1);
    const status=(await n.post('status')).data.task;assert.equal(status.art.executor,'queue-v1');assert.equal(status.art.wakeOp,'advance');assert.equal(status.art.wakeId,t.art.wake.id);
  });
  await check('only the original owner device conversation and source can take a queued step',async()=>{
    const n=await task();await n.submit(n.delivery,analysis);const t=await n.get(),fields={version:t.version,wakeId:t.art.wake.id};
    for(const patch of [{device:'other-device'},{cid:'other-cid'},{messageId:'other-source'},{wakeId:randomUUID()}]){const r=await n.post('recover',{...fields,...patch});assert.equal(r.status,409);}
    assert.equal((await n.post('recover',fields,{user:'review-b',expected:'review-b'})).status,404);
    assert.equal((await n.get()).version,t.version);assert.equal((await n.get()).art.totalChanges,0);
  });
  await check('analysis image reject modification and pass preserve one task and exact counters',async()=>{
    const n=await task();await n.submit(n.delivery,analysis);let ticket=await next(n);
    const rejected=await n.submit(ticket,'首版已移动树木，但桥头尚未连接',[await image(2)]);assert.equal(rejected.status,'revise');assert.equal(rejected.handoff,'queue');assert.equal((await n.get()).art.totalChanges,0);
    ticket=await next(n);f.control.artVerdict={decision:'pass',reason:'小屋与路径均已改善',evidence:'门和屋顶清楚，桥梁与两岸石路连续',change:'',actualImage:true,better:true};
    const result=await n.submit(ticket,'修好桥头，保留小屋和风格',[await image(3)]),t=await n.get();assert.equal(result.status,'pass');assert.equal(result.handoff,undefined);assert.equal(t.phase,'passed');assert.equal(t.id,n.base.id);assert.equal(t.art.totalChanges,1);assert.equal(t.art.recaps.length,0);assert.equal(t.art.stage,'done');assert.equal(t.art.wake,undefined);
    f.control.artVerdict=null;
  });
  await check('pause wins over queued advancement and preserves accepted analysis',async()=>{
    const n=await task();await n.submit(n.delivery,analysis);const t=await n.get();assert.ok((await n.post('pause',{version:t.version})).ok);
    const paused=await n.get(),r=await n.post('recover',{version:t.version,wakeId:t.art.wake.id});assert.equal(r.status,409);assert.equal((await n.get()).version,paused.version);assert.equal(paused.art.analysis,analysis);assert.equal(paused.art.totalChanges,0);
    assert.equal((await n.submit(n.delivery,analysis)).status,'stop');
  });
  await check('a normal source-bound resume upgrades legacy execution without restarting analysis',async()=>{
    const n=await task(false),legacy=await n.submit(n.delivery,analysis);assert.ok(legacy.delivery);let t=await n.get();assert.equal(t.art.executor,undefined);
    assert.ok((await n.post('pause',{version:t.version})).ok);t=await n.get();
    for(const patch of [{device:'other-device'},{cid:'other-cid'},{messageId:'other-source'}])assert.equal((await n.post('resume',{version:t.version,executor:'queue-v1',...patch})).status,409);
    const resumed=await n.post('resume',{version:t.version,executor:'queue-v1'});assert.ok(resumed.ok,resumed.data.error);assert.equal(resumed.data.task.art.executor,'queue-v1');
    const current=await n.get();assert.equal(current.art.analysis,analysis);assert.equal(current.art.stage,'image');assert.equal(current.art.totalChanges,0);assert.equal(current.art.receipts.length,1);
    const recovered=await n.post('recover',{version:current.version,wakeId:current.art.wake.id});assert.ok(recovered.ok,recovered.data.error);assert.match(recovered.data.instructions,/SD2 负责自动接续全部步骤/);assert.match(recovered.data.instructions,/真实图像制作/);
  });
  await check('three groups and two recaps stop at nine actual modifications',async()=>{
    f.control.artVerdict=null;const n=await task();await n.submit(n.delivery,analysis);let color=10;
    for(let cycle=0;cycle<3;cycle++){
      for(let change=0;change<(cycle===0?4:3);change++){
        const ticket=await next(n),r=await n.submit(ticket,'真实新图，保留原目标和已改善部分',[await image(color++)]);
        const t=await n.get();assert.ok(t.art.totalChanges<=9);if(cycle<2||change<2)assert.equal(r.handoff,'queue');else assert.equal(r.status,'stop');
      }
      if(cycle<2){const t=await n.get();assert.equal(t.art.stage,'recap');const ticket=await next(n),r=await n.submit(ticket,recap);assert.equal(r.handoff,'queue');assert.equal((await n.get()).art.cycle,cycle+1);}
    }
    const t=await n.get();assert.equal(t.phase,'input');assert.equal(t.art.stage,'done');assert.equal(t.art.totalChanges,9);assert.equal(t.art.recaps.length,2);assert.equal(t.art.wake,undefined);
  });
  await check('non-actual images advance twice then stop without counting a modification',async()=>{
    const n=await task();await n.submit(n.delivery,analysis);
    f.control.artVerdict={decision:'revise',reason:'这只是示意图',evidence:'缺少实际场景修改',change:'请交回实际场景改图',actualImage:false,better:false};
    try{for(let i=0;i<3;i++){
      const ticket=await next(n),r=await n.submit(ticket,'非成图材料',[await image(80+i)]),t=await n.get();
      assert.equal(t.art.totalChanges,0);assert.equal(t.art.bestRound,undefined);
      if(i<2){assert.equal(r.handoff,'queue');assert.equal(t.art.wake.op,'advance');}else{assert.equal(r.status,'stop');assert.equal(t.phase,'error');}
    }}finally{f.control.artVerdict=null;}
  });
  await check('pause during judging resumes with the same explicit wake after rejudging',async()=>{
    const n=await task();await n.submit(n.delivery,analysis);const ticket=await next(n);let enter,release;
    const entered=new Promise(r=>{enter=r;});f.control.onDefault=enter;f.control.defaultGate=new Promise(r=>{release=r;});
    let pending;
    try{
      pending=n.submit(ticket,'等待检查的实际图',[await image(85)]);await entered;
      let t=await n.get();assert.ok((await n.post('pause',{version:t.version})).ok);release();assert.equal((await pending).status,'stop');
      f.control.defaultGate=null;f.control.onDefault=null;t=await n.get();
      assert.ok((await n.post('resume',{version:t.version,executor:'queue-v1'})).ok);t=await n.get();const wake=t.art.wake.id;
      const recovered=await n.post('recover',{version:t.version,wakeId:wake});assert.ok(recovered.ok,recovered.data.error);assert.equal(recovered.data.task.phase,'delivering');assert.equal(recovered.data.task.art.wakeId,wake);
      assert.equal((await n.get()).art.wake.id,wake);assert.equal((await n.get()).art.totalChanges,0);
    }finally{release?.();f.control.defaultGate=null;f.control.onDefault=null;await pending?.catch(()=>{});}
  });
  await check('pause before the first claim recovers only on the original source',async()=>{
    const base={id:randomUUID(),scope,device:'queue-before-first-device',cid:'queue-before-first-cid',messageId:'queue-before-first-user',kind:'art',executor:'queue-v1',title:'首条未发恢复',goal:'保留小屋并连接两岸路径',text:'原图和原提问',reference:[original],images:[]};
    const call=(op,fields={})=>f.api({...base,executor:undefined,op,...fields});
    const created=await f.api({...base,op:'create'});assert.ok(created.ok);assert.equal(created.data.task.deliveryKey,'');
    assert.ok((await call('pause',{version:created.data.task.version})).ok);
    const paused=(await call('get')).data.task,resumed=await call('resume',{version:paused.version,executor:'queue-v1'});assert.ok(resumed.ok);
    const fields={version:resumed.data.task.version,wakeId:resumed.data.task.art.wakeId};assert.equal((await call('recover',{...fields,messageId:'another-source'})).status,409);
    const claimed=await call('recover',fields);assert.ok(claimed.ok,claimed.data.error);assert.equal(claimed.data.task.phase,'delivering');assert.ok(claimed.data.delivery);assert.equal(claimed.data.task.sourceConfirmed,false);assert.equal(claimed.data.task.art.totalChanges,0);
    assert.equal((await call('recover',fields)).data.delivery,claimed.data.delivery);
  });
}finally{f.control.artVerdict=null;await f.close();}
if(failed.length)throw new AggregateError(failed.map(x=>Error(x.name+': '+x.error)),'Queued art engineering failed');
console.log(JSON.stringify({ok:true,groups:passed.length,passed,productionWrites:0,paidImageCalls:0,storage:'actual temporary SQLite',images:'actual Sharp',modelTransport:'isolated fixture'}));
