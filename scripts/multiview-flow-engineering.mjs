import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const root=process.cwd(), require=createRequire(import.meta.url), ts=require('typescript');
const checks=[], cache=new Map();
function load(relative){
  const file=path.resolve(root,relative);if(cache.has(file))return cache.get(file);
  const module={exports:{}};cache.set(file,module.exports);
  const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext(code,{module,exports:module.exports,require(name){
    if(name.startsWith('./')||name.startsWith('../'))return load(path.resolve(path.dirname(file),name)+'.ts');
    if(name.startsWith('@/'))return load('src/'+name.slice(2)+'.ts');
    throw new Error('Unexpected import '+name);
  }},{filename:file});return module.exports;
}
function functions(file,names){
  const source=fs.readFileSync(path.join(root,file),'utf8'), ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX), selected=[];
  function visit(node){if(ts.isFunctionDeclaration(node)&&names.includes(node.name?.text))selected.push(node.getText(ast));ts.forEachChild(node,visit);}visit(ast);
  assert.equal(selected.length,names.length);
  return ts.transpileModule(selected.join('\n')+'\nglobalThis.actual={'+names.join(',')+'};',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
}
const restoreContract=load('src/lib/video/multiview-action-restore-contract.ts');
const layout=load('src/lib/video/multiview-reference-layout.ts'), contract=load('src/lib/video/multiview-work-contract.ts');
const info={taskId:'rotation',sourceVersion:'a'.repeat(64),width:512,height:512,timestamps:[0,.2,.4,.6,.8,1,1.2,1.4],duration:1.6};
const slots=[{id:'shot-a',frame:0,name:'正面',manual:true},{id:'shot-b',frame:4,name:'侧面',manual:true}];
const recipe=layout.createMultiviewReferenceRecipe(info,slots,{width:1920,height:1080,background:'#d6dbdf'});
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const parameters={provider:'seedance',model:'seedance-2.5',duration:12,resolution:'720p',ratio:'16:9',project_id:'project',video_card_id:null};
const action={stage:'final',workId:'work',revision:3,inputHash:'b'.repeat(64),recipeHash:hash(recipe),sourceVersion:info.sourceVersion,assetId:'image',outputHash:'c'.repeat(64),editableRecipe:recipe};
function restoreHarness(options={}){
  const snapshot={purpose:'multiview-action',owner:{userId:'owner'},input:{draftPrompt:'十二秒的新动作'},parameters,multiviewAction:{...action,...options.action},privateContext:{global:'NEVER_EXPOSE_FIXED_RULE',module:'NEVER_EXPOSE_FIXED_RULE'}};
  const reads=[];
  const env={exports:{},requireStudioUser(){},USER_VISIBLE_TASK_RETENTION_STATUSES:['active'],
    StudioError:class extends Error{constructor(message,status,code){super(message);this.status=status;this.code=code;}},
    readMultiviewPrivateTaskMarker:()=>({kind:'multiview-action',actionBinding:{runId:'run',workId:'work',revision:3,inputHash:action.inputHash,recipeHash:action.recipeHash}}),
    transformPrivateVideoRun:value=>value,parseMultiviewActionInput:restoreContract.parseMultiviewActionInput,
    getMultiviewWork:async()=>({id:'work',info,sourceVersion:info.sourceVersion,recipe:options.currentRecipe||recipe}),
    parseMultiviewWorkRecipe:contract.parseMultiviewWorkRecipe,multiviewWorkRecipeHash:hash,
    prisma:{videoTask:{findFirst:async query=>{reads.push(query);return options.denied?null:{id:'video',template_studio_run_id:'run'};}},
      videoStudioRun:{findFirst:async()=>({id:'run',draft_id:'draft',snapshot_json:JSON.stringify(snapshot)})},
      asset:{findFirst:async()=>options.imageMissing?null:{original_url:'/uploads/fixture.png'}}},
  };
  vm.runInNewContext(functions('src/lib/video/multiview-action-restore.server.ts',['restoreMultiviewVideoInput']),env);
  return {read:id=>env.actual.restoreMultiviewVideoInput({id:'owner'},id),reads};
}
let api=restoreHarness();let restored=await api.read('video');
assert.equal(restored.text,'十二秒的新动作');assert.equal(restored.parameters.duration,12);assert.equal(hash(restored.recipe),hash(recipe));
assert.ok(!JSON.stringify(restored).includes('NEVER_EXPOSE_FIXED_RULE'));
assert.equal(api.reads[0].where.OR[0].owner_user_id,'owner');checks.push('selected video restores its own text, duration and exact frozen reference without private rules');
await assert.rejects(restoreHarness({denied:true}).read('other'),error=>error.status===404);checks.push('owner and retained-task filter are required before decoding original inputs');
await assert.rejects(restoreHarness({action:{inputHash:'wrong'}}).read('video'),error=>error.status===409);checks.push('mismatched original task binding is rejected');
restored=await restoreHarness({action:{editableRecipe:undefined}}).read('video');assert.equal(hash(restored.recipe),hash(recipe));checks.push('legacy exact matching recipe remains restorable');
const different=layout.createMultiviewReferenceRecipe(info,[{...slots[0],frame:1},slots[1]],recipe.output);
restored=await restoreHarness({action:{editableRecipe:undefined},currentRecipe:different}).read('video');assert.equal(restored.recipe,null);assert.equal(restored.text,'十二秒的新动作');assert.ok(restored.warnings.length);checks.push('missing historical frames never borrow a newer recipe and still return known input');
restored=await restoreHarness({currentRecipe:different}).read('video');assert.equal(hash(restored.recipe),hash(recipe));checks.push('new immutable recipe wins over changed current work');
restored=await restoreHarness({imageMissing:true}).read('video');assert.equal(restored.referenceImageUrl,null);assert.ok(restored.warnings.length);checks.push('removed original image stays unavailable');

// Execute the real frame-return handler with state adapters, then validate its real recipe.
let frameDraft={schema:2,sourceVersion:info.sourceVersion,slots:[...slots,{id:'shot-c',frame:6,name:'背面',manual:false}],reserve:[],restoreOrder:[],layout:{columns:3,margin:0,gap:0,background:'#d6dbdf'}};
const originalFrameDraft=JSON.stringify(frameDraft);
const picker={draft:frameDraft,visible:true,operation:{current:null},quickFrameLock:{current:null},referenceFrameBackup:{current:null},referenceReturnScroll:{current:null},draftRef:{current:frameDraft},draftEdited:true,saved:true,retainedDraft:'original',undo:null,viewRef:{current:{selected:'shot-c'}},window:{scrollX:0,scrollY:300},Date,
  setReferenceNotice(){},setDraft:next=>{frameDraft=next;picker.draft=next;},setDraftEdited(){},setSaved(){},setRetainedDraft(){},setUndo(){},setView(){},
  setReferenceReplacement:value=>{picker.replacement=value;},setReferenceSelection:value=>{picker.referenceSelection=value;picker.selection=value;},setReferencePicking:value=>{picker.picking=value;}};
vm.runInNewContext(functions('src/app/multiview/page.tsx',['chooseReferenceFrames','finishReferenceFrames']),picker);
picker.actual.chooseReferenceFrames(slots);assert.deepEqual(Array.from(picker.selection),['shot-a','shot-b']);assert.equal(picker.picking,true);assert.ok(contract.parseMultiviewWorkRecipe(frameDraft,info));checks.push('returning to frames starts with the original two selections and a valid editable frame set');
picker.actual.finishReferenceFrames(false);assert.equal(JSON.stringify(frameDraft),originalFrameDraft);assert.equal(picker.picking,false);checks.push('canceling reference adjustment restores the original gallery draft and selection state');
const eight={...frameDraft,slots:info.timestamps.map((_,frame)=>({id:'original-'+frame,frame,name:'',manual:false})),reserve:[]};picker.draft=eight;picker.draftRef.current=eight;
picker.actual.chooseReferenceFrames(slots);picker.actual.finishReferenceFrames(true);assert.equal(picker.draft.slots.length,8);assert.equal(picker.draft.slots[7].id,'original-7');assert.equal(picker.replacement.slots.length,2);checks.push('applying new reference frames preserves all eight original gallery frames');


// Execute the actual preview detail loader; display is committed after input restoration.
const previewSource=fs.readFileSync('src/app/multiview/MultiviewVideoResults.tsx','utf8');
const previewAst=ts.createSourceFile('preview.tsx',previewSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let callback;
function find(node){if(ts.isVariableDeclaration(node)&&node.name.getText(previewAst)==='loadTask')callback=node.initializer.arguments[0].getText(previewAst);ts.forEachChild(node,find);}find(previewAst);assert.ok(callback);
const order=[], ref=()=>({current:0});
const view={URLSearchParams,alive:()=>true,validId:()=>true,currentSequence:ref(),detailSequence:ref(),focusedRef:{current:'new'},viewOnlySelection:{current:''},deliveredSelection:{current:'old'},
  selectionCallback:{current:async id=>{order.push('restore:'+id);return true;}},read:async()=>({items:[{id:'new'}]}),
  setViewOnlyCandidate(){},setCurrentError(){},setDetailLoading(){},setDetailError(){},setSelected:item=>order.push('display:'+item.id),setItems(){},setCurrent(){},rejectAccess(){},setSelectedId(){},mergeMultiviewVideoResults(){}};
vm.runInNewContext(ts.transpileModule('globalThis.readDetail='+callback,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,view);
await view.readDetail('new',false);assert.deepEqual(order,['restore:new','display:new']);checks.push('preview display follows successful matching input restoration');
order.length=0;await view.readDetail('new',false);assert.deepEqual(order,['display:new']);checks.push('background status refresh does not reset edits');
view.deliveredSelection.current='old';view.selectionCallback.current=async()=>false;order.length=0;await view.readDetail('new',false);assert.deepEqual(order,[]);checks.push('failed restoration keeps the prior video and form');
view.deliveredSelection.current='old';view.selectionCallback.current=async()=>{view.detailSequence.current++;return true;};order.length=0;await view.readDetail('new',false);assert.deepEqual(order,[]);checks.push('late previous selection cannot take over a newer selection');

const actionSource=fs.readFileSync('src/app/multiview/MultiviewActionPanel.tsx','utf8');
const actionAst=ts.createSourceFile('action.tsx',actionSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),effects=[];
function actionEffects(node){if(ts.isCallExpression(node)&&node.expression.getText(actionAst)==='useEffect')effects.push(node.arguments[0].getText(actionAst));ts.forEachChild(node,actionEffects);}actionEffects(actionAst);
const restoreEffect=effects.find(value=>value.includes('const raw=localStorage.getItem(videoInputKey)'));
const persistEffect=effects.find(value=>value.includes('localStorage.setItem(videoInputKey'));
assert.ok(restoreEffect&&persistEffect);
const previousDraft={text:'上次修改但尚未生成',parameters:{...parameters,duration:4},referenceImage:true};
const stored=new Map([['video-input',JSON.stringify(previousDraft)]]);
const input={exports:{},referenceImage:false,hydrated:true,props:{restored:{taskId:'video',text:'十二秒的新动作',parameters}},restoredInput:{current:''},videoInputKey:'video-input',
  localStorage:{getItem:key=>stored.get(key)||null,setItem:(key,value)=>stored.set(key,value)},
  parseMultiviewActionInput:restoreContract.parseMultiviewActionInput,
  updateText:value=>{input.text=value;},setParameters:value=>{input.parameters=value;},setVideoDraft:value=>{input.retained=value;},
  setAppliedRunId(){},setSuggestion(){},setBeforeAi(){},setReferenceImage(){},setDraftBlocked(){throw new Error('unexpected storage failure');},setMessage(){}};
vm.runInNewContext('globalThis.restoreInput='+restoreEffect+';globalThis.persistInput='+persistEffect,input);
input.restoreInput();assert.equal(input.text,'十二秒的新动作');assert.equal(input.parameters.duration,12);assert.equal(input.retained.text,previousDraft.text);
input.persistInput();assert.equal(stored.get('video-input'),JSON.stringify(previousDraft));checks.push('selecting a video restores original input while retaining its ungenerated draft for explicit resume');
input.text='当前新修改';input.persistInput();assert.equal(JSON.parse(stored.get('video-input')).text,'当前新修改');checks.push('new edits are retained under this video only');
assert.ok(restoreContract.parseMultiviewActionInput({text:'旧文案',parameters:{...parameters,model:'retired-model-id'}}));checks.push('historical unavailable model is preserved for display instead of silently replaced');
let readOnlyHandler;
function findReadOnly(node){if(ts.isJsxAttribute(node)&&node.name.getText(previewAst)==='onClick'&&node.initializer?.getText(previewAst).includes('onViewOnly?.'))readOnlyHandler=node.initializer.expression.getText(previewAst);ts.forEachChild(node,findReadOnly);}findReadOnly(previewAst);assert.ok(readOnlyHandler);
const readOnlyOrder=[],readOnly={player:{current:{pause(){}}},viewOnlyCandidate:{id:'unrestorable'},viewOnlySelection:{current:''},deliveredSelection:{current:''},onViewOnly:id=>readOnlyOrder.push('read-only:'+id),setSelected:item=>readOnlyOrder.push('display:'+item.id),setDetailError(){},setViewOnlyCandidate(){}};
vm.runInNewContext('globalThis.viewOnly='+readOnlyHandler,readOnly);readOnly.viewOnly();assert.deepEqual(readOnlyOrder,['read-only:unrestorable','display:unrestorable']);checks.push('unrestorable input still has a view-only video path without editable stale input');
const pageSource=fs.readFileSync('src/app/multiview/page.tsx','utf8'),pageAst=ts.createSourceFile('page.tsx',pageSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let reset;
function findReset(node){if(ts.isCallExpression(node)&&node.expression.getText(pageAst)==='useEffect'&&node.arguments[0]?.getText(pageAst).includes('setCarriedAction(null)'))reset=node.arguments[0].getText(pageAst);ts.forEachChild(node,findReset);}findReset(pageAst);assert.ok(reset);
const resetEvents=[],session={query:{get:()=>null},explicitTask:'',restoreSequence:{current:2},restoreLock:{current:true},openedVideo:{current:'old'},incomingVideoDone:{current:()=>resetEvents.push('old-waiter-released')}};
for(const key of ['setIncomingVideo','setCarriedAction','setVideoReturnView','setPreviewTaskId','setPreviewReadOnly','setRestoringVideo','setReferencePicking','setReferenceReplacement','setOriginalEditing','setImagePickerRequest'])session[key]=value=>resetEvents.push([key,value]);
vm.runInNewContext('globalThis.reset='+reset,session);session.reset();assert.ok(resetEvents.some(item=>Array.isArray(item)&&item[0]==='setCarriedAction'&&item[1]===null));assert.equal(session.restoreSequence.current,3);assert.equal(session.incomingVideoDone.current,null);checks.push('account or authority change clears carried inputs, preview state and pending selection');
const cardEffect=effects.find(value=>value.includes('setCards([]);if(!parameters.project_id)'));assert.ok(cardEffect);
let resolveCards;const cardValues=[],cardContext={scope:'owner:work',parameters:{project_id:'project'},input:{current:{parameters:{project_id:'project'}}},active:()=>true,setCards:value=>cardValues.push(value),api:()=>new Promise(resolve=>{resolveCards=resolve;})};
vm.runInNewContext(ts.transpileModule('globalThis.loadCards='+cardEffect,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,cardContext);cardContext.loadCards();resolveCards({video_cards:[{id:'card',title:'真实视频卡'}]});await Promise.resolve();await Promise.resolve();assert.equal(cardValues.at(-1)[0].id,'card');checks.push('video-card options consume the real endpoint video_cards field');
cardContext.loadCards();cardContext.input.current.parameters.project_id='other-project';resolveCards({video_cards:[{id:'old-card',title:'旧项目'}]});await Promise.resolve();await Promise.resolve();assert.equal(cardValues.at(-1).length,0);checks.push('late cards from the previous project cannot replace the current project options');
let activeCallback;
function findActive(node){if(ts.isVariableDeclaration(node)&&node.name.getText(actionAst)==='active')activeCallback=node.initializer.arguments[0].getText(actionAst);ts.forEachChild(node,findActive);}findActive(actionAst);assert.ok(activeCallback);
const lifecycle={scope:'same-work',mounted:{current:true},liveScope:{current:'same-work'},isClientSessionBlocked:()=>false};
vm.runInNewContext('globalThis.active='+activeCallback,lifecycle);assert.equal(lifecycle.active(),true);lifecycle.mounted.current=false;assert.equal(lifecycle.active(),false);checks.push('unmounted previous video editor cannot consume late results or rewrite shared request journals');
const originalMode={referenceEditor:{scope:'source-scope',slots,restored:{taskId:'old-video'},info},currentReferenceWork:{current:'bound-work'},referenceInfo:info,previewTaskId:'old-video',taskId:'rotation',editingWorkId:'base-work',owner:'owner',referenceMounted:true,openedVideo:{current:''},URL,
  window:{location:{href:'https://fixture.invalid/multiview?taskId=new-source&workId=new-work'},history:{state:null,replaceState(_state,_title,url){originalMode.returnUrl=url;}}},
  setCarriedAction:value=>{originalMode.carriedAction=value;},setOriginalEditing:value=>{originalMode.originalEditing=value;},setReferencePicking(){},setExpanded(){},setImagePickerRequest:value=>{originalMode.pickerRequested=value;},
  setLocation:value=>{originalMode.location=value;},setEditorWork:value=>{originalMode.work=value;},setReferenceEditor:value=>{originalMode.editor=value;},setPreviewTaskId:value=>{originalMode.video=value;}};
vm.runInNewContext(functions('src/app/multiview/page.tsx',['changeOriginal','returnToAction']),originalMode);
originalMode.actual.changeOriginal({text:'保留这个修改',parameters});assert.equal(originalMode.carriedAction.input.text,'保留这个修改');assert.equal(originalMode.originalEditing,true);assert.ok(originalMode.pickerRequested>0);checks.push('changing the original image opens the existing picker and retains action input without requiring an old rotation recipe');
originalMode.referenceMounted=false;originalMode.actual.returnToAction();assert.equal(originalMode.location.taskId,'rotation');assert.equal(originalMode.editor.carry.text,'保留这个修改');assert.equal(originalMode.work.id,'bound-work');assert.equal(new URL(originalMode.returnUrl,'https://fixture.invalid').searchParams.get('workId'),'bound-work');checks.push('returning after an original-image change restores the same draft and media source route without generation');
const preferenceRead=effects.find(value=>value.includes('const preference=localStorage.getItem(referencePreferenceKey)'));
const preferenceWrite=effects.find(value=>value.includes('localStorage.setItem(referencePreferenceKey'));
assert.ok(preferenceRead&&preferenceWrite);
const preferenceStorage=new Map([['work-input',{referenceImage:true}]]),preferences={hydrated:true,props:{work:{id:'work'}},referencePreferenceKey:'work-preference',requestKey:'work',referencePreferenceReady:'',referenceImage:false,
  localStorage:{getItem:key=>key==='work:input'?JSON.stringify(preferenceStorage.get('work-input')):preferenceStorage.get(key)||null,setItem:(key,value)=>preferenceStorage.set(key,value)},
  setReferenceImage:value=>{preferences.referenceImage=value;},setReferencePreferenceReady:value=>{preferences.referencePreferenceReady=value;},setMessage(){}};
vm.runInNewContext('globalThis.readPreference='+preferenceRead+';globalThis.writePreference='+preferenceWrite,preferences);
preferences.writePreference();assert.equal(preferenceStorage.has('work-preference'),false);preferences.readPreference();preferences.writePreference();assert.equal(preferenceStorage.get('work-preference'),'true');checks.push('image-reference preference survives video restoration without editing text or overwriting it with an initial default');
const composerFile='src/app/multiview/MultiviewReferenceComposer.tsx';
const removal={exports:{},hydrated:true,busy:false,missingRecipe:false,drag:{current:null},props:{active:true},selected:slots[1].id,
  recipeRef:{current:recipe},canvas:{current:{focus(){}}},recipe,history:[],future:[],syncAdjust:true,valid:()=>true,
  setRecipe:next=>{removal.recipe=next;},setHistory:next=>{removal.history=next(removal.history);},setFuture:next=>{removal.future=typeof next==='function'?next(removal.future):next;},setSelected:next=>{removal.selected=next;},setMessage(){}};
vm.runInNewContext(functions(composerFile,['edit','removeSelectedImage','onCanvasKeyDown']),removal);
let prevented=0;const deletion={key:'Delete',repeat:false,ctrlKey:false,metaKey:false,altKey:false,target:{isContentEditable:false,closest:()=>({tagName:'INPUT'})},preventDefault(){prevented++;}};
removal.actual.onCanvasKeyDown(deletion);assert.equal(removal.history.length,0);assert.equal(prevented,0);checks.push('Delete in text or select controls leaves the selected canvas image unchanged');
deletion.target.closest=()=>null;removal.actual.onCanvasKeyDown(deletion);assert.equal(removal.history.length,1);assert.equal(removal.selected,'');
assert.deepEqual(removal.recipe.placements[0],recipe.placements[0]);assert.deepEqual(removal.history[0],recipe);checks.push('Delete removes only the selected image and records one undo even with synchronized adjustment enabled');
const removedRecipe=contract.parseMultiviewWorkRecipe(removal.recipe,info);assert.ok(removedRecipe);
const pixels=layout.referencePixelGeometry(removedRecipe,info),removedImage=pixels.placements.find(item=>item.slotId===slots[1].id);
assert.ok(removedImage.x+removedImage.width<=0&&removedImage.y+removedImage.height<=0);checks.push('removed image stays absent after the actual saved-recipe parser and pixel geometry roundtrip');
const sharp=require('sharp'),frame=async color=>sharp({create:{width:16,height:16,channels:4,background:color}}).png().toBuffer();
const render={exports:{},Buffer,sharp,referencePixelGeometry:layout.referencePixelGeometry};
vm.runInNewContext(functions('src/lib/video/multiview.ts',['composeMultiviewReferencePng']),render);
const png=await render.actual.composeMultiviewReferencePng({id:'owner'},'rotation',info,[await frame('#ff0000'),await frame('#0000ff')],removedRecipe);
const sample=await sharp(png).extract({left:Math.floor(recipe.output.width*.75),top:Math.floor(recipe.output.height*.5),width:1,height:1}).raw().toBuffer();
assert.deepEqual([...sample],[214,219,223,255]);checks.push('actual server PNG composition omits the deleted image instead of exporting a preview-only change');
const composerAst=ts.createSourceFile(composerFile,fs.readFileSync(composerFile,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let undoClick;
function findUndo(node){if(ts.isJsxElement(node)&&node.openingElement.tagName.getText(composerAst)==='button'&&node.getText(composerAst).includes('<Undo2'))undoClick=node.openingElement.attributes.properties.find(item=>item.name?.getText(composerAst)==='onClick').initializer.expression.getText(composerAst);ts.forEachChild(node,findUndo);}findUndo(composerAst);assert.ok(undoClick);
removal.edit=removal.actual.edit;vm.runInNewContext('globalThis.undo='+undoClick,removal);removal.undo();assert.deepEqual(removal.recipe,recipe);assert.equal(removal.future.length,1);checks.push('existing undo restores the removed image and retains it for redo');
removal.selected=slots[1].id;deletion.key='Backspace';removal.actual.onCanvasKeyDown(deletion);assert.equal(removal.recipe.placements[1].x,-8);checks.push('Mac Delete key reported as Backspace uses the same single-image removal');
const empty={exports:{},missingRecipe:false,hasVisibleImages:false};vm.runInNewContext(functions(composerFile,['prepareForVideo']),empty);
await assert.rejects(empty.actual.prepareForVideo(),error=>error.message.includes('拼图中没有图像'));checks.push('clearing every canvas image stops reference preparation before any save or generation call');
const workFile='src/app/multiview/MultiviewWorks.tsx',workAst=ts.createSourceFile(workFile,fs.readFileSync(workFile,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let openWorkEffect;
function findWorkEffect(node){if(ts.isCallExpression(node)&&node.expression.getText(workAst)==='useEffect'&&node.arguments[0]?.getText(workAst).includes('const id = initialWorkId'))openWorkEffect=node.arguments[0].getText(workAst);ts.forEachChild(node,findWorkEffect);}findWorkEffect(workAst);assert.ok(openWorkEffect);
const opened=[],library={loadedIdentity:'owner',identity:'owner',initialWorkId:'',kind:'reference',preferences:{selected:'last-work'},setWork(){},fetchDetail:id=>opened.push(id)};
vm.runInNewContext('globalThis.enter='+openWorkEffect,library);library.enter();assert.deepEqual(opened,[]);checks.push('reference-collage entry shows the thumbnail library despite a previously selected work');
library.initialWorkId='explicit-work';library.enter();assert.equal(opened.at(-1),'explicit-work');library.initialWorkId='';library.kind=undefined;library.enter();assert.equal(opened.at(-1),'last-work');checks.push('explicit work links and ordinary work-library restoration keep their existing behavior');
let replaceFramesEffect;
function findReplaceFrames(node){if(ts.isCallExpression(node)&&node.expression.getText(composerAst)==='useEffect'&&node.arguments[0]?.getText(composerAst).includes('const replacement=props.replacementSlots'))replaceFramesEffect=node.arguments[0].getText(composerAst);ts.forEachChild(node,findReplaceFrames);}findReplaceFrames(composerAst);assert.ok(replaceFramesEffect);
const vertical=layout.createMultiviewReferenceRecipe(info,slots,{...recipe.output,layout:'vertical'});vertical.placements[0].x+=.1;
const replacementSlots=slots.map((slot,index)=>({...slot,id:'new-'+index,frame:slot.frame+1}));
const replacing={hydrated:true,props:{info,replacementSlots:{slots:replacementSlots,token:1}},recipeRef:{current:{...vertical,placements:vertical.placements.map((item,index)=>index?{...item,x:-8,y:-8}:item)}},
  createMultiviewReferenceRecipe:layout.createMultiviewReferenceRecipe,edit:next=>{replacing.next=next;},setMissingRecipe(){},setActiveView(){},setSelected(){}};
vm.runInNewContext(ts.transpileModule('globalThis.replaceFrames='+replaceFramesEffect,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,replacing);replacing.replaceFrames();
assert.ok(replacing.next.placements[1].x>=0&&replacing.next.placements[1].y>=.5,'new reference frame remains deleted');
assert.equal(hash(replacing.next.placements[0]),hash({...vertical.placements[0],slotId:replacementSlots[0].id}));assert.ok(contract.parseMultiviewWorkRecipe(replacing.next,info));checks.push('replacing frames restores a deleted image inside its original vertical panel while preserving the other placement');
replacing.recipeRef.current={...vertical,placements:vertical.placements.map(item=>({...item,x:-8,y:-8}))};replacing.replaceFrames();
assert.ok(layout.referencePixelGeometry(replacing.next,info).placements.every(item=>item.x>=0&&item.y>=0));checks.push('reselecting reference frames recovers a completely cleared canvas');
function previewValue(name,callback=false){let found;function visit(node){if(ts.isVariableDeclaration(node)&&node.name.getText(previewAst)===name)found=(callback?node.initializer.arguments[0]:node.initializer).getText(previewAst);ts.forEachChild(node,visit);}visit(previewAst);assert.ok(found,name);return found;}
const galleryFocus={selectedId:'',galleryOnly:true,currentTaskId:'previous-task',items:[{id:'previous-video'}]};
vm.runInNewContext('globalThis.focused='+previewValue('focusedId'),galleryFocus);assert.equal(galleryFocus.focused,'');
const previewEffects=[];function collectPreviewEffects(node){if(ts.isCallExpression(node)&&node.expression.getText(previewAst)==='useEffect')previewEffects.push(node.arguments[0].getText(previewAst));ts.forEachChild(node,collectPreviewEffects);}collectPreviewEffects(previewAst);
const galleryState={identity:'owner:authority',loadedIdentity:'owner:authority',selectionKey:'selection',initialTaskId:undefined,currentTaskId:undefined,galleryOnly:true,active:false,
  controllers:{current:new Set()},listSequence:{current:0},detailSequence:{current:0},currentSequence:{current:0},deliveredSelection:{current:''},player:{current:null},
  sessionStorage:{getItem(){galleryState.storageReads++;return 'previous-video';}},storageReads:0,loadList(){}};
for(const name of ['ViewOnlyCandidate','Items','Cursor','Current','Selected','SelectedId','Notice','DetailError','CurrentError','MediaError','PlayRequest','LoadedIdentity'])galleryState['set'+name]=value=>{galleryState[name]=value;};
const galleryInit=previewEffects.find(value=>value.includes('setLoadedIdentity(identity)'));
vm.runInNewContext('globalThis.initialize='+galleryInit,galleryState);galleryState.initialize();assert.equal(galleryState.storageReads,0);assert.equal(galleryState.SelectedId,'');
checks.push('action gallery ignores the last viewed video and starts with previews only');
const galleryDeactivate=previewEffects.find(value=>value.includes('loadedIdentity === identity && active'));
vm.runInNewContext('globalThis.activate='+galleryDeactivate,galleryState);galleryState.SelectedId='previous-video';galleryState.activate();assert.equal(galleryState.SelectedId,'');assert.equal(galleryState.Selected,null);
checks.push('returning to the action gallery clears the prior detail selection instead of reopening it');
const sourceVideos=[{id:'action',title:'动作视频',status:'success'},{id:'rotation',title:'旋转视频',status:'success'}],galleryReads=[];
const videoResults=load('src/app/multiview/multiview-video-results.ts');
const galleryReader={galleryOnly:true,owner:'owner',controllers:{current:new Set()},AbortController,AbortSignal,URLSearchParams,multiviewVideoStatusLabels:videoResults.multiviewVideoStatusLabels,
  fetch:async(url,options)=>{galleryReads.push({url,options});return {ok:true,json:async()=>({items:sourceVideos,nextCursor:null})};}};
vm.runInNewContext(ts.transpileModule('globalThis.validId='+previewValue('validId')+';globalThis.read='+previewValue('read',true),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,galleryReader);
let galleryPage=await galleryReader.read(new URLSearchParams({cursor:'next-page'}));let readQuery=new URL(galleryReads[0].url,'https://fixture.invalid').searchParams;assert.equal(readQuery.get('kind'),null);assert.equal(readQuery.get('cursor'),'next-page');assert.equal(galleryReads[0].options.headers['x-app-session-user'],'owner');assert.equal(galleryPage.items.length,1);assert.equal(galleryPage.items[0].id,'action');
galleryReader.galleryOnly=false;galleryPage=await galleryReader.read(new URLSearchParams({taskId:'video'}));readQuery=new URL(galleryReads[1].url,'https://fixture.invalid').searchParams;assert.equal(readQuery.get('kind'),null);assert.equal(readQuery.get('taskId'),'video');assert.equal(galleryPage.items.length,2);
checks.push('only the action gallery filters the existing read-only response while other result readers remain unchanged');
const galleryChoice={galleryOnly:true,selected:null,player:{current:null},sessionStorage:{setItem(){throw new Error('gallery must not replace workbench selection');}},setSelectedId:id=>{galleryChoice.chosen=id;},setPlayRequest(){},setMediaError(){},setViewOnlyCandidate(){}};
vm.runInNewContext(ts.transpileModule('globalThis.choose='+previewValue('choose'),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,galleryChoice);galleryChoice.choose('chosen-video');assert.equal(galleryChoice.chosen,'chosen-video');
checks.push('only an explicit gallery card click starts the existing restore-before-display detail chain');
const pages=[{items:[sourceVideos[1]],nextCursor:'next'},{items:[sourceVideos[0]],nextCursor:'older'},{items:[sourceVideos[1]],nextCursor:'tail'},{items:[],nextCursor:null}],pageReads=[];
Object.assign(galleryReader,{galleryOnly:true,listSequence:{current:0},alive:()=>true,items:[],mergeMultiviewVideoResults:videoResults.mergeMultiviewVideoResults,
  fetch:async url=>{pageReads.push(new URL(url,'https://fixture.invalid').searchParams.get('cursor'));return {ok:true,json:async()=>pages.shift()};},
  setLoading(){},setNotice(){},setItems:update=>{galleryReader.items=typeof update==='function'?update(galleryReader.items):update;},setCursor:value=>{galleryReader.cursor=value;},rejectAccess(){throw new Error('unexpected access failure');}});
vm.runInNewContext(ts.transpileModule('globalThis.loadList='+previewValue('loadList',true),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,galleryReader);
await galleryReader.loadList();assert.equal(galleryReader.items.length,1);assert.equal(galleryReader.items[0].id,'action');assert.equal(galleryReader.cursor,'older');assert.deepEqual(pageReads,[null,'next']);
await galleryReader.loadList(galleryReader.cursor);assert.equal(galleryReader.items.length,1);assert.equal(galleryReader.cursor,null);assert.deepEqual(pageReads,[null,'next','older','tail']);
checks.push('action gallery traverses rotation-only pages and retains the original pagination cursor without hiding older actions');
let actionEntry,referenceEntry;function findEntries(node){if(ts.isJsxElement(node)&&node.openingElement.tagName.getText(pageAst)==='button'){const text=node.children.filter(ts.isJsxText).map(child=>child.text.trim()).join('');const click=node.openingElement.attributes.properties.find(attr=>attr.name?.getText(pageAst)==='onClick')?.initializer?.expression?.getText(pageAst);if(text==='动作作品')actionEntry=click;if(text==='参考拼图')referenceEntry=click;}ts.forEachChild(node,findEntries);}findEntries(pageAst);assert.ok(actionEntry&&referenceEntry);
let entryUrl='https://fixture.invalid/multiview?view=works&kind=reference&workId=old-work&returnTo=%2Fmultiview%3Fview%3Dactions';
const entry={URL,URLSearchParams,owner:'owner',taskId:'rotation',pageView:'works',setActivity(){},setPageView(){},setEditorWork(){},setReferenceLibrary:value=>{entry.reference=value;},
  window:{location:{get href(){return entryUrl;},get pathname(){return new URL(entryUrl).pathname;},get search(){return new URL(entryUrl).search;}},history:{state:null,replaceState(_state,_title,url){entryUrl=new URL(url,'https://fixture.invalid').href;}}}};
vm.runInNewContext(functions('src/app/multiview/page.tsx',['readPageView','writeLocation','sourceReturn']),entry);
vm.runInNewContext('globalThis.enterActions='+actionEntry+';globalThis.enterReferences='+referenceEntry,entry);entry.enterActions();let entryQuery=new URL(entryUrl).searchParams;
assert.equal(entry.actual.readPageView(entryQuery),'actions');assert.equal(entryQuery.get('workId'),null);assert.equal(entryQuery.get('kind'),null);assert.equal(entryQuery.get('returnTo'),null);
entry.enterReferences();entryQuery=new URL(entryUrl).searchParams;assert.equal(entry.actual.readPageView(entryQuery),'works');assert.equal(entryQuery.get('kind'),'reference');assert.equal(entry.reference,true);
checks.push('action works and reference collages have distinct real navigation handlers and refreshable URLs');
const actionRestore=await restoreHarness().read('video');entryUrl='https://fixture.invalid/multiview?view=actions';entry.pageView='actions';entry.sessionReady=true;entry.authority='authority';entry.ownerRef={current:'owner'};entry.authorityRef={current:'authority'};entry.restoreLock={current:false};entry.restoreSequence={current:0};entry.openedVideo={current:''};entry.isClientSessionBlocked=()=>false;
entry.fetch=async url=>{assert.ok(url.includes('/actions/restore?taskId=video'));return {ok:true,status:200,json:async()=>actionRestore};};entry.AbortSignal=AbortSignal;entry.requestAnimationFrame=callback=>callback();entry.window.scrollTo=()=>{};
for(const name of ['RestoringVideo','ReferenceNotice','VideoReturnView','Location','EditorWork','PageView','ReferenceEditor','ReferencePicking','OriginalEditing','ReferenceReplacement','PreviewTaskId','PreviewReadOnly'])entry['set'+name]=value=>{entry[name]=value;};
const entryNavigation=entry.actual;vm.runInNewContext(functions('src/app/multiview/page.tsx',['openVideoInputs']),entry);entry.actual={...entryNavigation,...entry.actual};assert.equal(await entry.actual.openVideoInputs('video'),true);assert.equal(entry.VideoReturnView,'actions');assert.equal(entry.PreviewTaskId,'video');assert.equal(entry.ReferenceEditor.restored.text,'十二秒的新动作');assert.equal(entry.ReferenceEditor.restored.parameters.duration,12);assert.equal(hash(entry.ReferenceEditor.restored.recipe),hash(recipe));
entryQuery=new URL(entryUrl).searchParams;assert.equal(entryQuery.get('videoTaskId'),'video');assert.equal(entryQuery.get('returnTo'),'/multiview?view=actions');assert.equal(entry.actual.sourceReturn(entryQuery.get('returnTo'),'rotation'),'/multiview?view=actions');
entry.actual.writeLocation('actions');entryQuery=new URL(entryUrl).searchParams;assert.equal(entryQuery.get('videoTaskId'),null);assert.equal(entryQuery.get('returnTo'),null);assert.equal(entry.actual.readPageView(entryQuery),'actions');
checks.push('opening an action preview restores its exact video and settings and returns directly to the action gallery');
console.log(JSON.stringify({passed:true,checks,isolation:{realFetches:0,productionWrites:0,generationCalls:0,browserAcceptance:'manual-pending'}}));
