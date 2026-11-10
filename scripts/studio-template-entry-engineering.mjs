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
function fixture(module) {
  const actions = [], sharedLive = module.sharedLive;
  const scope = { exports: {}, module, sharedLive, hasSharedDefaults: () => true, canViewTemplateContext: true,
    templateWorkbench: true, canManageTemplateSharing: false, sharingPending: false,
    draftLoaded: true, draftRestoring: false, moduleSaveError: '', moduleSaving: false, moduleDeleting: false, bannerUploading: false,
    styles: {}, Settings: 'settings', ImagePlus: 'image', reproduceSourceTaskId: undefined, revisionRef: { current: 1 },
    openModuleDialog: () => actions.push('edit'), setReadingDefinition: value => actions.push(['read', value]),
    onOpenOriginal: value => actions.push(['original', value]), saveModule: async () => { actions.push('save'); return true; },
    setCoverEditorOpen: value => actions.push(['cover', value]), require: name => require(name) };
  const program = `const sharedReady = ${variable('sharedReady')}; const definitionEditable = ${variable('definitionEditable')}; const sourceCoverEditable = ${variable('sourceCoverEditable')}; globalThis.contextButton = (${contextControl}); globalThis.coverButton = (${coverControl});`;
  vm.runInNewContext(ts.transpileModule(program, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, scope);
  return { scope, actions };
}
const ownDraft = { saved: true, privateDefinition: true, sourcePresetId: 'source', sourcePresetOwnedByViewer: true,
  sharedLive: { available: true, methodDraft: true, defaults: {}, mode: 'live', capabilities: { generate: { allowed: true }, editDefinition: { allowed: false } } } };
let f = fixture(ownDraft);
f.scope.contextButton.props.children.props.onClick();
assert.equal(JSON.stringify(f.actions), JSON.stringify([['read', true]]));
checks.push('private method draft opens read-only definition instead of empty edit shell');
f = fixture({ ...ownDraft, coverEditable: true, sharedLive: { ...ownDraft.sharedLive, mode: 'publisher', methodDraft: false, capabilities: { ...ownDraft.sharedLive.capabilities, editDefinition: { allowed: true } } } });
f.scope.contextButton.props.children.props.onClick();
assert.equal(f.actions[0], 'edit');
checks.push('editable publisher keeps the existing private definition editor');
f = fixture(ownDraft);
f.scope.coverButton.props.onClick(); await new Promise(setImmediate);
assert.equal(JSON.stringify(f.actions), JSON.stringify([['original', true]]));
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
const files = [file, 'src/components/TemplateDefinitionRead.tsx', 'scripts/studio-template-entry-engineering.mjs'];
const report = { schema: 'studio-template-entry-engineering.v1', passed: checks.length, checks, productionWrites: 0, applicationDatabaseOpened: false,
  networkCalls: 0, providerCalls: 0, browserUsed: false, sourceSha256: Object.fromEntries(files.map(name => [name, createHash('sha256').update(readFileSync(name)).digest('hex')])) };
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
