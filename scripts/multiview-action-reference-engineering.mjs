import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const root = process.cwd(), require = createRequire(import.meta.url), ts = require('typescript');
const source = fs.readFileSync(path.join(root, 'src/lib/video/multiview-action.server.ts'), 'utf8');
const ast = ts.createSourceFile('actions.ts', source, ts.ScriptTarget.Latest, true);
const parts = ast.statements.filter(node =>
  ts.isFunctionDeclaration(node) && ['object', 'actionText', 'baseSnapshot', 'createMultiviewActionRun'].includes(node.name?.text)
  || ts.isVariableStatement(node) && node.declarationList.declarations.some(item => ['invalid', 'conflict', 'purpose', 'identifier'].includes(item.name.getText(ast))));
const errors = ts.createSourceFile('errors.ts', fs.readFileSync(path.join(root, 'src/lib/template-studio/errors.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
const errorClass = errors.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'StudioError');
const code = ts.transpileModule(errorClass.getText(errors) + '\n' + parts.map(node => node.getText(ast)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const user = { id: 'owner', username: 'owner', account_type: 'internal' };
const reference = { assetId: 'current-collage', recipeHash: 'a'.repeat(64), outputHash: 'b'.repeat(64), sourceTaskId: 'source', sourceVersion: 'v1', geometry: {} };
function harness({ prior = null, denied = false, changed = false } = {}) {
  const stored = [], prepared = [], rechecked = [];
  const row = { id: 'draft', revision: 2, prompt: '当前修改后的动作' };
  const env = { exports: {}, MULTIVIEW_ACTION_PURPOSE: 'multiview-action', MULTIVIEW_ACTION_REFERENCE_PURPOSE: 'multiview-action-reference',
    requireStudioUser() {}, snapshot: value => JSON.parse(value.snapshot_json), runDto: value => ({ id: value.id }),
    ownedDraft: async () => row, draftDto: () => ({ workId: 'work', workRevision: 7, parameters: {} }),
    referenceDraftWork: async () => { if (denied) throw new env.exports.StudioError('No source permission', 403, 'FORBIDDEN'); return { id: 'work', draftRevision: 7, recipe: {}, sourceTaskId: 'source' }; },
    getMultiviewActionCapabilities: async () => ({ actionReady: true, llmEnabled: true, defaultLlmModel: 'gpt-6.1-sol', llmModels: [{ id: 'gpt-6.1-sol' }] }),
    readMultiviewActionContext: async () => ({ context: 'fixture rules', revision: 1 }), multiviewWorkRecipeHash: () => 'a'.repeat(64), workGeometry: () => ({}),
    ensureMultiviewReferenceAsset: async (_user, id, revision) => { prepared.push({ id, revision }); return reference; },
    readMultiviewReferenceBinding: async (_user, id, revision) => { rechecked.push({ id, revision }); return changed ? { ...reference, assetId: 'other-image' } : reference; },
    TEMPLATE_STUDIO_LIMITS: { llmInput: 20000, activeLlmRunsPerUser: 5, maxPendingLlmRuns: 50, llmRequestsPerUserWindow: 20, llmRequestWindowMs: 60000 },
    getMuskApiSettings: async () => ({}), privateVideoRunOrigins: () => [], assertPrivateMuskSend() {}, privatePromptState: () => 'encrypted-write',
    makeFingerprint: value => JSON.stringify(value), assertSupplementaryModelEnabled: async () => {}, assertUsageProject: async () => {}, recordUsageAttribution: async () => {},
    randomUUID: () => 'run', transformPrivateVideoRun: value => value,
  };
  const runs = { findUnique: async () => prior, count: async () => 0, create: async ({ data }) => { stored.push(data); return data; } };
  const tx = { videoStudioRun: runs, videoStudioDraft: { findFirst: async () => row } };
  env.prisma = { videoStudioRun: runs, $transaction: async operation => operation(tx) };
  vm.runInNewContext(code, env);
  return { create: (input, route = false) => env.exports.createMultiviewActionRun(user, input, route), stored, prepared, rechecked };
}
const input = { draftId: 'draft', revision: 2, requestId: 'original-request', llmModel: 'gpt-6.1-sol' };
let api = harness(); await api.create({ ...input, referenceImage: true }, true);
let value = JSON.parse(api.stored[0].snapshot_json);
assert.equal(api.stored[0].purpose, 'multiview-action-reference');
assert.equal(value.input.draftPrompt, '当前修改后的动作'); assert.equal(value.multiviewAction.assetId, reference.assetId);
assert.equal(value.multiviewAction.revision, 7); assert.equal(value.multiviewAction.outputHash, reference.outputHash);
assert.deepEqual(value.assets, [{ assetId: reference.assetId, type: 'image', role: 'reference' }]);
assert.equal(api.prepared.length, 1); assert.equal(api.rechecked.length, 1);
api = harness(); await api.create(input); value = JSON.parse(api.stored[0].snapshot_json);
assert.equal(value.assets.length, 0); assert.equal(api.prepared.length, 0); assert.equal(api.rechecked.length, 0);
api = harness(); await assert.rejects(api.create({ ...input, referenceImage: 'true' }), error => error.code === 'INVALID'); assert.equal(api.stored.length, 0);
api = harness({ denied: true }); await assert.rejects(api.create({ ...input, referenceImage: true }, true), /No source permission/); assert.equal(api.stored.length, 0);
api = harness({ changed: true }); await assert.rejects(api.create({ ...input, referenceImage: true }, true), /参考拼图已变化/); assert.equal(api.stored.length, 0);
api = harness(); await assert.rejects(api.create({ ...input, referenceImage: true }), error => error.code === 'INVALID'); assert.equal(api.stored.length, 0);
const original = { id: 'original-run', purpose: 'multiview-action-reference', draft_id: 'draft', draft_revision: 2, mode: 'llm', snapshot_json: JSON.stringify({ llmModel: input.llmModel, multiviewAction: { assetId: 'current-collage' } }) };
api = harness({ prior: original }); assert.equal((await api.create({ ...input, referenceImage: true }, true)).run.id, original.id); assert.equal(api.stored.length, 0);
await assert.rejects(api.create(input), error => error.code === 'CONFLICT' && !error.details?.notAccepted);
console.log(JSON.stringify({ passed: true, checks: ['checked snapshot pins current authorized image and edited text', 'unchecked keeps legacy text-only snapshot', 'invalid checkbox rejected at entry', 'source permission denied before creation', 'changed reference rejected in transaction', 'same original request reads its receipt', 'same key cannot change image choice', 'legacy text endpoint cannot admit image work'], isolation: { realFetches: 0, productionWrites: 0, generationCalls: 0 } }));
