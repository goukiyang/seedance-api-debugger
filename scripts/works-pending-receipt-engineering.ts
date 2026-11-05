import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { pendingWorkOperations, queryWorkOperation } from '../src/lib/works/client';

// Run the actual reconciliation callback and effect against isolated browser event surfaces.
async function main() {
  const source = readFileSync(new URL('../src/components/works/WorksWorkspace.tsx', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('WorksWorkspace.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let reconcileSource = '', recoverySource = '';
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'reconcile'
      && node.initializer && ts.isCallExpression(node.initializer)
      && node.initializer.expression.getText(tree) === 'useCallback') {
      reconcileSource = node.initializer.arguments[0].getText(tree);
    }
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 'useEffect'
      && node.arguments[0]?.getText(tree).includes('const checkPending = async')) {
      recoverySource = node.arguments[0].getText(tree);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(reconcileSource, 'Manual and automatic receipt checks must share the existing reconciler');
  assert.ok(recoverySource, 'Restored pending operations must be checked automatically');
  assert.doesNotMatch(recoverySource, /worksMutate|setInterval|setTimeout|randomUUID/);

  const actor = 'fixture-viewer', otherActor = 'other-viewer';
  const original = { requestId: '00000000-0000-4000-8000-000000000001', key: 'method:fixture-work' };
  const storageKey = (id: string) => `sd2:works:operations:v1:${id}`;
  const memory = new Map<string, string>();
  const storage = { getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => { memory.set(key, value); } };
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const originalFetch = globalThis.fetch;
  const windowSurface = new EventTarget();
  const documentSurface = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const alive = { current: true }, locks = { current: new Set<string>() };
  const calls: Array<{ url: string; method: string }> = [];
  const applied: unknown[] = [];
  let notice = '', busy: string[] = [], pending = [original], stateUpdates = 0;
  let mode: 'committed' | 'unknown' | 'unavailable' | 'wrong-actor' = 'committed';
  let gate: Promise<void> | null = null;
  let release: (() => void) | undefined;
  const settle = async () => { for (let i = 0; i < 6; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
  const seed = () => { memory.set(storageKey(actor), JSON.stringify([original])); };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  globalThis.fetch = async (input, init) => {
    const url = String(input), method = init?.method || 'GET';
    calls.push({ url, method });
    assert.equal(method, 'GET', 'Reconciliation must never submit or generate');
    assert.equal(new Headers(init?.headers).get('x-app-session-user'), actor);
    assert.equal(url, `/api/works/operations/${original.requestId}`);
    if (gate) await gate;
    const body = mode === 'unavailable' ? { error: 'temporarily unavailable' }
      : { viewerId: mode === 'wrong-actor' ? otherActor : actor, operation: {
        requestId: original.requestId, state: mode === 'committed' ? 'committed' : 'unknown',
        result: mode === 'committed' ? { kind: 'image-template', workId: 'fixture-work', href: '/template-studio?moduleId=fixture' } : null,
      } };
    return new Response(JSON.stringify(body), { status: mode === 'unavailable' ? 503 : 200 });
  };
  const sandbox = {
    ready: true, viewerId: actor, window: windowSurface, document: documentSurface, Error,
    alive, operationLocks: locks, queryWorkOperation, pendingWorkOperations,
    setBusy: (update: (before: string[]) => string[]) => { busy = update(busy); },
    setNotice: (value: string) => { notice = value; },
    setPending: (value: typeof pending) => { pending = value; stateUpdates++; },
    applyResult: async (result: unknown) => { applied.push(result); },
  };
  const compile = (expression: string) => ts.transpileModule(`(${expression})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const reconcile = vm.runInNewContext(compile(reconcileSource), sandbox);
  const start = vm.runInNewContext(compile(recoverySource), { ...sandbox, reconcile });
  let stop: (() => void) | undefined;
  try {
    memory.set(storageKey(otherActor), JSON.stringify([original])); seed();
    stop = start(); await settle();
    assert.deepEqual(pendingWorkOperations(actor), [], 'A committed restored operation is removed on mount');
    assert.equal(pending.length, 0); assert.equal(applied.length, 1);
    assert.equal(pendingWorkOperations(otherActor).length, 1, 'Other account storage stays intact');
    assert.match(notice, /已确认保存/);
    const afterCommitted = calls.length;
    windowSurface.dispatchEvent(new Event('focus')); await settle();
    assert.equal(calls.length, afterCommitted, 'Cleared receipts are not queried again');

    seed(); mode = 'unknown'; notice = 'existing notice';
    windowSurface.dispatchEvent(new Event('focus')); await settle();
    assert.equal(pendingWorkOperations(actor).length, 1);
    assert.equal(notice, 'existing notice', 'Unknown background checks do not replace existing notices');

    mode = 'unavailable'; documentSurface.dispatchEvent(new Event('visibilitychange')); await settle();
    assert.equal(pendingWorkOperations(actor).length, 1, 'Read failures preserve the original request');
    mode = 'wrong-actor'; windowSurface.dispatchEvent(new Event('focus')); await settle();
    assert.equal(pendingWorkOperations(actor).length, 1, 'Mismatched account responses never confirm a receipt');

    mode = 'unknown'; gate = new Promise<void>(resolve => { release = resolve; });
    const beforeOverlap = calls.length;
    windowSurface.dispatchEvent(new Event('focus'));
    documentSurface.dispatchEvent(new Event('visibilitychange')); await settle();
    assert.equal(calls.length, beforeOverlap + 1, 'Overlapping return events share one bounded check');
    release!(); await settle(); gate = null;

    documentSurface.visibilityState = 'hidden';
    const beforeHidden = calls.length;
    documentSurface.dispatchEvent(new Event('visibilitychange')); await settle();
    assert.equal(calls.length, beforeHidden, 'Hiding the workspace does not check receipts');
    documentSurface.visibilityState = 'visible';
    mode = 'committed'; gate = new Promise<void>(resolve => { release = resolve; });
    windowSurface.dispatchEvent(new Event('focus')); await settle();
    const beforeUnmount = stateUpdates, appliedBeforeUnmount = applied.length;
    alive.current = false; stop!(); stop = undefined; release!(); await settle(); gate = null;
    assert.equal(stateUpdates, beforeUnmount); assert.equal(applied.length, appliedBeforeUnmount);
    const afterUnmount = calls.length;
    windowSurface.dispatchEvent(new Event('focus')); await settle();
    assert.equal(calls.length, afterUnmount, 'Unmount removes the return listeners');
    assert.equal(pendingWorkOperations(otherActor).length, 1);
    assert.equal(busy.length, 1, 'Unmounted component does not receive a cleanup state write');
    console.log(JSON.stringify({ checks: 8, getOnly: true, automaticMountAndReturn: true,
      confirmedRemoved: true, unknownPreserved: true, accountIsolated: true, overlappingChecksDeduplicated: true,
      unmountIsolated: true, browserRuns: 0, productionWrites: 0, paidRequests: 0 }));
  } finally {
    stop?.(); release?.(); globalThis.fetch = originalFetch;
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
