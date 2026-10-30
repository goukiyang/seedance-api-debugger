import assert from 'node:assert/strict';
import { prepareVideoModeSwitch, finishVideoModeSwitch, readVideoModeSwitch, parseModeInputDraft, videoInputContext, videoInputDraftKey,
  modeSwitchInput, writeVideoInputDraft, retainModeRecoveryDraft, parseTaskReuseClientRecord, type TaskReuseInputBackup, type VideoModelChoice } from '../src/lib/navigation/task-reuse-client';
import { reorderVideoPromptGroupPrefix } from '../src/lib/video/prompt-groups';
import { VOLCENGINE_IP_MODEL_OPTIONS } from '../src/lib/integrations/volcengine-ip-models';

class MemoryStorage {
  data = new Map<string, string>(); failAt = 0; writes = 0;
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { if (++this.writes === this.failAt) throw new Error('quota'); this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
}
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const refs = [1, 2, 3, 4].map(n => ({ groupId: id(n), versionId: id(n + 20) }));
const source: TaskReuseInputBackup = { version: 1, workspace: { ownerId: 'owner', epoch: 3, tabId: 'tab', workspaceId: 'workspace', items: [
  { assetId: 'asset-1', referenceImageId: 'reference-1', role: 'first_frame', sortOrder: 0 },
  { assetId: 'asset-2', referenceImageId: 'reference-2', role: 'last_frame', sortOrder: 1 },
] }, fields: { prompt: 'personal text', model: 'h3', provider: 'h3', auxiliary: 'lora', videoPromptGroups: refs,
  draftMode: true, generationMode: 'first_last_frame', ratio: '16:9', duration: 8, resolution: '1080p', seed: 17,
  generateAudio: true, returnLastFrame: true, watermark: false, resolutionApprovalConfirmed: false,
  projectId: 'project', videoCardId: 'card', videoBranchId: 'branch' } };
const from = videoInputContext('owner', 'tab', 'normal'), to = videoInputContext('owner', 'tab', 'ip');
const choice: VideoModelChoice = { id: 'ui-only', surface: 'ip', model: VOLCENGINE_IP_MODEL_OPTIONS[0].id, label: 'IP SD2.0', detail: '' };
let checks = 0;
const check = (run: () => void) => { run(); checks++; };
check(() => {
  assert.equal(reorderVideoPromptGroupPrefix(refs, refs.slice(0, 2), [refs[0].groupId, refs[1].groupId]), null);
  assert.deepEqual(reorderVideoPromptGroupPrefix(refs, refs.slice(0, 2), [refs[1].groupId, refs[0].groupId]), [refs[1], refs[0], refs[2], refs[3]]);
  assert.equal(reorderVideoPromptGroupPrefix(refs, refs.slice(0, 2), [refs[1].groupId, refs[1].groupId]), null);
  assert.equal(reorderVideoPromptGroupPrefix([{ ...refs[0], versionId: id(99) }, ...refs.slice(1)], refs.slice(0, 2), [refs[1].groupId, refs[0].groupId]), null);
});
check(() => {
  const ip = modeSwitchInput(source, choice, true);
  assert.equal(ip.fields.model, choice.model); assert.notEqual(ip.fields.model, choice.id);
  assert.deepEqual(ip.workspace, source.workspace); assert.equal(ip.fields.prompt, source.fields.prompt);
  assert.deepEqual(ip.fields.videoPromptGroups, []); assert.equal(ip.fields.draftMode, false); assert.equal(ip.fields.auxiliary, null);
  assert.equal(ip.fields.unapplied?.feishu, true); assert.deepEqual(ip.fields.unapplied?.videoPromptGroups, refs);
  const back = modeSwitchInput({ ...ip, fields: { ...ip.fields, prompt: 'edited in IP', seed: 42 } }, { ...choice, surface: 'normal', model: 'h3' });
  assert.equal(back.fields.prompt, 'edited in IP'); assert.equal(back.fields.seed, 42); assert.deepEqual(back.fields.videoPromptGroups, refs);
  assert.equal(back.fields.draftMode, true); assert.equal(back.fields.auxiliary, 'lora'); assert.equal(back.fields.provider, 'h3');
});
check(() => {
  const storage = new MemoryStorage(), target = { ...source, fields: { ...source.fields, prompt: 'old target', model: choice.model } };
  writeVideoInputDraft(storage, to, target);
  const old = storage.getItem(videoInputDraftKey(to));
  storage.data.set('sd2:task-reuse-backup:v2:unrelated', 'untouched');
  const handoff = prepareVideoModeSwitch(storage, from, 'normal', source, choice, 4, id(40));
  assert.equal(storage.getItem(videoInputDraftKey(to)), old); assert.equal(handoff.previousTarget?.fields.prompt, 'old target');
  assert.equal(readVideoModeSwitch(storage, 'other', 'tab', to, id(40)), null);
  assert.equal(readVideoModeSwitch(storage, 'owner', 'other-tab', to, id(40)), null);
  assert.equal(readVideoModeSwitch(storage, 'owner', 'tab', from, id(40)), null);
  assert.equal(readVideoModeSwitch(storage, 'owner', 'tab', to, id(41)), null);
  assert.throws(() => finishVideoModeSwitch(storage, handoff, source.workspace, 1));
  assert.throws(() => finishVideoModeSwitch(storage, handoff, { ...source.workspace, items: [...source.workspace.items].reverse() }, 0));
  assert.throws(() => finishVideoModeSwitch(storage, handoff, { ...source.workspace, workspaceId: 'other' }, 0));
  finishVideoModeSwitch(storage, handoff, { ...source.workspace, epoch: 9 }, 0);
  assert.equal(readVideoModeSwitch(storage, 'owner', 'tab', to, id(40))?.nonce, id(40));
  finishVideoModeSwitch(storage, handoff, { ...source.workspace, epoch: 9 }, 0);
  assert.equal(parseModeInputDraft(storage.getItem(videoInputDraftKey(to)), 'owner', 'tab')?.fields.prompt, source.fields.prompt);
  assert.equal(storage.data.get('sd2:task-reuse-backup:v2:unrelated'), 'untouched');
  assert.equal(parseTaskReuseClientRecord(JSON.stringify(handoff), 'owner', 'not-a-task'), null);
  retainModeRecoveryDraft(storage, to, target);
  assert.equal(readVideoModeSwitch(storage, 'owner', 'tab', to)?.previousTarget?.fields.prompt, 'old target');
  writeVideoInputDraft(storage, to, { ...target, fields: { ...target.fields, prompt: 'later edit' } });
  assert.equal(readVideoModeSwitch(storage, 'owner', 'tab', to, id(40)), null);
});
for (const failAt of [1, 2, 3]) check(() => {
  const storage = new MemoryStorage(); storage.data.set(videoInputDraftKey(to), JSON.stringify({ version: 2, ...source.fields, prompt: 'legacy target' }));
  const old = storage.getItem(videoInputDraftKey(to)); storage.failAt = failAt;
  assert.throws(() => prepareVideoModeSwitch(storage, from, 'normal', source, choice, 0, id(50 + failAt)));
  assert.equal(storage.getItem(videoInputDraftKey(to)), old);
});
check(() => {
  const legacy = parseModeInputDraft(JSON.stringify({ version: 2, ...source.fields }), 'owner', 'tab');
  assert.equal(legacy?.workspace, null); assert.equal(legacy?.fields.prompt, source.fields.prompt);
  assert.equal(parseModeInputDraft(JSON.stringify({ version: 2, ...source.fields, inputBackup: { ...source, workspace: { ...source.workspace, ownerId: 'other' } } }), 'owner', 'tab'), null);
  assert.throws(() => prepareVideoModeSwitch(new MemoryStorage(), 'wrong-context', 'normal', source, choice, 0, id(60)));
  assert.throws(() => prepareVideoModeSwitch(new MemoryStorage(), from, 'normal', source, { ...choice, disabled: true }, 0, id(61)));
});
console.log(JSON.stringify({ passed: true, checks, scope: 'video-mode-switch-and-group-order', networkCalls: 0, businessWrites: 0, browserTests: 0 }));
