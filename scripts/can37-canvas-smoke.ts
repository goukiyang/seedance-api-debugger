import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import { compileCanvasPromptReferences, parseCanvasPromptMentions, validateCanvasBoundReferenceImageIds, CanvasPromptReferenceError } from '../src/lib/canvas-prompt-references';
import { detectMentionAtCursor, replaceMentionRange } from '../src/lib/prompt/mention';

const root = 'public/tools/ultimate-canvas/';
const { CanvasEngine, CanvasReferenceSelection } = require('../public/tools/ultimate-canvas/canvas-engine.js');
const { duplicateNodeData } = require('../public/tools/ultimate-canvas/canvas-commands.js');
const workflow = require('../public/tools/ultimate-canvas/generation-node-workflow.js');
const checks: string[] = [];
const read = (file: string) => readFileSync(file, 'utf8');
function code(file: string, names: string[], source = read(file)) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found = new Map<string, string>();
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text)) found.set(node.name.text, node.getText(ast));
    ts.forEachChild(node, visit);
  }
  visit(ast); for (const name of names) assert.ok(found.has(name), `${file}:${name}`);
  return ts.transpileModule(Array.from(found.values()).join('\n').replace(/^export /gm, '') + names.map(name => `;this.${name}=${name}`).join(''),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
}
class TestAuthError extends Error { constructor(message: string, public status = 400) { super(message); } }
async function main() {
  const mapping = { version: 1, items: [{ token: '@图1', referenceImageId: 'ref-b' }] };
  const original = { type: 'video', data: { title: '原节点', prompt: '使用@图1', provider: 'volcengine_ip', promptMentions: mapping,
    videoSettings: { provider: 'volcengine_ip', model: 'ip-model', duration: 5 }, planReferences: [{ nodeId: 'snapshot-ref', referenceImageId: 'ref-b', available: true, preview: '/secret-preview' }],
    taskId: 'old-task', videoSubmission: { requestId: 'old-request', state: 'unconfirmed' }, styleJob: { requestId: 'old-image' }, quote: { cost: 15 }, resultVideoUrl: '/old-result', generationStatus: 'succeeded' } };
  const copy = duplicateNodeData(original, new Map(), new Map());
  assert.equal(copy.prompt, original.data.prompt); assert.equal(copy.provider, 'volcengine_ip');
  assert.deepEqual(copy.promptMentions, mapping); assert.equal(copy.planReferences[0].referenceImageId, 'ref-b');
  for (const key of ['taskId', 'videoSubmission', 'styleJob', 'quote', 'resultVideoUrl', 'generationStatus']) assert.equal(copy[key], undefined, key);
  assert.equal(copy.planReferences[0].preview, undefined); copy.promptMentions.items[0].referenceImageId = 'edited';
  assert.equal(original.data.promptMentions.items[0].referenceImageId, 'ref-b');
  checks.push('01: actual shared duplicate sanitizer preserves independent input/provider/bindings and drops old requests/results/price/URLs');

  const selected = new Set(['group-a', 'scatter', 'group-c']);
  const engine: any = { selectedNodeIds: selected, nodes: new Map(['group-a', 'group-b', 'scatter', 'group-c', 'group-d'].map((id, index) => [id,
    { id, x: index * 100, y: 10, data: id === 'scatter' ? {} : { canvasGroup: { id: index < 2 ? 'g1' : 'g2' } } }])),
    getSelectedNodeIds: () => Array.from(selected), selectNodes: (ids: string[]) => { engine.selectedNodeIds = new Set(ids); } };
  CanvasEngine.prototype._selectDragNodes.call(engine, 'group-a');
  assert.deepEqual(Array.from(engine.selectedNodeIds).sort(), ['group-a', 'group-b', 'group-c', 'group-d', 'scatter']);
  assert.equal(engine.dragNodeStarts.size, 5);
  const single = CanvasReferenceSelection.start({ targetNodeId: 'target', maximumReferences: 9 });
  const accepted = CanvasReferenceSelection.add(single, { nodeId: 'image', referenceImageId: 'ref-a' });
  assert.equal(accepted.finished, true); assert.equal(accepted.session.active, false);
  const multi = CanvasReferenceSelection.start({ targetNodeId: 'target', maximumReferences: 9, multiple: true });
  assert.equal(CanvasReferenceSelection.add(multi, { nodeId: 'image', referenceImageId: 'ref-a' }).finished, false);
  assert.equal(CanvasReferenceSelection.add(multi, { nodeId: 'missing' }).accepted, false);
  checks.push('05/06: actual multi-group/scatter drag set and explicit single/multiple reference state');

  const vm: any = { engine: { offsetX: 100, offsetY: -40, scale: 2 }, document: { getElementById: () => ({ getBoundingClientRect: () => ({ left: 10, top: 20 }) }) } };
  runInNewContext(code(`${root}app.js`, ['canvasFilePosition']), vm);
  assert.equal(vm.canvasFilePosition(310, 180).x, 100); assert.equal(vm.canvasFilePosition(310, 180).y, 100);
  const range = detectMentionAtCursor('文字 @雨衣', 6)!;
  assert.equal(replaceMentionRange('文字 @雨衣', range, '@图1').next, '文字 @图1 ');
  assert.equal(detectMentionAtCursor('文字 @图1', 6), null);
  checks.push('02/03: existing caret replacement and actual zoom/pan/drop coordinate conversion');

  const target = { data: {} }, input = { isConnected: true, value: '正文 @', selectionStart: 4, selectionEnd: 4 };
  const mentionContext: any = { pendingMention: { requestId: 'request', input, prompt: '正文 @', cursor: 4, context: 'user/doc/card', nodeId: 'node', node: target, signature: 'refs' },
    uploadContextKey: () => 'user/doc/card', referenceImportSignature: () => 'refs', graphEditAllowed: () => true,
    engine: { nodes: new Map([['node', target]]) }, document: { activeElement: input } };
  runInNewContext(code(`${root}app.js`, ['mentionContextMatches']), mentionContext);
  assert.equal(mentionContext.mentionContextMatches('request'), true);
  input.value = 'new user edit'; assert.equal(mentionContext.mentionContextMatches('request'), false); input.value = '正文 @';
  input.selectionStart = 3; assert.equal(mentionContext.mentionContextMatches('request'), false); input.selectionStart = 4;
  mentionContext.uploadContextKey = () => 'another-user/doc/card'; assert.equal(mentionContext.mentionContextMatches('request'), false);
  mentionContext.uploadContextKey = () => 'user/doc/card'; mentionContext.graphEditAllowed = () => false;
  assert.equal(mentionContext.mentionContextMatches('request'), false);
  checks.push('02: actual iframe mention guard rejects late input/cursor/account-document changes and readonly state');

  for (const provider of ['seedance', 'volcengine_ip']) {
    const descriptor = workflow.videoRequest({ nodeId: 'node', requestId: 'request', prompt: '使用@图1', promptMentions: mapping,
      referenceImageIds: ['ref-a', 'ref-b'], settings: { provider, model: provider === 'seedance' ? 'dreamina-seedance-2-5-260628' : 'doubao-seedance-2-5-260628' } });
    assert.equal(descriptor.url, provider === 'seedance' ? '/api/tasks/create' : '/api/ip/tasks/create');
    assert.deepEqual(descriptor.payload.promptMentions, mapping); assert.deepEqual(descriptor.payload.reference_image_ids, ['ref-a', 'ref-b']);
    assert.equal(descriptor.payload.prompt, '使用@图1');
  }
  assert.deepEqual(workflow.imageRequest({ prompt: '使用@图1', promptMentions: mapping }).payload.input.promptMentions, mapping);
  checks.push('02/07: actual ordinary/IP and legacy image descriptors preserve mapping, original order and route identities');
  assert.throws(() => workflow.videoRequest({ promptMentions: mapping, referenceImageIds: ['ref-b', 'ref-b'] }), /重复/);
  assert.throws(() => workflow.imageRequest({ promptMentions: mapping, referenceImageIds: ['ref-b', 'ref-b'] }), /重复/);
  assert.throws(() => workflow.videoRequest({ mode: 'first-last-frame-video', promptMentions: mapping, referenceImageIds: ['ref-a', 'ref-b', 'ref-c'] }), /超限/);

  let authorized: string[] = [];
  const video: any = { AuthError: TestAuthError, CanvasPromptReferenceError, compileCanvasPromptReferences,
    assertCanUseReferenceImage: async (_: unknown, id: string) => { authorized.push(id); if (id === 'denied') throw new TestAuthError('denied', 403); return { asset_id: `asset-${id}` }; } };
  runInNewContext(code('src/lib/canvas-video-prompt.ts', ['compileCanvasVideoPrompt']), video);
  const rendered = await video.compileCanvasVideoPrompt({}, '使用@图1', mapping, ['ref-a', 'ref-b'],
    [{ order: 0, originalUrl: 'a-original' }, { order: 1, originalUrl: 'b-original' }], ['a-original', 'b-original']);
  assert.equal(rendered.promptRendered, '使用图2'); assert.equal(rendered.assetMapping['图2'], 'asset-ref-b');
  assert.match(rendered.canvasPromptFingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(authorized, ['ref-a', 'ref-b']);
  await assert.rejects(video.compileCanvasVideoPrompt({}, '使用@图1', mapping, ['ref-a', 'ref-b'], [{ order: 1, originalUrl: 'b' }], ['external']), /唯一对应/);
  await assert.rejects(video.compileCanvasVideoPrompt({}, '使用@图1', mapping, ['ref-b', 'ref-b'], [{ order: 0, originalUrl: 'b' }], ['b']), /重复/);
  await assert.rejects(video.compileCanvasVideoPrompt({}, '使用@图1', { version: 1, items: [{ token: '@图1', referenceImageId: 'denied' }] }, ['denied'], [{ order: 0, originalUrl: 'd' }], ['d']), /denied/);
  checks.push('02: actual video compiler binds permission-checked prepared originals in sent order; external/duplicate/revoked rejected');

  const studioSource = read('src/lib/image-studio/tasks.ts');
  const studioAst = ts.createSourceFile('tasks.ts', studioSource, ts.ScriptTarget.Latest, true);
  let compileBlock = '';
  function findCompile(node: ts.Node) {
    if (ts.isIfStatement(node) && node.expression.getText(studioAst) === 'canvasPrompt'
      && node.thenStatement.getText(studioAst).includes('orderedReferenceIds.map')) compileBlock = node.thenStatement.getText(studioAst);
    ts.forEachChild(node, findCompile);
  }
  findCompile(studioAst); assert.ok(compileBlock);
  const studio: any = { StudioError: TestAuthError, compileCanvasPromptReferences, rawCanvasPrompt: '@图1', input: {},
    canvasPrompt: { mentions: mapping, referenceAssets: { 'ref-b': 'asset-b' } }, orderedReferenceIds: ['asset-primary', 'asset-b', 'asset-fixed'], canvasPromptFingerprint: undefined };
  const studioCode = ts.transpileModule(compileBlock, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(studioCode, studio); assert.equal(studio.input.prompt, '图2'); assert.match(studio.canvasPromptFingerprint, /^[a-f0-9]{64}$/);
  studio.orderedReferenceIds = ['asset-b', 'asset-fixed', 'asset-primary'];
  runInNewContext(studioCode, studio); assert.equal(studio.input.prompt, '图1');
  studio.canvasPrompt.referenceAssets['another-ref'] = 'asset-b';
  assert.throws(() => runInNewContext(studioCode, studio), /同一原件/);
  checks.push('02: actual persistent image submit block compiles final role/template/reference order and rejects ambiguous alias originals');

  const legacyImageRoute = 'src/app/api/assets/generate/route.ts';
  const imageAst = ts.createSourceFile(legacyImageRoute, read(legacyImageRoute), ts.ScriptTarget.Latest, true);
  const post = imageAst.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'POST') as ts.FunctionDeclaration;
  const statements = post.body!.statements.find(statement => ts.isTryStatement(statement)) as ts.TryStatement;
  const referenceStart = statements.tryBlock.statements.findIndex(statement => statement.getText(imageAst).startsWith('const rawReferenceImageIds'));
  const referenceEnd = statements.tryBlock.statements.findIndex(statement => statement.getText(imageAst).startsWith('const referenceImages:'));
  assert.ok(referenceStart >= 0 && referenceEnd > referenceStart);
  const referenceCode = ts.transpileModule('(function(){' + statements.tryBlock.statements.slice(referenceStart, referenceEnd).map(statement => statement.getText(imageAst)).join('\n')
    + ';this.selectedIds=referenceImageIds}).call(this)', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const imageInput: any = { AuthError: TestAuthError, parseCanvasPromptMentions, validateCanvasBoundReferenceImageIds,
    canvasDocumentId: 'doc', canvasNodeId: 'node', referenceLimit: 9, input: {} };
  runInNewContext(code('src/lib/reference-albums/permissions.ts', ['uniquePreserveOrder'])
    + code(legacyImageRoute, ['normalizeStringList']), imageInput);
  for (const alias of ['reference_image_ids', 'referenceImageIds']) {
    imageInput.input = { promptMentions: mapping, [alias]: ['ref-b', 'ref-b'] };
    assert.throws(() => runInNewContext(referenceCode, imageInput), /重复/);
    imageInput.input = { promptMentions: mapping, [alias]: [' ref-b '] };
    assert.throws(() => runInNewContext(referenceCode, imageInput), /无效/);
    imageInput.input = { promptMentions: mapping, [alias]: ['ref-a', 'ref-b'] };
    runInNewContext(referenceCode, imageInput); assert.equal(JSON.stringify(imageInput.selectedIds), '["ref-a","ref-b"]');
    imageInput.input = { [alias]: ['ref-b', 'ref-b'] };
    runInNewContext(referenceCode, imageInput); assert.equal(JSON.stringify(imageInput.selectedIds), '["ref-b"]');
  }
  checks.push('02 legacy image: actual snake/camel input branch preserves no-mapping normalization, bound duplicates/invalid IDs reject before normalization');

  let docReads = 0;
  const compatibility: any = { AuthError: TestAuthError, assertCanEditCanvasDocument: async () => {
    docReads++; return { document_json: JSON.stringify({ canvas: { nodes: [{ id: 'node', type: 'image', data: { promptMentions: mapping } }] } }) };
  } };
  runInNewContext(code('src/lib/canvas-prompt-compatibility.ts', ['assertCanvasPromptCompatibility']), compatibility);
  await assert.rejects(compatibility.assertCanvasPromptCompatibility({}, 'doc', 'node', '@图1', undefined), /刷新/);
  await assert.rejects(compatibility.assertCanvasPromptCompatibility({}, 'doc', 'node', '@图1', mapping, 0), /回退版本/);
  await compatibility.assertCanvasPromptCompatibility({}, 'doc', 'node', '旧图1', undefined);
  await compatibility.assertCanvasPromptCompatibility({}, 'doc', 'node', '@图1', mapping);
  assert.equal(docReads, 2);
  checks.push('rollback: actual compatibility guard blocks an old client/new bound document and an unsupported rollback; no write/replay');

  const old = (path: string) => execFileSync('git', ['show', `e2273e5258bc44234cb316ffa41f6ab1156a293a:${path}`], { encoding: 'utf8', maxBuffer: 2000000 });
  const oldDocument = old('src/lib/canvas-documents.ts');
  const oldWorkflow: any = { module: { exports: {} } };
  runInNewContext(old(`${root}generation-node-workflow.js`), oldWorkflow);
  for (const provider of ['seedance', 'volcengine_ip']) {
    const legacy = { mode: 'first-last-frame-video', prompt: '旧手写图1', referenceImageIds: ['same-ref', 'same-ref'], settings: { provider } };
    assert.equal(JSON.stringify(workflow.videoRequest(legacy)), JSON.stringify(oldWorkflow.module.exports.videoRequest(legacy)));
  }
  const legacyImage = { prompt: '旧手写图1', referenceImageIds: ['same-ref', 'same-ref'] };
  assert.equal(JSON.stringify(workflow.imageRequest(legacyImage)), JSON.stringify(oldWorkflow.module.exports.imageRequest(legacyImage)));
  checks.push('legacy: actual no-mapping ordinary/IP same-image frame descriptors and image descriptors remain identical to e227; new binding duplicates/overlimit reject without silent dedupe');
  const reader: any = { Buffer, MAX_CANVAS_BYTES: 2 * 1024 * 1024, CanvasDocumentError: TestAuthError };
  runInNewContext(code('old-document.ts', ['invalid', 'object', 'id', 'checkJson', 'parseCanvasSnapshot'], oldDocument), reader);
  const saved = JSON.stringify({ schema: 'ultimate_canvas.v1', schemaVersion: 2, context: { project_id: 'project' },
    canvas: { nodes: [{ id: 'node', type: 'image', x: 10, y: 20, data: { prompt: '@图1', promptMentions: mapping,
      planReferences: [{ referenceImageId: 'ref-b' }], styleJob: { requestId: 'original-request', submissionState: 'unconfirmed' } } }], connections: [] } });
  const roundtrip = reader.parseCanvasSnapshot(saved, 'project', true);
  assert.equal(JSON.stringify(roundtrip.canvas.nodes[0].data.promptMentions), JSON.stringify(mapping));
  assert.equal(roundtrip.canvas.nodes[0].data.styleJob.requestId, 'original-request');
  const oldCommands: any = { module: { exports: {} } };
  runInNewContext(old(`${root}canvas-commands.js`), oldCommands);
  assert.equal(oldCommands.module.exports.duplicateNodeData(original, new Map(), new Map()).promptMentions, undefined);
  const oldRender: any = { prisma: { workspaceAsset: { findMany: async () => [{ asset_id: 'other-original', role: 'reference_image' }] } } };
  runInNewContext(code('old-collection.ts', ['renderPromptWithAssets'], old('src/lib/assets/collection.ts')), oldRender);
  assert.equal((await oldRender.renderPromptWithAssets('@图1', 'workspace', 'reference-to-video')).assetMapping['图1'], 'other-original');
  checks.push('rollback evidence: actual e227 reader retains new fields, but old duplicate drops binding and legacy renderer uses workspace IDs; unmodified e227 is NOT safe');

  const uploader: any = { DEFAULT_UPLOAD_INVALID_JSON_MESSAGE: 'invalid', UploadNotAcceptedError: class extends Error {},
    notifyUploadProgress: () => {}, sha256File: async () => 'a'.repeat(64), readImageDimensions: async () => ({ width: 10, height: 10 }),
    readMediaMetadata: async () => null, validateClientMediaDuration: () => {}, uploadWithMultipart: async () => null,
    readUploadJsonResponse: async (response: any) => response.value, uploadStageConnectionMessage: (_: string, error: Error) => error.message,
    shouldUseRawFallback: (_: unknown, allowed: boolean) => allowed, uploadWithRawFallbackOrThrow: async (_: unknown, __: unknown, allowed: boolean, message: string) => {
      assert.equal(allowed, false); throw new Error(message);
    }, fetch: async () => ({ ok: true, value: { uploadUrl: 'storage', uploadToken: 'original-ticket', method: 'PUT', headers: {} } }),
    putFileToStorage: async () => { throw new Error('ECONNRESET'); }, uploadWithServerProxyOrRawFallback: async () => { throw new Error('must not fallback'); } };
  runInNewContext(code('src/lib/http/file-upload.ts', ['uploadFileToHistory']), uploader);
  await assert.rejects(uploader.uploadFileToHistory({ size: 100, type: 'image/png', name: 'original.png' }, { preserveUnknown: true }), /未切换链路重传/);
  uploader.fetch = async () => ({ ok: false, status: 403, value: { error: 'explicit pre-file rejection' } });
  await assert.rejects(uploader.uploadFileToHistory({ size: 100, type: 'image/png' }, { preserveUnknown: true }), (error: any) => error instanceof uploader.UploadNotAcceptedError);
  checks.push('03: actual uploader never falls back after an unknown original-byte PUT; explicit pre-file rejection is separately recoverable');

  const logs: any[] = []; let imported = 0, uploads = 0;
  const asset: any = { id: 'asset', owner_id: 'user', status: 'active', type: 'image', original_url: '/original', thumbnail_url: '/thumb',
    file_name: 'original.png', file_size: 123, mime_type: 'image/png', width: 10, height: 10 };
  const api: any = { AuthError: TestAuthError, ReferenceImportError: TestAuthError,
    NextResponse: { json: (value: unknown, options: any = {}) => ({ value, status: options.status || 200 }) },
    MULTIPART_COMPAT_MAX_SIZE_BYTES: 8 * 1024 * 1024, getSession: async () => ({ id: 'user', role: 'member' }), assertInternalOnly: () => {},
    assertCanEditCanvasDocument: async () => {}, getProjectForGeneration: async () => ({ id: 'project' }), assertCanGenerateInVideoCard: async () => {},
    createHash, readCanvasStyleJson: async (request: any) => request.json(),
    prisma: { videoCard: { findUnique: async () => ({ id: 'card', project_id: 'project' }) }, canvasDocument: { findUnique: async () => ({ id: 'doc', owner_user_id: 'user', project_id: 'project', status: 'active' }) },
      asset: { findUnique: async () => asset, findFirst: async (input: any) => { assert.equal(input.where.owner_id, 'user'); assert.equal(input.where.hash, 'a'.repeat(64)); return asset; } },
      operationLog: { findFirst: async () => logs[0] || null, create: async ({ data }: any) => { logs.push(data); } } },
    getOrCreateWorkspace: async () => ({ id: 'workspace' }), addAssetToWorkspace: async () => 'workspace-asset',
    attachAssetToSiteReferenceImage: async (_: unknown, id: string) => { imported++; assert.equal(id, 'asset'); return { referenceImageId: 'ref', workspaceAssetId: 'workspace-asset' }; },
    uploadSiteAsset: async () => { uploads++; throw new Error('must not upload JSON'); } };
  api.prisma.$transaction = async (run: (db: any) => Promise<unknown>) => run(api.prisma);
  runInNewContext(code('src/app/api/tools/ultimate-canvas/upload/route.ts', ['cleanString', 'roleForMimeType', 'parseContentLength', 'POST', 'GET']), api);
  const body: any = { request_id: 'original-request', asset_id: 'asset', project_id: 'project', video_card_id: 'card', canvas_document_id: 'doc', canvas_node_id: 'node' };
  const request = { headers: { get: (key: string) => key === 'content-type' ? 'application/json' : null }, json: async () => body };
  let result = await api.POST(request); assert.equal(result.status, 200); assert.equal(result.value.asset.id, 'asset'); assert.equal(imported, 1); assert.equal(uploads, 0);
  result = await api.POST(request); assert.equal(result.status, 200); assert.equal(imported, 1); assert.equal(logs.length, 1);
  body.canvas_node_id = 'other'; assert.equal((await api.POST(request)).status, 409); body.canvas_node_id = 'node';
  asset.owner_id = 'other'; assert.equal((await api.POST(request)).status, 403); asset.owner_id = 'user';
  body.project_id = 'other'; assert.equal((await api.POST(request)).status, 400); body.project_id = 'project';
  const query = new URLSearchParams({ canvas_document_id: 'doc', project_id: 'project', video_card_id: 'card', hash: 'a'.repeat(64), file_size: '123', mime_type: 'image/png' });
  assert.equal((await api.GET({ nextUrl: { searchParams: query } })).value.found, true);
  checks.push('03: actual JSON association retains context/owner/request+asset+target guards, dedupes receipt, no byte upload; exact owned hash recovery only');

  const storage = new Map<string, string>(); let posts = 0, uploadCalls = 0; const receipts: any[] = [];
  const frameAst = ts.createSourceFile('frame.tsx', read('src/app/tools/ultimate-canvas/CanvasFrame.tsx'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let runUploadsCode = '';
  function find(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(frameAst) === 'runUploads' && node.initializer && ts.isCallExpression(node.initializer)) runUploadsCode = node.initializer.arguments[0].getText(frameAst);
    ts.forEachChild(node, find);
  }
  find(frameAst); assert.ok(runUploadsCode);
  const parent: any = { userId: { current: 'user' }, uploads: { current: new Set() }, validId: (v: unknown) => typeof v === 'string' && /^[a-zA-Z0-9_-]+$/.test(v),
    frame: { current: { contentWindow: { UltimateCanvasUploadContextMatches: () => true, postMessage: (value: any) => receipts.push(value) } } },
    location: { origin: 'https://sd2.youdooart.com' }, URLSearchParams, localStorage: { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    UploadNotAcceptedError: class extends Error {}, readJsonResponse: async (response: any) => response.value,
    fetch: async (_: string, options?: any) => { if (options?.method === 'POST') posts++; return { ok: true, value: options?.method === 'POST' ? { success: true, asset } : { found: false } }; },
    uploadFileAsAsset: async (_: unknown, options: any) => { uploadCalls++; const restored = await options.beforeUpload({ hash: 'a'.repeat(64), fileSize: 123, mimeType: 'image/png' }); if (restored) return restored; throw new Error('response disconnected'); } };
  runInNewContext(code('src/app/tools/ultimate-canvas/CanvasFrame.tsx', ['uploadCanvasOriginal'])
    + ts.transpileModule(`this.runUploads = ${runUploadsCode}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, parent);
  const uploadRequest = { requestId: 'request', userId: 'user', documentId: 'doc', projectId: 'project', cardId: 'card', files: [{ file: {}, nodeId: 'node' }] };
  await parent.runUploads(uploadRequest); assert.equal(storage.size, 1); assert.equal(posts, 0);
  await parent.runUploads(uploadRequest); assert.equal(posts, 0); assert.match(receipts.findLast((entry: any) => entry.error)?.error, /未知/);
  parent.fetch = async (_: string, options?: any) => { if (options?.method === 'POST') posts++; return { ok: true, value: options?.method === 'POST' ? { success: true, asset } : { found: true, asset: { id: 'asset' } } }; };
  await parent.runUploads(uploadRequest); assert.equal(posts, 1); assert.equal(storage.size, 0);
  assert.equal(receipts.filter(entry => entry.success === true).length, 1); assert.equal(uploadCalls, 3);
  checks.push('03: actual parent upload bridge retains unknown marker, no-record cannot repost bytes; known original recovers association only');
  parent.frame.current.contentWindow.UltimateCanvasUploadContextMatches = () => false;
  const previousUploadCalls = uploadCalls, previousPosts = posts;
  await parent.runUploads(uploadRequest);
  assert.equal(uploadCalls, previousUploadCalls); assert.equal(posts, previousPosts);
  const canceled = receipts.findLast((entry: any) => entry.success === false);
  assert.match(canceled.error, /账号已变化/); assert.equal(canceled.assetId, undefined);
  assert.equal(parent.uploads.current.size, 0);
  checks.push('03: actual parent resolves obsolete waiting upload with refusal only; no asset identity/result exposure, no new file POST or association');

  let contextKey = 'original-account-document', queueCalls = 0, writtenNodes = 0;
  const rows: any[] = [];
  const makeElement = () => ({ dataset: {}, children: [] as any[], hidden: false, appendChild(child: any) { this.children.push(child); }, addEventListener() {}, remove() {} });
  const queue: any = { graphEditAllowed: () => true, showCanvasNotice: () => {}, uploadContextKey: () => contextKey,
    crypto: { randomUUID: () => `queue-${rows.length}` }, window: { UltimateCanvasIcons: () => '' },
    document: { querySelector: () => null, createElement: (tag: string) => { const el = makeElement(); if (tag === 'div') rows.push(el); return el; }, body: { appendChild() {} } },
    uploadCanvasFile: async () => { queueCalls++; contextKey = 'other-account-document'; return { asset: { id: 'original' } }; },
    engine: { nodes: new Map() }, createUploadedNode: () => writtenNodes++ };
  runInNewContext(code(`${root}app.js`, ['queueCanvasFiles']), queue);
  queue.queueCanvasFiles([{ name: 'a.png', type: 'image/png' }, { name: 'b.png', type: 'image/png' }], 10, 20);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(queueCalls, 1); assert.equal(writtenNodes, 0);
  assert.equal(rows[2].children[1].textContent, '画布或账号已变化，未上传此文件');
  checks.push('03: actual queued File snapshot blocks later upload/association after account-document switch, not just active upload callback');

  const source = read(`${root}app.js`);
  assert.match(source, /mediaType: type, mediaUrl: asset.id/);
  assert.match(source, /\['upload', 'asset', 'reference_image'\].includes\(node.data\?\.source\)/);
  assert.match(source, /'参考预览'/); assert.match(read(`${root}canvas-engine.js`), /summary, video, audio/);
  checks.push('04: import/taskless media restoration and independent reference display source contracts (not visual acceptance)');
  for (const check of checks) process.stdout.write(`PASS ${check}\n`);
  process.stdout.write(`CAN37 integrated offline groups: ${checks.length}\n`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
