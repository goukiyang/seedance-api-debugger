import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { attachStoryVideo, type StoryCanvas } from '../src/app/story-studio/story-handoff';
import { canvasTextWaitMs, STORY_TEXT_CLIENT_WAIT_MS } from '../src/lib/story-text-contract';
import { seedanceLocalReferenceTransport } from '../src/lib/provider/reference-image-transport';
import type { PickerItem } from '../src/lib/assets/picker-types';
import type { CreateVideoInput } from '../src/types';
import { STUDIO_TEXT_MODELS, isStudioTextModel } from '../src/lib/template-studio/text-models';
import { buildContentArray, buildSeedanceVideoPayload, redactInlineImageTransport, buildProviderHttpErrorStatus, mapProviderStatus } from '../src/lib/provider/jimeng';
import { normalizeProviderErrorMessage, providerFailureUserMessage } from '../src/lib/provider/error-message';
import { providerCreateDiagnostic } from '../src/lib/provider/create-diagnostic';

function actual(file: string, names: string[]) {
  const source = readFileSync(file, 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found = new Map<string, string>();
  function visit(node: ts.Node) {
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name && names.includes(node.name.text)) found.set(node.name.text, node.getText(ast));
    ts.forEachChild(node, visit);
  }
  visit(ast);
  for (const name of names) assert.ok(found.has(name), `${file}:${name}`);
  return ts.transpileModule(names.map(name => found.get(name)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
}

async function textTransport() {
  const c: any = { exports: {}, URL, Buffer, AbortController, Date, setTimeout, clearTimeout };
  runInNewContext(actual('src/lib/integrations/musk.ts', ['MuskApiError', 'isMuskApiReady', 'buildChatCompletionsUrl', 'safeMuskRequestId', 'createMuskChatCompletion']), c);
  const settings = { enabled: true, base_url: 'https://example.invalid', default_model: 'gpt-5.5', api_key: 'fixture-secret-not-real' };
  const base = { settings, messages: [{ role: 'user', content: '完整剧本' }] };
  let sent: any;
  const completion = await c.exports.createMuskChatCompletion({ ...base, timeoutMs: 1000,
    fetchImpl: async (_url: unknown, options: any) => {
      sent = JSON.parse(options.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'complete script' } }], model: 'gpt-5.5' }), { headers: { 'x-request-id': 'req-123' } });
    } });
  assert.equal(completion.content, 'complete script'); assert.equal(sent.model, 'gpt-5.5');
  assert.equal(completion.diagnostics.phase, 'completed');
  assert.equal(completion.diagnostics.upstreamRequestId, 'req-123');
  assert.ok(completion.diagnostics.requestBytes > completion.diagnostics.requestChars);
  assert.ok(!JSON.stringify(completion.diagnostics).includes('fixture-secret'));
  assert.ok(!JSON.stringify(completion.diagnostics).includes('完整剧本'));
  for (const phase of ['awaiting_headers', 'reading_body']) {
    const awaitAbort = (signal: AbortSignal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
    await assert.rejects(c.exports.createMuskChatCompletion({ ...base, timeoutMs: 5,
      fetchImpl: async (_url: unknown, options: any) => phase === 'awaiting_headers' ? awaitAbort(options.signal)
        : { status: 200, ok: true, headers: new Headers({ 'x-request-id': 'unsafe / bearer string' }), text: () => awaitAbort(options.signal) },
    }), (error: any) => { assert.equal(error.code, 'musk_api_timeout'); assert.equal(error.status, 504);
      assert.equal(error.diagnostics.phase, phase); assert.equal(error.diagnostics.upstreamRequestId, null);
      assert.equal(error.diagnostics.headersMs !== null, phase === 'reading_body'); return true; });
  }
  await assert.rejects(c.exports.createMuskChatCompletion({ ...base, fetchImpl: async () => { throw Object.assign(new Error('secret internal URL'), { cause: { code: 'ENOTFOUND' } }); } }),
    (error: any) => { assert.equal(error.code, 'musk_api_request_failed'); assert.equal(error.diagnostics.networkCode, 'ENOTFOUND'); assert.ok(!JSON.stringify(error).includes('secret internal URL')); return true; });
  const purpose: any = { exports: {} };
  runInNewContext(actual('src/lib/canvas-text-settings.ts', ['canvasRulePurpose']), purpose);
  assert.equal(purpose.exports.canvasRulePurpose('script', 'text', 'text'), 'text');
  assert.equal(purpose.exports.canvasRulePurpose('script', 'text'), 'storyboard');
  assert.equal(purpose.exports.canvasRulePurpose('text', 'text'), 'text');
  assert.equal(purpose.exports.canvasRulePurpose('script', 'video-prompt-enhance', 'text'), 'prompt');
  assert.equal(canvasTextWaitMs('script', 'script'), 180000);
  assert.equal(canvasTextWaitMs('script', 'storyboard'), 180000);
  assert.equal(canvasTextWaitMs('script', undefined), 60000);
  assert.equal(canvasTextWaitMs('text', 'script'), 60000);
  assert.ok(STORY_TEXT_CLIENT_WAIT_MS > canvasTextWaitMs('script', 'script'));
}

async function originalTransport() {
  const url = 'https://sd2.youdooart.com/uploads/assets/fixture.png';
  const bytes = Buffer.from('original fixture bytes');
  const asset = { original_url: url, type: 'image', status: 'active', mime_type: 'image/png', file_size: bytes.length };
  const input = { generation_mode: 'all_in_one_reference', prompt: 'shot', reference_image_urls: [url, 'https://remote.invalid/image.png'] } as CreateVideoInput;
  const before = structuredClone(input); let reads = 0;
  const read = async (source: string) => { assert.equal(source, url); reads++; return bytes; };
  assert.deepEqual(await seedanceLocalReferenceTransport(input, [], read), {}); assert.equal(reads, 0);
  assert.deepEqual(await seedanceLocalReferenceTransport(input, [{ url, asset: { ...asset, status: 'deleted' } }], read), {});
  const patch = await seedanceLocalReferenceTransport(input, [{ url, asset }], read);
  assert.equal(reads, 1); assert.equal(patch.reference_image_base64_data?.[0], `data:image/png;base64,${bytes.toString('base64')}`);
  assert.equal(patch.reference_image_base64_data?.[1], input.reference_image_urls![1], 'mixed external references must not disappear');
  assert.deepEqual(input, before, 'durable original URL identity is untouched');
  const content = buildContentArray({ ...input, ...patch });
  assert.equal(content[1].image_url?.url, patch.reference_image_base64_data![0]);
  assert.equal(content[1].role, 'reference_image');
  assert.ok(Buffer.byteLength(JSON.stringify(buildSeedanceVideoPayload({ ...input, ...patch }))) < 64_000_000);
  const echo = redactInlineImageTransport({ id: 'provider-fixture', content, error: `invalid content[1].image_url: ${patch.reference_image_base64_data![0]}`, base64: bytes.toString('base64') });
  assert.ok(!JSON.stringify(echo).includes(bytes.toString('base64')));
  assert.ok(JSON.stringify(echo).includes('provider-fixture'));
  assert.ok(JSON.stringify(echo).includes('content[1].image_url'));
  const taskRoute = readFileSync('src/app/api/tasks/create/route.ts', 'utf8');
  const ledgerPayload = taskRoute.slice(taskRoute.indexOf('    const providerRequest = await createProviderApiRequest'), taskRoute.indexOf('    providerRequestId = providerRequest.id;'));
  assert.ok(ledgerPayload.length, 'actual ledger boundary exists');
  assert.ok(!ledgerPayload.includes('seedanceReferenceTransport'), 'original URL-based ledger hash remains unchanged');
  const output: string[] = [];
  let status = 200, providerCalls = 0;
  const providerContext: any = { exports: {}, Buffer, providerCreateDiagnostic,
    isApiKeyConfigured: () => true, buildSeedanceVideoPayload,
    SEEDANCE_BASE_URL: 'https://example.invalid/never-connect', SEEDANCE_API_KEY: '', SEEDANCE_INLINE_REQUEST_MAX_BYTES: 64000000,
    redactInlineImageTransport, normalizeProviderErrorMessage, maskKey: () => '***',
    console: { log: (...items: unknown[]) => output.push(items.map(item => String(item)).join(' ')), error: (...items: unknown[]) => output.push(items.map(item => String(item)).join(' ')) },
    fetch: async (_url: string, options: any) => { providerCalls++; assert.equal(JSON.parse(options.body).content[1].image_url.url, patch.reference_image_base64_data![0]);
      return new Response(JSON.stringify({ id: 'provider-fixture', content, error: { code: 'InvalidParameter', message: `content[1].image_url ${patch.reference_image_base64_data![0]}` } }), { status }); },
  };
  runInNewContext(actual('src/lib/provider/jimeng.ts', ['createNonJsonProviderError', 'createVideoTask']), providerContext);
  const accepted = await providerContext.exports.createVideoTask({ ...input, ...patch });
  assert.ok(!JSON.stringify(accepted).includes(bytes.toString('base64')), 'provider raw receipt cannot persist an echoed input');
  status = 400;
  await assert.rejects(providerContext.exports.createVideoTask({ ...input, ...patch }), (error: any) => {
    assert.ok(error.message.includes('content[1].image_url')); assert.ok(!error.message.includes(bytes.toString('base64'))); return true;
  });
  assert.equal(providerCalls, 2, 'offline provider boundary only; no automatic retry');
  assert.ok(!output.join('\n').includes(bytes.toString('base64')), 'provider log cannot contain echoed inline originals');
  providerContext.buildProviderHttpErrorStatus = buildProviderHttpErrorStatus;
  providerContext.mapProviderStatus = mapProviderStatus; providerContext.providerFailureUserMessage = providerFailureUserMessage;
  providerContext.fetch = async () => new Response(JSON.stringify({ id: 'provider-fixture', status: 'failed',
    echoedInput: content, error: { code: 'InvalidParameter', message: `content[1].image_url ${patch.reference_image_base64_data![0]}` } }), { status: 200 });
  runInNewContext(actual('src/lib/provider/jimeng.ts', ['pickNumber', 'pickString', 'maskVideoUrl', 'redactProviderResponseForLog', 'getVideoTaskStatus', 'getVideoTaskStatusByClientRequestId']), providerContext);
  for (const lookup of [providerContext.exports.getVideoTaskStatus, providerContext.exports.getVideoTaskStatusByClientRequestId]) {
    const receipt = await lookup('provider-fixture');
    assert.equal(receipt.local_status, 'failed');
    assert.ok(!JSON.stringify(receipt).includes(bytes.toString('base64')), 'status/error raw receipt cannot persist echoed inline originals');
  }
  assert.ok(!output.join('\n').includes(bytes.toString('base64')), 'status logs cannot contain encoded originals');
  await assert.rejects(seedanceLocalReferenceTransport(input, [{ url, asset }], async () => Buffer.from('wrong bytes')), /不一致/);
  await assert.rejects(seedanceLocalReferenceTransport(input, [{ url, asset: { ...asset, file_size: 30_000_000 } }], read), /30MB/);
  const beforeOversize = reads;
  await assert.rejects(seedanceLocalReferenceTransport({ ...input, reference_image_urls: [url, url, url] },
    [{ url, asset: { ...asset, file_size: 19_453_407 } }], read), /64MB/);
  assert.equal(reads, beforeOversize, 'wire limit rejects before reading original bytes');
  const beforeFrames = reads;
  const frames = await seedanceLocalReferenceTransport({ ...input, generation_mode: 'first_last_frame', first_frame_url: url, last_frame_url: url }, [{ url, asset }], read);
  assert.equal(frames.first_frame_base64_data, frames.last_frame_base64_data);
  assert.equal(reads, beforeFrames + 1, 'duplicate frame reads the original once');
}

async function storyRoute() {
  const file = 'src/app/api/tools/ultimate-canvas/generate/route.ts';
  const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const code = ts.transpileModule(ast.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(ast)).join('\n'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  class AuthError extends Error { constructor(message: string, public status: number) { super(message); } }
  class MuskApiError extends Error {}
  for (const fixture of [
    { stage: 'script', saved: true, model: STUDIO_TEXT_MODELS[0].id, status: 200, wait: 180000 },
    { stage: 'storyboard', saved: true, status: 200, wait: 180000 },
    { saved: true, status: 200, wait: 60000 },
    { stage: 'script', saved: false, status: 400 },
    { stage: 'invalid', saved: true, status: 400 },
    { stage: 'script', saved: true, model: 'unapproved-model', status: 400 },
  ] as Array<Record<string, any>>) {
    let calls = 0; const logs: any[] = [];
    const doc = { id: 'doc', owner_user_id: 'owner', project_id: 'project', document_json: JSON.stringify({ canvas: { nodes: fixture.saved ? [{ id: 'node', type: 'script', data: { storyWorkflow: {} } }] : [] } }) };
    const c: any = { exports: {}, AuthError, MuskApiError, console: { warn() {} },
      getSession: async () => ({ id: 'owner', role: 'member' }), assertInternalOnly() {},
      assertCanEditCanvasDocument: async () => doc, getProjectForGeneration: async () => ({ id: 'project' }),
      prisma: { canvasDocument: { findUnique: async () => doc }, operationLog: { create: async (value: any) => logs.push(JSON.parse(value.data.detail)) } },
      getMuskApiSettings: async () => ({ default_model: 'gpt-5.5', enabled: true }), isMuskApiReady: () => true,
      isStudioTextModel, canvasTextWaitMs, getCanvasTextSettings: async () => ({ revision: 1 }),
      canvasRulePurpose: (_kind: string, _mode: string, purpose: string) => purpose || 'storyboard',
      compileCanvasTextRules: () => ({ basicRules: [], purposeRules: [], nodeRules: [], trace: { rules: [], libraryRevision: 1 } }),
      NextResponse: { json: (body: unknown, options: any = {}) => ({ body, status: options.status || 200 }) }, randomUUID: () => 'fixture-request',
      createMuskChatCompletion: async (params: any) => { calls++; assert.equal(params.timeoutMs, fixture.wait);
        assert.equal(params.settings.default_model, fixture.model || 'gpt-5.5');
        return { content: JSON.stringify({ content: '完整稿', title: '稿', summary: '', nextActions: [] }), model: params.settings.default_model, diagnostics: { phase: 'completed' } }; },
    };
    runInNewContext(code, c);
    const response = await c.exports.POST({ json: async () => ({ kind: 'script', prompt: '原故事', nodeId: 'node', canvas_document_id: 'doc', project_id: 'project',
      ...(fixture.stage ? { story_stage: fixture.stage } : {}), ...(fixture.model ? { model: fixture.model } : {}), source_request_id: 'source-123', textPurpose: 'text' }) });
    assert.equal(response.status, fixture.status); assert.equal(calls, fixture.status === 200 ? 1 : 0);
    if (calls) { assert.equal(logs[0].source_request_id, 'source-123'); assert.equal(logs[0].model, fixture.model || 'gpt-5.5'); assert.equal(logs[0].diagnostics.phase, 'completed'); }
  }
}

function handoffAndSelection() {
  const shot = { id: 's1', title: '放纸船', description: '镜头画面', dialogue: '', imagePrompt: '画面', videoPrompt: '放船后收手', durationSeconds: 5 };
  const graph: StoryCanvas = { canvas: { nodes: [
    { id: 'source', type: 'script', x: 0, y: 0, data: {} },
    { id: 'existing', type: 'video', x: 800, y: 0, data: { taskId: 'keep-job', generationStatus: 'running' } },
  ], connections: [], viewport: { scale: .75, offsetX: 50, offsetY: 60 } } };
  const before = structuredClone(graph);
  const ref = { type: 'image', width: 3840, height: 2160, referenceImageId: 'ref', originalUrl: '/api/image-studio/assets/ref', fileName: '原图' } as PickerItem;
  attachStoryVideo(graph, 'source', shot, 0, ref, 'video', 'image', 7);
  const video = graph.canvas.nodes.find(n => n.id === 'video')!, image = graph.canvas.nodes.find(n => n.id === 'image')!;
  assert.equal((image.data.imageSettings as any).ratio, '16:9');
  assert.equal(image.data.width, 3840); assert.equal(image.data.height, 2160);
  assert.ok(video.x >= image.x + 640 + 100); assert.ok(image.x >= 800 + 640 + 100);
  assert.equal(video.data.title, shot.title); assert.equal(image.data.title, '放纸船 · 原图');
  assert.equal(graph.canvas.selectedNodeId, 'video'); assert.deepEqual(graph.canvas.viewport, before.canvas.viewport);
  assert.deepEqual(graph.canvas.nodes.slice(0, 2), before.canvas.nodes);
  const dimensionContext: any = { exports: {}, engine: { nodes: new Map([['image', image]]) }, generationNodeLongEdge: () => 640,
    window: { UltimateCanvasGenerationInteractions: { ratioFromImageDimensions: () => '16:9' } } };
  runInNewContext(actual('public/tools/ultimate-canvas/app.js', ['applyGenerationNodeDimensions']) + '\nexports.dimensions=applyGenerationNodeDimensions;', dimensionContext);
  const properties = new Map();
  const element = { dataset: { nodeId: 'image' }, style: { setProperty: (key: string, value: string) => properties.set(key, value) } };
  dimensionContext.exports.dimensions(element, { ratio: '1:1' });
  assert.equal(properties.get('--generation-node-width'), '640px'); assert.equal(properties.get('--generation-node-height'), '360px');
  const code = actual('public/tools/ultimate-canvas/canvas-engine.js', ['CanvasEngine']);
  const c: any = { exports: {}, document: { getElementById: () => null }, window: {} };
  runInNewContext(code + '\nexports.Engine=CanvasEngine;', c);
  let selected: string | null = null;
  const engine: any = { canvas: { querySelectorAll: () => [] }, svg: { querySelectorAll: () => [] }, nodes: new Map(), selectedNodeIds: new Set(),
    addNode: (_type: string, x: number, y: number, data: any) => { engine.nodes.set(data.id, { x, y, data }); selected = data.id; },
    _createConnection() {}, _applyTransform() {}, _updateZoom() {}, _updateConnections() {}, _notifyCanvasGeometryChanged() {},
    _selectNode: (id: string) => selected = id, _deselectAll: () => selected = null };
  c.exports.Engine.prototype.restore.call(engine, { ...graph.canvas, planSplits: {} });
  assert.equal(selected, 'video', 'last inserted image cannot override saved selection');
  c.exports.Engine.prototype.restore.call(engine, { ...graph.canvas, planSplits: {}, selectedNodeId: 'deleted' });
  assert.equal(selected, null);
}

async function receiptRecovery() {
  const submission = { state: 'unconfirmed', userId: 'owner', documentId: 'canvas', requestId: 'original-request', generationPayload: { nodeId: 'video', requestId: 'original-request' } };
  const node: any = { id: 'video', data: { videoSubmission: submission } };
  let get = 0, flush = 0, apply = 0;
  const c: any = { exports: {}, URLSearchParams, CSS: { escape: (v: string) => v },
    engine: { nodes: new Map([['video', node]]) }, document: { querySelector: () => ({ querySelector: () => null }) },
    canvasRuntime: { bootstrap: { user: { id: 'owner' } }, documentId: 'canvas', documentOperation: true, saveConflict: true },
    currentGenerationContext: () => ({ documentId: 'canvas' }), setNodeGenerationStatus() {},
    requestJson: async (url: string) => { get++; assert.ok(url.includes('request_id=original-request')); return { state: 'accepted', task: { id: 'failed-task', local_status: 'failed' } }; },
    flushCanvasSave: async () => { flush++; return false; },
    window: { UltimateCanvasGenerationInteractions: { generationContextMatches: () => true } },
    applyVideoGenerationResult: (_el: unknown, payload: any, result: any) => { assert.equal(payload.requestId, 'original-request'); assert.equal(result.local_status, 'failed'); submission.state = 'accepted'; apply++; },
  };
  runInNewContext(actual('public/tools/ultimate-canvas/app.js', ['recoverVideoSubmission']) + '\nexports.recover=recoverVideoSubmission;', c);
  await c.exports.recover('video'); assert.equal(get, 1); assert.equal(apply, 1); assert.equal(flush, 0);
  submission.state = 'unconfirmed'; submission.userId = 'other';
  await c.exports.recover('video'); assert.equal(get, 1, 'account mismatch blocks lookup');
  const route = readFileSync('src/app/api/tools/ultimate-canvas/video-submission/route.ts', 'utf8');
  for (const guard of ['submission.userId !== user.id', 'submission.documentId !== document.id', 'task.video_card_id !== submission.cardId', 'metadata.canvas_node_id !== nodeId', 'assertCanViewTask(user, task)']) assert.ok(route.includes(guard));
}

async function main() {
  await textTransport(); await storyRoute(); await originalTransport(); handoffAndSelection(); await receiptRecovery();
  console.log('PRE34 correction02: actual purpose/transport timing, original-byte handoff, dimensions/selection, receipt recovery executed offline; no DB/network/Provider/browser/fees');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
