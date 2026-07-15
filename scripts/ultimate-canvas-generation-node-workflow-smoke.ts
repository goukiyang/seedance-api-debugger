import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const workflow = require('../public/tools/ultimate-canvas/generation-node-workflow.js');

const context = {
  projectId: 'project-1',
  cardId: 'card-1',
  branchId: 'branch-1',
  documentId: 'document-1',
  nodeId: 'node-1',
  workspaceKey: 'ultimate-canvas:project-1:card-1',
  requestId: 'request-1',
};

assert.deepEqual(workflow.imageMode('text-to-image'), {
  action: 'text_to_image_reference',
  requiresReference: false,
});
assert.deepEqual(workflow.imageMode('image-to-image'), {
  action: 'image_variant',
  requiresReference: true,
});
assert.deepEqual(workflow.imageMode('upscale-image'), {
  action: 'image_variant',
  requiresReference: true,
});
assert.deepEqual(workflow.imageMode('first-frame-draft'), {
  action: 'first_frame_draft',
  requiresReference: false,
});
assert.deepEqual(workflow.imageMode('last-frame-draft'), {
  action: 'last_frame_draft',
  requiresReference: false,
});

assert.equal(workflow.validateImage({
  mode: 'image-to-image',
  prompt: 'variation',
  projectId: 'project-1',
  cardId: 'card-1',
  referenceImageIds: [],
}).valid, false);
assert.equal(workflow.validateImage({
  mode: 'upscale-image',
  prompt: '',
  projectId: 'project-1',
  cardId: 'card-1',
  referenceImageIds: ['reference-1'],
}).valid, true);

assert.deepEqual(workflow.imageRequest({
  ...context,
  mode: 'image-to-image',
  prompt: 'Create a clean variation',
  referenceImageIds: ['reference-1', 'reference-1', 'reference-2'],
  settings: { ratio: '9:16', size: '2K', count: 2 },
}), {
  url: '/api/assets/generate',
  method: 'POST',
  payload: {
    project_id: 'project-1',
    video_card_id: 'card-1',
    canvas_document_id: 'document-1',
    canvas_node_id: 'node-1',
    tab_id: 'ultimate-canvas:project-1:card-1',
    source_request_id: 'ultimate_canvas:node-1:request-1',
    action: 'image_variant',
    input: {
      prompt: 'Create a clean variation',
      ratio: '9:16',
      size: '2K',
      count: 2,
      reference_image_ids: ['reference-1', 'reference-2'],
      mode: 'image-to-image',
    },
  },
});

assert.deepEqual(workflow.videoMode('text-to-video'), {
  generationMode: 'all_in_one_reference',
  minimumReferences: 0,
  maximumReferences: 9,
});
assert.deepEqual(workflow.videoMode('image-to-video'), {
  generationMode: 'all_in_one_reference',
  minimumReferences: 1,
  maximumReferences: 9,
});
assert.deepEqual(workflow.videoMode('first-last-frame-video'), {
  generationMode: 'first_last_frame',
  minimumReferences: 1,
  maximumReferences: 2,
});
assert.deepEqual(workflow.videoMode('smart-multi-frame-video'), {
  generationMode: 'smart_multi_frame',
  minimumReferences: 2,
  maximumReferences: 9,
});
assert.equal(workflow.validateVideo({
  mode: 'smart-multi-frame-video',
  prompt: 'camera move',
  projectId: 'project-1',
  cardId: 'card-1',
  referenceImageIds: ['reference-1'],
  settings: { ratio: '16:9', duration: 5, resolution: '720p' },
}).valid, false);
assert.equal(workflow.validateVideo({
  mode: 'first-last-frame-video',
  prompt: 'camera move',
  projectId: 'project-1',
  cardId: 'card-1',
  referenceImageIds: [],
  settings: { ratio: '16:9', duration: 5, resolution: '720p' },
}).valid, false);

assert.deepEqual(workflow.videoRequest({
  ...context,
  mode: 'first-last-frame-video',
  prompt: 'Slow camera move',
  referenceImageIds: ['first-frame', 'last-frame', 'ignored-frame'],
  settings: {
    ratio: '9:16',
    duration: 6,
    resolution: '1080p',
    generateAudio: true,
    returnLastFrame: true,
    watermark: false,
  },
}), {
  url: '/api/tasks/create',
  method: 'POST',
  payload: {
    prompt: 'Slow camera move',
    generation_mode: 'first_last_frame',
    ratio: '9:16',
    duration: 6,
    resolution: '1080p',
    seed: -1,
    generate_audio: true,
    return_last_frame: true,
    watermark: false,
    project_id: 'project-1',
    video_card_id: 'card-1',
    video_branch_id: 'branch-1',
    reference_image_ids: ['first-frame', 'last-frame'],
    idempotency_key: 'node-1:request-1',
    final_prompt_snapshot: 'Slow camera move',
    prompt_user_edited: true,
    client_name: 'ultimate_canvas',
    source_request_id: 'ultimate_canvas:node-1:request-1',
    source_metadata: {
      source: 'ultimate_canvas',
      canvas_document_id: 'document-1',
      canvas_node_id: 'node-1',
      video_branch_id: 'branch-1',
      mode: 'first-last-frame-video',
      workspace_key: 'ultimate-canvas:project-1:card-1',
    },
  },
});

const smartMultiFrameRequest = workflow.videoRequest({
  ...context,
  mode: 'smart-multi-frame-video',
  prompt: 'Tell a visual story',
  referenceImageIds: ['reference-1', 'reference-2', 'reference-1', 'reference-3', 'reference-4', 'reference-5', 'reference-6', 'reference-7', 'reference-8', 'reference-9', 'reference-10'],
  settings: { ratio: '16:9', duration: 5, resolution: '720p' },
});
assert.deepEqual(smartMultiFrameRequest.payload.reference_image_ids, ['reference-1', 'reference-2', 'reference-3', 'reference-4', 'reference-5', 'reference-6', 'reference-7', 'reference-8', 'reference-9']);
assert.equal(smartMultiFrameRequest.payload.generation_mode, 'smart_multi_frame');

assert.deepEqual(workflow.normalizeImageResult({
  success: true,
  assets: [{
    assetId: 'asset-1',
    referenceImageId: 'reference-1',
    workspaceAssetId: 'workspace-asset-1',
    originalUrl: '/uploads/image.png',
    thumbnailUrl: '/uploads/image-thumb.png',
    fileName: 'image.png',
  }],
}), {
  status: 'succeeded',
  assetId: 'asset-1',
  referenceImageId: 'reference-1',
  workspaceAssetId: 'workspace-asset-1',
  originalUrl: '/uploads/image.png',
  thumbnailUrl: '/uploads/image-thumb.png',
  imageUrl: '/uploads/image-thumb.png',
  fileName: 'image.png',
  assets: [{
    assetId: 'asset-1',
    referenceImageId: 'reference-1',
    workspaceAssetId: 'workspace-asset-1',
    originalUrl: '/uploads/image.png',
    thumbnailUrl: '/uploads/image-thumb.png',
    fileName: 'image.png',
  }],
});

assert.deepEqual(workflow.normalizeVideoCreate({
  id: 'task-1',
  provider_task_id: 'provider-1',
  status: 'submitted',
  frozen_cost: 135,
}), {
  taskId: 'task-1',
  providerTaskId: 'provider-1',
  status: 'submitted',
  frozenCost: 135,
});

assert.deepEqual(workflow.normalizeVideoStatus({
  id: 'task-1',
  local_status: 'succeeded',
  result_video_url: '/uploads/video.mp4',
  result_last_frame_url: '/uploads/last.png',
}), {
  taskId: 'task-1',
  status: 'succeeded',
  errorMessage: '',
  resultVideoUrl: '/uploads/video.mp4',
  resultLastFrameUrl: '/uploads/last.png',
  thumbnailUrl: '/api/video/thumbnail/task-1',
  playUrl: '/api/video/play/task-1',
  downloadUrl: '/api/video/download/task-1',
});

function contains(source: string, needle: string, label: string) {
  assert.ok(source.includes(needle), `${label}: missing ${needle}`);
}

function excludes(source: string, needle: string, label: string) {
  assert.ok(!source.includes(needle), `${label}: still contains ${needle}`);
}

const engineSource = readFileSync('public/tools/ultimate-canvas/canvas-engine.js', 'utf8');
const appSource = readFileSync('public/tools/ultimate-canvas/app.js', 'utf8');
const stylesSource = readFileSync('public/tools/ultimate-canvas/styles.css', 'utf8');
const indexSource = readFileSync('public/tools/ultimate-canvas/index.html', 'utf8');

contains(engineSource, 'data-generation-command="optimize-prompt"', 'video prompt optimizer is actionable');
contains(engineSource, 'data-generation-command="camera-presets"', 'camera presets are actionable');
contains(engineSource, 'data-generation-command="select-reference"', 'reference picker is actionable');
contains(engineSource, 'data-generation-command="toggle-settings"', 'settings are actionable');
contains(engineSource, 'data-generation-reference-list', 'nodes render ordered references');
contains(engineSource, 'data-generation-popover="spec"', 'nodes expose the specification popover trigger');
contains(engineSource, 'data-generation-settings="image"', 'image specification trigger identifies its panel');
contains(engineSource, 'data-generation-settings="video"', 'video specification trigger identifies its panel');
excludes(engineSource, 'data-video-mode=', 'video modes are not permanently rendered in nodes');
contains(engineSource, '后台计费', 'fake fixed point labels are removed');
excludes(engineSource, '<span>智记</span>', 'old inert smart-note button removed');
excludes(engineSource, '<span>角色库</span>', 'old inert character-library button removed');
excludes(engineSource, '<span>高端</span>', 'old inert premium button removed');
excludes(engineSource, '<span>标记</span>', 'old inert mark button removed');
excludes(engineSource, '<span>裁切</span>', 'old inert crop button removed');

contains(stylesSource, '.generation-reference-list', 'reference list layout exists');
contains(stylesSource, '.generation-settings-panel', 'settings panel layout exists');
contains(stylesSource, '@media (max-width: 720px)', 'generation controls have a mobile breakpoint');

contains(appSource, 'function generationSettingsForNode', 'node settings have one persisted source');
contains(appSource, 'function generationReferenceItems', 'incoming image references are ordered');
contains(appSource, 'function renderGenerationNodeControls', 'node controls rehydrate from node data');
contains(appSource, 'function renderSpecPopover', 'specification controls render in the shared popover');
contains(appSource, 'data-generation-setting="ratio"', 'ratio setting exists');
contains(appSource, 'data-generation-setting="size"', 'image size setting exists');
contains(appSource, 'data-generation-setting="count"', 'image count setting exists');
contains(appSource, 'data-generation-setting="duration"', 'video duration setting exists');
contains(appSource, 'data-generation-setting="resolution"', 'video resolution setting exists');
contains(appSource, 'data-generation-setting="generateAudio"', 'video audio setting exists');
contains(appSource, 'data-generation-setting="returnLastFrame"', 'last frame setting exists');
contains(appSource, 'data-generation-setting="watermark"', 'watermark setting exists');
contains(appSource, 'function updateGenerationNodeModelLabel', 'new nodes receive the backend model label');
contains(appSource, 'pendingGenerationReferenceTargetId', 'asset selection targets a generation node');
contains(appSource, 'referenceTarget.x - 720', 'selected reference nodes do not cover their target');
contains(appSource, "imageRequest({", 'image submission uses the contract module');
contains(appSource, 'normalizeImageResult', 'image response uses contract normalization');
contains(appSource, "data-generated-image-action=\"open\"", 'image result can open');
contains(appSource, "data-generated-image-action=\"download\"", 'image result can download');
contains(appSource, "data-generated-image-action=\"regenerate\"", 'image result can regenerate');
contains(appSource, "data-generated-image-action=\"create-video\"", 'image result creates downstream video');
contains(appSource, "scheduleCanvasSave('image_settings_change')", 'image settings persist');
contains(appSource, 'function optimizeVideoPrompt', 'video prompt optimizer calls the text backend');
contains(appSource, 'function renderCameraPresetMenu', 'camera preset menu renders');
contains(appSource, 'function applyCameraPreset', 'camera preset updates the prompt');
contains(appSource, 'UltimateCanvasGenerationInteractions.modeOptions', 'mode values are sourced from the interaction contract');
contains(appSource, 'modeButton.dataset.generationMode', 'popover mode values persist from stable contract ids');
contains(appSource, 'scheduleCanvasSave(`${node.type}_mode_change`)', 'generation mode persists');
contains(appSource, "scheduleCanvasSave('video_settings_change')", 'video settings persist');
contains(appSource, "videoRequest({", 'video submission uses the contract module');
contains(appSource, 'validateVideo({', 'video request is validated by the contract module');
contains(appSource, 'normalizeVideoCreate', 'video create response is normalized');
contains(appSource, 'normalizeVideoStatus', 'video poll response is normalized');
contains(appSource, 'frozenCost', 'frozen point result is displayed from the backend');
contains(appSource, 'data-generated-task-retry', 'terminal video task can retry');
contains(appSource, "scheduleCanvasSave('video_prompt_optimize')", 'optimized video prompt persists');
contains(appSource, "scheduleCanvasSave('video_camera_preset')", 'camera preset persists');

assert.match(
  appSource,
  /capabilities\.image\?\.message\s*\|\|\s*window\.UltimateCanvasBackendContract\.SAFE_UNAVAILABLE_MESSAGE/,
);
assert.match(
  appSource,
  /capabilities\.video\?\.message\s*\|\|\s*window\.UltimateCanvasBackendContract\.SAFE_UNAVAILABLE_MESSAGE/,
);

assert.match(indexSource, /styles\.css\?v=20260715-generated-image-drag/);
assert.match(indexSource, /canvas-engine\.js\?v=20260715-generated-image-drag/);
assert.match(indexSource, /generation-node-workflow\.js\?v=20260711-liblib-interactions/);
assert.match(indexSource, /app\.js\?v=20260715-generated-image-drag/);

console.log('ultimate-canvas-generation-node-workflow-smoke passed');
