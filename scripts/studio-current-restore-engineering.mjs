import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Evaluate actual UI declarations with deferred synthetic reads; no browser,
// application database, provider, or HTTP connection is opened.
const file = 'src/app/image-studio/studio.tsx';
const source = readFileSync(file, 'utf8');
const methodsSource = process.argv[3] ? readFileSync(process.argv[3], 'utf8') : source;
function declaration(text, name) {
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node.getText(tree);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(found, `Missing production function ${name}`);
  return found;
}
const names = ['applyNamedSettings', 'applyQuickPreset', 'restoreTemporaryDraft', 'restoreDefaults', 'restoreResultSettings'];
const declarations = ['captureRestoreInputs', 'restoreInputsUnchanged'].map(name => declaration(source, name))
  .concat(names.map(name => declaration(methodsSource, name))).join('\n');
const js = ts.transpileModule(declarations, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const checks = [];
const ref = current => ({ current });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const policy = { primaryIds: [], primaryMin: 0, primaryMax: 1, auxiliaryMax: 10, useFixedReferences: true };
function fixture() {
  const calls = [];
  const storage = new Map();
  const read = deferred();
  const globals = {
    JSON, Object, Array, Map, Set, Number, Boolean, encodeURIComponent,
    liveGenerationSignature: ref('original input'), latestSettingsDraft: ref('original definition'),
    currentInputRevision: ref(0), privateEditorEditVersion: ref(0), draftRestoreSequence: ref(0),
    detailReadSequence: ref(0), quickPresetLock: ref(false), presetSaveLock: ref(false),
    draftLoaded: true, draftRestoring: false, submitting: false, pendingSubmission: null,
    moduleSaving: false, moduleDeleting: false, uploading: false, bannerUploading: false, ratioEditing: false,
    sharedReady: true, quickPresetScopeKey: 'scope', quickPresetReadScope: ref('scope'),
    userId: 'owner', module: { id: 'module', images: [], fixedReferences: [], templateImages: [] },
    images: [], generationTemplateCount: 0, generationTemplateImageCount: 0,
    generationReferencePolicy: policy, MAX_REFERENCE_IMAGES: 12, prompt: 'original input',
    sharedLive: null, contextEditable: true, fixedEditable: false, evolution: null, models: ['model'],
    isAdmin: false, recoverableDraft: null, restoredSettingsError: '', generationChanged: false, authorDefinitionDirty: false,
    defaultsRecoveryKey: 'defaults', baseline: { prompt: 'default input', referencePolicy: policy },
    savedFixedReferences: [], savedModuleContext: 'default context',
    blockedDraftSignature: ref(null), generationDraft: 'draft',
    taskReadScope: 'tasks', taskReadScopeRef: ref('tasks'), currentView: ref({ token: 1, active: true }),
    moduleDialog: ref({ close: () => calls.push(['close']) }),
    isClientSessionBlocked: () => false,
    readResponse: async result => result, fetchReadWithRetry: () => read.promise,
    loadQuickPresets: () => read.promise, fetch: () => read.promise,
    readTaskDetail: () => read.promise, recoverPersonalPromptInput: () => read.promise,
    temporaryDraftPayload: () => ({ prompt: 'original input' }),
    moduleReferencePolicy: () => policy, parseStudioTaskSettings: () => null, parseStudioCurrentInputs: () => null,
    isEncryptedStudioPersonalPrompt: () => false,
    restoreTask: value => { calls.push(['restoreTask', value]); return null; },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
  };
  for (const name of new Set(declarations.match(/\bset[A-Z]\w*(?=\()/g))) globals[name] = value => calls.push([name, value]);
  const api = vm.runInNewContext(`${js}\n({${names.join(',')}})`, globals);
  return { api, globals, calls, read };
}
const setting = { id: 'setting', ownerId: 'owner', moduleId: 'module', name: 'Saved', images: [], styleGroups: [],
  values: { prompt: 'saved input', model: 'model', quality: 'quality', resolution: 'resolution', count: 1, aspectRatio: '1:1' } };
function assertRetained(f) {
  assert.ok(!f.calls.some(([name]) => ['setPrompt', 'setModuleContext', 'setNamedSettingStyles', 'restoreTask', 'close'].includes(name)), 'Late read changed current input');
}
for (const field of ['liveGenerationSignature', 'latestSettingsDraft', 'privateEditorEditVersion', 'currentInputRevision']) {
  const f = fixture();
  const running = f.api.applyNamedSettings(setting);
  f.globals[field].current = typeof f.globals[field].current === 'number' ? 1 : '';
  f.read.resolve({ setting });
  await running;
  assertRetained(f);
  assert.ok(f.calls.some(([name, value]) => name === 'setDraftRestoring' && value === false));
  checks.push(`named settings preserve later ${field}, including clear`);
}
{
  const f = fixture(); const running = f.api.applyNamedSettings(setting);
  f.read.resolve({ setting }); await running;
  assert.ok(f.calls.some(([name, value]) => name === 'setPrompt' && value === 'saved input'));
  checks.push('unchanged named settings apply normally');
}
{
  const f = fixture(); const running = f.api.applyQuickPreset({ id: 'quick' });
  f.globals.latestSettingsDraft.current = 'new definition';
  f.read.resolve([{ id: 'quick', referencesAvailable: true }]); await running;
  assertRetained(f);
  assert.ok(!f.calls.some(([name]) => name === 'setRestoredTaskSettings'));
  checks.push('late quick preset cannot start another restore over new edits');
}
for (const field of ['liveGenerationSignature', 'privateEditorEditVersion']) {
  const f = fixture(); const running = f.api.restoreTemporaryDraft({ prompt: 'saved input', namedSettingStyles: true });
  f.globals[field].current = field === 'privateEditorEditVersion' ? 1 : '';
  f.read.resolve({ restored: true, prompt: 'saved input', notice: '' });
  assert.equal(await running, false); assertRetained(f);
  assert.ok(f.calls.some(([name, value]) => name === 'setDraftRestoring' && value === false));
  checks.push(`draft restore preserves later ${field} after final text read`);
}
{
  const f = fixture(); const running = f.api.restoreTemporaryDraft({ prompt: 'saved input', context: '', namedSettingStyles: true });
  f.read.resolve({ restored: true, prompt: 'saved input', notice: '' });
  assert.equal(await running, true);
  assert.ok(f.calls.some(([name, value]) => name === 'setModuleContext' && value === ''));
  checks.push('unchanged draft restore applies explicit empty context');
}
{
  const f = fixture(); const running = f.api.restoreDefaults();
  f.globals.liveGenerationSignature.current = '';
  f.read.resolve({ restored: true, prompt: 'default input', notice: '' }); await running;
  assertRetained(f);
  assert.ok(f.calls.some(([name, value]) => name === 'setDraftRestoring' && value === false));
  checks.push('default recovery preserves text cleared during read');
}
for (const privateEdit of [false, true]) {
  const f = fixture(); const running = f.api.restoreResultSettings({ id: 'history' });
  if (privateEdit) f.globals.privateEditorEditVersion.current++;
  f.read.resolve({ id: 'history', snapshot: {} }); await running;
  assert.equal(f.calls.some(([name]) => name === 'restoreTask'), !privateEdit);
  checks.push(privateEdit ? 'history restore respects private edit before autosave receipt' : 'unchanged history restore applies normally');
}
{
  const f = fixture(); const running = f.api.applyNamedSettings(setting);
  f.globals.liveGenerationSignature.current = 'new input'; f.read.reject(new Error('late failure')); await running;
  assert.ok(!f.calls.some(([name, value]) => name === 'setError' && value));
  checks.push('late failure does not replace feedback after newer input');
}
const multiviewFile = 'src/app/multiview/MultiviewActionPanel.tsx';
const multiview = readFileSync(multiviewFile, 'utf8');
const tree = ts.createSourceFile(multiviewFile, multiview, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback;
function findCallback(node) {
  if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(tree) === 'PrivateDefinitionEditor') {
    const attribute = node.attributes.properties.find(item => ts.isJsxAttribute(item) && item.name.getText(tree) === 'onSaved');
    callback = attribute?.initializer?.expression?.getText(tree);
  }
  ts.forEachChild(node, findCallback);
}
findCallback(tree); assert.ok(callback);
let saved = 0, closed = 0;
const onSaved = vm.runInNewContext(`(${callback})`, { onSaved: () => saved++, onClose: () => closed++ });
onSaved(2, true); assert.equal(saved, 1); assert.equal(closed, 0);
onSaved(3); assert.equal(saved, 2); assert.equal(closed, 1);
checks.push('multiview save callback keeps newer edits open and closes an unchanged save');
const report = { passed: checks.length, checks, networkCalls: 0, databaseOpened: false, browserUsed: false,
  sources: Object.fromEntries([[file, source], [multiviewFile, multiview], ['scripts/studio-current-restore-engineering.mjs', readFileSync(import.meta.filename, 'utf8')]]
    .map(([name, text]) => [name, createHash('sha256').update(text).digest('hex')])) };
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
