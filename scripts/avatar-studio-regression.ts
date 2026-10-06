import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeDescriptionOutput, validateDescriptionConstraints } from '../src/lib/avatar-random/description-contract';
import { AvatarDescriptionError, inspectDescription, resolveDescription, type DescriptionStore } from '../src/lib/avatar-random/description-parser';
import { avatarLayout, avatarOutputCount, compileContactSheet, withAvatarLayout } from '../src/lib/avatar-random/layout';
import { emptyRules, type AvatarCandidate, type AvatarConstraints, type AvatarPlan } from '../src/lib/avatar-random/types';
import { avatarKey, avatarPlanKey, avatarRecordKey, avatarReadKeys } from '../src/lib/avatar-random/storage-keys';
import { avatarCellRect, containImageSize } from '../src/lib/avatar-random/sheet-geometry';

const description = '30岁，短发';
const valid = { summary:'希望是30岁的短发人物',soft:{},clarifications:[],explicit: { age: { value: 30, evidence: '30岁' } }, details: [], scopes: [], background: '', unrecognized: [], conflicts: [] };
function memory() {
  let raw: string | null = null, cache: AvatarConstraints | null = null;
  const responses = new Map<string, string>();
  const store: DescriptionStore = {
    readCache: async () => cache, readAttempt: async () => raw,
    createAttempt: async next => { if (raw) return false; raw = next; return true; },
    replaceAttempt: async (expected, next) => { if (expected !== raw) return false; raw = next; return true; },
    saveResponse: async (id, content) => { responses.set(id, content); }, readResponse: async id => responses.get(id) ?? null,
    complete: async (expected, next, parsed) => { if (raw !== expected) return false; raw = next; cache = parsed; return true; },
  };
  return { store, responses, setRaw: (value: string) => { raw = value; } };
}
async function main() {
  let cases = 0;
  assert.equal(validateDescriptionConstraints(decodeDescriptionOutput('```json\n'+JSON.stringify(valid)+'\n```'), description).explicit.age.value, '30'); cases++;
  for (const value of [ { ...valid, extra: true }, { ...valid, explicit: { age: { value: 30, evidence: '' } } }, { ...valid, scopes: ['unsupported'] }, { ...valid, background: '海边' }, { ...valid, explicit: { age: { value: 100, evidence: '30岁' } } } ]) { assert.throws(() => validateDescriptionConstraints(value, description)); cases++; }
  const unresolved=validateDescriptionConstraints({...valid,conflicts:['年龄冲突'],unrecognized:['要求待确认']},description);assert.equal(unresolved.conflicts.length,1);assert.equal(unresolved.unrecognized.length,1);cases++;
  const first = memory(); let calls = 0;
  const call = async () => { calls++; return { content: JSON.stringify(valid) }; };
  await resolveDescription(description, { approved: true }, first.store, call);
  await resolveDescription(description, { approved: true }, first.store, call);
  assert.equal(calls, 1);assert.equal(first.responses.size,1);assert.equal((await inspectDescription(description,first.store)).state,'succeeded');cases++;
  const bad = memory();let badCalls=0;
  await assert.rejects(resolveDescription(description,{approved:true},bad.store,async()=>{badCalls++;return {content:'{}'};}),e=>e instanceof AvatarDescriptionError&&e.parse.state==='failed'&&e.parse.failure?.field==='explicit');
  const failed=await inspectDescription(description,bad.store);assert.equal(failed.canRecheck,true);
  await assert.rejects(resolveDescription(description,{approved:false,recheck:true},bad.store,async()=>{badCalls++;return {content:JSON.stringify(valid)};}));assert.equal(badCalls,1);cases++;
  const legacy=memory();const old=JSON.stringify({state:'pending',createdAt:'2026-01-01T00:00:00Z'});legacy.setRaw(old);
  const unknown=await inspectDescription(description,legacy.store);assert.equal(unknown.state,'unknown');assert.equal(await legacy.store.readAttempt(),old);
  await assert.rejects(resolveDescription(description,{approved:true},legacy.store,call));assert.equal(calls,1);cases++;
  const timeout=memory();await assert.rejects(resolveDescription(description,{approved:true},timeout.store,async()=>{throw Object.assign(new Error('timeout'),{code:'musk_api_timeout'});}));
  const lost=await inspectDescription(description,timeout.store);assert.equal(lost.state,'unknown');assert.equal(lost.cost,'unknown');assert.equal(lost.retryToken,undefined);
  await assert.rejects(resolveDescription(description,{approved:true,retryToken:'unknown-cannot-retry'},timeout.store,call));assert.equal(calls,1);cases++;
  const race=memory();let raceCalls=0;let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  const inFlight=resolveDescription(description,{approved:true},race.store,async()=>{raceCalls++;await gate;return {content:JSON.stringify(valid)};});
  await new Promise(resolve=>setImmediate(resolve));await assert.rejects(resolveDescription(description,{approved:true},race.store,call));release();await inFlight;assert.equal(raceCalls,1);cases++;
  const receipt=memory();const requestId='saved-request';receipt.setRaw(JSON.stringify({version:2,state:'pending',requestId,createdAt:new Date().toISOString()}));receipt.responses.set(requestId,JSON.stringify(valid));
  assert.equal((await inspectDescription(description,receipt.store)).canRecheck,true);await resolveDescription(description,{approved:false,recheck:true},receipt.store,call);assert.equal(calls,1);cases++;
  const persistence=memory();const complete=persistence.store.complete;persistence.store.complete=async()=>{throw new Error('disk');};
  await assert.rejects(resolveDescription(description,{approved:true},persistence.store,call),e=>e instanceof AvatarDescriptionError&&e.parse.failure?.stage==='persistence'&&e.parse.canRecheck);
  assert.equal((await inspectDescription(description,persistence.store)).state,'unknown');
  persistence.store.complete=complete;await resolveDescription(description,{approved:false,recheck:true},persistence.store,call);assert.equal(calls,2);cases++;
  const cells=Array.from({length:4},(_,i)=>({characterId:`person-${i}`,members:[{fields:{},details:[],seed:String(i),ruleVersion:'1.0.0',featureBudget:2}],standardDescription:`不同人物条件${i}`,prompt:'画面中恰好1个人',compilerVersion:'1.0.0',rules:emptyRules,constraints:unresolved} satisfies AvatarCandidate));
  const oldPlan:AvatarPlan={id:'old-plan',candidates:cells,model:'test',quality:'auto',resolution:'1K',aspectRatio:'1:1',settingsRevision:24,unitCredits:5,referenceIds:[],createdAt:'2026-10-05T00:00:00Z'};
  assert.equal(avatarLayout(oldPlan),'independent');assert.equal(avatarOutputCount(oldPlan),4);const sheet=withAvatarLayout(oldPlan,'contact-sheet');assert.equal(avatarOutputCount(sheet),1);assert.equal(sheet.unitCredits!*avatarOutputCount(sheet),5);assert.ok(sheet.sheetPrompt?.includes('左下格'));assert.ok(!sheet.sheetPrompt?.includes('画面中恰好1个人'));assert.deepEqual(sheet.candidates.map(c=>c.characterId),cells.map(c=>c.characterId));assert.equal(avatarOutputCount(withAvatarLayout(sheet,'independent')),4);cases++;
  assert.throws(()=>compileContactSheet(cells.slice(0,2)));assert.throws(()=>withAvatarLayout({...oldPlan,referenceIds:['whole-image']},'contact-sheet'));assert.throws(()=>compileContactSheet(cells.map(c=>({...c,baselineAssetId:'single-person'}))));cases++;
  const nineCells=Array.from({length:9},(_,i)=>({...cells[0],characterId:`nine-${i}`,rules:{...emptyRules,layout:'contact-sheet-9' as const,candidates:9 as const}}));
  const nine=withAvatarLayout({...oldPlan,candidates:nineCells},'contact-sheet-9');
  assert.throws(()=>withAvatarLayout(nine,'independent'));
  const legacyFieldsBefore=JSON.stringify(cells.map(c=>c.members[0].fields));
  assert.deepEqual(sheet.candidates.map(c=>c.members[0].fields),cells.map(c=>c.members[0].fields));assert.equal(JSON.stringify(cells.map(c=>c.members[0].fields)),legacyFieldsBefore);assert.equal(sheet.candidates[0].members[0].fields.nationality,undefined);assert.equal(sheet.candidates[0].members[0].fields.ancestry,undefined);cases++;
  assert.equal(avatarOutputCount(nine),1);assert.equal(nine.candidates.length,9);assert.ok(nine.sheetPrompt?.includes('3×3'));assert.ok(nine.sheetPrompt?.includes('正中格'));assert.ok(nine.sheetPrompt?.includes('右下格'));cases++;
  assert.throws(()=>compileContactSheet(cells,'contact-sheet-9'));assert.throws(()=>compileContactSheet(nineCells.map(c=>({...c,characterId:'same'})),'contact-sheet-9'));assert.throws(()=>withAvatarLayout({...nine,referenceIds:['whole-image']},'contact-sheet-9'));cases++;
  assert.ok(avatarPlanKey('account',nine).includes(':sheet-plan:'));assert.ok(avatarRecordKey('account',{id:'nine-result',layout:'contact-sheet-9'}).includes(':sheet-record:'));cases++;
  assert.deepEqual(containImageSize(400,400,1200,600),{width:400,height:200});assert.deepEqual(containImageSize(300,600,300,900),{width:200,height:600});
  assert.deepEqual(avatarCellRect(1024,1024,3,8),{x:682,y:682,width:342,height:342});assert.deepEqual(avatarCellRect(1200,600,2,1),{x:600,y:0,width:600,height:300});assert.throws(()=>avatarCellRect(1024,1024,3,9));cases++;
  for(const submitted of [false,true]){const p={...sheet,id:'sheet-private',...(submitted?{sourceTaskId:'paid-task'}:{})};const database=new Map([[avatarPlanKey('account',p),p]]);assert.equal(database.get(avatarKey('account','plan',p.id)),undefined);assert.equal(avatarReadKeys('account','plan',p.id).map(k=>database.get(k)).find(Boolean),p);assert.ok(!avatarReadKeys('other-account','plan',p.id).some(k=>database.has(k)));}cases++;
  const generation={id:'sheet-result',layout:'contact-sheet' as const,rules:emptyRules};assert.notEqual(avatarRecordKey('account',generation),avatarKey('account','record',generation.id));assert.equal(avatarPlanKey('account',oldPlan),avatarKey('account','plan',oldPlan.id));cases++;
  // Synthetic text reproduces only the confirmed singleton-object wrapper, not private input/output.
  const wrapped={...valid,explicit:{gender:[{value:'男性',evidence:'男',excluded:[]}]}};
  const normalized=validateDescriptionConstraints(wrapped,'男，短发');assert.equal(normalized.explicit.gender.value,'男性');assert.equal(normalized.explicit.gender.evidence,'男');assert.ok(Array.isArray(wrapped.explicit.gender));cases++;
  for(const value of [null,'男性',[],[{value:'男性',evidence:'男'},{value:'女性',evidence:'女'}],[{value:'男性'}],[{value:'男性',evidence:'不存在的原文'}]]){assert.throws(()=>validateDescriptionConstraints({...valid,explicit:{gender:value}},'男，短发'));cases++;}
  const negative=validateDescriptionConstraints({...wrapped,explicit:{gender:[{value:'',evidence:'不要男性',excluded:['男性']}]},conflicts:['要求冲突'],unrecognized:['要求未知'],members:[{explicit:{age:[{value:30,evidence:'30岁'}]},details:[],relationship:''}]},'不要男性，30岁');assert.deepEqual(negative.explicit.gender.excluded,['男性']);assert.deepEqual(negative.conflicts,['要求冲突']);assert.deepEqual(negative.unrecognized,['要求未知']);assert.equal(negative.members![0].explicit.age.value,'30');cases++;
  const saved=memory();saved.setRaw(JSON.stringify({version:2,state:'failed',requestId:'singleton-receipt',responseId:'singleton-receipt',createdAt:new Date().toISOString(),cost:'response-received',failure:{field:'explicit.gender',stage:'validation'}}));saved.responses.set('singleton-receipt',JSON.stringify(wrapped));let recheckCalls=0;
  const recovered=await resolveDescription('男，短发',{approved:false,recheck:true},saved.store,async()=>{recheckCalls++;throw new Error('must not call model');});assert.equal(recheckCalls,0);assert.equal(recovered.explicit.gender.value,'男性');assert.equal((await inspectDescription('男，短发',saved.store)).state,'succeeded');cases++;
  for (const background of ['',null,'短发',['短发']]) { const input={...valid,background};const before=JSON.stringify(input);assert.equal(validateDescriptionConstraints(input,description).background,background===null?'':Array.isArray(background)?background[0]:background);assert.equal(JSON.stringify(input),before);cases++; }
  for (const background of [[],['短发','短发'],['短发','30岁'],[null],[{}],[['短发']],{},30,true,['海边'],['短发'.repeat(151)]]) { assert.throws(()=>validateDescriptionConstraints({...valid,background},description));cases++; }
  // Reauthored synthetic same-shape data; private receipt/account rows are never source fixtures.
  const receiptDescription='30至40岁男性，短发，有短胡茬，不戴眼镜，日常衣服，背景干净。';
  const receiptShape={summary:'合成检查：成年男性、短发胡茬、不戴眼镜、日常穿着和干净背景。',explicit:{age:{value:'30-40',evidence:'30至40岁'},gender:{value:'男性',evidence:'男性'},hair_length:{value:'短发',evidence:'短发'},facial_hair:{value:'淡胡茬',evidence:'短胡茬'},glasses:{value:'不戴眼镜',evidence:'不戴眼镜',excluded:['黑框眼镜','细框眼镜']},clothing:{value:'简洁日常衣服',evidence:'日常衣服'}},soft:{},details:[{value:'淡胡茬',kind:'trace',position:'下颌与上唇周围',side:'none',prominence:'secondary',evidence:'短胡茬'}],scopes:['ordinary'],background:['背景干净'],unrecognized:[],conflicts:[],clarifications:[]};
  const beforeShape=JSON.stringify(receiptShape), shapeResult=validateDescriptionConstraints(receiptShape,receiptDescription,true);
  assert.equal(shapeResult.background,'背景干净');assert.equal(shapeResult.explicit.age.value,'30-40');assert.deepEqual(shapeResult.explicit.glasses.excluded,['黑框眼镜','细框眼镜']);assert.equal(shapeResult.details[0].kind,'natural');assert.equal(shapeResult.details[0].side,'none');assert.equal(shapeResult.details[0].position,'胡须区域（位置未指定）');assert.equal(shapeResult.details[0].evidence,'短胡茬');assert.equal(JSON.stringify(receiptShape),beforeShape);cases++;
  const located={...receiptShape,explicit:{facial_hair:{value:'淡胡茬',evidence:'左侧下巴短胡茬'}},details:[{...receiptShape.details[0],evidence:'左侧下巴短胡茬',position:'下巴',side:'left',kind:'natural'}]};const locatedResult=validateDescriptionConstraints(located,receiptDescription+'左侧下巴短胡茬');assert.equal(locatedResult.details[0].position,'下巴');assert.equal(locatedResult.details[0].side,'left');cases++;
  const differentEvidence={...receiptShape,details:[{...receiptShape.details[0],value:'浅旧伤',evidence:'旧伤',position:'眉部',kind:'trace'}]};assert.equal(validateDescriptionConstraints(differentEvidence,receiptDescription+'旧伤').details[0].kind,'trace');cases++;
  const immutableConflict={...valid,explicit:{age:{value:'30',evidence:'30岁',excluded:['30']}},conflicts:[]};const conflictBefore=JSON.stringify(immutableConflict);assert.ok(validateDescriptionConstraints(immutableConflict,description).conflicts.length);assert.equal(JSON.stringify(immutableConflict),conflictBefore);cases++;
  const strictOld=memory();strictOld.setRaw(JSON.stringify({version:2,parserVersion:'1.1.0',state:'failed',requestId:'old-intent',responseId:'old-intent',createdAt:new Date().toISOString(),cost:'response-received'}));strictOld.responses.set('old-intent',JSON.stringify({...valid,summary:undefined}));await assert.rejects(resolveDescription(description,{approved:false,recheck:true},strictOld.store,async()=>{throw Error('must not call model');}),e=>e instanceof AvatarDescriptionError&&e.parse.failure?.field==='summary');cases++;
  let actualReceiptReplay=false;
  if(process.env.AVATAR_PRIVATE_RECEIPT){
    const rows=JSON.parse(readFileSync(process.env.AVATAR_PRIVATE_RECEIPT,'utf8')) as Array<{key:string;value_json:string}>;
    const attempt=rows.find(row=>row.key.includes(':parse-attempt:'))!, response=rows.find(row=>row.key.includes(':parse-response:'))!;assert.ok(attempt&&response);
    const attemptValue=JSON.parse(attempt.value_json), content=JSON.parse(response.value_json).content;const actual=memory();actual.setRaw(attempt.value_json);actual.responses.set(attemptValue.responseId||attemptValue.requestId,content);let paidCalls=0;
    const parsed=await resolveDescription(receiptDescription,{approved:false,recheck:true},actual.store,async()=>{paidCalls++;throw Error('no model on saved raw replay');});
    assert.equal(parsed.background,'背景干净');assert.equal(parsed.explicit.age.value,'30-40');assert.equal(parsed.explicit.facial_hair.value,'淡胡茬');assert.equal(parsed.details[0].kind,'natural');assert.equal(parsed.details[0].position,'胡须区域（位置未指定）');assert.equal((await inspectDescription(receiptDescription,actual.store)).state,'succeeded');assert.equal(actual.responses.get(attemptValue.responseId||attemptValue.requestId),content);assert.equal(paidCalls,0);actualReceiptReplay=true;cases++;
  }
  console.log(JSON.stringify({ok:true,cases,actualReceiptReplay,modelCalls:'in-memory only; no HTTP, DB, image generation or credits',original400:'specific failed field not available'}));
}
void main().catch(e=>{console.error(e);process.exitCode=1;});
