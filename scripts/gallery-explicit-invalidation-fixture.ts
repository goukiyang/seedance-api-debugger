import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

type SharedRevision = { revision: string; active: boolean };
type HookProps = { userId: string; query: Record<string, unknown>; enabled: boolean; shared?: SharedRevision };
type EffectSlot = { kind: 'effect'; deps?: unknown[]; cleanup?: () => void; pending?: () => void | (() => void) };
type StateSlot = { kind: 'state'; value: unknown };
type RefSlot = { kind: 'ref'; value: { current: unknown } };
type CallbackSlot = { kind: 'callback'; value: (...args: unknown[]) => unknown; deps: unknown[] };
type HookSlot = EffectSlot | StateSlot | RefSlot | CallbackSlot;
type GalleryHook = (userId: string, query: Record<string, unknown>, enabled: boolean, shared?: SharedRevision) => {
  data: ({ catalogRevision: string; fixtureLabel?: string } & Record<string, unknown>) | null;
  loading: boolean; error: string; denied: boolean; matchingScope: boolean;
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
      this.result = this.hook(this.props.userId, this.props.query, this.props.enabled, this.props.shared);
      for (const slot of this.slots) {
        if (slot.kind !== 'effect' || !slot.pending) continue;
        slot.cleanup?.(); const pending = slot.pending; slot.pending = undefined;
        slot.cleanup = pending() || undefined;
      }
    }
    assert.equal(this.renderPending, false, 'Fixture hook did not settle');
  }

  async mount() { this.renderPending = true; await this.flush(); }
  unmount() { for (const slot of this.slots) if (slot.kind === 'effect') slot.cleanup?.(); }
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

const galleryResult = (catalogRevision: string, fixtureLabel: string, directoryRevision?: string) => ({
  protocol: 'catalog-paged-v2', catalogRevision, fixtureLabel, ...(directoryRevision ? { directoryRevision } : {}),
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
const browserListeners = new Map<string, Set<(event: { type: string }) => void>>();
const addListener = (name: string, listener: (event: { type: string }) => void) => {
  const listeners = browserListeners.get(name) || new Set<(event: { type: string }) => void>(); listeners.add(listener); browserListeners.set(name, listeners);
};
const removeListener = (name: string, listener: (event: { type: string }) => void) => browserListeners.get(name)?.delete(listener);
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
  assert.match(executableHook, /refresh\(previous\.revision !== sharedRevision \? \{ invalidateRevision: true \} : undefined\)/,
    'The shared catalog revision effect must use the explicit invalidation API');
  assert.match(executableHook, /if \(!sharedActive \|\| sessionChanged \|\| isClientSessionBlocked\(\)\)/,
    'Shared invalidation must stay account-scoped and cover-view scoped');
  const openShared = studioSource.slice(studioSource.indexOf('async function openSharedPreset'), studioSource.indexOf('function navigateToEntry'));
  assert.ok(openShared.includes('pool.refresh();') && openShared.includes('shared.refresh();'), 'Open-shared keeps both existing refreshes');

  let additionalAssertions = 0;
  const equal = (actual: unknown, expected: unknown, message?: string) => { assert.equal(actual, expected, message); additionalAssertions++; };
  const dataSnapshot = (): ReturnType<GalleryHook>['data'] => runner.result.data;
  let props!: HookProps;
  const start = async (revision = '') => {
    runner.unmount();
    props = { userId: 'seed-viewer', query: { query: '', scope: 'all', navigationOnly: false }, enabled: true,
      shared: { revision, active: true } };
    runner = new HookRunner(useGalleryCatalog!, props); await runner.mount(); return nextRequest();
  };
  const seed = async (revision: string) => {
    props = { ...props, shared: { revision, active: true } }; runner.setProps(props); await runner.flush();
  };
  const noExtraRead = () => equal(pendingRequests.length, requestCursor, 'The initial marker confirmation cannot cause another read');

  const same = await start(); await seed('marker-1');
  equal(same.signal.aborted, false, 'First shared marker must not cancel the in-flight unversioned read'); noExtraRead();
  await respond(same, 200, galleryResult('query-hash-differs-from-marker', 'same-marker', 'marker-1'));
  equal(dataSnapshot()?.fixtureLabel, 'same-marker'); noExtraRead();
  const preseeded = await start('marker-1');
  await respond(preseeded, 200, galleryResult('preseeded-hash', 'preseeded', 'marker-1')); noExtraRead();

  for (const kind of ['different', 'missing', 'fallback'] as const) {
    const first = await start(); await seed('marker-1'); equal(first.signal.aborted, false);
    const result = galleryResult('first-query-hash', kind, kind === 'missing' ? undefined : 'marker-old');
    await respond(first, 200, kind === 'fallback' ? { ...result, protocol: undefined } : result);
    const fresh = nextRequest(); equal(fresh.body.catalogRevision, undefined);
    equal(runner.result.data, null, 'A known-unconfirmed initial result is not published before the fresh read');
    await respond(fresh, 200, galleryResult('fresh-query-hash', 'fresh-'+kind, 'marker-later'));
    equal(dataSnapshot()?.fixtureLabel, 'fresh-'+kind); noExtraRead();
  }

  const pendingInitial = await start(); await seed('marker-1'); await seed('marker-2');
  const changedBeforeSuccess = nextRequest(); equal(pendingInitial.signal.aborted, true);
  equal(changedBeforeSuccess.body.catalogRevision, undefined);
  await respond(changedBeforeSuccess, 200, galleryResult('changed-hash', 'real-change', 'marker-2'));
  await respond(pendingInitial, 200, galleryResult('late-hash', 'late-initial', 'marker-old'));
  equal(dataSnapshot()?.fixtureLabel, 'real-change'); noExtraRead();

  const successful = await start(); await respond(successful, 200, galleryResult('success-hash', 'before-seed'));
  runner.result.refresh(); await runner.flush(); const alreadyRunning = nextRequest();
  await seed('marker-1'); const seededAfterSuccess = nextRequest();
  equal(alreadyRunning.signal.aborted, true); equal(seededAfterSuccess.body.catalogRevision, undefined);
  await respond(seededAfterSuccess, 200, galleryResult('seeded-hash', 'after-seed', 'marker-1'));
  await respond(alreadyRunning, 200, galleryResult('late-existing-hash', 'late-existing'));
  equal(dataSnapshot()?.fixtureLabel, 'after-seed');

  for (const invalidateRevision of [false, true]) {
    const old = await start(); await seed('marker-1');
    runner.result.refresh(invalidateRevision ? { invalidateRevision: true } : undefined); await runner.flush();
    const explicit = nextRequest(); equal(old.signal.aborted, true);
    await respond(explicit, 200, galleryResult('explicit-hash', 'explicit'));
    await respond(old, 200, galleryResult('late-explicit', 'late-explicit', 'marker-old'));
    equal(dataSnapshot()?.fixtureLabel, 'explicit'); noExtraRead();
  }

  for (const change of ['scope', 'account'] as const) {
    const old = await start(); await seed('marker-1');
    props = change === 'scope' ? { ...props, query: { ...props.query, query: 'different-query' } }
      : { ...props, userId: 'next-viewer', shared: { revision: '', active: true } };
    runner.setProps(props); await runner.flush(); const current = nextRequest();
    equal(old.signal.aborted, true); equal(current.body.catalogRevision, undefined);
    await respond(current, 200, galleryResult('new-'+change, 'new-'+change));
    await respond(old, 200, galleryResult('late-'+change, 'late-'+change, 'marker-old'));
    equal(dataSnapshot()?.fixtureLabel, 'new-'+change); noExtraRead();
  }

  for (const status of [403, 200]) {
    const request = await start(); await seed('marker-1');
    await respond(request, status, status === 403 ? { error: 'forbidden' } : { code: 'account-changed', error: 'changed' });
    equal(runner.result.denied, true); equal(runner.result.data, null);
    props = { ...props, enabled: false }; runner.setProps(props); await runner.flush();
    props = { ...props, enabled: true }; runner.setProps(props); await runner.flush();
    const authorizedLater = nextRequest();
    await respond(authorizedLater, 200, galleryResult('authorized-later', 'authorized-later'));
    equal(dataSnapshot()?.fixtureLabel, 'authorized-later'); noExtraRead();
  }

  const coverInitial = await start(); await seed('marker-1');
  props = { ...props, query: { ...props.query, navigationOnly: true }, shared: { revision: 'marker-1', active: false } };
  runner.setProps(props); await runner.flush(); const workspace = nextRequest(); equal(coverInitial.signal.aborted, true);
  await respond(workspace, 200, galleryResult('workspace-hash', 'workspace'));
  props = { ...props, shared: { revision: 'marker-2', active: false } }; runner.setProps(props); await runner.flush(); noExtraRead();
  props = { ...props, query: { ...props.query, navigationOnly: false }, shared: { revision: 'marker-2', active: true } };
  runner.setProps(props); await runner.flush(); const returnedCover = nextRequest();
  equal(returnedCover.signal.aborted, false); noExtraRead();
  await respond(returnedCover, 200, galleryResult('return-hash', 'return-cover', 'marker-2'));
  await respond(coverInitial, 200, galleryResult('late-cover-hash', 'late-cover', 'marker-old'));
  equal(dataSnapshot()?.fixtureLabel, 'return-cover'); noExtraRead();

  // Run the actual studio initial-load effect, without rendering the rest of the workbench.
  const studioAst = ts.createSourceFile('studio.tsx', studioSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let initialEffect: ts.Expression | undefined;
  const findInitial = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(studioAst) === 'useEffect'
      && node.arguments[0]?.getText(studioAst).includes('initialModulesView.current')) initialEffect = node.arguments[0];
    ts.forEachChild(node, findInitial);
  };
  findInitial(studioAst); assert.ok(initialEffect);
  let initialLoads = 0, loadingReleased = false;
  const initialLoad = { exports: {} as { run?: () => void }, viewRestored: false, viewStorageKey: 'view-a',
    initialModulesView: { current: '' }, templateWorkbench: true, coverView: true, URLSearchParams,
    window: { location: { search: '' } }, loadModules: () => { initialLoads++; }, setLoading: (value: boolean) => { loadingReleased = !value; } };
  vm.runInNewContext(ts.transpileModule(`exports.run = ${initialEffect!.getText(studioAst)};`, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText, initialLoad);
  initialLoad.exports.run!(); equal(initialLoads, 0); equal(initialLoad.initialModulesView.current, '');
  initialLoad.viewRestored = true; initialLoad.exports.run!(); equal(initialLoads, 0); equal(loadingReleased, true);
  initialLoad.coverView = false; initialLoad.exports.run!(); equal(initialLoads, 0, 'Cover/workspace toggle cannot repeat initial load');
  initialLoad.viewStorageKey = 'view-b'; initialLoad.window.location.search = '?moduleId=named'; initialLoad.exports.run!(); equal(initialLoads, 1);
  initialLoad.coverView = true; initialLoad.exports.run!(); equal(initialLoads, 1);
  initialLoad.viewStorageKey = 'view-c'; initialLoad.window.location.search = '?presetId=named'; initialLoad.exports.run!(); equal(initialLoads, 2);
  initialLoad.viewStorageKey = 'view-d'; initialLoad.window.location.search = ''; initialLoad.templateWorkbench = false; initialLoad.exports.run!(); equal(initialLoads, 3);
  assert.match(studioSource, /gallery\.ready && viewRestored/); additionalAssertions++;
  assert.match(studioSource, /gallery\.sort === 'recent' \? \{ recentHints: galleryLastUsed \} : \{\}/); additionalAssertions++;
  assert.match(executableHook, /observedShared\.current\.owner !== userId/); additionalAssertions++;

  // Capacity belongs to pagination, not query identity; known invalidation/errors do not retain visuals.
  const capacityInitial = await start(); equal(runner.result.matchingScope, false);
  await respond(capacityInitial, 200, galleryResult('capacity', 'capacity'));
  equal(runner.result.matchingScope, true);
  runner.result.setPage(1, 15); await runner.flush(); const capacityRead = nextRequest();
  equal(runner.result.matchingScope, true); equal(runner.result.loading, true);
  await respond(capacityRead, 200, galleryResult('capacity', 'capacity-fresh'));
  runner.result.refresh({ invalidateRevision: true }); await runner.flush(); const invalidCapacity = nextRequest();
  equal(runner.result.matchingScope, false);
  await respond(invalidCapacity, 200, galleryResult('capacity-new', 'capacity-fresh'));
  equal(runner.result.matchingScope, true);
  props = { ...props, query: { ...props.query, query: 'other' } }; runner.setProps(props); await runner.flush();
  const changedCapacity = nextRequest(); equal(runner.result.matchingScope, false);
  await respond(changedCapacity, 200, galleryResult('other', 'other'));
  runner.result.refresh(); await runner.flush(); const failedCapacity = nextRequest();
  await respond(failedCapacity, 503, { error: 'temporarily unavailable' }); equal(runner.result.matchingScope, false);
  runner.result.refresh(); await runner.flush(); const deniedCapacity = nextRequest();
  await respond(deniedCapacity, 403, { error: 'forbidden' }); equal(runner.result.matchingScope, false); equal(runner.result.data, null);
  props = { ...props, userId: 'another-viewer' }; runner.setProps(props); await runner.flush();
  equal(runner.result.matchingScope, false); const newCapacityActor = nextRequest();
  await respond(newCapacityActor, 200, galleryResult('new-actor', 'new-actor')); equal(runner.result.matchingScope, true);

  // Execute the exact studio range/slice/item-loading expressions, rather than reproducing their rules.
  let compatible: ts.Expression | undefined, pageItem: ts.Expression | undefined, visibleItems: ts.Expression | undefined;
  let itemLoading: ts.Expression | undefined;
  const findCapacity = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(studioAst) === 'coverPageCompatible') compatible = node.initializer;
    if (ts.isVariableDeclaration(node) && node.name.getText(studioAst) === 'pageItem') pageItem = node.initializer;
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(studioAst) === 'ModuleGallery') {
      const attribute = node.attributes.properties.find(value => ts.isJsxAttribute(value) && value.name.getText(studioAst) === 'items');
      if (attribute && ts.isJsxAttribute(attribute) && attribute.initializer && ts.isJsxExpression(attribute.initializer)) {
        const map = attribute.initializer.expression;
        if (map && ts.isCallExpression(map) && ts.isPropertyAccessExpression(map.expression)) visibleItems = map.expression.expression;
        const callback = map && ts.isCallExpression(map) ? map.arguments[0] : undefined;
        if (callback && ts.isArrowFunction(callback) && ts.isBlock(callback.body)) {
          const returned = callback.body.statements.find(ts.isReturnStatement)?.expression;
          if (returned && ts.isObjectLiteralExpression(returned)) {
            const property = returned.properties.find(value => ts.isPropertyAssignment(value) && value.name.getText(studioAst) === 'loading');
            if (property && ts.isPropertyAssignment(property)) itemLoading = property.initializer;
          }
        }
      }
    }
    ts.forEachChild(node, findCapacity);
  };
  findCapacity(studioAst); assert.ok(compatible && pageItem && visibleItems && itemLoading);
  type Item = { key: string };
  type Pool = { matchingScope: boolean; loading: boolean; data: { page: number; pageSize: number; items: Item[] } | null };
  type Pages = { page: number; capacity: number; start: number; pageItems: Item[] };
  const projection = { exports: {} as { run?: (pool: Pool, coverPages: Pages) => { key: string; available: boolean; loading: boolean }[] } };
  vm.runInNewContext(ts.transpileModule(`exports.run = (pool, coverPages) => {
    const coverPageCompatible = ${compatible!.getText(studioAst)};
    return (${visibleItems!.getText(studioAst)}).map(entry => {
      const pageItem = ${pageItem!.getText(studioAst)};
      return { key: entry.key, available: Boolean(pageItem), loading: ${itemLoading!.getText(studioAst)} };
    });
  };`, { compilerOptions: { target: ts.ScriptTarget.ES2017, module: ts.ModuleKind.CommonJS } }).outputText, projection);
  const rows = Array.from({ length: 15 }, (_, index) => ({ key: `entry-${index}` }));
  const source: Pool = { matchingScope: true, loading: true, data: { page: 1, pageSize: 15, items: rows } };
  const pages: Pages = { page: 1, capacity: 12, start: 0, pageItems: rows };
  const projected = projection.exports.run!(source, pages);
  equal(projected.length, 12); equal(projected.every(item => item.available && !item.loading), true);
  equal(projected[11].key, 'entry-11', 'Capacity shrink cannot retain items beyond the target page range');
  const smaller: Pool = { ...source, data: { page: 1, pageSize: 12, items: rows.slice(0, 12) } };
  const expanded = projection.exports.run!(smaller, { ...pages, capacity: 15, pageItems: rows.slice(0, 12) });
  equal(expanded.length, 12, 'Growing capacity does not invent the unread new entries'); equal(expanded.every(item => item.available), true);
  equal(projection.exports.run!({ ...source, matchingScope: false }, { ...pages, capacity: 15 }).every(item => item.available && !item.loading), true,
    'Exact page/size preserves the existing ordinary-refresh error recovery; only the new capacity branch requires matching scope');
  for (const [pool, target] of [
    [{ ...source, matchingScope: false }, pages],
    [{ ...source, data: null }, pages],
    [source, { ...pages, page: 2, start: 12 }],
    [{ ...source, data: { ...source.data!, page: 2 } }, { ...pages, page: 2, start: 12 }],
  ] as Array<[Pool, Pages]>) equal(projection.exports.run!(pool, target).every(item => !item.available && item.loading), true);

  // Passive resume reuses the actual pending read; stronger changes still replace it immediately.
  const resume = async (type: string) => {
    browserListeners.get(type)?.forEach(listener => listener({ type })); await runner.flush();
  };
  const pendingResume = await start('resume-marker');
  for (const type of ['focus', 'visibilitychange', 'focus']) await resume(type);
  equal(pendingRequests.length, requestCursor, 'Repeated passive resume must not start another read');
  equal(pendingResume.signal.aborted, false);
  runner.result.setPage(2, 12); await runner.flush(); const resumePage = nextRequest();
  equal(pendingResume.signal.aborted, true, 'Pagination still replaces the pending request immediately');
  equal(resumePage.body.page, 2);
  await respond(pendingResume, 200, galleryResult('old-resume', 'old-resume'));
  await resume('focus'); equal(pendingRequests.length, requestCursor, 'Late completion cannot clear the newer active read');
  equal(resumePage.signal.aborted, false);
  runner.result.refresh({ invalidateRevision: true }); await runner.flush(); const resumeInvalidation = nextRequest();
  equal(resumePage.signal.aborted, true, 'Explicit invalidation must still replace a pending read');
  equal(resumeInvalidation.body.catalogRevision, undefined);
  await respond(resumePage, 200, galleryResult('late-page', 'late-page'));
  await resume('visibilitychange'); equal(pendingRequests.length, requestCursor);
  await resume('online'); const reconnected = nextRequest();
  equal(resumeInvalidation.signal.aborted, true, 'Online always replaces a possibly interrupted request');
  await respond(resumeInvalidation, 200, galleryResult('late-invalidated', 'late-invalidated'));
  await resume('focus'); equal(pendingRequests.length, requestCursor);
  await respond(reconnected, 200, galleryResult('reconnected', 'reconnected', 'resume-marker'));
  equal(dataSnapshot()?.fixtureLabel, 'reconnected');
  await resume('focus'); const settledResume = nextRequest();
  equal(settledResume.signal.aborted, false, 'Resume after completion still starts a fresh read');
  await respond(settledResume, 200, galleryResult('settled-resume', 'settled-resume', 'resume-marker'));
  equal(dataSnapshot()?.fixtureLabel, 'settled-resume');

  console.log(JSON.stringify({ fixture: 'gallery-explicit-invalidation-fixture', assertions: 27 + additionalAssertions,
    requests: pendingRequests.length, status: 'passed' }));
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
