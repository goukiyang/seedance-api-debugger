import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the real JSX controls and handlers with synthetic module capabilities.
// No browser, application database, server requests or model calls.
const require = createRequire(import.meta.url);
const file = 'src/app/image-studio/studio.tsx', source = readFileSync(process.argv[3] || file, 'utf8');
const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const nodes = [];
function visit(node) { nodes.push(node); ts.forEachChild(node, visit); }
visit(ast);
const variable = name => nodes.find(node => ts.isVariableDeclaration(node) && node.name.getText(ast) === name).initializer.getText(ast);
const control = text => {
  const button = nodes.find(node => ts.isJsxElement(node) && node.openingElement.tagName.getText(ast) === 'button' && node.getText(ast).includes(text));
  assert.ok(button, text);
  return button.parent.getText(ast);
};
const contextControl = control('setReadingDefinition(true)'), coverControl = control('setCoverEditorOpen(true)');
const checks = [];
const compile = code => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const parent = nodes.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'openSharedPreset').getText(ast);
const publisher = { id: 'publisher', sourcePresetId: 'source', name: 'Original', groupName: 'Group', coverEditable: true,
  sharedLive: { intent: { presetId: 'source' }, mode: 'publisher', available: true, methodDraft: false, capabilities: { editDefinition: { allowed: true } } } };
const unavailable = { id: 'draft', sourcePresetId: 'source', coverEditable: false,
  sharedLive: { intent: { presetId: 'source' }, mode: 'live', available: false, methodDraft: false } };
for (const directoryLoaded of [false, true]) for (const hydrated of [false, true]) for (const action of ['cover', 'context']) {
  const requests = [], covers = [], navigations = [], errors = [];
  let items = [unavailable, ...(hydrated ? [publisher] : [])], contextRequest = null;
  const scope = { directory: directoryLoaded ? [publisher] : [], modules: items, userId: 'owner',
    navigateToModule: (...args) => navigations.push(args), setRequestedContext: update => { contextRequest = update(contextRequest); },
    setGalleryCoverTarget: value => covers.push(value), setError: value => { if (value) errors.push(value); },
    sharedOpenLock: { current: false }, sharedOpenSequence: { current: 0 }, moduleReadScope: { current: 'scope' },
    setSharedOpening: () => {}, claimSharedOpen: async () => ({ retained: true, requestId: 'original-request' }),
    clearSharedOpen: async () => {}, isClientSessionBlocked: () => false,
    readResponse: async value => value, fetchReadWithRetry: async url => {
      requests.push(url);
      return url.includes('open-status') ? { status: 'opened', version: 1, actorId: 'owner', presetId: 'source', requestId: 'original-request', moduleId: 'publisher' } : { modules: [publisher] };
    }, fetch: () => { throw Error('Unexpected workspace creation'); },
    setDeletedSourcePresetIds: update => update([]), setModules: update => { items = update(items); },
    studioRepairModule: item => item, receiveStudioModuleProjection: (_old, next) => next,
    pool: { refresh: () => {} }, shared: { refresh: () => {} } };
  vm.runInNewContext(compile(`${parent}; globalThis.open = openSharedPreset;`), scope);
  assert.equal(await scope.open('source', { explicitSelection: true, forCoverEditor: action === 'cover', forContextEditor: action === 'context' }), true,
    'Real parent source resolver rejected the publisher after selecting an unavailable live draft');
  assert.equal(errors.length, 0);
  if (action === 'cover') assert.equal(covers[0]?.moduleId, 'publisher', 'Cover opened against the invalid draft');
  else { assert.equal(navigations[0]?.[1], 'publisher'); assert.equal(contextRequest?.moduleId, 'publisher'); }
  assert.equal(items[0], unavailable, 'Opening source changed the retained draft');
  checks.push(`real parent selects publisher: directory=${directoryLoaded}, hydrated=${hydrated}, action=${action}`);
}
const effect = nodes.find(node => ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect'
  && node.arguments[0]?.getText(ast).includes('handledContextRequest.current')).arguments[0].getText(ast);
const gate = { openContextRequest: 1, handledContextRequest: { current: 0 }, hidden: false, active: false,
  draftLoaded: false, draftRestoring: false, definitionEditable: true, setPersonalSettingsOpen: () => {},
  moduleDialog: { current: { showModal() { gate.opened++; } } }, opened: 0 };
vm.runInNewContext(compile(`globalThis.run = ${effect};`), gate);
gate.run(); assert.equal(gate.opened, 0); gate.active = true; gate.run(); assert.equal(gate.opened, 0);
gate.draftLoaded = true; gate.draftRestoring = true; gate.run(); assert.equal(gate.opened, 0);
gate.draftRestoring = false; gate.run(); gate.run(); assert.equal(gate.opened, 1);
checks.push('real source context dialog waits for active hydrated draft and opens once');
const moduleFile = 'src/lib/image-studio/modules.ts', moduleSource = readFileSync(moduleFile, 'utf8');
const moduleAst = ts.createSourceFile(moduleFile, moduleSource, ts.ScriptTarget.Latest, true);
let draftProjection;
function findDraft(node) { if (ts.isVariableDeclaration(node) && node.name.getText(moduleAst) === 'methodDraft') draftProjection = node.initializer.getText(moduleAst); ts.forEachChild(node, findDraft); }
findDraft(moduleAst); assert.ok(draftProjection);
for (const pinPresent of [true, false]) {
  const scope = { resolved: null, row: { id: 'draft' }, prisma: { platformSetting: { findUnique: async () => pinPresent ? { key: 'stored-pin' } : null } } };
  await vm.runInNewContext(compile(`(async () => { globalThis.result = ${draftProjection}; })()`), scope);
  assert.equal(scope.result, pinPresent);
}
checks.push('unavailable full module DTO preserves the stored method pin marker');
function fixture(module) {
  const actions = [], sharedLive = module.sharedLive;
  const scope = { exports: {}, module, sharedLive, sourceAction: null, hasSharedDefaults: () => true, canViewTemplateContext: true,
    templateWorkbench: true, canManageTemplateSharing: false, sharingPending: false,
    draftLoaded: true, draftRestoring: false, moduleSaveError: '', moduleSaving: false, moduleDeleting: false, bannerUploading: false,
    styles: {}, Settings: 'settings', ImagePlus: 'image', reproduceSourceTaskId: undefined, revisionRef: { current: 1 },
    openModuleDialog: () => actions.push('edit'), setReadingDefinition: value => actions.push(['read', value]),
    onOpenOriginal: async value => { actions.push(['original', value]); return true; }, setSourceAction: () => {}, setSourceActionError: () => {}, saveModule: async () => { actions.push('save'); return true; },
    setCoverEditorOpen: value => actions.push(['cover', value]), require: name => require(name) };
  const program = `const sharedReady = ${variable('sharedReady')}; const definitionEditable = ${variable('definitionEditable')}; const sourceEditable = ${variable('sourceEditable')}; const sourceCoverEditable = ${variable('sourceCoverEditable')}; ${nodes.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'openOriginal').getText(ast)}; globalThis.contextButton = (${contextControl}); globalThis.coverButton = (${coverControl});`;
  vm.runInNewContext(ts.transpileModule(program, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, scope);
  return { scope, actions };
}
const ownDraft = { saved: true, privateDefinition: true, sourcePresetId: 'source', sourcePresetOwnedByViewer: true,
  sharedLive: { available: true, methodDraft: true, defaults: {}, mode: 'live', capabilities: { generate: { allowed: true }, editDefinition: { allowed: false } } } };
let f = fixture(ownDraft);
f.scope.contextButton.props.children.props.onClick(); await new Promise(setImmediate);
assert.equal(JSON.stringify(f.actions), JSON.stringify([['original', 'context']]));
checks.push('owned live context opens the actual original editor instead of read-only article');
f = fixture({ ...ownDraft, coverEditable: true, sharedLive: { ...ownDraft.sharedLive, mode: 'publisher', methodDraft: false, capabilities: { ...ownDraft.sharedLive.capabilities, editDefinition: { allowed: true } } } });
f.scope.contextButton.props.children.props.onClick();
assert.equal(f.actions[0], 'edit');
checks.push('editable publisher keeps the existing private definition editor');
f = fixture(ownDraft);
f.scope.coverButton.props.onClick(); await new Promise(setImmediate);
assert.equal(JSON.stringify(f.actions), JSON.stringify([['original', 'cover']]));
checks.push('owned method draft edits original publisher cover without saving or rebinding draft');
f = fixture({ ...ownDraft, sourcePresetOwnedByViewer: false });
assert.equal(f.scope.coverButton, false);
checks.push('another creator method draft has no source cover write control');
f = fixture({ saved: true, coverEditable: true });
f.scope.coverButton.props.onClick(); await new Promise(setImmediate);
assert.equal(JSON.stringify(f.actions), JSON.stringify([['cover', true]]));
checks.push('independent own template keeps its existing cover editor');
f = fixture({ saved: false });
f.scope.coverButton.props.onClick(); await new Promise(setImmediate);
assert.equal(JSON.stringify(f.actions), JSON.stringify(['save', ['cover', true]]));
checks.push('new unsaved module is saved before existing cover editing');
f = fixture({ ...ownDraft, privateDefinition: false, sharedLive: { ...ownDraft.sharedLive, methodDraft: false, available: false } });
f.scope.contextButton.props.children.props.onClick(); await new Promise(setImmediate);
assert.equal(JSON.stringify(f.actions), JSON.stringify([['original', 'context']]));
checks.push('unavailable owned live with missing old marker still reaches original settings');
f = fixture({ ...ownDraft, sourcePresetOwnedByViewer: false }); f.scope.contextButton.props.children.props.onClick();
assert.equal(JSON.stringify(f.actions), JSON.stringify([['read', true]]));
checks.push('another creator context keeps the read-only boundary');
const files = [file, moduleFile, 'src/components/TemplateDefinitionRead.tsx', 'scripts/studio-template-entry-engineering.mjs'];
const report = { schema: 'studio-template-entry-engineering.v1', passed: checks.length, checks, productionWrites: 0, applicationDatabaseOpened: false,
  networkCalls: 0, providerCalls: 0, browserUsed: false, sourceSha256: Object.fromEntries(files.map(name => [name, createHash('sha256').update(readFileSync(name)).digest('hex')])) };
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
