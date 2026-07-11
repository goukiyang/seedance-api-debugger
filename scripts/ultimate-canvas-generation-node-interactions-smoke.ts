import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const interactions = require('../public/tools/ultimate-canvas/generation-node-interactions.js');
const { CanvasEngine, CanvasReferenceSelection } = require('../public/tools/ultimate-canvas/canvas-engine.js');

const bootstrapSource = readFileSync('src/app/api/tools/ultimate-canvas/bootstrap/route.ts', 'utf8');
const engineSource = readFileSync('public/tools/ultimate-canvas/canvas-engine.js', 'utf8');
const appSource = readFileSync('public/tools/ultimate-canvas/app.js', 'utf8');
const stylesSource = readFileSync('public/tools/ultimate-canvas/styles.css', 'utf8');

function contains(source: string, expected: string, message: string) {
  assert.ok(source.includes(expected), message);
}

contains(engineSource, 'connectNodes(fromId, toId)', 'engine exposes public connection creation');
contains(engineSource, 'disconnectNodes(fromId, toId)', 'engine exposes public connection removal');
contains(engineSource, 'disconnectIncoming(nodeId)', 'engine can clear target references');
contains(engineSource, 'selectNode(nodeId)', 'app can return selection to the target node');
contains(engineSource, 'new ResizeObserver', 'node size changes update edge paths');
contains(engineSource, 'this.onConnectionDeleted', 'connection removals notify persistence');
contains(stylesSource, '.canvas-node.selected', 'selected canvas node state is styled');
contains(stylesSource, '.canvas-node:not(.selected) .node-generation-expanded', 'unselected generation controls collapse');
contains(stylesSource, '.canvas-node.is-reference-compatible', 'reference-compatible node state is styled');
contains(engineSource, 'data-generation-popover="mode"', 'node exposes one mode trigger');
contains(engineSource, 'data-generation-popover="spec"', 'node exposes one specification trigger');
contains(appSource, 'function openGenerationPopover', 'app owns one anchored popover');
contains(appSource, 'function closeGenerationPopover', 'popover has one cleanup path');
contains(appSource, 'function startReferenceSelection', 'reference command enters canvas selection mode');
contains(appSource, 'function finishReferenceSelection', 'reference mode has one cleanup path');
contains(appSource, 'function selectCanvasReference', 'compatible canvas nodes can be selected');
contains(appSource, 'function removeGenerationReference', 'individual references can be removed');
contains(appSource, '从画布选择参考', 'reference mode has visible status text');
contains(stylesSource, '.is-reference-compatible', 'compatible nodes are highlighted');
contains(stylesSource, '.is-reference-incompatible', 'incompatible nodes are visibly disabled');
contains(appSource, 'referenceRole(', 'first and last frames derive from ordered references');
contains(appSource, "case 'Escape'", 'Escape closes generation popovers');
contains(stylesSource, '.generation-popover', 'popover has viewport-safe styling');
contains(engineSource, 'data-generation-quick-mode', 'compact nodes expose quick mode choices');
contains(engineSource, 'data-generation-result-region', 'generation nodes reserve an in-place result region');
contains(appSource, 'function applyGenerationQuickMode', 'quick choices only configure the node');
contains(appSource, 'sanitizeSerializable(structuredClone(canvasDocumentPayload', 'canvas documents remove transient local URLs');
contains(appSource, 'data-generated-image-action="regenerate"', 'image results remain regeneratable');
contains(appSource, 'data-generation-submit', 'result nodes retain their generation submit control');
assert.ok(!engineSource.includes('data-video-mode='), 'video generation modes are not permanently spread across the node');

const quickModeSource = appSource.slice(
  appSource.indexOf('function applyGenerationQuickMode'),
  appSource.indexOf('function generationSelect'),
);
assert.ok(quickModeSource.includes('engine.selectNode(nodeId)'), 'quick mode selects the existing node');
assert.ok(quickModeSource.includes('startReferenceSelection(nodeId)'), 'reference modes enter selection');
assert.ok(!quickModeSource.includes('submitNodeGeneration'), 'quick mode never submits generation');

const generatedActionSource = appSource.slice(
  appSource.indexOf("if (action === 'regenerate')"),
  appSource.indexOf('function promptInputFor'),
);
assert.ok(generatedActionSource.includes('submitNodeGeneration(nodeEl, submit)'), 'regenerate reuses the current node');
assert.equal((generatedActionSource.match(/engine\.addNode\('video'/g) || []).length, 1,
  'create-video creates exactly one downstream video node');
assert.equal((generatedActionSource.match(/engine\.connectNodes\(node\.id, videoNodeId\)/g) || []).length, 1,
  'create-video connects the downstream node exactly once');

const decorationSource = appSource.slice(
  appSource.indexOf('function decorateGeneratedNode'),
  appSource.indexOf('function createDirectorOutput'),
);
assert.ok(decorationSource.includes('resultRegion.innerHTML'), 'generated results update their dedicated region');
assert.ok(!decorationSource.includes('body.innerHTML'), 'generated results do not replace editor controls');

assert.ok(bootstrapSource.includes('interaction'));
assert.ok(bootstrapSource.includes('DURATION_OPTIONS'));
assert.ok(bootstrapSource.includes('RESOLUTION_OPTIONS'));
assert.ok(bootstrapSource.includes('RATIO_OPTIONS'));

const videoCapability = interactions.normalizeCapabilities('video', {
  interaction: {
    modes: ['text-to-video', 'image-to-video', 'first-last-frame-video'],
    ratios: ['16:9', '9:16'],
    durations: [5, 10],
    resolutions: ['720p', '1080p'],
    supports_audio: true,
    supports_last_frame: true,
    supports_watermark: false,
    max_reference_images: 2,
  },
});

assert.deepEqual(videoCapability.durations, [5, 10]);
assert.equal(videoCapability.supportsWatermark, false);

const invalidResolutionCapability = interactions.normalizeCapabilities('video', {
  interaction: { resolutions: ['2160p', 'not-a-resolution'] },
});
assert.deepEqual(invalidResolutionCapability.resolutions, ['720p', '1080p']);

const imageResolutionCapability = interactions.normalizeCapabilities('image', {
  interaction: { resolutions: ['1K', '2K', '2160p'] },
});
assert.deepEqual(imageResolutionCapability.resolutions, ['1K', '2K']);
const imageMixedResolutionCapability = interactions.normalizeCapabilities('image', {
  interaction: { resolutions: ['1K', '2160p'] },
});
assert.deepEqual(imageMixedResolutionCapability.resolutions, ['1K']);

const nullInteractionCapability = interactions.normalizeCapabilities('video', { interaction: null });
assert.deepEqual(nullInteractionCapability.modes, [
  'text-to-video',
  'all-reference-video',
  'image-to-video',
  'first-frame-video',
  'first-last-frame-video',
  'image-reference-video',
  'smart-multi-frame-video',
]);

const withoutReferences = interactions.modeOptions('video', videoCapability, 0);
assert.equal(withoutReferences.find((item: any) => item.id === 'text-to-video').enabled, true);
assert.equal(withoutReferences.find((item: any) => item.id === 'image-to-video').enabled, false);
assert.match(withoutReferences.find((item: any) => item.id === 'image-to-video').reason, /1/);

const withTwoReferences = interactions.modeOptions('video', videoCapability, 2);
assert.equal(withTwoReferences.find((item: any) => item.id === 'first-last-frame-video').enabled, true);
assert.equal(interactions.referenceRole('first-last-frame-video', 0), '首帧');
assert.equal(interactions.referenceRole('first-last-frame-video', 1), '尾帧');

assert.equal(
  interactions.replaceCameraLine('产品缓慢旋转\n运镜：镜头前推', '镜头环绕主体'),
  '产品缓慢旋转\n运镜：镜头环绕主体',
);
assert.equal(
  interactions.replaceCameraLine('产品缓慢旋转', '镜头环绕主体'),
  '产品缓慢旋转\n运镜：镜头环绕主体',
);

assert.deepEqual(
  interactions.sanitizeSerializable({ keep: 'https://example.com/a.png', remove: 'blob:temp', nested: ['data:image/png;base64,x', 3] }),
  { keep: 'https://example.com/a.png', remove: '', nested: ['', 3] },
);
const liveDocument = {
  id: 'canvas-1',
  count: 2,
  enabled: true,
  empty: null,
  remote: 'https://example.com/a.png',
  api: '/api/assets/a.png',
  transient: 'blob:preview',
  nested: { transient: 'data:image/png;base64,x' },
};
const durableDocument = interactions.sanitizeSerializable(structuredClone(liveDocument));
assert.deepEqual(durableDocument, {
  ...liveDocument,
  transient: '',
  nested: { transient: '' },
});
assert.equal(liveDocument.transient, 'blob:preview', 'sanitizing a clone does not mutate live node data');
assert.equal(liveDocument.nested.transient, 'data:image/png;base64,x');

assert.equal(interactions.pollDelay(1, 0, false), 3000);
assert.equal(interactions.pollDelay(20, 0, false), 8000);
assert.equal(interactions.pollDelay(2, 3, false), 15000);
assert.equal(interactions.pollDelay(2, 0, true), 15000);

const selection = CanvasReferenceSelection.start({
  targetNodeId: 'target',
  previousSelectedNodeId: 'previous',
  maximumReferences: 2,
});
const missingDurableId = CanvasReferenceSelection.add(selection, { nodeId: 'image-missing' });
assert.equal(missingDurableId.accepted, false, 'canvas references require a durable referenceImageId');

const firstReference = CanvasReferenceSelection.add(selection, {
  nodeId: 'image-first',
  referenceImageId: 'reference-first',
});
assert.equal(firstReference.accepted, true);
assert.equal(firstReference.finished, false, 'selection remains active below the maximum');
assert.equal(CanvasReferenceSelection.pendingTargetId(firstReference.session), 'target', 'library target remains available below max');

const duplicateReference = CanvasReferenceSelection.add(firstReference.session, {
  nodeId: 'image-duplicate',
  referenceImageId: 'reference-first',
});
assert.equal(duplicateReference.accepted, false, 'duplicate durable references are ignored');

const secondReference = CanvasReferenceSelection.add(firstReference.session, {
  nodeId: 'image-last',
  referenceImageId: 'reference-last',
});
assert.equal(secondReference.accepted, true);
assert.equal(secondReference.finished, true, 'selection finishes at the maximum');
assert.deepEqual(secondReference.session.references.map((item: any) => item.referenceImageId), [
  'reference-first',
  'reference-last',
]);
assert.deepEqual(secondReference.session.references.map((_: any, index: number) =>
  interactions.referenceRole('first-last-frame-video', index)), ['首帧', '尾帧']);
assert.equal(CanvasReferenceSelection.pendingTargetId(secondReference.session), null, 'max cleanup clears library target');

const returned = CanvasReferenceSelection.transition(firstReference.session, 'return');
assert.equal(returned.session.active, true, 'return-to-target keeps selection active');
assert.equal(returned.selectedNodeId, 'target');
const exited = CanvasReferenceSelection.transition(firstReference.session, 'exit');
assert.equal(exited.session.active, false, 'explicit exit finishes selection');
assert.equal(CanvasReferenceSelection.pendingTargetId(exited.session), null);

assert.equal(CanvasReferenceSelection.deleteNode(firstReference.session, 'image-first').active, true,
  'deleting an unrelated/source node keeps selection active');
assert.equal(CanvasReferenceSelection.deleteNode(firstReference.session, 'target').active, false,
  'deleting the target finishes selection');

const smartMultiFrameWithTwo = interactions.modeOptions('video', {
  modes: ['smart-multi-frame-video'],
}, 2)[0];
const smartMultiFrameAfterRemoval = interactions.modeOptions('video', {
  modes: ['smart-multi-frame-video'],
}, 1)[0];
assert.equal(smartMultiFrameWithTwo.enabled, true);
assert.equal(smartMultiFrameAfterRemoval.enabled, false, 'mode and submit gating become invalid after reference removal');
assert.ok(smartMultiFrameAfterRemoval.reason);

function engineHarness() {
  const engine = Object.create(CanvasEngine.prototype);
  engine.nodes = new Map();
  engine.connections = [];
  engine.svg = { appendChild() {}, innerHTML: '', querySelectorAll: () => [] };
  engine.canvas = { innerHTML: '', querySelectorAll: () => [] };
  engine.scale = 1;
  engine.offsetX = 0;
  engine.offsetY = 0;
  engine.nextNodeId = 1;
  engine._updateConnections = () => {};
  engine._applyTransform = () => {};
  engine._updateZoom = () => {};
  engine.addNode = (type: string, x: number, y: number, data: any) => {
    const id = data.id;
    engine.nodes.set(id, { id, type, x, y, data: { ...data, id: undefined } });
    return id;
  };
  return engine;
}

const originalDocument = globalThis.document;
const originalAnimationFrame = globalThis.requestAnimationFrame;
(globalThis as any).document = {
  createElementNS: () => ({ id: '', classList: { add() {} } }),
  getElementById: () => null,
  querySelector: () => null,
};
(globalThis as any).requestAnimationFrame = (callback: Function) => { callback(); return 1; };
try {
  const engine = engineHarness();
  engine.nodes.set('image-first', { id: 'image-first', type: 'image', x: 0, y: 0, data: { referenceImageId: 'reference-first' } });
  engine.nodes.set('image-last', { id: 'image-last', type: 'image', x: 10, y: 10, data: { referenceImageId: 'reference-last' } });
  engine.nodes.set('target', { id: 'target', type: 'video', x: 20, y: 20, data: {} });
  const created: string[] = [];
  const deleted: string[] = [];
  engine.onConnectionCreated = (from: string, to: string) => created.push(`${from}:${to}`);
  engine.onConnectionDeleted = (from: string, to: string) => deleted.push(`${from}:${to}`);
  assert.equal(engine.connectNodes('image-first', 'target'), true);
  assert.equal(engine.connectNodes('image-last', 'target'), true);
  assert.deepEqual(created, ['image-first:target', 'image-last:target']);
  const snapshot = engine.serialize();
  assert.deepEqual(snapshot.connections.map((item: any) => [item.from, item.to]), [
    ['image-first', 'target'],
    ['image-last', 'target'],
  ]);
  assert.equal(engine.disconnectNodes('image-first', 'target'), true);
  assert.deepEqual(deleted, ['image-first:target']);

  const restoredEngine = engineHarness();
  const restoredCreated: string[] = [];
  restoredEngine.onConnectionCreated = (from: string, to: string) => restoredCreated.push(`${from}:${to}`);
  restoredEngine.restore(snapshot);
  assert.deepEqual(restoredEngine.connections.map((item: any) => [item.from, item.to]), [
    ['image-first', 'target'],
    ['image-last', 'target'],
  ], 'engine restore preserves incoming connection order');
  assert.deepEqual(restoredCreated, ['image-first:target', 'image-last:target']);
} finally {
  (globalThis as any).document = originalDocument;
  (globalThis as any).requestAnimationFrame = originalAnimationFrame;
}

console.log('ultimate-canvas-generation-node-interactions-smoke passed');
