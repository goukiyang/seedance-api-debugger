import assert from 'node:assert/strict';
import { currentMultiviewFrameSettings, applyMultiviewFrameSettings } from '../src/app/multiview/multiview-frame-settings-client';
import type { MultiviewDraft, MultiviewInfo } from '../src/lib/video/multiview-contract';

const info: MultiviewInfo = { taskId: 'private-task', sourceVersion: 'source-a', width: 640, height: 640,
  duration: 4, timestamps: Array.from({ length: 97 }, (_, i) => i / 24) };
const draft: MultiviewDraft = { schema: 1, sourceVersion: info.sourceVersion,
  slots: [0, 12, 24, 36].map((frame, index) => ({ id: 'slot-' + index, frame, name: '方向' + index, manual: true })),
  reserve: [{ id: 'hidden-slot', frame: 48, name: '保留', manual: true }],
  layout: { columns: 4, margin: 12, gap: 12, background: '#aabbcc' }, editing: 'slot-1', editorFrame: 12 };
const original = JSON.stringify(draft);
const saved = currentMultiviewFrameSettings(draft);
assert.ok(saved);
assert.deepEqual(Object.keys(saved).sort(), ['schema', 'slots']);
assert.ok(!JSON.stringify(saved).includes('private-task') && !JSON.stringify(saved).includes('source-a'));
const next = applyMultiviewFrameSettings(draft, info, { schema: 1, slots: [
  { frame: 40, name: '后' }, { frame: 0, name: '前' }, { frame: 20, name: '侧' },
] });
assert.ok(next);
assert.deepEqual(next.slots.map(item => [item.frame, item.name]), [[40, '后'], [0, '前'], [20, '侧']]);
assert.deepEqual(next.slots.map(item => item.id), ['slot-0', 'slot-1', 'slot-2']);
assert.equal(next.layout, draft.layout); assert.equal(next.reserve, draft.reserve);
assert.equal(next.editing, null); assert.equal(next.editorFrame, undefined);
assert.equal(JSON.stringify(draft), original);
assert.equal(applyMultiviewFrameSettings(draft, { ...info, sourceVersion: 'source-b' }, saved), null);
assert.equal(applyMultiviewFrameSettings(draft, info, { schema: 1, slots: saved.slots.map(item => ({ ...item, frame: 97 })) }), null);
assert.equal(applyMultiviewFrameSettings(draft, info, { ...saved, taskId: 'injected' }), null);
assert.equal(applyMultiviewFrameSettings(draft, info, { schema: 1, slots: [
  ...saved.slots, { frame: 49, name: '5' }, { frame: 50, name: '6' }, { frame: 51, name: '7' }, { frame: 52, name: '8' },
] }, () => 'hidden-slot'), null);
console.log(JSON.stringify({ schema: 'multiview-frame-settings-client-engineering.v1', completed: true,
  checks: ['no-media-identities', 'exact-frames-order-and-names', 'layout-and-reserve-preserved', 'input-immutable',
    'source-version-reject', 'out-of-range-reject', 'extra-field-reject', 'identity-collision-reject'],
  productionWrites: 0, generationCalls: 0, billingChanges: 0 }));
