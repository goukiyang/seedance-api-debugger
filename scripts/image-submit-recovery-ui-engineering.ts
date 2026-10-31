import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { isEncryptedStudioPersonalPrompt } from '../src/lib/image-studio/personal-prompt';
import { recoverStudioPersonalPrompt, UNKNOWN_PERSONAL_PROMPT_NOTICE } from '../src/app/image-studio/personal-prompt-recovery';
import { matchingStudioRequestReceipt, isStudioRequestEnded, studioRequestOutcomeMessage } from '../src/app/image-studio/submit-recovery';
import { readBatchResponse } from '../src/lib/image-studio/batch-receipt';

// Synthetic inputs only. Execute the production query/close declarations with
// in-memory storage and HTTP responses; never load a browser, database or provider.
const checks: string[] = [];
const requestId = 'synthetic-request-00000001';
const wrongRequest = 'synthetic-request-00000002';
const singleSource = readFileSync('src/app/image-studio/studio.tsx', 'utf8');
const batchSource = readFileSync('src/app/image-studio/use-studio-batch.tsx', 'utf8');
function declaration(text: string, ownerName: string, names: string[]) {
  const source = ts.createSourceFile('production.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const owner = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === ownerName) as ts.FunctionDeclaration | undefined;
  assert.ok(owner?.body, `Missing production owner ${ownerName}`);
  return names.map(name => {
    const node = owner.body!.statements.find(value => ts.isFunctionDeclaration(value) && value.name?.text === name);
    assert.ok(node, `Missing production function ${ownerName}:${name}`);
    return node.getText(source);
  }).join('\n');
}
function memory(initial: string) {
  const values = new Map([['synthetic-key', initial]]);
  return { getItem: (key: string) => values.get(key) ?? null, removeItem: (key: string) => values.delete(key) };
}
type Reply = { ok: boolean; value: unknown };
function queryHarness(batch: boolean, replies: Reply[], storageRequest = requestId) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const errors: string[] = [];
  const local = memory(batch ? storageRequest : JSON.stringify({ requestId: storageRequest }));
  const session = memory(JSON.stringify({ requestId: storageRequest }));
  const box: Record<string, any> = {
    pendingSubmission: { requestId }, pending: requestId, submitLock: { current: false }, moduleDeleteLock: { current: false },
    lock: { current: false }, taskReadScope: 'synthetic-scope', taskReadScopeRef: { current: 'synthetic-scope' },
    scopedKey: 'synthetic-scope', live: { current: { mounted: true, scope: 'synthetic-scope' } }, moduleId: 'synthetic-module',
    pendingKey: 'synthetic-key', localStorage: local, sessionStorage: session,
    isClientSessionBlocked: () => false, matchingStudioRequestReceipt, isStudioRequestEnded, studioRequestOutcomeMessage, readBatchResponse,
    encodeURIComponent, AbortSignal: { timeout: () => undefined },
    setError: (value: string) => errors.push(value), setPendingAccepted: (value: boolean) => { box.pendingAccepted = value; }, setBusy: () => {}, setSubmitting: () => {}, setQueryingSubmission: () => {},
    setBillingQuote: () => {}, lastDisplayedQuote: { current: null },
    setPendingSubmission: (value: any) => { box.pendingSubmission = typeof value === 'function' ? value(box.pendingSubmission) : value; },
    setPending: (value: any) => { box.pending = typeof value === 'function' ? value(box.pending) : value; },
    setId: (value: string) => { box.id = value; },
    showLatestResults: { current: (value: string) => { box.shown = value; } },
    onGenerationAccepted: () => { box.accepted = true; }, loadTasks: async () => {},
    readJsonResponse: async (response: { json: () => Promise<unknown> }) => response.json(),
    readResponse: async (response: { ok: boolean; json: () => Promise<unknown> }) => { const value = await response.json(); if (!response.ok) throw Error('Synthetic read failed'); return value; },
    fetch: async (url: string, init?: { method?: string; body?: string }) => {
      calls.push({ url, method: init?.method || 'GET', ...(init?.body ? { body: JSON.parse(init.body) } : {}) });
      const reply = replies.shift();
      assert.ok(reply, 'Unexpected extra HTTP call');
      return { ok: reply.ok, json: async () => reply.value };
    },
  };
  const functions = batch ? declaration(batchSource, 'useStudioBatch', ['releasePendingRequest', 'query'])
    : declaration(singleSource, 'ImageStudioBlock', ['releasePendingSubmission', 'querySubmission']);
  const js = ts.transpileModule(`${functions}\nglobalThis.execute = ${batch ? 'query' : 'querySubmission'};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(js, box);
  return { box, calls, errors, local, session, execute: box.execute as (close?: boolean) => Promise<void> };
}
const receipt = (state: string, id = requestId) => ({ schema: 'image.submit-receipt.v1', requestId: id, state, message: state === 'rejected' ? 'Synthetic explicit rejection' : undefined });
const batch = { id: 'a'.repeat(64), moduleId: 'synthetic-module', state: 'preparing', total: 4, generated: 0,
  failed: 0, uncertain: 0, active: 0, pending: 4, prepared: 0, budget: 20, committedCredits: 0, unitCredits: 5 };
function productionTerminalReceipt(state: 'rejected' | 'closed', code = 'IMAGE_SUBMIT_REJECTED') {
  const file = 'src/lib/image-studio/submit-receipts.server.ts';
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const node = source.statements.find(value => ts.isFunctionDeclaration(value) && value.name?.text === 'projectReceipt');
  assert.ok(node, 'Missing backend public receipt projection');
  const box: Record<string, any> = { IMAGE_SUBMIT_RECEIPT_SCHEMA: 'image.submit-receipt.v1' };
  const js = ts.transpileModule(`${node.getText(source)}\nglobalThis.project = projectReceipt;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(js, box);
  return box.project({ schema: 'image.submit-receipt.v1', account: 'synthetic-owner', requestId, state, code, stage: 'synthetic-pre-admission', createdAt: '2026-10-31T00:00:00Z' });
}
async function main() {
  const envelope = { format: 'private-prompt.v1', source: 'untrusted-cipher-metadata' };
  const cipher = 'ppenc:synthetic-cipher';
  for (const value of [cipher, JSON.stringify(envelope), envelope]) {
    assert.equal(isEncryptedStudioPersonalPrompt(value), true);
    const preserved = recoverStudioPersonalPrompt(value, 'synthetic-current-plain');
    assert.equal(preserved.prompt, 'synthetic-current-plain'); assert.equal(preserved.restored, false);
    assert.equal(preserved.notice, UNKNOWN_PERSONAL_PROMPT_NOTICE);
    const recovered = recoverStudioPersonalPrompt(value, 'synthetic-current-plain', { personalPromptState: 'recorded', personalPrompt: 'synthetic-source-personal' });
    assert.equal(recovered.prompt, 'synthetic-source-personal'); assert.equal(recovered.restored, true);
  }
  assert.equal(recoverStudioPersonalPrompt('synthetic-edited-plain', 'synthetic-current', { personalPromptState: 'recorded', personalPrompt: 'synthetic-source' }).prompt, 'synthetic-edited-plain');
  assert.equal(recoverStudioPersonalPrompt('', 'synthetic-current').prompt, '');
  assert.equal(recoverStudioPersonalPrompt(cipher, 'synthetic-current', { personalPromptState: 'unknown', personalPrompt: 'must-not-assume-source' }).prompt, 'synthetic-current');
  assert.equal(recoverStudioPersonalPrompt(cipher, 'synthetic-current', { personalPromptState: 'recorded', personalPrompt: cipher }).prompt, 'synthetic-current');
  assert.equal(recoverStudioPersonalPrompt(undefined, 'synthetic-current').prompt, 'synthetic-current');
  checks.push('plaintext/cipher/envelope/source-projection restoration preserves current personal input');

  for (const value of [{ submitted: false }, { requestId: wrongRequest, receipt: receipt('rejected') }, { requestId, receipt: receipt('rejected', wrongRequest) }, { requestId, state: 'failed' }]) {
    assert.equal(matchingStudioRequestReceipt(value, requestId), null);
  }
  const rejected = matchingStudioRequestReceipt({ requestId, receipt: receipt('rejected') }, requestId);
  assert.equal(isStudioRequestEnded(rejected), true);
  assert.equal(isStudioRequestEnded(matchingStudioRequestReceipt(receipt('unknown'), requestId)), false);
  assert.equal(isStudioRequestEnded(matchingStudioRequestReceipt(receipt('accepted'), requestId)), false);
  checks.push('only matching rejected/closed receipt ends a request; submitted:false or HTTP category cannot');

  const actualRejected = productionTerminalReceipt('rejected', 'PRIVATE_PROMPT_UNAVAILABLE');
  const actualClosed = productionTerminalReceipt('closed');
  assert.equal(matchingStudioRequestReceipt(actualRejected, requestId)?.schema, 'image.submit-receipt.v1');
  assert.equal(isStudioRequestEnded(matchingStudioRequestReceipt(actualClosed, requestId)), true);
  assert.match(studioRequestOutcomeMessage(matchingStudioRequestReceipt(actualRejected, requestId), 'fallback'), /私密设置/);
  assert.match(studioRequestOutcomeMessage(matchingStudioRequestReceipt({ ...actualRejected, code: 'PERSONAL_PROMPT_ENCRYPTED' }, requestId), 'fallback'), /旧加密内容/);
  assert.equal(studioRequestOutcomeMessage(matchingStudioRequestReceipt(actualRejected, requestId), 'fallback', 'Synthetic precise business reason'), 'Synthetic precise business reason');
  checks.push('actual backend public terminal projection matches client schema and preserves precise POST/query causes');
  for (const useBatch of [false, true]) {
    for (const state of ['rejected', 'closed']) {
      const fixture = queryHarness(useBatch, [{ ok: true, value: state === 'rejected' ? actualRejected : actualClosed }]);
      await fixture.execute(state === 'closed');
      assert.equal(useBatch ? fixture.box.pending : fixture.box.pendingSubmission, null);
      assert.equal(fixture.local.getItem('synthetic-key'), null);
      if (state === 'closed') {
        assert.equal(fixture.calls[0].method, 'POST');
        assert.equal(JSON.stringify(fixture.calls[0].body), JSON.stringify({ requestId, action: 'close' }));
      }
    }
    for (const reply of [receipt('unknown'), receipt('rejected', wrongRequest), { submitted: false, requestId }]) {
      const fixture = queryHarness(useBatch, [{ ok: true, value: reply }]);
      await fixture.execute();
      assert.ok(useBatch ? fixture.box.pending : fixture.box.pendingSubmission);
      assert.notEqual(fixture.local.getItem('synthetic-key'), null); assert.equal(fixture.calls.length, 1);
    }
    const unavailableRejected = queryHarness(useBatch, [{ ok: false, value: receipt('rejected') }]);
    await unavailableRejected.execute();
    assert.equal(useBatch ? unavailableRejected.box.pending : unavailableRejected.box.pendingSubmission, null, 'An explicit durable rejection also applies to a 503 response');
    const disabled = queryHarness(useBatch, [{ ok: false, value: { error: 'Synthetic close capability disabled', code: 'CLOSE_DISABLED' } }]);
    await disabled.execute(true);
    assert.ok(useBatch ? disabled.box.pending : disabled.box.pendingSubmission);
    assert.ok(disabled.errors.includes('Synthetic close capability disabled'));
    const other = queryHarness(useBatch, [{ ok: true, value: receipt('closed') }], wrongRequest);
    await other.execute(true);
    assert.notEqual(other.local.getItem('synthetic-key'), null, 'Never remove another stored request');
  }
  checks.push('production single/batch query and close keep unknown/mismatch/disabled pending and preserve other stored identities');

  const acceptedSingle = queryHarness(false, [{ ok: true, value: receipt('accepted') }, { ok: true, value: { tasks: [{ id: 'synthetic-task' }] } }]);
  await acceptedSingle.execute();
  assert.equal(acceptedSingle.box.pendingSubmission, null); assert.equal(acceptedSingle.box.shown, requestId); assert.equal(acceptedSingle.box.accepted, true);
  const delayedSingle = queryHarness(false, [{ ok: true, value: receipt('accepted') }, { ok: true, value: { tasks: [] } }]);
  await delayedSingle.execute(); assert.ok(delayedSingle.box.pendingSubmission);
  const acceptedParent = queryHarness(true, [{ ok: true, value: receipt('accepted') }, { ok: true, value: { batch } }]);
  await acceptedParent.execute(); assert.equal(acceptedParent.box.pending, null); assert.equal(acceptedParent.box.id, batch.id);
  assert.equal(batch.generated, 0); assert.equal(batch.prepared, 0);
  const delayedParent = queryHarness(true, [{ ok: true, value: receipt('accepted') }, { ok: false, value: { error: 'Synthetic parent temporarily unavailable' } }]);
  await delayedParent.execute(); assert.ok(delayedParent.box.pending);
  checks.push('accepted original task restores; accepted parent with zero dispatched children restores its original batch; delayed records stay pending');

  assert.equal(singleSource.includes("response.status >= 400 && response.status < 500"), false);
  assert.equal(batchSource.includes("response.status >= 400 && response.status < 500"), false);
  assert.equal(singleSource.includes('放弃核对'), false);
  assert.ok(singleSource.includes('核对并结束本次提交')); assert.ok(batchSource.includes('核对并结束本次提交'));
  assert.ok(singleSource.includes('confirmationRequired: true')); assert.ok(singleSource.includes('confirmingOriginalPrice ? String(pendingSubmission!.requestId)'));
  const restoreSource = declaration(singleSource, 'ImageStudioBlock', ['restoreTask', 'restoreTemporaryDraft', 'restoreDefaults']);
  assert.equal(restoreSource.includes("setPrompt(snapshot.prompt"), false);
  assert.ok(restoreSource.includes('recoverPersonalPromptInput'));
  const personalFallback = singleSource.match(/const personalSourceTaskId = ([^;]+);/)?.[1] || '';
  assert.ok(personalFallback.includes('saved.personalPromptSourceTaskId'));
  assert.ok(personalFallback.includes('saved.restoredSettings?.sourceTaskId'));
  assert.ok(personalFallback.includes('saved.reproduceSourceTaskId'));
  assert.equal(personalFallback.includes('taskSettings'), false);
  assert.equal(personalFallback.includes('saved.sourceTaskId'), false);
  const initialFallback = singleSource.match(/const initialSourceTaskId = ([^;]+);/)?.[1];
  assert.equal(initialFallback, 'module.reproduceFromTaskId');
  const persistedFallback = singleSource.match(/personalPromptSourceTaskId: ([^,\n]+),\n      resultView/)?.[1] || '';
  assert.ok(persistedFallback.includes('restoredTaskSettings?.sourceTaskId'));
  assert.equal(persistedFallback.includes('globalSettingsSourceTaskId'), false);
  checks.push('actual input entrances and single/batch submission wiring retain original request IDs and use safe personal restoration');
  console.log(JSON.stringify({ checks: checks.length, passed: checks, browser: false, generation: false, productionWrites: false }, null, 2));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
