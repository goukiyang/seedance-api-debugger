import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const interactions = require('../public/tools/ultimate-canvas/generation-node-interactions.js');
const { CanvasEngine, CanvasReferenceSelection } = require('../public/tools/ultimate-canvas/canvas-engine.js');

const bootstrapSource = readFileSync('src/app/api/tools/ultimate-canvas/bootstrap/route.ts', 'utf8');
const engineSource = readFileSync('public/tools/ultimate-canvas/canvas-engine.js', 'utf8');
const appSource = readFileSync('public/tools/ultimate-canvas/app.js', 'utf8');
const stylesSource = readFileSync('public/tools/ultimate-canvas/styles.css', 'utf8');
const indexSource = readFileSync('public/tools/ultimate-canvas/index.html', 'utf8');

function contains(source: string, expected: string, message: string) {
  assert.ok(source.includes(expected), message);
}

function matches(source: string, expected: RegExp, message: string) {
  assert.match(source, expected, message);
}

assert.deepEqual(interactions.generationNodeDimensions('16:9'), {
  ratio: '16:9', numerator: 16, denominator: 9, width: 350, height: 196.875,
});
assert.deepEqual(interactions.generationNodeDimensions('9:16'), {
  ratio: '9:16', numerator: 9, denominator: 16, width: 196.875, height: 350,
});
assert.deepEqual(interactions.generationNodeDimensions('1:1'), {
  ratio: '1:1', numerator: 1, denominator: 1, width: 350, height: 350,
});
assert.deepEqual(interactions.generationNodeDimensions('9:16', 296), {
  ratio: '9:16', numerator: 9, denominator: 16, width: 166.5, height: 296,
});
assert.equal(interactions.generationNodeDimensions('bad').ratio, '16:9');
assert.equal(interactions.generationNodeDimensions('16:9', 0).width, 350);
assert.equal(interactions.generationNodeLongEdge('image', 1200), 640, 'desktop image nodes align their long edge with the prompt panel');
assert.equal(interactions.generationNodeLongEdge('video', 1200), 640, 'desktop video nodes align their long edge with the prompt panel');
assert.equal(interactions.generationNodeLongEdge('image', 390), 366, 'image nodes respect the mobile viewport gutter');
assert.equal(interactions.generationNodeLongEdge('video', 390), 366, 'video nodes align with the prompt panel at the 390px mobile viewport');
assert.equal(interactions.generationNodeLongEdge('video', 320), 296, 'video nodes respect the mobile viewport gutter');
assert.deepEqual(interactions.videoTaskActionAvailability({
  taskId: 'task-1', status: 'succeeded', previewUrl: '/play', downloadUrl: '/download', canRetry: true, canManage: true,
}), {
  taskId: 'task-1', detailUrl: '/tasks?task=task-1', previewUrl: '/play', downloadUrl: '/download', canRetry: true, canMarkVersion: true,
});
assert.equal(interactions.videoTaskActionAvailability({ taskId: '', status: 'succeeded' }), null);
assert.equal(interactions.videoTaskActionAvailability({ taskId: 'task-2', status: 'running', canRetry: true }).canRetry, false);
assert.equal(interactions.videoTaskActionAvailability({ taskId: 'task-3', status: 'failed', canRetry: true }).canRetry, true);

const taskActionPopoverSource = appSource.slice(
  appSource.indexOf('function videoTaskActionsForNode'),
  appSource.indexOf('function activeTabText'),
);
function taskActionPopoverHarness(node: { id: string; type: string; data: Record<string, unknown> }) {
  const body: { lastChild: any; appendChild: (element: any) => void } = {
    lastChild: null,
    appendChild(element) { element.isConnected = true; this.lastChild = element; },
  };
  const documentStub = {
    body,
    createElement() {
      return {
        className: '', dataset: {}, style: {}, isConnected: false,
        remove() { this.isConnected = false; },
        setAttribute() {},
        getBoundingClientRect: () => ({ width: 190, height: 100 }),
      };
    },
  };
  const canvasRuntime = {
    generationPopover: null,
    selectedVideoCardId: 'card-1',
    videoCardDetails: new Map(),
    bootstrap: { context: { video_cards: [{ id: 'card-1', can_generate: true, can_manage: true }] } },
  };
  const factory = new Function('canvasRuntime', 'window', 'document', 'engine', 'escapeHtml', 'videoCardUiText', `${taskActionPopoverSource}\nreturn { syncVideoTaskActionsTrigger, openGenerationPopover };`);
  const api = factory(
    canvasRuntime,
    { UltimateCanvasGenerationInteractions: interactions, innerWidth: 1200, innerHeight: 800 },
    documentStub,
    { nodes: new Map([[node.id, node]]) },
    (value: unknown) => String(value ?? ''),
    { retryTask: 'Retry', candidate: 'Candidate', best: 'Best', final: 'Final' },
  );
  const toolbar: { trigger: any; querySelector: () => any; appendChild: (trigger: any) => void } = {
    trigger: null,
    querySelector: () => null,
    appendChild(trigger) { this.trigger = trigger; },
  };
  const nodeEl = { querySelector: (selector: string) => selector === '.generation-node-toolbar' ? toolbar : null };
  return { api, body, nodeEl, toolbar };
}

for (const [taskId, previewUrl, downloadUrl] of [
  ['refreshed-task', '/api/video/play/refreshed-task', '/api/video/download/refreshed-task'],
  ['restored-task', '/restored-preview', '/api/video/download/restored-task'],
]) {
  const node = { id: `${taskId}-node`, type: 'video', data: { taskId, generationStatus: 'succeeded', videoCardId: 'card-1' } };
  const { api, body, nodeEl, toolbar } = taskActionPopoverHarness(node);
  api.syncVideoTaskActionsTrigger(nodeEl, node, { videoUrl: previewUrl, downloadUrl });
  const trigger = {
    ...toolbar.trigger,
    isConnected: true,
    setAttribute() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, bottom: 30 }),
  };
  api.openGenerationPopover(node.id, 'task-actions', trigger);
  assert.ok(body.lastChild.innerHTML.includes(previewUrl), `${taskId} popover retains override-only preview URL`);
  assert.ok(body.lastChild.innerHTML.includes(downloadUrl), `${taskId} popover retains override-only download URL`);
}

const specPopoverSource = appSource.slice(
  appSource.indexOf('function generationSelect'),
  appSource.indexOf('function renderCameraPopover'),
);
const specPopoverElement = { isConnected: true, innerHTML: 'stale controls' };
let specPopoverPositionCalls = 0;
const specPopoverRuntime = {
  generationPopover: { nodeId: 'image-spec-node', kind: 'spec', element: specPopoverElement },
  bootstrap: { capabilities: { image: {} } },
};
const specPopoverFactory = new Function(
  'canvasRuntime', 'window', 'escapeHtml', 'generationSettingsForNode', 'positionGenerationPopover',
  `${specPopoverSource}\nreturn { refreshOpenGenerationSpecPopover };`,
);
const specPopoverApi = specPopoverFactory(
  specPopoverRuntime,
  {
    UltimateCanvasGenerationInteractions: {
      normalizeCapabilities: () => ({ ratios: ['16:9', '21:9'], sizeOptions: ['1K', '2K'], fixedSize: '' }),
    },
  },
  (value: unknown) => String(value ?? ''),
  (node: any) => ({ ...node.data.imageSettings, maximumCount: 4 }),
  () => { specPopoverPositionCalls += 1; },
);
const imageSpecNode = {
  id: 'image-spec-node', type: 'image', data: { imageSettings: { ratio: '21:9', size: '2K', count: 3 } },
};
assert.equal(specPopoverApi.refreshOpenGenerationSpecPopover(imageSpecNode), true);
assert.ok(specPopoverElement.innerHTML.includes('value="21:9" selected'), 'open ratio control follows current image settings');
assert.ok(specPopoverElement.innerHTML.includes('value="2K" selected'), 'open size control follows current image settings');
assert.ok(specPopoverElement.innerHTML.includes('value="3"'), 'open count control follows current image settings');
assert.equal(specPopoverPositionCalls, 1, 'refreshed specification controls are repositioned');

contains(appSource, 'generationNodeDimensions(settings.ratio, generationNodeLongEdge(nodeEl))', 'render derives card dimensions from the node type and current settings');
contains(appSource, "setProperty('--generation-node-width'", 'render writes node width');
contains(appSource, "setProperty('--generation-node-height'", 'render writes node height');
contains(appSource, 'function refreshOpenGenerationSpecPopover', 'open specification controls have one state refresh path');
contains(appSource, 'state.element.innerHTML = renderSpecPopover(node)', 'open specification controls rerender from current node settings');
const renderGenerationControlsSource = appSource.slice(
  appSource.indexOf('function renderGenerationNodeControls'),
  appSource.indexOf('function renderAllGenerationNodeControls'),
);
contains(renderGenerationControlsSource, 'refreshOpenGenerationSpecPopover(node)', 'node control refresh updates an open specification popover');

contains(engineSource, 'connectNodes(fromId, toId)', 'engine exposes public connection creation');
contains(engineSource, 'disconnectNodes(fromId, toId)', 'engine exposes public connection removal');
contains(engineSource, 'disconnectIncoming(nodeId)', 'engine can clear target references');
contains(engineSource, 'selectNode(nodeId)', 'app can return selection to the target node');
contains(engineSource, 'new ResizeObserver', 'node size changes update edge paths');
assert.doesNotMatch(
  stylesSource,
  /\.canvas-node\.selected\.node-type-(?:video|image) \.node-card[\s\S]*?(?:width|height):\s*\d+px;/,
  'selected generated results do not override ratio-aware card dimensions',
);
matches(
  stylesSource,
  /\.generated-reference-card\s*\{[\s\S]*?box-sizing:\s*border-box;/,
  'generated result cards include padding and borders in their measured size',
);
matches(
  stylesSource,
  /\.generated-frame-preview\s*\{[\s\S]*?max-height:\s*\d+px;/,
  'generated media is bounded so action rows remain visible',
);
matches(
  stylesSource,
  /\.canvas-node:not\(\.selected\)[\s\S]*?\.generated-action-row\s*\{[\s\S]*?display:\s*none;/,
  'unselected generated nodes hide result actions to preserve compact dimensions',
);
matches(stylesSource, /\.node-connector\s*\{[\s\S]*?top:\s*50%;[\s\S]*?translateY\(-50%\)/, 'ports stay vertically centered on the card');
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
contains(appSource, 'durableCanvasDocument(', 'canvas save uses the executable durable document contract');
contains(appSource, 'data-generated-image-action="regenerate"', 'image results remain regeneratable');
contains(appSource, 'data-generation-submit', 'result nodes retain their generation submit control');
contains(indexSource, 'generation-task-coordinator.js', 'canvas loads the polling coordinator before app startup');
contains(indexSource, 'app.js?v=20260713-no-fake-preview', 'canvas app cache key matches the non-generating preview state');
contains(appSource, 'function scheduleVideoEstimate', 'video settings request a debounced estimate');
contains(appSource, "'/api/tasks/estimate'", 'estimate uses the existing sd2 endpoint');
contains(appSource, '350', 'video estimates debounce for 350ms');
contains(appSource, '.abort()', 'a superseded video estimate request is aborted');
contains(appSource, 'estimateSignature', 'stale estimate responses are checked against their settings signature');
contains(appSource, '预计 ${', 'successful estimates are labeled clearly');
contains(appSource, '提交后由后台计算', 'estimate failure remains nonblocking');
contains(appSource, 'function clearAllVideoEstimates', 'app exposes one whole-canvas estimate cleanup path');
const bootstrapSourceBlock = appSource.slice(
  appSource.indexOf('async function loadCanvasBootstrap'),
  appSource.indexOf('function renderRuntimeContextControls'),
);
contains(bootstrapSourceBlock, 'clearAllVideoEstimates()', 'project and video-card bootstrap switches clear old estimates');
contains(appSource, "window.addEventListener('pagehide', clearAllVideoEstimates)", 'page teardown clears pending estimates');
const clearCanvasSource = appSource.slice(
  appSource.indexOf('function clearCanvasForContext'),
  appSource.indexOf('function resetProjectScopedRuntime'),
);
contains(clearCanvasSource, 'clearAllVideoEstimates()', 'whole-canvas clearing cancels stale estimates before restore');
assert.ok(
  clearCanvasSource.indexOf('clearAllVideoEstimates()') < clearCanvasSource.indexOf('engine.restore('),
  'whole-canvas cleanup runs before engine restore',
);
const restoreDocumentSource = appSource.slice(
  appSource.indexOf('async function loadCanvasDocument'),
  appSource.indexOf('function installAutosaveHooks'),
);
contains(restoreDocumentSource, 'clearAllVideoEstimates()', 'document restore cancels stale estimates');
assert.ok(
  restoreDocumentSource.lastIndexOf('clearAllVideoEstimates()') < restoreDocumentSource.indexOf('engine.restore('),
  'document cleanup runs before engine restore',
);
const pollingSource = appSource.slice(
  appSource.indexOf('function pollVideoTask'),
  appSource.indexOf('canvasRuntime.pollingCoordinator ='),
);
contains(pollingSource, 'pollingCoordinator.register(taskId, nodeId)', 'video polling always delegates registration to the canvas coordinator');
assert.ok(!pollingSource.includes('pollingCoordinator.has(taskId)'), 'app does not bypass coordinator replacement semantics');
contains(appSource, 'stopVideoPolling(deletedNode.data.taskId, deletedNode.id)', 'node deletion unregisters only its own task mapping');
contains(appSource, 'pollingCoordinator.unregister(taskId, nodeId)', 'task cleanup delegates optional node ownership to the coordinator');
contains(appSource, 'pollingCoordinator.clear()', 'context cleanup delegates to the coordinator');
assert.ok(!appSource.includes('pollingTasks: new Map()'), 'app no longer owns per-task polling timers');
assert.ok(!engineSource.includes('data-video-mode='), 'video generation modes are not permanently spread across the node');

const quickModeSource = appSource.slice(
  appSource.indexOf('function applyGenerationQuickMode'),
  appSource.indexOf('function generationSelect'),
);
assert.ok(quickModeSource.includes('applyGenerationQuickAction'), 'quick mode delegates to the executable contract');
assert.ok(!quickModeSource.includes('submitNodeGeneration'), 'quick mode never submits generation');

const generatedActionSource = appSource.slice(
  appSource.indexOf("if (action === 'regenerate')"),
  appSource.indexOf('function promptInputFor'),
);
assert.ok(generatedActionSource.includes('submitNodeGeneration(nodeEl, submit)'), 'regenerate reuses the current node');
assert.ok(generatedActionSource.includes('applyDownstreamVideoAction'), 'create-video delegates to the executable contract');

const decorationSource = appSource.slice(
  appSource.indexOf('function decorateGeneratedNode'),
  appSource.indexOf('function createDirectorOutput'),
);
assert.ok(decorationSource.includes('updateGenerationResultRegion'), 'generated results use the executable region contract');
assert.ok(!decorationSource.includes('body.innerHTML'), 'generated results do not replace editor controls');
assert.ok(!decorationSource.includes('const taskActions ='), 'generated result cards no longer render task links');
assert.ok(!decorationSource.includes('const generatedButtons ='), 'generated result cards no longer render task commands');
contains(appSource, 'data-generation-popover="task-actions"', 'video toolbar exposes a task-actions popover trigger');
const taskActionsTriggerSource = appSource.slice(
  appSource.indexOf('function syncVideoTaskActionsTrigger'),
  appSource.indexOf('function renderVideoTaskActionsPopover'),
);
contains(engineSource, 'data-generation-command="disconnect-references"', 'video prompt toolbar exposes clear references before dynamic task actions');
contains(taskActionsTriggerSource, "trigger.textContent = '\\u66f4\\u591a'", 'task trigger renders the more label');
contains(taskActionsTriggerSource, 'toolbar.appendChild(trigger)', 'video task-actions trigger follows the existing toolbar commands');
contains(appSource, "kind === 'task-actions' ? renderVideoTaskActionsPopover(node, anchor._generationTaskActions)", 'popover renders the explicit task-actions branch with trigger action state');

assert.ok(bootstrapSource.includes('interaction'));
assert.ok(bootstrapSource.includes('DURATION_OPTIONS'));
assert.ok(bootstrapSource.includes('RESOLUTION_OPTIONS'));
assert.ok(bootstrapSource.includes('RATIO_OPTIONS'));

const videoCapability = interactions.normalizeCapabilities('video', {
  enabled: true,
  message: 'video ready',
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
assert.equal(videoCapability.enabled, true);
assert.equal(videoCapability.message, 'video ready');

const invalidResolutionCapability = interactions.normalizeCapabilities('video', {
  enabled: true,
  interaction: { resolutions: ['2160p', 'not-a-resolution'] },
});
assert.deepEqual(invalidResolutionCapability.resolutions, [], 'explicit invalid video resolutions do not invent defaults');

const imageResolutionCapability = interactions.normalizeCapabilities('image', {
  enabled: true,
  interaction: { size_options: ['1K', '2K', '2160p'] },
});
assert.deepEqual(imageResolutionCapability.sizeOptions, ['1K', '2K']);
assert.deepEqual(imageResolutionCapability.resolutions, ['1K', '2K'], 'image resolution alias remains compatible');
const imageMixedResolutionCapability = interactions.normalizeCapabilities('image', {
  enabled: true,
  interaction: { size_options: ['1K', '2160p'] },
});
assert.deepEqual(imageMixedResolutionCapability.sizeOptions, ['1K']);
const imageEmptySizeCapability = interactions.normalizeCapabilities('image', {
  enabled: true,
  size: '2K',
  interaction: { size_options: [] },
});
assert.deepEqual(imageEmptySizeCapability.sizeOptions, [], 'explicit empty selectable image sizes stay empty');
assert.equal(imageEmptySizeCapability.fixedSize, '2K', 'outer configured image size is normalized as fixed');
assert.equal(
  interactions.generationInteractionReadiness('image', imageEmptySizeCapability, {}, 0, 'text-to-image').ready,
  true,
  'enabled fixed-size image capability remains valid',
);
const imageMissingSizeCapability = interactions.normalizeCapabilities('image', {
  enabled: true,
  message: '可用',
  interaction: { size_options: [] },
});
const imageMissingSizeReadiness = interactions.generationInteractionReadiness(
  'image', imageMissingSizeCapability, {}, 0, 'text-to-image',
);
assert.equal(imageMissingSizeReadiness.ready, false, 'image capability without selectable or fixed size is invalid');
assert.equal(imageMissingSizeReadiness.message, '当前没有可用的生成规格。');
assert.notEqual(imageMissingSizeReadiness.message, '可用', 'missing spec never reports a positive capability message');
const imageDefaultSizeCapability = interactions.normalizeCapabilities('image', {
  enabled: true,
  interaction: {},
});
assert.deepEqual(imageDefaultSizeCapability.sizeOptions, ['1K', '2K'], 'missing image sizes use compatibility defaults');
assert.equal(imageDefaultSizeCapability.fixedSize, '');
assert.equal(imageResolutionCapability.fixedSize, '');

const disabledCapability = interactions.normalizeCapabilities('image', {
  enabled: false,
  message: 'provider unavailable',
  interaction: { modes: ['text-to-image'], size_options: ['1K'] },
});
assert.equal(disabledCapability.enabled, false);
assert.equal(disabledCapability.message, 'provider unavailable');
assert.deepEqual(
  interactions.generationInteractionReadiness('image', disabledCapability, {}, 0, 'text-to-image'),
  { ready: false, message: 'provider unavailable' },
);
const missingCapability = interactions.normalizeCapabilities('image');
assert.equal(missingCapability.enabled, false, 'missing backend capability is unavailable');
const recoveredCapability = interactions.normalizeCapabilities('image', {
  enabled: true,
  interaction: { modes: ['text-to-image'], size_options: ['1K'] },
});
assert.equal(
  interactions.generationInteractionReadiness('image', recoveredCapability, {}, 0, 'text-to-image').ready,
  true,
  'enabled capability with a valid mode and size recovers',
);

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
assert.equal(withTwoReferences.find((item: any) => item.id === 'image-to-video').maximumReferences, 2,
  'mode maxima are capped by backend max_reference_images');
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
const durableDocument = interactions.durableCanvasDocument(liveDocument);
assert.deepEqual(durableDocument, {
  ...liveDocument,
  transient: '',
  nested: { transient: '' },
});
assert.equal(liveDocument.transient, 'blob:preview', 'sanitizing a clone does not mutate live node data');
assert.equal(liveDocument.nested.transient, 'data:image/png;base64,x');

const quickCalls: string[] = [];
let quickSubmitCalls = 0;
let quickNetworkCalls = 0;
const quickPlan = interactions.applyGenerationQuickAction({
  selectNode: (nodeId: string) => quickCalls.push(`select:${nodeId}`),
  configureMode: (nodeId: string, mode: string) => quickCalls.push(`configure:${nodeId}:${mode}`),
  renderControls: (nodeId: string) => quickCalls.push(`render:${nodeId}`),
  startReferenceSelection: (nodeId: string) => quickCalls.push(`reference:${nodeId}`),
  scheduleSave: (reason: string) => quickCalls.push(`save:${reason}`),
  submitGeneration: () => { quickSubmitCalls += 1; },
  request: () => { quickNetworkCalls += 1; },
}, { nodeId: 'image-1', nodeType: 'image', mode: 'image-to-image', minimumReferences: 1, referenceCount: 0 });
assert.deepEqual(quickPlan, { startsReferenceSelection: true });
assert.deepEqual(quickCalls, [
  'select:image-1',
  'configure:image-1:image-to-image',
  'render:image-1',
  'reference:image-1',
  'save:image_quick_mode',
]);
assert.equal(quickSubmitCalls, 0, 'quick action does not invoke an available submit dependency');
assert.equal(quickNetworkCalls, 0, 'quick action does not invoke an available network dependency');
const noReferenceCalls: string[] = [];
const noReferencePlan = interactions.applyGenerationQuickAction({
  selectNode() {}, configureMode() {}, renderControls() {},
  startReferenceSelection: () => noReferenceCalls.push('reference'), scheduleSave() {},
}, { nodeId: 'image-1', nodeType: 'image', mode: 'image-to-image', minimumReferences: 1, referenceCount: 1 });
assert.deepEqual(noReferencePlan, { startsReferenceSelection: false });
assert.deepEqual(noReferenceCalls, []);

const promptObject = { value: 'editable prompt' };
const submitObject = { disabled: false };
const editorObject = { promptObject, submitObject };
const resultRegion = { innerHTML: '' };
const nodeStub = {
  querySelector(selector: string) {
    if (selector === '[data-generation-result-region]') return resultRegion;
    if (selector === '.node-generation-expanded') return editorObject;
    if (selector === '[data-generation-submit]') return submitObject;
    return null;
  },
};
assert.equal(interactions.updateGenerationResultRegion(nodeStub, '<article>first</article>'), true);
assert.equal(resultRegion.innerHTML, '<article>first</article>');
assert.equal(nodeStub.querySelector('.node-generation-expanded'), editorObject);
assert.equal(nodeStub.querySelector('[data-generation-submit]'), submitObject);
assert.equal(promptObject.value, 'editable prompt');
assert.equal(interactions.updateGenerationResultRegion(nodeStub, '<article>restored</article>'), true);
assert.equal(resultRegion.innerHTML, '<article>restored</article>', 'rerender restores only result content');
assert.equal(nodeStub.querySelector('.node-generation-expanded'), editorObject, 'rerender preserves editor identity');

const downstreamCalls: string[] = [];
const downstreamId = interactions.applyDownstreamVideoAction({
  createVideoNode: () => { downstreamCalls.push('create'); return 'video-1'; },
  connectNodes: (from: string, to: string) => { downstreamCalls.push(`connect:${from}:${to}`); return true; },
  rollbackVideoNode: (nodeId: string) => downstreamCalls.push(`rollback:${nodeId}`),
}, { sourceNodeId: 'image-1' });
assert.equal(downstreamId, 'video-1');
assert.deepEqual(downstreamCalls, ['create', 'connect:image-1:video-1']);

const falseConnectionCalls: string[] = [];
assert.equal(interactions.applyDownstreamVideoAction({
  createVideoNode: () => { falseConnectionCalls.push('create'); return 'video-false'; },
  connectNodes: () => { falseConnectionCalls.push('connect'); return false; },
  rollbackVideoNode: (nodeId: string) => falseConnectionCalls.push(`rollback:${nodeId}`),
}, { sourceNodeId: 'image-1' }), null);
assert.deepEqual(falseConnectionCalls, ['create', 'connect', 'rollback:video-false']);

const thrownConnectionCalls: string[] = [];
assert.equal(interactions.applyDownstreamVideoAction({
  createVideoNode: () => { thrownConnectionCalls.push('create'); return 'video-throw'; },
  connectNodes: () => { thrownConnectionCalls.push('connect'); throw new Error('connection failed'); },
  rollbackVideoNode: (nodeId: string) => thrownConnectionCalls.push(`rollback:${nodeId}`),
}, { sourceNodeId: 'image-1' }), null);
assert.deepEqual(thrownConnectionCalls, ['create', 'connect', 'rollback:video-throw']);

const noIdCalls: string[] = [];
assert.equal(interactions.applyDownstreamVideoAction({
  createVideoNode: () => { noIdCalls.push('create'); return null; },
  connectNodes: () => { noIdCalls.push('connect'); return true; },
  rollbackVideoNode: () => noIdCalls.push('rollback'),
}, { sourceNodeId: 'image-1' }), null);
assert.deepEqual(noIdCalls, ['create']);

for (const missingDependency of ['createVideoNode', 'connectNodes', 'rollbackVideoNode']) {
  const missingCalls: string[] = [];
  const dependencies: any = {
    createVideoNode: () => { missingCalls.push('create'); return 'video-missing'; },
    connectNodes: () => { missingCalls.push('connect'); return true; },
    rollbackVideoNode: () => missingCalls.push('rollback'),
  };
  delete dependencies[missingDependency];
  assert.equal(interactions.applyDownstreamVideoAction(dependencies, { sourceNodeId: 'image-1' }), null);
  assert.deepEqual(missingCalls, [], `missing ${missingDependency} prevents all downstream side effects`);
}

assert.equal(interactions.pollDelay(1, 0, false), 3000);
assert.equal(interactions.pollDelay(20, 0, false), 8000);
assert.equal(interactions.pollDelay(2, 3, false), 15000);
assert.equal(interactions.pollDelay(2, 0, true), 15000);

assert.doesNotThrow(() => interactions.clearVideoEstimateEntries());
assert.doesNotThrow(() => interactions.clearVideoEstimateEntries(new Map()));
const clearedTimers: unknown[] = [];
let firstAbortCount = 0;
let throwingAbortCount = 0;
let lastAbortCount = 0;
const estimateEntries = new Map<string, any>([
  ['first', { timer: 11, controller: { abort: () => { firstAbortCount += 1; } } }],
  ['throwing', { timer: 22, controller: { abort: () => { throwingAbortCount += 1; throw new Error('abort failed'); } } }],
  ['last', { timer: null, controller: { abort: () => { lastAbortCount += 1; } } }],
]);
assert.doesNotThrow(() => interactions.clearVideoEstimateEntries(
  estimateEntries,
  (timer: unknown) => clearedTimers.push(timer),
));
assert.deepEqual(clearedTimers, [11, 22]);
assert.equal(firstAbortCount, 1);
assert.equal(throwingAbortCount, 1);
assert.equal(lastAbortCount, 1, 'cleanup continues after an abort throws');
assert.equal(estimateEntries.size, 0, 'cleanup always clears the transient estimate map');

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

for (const status of ['submitted', 'queued', 'pending', 'processing', 'running', 'IN-PROGRESS', 'in progress']) {
  assert.equal(interactions.isNonterminalGenerationStatus(status), true, `${status} is nonterminal`);
}
for (const status of ['succeeded', 'failed', 'cancelled', '', null]) {
  assert.equal(interactions.isNonterminalGenerationStatus(status), false, `${status} is terminal or empty`);
}
assert.equal(interactions.nodeHasNonterminalVideoTask({
  type: 'video',
  data: { taskId: 'task-1', generationStatus: 'processing' },
}), true);
assert.equal(interactions.nodeHasNonterminalVideoTask({
  type: 'video',
  data: { generationStatus: 'submitted' },
}), false, 'taskless legacy submitted state cannot own or lock a video task');
assert.deepEqual(
  interactions.generationInteractionReadiness(
    'video',
    videoCapability,
    { taskId: 'task-1', generationStatus: 'running' },
    0,
    'text-to-video',
  ),
  { ready: false, message: '当前视频任务仍在处理中，请等待完成后再生成。' },
  'paid video submission is rejected while this node owns a nonterminal task',
);
assert.equal(
  interactions.generationInteractionReadiness('image', recoveredCapability, { generationStatus: 'running' }, 0, 'text-to-image').ready,
  true,
  'image regeneration remains available',
);

assert.deepEqual(interactions.referenceIdsFromNodeData({
  generationResult: {
    assets: [{ reference_image_id: 'asset-reference' }],
    result: { referenceImageIds: ['nested-reference'] },
  },
}).sort(), ['asset-reference', 'nested-reference'], 'restored nested reference IDs remain durable and available');
assert.equal(interactions.availableReferenceCount([
  { data: { previewImage: 'https://example.test/unavailable.png' } },
  { data: { generationResult: { reference_image_id: 'durable-reference' } } },
]), 1, 'only durable reference IDs count toward mode gating');
const durableCount = interactions.availableReferenceCount([
  { data: { previewImage: 'https://example.test/unavailable.png' } },
  { data: { generationResult: { reference_image_id: 'durable-reference' } } },
]);
assert.equal(interactions.modeOptions('video', {
  modes: ['smart-multi-frame-video'],
  maxReferenceImages: 9,
}, durableCount)[0].enabled, false, 'an unavailable connected image cannot enable a multi-reference mode');

assert.ok(appSource.includes('generationInteractionReadiness'), 'app consumes the shared readiness contract');
assert.ok(appSource.includes('availableGenerationReferenceItems'), 'app gates modes with available references');
assert.ok(appSource.includes('capability.sizeOptions'), 'image spec UI consumes normalized size options');
assert.ok(appSource.includes('capability.fixedSize'), 'image spec UI renders a read-only fixed size fallback');

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
