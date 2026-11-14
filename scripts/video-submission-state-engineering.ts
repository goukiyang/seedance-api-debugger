import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { isVideoSubmissionUnconfirmed, videoPendingStatusLabel, videoSubmissionUnknownMessage } from '../src/components/generate/video-submission-state';
import { videoDeliveryStageForTask } from '../src/lib/video/delivery-status';

const source = fs.readFileSync('src/components/generate/GeneratePageClient.tsx', 'utf8');
const file = ts.createSourceFile('GeneratePageClient.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function callback(name: string) {
  let result: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === name && node.initializer) {
      assert.equal(result, undefined);
      result = ts.isCallExpression(node.initializer) ? node.initializer.arguments[0] : node.initializer;
    }
    ts.forEachChild(node, visit);
  }
  visit(file); assert.ok(result);
  return ts.transpileModule(`module.exports = ${result.getText(file)}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
}

function submitErrorResponseBranch() {
  let submit: ts.Node | undefined;
  function findSubmit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'handleSubmit'
      && node.initializer && ts.isCallExpression(node.initializer)) submit = node.initializer.arguments[0];
    ts.forEachChild(node, findSubmit);
  }
  findSubmit(file); assert.ok(submit);
  const property = (node: ts.Node, receiver: string, name: string) => ts.isPropertyAccessExpression(node)
    && ts.isIdentifier(node.expression) && node.expression.text === receiver && node.name.text === name;
  const branches: ts.IfStatement[] = [];
  function findBranch(node: ts.Node) {
    if (ts.isIfStatement(node) && ts.isPrefixUnaryExpression(node.expression)
      && node.expression.operator === ts.SyntaxKind.ExclamationToken && property(node.expression.operand, 'res', 'ok')) {
      let checksServerError = false, removesReceipt = false;
      const inspect = (child: ts.Node) => {
        if (ts.isBinaryExpression(child) && property(child.left, 'res', 'status')
          && child.operatorToken.kind === ts.SyntaxKind.GreaterThanEqualsToken
          && ts.isNumericLiteral(child.right) && child.right.text === '500') checksServerError = true;
        if (ts.isCallExpression(child) && property(child.expression, 'sessionStorage', 'removeItem')) removesReceipt = true;
        ts.forEachChild(child, inspect);
      };
      inspect(node);
      if (checksServerError && removesReceipt) branches.push(node);
    }
    ts.forEachChild(node, findBranch);
  }
  findBranch(submit); assert.equal(branches.length, 1);
  return ts.transpileModule(`module.exports = async () => { ${branches[0].getText(file)} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
}

async function main() {
  let checks = 0;
  const fixtures = [
    { status: 'submission_unknown', expected: true },
    { local_status: 'submission_unknown', expected: true },
    { status: 'submitted', error_code: 'IP_SUBMISSION_UNCONFIRMED', expected: true },
    { status: 'submitted', submission_unconfirmed: true, expected: true },
    { status: 'retry_wait', expected: false },
    { status: 'retry_submitting', expected: false },
    { status: 'submitted', expected: false },
    { status: 'succeeded', expected: false },
    { status: 'failed', expected: false },
  ];
  for (const fixture of fixtures) {
    assert.equal(isVideoSubmissionUnconfirmed(fixture), fixture.expected); checks++;
  }
  for (const [status, label] of [['submission_unknown', '提交结果待确认'], ['retry_wait', '等待安全重试'], ['retry_submitting', '正在提交']]) {
    assert.equal(videoPendingStatusLabel(status), label);
    assert.equal(videoDeliveryStageForTask({ local_status: status }).stableDownloadReady, false); checks++;
  }
  assert.equal(videoPendingStatusLabel('succeeded'), null); checks++;

  for (const name of ['checkOriginalGenerationRequest', 'acceptRecoveredTask']) {
    const code = callback(name);
    for (const fixture of fixtures) {
      const key = 'original-request', storageKey = 'offline-request';
      const storage = new Map([[storageKey, JSON.stringify({ key })]]);
      const task = { id: 'original-task', ...fixture };
      const observed = { unconfirmed: false, result: null as unknown, accepted: [] as string[], requests: [] as string[], notice: '' };
      const scope = {};
      const context = {
        module: { exports: undefined as unknown }, URLSearchParams,
        currentUser: { id: 'offline-owner' }, generationOperation: { current: null },
        generationScope: { current: scope }, reuseMountedRef: { current: true },
        activeGenerationRequestStorageKey: storageKey, requestStorageKey: storageKey,
        studioRunId: null, isIpSurface: false, params: { prompt: 'retain-input' }, unconfirmedGenerationParamsRef: { current: null },
        sessionStorage: { getItem: (k: string) => storage.get(k), removeItem: (k: string) => storage.delete(k) },
        fetch: async (url: string, options: { method?: string }) => {
          assert.ok(!options.method || options.method === 'GET'); observed.requests.push(url);
          return { ok: true, body: { task } };
        },
        readJsonResponse: async (response: { body: unknown }) => response.body,
        isVideoSubmissionUnconfirmed, videoSubmissionUnknownMessage, isCurrent: () => true,
        creation: { acceptTask: async (request: string, id: string) => { observed.accepted.push(`${request}:${id}`); } },
        setSubmitting() {}, setError() {}, setErrorDebug() {}, setPolledResult() {}, setActivePollingTaskIds() {},
        setUnconfirmedGenerationRequest: (value: boolean) => { observed.unconfirmed = value; },
        setResult: (value: unknown) => { observed.result = value; },
        setGenerationNotice: (value: string) => { observed.notice = value; }, loadRecentTasksPage: async () => {},
      };
      vm.runInNewContext(code, context);
      const run = context.module.exports as (...args: unknown[]) => Promise<void>;
      await run(...(name === 'acceptRecoveredTask' ? [task, key] : []));
      assert.equal(observed.unconfirmed, fixture.expected);
      if (fixture.expected) assert.match(observed.notice, /费用仍待核对/);
      assert.equal(storage.has(storageKey), fixture.expected);
      assert.deepEqual(observed.accepted, [`${key}:original-task`]);
      assert.equal(observed.result === null, fixture.expected);
      assert.equal(observed.requests.length, name === 'checkOriginalGenerationRequest' ? 1 : 0);
      if (observed.requests.length) assert.ok(observed.requests[0].includes(`idempotency_key=${key}`));
      checks++;
    }
  }
  const responseCode = submitErrorResponseBranch();
  for (const fixture of [
    { status: 409, lookups: 0, retained: false, unconfirmed: false },
    { status: 503, lookups: 1, retained: true, unconfirmed: true },
  ]) {
    const key = 'original-key', storageKey = 'original-request-storage';
    const storage = new Map([[storageKey, JSON.stringify({ key })]]);
    const params = { prompt: 'retain-input', referenceVideoUrls: ['/fixture-video'], generationMode: 'all_in_one_reference' };
    const originalParams = structuredClone(params), pendingParams = { current: params as typeof params | null };
    const message = '参考视频当前不可用，尚未提交生成。';
    const observed = { lookups: 0, removed: 0, unconfirmed: true, accepted: 0 };
    const context = {
      module: { exports: undefined as unknown }, Error,
      res: new Response(JSON.stringify({ error: message }), { status: fixture.status }), data: { error: message },
      params, idempotencyKey: key, requestStorageKey: storageKey, unconfirmedGenerationParamsRef: pendingParams,
      sessionStorage: { removeItem: (name: string) => { observed.removed++; storage.delete(name); } },
      isCurrent: () => true, setErrorDebug() {}, notifyVideoPricingChanged() { throw new Error('Unexpected pricing change'); },
      recoverAcceptedRequest: async (requestKey: string) => { assert.equal(requestKey, key); observed.lookups++; return null; },
      acceptRecoveredTask: async () => { observed.accepted++; throw new Error('An empty lookup cannot accept a task'); },
      setUnconfirmedGenerationRequest: (value: boolean) => { observed.unconfirmed = value; },
    };
    vm.runInNewContext(responseCode, context);
    const run = context.module.exports as () => Promise<void>;
    await assert.rejects(() => run(), (error: unknown) => { assert.equal((error as Error).message, message); return true; });
    assert.equal(storage.has(storageKey), fixture.retained);
    assert.equal(observed.removed, fixture.retained ? 0 : 1);
    assert.equal(observed.unconfirmed, fixture.unconfirmed);
    assert.equal(observed.lookups, fixture.lookups);
    assert.equal(observed.accepted, 0);
    assert.equal(pendingParams.current, fixture.retained ? params : null);
    assert.deepEqual(params, originalParams);
    checks++;
  }
  const output = process.argv[2] ?? '.role-tests/video-submission-state-w2.json';
  assert.ok(output && path.resolve(output).startsWith(path.resolve('.role-tests') + path.sep));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify({ checks, passed: true, actualClientCallbacks: 2, actualSubmitErrorResponseBranch: true,
    submitErrorStatuses: [409, 503], networkCalls: 0, productionWrites: 0, providerCalls: 0 }, null, 2));
  console.log(JSON.stringify({ checks, passed: true, actualClientCallbacks: 2, actualSubmitErrorResponseBranch: true }));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
