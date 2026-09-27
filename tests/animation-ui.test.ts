import assert from 'node:assert/strict';
import test from 'node:test';
import type { AnimationPose, AnimationSequence } from '../src/lib/animation/types';
import {
  advanceDocumentRequestContext, animationWorkbenchHref, assignPoseToEntry, canChangeGlobalScale, canExportValidated, canSaveAtRevision, clearMutationIfCurrent, documentRequestStateValue, entryIndexAtTick,
  isPoseAdapted, resolvePixelLogicalGeometry, resolveReferenceGeometry, reviewCapabilities, setEntryLocked, stableMutationId, timingSummary, totalTicks, updateGlobalScale, updateSequenceEntry,
  runIfDocumentRequestCurrent,
  sanitizeAnimationWorkbenchReturnTo,
} from '../src/components/animation/model';

function makePose(id: string, fileId = `${id}.png`): AnimationPose {
  return {
    id,
    file_id: fileId,
    label: id,
    width: 128,
    height: 128,
    logical_width: 32,
    logical_height: 32,
    pixels_per_unit: 4,
    source: { note: 'test source' },
  };
}

function makeSequence(): AnimationSequence {
  const pose = makePose('shared-pose');
  return {
    schema_version: 1,
    title: 'test sequence',
    preview_fps: 24,
    tick_rate: null,
    tick_rate_verified: false,
    global_scale: 1,
    poses: [pose],
    entries: [
      { id: 'entry-a', action: 'walk', pose_id: pose.id, reference_file_id: 'original-a.png', reference_geometry: { logical_width: 64, logical_height: 64, pixels_per_unit: 1, source: 'manifest.json#/frames/0' }, hold_ticks: 7, original_hold_ticks: 7, locked: false, translate_x: 0, translate_y: 0 },
      { id: 'entry-b', action: 'walk', pose_id: pose.id, reference_file_id: 'original-b.png', reference_geometry: { logical_width: 64, logical_height: 64, pixels_per_unit: 1, source: 'manifest.json#/frames/1' }, hold_ticks: 5, original_hold_ticks: 5, locked: true, translate_x: 0, translate_y: 0 },
    ],
    notes: '',
    user_accepted_for_retention: false,
    historical_review: '',
  };
}

test('工作台入口保留项目/文档上下文，并将返回地址限制在项目页或资产页', () => {
  const assetHref = animationWorkbenchHref({
    projectId: 'project-1',
    returnTo: '/assets?scope=project&project_id=project-1&type=video',
  });
  const assetUrl = new URL(assetHref, 'https://sd2.local');
  assert.equal(assetUrl.pathname, '/tools/animation-workbench');
  assert.equal(assetUrl.searchParams.get('project_id'), 'project-1');
  assert.equal(assetUrl.searchParams.get('return_to'), '/assets?scope=project&project_id=project-1&type=video');

  const documentUrl = new URL(animationWorkbenchHref({
    documentId: 'document-1',
    projectId: 'project-2',
    returnTo: '/projects/project-2',
  }), 'https://sd2.local');
  assert.equal(documentUrl.searchParams.get('document_id'), 'document-1');
  assert.equal(documentUrl.searchParams.get('project_id'), 'project-2');
  assert.equal(documentUrl.searchParams.get('return_to'), '/projects/project-2');
  assert.equal(sanitizeAnimationWorkbenchReturnTo('//evil.example/path'), null);
  assert.equal(sanitizeAnimationWorkbenchReturnTo('https://evil.example/projects/project-2'), null);
  assert.equal(sanitizeAnimationWorkbenchReturnTo('/admin'), null);
  assert.equal(sanitizeAnimationWorkbenchReturnTo('/projects/project-2/video-cards/card-1'), null);
  assert.equal(animationWorkbenchHref({ returnTo: 'https://evil.example/' }).includes('return_to='), false);
});

test('迟到的文档响应在 A→列表→B→A 后不能覆盖新一代 A', async () => {
  let active = { documentId: '', epoch: 0 };
  const firstA = advanceDocumentRequestContext(active, 'A');
  active = firstA;
  let release!: (value: string) => void;
  const delayedResponse = new Promise<string>(resolve => { release = resolve; });
  const visibleTitles: string[] = [];
  const applyDelayedResponse = delayedResponse.then(title => runIfDocumentRequestCurrent(firstA, active, () => visibleTitles.push(title)));

  active = advanceDocumentRequestContext(active, '');
  active = advanceDocumentRequestContext(active, 'B');
  assert.equal(runIfDocumentRequestCurrent(firstA, active, () => 'Race A'), undefined);
  active = advanceDocumentRequestContext(active, 'A');
  const queuedReactUpdate = (previous: string) => documentRequestStateValue(firstA, active, previous, 'Race A');
  release('Race A');

  assert.equal(await applyDelayedResponse, undefined);
  assert.deepEqual(visibleTitles, []);
  assert.equal(queuedReactUpdate('Record B'), 'Record B');
});

test('旧请求的错误、finally 和草稿清理不会影响当前文档代次', async () => {
  let active = { documentId: 'A', epoch: 1 };
  const request = active;
  const draftByDocument = new Map([['A', 'new A draft'], ['B', 'B draft']]);
  const visibleErrors: string[] = [];
  let busy = true;
  const delayedFailure = Promise.reject(new Error('旧请求失败')).catch(error => {
    runIfDocumentRequestCurrent(request, active, () => visibleErrors.push((error as Error).message));
  }).finally(() => {
    runIfDocumentRequestCurrent(request, active, () => { busy = false; });
  });

  active = advanceDocumentRequestContext(active, 'B');
  active = advanceDocumentRequestContext(active, 'A');
  runIfDocumentRequestCurrent(request, active, () => draftByDocument.delete(request.documentId));
  await delayedFailure;

  assert.deepEqual(visibleErrors, []);
  assert.equal(busy, true);
  assert.equal(draftByDocument.get('A'), 'new A draft');
  assert.equal(draftByDocument.get('B'), 'B draft');
});

// Browser replay (main controller only): with the frozen R5 app, run
// node /tmp/sd2-animation-acceptance-ff5Gys/race-check.cjs to hold A's PATCH, return to the list,
// open B, and release A. Final acceptance uses EXPECT_FIXED=1 node <same harness>; URL,
// heading/editor, status and user/document-scoped drafts must remain on B. Do not run in this task.

test('导入的 hold 不能偏离原始 ticks，pose 替换不继承候选时值', () => {
  const sequence = makeSequence();
  const withPose = assignPoseToEntry(sequence, 'entry-a', makePose('candidate-pose'));
  assert.equal(withPose.entries[0].hold_ticks, 7);
  assert.equal(withPose.entries[0].original_hold_ticks, 7);
  assert.throws(() => updateSequenceEntry(sequence, 'entry-a', { hold_ticks: 8 } as never), /hold 只读/);
  const unchangedHold = updateSequenceEntry(sequence, 'entry-a', { hold_ticks: 7 } as never);
  assert.equal(unchangedHold.entries[0].hold_ticks, 7);
});

test('锁帧条目拒绝平移、动作或 pose 修改', () => {
  const sequence = makeSequence();
  assert.throws(() => updateSequenceEntry(sequence, 'entry-b', { translate_x: 3 }), /先解锁/);
  assert.throws(() => assignPoseToEntry(sequence, 'entry-b', makePose('candidate-pose')), /先解锁/);
  const separatelyUnlocked = setEntryLocked(sequence, 'entry-b', false);
  assert.equal(separatelyUnlocked.entries[1].locked, false);
  assert.equal(updateSequenceEntry(separatelyUnlocked, 'entry-b', { translate_x: 3 }).entries[1].translate_x, 3);
});

test('调整共享 pose 的适配信息时派生新 ID，不影响其他引用或锁帧条目', () => {
  const sequence = makeSequence();
  const adapted = { ...sequence.poses[0], logical_width: 16, logical_height: 16, pixels_per_unit: 8 };
  const next = assignPoseToEntry(sequence, 'entry-a', adapted, { createId: () => 'shared-pose-copy' });
  assert.equal(next.entries[0].pose_id, 'shared-pose-copy');
  assert.equal(next.entries[1].pose_id, 'shared-pose');
  assert.equal(next.poses.find(pose => pose.id === 'shared-pose')?.logical_width, 32);
  assert.equal(next.poses.find(pose => pose.id === 'shared-pose-copy')?.logical_width, 16);
  assert.equal(next.entries[0].hold_ticks, 7);
  assert.deepEqual(next.entries[0].reference_geometry, sequence.entries[0].reference_geometry);
});

test('原作几何只接受绑定文件上的来源映射且需与像素尺寸、倍率一致', () => {
  const entry = makeSequence().entries[0];
  assert.deepEqual(resolveReferenceGeometry(entry, { id: 'original-a.png', width: 64, height: 64 }), {
    geometry: { logical_width: 64, logical_height: 64, pixels_per_unit: 1 },
    source: 'manifest.json#/frames/0',
  });
  assert.equal(resolveReferenceGeometry({ ...entry, reference_geometry: undefined }, { id: 'original-a.png', width: 64, height: 64 }), null);
  assert.equal(resolveReferenceGeometry(entry, { id: 'other.png', width: 64, height: 64 }), null);
  assert.equal(resolveReferenceGeometry(entry, { id: 'original-a.png', width: 63, height: 64 }), null);
  assert.equal(resolveReferenceGeometry(entry, { id: 'original-a.png', width: null, height: 64 }), null);
  assert.equal(resolveReferenceGeometry({ ...entry, reference_geometry: { ...entry.reference_geometry!, source: '  ' } }, { id: 'original-a.png', width: 64, height: 64 }), null);
  assert.equal(resolvePixelLogicalGeometry(1024, 512, null), null);
  assert.deepEqual(resolvePixelLogicalGeometry(1024, 512, {
    logical_width: 64, logical_height: 32, pixels_per_unit: 16,
  }), { logical_width: 64, logical_height: 32, pixels_per_unit: 16 });
  assert.equal(resolvePixelLogicalGeometry(1024, 512, {
    logical_width: 64, logical_height: 32, pixels_per_unit: 24,
  }), null);
});

test('导入原作文件和几何映射属于只读基线', () => {
  const sequence = makeSequence();
  assert.throws(() => updateSequenceEntry(sequence, 'entry-a', { reference_file_id: 'replacement.png' } as never), /导入基线/);
  assert.throws(() => updateSequenceEntry(sequence, 'entry-a', { reference_geometry: { ...sequence.entries[0].reference_geometry!, pixels_per_unit: 2 } } as never), /导入基线/);
});

test('全段缩放会影响所有条目，存在锁帧时必须先解锁', () => {
  const sequence = makeSequence();
  assert.equal(canChangeGlobalScale(sequence), false);
  assert.throws(() => updateGlobalScale(sequence, 1.5), /先解锁/);
  const unlocked = { ...sequence, entries: sequence.entries.map(entry => ({ ...entry, locked: false })) };
  assert.equal(canChangeGlobalScale(unlocked), true);
  assert.equal(updateGlobalScale(unlocked, 1.5).global_scale, 1.5);
});

test('时间表按 ticks 播放；未知 tick 率不显示秒数，登记值不冒充游戏验证', () => {
  const sequence = makeSequence();
  assert.equal(totalTicks(sequence.entries), 12);
  assert.equal(entryIndexAtTick(sequence.entries, 7), 1);
  const unknown = timingSummary(sequence);
  assert.match(unknown, /12 ticks/);
  assert.match(unknown, /游戏 tick 未验证/);
  assert.match(unknown, /不显示真实秒数/);
  assert.doesNotMatch(unknown, /\d+(?:\.\d+)?\s*秒/);
  assert.equal(canExportValidated(sequence), false);

  const recorded = { ...sequence, tick_rate: 30, tick_rate_verified: true };
  const summary = timingSummary(recorded);
  assert.match(summary, /按已登记 tick 率计算/);
  assert.match(summary, /游戏仍未验证/);
  assert.equal(canExportValidated(recorded), true);
});

test('修订冲突时不允许以旧 base_revision 保存', () => {
  assert.equal(canSaveAtRevision(4, 4), true);
  assert.equal(canSaveAtRevision(4, 5), false);
});

test('同一 mutation 重试复用请求 ID，payload 改变换新 ID且旧完成不清除新操作', () => {
  const pending = new Map<string, { payload: string; mutationId: string }>();
  let nextId = 0;
  const createId = () => `mutation-${++nextId}`;
  const first = stableMutationId(pending, 'document:status', '{"status":"archived"}', createId);
  const retry = stableMutationId(pending, 'document:status', '{"status":"archived"}', createId);
  assert.equal(retry, first);
  const changed = stableMutationId(pending, 'document:status', '{"status":"active"}', createId);
  assert.notEqual(changed, first);
  clearMutationIfCurrent(pending, 'document:status', first);
  assert.equal(pending.get('document:status')?.mutationId, changed);
  clearMutationIfCurrent(pending, 'document:status', changed);
  assert.equal(pending.has('document:status'), false);

  const saveA = stableMutationId(pending, 'save:document-A', '{"sequence":"old"}', createId);
  const saveB = stableMutationId(pending, 'save:document-B', '{"sequence":"old"}', createId);
  const newerSaveA = stableMutationId(pending, 'save:document-A', '{"sequence":"new"}', createId);
  assert.notEqual(saveA, saveB);
  assert.notEqual(newerSaveA, saveA);
  clearMutationIfCurrent(pending, 'save:document-A', saveA);
  assert.equal(pending.get('save:document-A')?.mutationId, newerSaveA);
});

test('审核权限区分提交待审与登记处理结果、游戏状态', () => {
  assert.deepEqual(reviewCapabilities(true, false), {
    canSubmitPending: true, canRecordOutcome: false, canRecordGameStatus: false, canSubmit: true,
  });
  assert.deepEqual(reviewCapabilities(false, true), {
    canSubmitPending: false, canRecordOutcome: true, canRecordGameStatus: true, canSubmit: true,
  });
});

test('pose 缺少逻辑画布或像素倍率时不能用于当前条目', () => {
  assert.equal(isPoseAdapted({ ...makePose('unadapted'), logical_width: null }), false);
  assert.throws(() => assignPoseToEntry(makeSequence(), 'entry-a', { ...makePose('unadapted'), pixels_per_unit: null }), /逻辑画布/);
  assert.equal(isPoseAdapted({ ...makePose('inconsistent'), logical_width: 64, pixels_per_unit: 4 }), false);
});
