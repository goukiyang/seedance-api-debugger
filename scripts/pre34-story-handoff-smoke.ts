import assert from 'node:assert/strict';
import { timingFromStory, validateStoryTiming } from '../src/app/story-studio/story-duration';
import { attachStoryVideo, type StoryCanvas } from '../src/app/story-studio/story-handoff';
import type { PickerItem } from '../src/lib/assets/picker-types';
import { AUDIO_CAPABILITY } from '../src/lib/provider/audio-contract';

const shot = { id: 'shot-1', title: '雨夜', description: '寻找纸船', dialogue: '', imagePrompt: '纸船停在水面', videoPrompt: '纸船缓慢漂过水面', durationSeconds: 5 };
const shots = [shot, { ...shot, id: 'shot-2' }, { ...shot, id: 'shot-3' }];
const timing = timingFromStory('总时长15秒，3x5秒。');
assert.deepEqual(timing, { total: 15, count: 3, each: 5 });
validateStoryTiming(timing, shots);
assert.throws(() => validateStoryTiming(timing, shots.slice(0, 2)), /镜头/);
assert.throws(() => validateStoryTiming(timing, [shot, shot, { ...shot, durationSeconds: 6 }]), /15/);
assert.throws(() => validateStoryTiming(timingFromStory('总时长20秒，3x5秒')), /不一致/);
assert.deepEqual(timingFromStory('雨夜，女孩拾起一只纸船。'), {});
assert.deepEqual(timingFromStory('15sec短片，3x5sec'), { total: 15, count: 3, each: 5 });
const graph: StoryCanvas = { schema: 'ultimate_canvas.v1', canvas: { version: 1, nodes: [
  { id: 'source', type: 'script', x: 0, y: 0, data: { prompt: '完整故事', generationStatus: 'succeeded', taskId: 'existing-task' } },
  { id: 'old-video', type: 'video', x: 0, y: 600, data: { generationStatus: 'running', taskId: 'keep-live-job' } },
], connections: [] } };
const oldNodes = structuredClone(graph.canvas.nodes);
const reference: PickerItem = { key: 'asset:original', identity: 'asset:original', id: 'original', type: 'image', assetId: 'original', referenceImageId: 'permitted-reference',
  originalUrl: '/api/image-studio/assets/original', thumbnailUrl: '/preview-only', fileName: '原图', width: 1024, height: 1024,
  duration: null, createdAt: '', source: 'generated' };
attachStoryVideo(graph, 'source', shot, 0, reference, 'new-video', 'new-reference', 7);
assert.deepEqual(graph.canvas.nodes.slice(0, 2), oldNodes);
assert.equal(graph.canvas.nodes[2].data.generationStatus, 'idle');
assert.equal(graph.canvas.nodes[2].data.taskId, undefined);
assert.equal(graph.canvas.nodes[2].data.prompt, shot.videoPrompt);
assert.equal(graph.canvas.nodes[3].data.originalUrl, reference.originalUrl);
assert.equal(graph.canvas.nodes[3].data.referenceImageId, reference.referenceImageId);
assert.deepEqual(graph.canvas.connections, [{ from: 'source', to: 'new-video' }, { from: 'new-reference', to: 'new-video' }]);
assert.throws(() => attachStoryVideo(graph, 'source', shot, 0, reference, 'new-video', 'duplicate-reference', 7), /已存在/);
const before = structuredClone(graph);
assert.throws(() => attachStoryVideo(graph, 'source', shot, 0, { ...reference, referenceImageId: undefined }, 'not-added', 'not-added-ref', 7), /关联/);
assert.deepEqual(graph, before);
assert.equal(AUDIO_CAPABILITY.enabled, false);
assert.equal(AUDIO_CAPABILITY.configured, false);
assert.equal(AUDIO_CAPABILITY.quote, null);
assert.deepEqual(AUDIO_CAPABILITY.models, []);
assert.equal('endpoint' in AUDIO_CAPABILITY, false);
console.log('PRE34 duration and original-media handoff smoke passed (no external requests)');
