import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

export async function runPricingFocusEngineering(source = readFileSync('src/app/admin/pricing/AdminPricingClient.tsx', 'utf8')) {
  const file = ts.createSourceFile('AdminPricingClient.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const variables = new Map<string, ts.Expression>();
  let initialize: ts.Expression | undefined;
  let moneyInputDisabled: ts.Expression | undefined, compactChange: ts.Expression | undefined;
  const hasActorAssignment = (node: ts.Node): boolean => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && node.left.getText(file) === 'currentActor.current' && node.right.getText(file) === 'actorId') return true;
    return ts.forEachChild(node, hasActorAssignment) || false;
  };
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) variables.set(node.name.text, node.initializer);
    if (ts.isVariableDeclaration(node) && node.initializer?.getText(file).includes('moneyRows.get(row.id)')) compactChange = node.initializer;
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(file) === 'input'
      && node.attributes.properties.some(item => ts.isJsxAttribute(item) && item.name.getText(file) === 'aria-label'
        && item.initializer?.getText(file).includes('人民币单价'))) {
      const attribute = node.attributes.properties.find(item => ts.isJsxAttribute(item) && item.name.getText(file) === 'disabled');
      if (attribute && ts.isJsxAttribute(attribute) && attribute.initializer && ts.isJsxExpression(attribute.initializer)) moneyInputDisabled = attribute.initializer.expression;
    }
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'useEffect'
      && node.arguments[0] && hasActorAssignment(node.arguments[0])) initialize = node.arguments[0];
    ts.forEachChild(node, visit);
  };
  visit(file);
  const expression = (name: string) => {
    const value = variables.get(name); assert.ok(value, `Missing real callback ${name}`);
    return ts.isCallExpression(value) && value.expression.getText(file) === 'useCallback' ? value.arguments[0] : value;
  };
  const evaluate = (value: ts.Expression, context: vm.Context) => vm.runInContext(ts.transpileModule(`(${value.getText(file)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, context);
  const snapshot = (revision = 'current', id = 'admin-a') => ({ schemaVersion: 1, actor: { id }, revision,
    authoring: { revision: 'authoring' }, catalogFingerprint: 'catalog', rows: [] });
  const response = (status: number, data = snapshot()) => ({ status, ok: status >= 200 && status < 300, json: async () => data });
  function harness(fetchResponse: () => Promise<ReturnType<typeof response>>, actorId = 'admin-a') {
    const state: Record<string, any> = { identityVerified: true, snapshot: snapshot(), draft: { revision: 'current',
      changes: { rows: [{ id: 'own-draft', pricingEnabled: false }] } }, denied: false, reading: false, readError: '' };
    const requests: Array<{ url: string; init: RequestInit }> = [], reads: Promise<void>[] = [], events: string[] = [];
    const context: Record<string, any> = { Error, actorId, endpoint: '/api/admin/pricing', document: { hidden: true },
      alive: { current: true }, currentActor: { current: actorId }, readSequence: { current: 0 }, restored: { current: true },
      restoredAnchor: { current: false }, userInteracted: { current: false }, saveLock: { current: false },
      scrollAnchor: { current: null },
      window: { dispatchEvent: (event: { type: string }) => events.push(event.type) },
      CustomEvent: class { constructor(public type: string, public options: unknown) {} },
      fetch: async (url: string, init: RequestInit) => { requests.push({ url, init }); return fetchResponse(); } };
    for (const name of ['IdentityVerified', 'Snapshot', 'Draft', 'Denied', 'Reading', 'ReadError', 'HistoryOpen', 'PreviewResult',
      'Selected', 'Pending', 'Hydrated', 'OperationStorageFailed', 'StorageFailed', 'Restore', 'RecoveringDraft', 'ShowAlternateImageChannels']) {
      const key = name[0].toLowerCase() + name.slice(1);
      context[`set${name}`] = (value: any) => { state[key] = typeof value === 'function' ? value(state[key]) : value; };
    }
    vm.createContext(context);
    for (const name of ['active', 'unauthorized', 'authorized']) context[name] = evaluate(expression(name), context);
    const read = evaluate(expression('load'), context);
    context.load = (...args: unknown[]) => { const result = read(...args); reads.push(result); return result; };
    return { state, context, requests, reads, events, visibility: evaluate(expression('visibility'), context),
      initialize: () => { assert.ok(initialize); return evaluate(initialize, context)(); } };
  }

  // Execute the actual page callbacks; the deployed browser check covers DOM hit targets.
  const failed = harness(async () => { throw new TypeError('Failed to fetch'); });
  const draft = JSON.stringify(failed.state.draft);
  failed.visibility();
  assert.equal(failed.requests.length, 0, 'Backgrounding does not start a read');
  assert.equal(failed.state.identityVerified, true, 'Backgrounding does not invalidate the verified actor');
  failed.context.document.hidden = false;
  failed.visibility(); await Promise.all(failed.reads);
  assert.equal(failed.state.identityVerified, true, 'A failed refresh must not hide the verified editor');
  assert.equal(failed.state.snapshot.revision, 'current'); assert.equal(failed.state.reading, false);
  assert.equal(failed.state.readError, 'Failed to fetch'); assert.equal(JSON.stringify(failed.state.draft), draft);

  const ready = harness(async () => response(200));
  ready.context.document.hidden = false; ready.visibility(); await Promise.all(ready.reads);
  assert.equal(ready.state.identityVerified, true); assert.equal(ready.state.readError, '');
  assert.equal(ready.requests[0].init.cache, 'no-store'); assert.equal(ready.requests[0].url, '/api/admin/pricing');
  assert.equal((ready.requests[0].init.headers as Record<string, string>)['x-app-session-user'], 'admin-a');
  assert.equal(JSON.stringify(ready.state.draft), draft, 'Refreshing preserves the unsaved draft');

  for (const result of [response(401), response(403), response(200, snapshot('other', 'admin-b'))]) {
    const denied = harness(async () => result);
    await denied.context.load();
    assert.equal(denied.state.identityVerified, false, 'Real permission or actor loss masks the page');
    assert.equal(denied.state.snapshot, null); assert.equal(denied.state.denied, true);
    assert.equal(denied.state.draft.changes.rows.length, 0, 'Another account cannot inherit the draft');
  }

  let finishOld!: (value: ReturnType<typeof response>) => void;
  let call = 0;
  const late = harness(() => ++call === 1 ? new Promise(resolve => { finishOld = resolve; }) : Promise.resolve(response(200, snapshot('new'))));
  const oldRead = late.context.load(); await late.context.load();
  finishOld(response(200, snapshot('old'))); await oldRead;
  assert.equal(late.state.snapshot.revision, 'new', 'A late response cannot overwrite the current revision');

  let finishIdentity!: (value: ReturnType<typeof response>) => void;
  const switching = harness(() => new Promise(resolve => { finishIdentity = resolve; }), 'admin-b');
  const cleanup = switching.initialize();
  assert.equal(switching.state.identityVerified, false, 'Actual actor initialization still masks immediately');
  assert.equal(switching.state.snapshot, null);
  cleanup(); finishIdentity(response(200, snapshot('other', 'admin-b'))); await Promise.all(switching.reads);
  assert.equal(switching.state.identityVerified, false, 'Unmounted actor requests cannot restore visibility');

  const saving: Record<string, any> = { preview: { changes: [{}] }, actionable: true, action: { kind: 'save', changes: { standards: {} } },
    pending: null, saving: false, previewBusy: false, conflict: false, readError: '', reading: false,
    invalidRate: false, invalidEnhance: false, invalidEnabled: false, operationStorageFailed: false, scenarioOverflow: false };
  vm.createContext(saving);
  assert.equal(evaluate(expression('canSave'), saving), true);
  for (const key of ['reading', 'readError', 'conflict', 'pending', 'operationStorageFailed']) {
    const previous = saving[key]; saving[key] = key === 'readError' ? 'Read failed' : true;
    assert.equal(evaluate(expression('canSave'), saving), false, `${key} still prevents a save`);
    saving[key] = previous;
  }

  const editing: Record<string, any> = { Boolean, pending: null, saving: false, conflict: true, reading: false, readError: '',
    recoveringDraft: false, complexDraft: false, cannotEnable: false, row: { id: 'own-draft' },
    moneyRows: new Map([['own-draft', { id: 'own-draft', base: { amount: '0.051' }, pricingEnabled: false }]]) };
  vm.createContext(editing);
  assert.ok(moneyInputDisabled && compactChange, 'Real compact price controls must be found');
  assert.equal(evaluate(expression('disabled'), editing), false, 'A stale revision blocks saving, not switch draft editing');
  assert.equal(evaluate(moneyInputDisabled, editing), false, 'A stale revision must not lock the amount draft');
  assert.equal(evaluate(compactChange, editing), editing.moneyRows.get('own-draft'), 'Conflicting draft values stay visible');
  for (const key of ['pending', 'saving', 'reading', 'readError', 'complexDraft', 'cannotEnable']) {
    const previous = editing[key]; editing[key] = key === 'readError' ? 'Read failed' : true;
    assert.equal(evaluate(expression('disabled'), editing), true, `${key} retains its switch guard`);
    editing[key] = previous;
  }
  return { completed: true, actualSourceCallbacks: true, checks: ['same-actor visibility', 'failed refresh keeps editor/draft',
    'fresh success', '401/403/mismatched actor cleared', 'late reply ignored', 'actor initialization masked', 'unmount ignored', 'write barriers retained',
    'conflict allows draft edits', 'conflicting draft stays visible', 'switch guards retained'],
  networkCalls: 0, databaseWrites: 0, paidRequests: 0 };
}

if (require.main === module) runPricingFocusEngineering().then(result => console.log(JSON.stringify(result)))
  .catch(error => { console.error(error); process.exitCode = 1; });
