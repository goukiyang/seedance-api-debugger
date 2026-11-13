import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { observePendingVideoSubmission, markVideoSubmission } from '../src/components/generate/video-submission-progress';
import { videoPendingStatusLabel } from '../src/components/generate/video-submission-state';

async function main() {
  let checks = 0;
  const source = fs.readFileSync('src/components/generate/GeneratePageClient.tsx', 'utf8');
  const file = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let probe: ts.Expression | undefined;
  let lookup: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'observePendingVideoSubmission') {
      assert.equal(probe, undefined); probe = node.arguments[0];
    }
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'recoverAcceptedRequest') lookup = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(file); assert.ok(probe); assert.ok(lookup);
  const code = ts.transpileModule(`const recoverAcceptedRequest = ${lookup.getText(file)}; module.exports = ${probe.getText(file)}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  for (const kind of ['ordinary', 'ip', 'template', 'missing', 'error', 'aborted', 'changed']) {
    const controller = new AbortController(); if (kind === 'aborted') controller.abort();
    const reads: string[] = [], accepted: string[] = [], progress: unknown[] = [];
    const task = { id: 'local-task', status: 'retry_submitting' };
    const context = { module: { exports: undefined as unknown }, URLSearchParams,
      isCurrent: () => kind !== 'changed', tracedRequestId: 'original-request', idempotencyKey: 'original-request',
      params: { templateStudioRunId: kind === 'template' ? 'original-run' : null }, isIpSurface: kind === 'ip', currentUser: { id: 'owner' },
      captured: { key: 'original-scope' }, MAX_ACTIVE_POLLING_TASKS: 4, markVideoSubmission, videoPendingStatusLabel,
      fetch: async (url: string, options: { method?: string; signal: AbortSignal }) => {
        assert.ok(!options.method || options.method === 'GET'); assert.equal(options.signal, controller.signal); reads.push(url);
        return { ok: kind !== 'error', data: { task: kind === 'missing' ? null : task } };
      },
      readJsonResponse: async (r: { data: unknown }) => r.data,
      creation: { acceptTask: async (key: string, id: string) => { accepted.push(`${key}:${id}`); } },
      setSubmissionProgress: (value: unknown) => { progress.push(value); }, setGenerationNotice() {}, setActivePollingTaskIds() {}, loadRecentTasksPage: async () => {},
    };
    vm.runInNewContext(code, context);
    const run = context.module.exports as (signal: AbortSignal) => Promise<void>;
    if (kind === 'error') await assert.rejects(() => run(controller.signal));
    else await run(controller.signal);
    assert.equal(reads.length, ['aborted', 'changed'].includes(kind) ? 0 : 1);
    if (reads.length) {
      const url = new URL(reads[0], 'https://offline.invalid'); assert.equal(url.searchParams.get('idempotency_key'), 'original-request');
      assert.equal(url.pathname, kind === 'ip' ? '/api/ip/tasks/request-status' : kind === 'template' ? '/api/template-studio-video-handoff' : '/api/tasks/request-status');
    }
    const found = ['ordinary', 'ip', 'template'].includes(kind);
    assert.equal(accepted.length, found ? 1 : 0); assert.equal(progress.length, found ? 1 : 0);
    if (found) { assert.equal(accepted[0], 'original-request:local-task'); assert.equal(JSON.stringify(progress[0]), JSON.stringify({ scopeKey: 'original-scope', taskId: 'local-task' })); }
    checks++;
  }

  const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  const scheduled: Array<{ callback: () => void; delay: number; cleared: boolean }> = [];
  try {
    globalThis.setTimeout = ((callback: () => void, delay: number) => {
      scheduled.push({ callback, delay, cleared: false }); return scheduled.length as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => { scheduled[Number(id) - 1].cleared = true; }) as typeof clearTimeout;
    let probes = 0, observedSignal: AbortSignal | undefined;
    const post = new AbortController();
    const stopEarly = observePendingVideoSubmission(async () => { probes++; });
    assert.equal(scheduled[0].delay, 10000); stopEarly(); assert.equal(scheduled[0].cleared, true); assert.equal(probes, 0); checks++;
    const stop = observePendingVideoSubmission(async signal => { probes++; observedSignal = signal; });
    scheduled[1].callback(); await Promise.resolve(); assert.equal(probes, 1); stop();
    assert.equal(observedSignal?.aborted, true); assert.equal(post.signal.aborted, false); checks++;
  } finally { globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear; }

  markVideoSubmission('diagnostic-request', 'response_decoded');
  const mark = performance.getEntriesByName('sd2:video-submit:response_decoded').at(-1) as PerformanceMark;
  assert.deepEqual(Object.keys(mark.detail).sort(), ['phase', 'requestId', 'version']);
  assert.equal(mark.detail.requestId, 'diagnostic-request'); checks++;

  require.extensions['.css'] = module => { module.exports = {}; };
  Object.assign(globalThis, { React });
  const CreationAvailability = (await import('../src/components/creation/CreationAvailability')).default;
  for (const submitting of [false, true]) {
    const controller = { intent: { id: 'intent', state: 'ready', spec: {}, availability: { reasons: [] } }, context: null,
      loading: false, error: '', unconfirmedRequestId: null, contextKey: 'scope' };
    const html = renderToStaticMarkup(React.createElement(CreationAvailability, { controller: controller as unknown as React.ComponentProps<typeof CreationAvailability>['controller'], submitting }));
    const button = html.match(/<button[^>]*>核对并结束本次准备<\/button>/)?.[0]; assert.ok(button);
    assert.equal(button.includes('disabled'), submitting); checks++;
  }
  console.log(JSON.stringify({ passed: true, checks, actualProbeCallback: true, actualPreparationComponentRendered: true,
    productionWrites: 0, providerCalls: 0, browserGeneration: false }));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
