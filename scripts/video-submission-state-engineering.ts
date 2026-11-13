import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { isVideoSubmissionUnconfirmed, videoPendingStatusLabel } from '../src/lib/video/submission-state';
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
    assert.ok(videoDeliveryStageForTask({ local_status: status }).label.includes(label === '提交结果待确认' ? '提交确认' : label)); checks++;
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
        isVideoSubmissionUnconfirmed, isCurrent: () => true,
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
      assert.equal(storage.has(storageKey), fixture.expected);
      assert.deepEqual(observed.accepted, [`${key}:original-task`]);
      assert.equal(observed.result === null, fixture.expected);
      assert.equal(observed.requests.length, name === 'checkOriginalGenerationRequest' ? 1 : 0);
      if (observed.requests.length) assert.ok(observed.requests[0].includes(`idempotency_key=${key}`));
      checks++;
    }
  }
  const output = process.argv[2];
  assert.ok(output && path.resolve(output).startsWith(path.resolve('.role-tests') + path.sep));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify({ checks, passed: true, actualClientCallbacks: 2, networkCalls: 0, productionWrites: 0, providerCalls: 0 }, null, 2));
  console.log(JSON.stringify({ checks, passed: true, actualClientCallbacks: 2 }));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
