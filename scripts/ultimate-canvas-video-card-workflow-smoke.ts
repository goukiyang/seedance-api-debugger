import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const workflow = require('../public/tools/ultimate-canvas/video-card-workflow.js');

function contains(source: string, needle: string, label: string) {
  assert.ok(source.includes(needle), `${label}: missing ${needle}`);
}

function request(operation: string, input: Record<string, unknown>) {
  return workflow.requestFor(operation, input);
}

const branches = [
  { id: 'closed', status: 'closed', is_primary: false },
  { id: 'main', status: 'primary', is_primary: true },
  { id: 'idea', status: 'exploring', is_primary: false },
  { id: 'candidate', status: 'candidate', is_primary: false },
];

assert.deepEqual(
  workflow.activeBranches(branches).map((item: { id: string }) => item.id),
  ['main', 'idea', 'candidate'],
);
assert.equal(workflow.chooseBranch(branches, 'closed'), 'main');
assert.equal(workflow.chooseBranch(branches, 'idea'), 'idea');
assert.equal(workflow.chooseBranch([], 'idea'), '');

assert.equal(workflow.operationAllowed({
  video_card: { status: 'active' },
  permissions: { can_generate: true, can_manage: false },
}, 'generate'), true);
assert.equal(workflow.operationAllowed({
  video_card: { status: 'sealed' },
  permissions: { can_generate: true, can_manage: true },
}, 'generate'), false);
assert.equal(workflow.operationAllowed({
  video_card: { status: 'active' },
  permissions: { can_generate: true, can_manage: false },
}, 'card-update'), false);

assert.deepEqual(request('card-update', {
  cardId: 'card 1',
  values: { title: '开场镜头' },
}), {
  url: '/api/video-cards/card%201',
  method: 'PATCH',
  payload: { title: '开场镜头' },
});
assert.deepEqual(request('card-seal', { cardId: 'card-1' }), {
  url: '/api/video-cards/card-1',
  method: 'PATCH',
  payload: { seal: true },
});
assert.deepEqual(request('card-archive', { cardId: 'card-1' }), {
  url: '/api/video-cards/card-1',
  method: 'PATCH',
  payload: { action: 'archive' },
});
assert.deepEqual(request('card-discard', { cardId: 'card-1' }), {
  url: '/api/video-cards/card-1',
  method: 'PATCH',
  payload: { action: 'discard' },
});
assert.deepEqual(request('branch-create', {
  cardId: 'card-1',
  title: '动作方向',
  description: '快速移动',
}), {
  url: '/api/video-cards/card-1/branches',
  method: 'POST',
  payload: { title: '动作方向', description: '快速移动' },
});
assert.deepEqual(request('branch-create', {
  cardId: 'card-1',
  title: '第六方向',
  confirmOverLimit: true,
}), {
  url: '/api/video-cards/card-1/branches',
  method: 'POST',
  payload: { title: '第六方向', description: null, confirm_over_limit: true },
});
assert.deepEqual(request('branch-action', {
  cardId: 'card-1',
  branchId: 'branch-1',
  action: 'merge',
  targetBranchId: 'branch-main',
}), {
  url: '/api/video-cards/card-1/branches/branch-1',
  method: 'PATCH',
  payload: { action: 'merge', target_branch_id: 'branch-main' },
});
assert.deepEqual(request('branch-action', {
  cardId: 'card-1',
  branchId: 'branch-1',
  action: 'promote_to_card',
  title: '动作独立卡',
  reason: '方向成熟',
}), {
  url: '/api/video-cards/card-1/branches/branch-1',
  method: 'PATCH',
  payload: { action: 'promote_to_card', title: '动作独立卡', reason: '方向成熟' },
});
assert.deepEqual(request('version-candidate', { cardId: 'card-1', taskId: 'task-1' }), {
  url: '/api/video-cards/card-1',
  method: 'PATCH',
  payload: { candidate_task_id: 'task-1' },
});
assert.deepEqual(request('version-best', { cardId: 'card-1', taskId: 'task-1' }), {
  url: '/api/video-cards/card-1',
  method: 'PATCH',
  payload: { current_best_task_id: 'task-1' },
});
assert.deepEqual(request('version-final', { cardId: 'card-1', taskId: 'task-1' }), {
  url: '/api/video-cards/card-1',
  method: 'PATCH',
  payload: { final_task_id: 'task-1' },
});
assert.deepEqual(request('tasks-move', {
  cardId: 'card-1',
  targetCardId: 'card-2',
  taskIds: ['task-1'],
  targetBranchId: 'branch-2',
  reason: '整理版本',
}), {
  url: '/api/video-cards/card-1/tasks',
  method: 'PATCH',
  payload: {
    action: 'move',
    target_video_card_id: 'card-2',
    task_ids: ['task-1'],
    target_branch_id: 'branch-2',
    reason: '整理版本',
  },
});
assert.deepEqual(request('card-split', {
  cardId: 'card-1',
  title: '产品特写',
  taskIds: ['task-1'],
  reason: '独立方向',
}), {
  url: '/api/video-cards/card-1/split',
  method: 'POST',
  payload: { title: '产品特写', task_ids: ['task-1'], reason: '独立方向' },
});
assert.deepEqual(request('card-merge', {
  cardId: 'card-1',
  targetCardId: 'card-2',
  reason: '收敛方向',
}), {
  url: '/api/video-cards/card-1/merge',
  method: 'POST',
  payload: { target_video_card_id: 'card-2', reason: '收敛方向' },
});
assert.deepEqual(request('approval-ratio', {
  projectId: 'project-1',
  cardId: 'card-1',
  targetRatio: '9:16',
  reason: '竖屏交付',
}), {
  url: '/api/approvals',
  method: 'POST',
  payload: {
    type: 'ratio_change',
    project_id: 'project-1',
    video_card_id: 'card-1',
    reason: '竖屏交付',
    payload: {
      source: 'ultimate_canvas',
      target_ratio: '9:16',
      change_reason: '竖屏交付',
    },
  },
});
assert.deepEqual(request('approval-reopen', {
  projectId: 'project-1',
  cardId: 'card-1',
  reason: '继续修改',
}), {
  url: '/api/approvals',
  method: 'POST',
  payload: {
    type: 'video_card_reopen',
    project_id: 'project-1',
    video_card_id: 'card-1',
    reason: '继续修改',
    payload: {
      source: 'ultimate_canvas',
      target_status: 'active',
      reopen_reason: '继续修改',
    },
  },
});
assert.deepEqual(request('task-retry', { taskId: 'task-1' }), {
  url: '/api/video/retry/task-1',
  method: 'POST',
  payload: {},
});

assert.deepEqual(workflow.generationContext({
  projectId: 'project-1',
  cardId: 'card-1',
  branchId: 'branch-1',
  documentId: 'document-1',
  nodeId: 'node-1',
  tabId: 'tab-1',
}), {
  project_id: 'project-1',
  video_card_id: 'card-1',
  video_branch_id: 'branch-1',
  canvas_document_id: 'document-1',
  canvas_node_id: 'node-1',
  tab_id: 'tab-1',
});

assert.throws(() => request('unknown-operation', {}), /不支持的视频卡操作/);

const app = readFileSync('public/tools/ultimate-canvas/app.js', 'utf8');
contains(app, 'selectedVideoBranchId: null', 'runtime tracks selected branch');
contains(app, 'videoCardDetails: new Map()', 'runtime caches card detail');
contains(app, 'videoCardBranches: new Map()', 'runtime caches card branches');
contains(app, 'videoCardTasks: new Map()', 'runtime caches card tasks');
contains(app, 'videoCardLoads: new Map()', 'runtime deduplicates card loads');
contains(app, 'async function loadVideoCardWorkspace', 'card workspace is lazy loaded');
contains(app, 'function invalidateVideoCardWorkspace', 'card cache can be invalidated');
contains(
  app,
  'video_branch_id: canvasRuntime.selectedVideoBranchId || null',
  'save stores selected branch',
);
contains(app, 'parsed?.context?.video_branch_id', 'restore reads selected branch');
contains(
  app,
  'UltimateCanvasVideoCards.generationContext',
  'generation uses shared context builder',
);
contains(app, 'data-video-card-search', 'video card list has search');
contains(app, 'data-video-card-refresh', 'video card list has refresh');
contains(app, 'data-video-card-manage', 'video card rows open in-place management');
contains(app, 'data-video-card-view-back', 'video card detail returns to list');
contains(app, 'data-video-card-section', 'video card detail has in-place sections');
contains(app, 'async function refreshProjectVideoCards', 'menu refreshes complete project cards');
contains(app, 'data-video-card-info-form', 'video card info is editable in place');
contains(app, 'data-video-card-seal', 'video card can be sealed in place');
contains(app, 'data-video-card-approval-ratio', 'ratio approval is requested in place');
contains(app, 'data-video-card-approval-reopen', 'reopen approval is requested in place');
contains(app, 'async function executeVideoCardOperation', 'card mutations share one executor');
contains(app, 'UltimateCanvasVideoCards.requestFor', 'card mutations use shared request contracts');
contains(
  app,
  'const canRequestApproval = Boolean(detail?.video_card)',
  'viewable cards can request approval without admin or generate permission',
);
contains(app, 'data-video-branch-create-form', 'branches can be created in place');
contains(app, 'data-video-branch-select', 'active branch can be selected');
contains(app, 'data-video-branch-action', 'branch lifecycle actions are available');
contains(app, 'async function executeVideoBranchAction', 'branch actions use one executor');
contains(app, 'data-video-branch-prompt-select', 'video prompt contains branch selector');
contains(
  app,
  'videoBranchId: canvasRuntime.selectedVideoBranchId',
  'video node persists selected branch',
);
contains(
  app,
  'branchId: payload.videoBranchId || canvasRuntime.selectedVideoBranchId',
  'real generation uses node or canvas branch',
);
contains(app, "scheduleCanvasSave('prompt_modal_save')", 'prompt modal saves branch and prompt');

const styles = readFileSync('public/tools/ultimate-canvas/styles.css', 'utf8');
contains(styles, '.video-card-context-detail', 'video card detail styles exist');
contains(styles, '.video-card-section-tabs', 'video card section tabs are stable');
contains(styles, '.video-card-task-list', 'video card task list has stable layout');
contains(
  styles,
  'max-width: min(560px, calc(100vw - 24px))',
  'video card menu is constrained to viewport',
);

const index = readFileSync('public/tools/ultimate-canvas/index.html', 'utf8');
assert.ok(index.includes('video-card-workflow.js'), 'index loads video card workflow');
assert.ok(
  index.indexOf('video-card-workflow.js') < index.indexOf('app.js'),
  'workflow loads before app',
);

console.log('ultimate-canvas-video-card-workflow-smoke passed');
