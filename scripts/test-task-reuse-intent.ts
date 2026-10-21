import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { taskReuseHref, taskReuseReturnTo, authorizeTaskReuseHref } from '../src/lib/navigation/task-reuse';
import {
  taskReuseAutoAction,
  taskReuseContextMatches,
  shouldConsumeTaskReuseQuery,
  taskReuseReceiptKey,
  readTaskReuseTabId,
  transitionTaskReuseQuery,
  validTaskReuseNavigationIntent,
  taskReuseNavigationTarget,
  taskReuseReasonMessage,
  claimTaskReuseNavigationIntent,
  captureTaskReuseScope,
  type TaskReuseContext,
  type TaskReuseIntent,
} from '../src/lib/navigation/task-reuse-intent';

const ready: TaskReuseContext = {
  accountId: 'fixture-owner', workspaceBridgeKey: 'fixture-owner:standard', tabId: 'fixture-tab',
  projectId: 'fixture-project', videoCardId: 'fixture-card', videoBranchId: 'fixture-branch',
  editEpoch: 0, initializing: false, conflict: null, busy: false,
};
const waiting: TaskReuseIntent = {
  taskId: 'fixture-task', accountId: 'fixture-owner', fromUrl: true, phase: 'waiting', editEpoch: 0,
};

// One explicit click waits for reads, then applies without another confirmation.
for (let read = 0; read < 5; read += 1) {
  assert.equal(taskReuseAutoAction(waiting, { ...ready, initializing: true, busy: true }), 'wait');
}
assert.equal(taskReuseAutoAction(waiting, ready), 'apply');
for (const reason of ['uploading', 'pending-attach', 'saving', 'upload-failed', 'read-error', 'agent-running', 'picker-open'] as const) {
  assert.equal(taskReuseAutoAction(waiting, { ...ready, reason, busy: true }), 'wait', reason);
  assert.ok(taskReuseReasonMessage(reason));
}
assert.equal(taskReuseAutoAction({ ...waiting, expiresAt: 100 }, ready, 100), 'block');
assert.equal(taskReuseAutoAction({ ...waiting, context: ready }, { ...ready, projectId: 'another-project' }), 'block');
const initializingScope = captureTaskReuseScope({ ...ready, initializing: true });
assert.equal(taskReuseAutoAction({ ...waiting, context: initializingScope }, { ...ready, tabId: 'another-tab' }), 'block');
assert.equal(taskReuseAutoAction({ ...waiting, context: initializingScope }, { ...ready, projectId: 'loaded-project' }), 'apply', 'system initialization may finish its target before the first write');
for (const phase of ['blocked', 'confirming', 'sending', 'applying', 'failed', 'unknown', 'done'] as const) {
  assert.equal(taskReuseAutoAction({ ...waiting, phase }, ready), 'none', phase);
}
assert.equal(taskReuseAutoAction(waiting, { ...ready, conflict: '正在上传', busy: true }), 'block');
assert.equal(taskReuseAutoAction(waiting, { ...ready, editEpoch: 1 }), 'block', 'edits during initial reads are protected');
assert.equal(taskReuseAutoAction(waiting, { ...ready, accountId: 'fixture-other' }), 'none');
assert.equal(taskReuseAutoAction(waiting, { ...ready, tabId: '' }), 'block');
assert.equal(readTaskReuseTabId(() => 'fixture-tab'), 'fixture-tab');
assert.equal(readTaskReuseTabId(() => null), 'default', 'a readable missing value keeps the existing fallback');
assert.equal(readTaskReuseTabId(() => { throw new Error('storage denied'); }), null, 'unreadable storage is explicit, never the default tab');

assert.equal(taskReuseContextMatches(ready, { ...ready }), true);
for (const changed of [
  { accountId: 'fixture-other' }, { workspaceBridgeKey: 'fixture-other:standard' }, { tabId: 'fixture-other-tab' },
  { projectId: 'fixture-other-project' }, { videoCardId: 'fixture-other-card' }, { videoBranchId: 'fixture-other-branch' },
  { tabId: '' }, { editEpoch: 1 }, { busy: true }, { initializing: true }, { conflict: '正在保存' },
]) assert.equal(taskReuseContextMatches(ready, { ...ready, ...changed }), false);
assert.equal(taskReuseContextMatches(ready, { ...ready, editEpoch: 2 }), false, 'switch away and back still invalidates old confirmation');
for (const outcome of ['waiting', 'failed', 'unknown'] as const) assert.equal(shouldConsumeTaskReuseQuery(outcome), false);
for (const outcome of ['applied', 'cancelled', 'unrecoverable'] as const) assert.equal(shouldConsumeTaskReuseQuery(outcome), true);
const receipt = taskReuseReceiptKey('fixture-owner', 'fixture-tab', 'fixture-task');
assert.notEqual(receipt, taskReuseReceiptKey('fixture-other', 'fixture-tab', 'fixture-task'));
assert.notEqual(receipt, taskReuseReceiptKey('fixture-owner', 'fixture-other-tab', 'fixture-task'));
assert.notEqual(receipt, taskReuseReceiptKey('fixture-owner', 'fixture-tab', 'fixture-other-task'));
const source = new URL('https://fixture.invalid/generate?reuse_task_id=fixture-task&project_id=fixture-project&return_to=%2Ftasks');
source.searchParams.set('reuse_intent', 'fixture-token');
const explicit = { token: 'fixture-token', taskId: 'fixture-task', accountId: 'fixture-owner', tabId: 'fixture-tab',
  target: taskReuseNavigationTarget(source), expiresAt: 1010 };
assert.equal(validTaskReuseNavigationIntent(explicit, source, 'fixture-owner', 'fixture-tab', 1000), true);
assert.equal(validTaskReuseNavigationIntent(explicit, source, 'fixture-other', 'fixture-tab', 1000), false);
assert.equal(validTaskReuseNavigationIntent(explicit, source, 'fixture-owner', 'other-tab', 1000), false);
assert.equal(validTaskReuseNavigationIntent(explicit, source, 'fixture-owner', 'fixture-tab', 1010), false);
const changedTarget = new URL(source); changedTarget.pathname = '/generate/ip';
assert.equal(validTaskReuseNavigationIntent(explicit, changedTarget, 'fixture-owner', 'fixture-tab', 1000), false);
assert.equal(transitionTaskReuseQuery(source, 'fixture-task', 'unconfirmed'), true);
assert.equal(source.searchParams.has('reuse_intent'), false);
assert.equal(source.searchParams.get('reuse_task_id'), null, 'the old client has no executable reuse source');
assert.equal(source.searchParams.get('reuse_unconfirmed_task_id'), 'fixture-task');
assert.equal(source.searchParams.get('project_id'), 'fixture-project');
assert.equal(source.searchParams.get('return_to'), '/tasks');
assert.equal(transitionTaskReuseQuery(source, 'fixture-task', 'retryable'), true);
assert.equal(source.searchParams.get('reuse_task_id'), 'fixture-task');
assert.equal(source.searchParams.get('reuse_unconfirmed_task_id'), null);
assert.equal(transitionTaskReuseQuery(source, 'fixture-task', 'consumed'), true);
assert.equal(source.searchParams.get('reuse_task_id'), null);
const newer = new URL('https://fixture.invalid/generate?reuse_task_id=fixture-newer&reuse_unconfirmed_task_id=fixture-task&project_id=fixture-newer-project');
const newerBefore = newer.href;
assert.equal(transitionTaskReuseQuery(newer, 'fixture-task', 'retryable'), false);
assert.equal(newer.href, newerBefore, 'a definite late rejection cannot overwrite the newer source');
assert.equal(transitionTaskReuseQuery(newer, 'fixture-task', 'consumed'), true);
assert.equal(newer.searchParams.get('reuse_task_id'), 'fixture-newer');
assert.equal(newer.searchParams.get('project_id'), 'fixture-newer-project');

const normalHref = taskReuseHref({ id: 'real-task', provider: 'seedance', generationMode: 'all_in_one_reference', projectId: 'project' }, '/assets?view=history&content=video_task%3Aold');
assert.ok(normalHref?.startsWith('/generate?'));
assert.equal(new URL(normalHref!, 'https://fixture.invalid').searchParams.get('return_to'), '/assets?view=history');
assert.ok(taskReuseHref({ id: 'real-task', provider: 'volcengine_ark', generationMode: 'first_last_frame' }, '/assets')?.startsWith('/generate/ip?'));
assert.equal(taskReuseHref({ id: 'real-task', provider: 'volcengine_mediakit', generationMode: 'enhance_video' }, '/assets'), null);
assert.equal(taskReuseHref({ id: 'image-task', provider: 'seedance', generationMode: 'image' }, '/assets'), null);
assert.equal(taskReuseHref({ provider: 'seedance', generationMode: 'first_last_frame' }, '/assets'), null);
assert.equal(taskReuseReturnTo('//outside.invalid/assets'), null);
assert.equal(taskReuseReturnTo('/assets?view=favorites&content=private-item'), '/assets?view=favorites');

const storage = new Map<string, string>();
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { origin: 'https://fixture.invalid' } } });
Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
  getItem: (key: string) => storage.get(key) || null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key),
} });
try {
  const href = authorizeTaskReuseHref(normalHref!, 'fixture-owner');
  assert.ok(href);
  const url = new URL(href!, 'https://fixture.invalid');
  assert.ok(url.searchParams.get('reuse_intent'));
  assert.equal(claimTaskReuseNavigationIntent(url, 'fixture-owner', 'default'), true);
  assert.equal(claimTaskReuseNavigationIntent(url, 'fixture-owner', 'default'), false, 'a consumed URL is not replayable after refresh');
  assert.equal(authorizeTaskReuseHref('https://outside.invalid/generate?reuse_task_id=task', 'fixture-owner'), null);
} finally {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window');
  if (originalStorage) Object.defineProperty(globalThis, 'sessionStorage', originalStorage); else Reflect.deleteProperty(globalThis, 'sessionStorage');
  if (originalCrypto) Object.defineProperty(globalThis, 'crypto', originalCrypto); else Reflect.deleteProperty(globalThis, 'crypto');
}

console.log('Task reuse intent offline contracts passed. Browser behavior remains for user acceptance.');
