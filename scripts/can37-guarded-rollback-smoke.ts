import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';

const rollback = process.env.CAN37_GUARDED_ROLLBACK_ROOT;
if (!rollback) throw Error('CAN37_GUARDED_ROLLBACK_ROOT must identify the isolated guarded source');
const base = 'e2273e5258bc44234cb316ffa41f6ab1156a293a';
const read = (file: string) => readFileSync(path.join(rollback, file), 'utf8');
const old = (file: string) => execFileSync('git', ['show', `${base}:${file}`], { encoding: 'utf8' });
function functions(file: string, names: string[], source = read(file)) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const declarations = new Map<string, string>();
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text)) declarations.set(node.name.text, node.getText(ast));
    ts.forEachChild(node, visit);
  }
  visit(ast);
  for (const name of names) assert.ok(declarations.has(name), `${file}:${name}`);
  return ts.transpileModule(Array.from(declarations.values()).join('\n').replace(/^export /gm, '')
    + names.map(name => `;this.${name}=${name}`).join(''), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}
class AuthError extends Error { constructor(message: string, public status = 400) { super(message); } }
async function main() {
  const mapping = { version: 1, items: [{ token: '@图1', referenceImageId: 'reference-b' }] };
  const node = { id: 'node', type: 'image', x: 0, y: 0, data: { prompt: '使用@图1', promptMentions: mapping,
    source: 'upload', assetId: 'asset', referenceImageId: 'reference-b', planReferences: [{ referenceImageId: 'reference-b' }],
    styleJob: { requestId: 'original-request', submissionState: 'unconfirmed' } } };
  const snapshot = { schema: 'ultimate_canvas.v1', schemaVersion: 2, context: { project_id: 'project' }, canvas: { nodes: [node], connections: [] } };
  const doc: any = { Buffer, MAX_CANVAS_BYTES: 2 * 1024 * 1024, CanvasDocumentError: AuthError, randomUUID };
  const readerNames = ['invalid', 'object', 'id', 'checkJson', 'parseCanvasSnapshot'];
  runInNewContext(functions('src/lib/canvas-documents.ts', readerNames.concat('duplicateSnapshot')), doc);
  const saved = doc.parseCanvasSnapshot(JSON.stringify(snapshot), 'project', true);
  assert.equal(JSON.stringify(saved.canvas.nodes[0].data), JSON.stringify(node.data));
  const duplicate = doc.duplicateSnapshot(saved).canvas.nodes[0].data;
  assert.equal(JSON.stringify(duplicate.promptMentions), JSON.stringify(mapping));
  assert.equal(duplicate.assetId, 'asset'); assert.equal(duplicate.referenceImageId, 'reference-b');
  assert.equal(duplicate.styleJob, undefined); assert.equal(node.data.styleJob.requestId, 'original-request');
  const commands: any = { module: { exports: {} } };
  runInNewContext(read('public/tools/ultimate-canvas/canvas-commands.js'), commands);
  const copied = commands.module.exports.duplicateNodeData(node, new Map(), new Map());
  assert.equal(JSON.stringify(copied.promptMentions), JSON.stringify(mapping));
  assert.equal(copied.assetId, 'asset'); assert.equal(copied.referenceImageId, 'reference-b'); assert.equal(copied.styleJob, undefined);
  const history = commands.module.exports.captureState({ nodes: new Map([['node', { ...node, type: 'video', data: { ...node.data,
    videoSubmission: { requestId: 'unknown', userId: 'user', documentId: 'doc', projectId: 'project', cardId: 'card',
      input: { prompt: '@图1', promptMentions: mapping }, generationPayload: { prompt: '@图1', promptMentions: mapping } } } }]]),
    connections: [], selectedNodeIds: new Set(), scale: 1, offsetX: 0, offsetY: 0 });
  assert.equal(JSON.stringify(history.nodes[0].runtimeReferences.videoSubmission.input.promptMentions), JSON.stringify(mapping));
  assert.equal(JSON.stringify(history.nodes[0].runtimeReferences.videoSubmission.generationPayload.promptMentions), JSON.stringify(mapping));
  console.log('PASS rollback reader, both duplicate whitelists and undo retain binding/original inputs without task replay');

  let graph: any = snapshot;
  let reads = 0;
  const guard: any = { AuthError, assertCanEditCanvasDocument: async () => { reads++; return { document_json: JSON.stringify(graph) }; } };
  runInNewContext(functions('src/lib/canvas-prompt-compatibility.ts', ['assertCanvasPromptCompatibility']), guard);
  await assert.rejects(guard.assertCanvasPromptCompatibility({}, 'doc', 'node', '@图1', mapping, true), (e: any) => e.status === 409);
  await assert.rejects(guard.assertCanvasPromptCompatibility({}, 'doc', 'node', '@图1', undefined, true), /已保存/);
  await assert.rejects(guard.assertCanvasPromptCompatibility({}, null, null, '@图1', undefined, true), /无法核实/);
  graph = { canvas: { nodes: [{ ...node, data: { prompt: '@图1' } }] } };
  await assert.rejects(guard.assertCanvasPromptCompatibility({}, 'doc', 'node', '@图1', undefined, true), /无法核实/);
  await guard.assertCanvasPromptCompatibility({}, 'doc', 'node', '旧手写图1', undefined, true);
  await guard.assertCanvasPromptCompatibility({}, null, null, '@图1', undefined, false);
  assert.equal(reads, 2);
  console.log('PASS rollback server guard rejects new/old-client bound inputs and stripped-marker ambiguity; plain legacy body unaffected');

  const app: any = { engine: { nodes: new Map([['node', node]]) }, promptWithConnectedText: (payload: any) => payload.prompt || '' };
  runInNewContext(functions('public/tools/ultimate-canvas/app.js', ['assertGuardedCanvasPrompt']), app);
  assert.throws(() => app.assertGuardedCanvasPrompt({ kind: 'image', nodeId: 'node', prompt: '@图1' }), /保护回退/);
  app.engine.nodes.clear();
  assert.throws(() => app.assertGuardedCanvasPrompt({ kind: 'video', nodeId: 'node', prompt: '@图1' }), /保护回退/);
  assert.doesNotThrow(() => app.assertGuardedCanvasPrompt({ kind: 'video', nodeId: 'node', prompt: '旧图1' }));
  const submit = functions('public/tools/ultimate-canvas/app.js', ['submitNodeGeneration']);
  assert.ok(submit.indexOf('assertGuardedCanvasPrompt(payload)') < submit.indexOf('/api/tasks/estimate'));
  const adapter = functions('public/tools/ultimate-canvas/app.js', ['installGenerationAdapter']);
  assert.ok(adapter.indexOf('assertGuardedCanvasPrompt(payload)') < adapter.indexOf("payload.kind === 'image'"));
  console.log('PASS rollback actual UI submit guard precedes quote and actual adapter guard precedes all image/video dispatch');

  const routes = [
    ['src/app/api/tasks/create/route.ts', '$transaction'],
    ['src/app/api/ip/tasks/create/route.ts', '$transaction'],
    ['src/app/api/assets/generate/route.ts', 'getImageGenerationChannels'],
    ['src/app/api/tools/ultimate-canvas/images/generate/route.ts', 'saveStudioModule'],
    ['src/app/api/tools/ultimate-canvas/styles/generate/route.ts', 'submitStudioBatch'],
  ];
  const body = { prompt: '@图1', promptMentions: mapping, input: {}, source_metadata: { canvas_node_id: 'node', source: 'ultimate_canvas' }, client_name: 'ultimate_canvas' };
  for (const [file, effect] of routes) {
    const post = functions(file, ['POST']);
    assert.ok(post.includes('assertCanvasPromptCompatibility'), file);
    assert.ok(post.indexOf('assertCanvasPromptCompatibility') < post.indexOf(`${effect}(`), `${file} guard before ${effect}`);
    const source = read(file); const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    let call = '';
    const visit = (item: ts.Node) => {
      if (ts.isCallExpression(item) && item.expression.getText(ast) === 'assertCanvasPromptCompatibility') call = item.getText(ast);
      ts.forEachChild(item, visit);
    };
    visit(ast); assert.ok(call);
    const scope: any = { ...guard, user: {}, body, input: { promptMentions: mapping }, canvasDocumentId: 'doc', canvasNodeId: 'node',
      canvasDocumentIds: new Set(['doc']), context: { documentId: 'doc', nodeId: 'node' }, action: 'image_variant',
      cleanSourceMetadata: (value: any) => value, buildGenerationPrompt: () => '@图1' };
    await assert.rejects(runInNewContext(`(async()=>{await ${call}})()`, scope), (e: any) => e.status === 409);
  }
  const imageRoute = 'src/app/api/tools/ultimate-canvas/images/generate/route.ts';
  assert.equal(functions(imageRoute, ['GET']), functions(imageRoute, ['GET'], old(imageRoute)), 'image query must not gain submit guard');
  for (const file of ['src/lib/image-studio/worker.ts', 'scripts/process-image-studio.ts',
    'src/app/api/tools/ultimate-canvas/video-submission/route.ts', 'public/tools/ultimate-canvas/generation-node-workflow.js']) {
    assert.equal(read(file), old(file), `${file}: worker/query/unknown normalization unchanged`);
  }
  for (const name of ['recoverVideoSubmission', 'applyVideoGenerationResult']) {
    assert.equal(functions('public/tools/ultimate-canvas/app.js', [name]), functions('public/tools/ultimate-canvas/app.js', [name], old('public/tools/ultimate-canvas/app.js')), name);
  }
  const version = JSON.parse(read('package.json')).version;
  assert.equal(version, '0.60.0+can37-rollback-guard.1');
  assert.equal(JSON.parse(read('package-lock.json')).packages[''].version, version);
  console.log('PASS five actual submit-route guards run before effects; GET/recovery/unknown/worker contracts remain e227; distinct rollback version');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
