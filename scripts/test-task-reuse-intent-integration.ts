import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as intentContract from '../src/lib/navigation/task-reuse-intent';

// Runs the actual production callbacks and route with offline boundaries. No
// browser, network, DB, task creation, payment or upload is permitted here.
type Scope = Record<string, any>;
const root = resolve(process.argv[2] || process.cwd());
const pageSource = readFileSync(resolve(root, 'src/components/generate/GeneratePageClient.tsx'), 'utf8');
const composerSource = readFileSync(resolve(root, 'src/components/GenerationComposer.tsx'), 'utf8');
const routeSource = readFileSync(resolve(root, 'src/app/api/tasks/[id]/reuse/route.ts'), 'utf8');

function parsed(source: string) {
  return ts.createSourceFile('fixture.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}
function callback(source: string, variable: string): string {
  const tree = parsed(source);
  let found = '';
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === variable && node.initializer && ts.isCallExpression(node.initializer)) {
      found = node.initializer.arguments[0].getText(tree);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.ok(found, `actual callback missing: ${variable}`);
  return found;
}
function effect(source: string, marker: string): string {
  const tree = parsed(source);
  const matches: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 'useEffect' && node.arguments[0]?.getText(tree).includes(marker)) {
      matches.push(node.arguments[0].getText(tree));
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.equal(matches.length, 1, `unambiguous production effect: ${marker}`);
  return matches[0];
}
function assignedValue(source: string, target: string): string {
  const tree = parsed(source);
  const matches: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && node.left.getText(tree) === target) {
      matches.push(node.right.getText(tree));
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.equal(matches.length, 1, `unambiguous production assignment: ${target}`);
  return matches[0];
}
function compileFunction(text: string, scope: Scope): (...args: any[]) => any {
  const output = ts.transpileModule(`exports.run = ${text};`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  scope.exports = {};
  runInNewContext(output, scope);
  return scope.exports.run;
}
const clone = (value: any) => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let step = 0; step < 8; step += 1) await Promise.resolve(); };
const draft = {
  task_id: 'fixture-task', provider: 'seedance', prompt: '<script>ordinary task text</script>',
  generation_mode: 'all_in_one_reference', model: 'seedance-2.0', duration: 15, resolution: '480p', ratio: '16:9',
  seed: -1, generate_audio: true, return_last_frame: false, watermark: false, resolution_approval_confirmed: false,
  project_id: 'fixture-project', video_card_id: 'fixture-card', video_branch_id: 'fixture-branch',
  video_card: { id: 'fixture-card', project_id: 'fixture-project' },
};

function pageHarness(storage = new Map<string, string>()) {
  const state: Scope = { message: '', confirms: 0, requests: [], draft: null, unknown: false, refreshes: 0 };
  const context = {
    accountId: 'fixture-owner', workspaceBridgeKey: 'fixture-owner:standard', tabId: 'fixture-tab',
    projectId: 'fixture-project', videoCardId: 'fixture-card', videoBranchId: 'fixture-branch',
    editEpoch: 0, initializing: false, conflict: null, busy: false,
  };
  const scope: Scope = {
    ...intentContract, URL, URLSearchParams, Promise, currentUser: { id: 'fixture-owner' }, loadingUser: false, isIpSurface: false,
    activeAccountIdRef: { current: 'fixture-owner' }, workspaceBridgeKeyRef: { current: context.workspaceBridgeKey },
    reuseRequestIdRef: { current: 0 }, reuseInFlightRef: { current: false }, reuseIntentRef: { current: null },
    reuseEditEpochRef: { current: 0 }, reuseApplicationKeyRef: { current: 0 }, pendingReuseApplicationRef: { current: null },
    parameterOnlyReuseRef: { current: null }, workspaceBusySnapshotRef: { current: { key: context.workspaceBridgeKey, busy: false, reason: null } },
    userChangedProjectRef: { current: false }, userChangedVideoCardRef: { current: false }, userChangedVideoBranchRef: { current: false },
    projects: [{ id: context.projectId }], videoCards: [{ id: context.videoCardId, project_id: context.projectId }],
    videoBranches: [{ id: context.videoBranchId }], loadingProjects: false, loadingVideoCards: false, loadingVideoBranches: false,
    videoCardsLoadedProjectId: context.projectId, videoBranchesLoadedCardId: context.videoCardId,
    selectedProjectId: context.projectId, selectedVideoCardId: context.videoCardId,
    reuseLoading: false, reusePreflightPending: false, reuseOutcomeUnknown: false, reuseRefreshRequested: false, workspaceBusy: false,
    sessionStorage: { getItem: (key: string) => {
      if (state.failStorageRead) throw new Error('offline storage read denied');
      return key === 'workspace_tab_id' ? context.tabId : storage.get(key) || null;
    },
      setItem: (key: string, value: string) => { if (state.failStorageWrite) throw new Error('offline storage denied'); storage.set(key, value); },
      removeItem: (key: string) => storage.delete(key) },
    readReuseContext: () => ({ ...context }),
    updateReuseIntent: (value: any) => { scope.reuseIntentRef.current = value; scope.reuseIntent = value; },
    asBoolean: (value: unknown, fallback: boolean) => typeof value === 'boolean' ? value : fallback,
    readJsonResponse: async (response: any) => response.body,
    confirm: async () => { state.confirms += 1; if (state.onConfirm) state.onConfirm(); return state.approved !== false; },
    fetch: async (url: string, options: any) => {
      assert.match(url, /^\/api\/tasks\/fixture-task\/reuse$/);
      assert.equal(options.method, 'POST'); assert.equal(options.headers['x-tab-id'], 'fixture-tab');
      const source = new URL(scope.window.location.href).searchParams;
      assert.equal(source.get('reuse_task_id'), null, 'the old v0.85 reader cannot auto-POST this in-flight source');
      assert.equal(source.get('reuse_unconfirmed_task_id'), 'fixture-task', 'the safe source is recorded before the actual POST');
      state.requests.push({ url, options });
      if (state.onResponse) state.onResponse();
      if (state.rejectRequest) throw new Error('offline unknown response');
      return state.response || { ok: true, status: 200, body: { draft, restored_references: 0, skipped_references: 0 } };
    },
    document: { querySelector: () => null },
    requestAnimationFrame: (fn: () => void) => fn(),
  };
  scope.window = {
    location: { href: 'https://fixture.invalid/generate?reuse_task_id=fixture-task&project_id=fixture-project&return_to=%2Ftasks' },
    requestAnimationFrame: (fn: () => void) => { if (state.onFrame) state.onFrame(); fn(); },
    history: { replaceState: (_data: unknown, _title: string, url: string) => {
      scope.window.location.href = new URL(url, scope.window.location.href).href;
    } },
  };
  Object.defineProperty(scope.window.location, 'search', { get: () => new URL(scope.window.location.href).search });
  const setterNames = ['ReuseLoading', 'ReusingTaskId', 'ReusePreflightPending', 'ReuseRefreshRequested', 'ReuseParameterOnlyAvailable',
    'Result', 'Error', 'ErrorDebug', 'PolledResult', 'SelectedProjectId', 'SelectedVideoCardId', 'SelectedVideoBranchId'];
  setterNames.forEach(name => { scope[`set${name}`] = (value: any) => { state[name] = value; scope[name[0].toLowerCase() + name.slice(1)] = value; }; });
  scope.setReuseMessage = (value: string) => { state.message = value; };
  scope.setReuseOutcomeUnknown = (value: boolean) => { state.unknown = value; scope.reuseOutcomeUnknown = value; };
  scope.setReuseDraft = (value: any) => { state.draft = value; scope.reuseDraft = value; };
  scope.setReuseApplicationTick = () => {};
  scope.transitionReuseSourceUrl = compileFunction(callback(pageSource, 'transitionReuseSourceUrl'), scope);
  const load = compileFunction(callback(pageSource, 'loadReusableTask'), scope);
  scope.loadReusableTask = (...args: any[]) => { state.pending = load(...args); return state.pending; };
  const auto = compileFunction(effect(pageSource, 'taskReuseAutoAction(intent, context)'), scope);
  const complete = compileFunction(callback(pageSource, 'completeReuseDraftApplication'), scope);
  const finalize = compileFunction(effect(pageSource, 'pending.formApplied'), scope);
  const cancel = compileFunction(callback(pageSource, 'cancelReuseIntent'), scope);
  function useActualPageBridge() {
    Object.assign(scope, {
      reuseContextRef: { current: { ...context } }, workspaceBridgeKey: context.workspaceBridgeKey,
      selectedVideoBranchId: context.videoBranchId, parentReuseInitializing: false, parentReuseConflict: null,
      reuseContextBusy: false,
      composerReuseState: { key: context.workspaceBridgeKey, initializing: false, conflict: false, editRevision: 0 },
      composerReuseStateRef: { current: { key: context.workspaceBridgeKey, initializing: false, conflict: false, editRevision: 0 } },
    });
    const renderBridge = compileFunction(`() => (${assignedValue(pageSource, 'reuseContextRef.current')})`, scope);
    scope.readReuseContext = compileFunction(callback(pageSource, 'readReuseContext'), scope);
    return () => { scope.reuseContextRef.current = renderBridge(); return scope.reuseContextRef.current; };
  }
  async function applyComposer() {
    assert.ok(scope.reuseDraft);
    Object.assign(scope, {
      studioHandoff: null, appliedReuseDraftRef: { current: null }, reportedReuseAppliedRef: { current: null },
      workspace: { loading: false, error: null, refresh: async () => { state.refreshes += 1; } },
      require1080pApproval: false, modelOptions: [{ id: draft.model }],
      runWorkspaceOperation: async (fn: () => Promise<void>, userChange: boolean) => {
        assert.equal(userChange, false, 'a reuse read cannot count as a fresh edit'); await fn();
      },
      onModelChange: () => {}, onReuseDraftApplied: complete,
      setReuseReadCompleteKey: (value: any) => { scope.reuseReadCompleteKey = value; },
    });
    ['Prompt', 'GenerationMode', 'Ratio', 'Duration', 'Resolution', 'Seed', 'GenerateAudio', 'ReturnLastFrame', 'Watermark',
      'SelectedModel', 'ResolutionApprovalConfirmed'].forEach(name => {
      scope[`set${name}`] = (value: any) => { scope[name[0].toLowerCase() + name.slice(1)] = value; };
    });
    const apply = compileFunction(effect(composerSource, 'setPrompt(reuseDraft.prompt)'), scope);
    apply(); await flush();
    const ack = compileFunction(effect(composerSource, 'reportedReuseAppliedRef.current === reuseKey'), scope);
    ack(); finalize();
    assert.equal(scope.prompt, draft.prompt, 'actual composer restores text even with zero references');
    assert.equal(scope.duration, 15); assert.equal(scope.ratio, '16:9'); assert.equal(scope.resolution, '480p');
  }
  return { state, context, scope, auto, load: scope.loadReusableTask, applyComposer, cancel, useActualPageBridge,
    storage, hasSource: () => {
      const source = new URL(scope.window.location.href).searchParams;
      return source.has('reuse_task_id') || source.has('reuse_unconfirmed_task_id');
    } };
}

async function checkPage() {
  const slow = pageHarness(); slow.context.initializing = true; slow.context.busy = true;
  slow.auto(); slow.auto(); assert.equal(slow.state.requests.length, 0); assert.ok(slow.hasSource());
  slow.context.initializing = false; slow.context.busy = false;
  slow.auto(); await slow.state.pending;
  assert.equal(slow.state.confirms, 1); assert.equal(slow.state.requests.length, 1); assert.ok(slow.hasSource(), 'URL retained until the composer actually applies');
  await slow.applyComposer(); assert.equal(slow.hasSource(), false); assert.equal(slow.scope.reuseIntent.phase, 'done');
  slow.auto(); assert.equal(slow.state.requests.length, 1, 'no automatic second POST after success');

  const blocked = pageHarness(); blocked.context.conflict = '正在上传'; blocked.context.busy = true;
  blocked.auto(); blocked.auto(); assert.equal(blocked.scope.reuseIntent.phase, 'blocked'); assert.equal(blocked.state.requests.length, 0);
  blocked.context.conflict = null; blocked.context.busy = false; blocked.auto(); assert.equal(blocked.state.requests.length, 0);
  await blocked.load('fixture-task', { clearUrl: true }); assert.equal(blocked.state.confirms, 1); await blocked.applyComposer();

  const initializingLate = pageHarness();
  initializingLate.state.onFrame = () => { initializingLate.context.initializing = true; initializingLate.context.busy = true; };
  await initializingLate.load('fixture-task', { clearUrl: true });
  assert.equal(initializingLate.state.confirms, 0); assert.equal(initializingLate.state.requests.length, 0); assert.ok(initializingLate.hasSource());
  initializingLate.state.onFrame = null; initializingLate.context.initializing = false; initializingLate.context.busy = false;
  initializingLate.auto(); await initializingLate.state.pending; assert.equal(initializingLate.state.requests.length, 1);

  const edited = pageHarness(); edited.state.onConfirm = () => { edited.context.editEpoch += 1; };
  await edited.load('fixture-task', { clearUrl: true });
  assert.equal(edited.state.requests.length, 0); assert.equal(edited.scope.reuseIntent.phase, 'blocked'); assert.ok(edited.hasSource());
  edited.state.onConfirm = null; await edited.load('fixture-task', { clearUrl: true }); assert.equal(edited.state.confirms, 2);
  assert.equal(edited.state.requests.length, 1);

  for (const change of ['account', 'project', 'tab', 'branch'] as const) {
    const late = pageHarness(); late.state.onResponse = () => {
      if (change === 'account') { late.context.accountId = 'fixture-other'; late.scope.activeAccountIdRef.current = 'fixture-other'; }
      if (change === 'project') late.context.projectId = 'fixture-other-project';
      if (change === 'tab') late.context.tabId = 'fixture-other-tab';
      if (change === 'branch') late.context.videoBranchId = 'fixture-other-branch';
    };
    await late.load('fixture-task', { clearUrl: true });
    assert.equal(late.state.draft, null, `late ${change} cannot write parameters`); assert.ok(late.hasSource());
    if (change !== 'account') {
      assert.equal(late.state.unknown, true); late.auto(); await late.load('fixture-task', { clearUrl: true });
      assert.equal(late.state.requests.length, 1, 'unknown result cannot be blindly POSTed again');
    }
  }
  const switched = pageHarness();
  const accountScope = switched.scope;
  Object.assign(accountScope, {
    previousAccountIdRef: { current: 'fixture-owner' }, workspaceBridgeKey: 'fixture-other:standard',
    composerReuseStateRef: { current: { key: 'fixture-owner:standard', initializing: false, conflict: false, editRevision: 0 } },
    workspaceRefreshRef: { current: null },
  });
  ['projectsRequestIdRef', 'videoCardsRequestIdRef', 'videoBranchesRequestIdRef', 'collectionsRequestIdRef', 'creditsRequestIdRef']
    .forEach(name => { accountScope[name] = { current: 0 }; });
  ['Projects', 'LoadingProjects', 'VideoCards', 'LoadingVideoCards', 'VideoBranches', 'LoadingVideoBranches',
    'VideoCardsLoadedProjectId', 'VideoBranchesLoadedCardId', 'Collections', 'Credits', 'StudioHandoff', 'StudioWorkspaceTabId',
    'ReuseRefreshInProgress', 'ComposerReuseState', 'WorkspaceBusySnapshot', 'WorkspaceRefreshReadyKey'].forEach(name => {
      accountScope[`set${name}`] = (value: any) => { accountScope[name[0].toLowerCase() + name.slice(1)] = value; };
    });
  const resetAccount = compileFunction(effect(pageSource, 'const nextAccountId = currentUser?.id || null'), accountScope);
  switched.state.onResponse = () => {
    accountScope.currentUser.id = 'fixture-other'; accountScope.activeAccountIdRef.current = 'fixture-other';
    switched.context.accountId = 'fixture-other'; resetAccount();
  };
  await switched.load('fixture-task', { clearUrl: true });
  assert.equal(accountScope.reuseIntentRef.current, null); assert.equal(switched.state.draft, null);
  assert.equal(switched.hasSource(), false); assert.match(switched.state.message, /未继续恢复旧账号的输入/);
  assert.match(switched.state.message, /结果须回到原账号核对/);
  assert.equal(switched.state.message.includes('已取消旧账号的复用请求'), false, 'an account switch never claims a server cancellation');
  assert.equal(switched.state.requests.length, 1, 'late old-account response cannot create a request for the new account');
  assert.ok(switched.storage.has(intentContract.taskReuseReceiptKey('fixture-owner', 'fixture-tab', 'fixture-task')),
    'changing accounts never clears the old account unknown fence');

  const unknown = pageHarness(); unknown.state.rejectRequest = true;
  await unknown.load('fixture-task', { clearUrl: true }); unknown.auto(); await unknown.load('fixture-task', { clearUrl: true });
  assert.equal(unknown.state.unknown, true); assert.equal(unknown.state.requests.length, 1); assert.ok(unknown.hasSource());
  unknown.cancel(); assert.ok(unknown.hasSource(), 'unknown cannot end before a reference read is requested');
  const reopened = pageHarness(unknown.storage); reopened.scope.window.location.href = unknown.scope.window.location.href; reopened.auto();
  assert.equal(reopened.scope.reuseIntent.phase, 'unknown'); assert.equal(reopened.state.requests.length, 0);
  await reopened.load('fixture-task', { clearUrl: true }); assert.equal(reopened.state.requests.length, 0, 'refresh retains the unknown POST fence');
  const onlyUrl = pageHarness(); onlyUrl.scope.window.location.href = unknown.scope.window.location.href;
  onlyUrl.state.draft = { prompt: 'current input retained' }; onlyUrl.auto();
  assert.equal(onlyUrl.scope.reuseIntent.phase, 'unknown'); assert.equal(onlyUrl.state.requests.length, 0);
  assert.equal(onlyUrl.state.draft.prompt, 'current input retained', 'unknown URL recovery never clears the current form');
  assert.equal(new URL(onlyUrl.scope.window.location.href).searchParams.get('reuse_task_id'), null);
  const directUnknown = pageHarness(); directUnknown.scope.window.location.href = unknown.scope.window.location.href;
  await directUnknown.load('fixture-task');
  assert.equal(directUnknown.state.requests.length, 0); assert.equal(directUnknown.state.confirms, 0);
  assert.equal(directUnknown.scope.reuseIntent.phase, 'unknown', 'the direct entry also honors an unknown URL even without a storage fence');
  const recentUnknown = pageHarness(); recentUnknown.scope.window.location.href = 'https://fixture.invalid/generate?return_to=%2Ftasks&project_id=fixture-project';
  recentUnknown.state.rejectRequest = true; await recentUnknown.load('fixture-task');
  assert.equal(new URL(recentUnknown.scope.window.location.href).searchParams.get('reuse_unconfirmed_task_id'), 'fixture-task');
  const recentReopened = pageHarness(); recentReopened.scope.window.location.href = recentUnknown.scope.window.location.href; recentReopened.auto();
  assert.equal(recentReopened.scope.reuseIntent.phase, 'unknown'); assert.equal(recentReopened.state.requests.length, 0);
  unknown.scope.reuseRefreshRequested = true; unknown.cancel();
  assert.equal(unknown.state.requests.length, 1); assert.equal(unknown.hasSource(), false); assert.equal(unknown.storage.size, 0);
  const cannotStore = pageHarness(); cannotStore.state.failStorageWrite = true;
  await cannotStore.load('fixture-task', { clearUrl: true });
  assert.equal(cannotStore.state.requests.length, 0); assert.equal(cannotStore.scope.reuseIntent.phase, 'failed');
  assert.ok(cannotStore.hasSource()); assert.match(cannotStore.state.message, /未发送请求/);
  const cannotRead = pageHarness(); const renderUnreadable = cannotRead.useActualPageBridge();
  cannotRead.state.failStorageRead = true;
  assert.doesNotThrow(() => renderUnreadable(), 'the production render bridge tolerates a refused sessionStorage getter');
  assert.equal(cannotRead.scope.reuseContextRef.current.tabId, '', 'unreadable never means the default tab');
  assert.doesNotThrow(() => cannotRead.scope.readReuseContext());
  cannotRead.auto(); await cannotRead.load('fixture-task', { clearUrl: true });
  assert.equal(cannotRead.state.requests.length, 0); assert.equal(cannotRead.state.confirms, 0);
  assert.ok(cannotRead.hasSource()); assert.match(cannotRead.state.message, /无法读取工作台标签，未发送复用请求/);
  const failedReadIntent = cannotRead.scope.reuseIntentRef.current;
  cannotRead.auto(); cannotRead.auto();
  assert.equal(cannotRead.scope.reuseIntentRef.current, failedReadIntent, 'continued storage refusal does not self-trigger new intent objects');
  const lateUnreadable = pageHarness(); const renderReadable = lateUnreadable.useActualPageBridge(); renderReadable();
  lateUnreadable.state.onFrame = () => { lateUnreadable.state.failStorageRead = true; };
  await lateUnreadable.load('fixture-task', { clearUrl: true });
  assert.equal(lateUnreadable.state.requests.length, 0); assert.equal(lateUnreadable.state.confirms, 0);
  assert.ok(lateUnreadable.hasSource()); assert.match(lateUnreadable.state.message, /无法读取工作台标签，未发送复用请求/);

  const refused = pageHarness(); refused.state.response = { ok: false, status: 400, body: { error: '参数读取失败' } };
  await refused.load('fixture-task', { clearUrl: true }); refused.auto(); assert.equal(refused.state.requests.length, 1);
  assert.ok(refused.hasSource()); assert.equal(refused.scope.reuseIntent.phase, 'failed');
  assert.equal(new URL(refused.scope.window.location.href).searchParams.get('reuse_task_id'), 'fixture-task');
  assert.equal(new URL(refused.scope.window.location.href).searchParams.get('reuse_unconfirmed_task_id'), null);
  const newerSource = pageHarness(); newerSource.state.response = { ok: false, status: 400, body: { error: '确定拒绝' } };
  newerSource.state.onResponse = () => {
    const url = new URL(newerSource.scope.window.location.href); url.searchParams.set('reuse_task_id', 'fixture-newer');
    url.searchParams.set('project_id', 'fixture-newer-project'); newerSource.scope.window.location.href = url.href;
  };
  await newerSource.load('fixture-task', { clearUrl: true });
  assert.equal(new URL(newerSource.scope.window.location.href).searchParams.get('reuse_task_id'), 'fixture-newer');
  assert.equal(new URL(newerSource.scope.window.location.href).searchParams.get('project_id'), 'fixture-newer-project');
  assert.equal(newerSource.state.draft, null);
  const newerAfterSuccess = pageHarness(); newerAfterSuccess.state.onResponse = () => {
    const url = new URL(newerAfterSuccess.scope.window.location.href); url.searchParams.set('reuse_task_id', 'fixture-newer');
    newerAfterSuccess.scope.window.location.href = url.href;
  };
  await newerAfterSuccess.load('fixture-task', { clearUrl: true });
  assert.equal(newerAfterSuccess.state.draft, null); assert.equal(newerAfterSuccess.state.unknown, true);
  assert.equal(new URL(newerAfterSuccess.scope.window.location.href).searchParams.get('reuse_task_id'), 'fixture-newer');
  const missing = pageHarness(); missing.state.response = { ok: false, status: 404, body: { error: '任务不存在' } };
  await missing.load('fixture-task', { clearUrl: true }); assert.equal(missing.hasSource(), false); assert.match(missing.state.message, /任务不存在/);

  const partial = pageHarness(); partial.state.response = { ok: false, status: 409, body: {
    code: 'REUSE_ASSETS_UNAVAILABLE', error: '原参考素材无法恢复', draft, skipped_references: 1,
    inputWarnings: ['有 1 项历史素材缺失、已停用或当前账号无权使用，未加入工作区。'],
  } };
  await partial.load('fixture-task', { clearUrl: true });
  assert.equal(partial.state.draft, null); assert.ok(partial.hasSource()); assert.match(partial.state.message, /仅参数可恢复，当前素材保留/);
  await partial.scope.parameterOnlyReuseRef.current();
  assert.equal(partial.state.confirms, 2, 'partial parameter recovery asks explicit confirmation');
  assert.equal(partial.state.requests.length, 1, 'parameter-only recovery never replays the POST');
  await partial.applyComposer(); assert.equal(partial.hasSource(), false); assert.match(partial.state.message, /当前素材保留/);

  const mismatched = pageHarness(); mismatched.state.response = { ok: true, status: 200, body: { draft: { ...draft, video_card: { id: draft.video_card_id, project_id: 'fixture-other-project' } } } };
  await mismatched.load('fixture-task', { clearUrl: true }); assert.equal(mismatched.state.draft, null); assert.equal(mismatched.state.unknown, true);
  assert.ok(pageSource.includes('onReuseDraftApplied={completeReuseDraftApplication}'));
  assert.ok(pageSource.includes('onReuseStateChange={reportComposerReuseState}'));
  assert.ok(composerSource.includes('onChangeCapture={markReuseInputChanged}'));
}

async function checkRoute() {
  class FixtureAuthError extends Error { status = 403; }
  const state: Scope = { missing: false, denied: false, session: true, transactions: 0, workspaceCreates: 0, deletes: 0, adds: 0 };
  const task: Scope = { id: draft.task_id, provider: draft.provider, prompt: draft.prompt, generation_mode: draft.generation_mode,
    model: draft.model, ratio: draft.ratio, duration: draft.duration, resolution: draft.resolution, seed: draft.seed,
    generate_audio: draft.generate_audio, return_last_frame: false, watermark: false,
    params_json: null, snapshot_id: null, project_id: draft.project_id, video_card_id: draft.video_card_id,
    video_branch_id: draft.video_branch_id, video_card: draft.video_card, reference_image_ids: null,
    reference_image_urls: null, reference_video_urls: null, reference_audio_urls: null, frame_image_urls: null,
    first_frame_url: null, last_frame_url: null };
  const prisma = {
    videoTask: { findUnique: async () => state.missing ? null : task },
    generationTaskSnapshot: { findUnique: async () => null, findFirst: async () => null },
    workspaceAsset: { findMany: async () => [] },
    asset: { findMany: async () => [] }, referenceImage: { findMany: async () => [] },
    $transaction: async (fn: (tx: any) => Promise<void>) => {
      state.transactions += 1; await fn({ workspaceAsset: {
        deleteMany: async () => { state.deletes += 1; }, createMany: async () => { state.adds += 1; },
      } });
    },
  };
  const modules: Scope = {
    'next/server': { NextResponse: { json: (body: any, options: any = {}) => ({ body, status: options.status || 200 }) } },
    '@/lib/prisma': { prisma }, '@/lib/auth/session': { AuthError: FixtureAuthError, getSession: async () => state.session ? { id: 'fixture-owner' } : null },
    '@/lib/access/feature-guard': { assertInternalOnly: () => {} },
    '@/lib/assets/workspace': { getOrCreateWorkspace: async () => { state.workspaceCreates += 1; return { id: 'fixture-workspace' }; } },
    '@/lib/projects/permissions': { assertCanViewTask: async () => { if (state.denied) throw new FixtureAuthError('无权读取'); } },
    '@/lib/reference-albums/permissions': { assertCanUseReferenceImage: async () => { throw new FixtureAuthError('无权读取'); },
      canUseDirectAsset: async () => false, uniquePreserveOrder: (values: string[]) => Array.from(new Set(values)) },
    '@/lib/provider/volcengine-ip': { VOLCENGINE_IP_VIDEO_PROVIDER: 'volcengine_ark' },
    '@/lib/provider/reference-media-policy': { seedanceReferenceMediaCapabilities: () => ({ imageLimit: 9, videoLimit: 3, audioLimit: 3 }) },
  };
  const scope: Scope = { exports: {}, console, require: (name: string) => { assert.ok(name in modules, `unexpected route dependency: ${name}`); return modules[name]; } };
  runInNewContext(ts.transpileModule(routeSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, scope);
  const request = { headers: { get: () => 'fixture-tab' }, json: async () => ({ surface: 'normal' }) };
  const run = () => scope.exports.POST(request, { params: { id: draft.task_id } });

  task.reference_image_urls = JSON.stringify(['https://fixture.invalid/private-unavailable-image']);
  let result = await run();
  assert.equal(result.status, 409); assert.equal(result.body.code, 'REUSE_ASSETS_UNAVAILABLE');
  assert.deepEqual(clone(result.body.draft), { ...draft, video_card: draft.video_card });
  assert.equal(state.transactions, 0); assert.equal(state.workspaceCreates, 0); assert.equal(state.deletes, 0); assert.equal(state.adds, 0);
  assert.equal(JSON.stringify(result.body).includes('private-unavailable-image'), false, 'no inaccessible media URL leaks in partial response');

  state.denied = true; result = await run(); assert.equal(result.status, 403); assert.equal(result.body.draft, undefined);
  state.denied = false; state.missing = true; result = await run(); assert.equal(result.status, 404); assert.equal(result.body.draft, undefined);
  state.missing = false; state.session = false; result = await run(); assert.equal(result.status, 401); assert.equal(result.body.draft, undefined);
  state.session = true; task.provider = 'volcengine_ark'; result = await run(); assert.equal(result.status, 409); assert.equal(result.body.draft.task_id, undefined);
  assert.equal(state.transactions, 0); assert.equal(state.workspaceCreates, 0);

  task.provider = draft.provider; task.reference_image_urls = null; result = await run();
  assert.equal(result.status, 200); assert.equal(result.body.restored_references, 0); assert.equal(result.body.draft.prompt, draft.prompt);
  assert.equal(result.body.draft.video_branch_id, draft.video_branch_id);
  assert.equal(state.transactions, 1); assert.equal(state.workspaceCreates, 1); assert.equal(state.deletes, 1); assert.equal(state.adds, 0);
  // Every mocked mutation is an existing workspace operation. An added task,
  // ledger or provider call would be an unavailable dependency and fail here.
}

async function run() {
  await checkPage(); await checkRoute();
  console.log('Task reuse actual callback/composer/API offline contracts passed. No browser acceptance claimed.');
}
void run().catch(error => { console.error(error); process.exitCode = 1; });
