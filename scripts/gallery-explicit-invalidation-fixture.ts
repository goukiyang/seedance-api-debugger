import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

type HookProps = { userId: string; query: Record<string, unknown>; enabled: boolean };
type EffectSlot = { kind: 'effect'; deps?: unknown[]; cleanup?: () => void; pending?: () => void | (() => void) };
type StateSlot = { kind: 'state'; value: unknown };
type RefSlot = { kind: 'ref'; value: { current: unknown } };
type CallbackSlot = { kind: 'callback'; value: (...args: unknown[]) => unknown; deps: unknown[] };
type HookSlot = EffectSlot | StateSlot | RefSlot | CallbackSlot;
type GalleryHook = (userId: string, query: Record<string, unknown>, enabled: boolean) => {
  data: ({ catalogRevision: string; fixtureLabel?: string } & Record<string, unknown>) | null;
  loading: boolean; error: string; denied: boolean;
  setPage(next: number, pageSize: number): void;
  refresh(options?: { invalidateRevision?: true }): void;
};

const sameDependencies = (left: unknown[] | undefined, right: unknown[]) => Boolean(left && left.length === right.length
  && left.every((value, index) => Object.is(value, right[index])));

class HookRunner {
  private slots: HookSlot[] = [];
  private cursor = 0;
  private renderPending = false;
  result!: ReturnType<GalleryHook>;

  constructor(private hook: GalleryHook, private props: HookProps) {}

  useState = (initial: unknown) => {
    const index = this.cursor++;
    if (!this.slots[index]) this.slots[index] = { kind: 'state', value: typeof initial === 'function' ? (initial as () => unknown)() : initial };
    const slot = this.slots[index] as StateSlot;
    return [slot.value, (next: unknown) => {
      const value = typeof next === 'function' ? (next as (previous: unknown) => unknown)(slot.value) : next;
      if (!Object.is(value, slot.value)) { slot.value = value; this.renderPending = true; }
    }];
  };

  useRef = (initial: unknown) => {
    const index = this.cursor++;
    if (!this.slots[index]) this.slots[index] = { kind: 'ref', value: { current: initial } };
    return (this.slots[index] as RefSlot).value;
  };

  useCallback = (callback: (...args: unknown[]) => unknown, dependencies: unknown[]) => {
    const index = this.cursor++, existing = this.slots[index] as CallbackSlot | undefined;
    if (!existing || !sameDependencies(existing.deps, dependencies)) this.slots[index] = { kind: 'callback', value: callback, deps: dependencies };
    return (this.slots[index] as CallbackSlot).value;
  };

  useEffect = (effect: () => void | (() => void), dependencies: unknown[]) => {
    const index = this.cursor++, existing = this.slots[index] as EffectSlot | undefined;
    if (!existing) this.slots[index] = { kind: 'effect', deps: dependencies, pending: effect };
    else if (!sameDependencies(existing.deps, dependencies)) { existing.deps = dependencies; existing.pending = effect; }
  };

  setProps(next: HookProps) { this.props = next; this.renderPending = true; }

  stateValue<T>(stateIndex: number) {
    const states = this.slots.filter((slot): slot is StateSlot => slot.kind === 'state');
    return states[stateIndex].value as T;
  }

  async flush() {
    for (let round = 0; round < 30; round++) {
      await Promise.resolve();
      if (!this.renderPending) continue;
      this.renderPending = false; this.cursor = 0;
      this.result = this.hook(this.props.userId, this.props.query, this.props.enabled);
      for (const slot of this.slots) {
        if (slot.kind !== 'effect' || !slot.pending) continue;
        slot.cleanup?.(); const pending = slot.pending; slot.pending = undefined;
        slot.cleanup = pending() || undefined;
      }
    }
    assert.equal(this.renderPending, false, 'Fixture hook did not settle');
  }

  async mount() { this.renderPending = true; await this.flush(); }
}

type PendingRequest = {
  body: Record<string, unknown>; signal: AbortSignal;
  respond(status: number, payload: Record<string, unknown>): void;
  reject(error: Error): void;
};

const pendingRequests: PendingRequest[] = [];
const fetchFixture = (_input: string, init: { body: string; signal: AbortSignal }) => new Promise<object>((resolve, reject) => {
  pendingRequests.push({
    body: JSON.parse(init.body) as Record<string, unknown>, signal: init.signal,
    respond(status, payload) { resolve({ status, ok: status >= 200 && status < 300, json: async () => payload }); },
    reject,
  });
});

const galleryResult = (catalogRevision: string, fixtureLabel: string) => ({
  protocol: 'catalog-paged-v2', catalogRevision, fixtureLabel,
  capabilities: { independentReactions: true }, items: [], navigation: [], matches: [],
});

const hookSource = ts.createSourceFile('useGalleryCatalog.ts', readFileSync('src/app/image-studio/useGalleryCatalog.ts', 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const executableHook = hookSource.statements.filter(statement => !ts.isImportDeclaration(statement)
  && !(ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression))).map(statement => statement.getText(hookSource)).join('\n');
const compiledHook = ts.transpileModule(executableHook, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
} }).outputText;

let runner: HookRunner;
const browserListeners = new Map<string, Set<() => void>>();
const addListener = (name: string, listener: () => void) => {
  const listeners = browserListeners.get(name) || new Set<() => void>(); listeners.add(listener); browserListeners.set(name, listeners);
};
const removeListener = (name: string, listener: () => void) => browserListeners.get(name)?.delete(listener);
const sandbox = {
  exports: {} as { useGalleryCatalog?: GalleryHook }, AbortController,
  useState: (initial: unknown) => runner.useState(initial),
  useRef: (initial: unknown) => runner.useRef(initial),
  useCallback: (callback: (...args: unknown[]) => unknown, dependencies: unknown[]) => runner.useCallback(callback, dependencies),
  useEffect: (effect: () => void | (() => void), dependencies: unknown[]) => runner.useEffect(effect, dependencies),
  watchReactionChanges: () => () => undefined, useAppSession: () => ({ sessionChanged: false }), isClientSessionBlocked: () => false,
  fetch: fetchFixture,
  window: { addEventListener: addListener, removeEventListener: removeListener },
  document: { hidden: false, addEventListener: addListener, removeEventListener: removeListener },
};
vm.runInNewContext(compiledHook, sandbox, { filename: 'useGalleryCatalog.fixture.js', timeout: 1000 });
const useGalleryCatalog = sandbox.exports.useGalleryCatalog;
assert.equal(typeof useGalleryCatalog, 'function', 'Fixture must execute the production hook');

async function main() {
  let requestCursor = 0;
  const nextRequest = () => {
    const request = pendingRequests[requestCursor++];
    assert.ok(request, `Expected gallery request ${requestCursor}`);
    return request;
  };
  const respond = async (request: PendingRequest, status: number, payload: Record<string, unknown>) => {
    request.respond(status, payload); await runner.flush();
  };
  const settlePromises = async () => { for (let turn = 0; turn < 5; turn++) await Promise.resolve(); };

  runner = new HookRunner(useGalleryCatalog!, { userId: 'viewer-a', query: { query: '', scope: 'all' }, enabled: true });
  await runner.mount();
  const initial = nextRequest();
  assert.equal(initial.body.catalogRevision, undefined);
  await respond(initial, 200, galleryResult('revision-1', 'initial'));
  assert.equal(runner.result.data?.catalogRevision, 'revision-1');

  runner.result.refresh(); await runner.flush();
  const ordinaryRefresh = nextRequest();
  assert.equal(ordinaryRefresh.body.catalogRevision, 'revision-1', 'Ordinary refresh keeps the last successful revision');
  await respond(ordinaryRefresh, 200, galleryResult('revision-1', 'ordinary-refresh'));

  runner.result.setPage(2, 12); await runner.flush();
  const stalePage = nextRequest();
  assert.equal(stalePage.body.catalogRevision, 'revision-1', 'Ordinary pagination keeps revision protection');
  await respond(stalePage, 409, { error: 'catalog changed' });
  const pageRetry = nextRequest();
  assert.equal(pageRetry.body.catalogRevision, undefined, 'A 409 retry omits the stale revision');
  await respond(pageRetry, 200, galleryResult('revision-2', 'page-retry'));
  assert.equal(pendingRequests.length, requestCursor, 'A 409 causes exactly one retry');

  runner.result.refresh({ invalidateRevision: true }); await runner.flush();
  const explicitInvalidation = nextRequest();
  assert.equal(explicitInvalidation.body.catalogRevision, undefined, 'Explicit invalidation does not ask with a known-stale revision');
  await respond(explicitInvalidation, 200, galleryResult('revision-3', 'explicit-invalidation'));
  runner.result.setPage(3, 12); await runner.flush();
  const afterInvalidation = nextRequest();
  assert.equal(afterInvalidation.body.catalogRevision, 'revision-3', 'A successful invalidation read restores normal revision use');
  await respond(afterInvalidation, 200, galleryResult('revision-3', 'after-invalidation'));

  runner.result.refresh({ invalidateRevision: true });
  runner.setProps({ userId: 'viewer-a', query: { query: 'new-scope', scope: 'all' }, enabled: true });
  await runner.flush();
  const otherScope = nextRequest();
  assert.equal(otherScope.body.catalogRevision, undefined);
  await respond(otherScope, 200, galleryResult('revision-other', 'other-scope'));
  runner.setProps({ userId: 'viewer-a', query: { query: '', scope: 'all' }, enabled: true }); await runner.flush();
  const invalidatedScopeReturn = nextRequest();
  assert.equal(invalidatedScopeReturn.body.catalogRevision, undefined, 'Another scope cannot consume the pending explicit invalidation');
  await respond(invalidatedScopeReturn, 200, galleryResult('revision-4', 'invalidated-scope-return'));

  runner.result.refresh(); await runner.flush();
  const rejectedBeforeCleanup = nextRequest();
  runner.result.refresh({ invalidateRevision: true });
  rejectedBeforeCleanup.reject(new Error('obsolete request failed before cleanup'));
  await settlePromises();
  assert.equal(runner.stateValue<{ error: string }>(2).error, '', 'A pre-cleanup rejection from the old epoch cannot publish an obsolete error');
  await runner.flush();
  const afterPreCleanupRejection = nextRequest();
  assert.equal(afterPreCleanupRejection.body.catalogRevision, undefined);
  await respond(afterPreCleanupRejection, 200, galleryResult('revision-4b', 'after-pre-cleanup-rejection'));

  runner.result.refresh(); await runner.flush();
  const sameScopeOld = nextRequest();
  assert.equal(sameScopeOld.body.catalogRevision, 'revision-4b');
  runner.result.refresh({ invalidateRevision: true }); await runner.flush();
  const sameScopeFresh = nextRequest();
  assert.equal(sameScopeOld.signal.aborted, true);
  assert.equal(sameScopeFresh.body.catalogRevision, undefined);
  await respond(sameScopeFresh, 200, galleryResult('revision-5', 'same-scope-fresh'));
  await respond(sameScopeOld, 200, galleryResult('revision-old', 'same-scope-late'));
  assert.equal(runner.result.data?.catalogRevision, 'revision-5', 'A late same-scope response cannot restore the old catalog');

  runner.result.refresh(); await runner.flush();
  const oldAccount = nextRequest();
  runner.setProps({ userId: 'viewer-b', query: { query: '', scope: 'all' }, enabled: true }); await runner.flush();
  const newAccount = nextRequest();
  assert.equal(newAccount.body.catalogRevision, undefined, 'A new account cannot send the prior account revision');
  await respond(newAccount, 200, galleryResult('revision-b', 'new-account'));
  await respond(oldAccount, 200, galleryResult('revision-a-late', 'old-account-late'));
  assert.equal(runner.result.data?.catalogRevision, 'revision-b', 'A late prior-account response cannot replace current data');

  runner.result.refresh(); await runner.flush();
  const denied = nextRequest();
  assert.equal(denied.body.catalogRevision, 'revision-b');
  await respond(denied, 403, { error: 'forbidden' });
  assert.equal(runner.result.denied, true);
  assert.equal(runner.result.data, null, 'Permission denial clears previously visible gallery data');

  const studioSource = readFileSync('src/app/image-studio/studio.tsx', 'utf8');
  assert.match(studioSource, /pool\.refresh\(previous\.revision !== shared\.catalogRevision \? \{ invalidateRevision: true \} : undefined\)/,
    'The shared catalog revision effect must use the explicit invalidation API');
  assert.match(studioSource, /if \(!coverView \|\| previous\.owner !== userId\) return;/,
    'Shared invalidation must stay account-scoped and cover-view scoped');
  const openShared = studioSource.slice(studioSource.indexOf('async function openSharedPreset'), studioSource.indexOf('function navigateToEntry'));
  assert.ok(openShared.includes('pool.refresh();') && openShared.includes('shared.refresh();'), 'Open-shared keeps both existing refreshes');

  console.log(JSON.stringify({ fixture: 'gallery-explicit-invalidation-fixture', assertions: 27, requests: pendingRequests.length, status: 'passed' }));
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
