import assert from 'node:assert/strict';
import { IMAGE_GENERATION_WAIT_GRACE_MS, advanceImageGenerationWaitDisplay, imageGenerationDisplayProgress, imageGenerationWaitDisplay, type ImageGenerationWait } from '../src/lib/image-studio/wait-display';
import { studioGenerationDetailSuperseded } from '../src/lib/image-studio/delivery-display';

// Offline display contracts only. These assertions never submit/query a task.
const acceptedAt = 1_000_000;
const accepted: ImageGenerationWait = { status: 'running', phase: 'provider', waitingStatus: 'pending',
  label: '生成中', acceptedAt, createdAt: acceptedAt - 10_000, recoveryAvailable: true };
const at = (elapsed: number, changes: Partial<ImageGenerationWait> = {}, online = true) =>
  imageGenerationWaitDisplay({ ...accepted, ...changes }, acceptedAt + elapsed, online);
const waitingStates = ['pending', 'retrying', 'unconfirmed'];
waitingStates.forEach(waitingStatus => {
  [0, 299_999].forEach(elapsed => {
    [true, false].forEach(online => {
      const display = at(elapsed, { waitingStatus, detail: '原状态暂未更新', connectionIssue: !online }, online);
      assert.equal(display.label, '正在生成'); assert.equal(display.showTrack, true);
      assert.equal(display.showIssue, false); assert.equal(display.showRecovery, false);
      assert.equal(display.detail, undefined); assert.equal(display.nextCheckAt, acceptedAt + IMAGE_GENERATION_WAIT_GRACE_MS);
    });
  });
  const boundary = at(300_000, { waitingStatus, detail: '原状态暂未更新' });
  assert.equal(boundary.showTrack, waitingStatus === 'pending');
  assert.equal(boundary.showIssue, waitingStatus !== 'pending');
  assert.equal(boundary.showRecovery, waitingStatus !== 'pending');
  assert.equal(boundary.nextCheckAt, undefined);
});
['retrying', 'unconfirmed'].forEach(status => {
  assert.equal(at(299_999, { status }).showTrack, true);
  assert.equal(at(300_000, { status }).showIssue, true);
});
assert.equal(at(900_000).label, '正在生成', 'five minutes is not a failure deadline');
const offline = at(300_000, {}, false);
assert.equal(offline.showTrack, false); assert.equal(offline.showRecovery, true); assert.match(offline.detail || '', /网络连接/);
const unread = at(300_000, { connectionIssue: true, connectionDetail: '原列表读取失败' });
assert.equal(unread.detail, '原列表读取失败');
const reconnected = at(300_001, { waitingStatus: 'pending', detail: '旧的重连提示' });
assert.equal(reconnected.showIssue, false); assert.equal(reconnected.showRecovery, false); assert.equal(reconnected.showTrack, true);
assert.equal(at(299_999, { phase: 'unknown', waitingStatus: 'unconfirmed' }).showTrack, true);
assert.equal(at(300_000, { phase: 'unknown', waitingStatus: 'unconfirmed' }).showIssue, true);

['succeeded', 'success', 'failed', 'failure', 'cancelled', 'canceled', 'uncertain'].forEach(status => {
  const terminal = at(0, { status, label: `真实${status}`, detail: '终态说明', recoveryAvailable: false });
  assert.equal(terminal.label, `真实${status}`); assert.equal(terminal.showTrack, false);
  assert.equal(terminal.busy, false); assert.equal(terminal.showIssue, true); assert.equal(terminal.nextCheckAt, undefined);
});
['ready', 'failed', 'stopped'].forEach(phase => assert.equal(at(0, { phase }).showTrack, false));
['download', 'validate', 'save'].forEach(phase => {
  const checkpoint = { phase }, receipt = { state: 'success', waitingStatus: 'pending' };
  assert.equal(studioGenerationDetailSuperseded('running', checkpoint, receipt), true);
  assert.equal(studioGenerationDetailSuperseded('channel_running', checkpoint, receipt), true);
  assert.equal(studioGenerationDetailSuperseded('running', { ...checkpoint, code: 'download_failed' }, receipt), false);
  assert.equal(studioGenerationDetailSuperseded('running', checkpoint, { ...receipt, state: 'accepted' }), false);
  assert.equal(studioGenerationDetailSuperseded('running', checkpoint, { ...receipt, waitingStatus: 'retrying' }), false);
  const delivery = at(0, { phase, detail: '图片任务已受理，仍在生成', generationDetailSuperseded: true });
  assert.equal(delivery.showIssue, false); assert.equal(delivery.showRecovery, false); assert.equal(delivery.detail, undefined);
  const disconnected = at(0, { phase, detail: '旧生成提示', generationDetailSuperseded: true }, false);
  assert.equal(disconnected.showIssue, true); assert.equal(disconnected.showRecovery, true); assert.match(disconnected.detail || '', /网络连接/);
  const unreadDelivery = at(0, { phase, detail: '旧生成提示', generationDetailSuperseded: true, connectionIssue: true, connectionDetail: '本次读取无权限' });
  assert.equal(unreadDelivery.detail, '本次读取无权限'); assert.equal(unreadDelivery.showRecovery, true);
});
assert.equal(studioGenerationDetailSuperseded('running', null, { state: 'success', waitingStatus: 'pending' }), false);
assert.equal(studioGenerationDetailSuperseded('running', { phase: 'save' }, null), false);
['failed', 'uncertain', 'succeeded'].forEach(status => assert.equal(studioGenerationDetailSuperseded(status, { phase: 'save' }, { state: 'success', waitingStatus: 'pending' }), false));
['recover', 'stopped', 'provider'].forEach(phase => assert.equal(studioGenerationDetailSuperseded('running', { phase }, { state: 'success', waitingStatus: 'pending' }), false));
const recovery = at(0, { phase: 'recover', detail: '真实下载异常', generationDetailSuperseded: true });
assert.equal(recovery.detail, '真实下载异常'); assert.equal(recovery.showRecovery, true);
['download', 'recover', 'validate', 'save', 'settle'].forEach(phase => {
  const delivery = at(0, { phase, label: `真实${phase}`, detail: '交付阶段说明' });
  assert.equal(delivery.label, `真实${phase}`); assert.equal(delivery.showTrack, true);
  assert.equal(delivery.showIssue, true); assert.equal(delivery.showRecovery, true); assert.equal(delivery.busy, true);
});
['queued', 'channel_queued', 'needs-confirmation'].forEach(status => {
  const queued = at(0, { status, phase: 'queued', acceptedAt: undefined, label: '等待派发' });
  assert.equal(queued.label, '等待派发'); assert.equal(queued.showTrack, false); assert.equal(queued.nextCheckAt, undefined);
});
assert.equal(at(0, { status: 'pending', phase: undefined, acceptedAt: undefined, label: '等待派发' }).showTrack, false);

const fallback = imageGenerationWaitDisplay({ ...accepted, acceptedAt: undefined, createdAt: new Date(acceptedAt).toISOString(),
  label: '生成中', waitingStatus: 'retrying' }, acceptedAt + 299_999);
assert.equal(fallback.timeSource, 'createdAt'); assert.equal(fallback.label, '生成中'); assert.equal(fallback.showIssue, false);
assert.equal(imageGenerationWaitDisplay({ ...accepted, acceptedAt: undefined, createdAt: acceptedAt, waitingStatus: 'retrying' }, acceptedAt + 300_000).showIssue, true);
const noTime = imageGenerationWaitDisplay({ ...accepted, acceptedAt: NaN, createdAt: 'not-a-date' }, acceptedAt);
assert.equal(noTime.label, '状态待确认'); assert.equal(noTime.showTrack, false); assert.equal(noTime.showRecovery, true); assert.equal(noTime.nextCheckAt, undefined);
assert.equal(imageGenerationWaitDisplay({ ...accepted, acceptedAt: acceptedAt + 1, createdAt: undefined }, acceptedAt).showTrack, false, 'a future timestamp is not a new local origin');
const original = Object.freeze({ ...accepted, waitingStatus: 'retrying' });
const beforeRemount = imageGenerationWaitDisplay(original, acceptedAt + 299_999);
const afterRemount = imageGenerationWaitDisplay({ ...original }, acceptedAt + 300_000);
assert.equal(beforeRemount.showIssue, false); assert.equal(afterRemount.showIssue, true); assert.equal(original.acceptedAt, acceptedAt);
const batch = [{ ...accepted, acceptedAt, waitingStatus: 'retrying' }, { ...accepted, acceptedAt: acceptedAt + 1, waitingStatus: 'unconfirmed' }]
  .map(item => imageGenerationWaitDisplay(item, acceptedAt + 300_000));
assert.equal(batch[0].showRecovery, true); assert.equal(batch[1].showRecovery, false, 'each accepted task has its own boundary');
assert.equal(imageGenerationWaitDisplay({ status: 'running', phase: 'provider', waitingStatus: 'pending', label: '生成中' }, acceptedAt).showRecovery, true,
  'a batch item without original time must be re-read, not timed from batch creation');

const curveTimes = [0, 1_000, 60_000, 299_999, 300_000, 600_000, 900_000, 3_600_000];
const curve = curveTimes.map(elapsed => imageGenerationDisplayProgress(accepted, acceptedAt + elapsed));
curve.forEach((progress, index) => { assert.ok(progress >= (curve[index - 1] ?? 0)); assert.ok(progress < 100); });
assert.ok(curve[5] > 95, 'the curve continues beyond the old 95 percent stop');
assert.equal(imageGenerationDisplayProgress({ ...accepted, acceptedAt: undefined, createdAt: undefined }, acceptedAt), 8);
assert.equal(imageGenerationDisplayProgress({ ...accepted, progress: 42 }, acceptedAt + 900_000), 42, 'measured progress takes precedence');
assert.equal(imageGenerationDisplayProgress({ ...accepted, progress: 100 }, acceptedAt), 99.9, 'received bytes alone cannot declare delivery ready');
assert.equal(imageGenerationDisplayProgress(accepted, acceptedAt + 300_000), imageGenerationDisplayProgress({ ...accepted }, acceptedAt + 300_000), 'refresh uses the same original curve');
const ready = at(0, { status: 'succeeded', phase: 'ready', resultReady: true, label: '已完成', detail: '旧查询红字' });
assert.equal(ready.progress, 100); assert.equal(ready.showIssue, false); assert.equal(ready.showRecovery, false); assert.equal(ready.detail, undefined);
const missing = at(0, { status: 'succeeded', phase: 'ready', resultReady: false, detail: '原图不可用' });
assert.equal(missing.progress, undefined); assert.equal(missing.showIssue, true);
assert.equal(at(0, { status: 'failed', resultReady: true }).progress, undefined, 'failure always exits without 100');
const pendingMemory = advanceImageGenerationWaitDisplay(at(1_000), undefined, 'original-task', acceptedAt + 1_000);
const finishing = advanceImageGenerationWaitDisplay(ready, pendingMemory.memory, 'original-task', acceptedAt + 2_000);
assert.equal(finishing.display.finishing, true); assert.ok(finishing.display.progress! < 100);
const full = advanceImageGenerationWaitDisplay(ready, finishing.memory, 'original-task', acceptedAt + 2_300);
assert.equal(full.display.progress, 100); assert.equal(full.display.finishing, true, '100 has its own visible frame before completion');
const completed = advanceImageGenerationWaitDisplay(ready, full.memory, 'original-task', acceptedAt + 2_380);
assert.equal(completed.display.finishing, undefined); assert.equal(completed.display.label, '已完成');
assert.equal(advanceImageGenerationWaitDisplay(ready, completed.memory, 'original-task', acceptedAt + 3_000).display.finishing, undefined, 'ready re-reads do not replay');
assert.equal(advanceImageGenerationWaitDisplay(ready, undefined, 'historical-task', acceptedAt + 3_000).display.finishing, undefined, 'history and remount skip completion animation');
assert.equal(advanceImageGenerationWaitDisplay(ready, pendingMemory.memory, 'original-task', acceptedAt + 2_000, true, true).display.finishing, undefined, 'reduced motion completes directly');
const hidden = advanceImageGenerationWaitDisplay(ready, pendingMemory.memory, 'original-task', acceptedAt + 2_000, false);
assert.equal(hidden.display.finishing, undefined);
assert.equal(advanceImageGenerationWaitDisplay(ready, hidden.memory, 'original-task', acceptedAt + 3_000).display.finishing, undefined, 'hidden completion does not replay on return');
const switched = advanceImageGenerationWaitDisplay(at(0), finishing.memory, 'different-task', acceptedAt);
assert.equal(switched.memory.finishStartedAt, undefined); assert.equal(switched.display.progress, 8);
const nondecreasing = advanceImageGenerationWaitDisplay(at(0), pendingMemory.memory, 'original-task', acceptedAt);
assert.ok(nondecreasing.display.progress! >= pendingMemory.display.progress!, 'a clock/source correction cannot move a mounted bar backwards');
console.log('Image generation wait display offline contracts passed');
