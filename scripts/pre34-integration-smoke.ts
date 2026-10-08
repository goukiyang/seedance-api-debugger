import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = readFileSync('src/lib/canvas-documents.ts', 'utf8');
const ast = ts.createSourceFile('canvas-documents.ts', source, ts.ScriptTarget.Latest, true);
const declaration = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === 'duplicateSnapshot');
assert.ok(declaration);
const compiled = ts.transpileModule(`${declaration.getText(ast)}\nmodule.exports = duplicateSnapshot;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const context = { module: { exports: null as unknown }, randomUUID,
  object: (value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value) };
runInNewContext(compiled, context);
const copy = context.module.exports as (value: unknown) => any;
const original = { canvas: { viewport: {}, connections: [{ from: 'a', to: 'b' }], nodes: [
  { id: 'a', type: 'script', x: 0, y: 0, data: { prompt: 'story', storyWorkflow: { version: 1, story: '完整原文' },
    storyRequest: { state: 'unconfirmed' }, storyMediaNodes: { paid: 'b' }, canvasGroup: { id: 'old-group', name: '镜头组' } } },
  { id: 'b', type: 'video', x: 300, y: 0, data: { prompt: 'video', taskId: 'paid-task', generationStatus: 'succeeded',
    videoSubmission: { requestId: 'paid-request' }, storySource: { nodeId: 'a', shotId: 'shot-1', sourceRevision: 7 }, generationResult: { url: '/protected' }, canvasGroup: { id: 'old-group', name: '镜头组' } } },
] } };
const result = JSON.parse(JSON.stringify(copy(original)));
assert.notEqual(result.canvas.nodes[0].id, 'a');
assert.notEqual(result.canvas.nodes[0].data.canvasGroup.id, 'old-group');
assert.equal(result.canvas.nodes[0].data.canvasGroup.id, result.canvas.nodes[1].data.canvasGroup.id);
assert.equal(result.canvas.nodes[0].data.storyWorkflow.story, '完整原文');
assert.equal(result.canvas.nodes[0].data.storyRequest, undefined);
assert.equal(result.canvas.nodes[0].data.storyMediaNodes, undefined);
assert.equal(result.canvas.nodes[1].data.taskId, undefined);
assert.equal(result.canvas.nodes[1].data.videoSubmission, undefined);
assert.equal(result.canvas.nodes[1].data.generationResult, undefined);
assert.equal(result.canvas.nodes[1].data.generationStatus, 'idle');
assert.equal(result.canvas.nodes[1].data.storySource.nodeId, result.canvas.nodes[0].id);
assert.deepEqual(result.canvas.connections, [{ from: result.canvas.nodes[0].id, to: result.canvas.nodes[1].id }]);

const html = readFileSync('public/tools/ultimate-canvas/index.html', 'utf8');
const app = readFileSync('public/tools/ultimate-canvas/app.js', 'utf8');
for (const file of ['canvas-commands.js', 'canvas-groups.js', 'canvas-minimap.js']) {
  assert.ok(html.indexOf(`src="${file}`) < html.indexOf('src="app.js'));
}
for (const id of ['btn-undo', 'btn-redo', 'btn-copy-nodes', 'btn-group', 'btn-ungroup', 'canvas-minimap']) assert.ok(html.includes(`id="${id}"`));
assert.ok(app.includes('minimapViewportChanged?.(...args)'));
assert.ok(app.includes('onInitialCancel: async'));
assert.ok(app.includes("window.top.location.assign('/')"));
assert.ok(!app.includes('画布小地图还没有接入'));
const appAst = ts.createSourceFile('app.js', app, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
let promptFunction: ts.FunctionDeclaration | undefined;
function findPrompt(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'promptWithConnectedText') promptFunction = node;
  ts.forEachChild(node, findPrompt);
}
findPrompt(appAst); assert.ok(promptFunction);
const promptContext = { engine: { nodes: new Map([['story-shot', { data: { storySource: { nodeId: 'source' } } }], ['ordinary', { data: {} }]]) }, module: { exports: null as unknown } };
runInNewContext(`${promptFunction.getText(appAst)}\nmodule.exports = promptWithConnectedText;`, promptContext);
const promptFor = promptContext.module.exports as (payload: unknown) => string;
const payload = { nodeId: 'story-shot', prompt: 'single shot only', sourceNodes: [{ type: 'script', data: { generatedText: 'complete unrelated full script' } }] };
assert.equal(promptFor(payload), 'single shot only');
assert.equal(promptFor({ ...payload, nodeId: 'ordinary' }), 'single shot only\n\ncomplete unrelated full script');
console.log('PRE34 server document copy and integration wiring smoke passed (no DB/network calls)');
