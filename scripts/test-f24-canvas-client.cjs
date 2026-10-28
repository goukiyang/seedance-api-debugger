'use strict';
const assert = require('node:assert/strict');
const workflow = require('../public/tools/ultimate-canvas/generation-node-workflow.js');
const tests = [];
const test = (name, run) => tests.push({ name, run });
const input = () => ({ projectId: 'project-a', documentId: 'document-a', nodeId: 'node-a', requestId: 'request-a',
  workspaceKey: 'uc2_' + 'a'.repeat(64), prompt: 'synthetic', mode: 'all-reference-video',
  settings: { provider: 'seedance', model: 'dreamina-seedance-2-0-260128', ratio: '16:9', duration: 5, resolution: '480p' } });
test('actual video request retains typed audio identity, role, version and order', () => {
  const references = { version: 1, items: [
    { kind: 'image', role: 'reference', referenceImageId: 'image-a', sourceNodeId: 'node-image' },
    { kind: 'audio', role: 'reference', assetId: 'audio-a', sourceVersion: 'a'.repeat(64) },
  ] };
  const body = workflow.videoRequest({ ...input(), referenceImageIds: ['image-a'], canvasReferences: references,
    referenceAudioUrls: ['https://synthetic.invalid/audio.mp3'] }).payload;
  assert.deepEqual(body.canvas_references, references);
  assert.deepEqual(body.reference_audio_urls, ['https://synthetic.invalid/audio.mp3']);
  assert.deepEqual(workflow.videoPricingRequest({ ...input(), referenceImageIds: ['image-a'], canvasReferences: references,
    referenceAudioUrls: ['https://synthetic.invalid/audio.mp3'] }).payload.canvas_references, references);
});
test('actual video request rejects excess references rather than slicing them', () => {
  assert.throws(() => workflow.videoRequest({ ...input(), referenceImageIds: Array.from({ length: 10 }, (_, i) => 'image-' + i) }), /超|上限|清单/);
});
test('actual IP request preserves all model-supported media, no ordinary max3 fallback', () => {
  const videos = Array.from({ length: 4 }, (_, i) => 'https://synthetic.invalid/video-' + i + '.mp4');
  const request = { ...input(), settings: { ...input().settings, provider: 'volcengine_ip', model: 'doubao-seedance-2-5-260628',
    referenceMedia: { imageLimit: 30, videoLimit: 10, audioLimit: 10, audioOnly: true }, referenceImageLimit: 30 }, referenceVideoUrls: videos };
  assert.deepEqual(workflow.videoRequest(request).payload.reference_video_urls, videos);
});
let failed = 0;
for (const { name, run } of tests) { try { run(); console.log('ok ' + name); } catch (error) { failed++; console.log('FAIL ' + name + ': ' + error.message); } }
console.log(JSON.stringify({ suite: 'f24-canvas-client', total: tests.length, failed, providerCalls: 0, nativePrisma: false }));
if (failed) process.exitCode = 1;
