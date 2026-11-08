'use strict';
// Read-only source probes and optional synthetic SQLite probes; never a production writer.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto'), { createRequire } = require('node:module');
const root = process.cwd(), requireAt = createRequire(path.join(root, 'package.json')), ts = requireAt('typescript');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const source = ts.createSourceFile('studio.tsx', fs.readFileSync(path.join(root, 'src/app/image-studio/studio.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function all(node, pred, found = []) { if (pred(node)) found.push(node); ts.forEachChild(node, n => { all(n, pred, found); }); return found; }
function named(name) { const node = all(source, n => ts.isFunctionDeclaration(n) && n.name?.text === name)[0]; assert.ok(node, name); return node; }
function variable(name) { const node = all(source, n => ts.isVariableDeclaration(n) && n.name.getText(source) === name)[0]; assert.ok(node, name); return node; }
function expression(node, env) { const compiled = ts.transpileModule(`const expression = (${node.getText(source)});`, { fileName: 'probe.tsx', compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText; return new Function('scope', `with(scope){${compiled};return expression;}`)(env); }
function declaration(node, env) { const compiled = ts.transpileModule(node.getText(source), { fileName: 'probe.tsx', compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText; return new Function('scope', `with(scope){${compiled};return ${node.name.text};}`)(env); }
const report = { schema: 'template-sharing-chain-engineering.v1', synthetic: true, completed: false, applicationDatabaseOpened: false, forbiddenCalls: 0, candidateRoot: root, checks: [], observations: {}, productionWrites: 0, paidRequests: 0, browserRuns: 0, networkCalls: 0 };
const projection = {};
new Function('exports', ts.transpileModule(fs.readFileSync(path.join(root, 'src/lib/image-studio/module-projection.ts'), 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(projection);
const newer = { id: 'workspace', sourcePresetId: 'source', sourcePresetShared: true, revision: 8, name: 'newer confirmed', sharedLive: { mode: 'publisher', sourceRevision: '2026-11-08T10:00:00.000Z', intent: { presetId: 'source', definitionToken: 'new-token' }, available: true } };
const older = { ...newer, revision: 7, name: 'older response', sharedLive: { ...newer.sharedLive, intent: { presetId: 'source', definitionToken: 'old-token' } } };
let modules = [structuredClone(newer)];
const env = { ...projection, useCallback: callback => callback, studioRepairModule: declaration(named('studioRepairModule'), {}), setModules: setter => { modules = setter(modules); } };
const receive = expression(variable('receiveSharedDefinition').initializer, env);
receive(older);
assert.equal(modules[0].revision, 8); assert.equal(modules[0].sharedLive.intent.definitionToken, 'new-token');
report.checks.push('actual_receiver_rejects_older_workspace_projection');
report.observations.projectionRegression = { before: newer.revision, after: modules[0].revision, sourceTokenRegressed: false };
const sharingInput = variable('sharing').initializer.arguments[0];
const settledNode = sharingInput.properties.find(p => p.name?.getText(source) === 'onSettled').initializer;
modules = [structuredClone(newer)]; let refreshes = 0;
const settled = expression(settledNode, { ...projection, setPresets: setter => setter([]), setModules: env.setModules, shared: { refresh: () => { refreshes++; } }, pool: { refresh: () => {} }, refreshPresetCatalogs: async () => {}, setPresetsError: () => {} });
settled('source', { isShared: false, sourceRevision: '2026-11-08T11:00:00.000Z', moduleRevision: 9 });
assert.equal(modules[0].sourcePresetShared, false); assert.equal(modules[0].revision, 9); assert.equal(modules[0].definitionSyncPending, true); assert.equal(refreshes, 1);
const live = { ...newer, sharedLive: { ...newer.sharedLive, mode: 'live' } };
assert.equal(projection.receiveStudioSharingCurrent(live, 'source', { isShared: false, sourceRevision: '2026-11-08T11:00:00.000Z', moduleRevision: 99 }).revision, 8);
assert.equal(projection.receiveStudioModuleProjection(modules[0], newer), modules[0]);
assert.equal(projection.receiveStudioModuleProjection(modules[0], {...newer,revision:9}),modules[0]);
assert.equal(projection.receiveStudioModuleProjection(modules[0], { ...modules[0], definitionSyncPending: undefined }).definitionSyncPending, undefined);
report.checks.push('actual_settlement_adopts_publisher_revision_without_changing_colleague_revision');
report.observations.sharingAcknowledgement = { receiptRevision: 9, pageRevision: modules[0].revision, asynchronousRefreshRequested: true };
const callbackEnv={...projection,studioRepairModule:env.studioRepairModule,setModules:env.setModules,shared:{refresh(){}},pool:{refresh(){}},refreshPresetCatalogs:async()=>{},setPresetsError(){},navigateToModule(){}};
const receivePreference=expression(variable('preferenceSharing').initializer.arguments[1],callbackEnv);modules=[structuredClone(newer)];receivePreference(older);assert.equal(modules[0].revision,8);
const copyAttribute=all(source,n=>ts.isJsxAttribute(n)&&n.name.getText(source)==='onParameterCopySaved')[0];assert.ok(copyAttribute);const receiveCopy=expression(copyAttribute.initializer.expression,callbackEnv);receiveCopy(older);assert.equal(modules[0].revision,8);report.checks.push('actual_preference_and_parameter_copy_callbacks_reject_older_projection');
const pendingId = randomUUID();
async function durableSave() {
 const saved = new Map(), scope = { exports: {}, localStorage: { getItem:k=>saved.get(k)??null,setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k) }, navigator: {locks:{request:async(k,f)=>f()}} };
 const text = ts.transpileModule(fs.readFileSync(path.join(root, 'src/app/image-studio/fixed-reference-save-state.ts'), 'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 function remount() { const exports={};const current={...scope,exports};new Function('scope',`with(scope){${text}}`)(current);return exports; }
 let api=remount();const command={version:1,actorId:'author',moduleId:'workspace',presetId:'module-source:workspace',requestId:pendingId,expectedRevision:0,definitionToken:'first-publication'};
 await api.claimFixedReferenceSave(command);api=remount();assert.deepEqual(api.readFixedReferenceSave('author','workspace'),command);
 assert.equal(api.readFixedReferenceSave('other','workspace'),null);assert.equal(api.readFixedReferenceSave('author','other'),null);
 await assert.rejects(()=>api.claimFixedReferenceSave({...command,requestId:randomUUID()}));
 await assert.rejects(()=>api.clearFixedReferenceSave({...command,requestId:randomUUID()}));
 assert.equal(api.fixedReferenceReceiptMatches({status:'completed',receipt:{moduleId:'workspace',presetId:command.presetId,beforeRevision:0,revision:1,sourceRevision:new Date().toISOString(),definitionToken:'new'}},command),true);
 assert.equal(api.fixedReferenceSaveRejected({commandOutcome:{status:'not-applied',actorId:'other',moduleId:'workspace',requestId:pendingId}},command),false);
 assert.equal(JSON.stringify([...saved.values()]).includes('context'),false);await api.clearFixedReferenceSave(command);assert.equal(api.readFixedReferenceSave('author','workspace'),null);
 const save=named('saveModule');const claims=all(save,n=>ts.isIfStatement(n)&&n.expression.getText(source)==='saveDefinition');
 assert.ok(claims.some(n=>n.thenStatement.getText(source).includes('claimFixedReferenceSave')));
 return { originalCommandSurvivesRemount:true, actorAndTargetIsolated:true, noTemplateBodyStored:true };
}
const inputs = ['src/app/image-studio/studio.tsx', 'src/app/image-studio/use-shared-studio.ts', 'src/app/image-studio/use-sharing-command.ts', 'src/lib/image-studio/shared-contract.ts', 'src/lib/image-studio/modules.ts', 'src/lib/image-studio/presets.ts', 'src/lib/image-studio/definition-read.ts', 'src/components/TemplateDefinitionRead.tsx', 'src/lib/image-studio/module-projection.ts', 'src/app/image-studio/fixed-reference-save-state.ts', 'src/lib/image-studio/shared-types.ts', 'src/lib/image-studio/tasks.ts', 'src/lib/image-studio/protected-assets.ts', 'scripts/template-sharing-version-engineering.cjs', 'src/app/api/image-studio/presets/route.ts', 'src/lib/performance/trace-contract.ts', 'src/lib/image-studio/feishu-navigation.ts'];
report.sourceSha256 = Object.fromEntries(inputs.map(n => [n, sha(fs.readFileSync(path.join(root, n)))]));
report.fixtureSha256 = sha(fs.readFileSync(__filename));
async function clientInterleaving() {
 const runtime = process.env.REQ01_RUNTIME_ROOT ? createRequire(path.join(process.env.REQ01_RUNTIME_ROOT, 'package.json')) : requireAt;
 const React = runtime('react'), Renderer = runtime('react-test-renderer');
 assert.equal(React.version, requireAt('react/package.json').version);
 const hookAst = ts.createSourceFile('use-shared-studio.ts', fs.readFileSync(path.join(root, 'src/app/image-studio/use-shared-studio.ts'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
 const hookNode = all(hookAst, n => ts.isFunctionDeclaration(n) && n.name?.text === 'useSharedStudio')[0];
 const hookCode = ts.transpileModule(hookNode.getText(hookAst), { fileName: 'hook.ts', compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
 const timers = new Map(); let timerId = 0, deferred, deliveries = 0;
 const events = { addEventListener() {}, removeEventListener() {} };
 const scope = { exports: {}, useRef: React.useRef, useState: React.useState, useEffect: React.useEffect, useCallback: React.useCallback,
   useAppSession: () => ({ sessionChanged: false }), isClientSessionBlocked: () => false,
   document: { ...events, hidden: false }, window: events, navigator: { onLine: true },
   setTimeout: callback => { timers.set(++timerId, callback); return timerId; }, clearTimeout: id => timers.delete(id),
   SharedReadError: class extends Error {},
   readShared: async url => url.includes('mode=revision')
     ? { catalogRevision: 'c'.repeat(64), activeDefinitionToken: 'old-token', activeAvailable: true }
     : new Promise(resolve => { deferred = resolve; }) };
 const hook = new Function('scope', `with(scope){${hookCode};return useSharedStudio;}`)(scope);
 const props = { userId: 'author', activeModule: older, onDefinition: value => { deliveries++; receive(value); }, onUnavailable: () => {}, lightweightCatalog: true };
 const tick = () => new Promise(resolve => setImmediate(resolve));
 let renderer;
 function Harness(input) { hook(input); return null; }
 try {
   await Renderer.act(async () => { renderer = Renderer.create(React.createElement(Harness, props)); await tick(); });
   assert.equal(typeof deferred, 'function'); const originalRead = deferred;
   modules = [structuredClone(newer)];
   await Renderer.act(async () => { renderer.update(React.createElement(Harness, { ...props, activeModule: newer })); await tick(); });
   assert.equal(modules[0].revision, 8);
   await Renderer.act(async () => { originalRead({ modules: [older] }); await tick(); });
   assert.equal(deliveries,0);assert.equal(modules[0].revision,8);await Renderer.act(async()=>{deferred({modules:[newer]});await tick();});assert.equal(deliveries,1);assert.equal(modules[0].revision,8);
 } finally { if (renderer) await Renderer.act(async () => renderer.unmount()); }
 return {realReactVersion:React.version,oldReadDropped:true,newerReadApplied:true};
}
async function backend() {
 // Reuse the existing, already-verified isolation/loader scaffolding; do not re-run its 17 cases.
 const base = fs.readFileSync(path.join(root, 'scripts/template-sharing-version-engineering.cjs'), 'utf8');
 const prelude = base.slice(0, base.indexOf('async function main()'));
 const setupStart = base.indexOf('  const setup = spawnSync('), setupEnd = base.indexOf('  const contract = load(', setupStart);
 assert.ok(setupStart > 0 && setupEnd > setupStart);
 const setup = base.slice(setupStart, setupEnd);
 const probe = String.raw`
 const contract = load('src/lib/image-studio/shared-contract.ts'), modules = load('src/lib/image-studio/modules.ts'), presets = load('src/lib/image-studio/presets.ts');
 const request = { id: data.id, saveIntent: 'definition', revision: 0, requestId: randomUUID(), isShared: true, name: 'healthy synthetic source', count: 1, referenceIds: [], referencePolicy: { primaryIds: [], primaryMin: 0, primaryMax: 1, auxiliaryMax: 10, styleMax: 10, referenceMax: 10, useFixedReferences: true } };
 const published = await modules.saveStudioModule(actor.id, request);
 const definitionRead = await load('src/lib/image-studio/definition-read.ts').readStudioTemplateDefinition(actor, { presetId: published.sourcePresetId });
 const privateEditor = await contract.readPrivateStudioEditor(actor, data.id);
 assert.equal(definitionRead.definition.context,'old synthetic context');assert.equal(crypto.isStoredPrivatePrompt(definitionRead.definition.context),false);assert.ok(published.commandReceipt);const receipt=await presets.studioSharingCommandStatus(actor,request.requestId);assert.equal(receipt.status,'completed');assert.equal(receipt.receipt.revision,1);
 assert.equal(privateEditor.context, 'old synthetic context');
 await db.user.create({ data: { id: 'colleague', role: 'user', account_type: 'internal', username: 'fixture-colleague', name: 'fixture', email: 'colleague@invalid.test', password_hash: 'not-a-login', feishu_tenant_key: 'tenant', feishu_open_id: 'colleague-subject' } });
 const colleague = { id: 'colleague', role: 'user', account_type: 'internal', feishu_tenant_key: 'tenant', feishu_open_id: 'colleague-subject' };
 const workspace = await contract.openSharedStudioModule(colleague, published.sourcePresetId, randomUUID(), undefined, { explicitSelection: true });
 await assert.rejects(()=>load('src/lib/image-studio/definition-read.ts').readStudioTemplateDefinition(colleague,{presetId:published.sourcePresetId}));
 const unsigned={id:'author',role:'admin',account_type:'internal'};actor=unsigned;await assert.rejects(()=>load('src/lib/image-studio/definition-read.ts').readStudioTemplateDefinition(unsigned,{presetId:published.sourcePresetId}));actor={id:'author',role:'admin',account_type:'internal'};assert.equal(identity.authenticatePrivateIdentity(actor,signed,token),true);
 const opened = await modules.studioModuleDTOForUser(colleague, workspace.id);
 assert.equal(opened.sharedLive.available, true); assert.equal(opened.context || '', ''); assert.equal(opened.sharedLive.capabilities.saveDefinition.allowed, false);
 const before = await db.imageStudioModule.findUniqueOrThrow({ where: { id: data.id } });
 let sourceRow = await db.imageStudioPreset.findUniqueOrThrow({ where: { id: published.sourcePresetId } });
 const withdrawn = await presets.setStudioPresetSharing(actor, sourceRow.id, false, sourceRow.updated_at.toISOString(), randomUUID(), 'workbench');
 assert.equal(withdrawn.current.moduleRevision, before.revision + 1);
 let denial;
 try { await contract.resolveSharedStudioModule(colleague, workspace.id); } catch(error) { denial = error; }
 assert.ok(denial && [403,404,409].includes(denial.status));
 assert.equal(await db.imageStudioModule.count({ where: { id: workspace.id } }), 1);
 sourceRow = await db.imageStudioPreset.findUniqueOrThrow({ where: { id: published.sourcePresetId } });
 await presets.setStudioPresetSharing(actor, sourceRow.id, true, sourceRow.updated_at.toISOString(), randomUUID(), 'workbench');
 assert.ok(await contract.resolveSharedStudioModule(colleague, workspace.id));
 const definitionBeforeRename = (await contract.resolveSharedStudioDefinition(actor, sourceRow.id)).definition;
 sourceRow = await db.imageStudioPreset.findUniqueOrThrow({ where: { id: sourceRow.id } });
 await presets.manageStudioPreset(actor, sourceRow.id, sourceRow.updated_at.toISOString(), 'rename', 'metadata-only rename', { requestId: randomUUID(), entryPoint: 'workbench' });
 const definitionAfterRename = (await contract.resolveSharedStudioDefinition(actor, sourceRow.id)).definition;
 const generationFields = value => ({ prompt: value.prompt, templatePrompt: value.templatePrompt, context: value.context,
   defaults: value.generationDefaults, policy: value.referencePolicy, references: value.templateReferenceIds,
   fixed: value.fixedReferences, styles: value.styleGroups, styleReferences: value.styleReferences });
 assert.deepEqual(generationFields(definitionAfterRename), generationFields(definitionBeforeRename));
 assert.notEqual(definitionAfterRename.intent.definitionToken, definitionBeforeRename.intent.definitionToken);
 assert.equal(definitionAfterRename.generationIntent.definitionToken,definitionBeforeRename.generationIntent.definitionToken);
 const nav=load('src/lib/image-studio/feishu-navigation.ts');const navInput={owner_id:actor.id,module_id:data.id,batch_id:'synthetic-navigation',snapshot_json:JSON.stringify({moduleName:definitionAfterRename.name})};const resolvedNav=await nav.resolveImageFeishuNavigation(db,navInput,'synthetic-output');assert.equal(resolvedNav.label,definitionAfterRename.name);assert.equal(resolvedNav.kind,'module');assert.equal((await nav.resolveImageFeishuNavigation(db,{...navInput,snapshot_json:null},'synthetic-output')).label,(await db.imageStudioModule.findUniqueOrThrow({where:{id:data.id}})).name);
 const tasks=load('src/lib/image-studio/tasks.ts');const used=await tasks.resolveStudioTaskSharedUse(actor,data.id,definitionBeforeRename.generationIntent,db);assert.deepEqual(used.definition.intent,definitionBeforeRename.generationIntent);
 await assert.rejects(()=>tasks.resolveStudioTaskSharedUse(actor,data.id,definitionBeforeRename.intent,db));
 const method=await contract.prepareSharedStudioMethodWorkspace(actor,sourceRow.id,definitionBeforeRename.sourceRevision,definitionBeforeRename.generationIntent.definitionToken,db,{});assert.ok(await contract.resolveSharedStudioModule(actor,method,db));
 const copyId='parameter-copy-'+randomUUID();await db.imageStudioPreset.create({data:{id:copyId,owner_id:actor.id,scope:'creator',model:definitionAfterRename.generationDefaults.model,is_shared:false,name:'private parameter set'}});
 const parameters=Object.fromEntries(['model','quality','resolution','count','aspectRatio'].map(k=>[k,definitionAfterRename.generationDefaults[k]]));
 await db.platformSetting.create({data:{key:'studio_parameter_copy_v1:'+copyId,updated_by:actor.id,value_json:JSON.stringify({version:1,ownerId:actor.id,presetId:copyId,rootPresetId:sourceRow.id,styleGroupIds:[],parameters})}});
 const copyBefore=(await contract.resolveSharedStudioDefinition(actor,copyId)).definition;await db.imageStudioPreset.update({where:{id:copyId},data:{name:'renamed parameter set',updated_at:new Date(Date.now()+100)}});
 const copyAfter=(await contract.resolveSharedStudioDefinition(actor,copyId)).definition;assert.equal(copyBefore.generationIntent.definitionToken,copyAfter.generationIntent.definitionToken);assert.notEqual(copyBefore.intent.definitionToken,copyAfter.intent.definitionToken);
 const edit=await contract.readPrivateStudioEditor(actor,data.id);await contract.savePrivateStudioEditor(actor,data.id,{requestId:randomUUID(),revision:edit.revision,sourceRevision:edit.sourceRevision,prompt:'',context:'changed generation context'});
 const changed=(await contract.resolveSharedStudioDefinition(actor,sourceRow.id)).definition;assert.notEqual(changed.generationIntent.definitionToken,definitionAfterRename.generationIntent.definitionToken);assert.notEqual((await contract.resolveSharedStudioDefinition(actor,copyId)).definition.generationIntent.definitionToken,copyAfter.generationIntent.definitionToken);
 await assert.rejects(()=>tasks.resolveStudioTaskSharedUse(actor,data.id,definitionBeforeRename.generationIntent,db));await assert.rejects(()=>contract.resolveSharedStudioModule(actor,method,db));
 const secondId = randomUUID();
 await db.imageStudioModule.create({ data: storage.writePrivateStudioDefinition('image-module', { ...data, id: secondId, name: 'unrelated synthetic source', prompt: '', context: 'unrelated rule', revision: 0 }) });
 const second = await modules.saveStudioModule(actor.id, { ...request, id: secondId, requestId: randomUUID(), name: 'unrelated synthetic source' });
 const healthyCatalog = await contract.listSharedStudioCatalog(actor);
 assert.ok(healthyCatalog.items.some(item => item.presetId === published.sourcePresetId && item.available));
 const badKey = contract.studioSharedReproductionKey(second.sourcePresetId), original = await db.platformSetting.findUnique({ where: { key: badKey } });
 await db.platformSetting.upsert({ where: { key: badKey }, create: { key: badKey, updated_by: actor.id, value_json: '{INVALID SYNTHETIC JSON' }, update: { value_json: '{INVALID SYNTHETIC JSON' } });
 const attempt = async f => { try { await f(); return { ok: true }; } catch(e) { return { ok: false, name: e.name, status: e.status ?? null }; } };
 const catalogFailure = await attempt(() => contract.listSharedStudioCatalog(actor));
 const targeted = await attempt(() => contract.resolveSharedStudioModule(actor, data.id));
 const revisionLegacy = await attempt(() => contract.sharedStudioRevision(actor, published.sourcePresetId, data.id, false));
 assert.equal(catalogFailure.ok,true);assert.equal(revisionLegacy.ok,true);assert.equal(targeted.ok,true);
 const isolated=await contract.listSharedStudioCatalog(colleague);assert.equal(isolated.items.find(item=>item.presetId===second.sourcePresetId).available,false);assert.equal(isolated.items.find(item=>item.presetId===published.sourcePresetId).available,true);
 await assert.rejects(()=>contract.resolveSharedStudioDefinition(actor,second.sourcePresetId));
 const legacyId=randomUUID();await db.imageStudioModule.create({data:{...storage.writePrivateStudioDefinition('image-module',{...data,id:legacyId,source_preset_id:null,revision:0,prompt:'',context:'legacy independent context'}),source_preset_id:sourceRow.id}});
 const legacy=await modules.studioModuleDTOForUser(actor,legacyId);assert.equal(legacy.id,legacyId);assert.equal(await db.platformSetting.count({where:{key:contract.studioBindingKey(legacyId)}}),0);
 await db.platformSetting.update({where:{key:badKey},data:{value_json:JSON.stringify({version:1,sourceOwnerId:actor.id,templateFixedReferences:[]})}});const badStructure=await contract.listSharedStudioCatalog(colleague);assert.equal(badStructure.items.find(item=>item.presetId===second.sourcePresetId).available,false);assert.equal(badStructure.items.find(item=>item.presetId===published.sourcePresetId).available,true);
 if (original) await db.platformSetting.update({ where: { key: badKey }, data: { value_json: original.value_json } }); else await db.platformSetting.delete({ where: { key: badKey } });
 await contract.listSharedStudioCatalog(actor);
 const legacySource=randomUUID();await db.imageStudioPreset.create({data:{id:legacySource,owner_id:actor.id,scope:'creator',is_shared:true,name:'legacy shared source',model:'gpt-image-2'}});
 assert.ok((await contract.resolveSharedStudioDefinition(colleague,legacySource)).definition.intent);assert.equal(await db.platformSetting.count({where:{key:contract.studioPublisherKey(legacySource)}}),0);
 const route=load('src/app/api/image-studio/presets/route.ts'), savedActor=actor;actor=null;
 const {NextRequest}=requireAt('next/server');for(const verb of ['GET','POST']){const response=await route[verb](new NextRequest('https://invalid.test/api/image-studio/presets',{method:verb}));assert.equal(response.status,401);}actor=savedActor;
 const actualPolicyFile=process.env.PRIVATE_PROMPTS_POLICY_FILE;process.env.PRIVATE_PROMPTS_POLICY_FILE=path.join(fixture,'temporarily-unavailable-policy.json');
 try { const unavailable=await route.GET(new NextRequest('https://invalid.test/api/image-studio/presets?mode=definition&presetId='+encodeURIComponent(published.sourcePresetId)));assert.equal(unavailable.status,503);assert.equal((await unavailable.json()).reasonCode,'read-unavailable'); }
 finally {process.env.PRIVATE_PROMPTS_POLICY_FILE=actualPolicyFile;}
 assert.equal(await db.imageStudioTask.count(), 0); assert.equal(await db.creditLedger.count(), 0); assert.equal(calls, 0);
 return { isolatedSqlite: true, rawPrivateContextHiddenFromColleague: true, colleagueCannotSaveDefinition: true, withdrawalDeniesNewUseAndKeepsWorkspace: true, reshareRestoresUse: true,
   sharingActuallyAdvancesPublisherRevision: { before: before.revision, after: withdrawn.current.moduleRevision }, metadataOnlyRenamePreservesGenerationToken: true, changedContextRejectsOldGeneration: true, oldEditIntentStaysStrict: true, methodContentPinWorks: true, originalDefinitionReceiptAvailable: true, legacyReadDoesNotCreateBinding: true,
   unrelatedMalformedReproduction: { catalog: catalogFailure, legacyRevision: revisionLegacy, targetedHealthyModule: targeted, healthyCatalogAndRevisionStayAvailable: true }, productionWrites: 0, paidRequests: 0, networkCalls: calls };
 `;
 const program = prelude + '\nreturn (async()=>{try{\n' + setup + probe + '\n}finally{globalThis.fetch=originalFetch;if(db)await db.$disconnect();fs.rmSync(fixture,{recursive:true,force:true});}})();';
 const previousTmp = process.env.TMPDIR;
 const actualTmp = fs.realpathSync(require('node:os').tmpdir());
 // Real private-policy validation forbids test key material inside app source.
 if (actualTmp === root || actualTmp.startsWith(root + path.sep)) process.env.TMPDIR = fs.realpathSync('/tmp');
 else process.env.TMPDIR = actualTmp;
 try { return await new Function('require', 'process', 'console', program)(require, process, console); }
 finally { if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp; }
}
(async()=>{
 report.observations.durableSave=await durableSave();report.observations.realReact=await clientInterleaving();report.observations.backend=await backend();
 report.checks.push('original_definition_command_survives_remount_and_isolated_by_actor_target','actual_hook_drops_old_read_and_accepts_current_read','authorized_plaintext_and_unsigned_admin_colleague_denied','original_definition_receipt_and_withdrawal_reshare_boundaries','metadata_generation_identity_and_edit_cas_separated','changed_generation_content_and_method_pin_reject_stale_identity','unrelated_corruption_isolated_from_catalog_and_healthy_target','legacy_workspace_read_does_not_migrate_binding','feishu_navigation_uses_accepted_source_name_and_keeps_legacy_fallback');
 report.completedAt=new Date().toISOString();report.completed=true;
 const output=process.argv[2];if(output&&!output.startsWith('--'))fs.writeFileSync(output,JSON.stringify(report,null,2),{mode:0o600,flag:'wx'});
 console.log(JSON.stringify(report,null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
