import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const baseline = process.argv.find(v => v.startsWith('--baseline='))?.split('=')[1];
if (baseline && !/^[a-f0-9]{40}$/.test(baseline)) throw Error('Invalid baseline');
const source = (file: string) => baseline ? execFileSync('git', ['show', `${baseline}:${file}`], { encoding: 'utf8' }) : readFileSync(file, 'utf8');
function compile(file: string, names?: string[], current = false) {
  const ast = ts.createSourceFile(file, current ? readFileSync(file, 'utf8') : source(file), ts.ScriptTarget.Latest, true);
  const found = new Map<string, string>();
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name && names?.includes(node.name.text)) found.set(node.name.text, node.getText(ast));
    ts.forEachChild(node, visit);
  }
  visit(ast);
  names?.forEach(name => assert.ok(found.has(name), name));
  const body = names ? names.map(name => found.get(name)).join('\n')
    : ast.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(ast)).join('\n');
  return ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
}
const plain = (value: any) => JSON.parse(JSON.stringify(value));

async function diagnostics() {
  const helper: any = { exports: {}, Date };
  runInNewContext(compile('src/lib/provider/create-diagnostic.ts', undefined, true), helper);
  const build = helper.exports.providerCreateDiagnostic;
  const inline = 'data:image/png;base64,QUJDRA==';
  const body = { model: 'fixture', content: [{ image_url: { url: inline } }, { text: 'private prompt Chinese: 中文' }], apiKey: 'private-fixture-key' };
  const network: any = new TypeError('fetch failed', { cause: Object.assign(new Error('private secret cause text'), { code: 'ECONNRESET', stack: 'private-stack' }) });
  const cases = [
    { response: null, error: network, phase: 'fetch', status: null, code: 'ECONNRESET' },
    { response: { status: 413, ok: false, text: async () => { throw network; } }, phase: 'response_body', status: 413, code: 'ECONNRESET' },
    { response: { status: 413, ok: false, text: async () => '<html>private raw reply</html>' }, phase: 'response_parse', status: 413 },
    { response: { status: 429, ok: false, text: async () => '{"error":"busy"}' }, phase: 'response_validation', status: 429 },
    { response: { status: 200, ok: true, text: async () => '' }, phase: 'response_validation', status: 200 },
    { response: { status: 201, ok: true, text: async () => '{"id":"provider-fixture"}' }, phase: 'complete', status: 201 },
  ];
  for (const fixture of cases) {
    let calls = 0, diagnostic: any, wire = '';
    const logs: any[] = [];
    const c: any = { exports: {}, Buffer, Date, providerCreateDiagnostic: build,
      isApiKeyConfigured: () => true, SEEDANCE_BASE_URL: 'https://example.invalid/server/api', SEEDANCE_API_KEY: 'private-fixture-key',
      SEEDANCE_INLINE_REQUEST_MAX_BYTES: 64000000, buildSeedanceVideoPayload: () => body,
      maskKey: () => '***', redactInlineImageTransport: (v: any) => v,
      normalizeProviderErrorMessage: () => 'Provider fixture rejected', createNonJsonProviderError: () => Error('Non-JSON fixture'),
      console: { log: () => {}, error: (...args: any[]) => logs.push(args) },
      fetch: async (url: string, options: any) => {
        calls++; assert.equal(url, 'https://example.invalid/server/api/call');
        assert.deepEqual(Object.keys(options).sort(), ['body', 'headers', 'method']);
        assert.equal(options.method, 'POST'); wire = options.body;
        if (fixture.error) throw fixture.error;
        return fixture.response;
      } };
    runInNewContext(compile('src/lib/provider/jimeng.ts', ['createVideoTask']) + ';this.create=createVideoTask;', c);
    const operation = c.create({ generation_mode: 'all_in_one_reference', prompt: 'private prompt' }, (value: any) => { diagnostic = plain(value); });
    if (fixture.phase === 'complete') assert.equal((await operation).provider_task_id, 'provider-fixture');
    else await assert.rejects(operation);
    assert.equal(calls, 1, 'never retry create');
    assert.equal(wire, JSON.stringify(body), 'exact existing payload unchanged');
    assert.ok(diagnostic, 'Provider create must capture bounded diagnostic');
    assert.equal(diagnostic.encoded_json_bytes, Buffer.byteLength(wire));
    assert.equal(diagnostic.http_status, fixture.status);
    assert.equal(diagnostic.phase, fixture.phase);
    assert.ok(diagnostic.elapsed_ms >= 0);
    assert.equal(diagnostic.cause?.code || undefined, fixture.code);
    const stored = JSON.stringify({ diagnostic, logs });
    for (const forbidden of [inline, 'private prompt', 'private-fixture-key', 'private secret', 'private-stack', 'private raw reply']) assert.ok(!stored.includes(forbidden), forbidden);
    if (fixture.phase === 'complete') await c.create({ generation_mode: 'all_in_one_reference' }, () => { throw Error('observer failure'); });
  }
  const arbitrary = build({ phase: 'fetch', startedAt: Date.now(), encodedJsonBytes: 1, httpStatus: null,
    error: { name: 'private-name', code: 'PRIVATE_TOKEN', cause: { name: 'Error', code: 'PRIVATE_TOKEN', message: inline, stack: inline } } });
  assert.deepEqual(plain(arbitrary.cause), { name: 'Error', code: null }); assert.equal(arbitrary.code, null);
  const updates: any[] = [];
  const c: any = { exports: {}, Date, providerName: () => 'seedance', prisma: { providerApiRequest: { update: async (v: any) => updates.push(plain(v)) },
    $transaction: async (fn: any) => fn({ providerApiRequest: { update: async (v: any) => updates.push(plain(v)) }, costLedger: { upsert: async () => {} } }) } };
  runInNewContext(compile('src/lib/costs/ledger.ts', ['markProviderApiRequestAccepted', 'markProviderApiRequestFailed']), c);
  await c.exports.markProviderApiRequestFailed({ requestId: 'request-fixture', httpStatus: null, responseSummary: { seedance_diagnostic: arbitrary } });
  await c.exports.markProviderApiRequestAccepted({ requestId: 'request-fixture', task: { id: 'task-fixture' }, httpStatus: 201 });
  await c.exports.markProviderApiRequestFailed({ requestId: 'other-provider-fixture' });
  assert.equal(updates[0].data.http_status, null); assert.equal(updates[1].data.http_status, 201);
  assert.ok(!('http_status' in updates[2].data), 'other providers unchanged');
  const route = source('src/app/api/tasks/create/route.ts');
  assert.equal((route.match(/seedance_diagnostic: seedanceDiagnostic.value/g) || []).length, 2);
  assert.ok(route.includes('createVideoTask({ ...providerInput, ...seedanceReferenceTransport }, diagnostic'));
}

function errorHandlerSource() {
  const ast = ts.createSourceFile('app.js', source('public/tools/ultimate-canvas/app.js'), ts.ScriptTarget.Latest, true);
  let body = '';
  function visit(node: ts.Node, inside = false) {
    const scoped = inside || ts.isFunctionDeclaration(node) && node.name?.text === 'submitNodeGeneration';
    if (scoped && ts.isPropertyAssignment(node) && node.name.getText(ast) === 'onError') body = node.initializer.getText(ast);
    ts.forEachChild(node, child => visit(child, scoped));
  }
  visit(ast); assert.ok(body);
  return ts.transpileModule('this.handle=' + body, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}

async function receipts() {
  const workflow: any = { window: {} };
  runInNewContext(readFileSync('public/tools/ultimate-canvas/generation-node-workflow.js', 'utf8'), workflow);
  for (const scenario of ['failed', 'save-error', 'submitted', 'mismatch', 'empty', 'lookup-error', 'foreign-user', 'stale', 'wrong-state']) {
    const submission: any = { state: 'unconfirmed', userId: 'owner', documentId: 'canvas-fixture', requestId: 'original-request',
      input: { prompt: 'authored text' }, generationPayload: { nodeId: 'video-fixture', requestId: 'original-request' } };
    if (scenario === 'foreign-user') submission.userId = 'other';
    const node: any = { id: 'video-fixture', data: { videoSubmission: submission, authoredText: 'authored text' } };
    let gets = 0, flush = 0, polls = 0;
    const statuses: any[] = [];
    const c: any = { exports: {}, URLSearchParams, CSS: { escape: (v: string) => v },
      engine: { nodes: new Map([[node.id, node]]) }, document: { querySelector: () => ({ querySelector: () => null }) },
      canvasRuntime: { bootstrap: { user: { id: 'owner' } }, documentId: 'canvas-fixture', selectedVideoCardId: 'card-fixture' },
      currentGenerationContext: () => ({ documentId: 'canvas-fixture' }), setNodeGenerationStatus: (_el: any, state: string) => statuses.push(state),
      requestJson: async (url: string, options: any) => {
        gets++; assert.equal(options.cache, 'no-store'); assert.ok(url.startsWith('/api/tools/ultimate-canvas/video-submission?'));
        const query = new URL(url, 'https://example.invalid').searchParams;
        assert.equal(query.get('document_id'), 'canvas-fixture'); assert.equal(query.get('node_id'), node.id); assert.equal(query.get('request_id'), 'original-request');
        if (scenario === 'lookup-error') throw Error('lookup fixture failed');
        return { state: scenario === 'wrong-state' ? 'unconfirmed' : 'accepted', task: scenario === 'empty' ? null : {
          id: scenario === 'mismatch' ? 'other-task' : 'local-task', local_status: scenario === 'submitted' ? 'submitted' : 'failed' } };
      },
      flushCanvasSave: async () => { flush++; if (scenario === 'save-error') throw Error('save fixture failed'); }, scheduleCanvasSave: () => {}, showCanvasNotice: () => {}, syncNodeDataFromDom: () => {},
      pollVideoTask: () => { polls++; }, renderVideoResultHistory: () => {}, decorateGeneratedNode: () => {}, renderGenerationNodeControls: () => {},
      videoPreviewForTask: () => '', taskDescription: () => 'task state', videoStageLabel: () => 'task state',
      window: { UltimateCanvasGenerationNodes: workflow.UltimateCanvasGenerationNodes,
        UltimateCanvasGenerationInteractions: { generationContextMatches: () => scenario !== 'stale' } } };
    runInNewContext(compile('public/tools/ultimate-canvas/app.js', ['recoverVideoSubmission', 'applyVideoGenerationResult', 'applyVideoTaskStatus']) + ';this.recover=recoverVideoSubmission;', c);
    const confirmed = await c.recover(node.id, 'local-task');
    if (['failed', 'save-error', 'submitted'].includes(scenario)) {
      if (scenario !== 'submitted') assert.equal(statuses.at(-1), 'error', 'known failed receipt cannot become loading or unconfirmed');
      assert.equal(confirmed, true); assert.equal(node.data.taskId, 'local-task'); assert.equal(submission.state, 'accepted');
      assert.equal(node.data.authoredText, 'authored text'); assert.equal(node.data.videoHistory.length, 1); assert.equal(flush, 1); assert.equal(polls, 1);
      if (scenario !== 'submitted') { assert.equal(node.data.generationStatus, 'failed');
        assert.equal(node.data.generationResult.task_id, 'local-task'); assert.equal(Object.keys(node.data.generationResult).length, 12); }
    } else { assert.ok(!confirmed); assert.equal(submission.state, 'unconfirmed'); assert.equal(node.data.taskId, undefined); assert.equal(polls, 0); assert.equal(flush, 0); }
    assert.equal(gets, scenario === 'foreign-user' ? 0 : 1, 'one bounded receipt GET only');
  }
  for (const taskId of ['local-task', 'other-task', '', '<invalid>']) {
    let lookedUp = '', attached = false, warns = 0;
    const payload = { kind: 'video', nodeId: 'video-fixture', requestId: 'original-request' };
    const c: any = { payload, capturedContext: {}, currentGenerationContext: () => ({}),
      engine: { nodes: new Map([[payload.nodeId, { data: { videoSubmission: { requestId: payload.requestId } } }]]) }, nodeEl: {},
      window: { UltimateCanvasGenerationInteractions: { generationContextMatches: () => true } },
      recoverVideoSubmission: async (_id: string, expected: string) => { lookedUp = expected; attached = expected === 'local-task'; return attached; },
      setNodeGenerationStatus: () => { warns++; }, scheduleCanvasSave: () => {}, showCanvasNotice: () => {} };
    runInNewContext(errorHandlerSource(), c);
    await c.handle({ response: { task_id: taskId } });
    assert.equal(lookedUp, /^[a-zA-Z0-9_-]{1,160}$/.test(taskId) ? taskId : '');
    assert.equal(attached, taskId === 'local-task'); assert.equal(warns, attached ? 0 : 1);
  }
  const route = source('src/app/api/tools/ultimate-canvas/video-submission/route.ts');
  for (const guard of ['submission.userId !== user.id', 'submission.documentId !== document.id', 'task.video_card_id !== submission.cardId', 'metadata.canvas_node_id !== nodeId', 'assertCanViewTask(user, task)']) assert.ok(route.includes(guard));
}

async function main() {
  const selected = process.argv.find(v => v.startsWith('--case='))?.split('=')[1];
  if (!selected || selected === 'C04-DIAG') await diagnostics();
  if (!selected || selected === 'C04-RECEIPT') await receipts();
  console.log('PRE34 correction04: bounded native diagnostics, exact wire bytes/HTTP phases, strict original receipt and failed safe projection checked offline; no DB/Provider/browser/fees');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
