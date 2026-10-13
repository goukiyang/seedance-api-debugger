import assert from 'node:assert/strict';
import {
  taskReuseAutoAction,
  taskReuseContextMatches,
  shouldConsumeTaskReuseQuery,
  taskReuseReceiptKey,
  readTaskReuseTabId,
  transitionTaskReuseQuery,
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

// Repeated initial reads cannot issue a command. A ready page may request one
// confirmation; the next phases require a deliberate user action or a receipt.
for (let read = 0; read < 5; read += 1) {
  assert.equal(taskReuseAutoAction(waiting, { ...ready, initializing: true, busy: true }), 'wait');
}
assert.equal(taskReuseAutoAction(waiting, ready), 'confirm');
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
assert.equal(transitionTaskReuseQuery(source, 'fixture-task', 'unconfirmed'), true);
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

console.log('Task reuse intent offline contracts passed. Browser behavior remains for user acceptance.');
