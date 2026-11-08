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
const report = { schema: 'template-sharing-chain-audit.v1', sourceRoot: root, diagnosticOnly: true, checks: [], observations: {}, productionWrites: 0, paidRequests: 0, browserRuns: 0, networkCalls: 0 };
const newer = { id: 'workspace', sourcePresetId: 'source', sourcePresetShared: true, revision: 8, name: 'newer confirmed', sharedLive: { intent: { presetId: 'source', definitionToken: 'new-token' }, available: true } };
const older = { ...newer, revision: 7, name: 'older response', sharedLive: { ...newer.sharedLive, intent: { presetId: 'source', definitionToken: 'old-token' } } };
let modules = [structuredClone(newer)];
const env = { useCallback: callback => callback, studioRepairModule: declaration(named('studioRepairModule'), {}), setModules: setter => { modules = setter(modules); } };
const receive = expression(variable('receiveSharedDefinition').initializer, env);
receive(older);
assert.equal(modules[0].revision, 7); assert.equal(modules[0].sharedLive.intent.definitionToken, 'old-token');
report.checks.push('actual_shared_projection_receiver_accepts_an_older_workspace_and_source_token');
report.observations.projectionRegression = { before: newer.revision, after: modules[0].revision, sourceTokenRegressed: true };
const sharingInput = variable('sharing').initializer.arguments[0];
const settledNode = sharingInput.properties.find(p => p.name?.getText(source) === 'onSettled').initializer;
modules = [structuredClone(newer)]; let refreshes = 0;
const settled = expression(settledNode, { setPresets: setter => setter([]), setModules: env.setModules, shared: { refresh: () => { refreshes++; } }, pool: { refresh: () => {} }, refreshPresetCatalogs: async () => {}, setPresetsError: () => {} });
settled('source', { isShared: false, sourceRevision: 'new-source-revision', moduleRevision: 9 });
assert.equal(modules[0].sourcePresetShared, false); assert.equal(modules[0].revision, 8); assert.equal(refreshes, 1);
report.checks.push('actual_sharing_settlement_discards_confirmed_module_revision_and_waits_for_a_later_read');
report.observations.sharingAcknowledgement = { receiptRevision: 9, pageRevision: modules[0].revision, asynchronousRefreshRequested: true };
const requestDeclaration = variable('moduleSaveRequest');
assert.equal(requestDeclaration.initializer.expression.getText(source), 'useRef');
assert.equal(requestDeclaration.initializer.arguments[0].kind, ts.SyntaxKind.NullKeyword);
const pendingId = randomUUID(), policy = { primaryIds: [], primaryMin: 0, primaryMax: 1, auxiliaryMax: 10, styleMax: 10, referenceMax: 10, useFixedReferences: true };
const draftEnv = { namedSettingStyles: false, studioTaskSettings: () => ({ mode: 'current' }), globalContextMode: 'current', globalSettingsSourceTaskId: null,
 sharedLive: null, restoredTaskSettings: null, authorDefinitionDirty: false, resultView: 'all', evolution: false, prompt: 'PERSONAL INPUT', count: 1,
 referenceLimit: 1, aspectRatio: 'auto', resolution: '4K', contextEditable: false, fixedEditable: false, moduleContext: '', moduleModel: 'gpt-image-2',
 quality: 'high', reproduceSourceTaskId: null, moduleRevision: 8, images: [], auxiliaryImages: [], referencePolicy: policy,
 skills: [], styleGroups: [], moduleSaveRequest: { current: { requestId: pendingId, unknown: true, signature: '{"isShared":true}' } } };
const payload = declaration(named('temporaryDraftPayload'), draftEnv)();
assert.equal(JSON.stringify(payload).includes(pendingId), false);
report.checks.push('normal_persisted_workspace_draft_omits_the_original_pending_definition_save_command');
report.observations.pendingSave = { initializedToNull: true, requestIdentityInPersistedDraft: false, fixedReferenceSpecialCaseSeparate: true, serverReceiptLossProven: false, duplicateGenerationProven: false };
const inputs = ['src/app/image-studio/studio.tsx', 'src/app/image-studio/use-shared-studio.ts', 'src/app/image-studio/use-sharing-command.ts', 'src/lib/image-studio/shared-contract.ts', 'src/lib/image-studio/modules.ts', 'src/lib/image-studio/presets.ts', 'src/lib/image-studio/definition-read.ts', 'src/components/TemplateDefinitionRead.tsx'];
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
   assert.equal(typeof deferred, 'function');
   modules = [structuredClone(newer)];
   await Renderer.act(async () => { renderer.update(React.createElement(Harness, { ...props, activeModule: newer })); await tick(); });
   assert.equal(modules[0].revision, 8);
   await Renderer.act(async () => { deferred({ modules: [older] }); await tick(); });
   assert.equal(deliveries, 1); assert.equal(modules[0].revision, 7);
 } finally { if (renderer) await Renderer.act(async () => renderer.unmount()); }
 let pendingRef;
 const init = requestDeclaration.initializer;
 function PendingHarness() { pendingRef = expression(init, { useRef: React.useRef }); return null; }
 await Renderer.act(async () => { renderer = Renderer.create(React.createElement(PendingHarness)); });
 pendingRef.current = { requestId: pendingId, unknown: true };
 await Renderer.act(async () => renderer.unmount());
 await Renderer.act(async () => { renderer = Renderer.create(React.createElement(PendingHarness)); });
 assert.equal(pendingRef.current, null);
 await Renderer.act(async () => renderer.unmount());
 return { realReactVersion: React.version, delayedPollBeforeSaveAppliedAfterNewerProps: { confirmed: 8, applied: modules[0].revision }, pendingIdentityAfterRemount: null };
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
 assert.ok(crypto.isStoredPrivatePrompt(definitionRead.definition.context));
 assert.equal(privateEditor.context, 'old synthetic context');
 if (process.argv.includes('--definition-only')) return { definitionOnly: true, readonlyDefinitionReturnsStoredEnvelope: true,
   privateEditorReturnsAuthorizedPlaintext: true, plaintextOrEnvelopePrinted: false, productionWrites: 0, paidRequests: 0, networkCalls: calls };
 await db.user.create({ data: { id: 'colleague', role: 'user', account_type: 'internal', username: 'fixture-colleague', name: 'fixture', email: 'colleague@invalid.test', password_hash: 'not-a-login', feishu_tenant_key: 'tenant', feishu_open_id: 'colleague-subject' } });
 const colleague = { id: 'colleague', role: 'user', account_type: 'internal', feishu_tenant_key: 'tenant', feishu_open_id: 'colleague-subject' };
 const workspace = await contract.openSharedStudioModule(colleague, published.sourcePresetId, randomUUID(), undefined, { explicitSelection: true });
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
 assert.equal(catalogFailure.ok, false); assert.equal(revisionLegacy.ok, false);
 if (original) await db.platformSetting.update({ where: { key: badKey }, data: { value_json: original.value_json } }); else await db.platformSetting.delete({ where: { key: badKey } });
 await contract.listSharedStudioCatalog(actor);
 assert.equal(await db.imageStudioTask.count(), 0); assert.equal(await db.creditLedger.count(), 0); assert.equal(calls, 0);
 return { isolatedSqlite: true, rawPrivateContextHiddenFromColleague: true, colleagueCannotSaveDefinition: true, withdrawalDeniesNewUseAndKeepsWorkspace: true, reshareRestoresUse: true,
   sharingActuallyAdvancesPublisherRevision: { before: before.revision, after: withdrawn.current.moduleRevision }, metadataOnlyRenameChangesGenerationToken: true,
   unrelatedMalformedReproduction: { catalog: catalogFailure, legacyRevision: revisionLegacy, targetedHealthyModule: targeted, recoveredAfterRemovingSyntheticFault: true }, productionWrites: 0, paidRequests: 0, networkCalls: calls };
 `;
 const program = prelude + '\nreturn (async()=>{try{\n' + setup + probe + '\n}finally{globalThis.fetch=originalFetch;if(db)await db.$disconnect();fs.rmSync(fixture,{recursive:true,force:true});}})();';
 return new Function('require', 'process', 'console', program)(require, process, console);
}
(async () => {
 report.observations.realReact = await clientInterleaving();
 report.checks.push('real_hook_inflight_old_read_survives_newer_active_props_and_replaces_confirmed_state', 'real_pending_ref_remount_loses_identity_that_is_absent_from_persisted_draft');
 if (process.argv.includes('--backend')) {
   report.observations.backend = await backend();
   report.checks.push('readonly_definition_returns_storage_ciphertext_while_authorized_private_editor_returns_plaintext');
   if (!report.observations.backend.definitionOnly) report.checks.push('real_backend_share_receipt_advances_revision_and_colleague_withdrawal_reshare_boundaries_hold', 'one_unrelated_malformed_reproduction_aborts_full_catalog_and_legacy_revision');
 }
 report.completedAt = new Date().toISOString(); report.passed = true;
 console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
