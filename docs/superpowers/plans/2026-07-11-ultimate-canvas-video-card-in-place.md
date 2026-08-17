# Ultimate Canvas Video Card In-Place Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有无线画布交互内完整接入 sd2 视频卡、方向、真实生成、版本和生命周期工作流，不新增另一套页面或生成流程。

**Architecture:** 首屏继续由 bootstrap 提供轻量项目和视频卡上下文；视频卡详情、方向和任务在现有视频卡菜单展开时通过已有 API 懒加载。新增一个浏览器/Node 双用的纯工作流模块，集中定义请求描述、方向选择和权限派生，`app.js` 负责当前画布的 DOM、缓存、保存恢复和节点接线。

**Tech Stack:** Next.js 14 App Router、TypeScript、浏览器原生 JavaScript、现有 CanvasEngine、Prisma 既有 API、Node `assert` smoke tests、PowerShell/Node 本机预览。

## Global Constraints

- 后端统一连接 `https://sd2.youdoodesign.com`，生产代码只调用同源 `/api/...`。
- 普通账号必须可用，不得将用户绕成 admin。
- 不读取或修改 `.env`、后台 API 设置、点数核心规则、provider 密钥配置或数据库 schema。
- 不直接使用第三方 API Key。
- 不新增独立视频卡页面、固定侧栏、底部工作台或第二套生成提交流程。
- 不增加视频卡硬删除；继续使用归档、废弃、封板和审批规则。
- 本机 Mock 仅证明 UI 和请求形状，不得写成真实生成或点数验证结果。
- 每个任务必须先运行新增断言并观察预期失败，再写生产实现。

---

## File Structure

- Create `public/tools/ultimate-canvas/video-card-workflow.js`: 纯状态和请求契约，无 DOM、无网络副作用。
- Modify `public/tools/ultimate-canvas/index.html`: 在 `app.js` 前加载工作流模块。
- Modify `public/tools/ultimate-canvas/app.js`: 画布运行时、原位菜单、真实请求、保存恢复、节点动作。
- Modify `public/tools/ultimate-canvas/styles.css`: 原位菜单详情、任务行、表单和响应式样式。
- Create `scripts/smoke/ultimate-canvas-video-card-workflow-smoke.ts`: 纯模块和源码契约测试。
- Create `scripts/smoke/ultimate-canvas-preview-api-smoke.ts`: 启动本机预览服务并测试完整内存 API 闭环。
- Modify `scripts/ultimate-canvas-preview-server.mjs`: 模拟视频卡详情、方向、版本和高级动作。
- Modify `scripts/smoke/ultimate-canvas-complete-smoke.ts`: 保留跨文件总约束。
- Modify `docs/handoffs/ultimate-canvas-implementation-report.md`: 最终回执。

---

### Task 1: 视频卡工作流纯模块与请求契约

**Files:**
- Create: `public/tools/ultimate-canvas/video-card-workflow.js`
- Create: `scripts/smoke/ultimate-canvas-video-card-workflow-smoke.ts`
- Modify: `public/tools/ultimate-canvas/index.html`

**Interfaces:**
- Produces: `window.UltimateCanvasVideoCards` and CommonJS exports.
- Produces: `activeBranches(branches)`, `chooseBranch(branches, preferredId)`, `operationAllowed(detail, operation)`, `requestFor(operation, input)`, `generationContext(input)`.
- Consumes: plain JSON returned by existing sd2 endpoints; no browser globals except optional export target.

- [ ] **Step 1: Write the failing workflow smoke test**

Create `scripts/smoke/ultimate-canvas-video-card-workflow-smoke.ts` with assertions equivalent to:

```ts
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const workflow = require('../public/tools/ultimate-canvas/video-card-workflow.js');
const contains = (source: string, needle: string, label: string) => {
  assert.ok(source.includes(needle), `${label}: missing ${needle}`);
};

const branches = [
  { id: 'closed', status: 'closed', is_primary: false },
  { id: 'main', status: 'primary', is_primary: true },
  { id: 'idea', status: 'exploring', is_primary: false },
];
assert.deepEqual(workflow.activeBranches(branches).map((item: { id: string }) => item.id), ['main', 'idea']);
assert.equal(workflow.chooseBranch(branches, 'closed'), 'main');
assert.equal(workflow.chooseBranch(branches, 'idea'), 'idea');

assert.deepEqual(workflow.requestFor('branch-create', {
  cardId: 'card-1', title: '动作方向', description: '快速移动',
}), {
  url: '/api/video-cards/card-1/branches',
  method: 'POST',
  payload: { title: '动作方向', description: '快速移动' },
});

assert.deepEqual(workflow.requestFor('version-final', {
  cardId: 'card-1', taskId: 'task-1',
}), {
  url: '/api/video-cards/card-1',
  method: 'PATCH',
  payload: { final_task_id: 'task-1' },
});

assert.deepEqual(workflow.generationContext({
  projectId: 'project-1', cardId: 'card-1', branchId: 'branch-1',
  documentId: 'document-1', nodeId: 'node-1', tabId: 'tab-1',
}), {
  project_id: 'project-1', video_card_id: 'card-1', video_branch_id: 'branch-1',
  canvas_document_id: 'document-1', canvas_node_id: 'node-1', tab_id: 'tab-1',
});

const index = readFileSync('public/tools/ultimate-canvas/index.html', 'utf8');
assert.ok(index.includes('video-card-workflow.js'));
assert.ok(index.indexOf('video-card-workflow.js') < index.indexOf('app.js'));
console.log('ultimate-canvas-video-card-workflow-smoke passed');
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npx tsx scripts/smoke/ultimate-canvas-video-card-workflow-smoke.ts`

Expected: FAIL with `Cannot find module '../public/tools/ultimate-canvas/video-card-workflow.js'`.

- [ ] **Step 3: Implement the pure workflow module**

Implement a UMD-style module whose public request map covers these exact operations:

```js
const builders = {
  'card-update': ({ cardId, values }) => ({ url: `/api/video-cards/${encodeURIComponent(cardId)}`, method: 'PATCH', payload: values }),
  'card-seal': ({ cardId }) => ({ url: `/api/video-cards/${encodeURIComponent(cardId)}`, method: 'PATCH', payload: { seal: true } }),
  'card-archive': ({ cardId }) => ({ url: `/api/video-cards/${encodeURIComponent(cardId)}`, method: 'PATCH', payload: { action: 'archive' } }),
  'card-discard': ({ cardId }) => ({ url: `/api/video-cards/${encodeURIComponent(cardId)}`, method: 'PATCH', payload: { action: 'discard' } }),
  'branch-create': ({ cardId, title, description }) => ({ url: `/api/video-cards/${encodeURIComponent(cardId)}/branches`, method: 'POST', payload: { title, description: description || null } }),
  'branch-action': ({ cardId, branchId, action, targetBranchId }) => ({ url: `/api/video-cards/${encodeURIComponent(cardId)}/branches/${encodeURIComponent(branchId)}`, method: 'PATCH', payload: { action, ...(targetBranchId ? { target_branch_id: targetBranchId } : {}) } }),
  'version-candidate': ({ cardId, taskId }) => ({ url: `/api/video-cards/${encodeURIComponent(cardId)}`, method: 'PATCH', payload: { candidate_task_id: taskId } }),
  'version-best': ({ cardId, taskId }) => ({ url: `/api/video-cards/${encodeURIComponent(cardId)}`, method: 'PATCH', payload: { current_best_task_id: taskId } }),
  'version-final': ({ cardId, taskId }) => ({ url: `/api/video-cards/${encodeURIComponent(cardId)}`, method: 'PATCH', payload: { final_task_id: taskId } }),
  'tasks-move': ({ cardId, targetCardId, taskIds, targetBranchId, reason }) => ({ url: `/api/video-cards/${encodeURIComponent(cardId)}/tasks`, method: 'PATCH', payload: { action: 'move', target_video_card_id: targetCardId, task_ids: taskIds, target_branch_id: targetBranchId || null, reason: reason || null } }),
  'card-split': ({ cardId, title, taskIds, reason }) => ({ url: `/api/video-cards/${encodeURIComponent(cardId)}/split`, method: 'POST', payload: { title, task_ids: taskIds, reason: reason || null } }),
  'card-merge': ({ cardId, targetCardId, reason }) => ({ url: `/api/video-cards/${encodeURIComponent(cardId)}/merge`, method: 'POST', payload: { target_video_card_id: targetCardId, reason: reason || null } }),
  'approval-ratio': ({ projectId, cardId, targetRatio, reason }) => ({ url: '/api/approvals', method: 'POST', payload: { type: 'ratio_change', project_id: projectId, video_card_id: cardId, reason, payload: { source: 'ultimate_canvas', target_ratio: targetRatio, change_reason: reason } } }),
  'approval-reopen': ({ projectId, cardId, reason }) => ({ url: '/api/approvals', method: 'POST', payload: { type: 'video_card_reopen', project_id: projectId, video_card_id: cardId, reason, payload: { source: 'ultimate_canvas', target_status: 'active', reopen_reason: reason } } }),
  'task-retry': ({ taskId }) => ({ url: `/api/video/retry/${encodeURIComponent(taskId)}`, method: 'POST', payload: {} }),
};
```

`activeBranches` must retain only `exploring`, `candidate`, and `primary`; `chooseBranch` must retain an active preferred ID, otherwise select primary, otherwise first active, otherwise return an empty string. `operationAllowed` must reject management operations when `permissions.can_manage` is false and reject generation for sealed/merged/archived/discarded cards.

- [ ] **Step 4: Load the module before `app.js`**

Add to `index.html` after `generation-api.js`:

```html
<script src="video-card-workflow.js?v=20260711-in-place"></script>
```

- [ ] **Step 5: Run GREEN verification**

Run:

```powershell
node --check public/tools/ultimate-canvas/video-card-workflow.js
npx tsx scripts/smoke/ultimate-canvas-video-card-workflow-smoke.ts
```

Expected: syntax exit `0`; smoke prints `ultimate-canvas-video-card-workflow-smoke passed`.

- [ ] **Step 6: Commit Task 1**

```powershell
git add public/tools/ultimate-canvas/video-card-workflow.js public/tools/ultimate-canvas/index.html scripts/smoke/ultimate-canvas-video-card-workflow-smoke.ts
git commit -m "feat: add canvas video card workflow contracts"
```

---

### Task 2: 方向上下文、缓存和保存恢复

**Files:**
- Modify: `public/tools/ultimate-canvas/app.js`
- Modify: `scripts/smoke/ultimate-canvas-video-card-workflow-smoke.ts`
- Modify: `scripts/smoke/ultimate-canvas-complete-smoke.ts`

**Interfaces:**
- Consumes: `UltimateCanvasVideoCards.chooseBranch` and `generationContext` from Task 1.
- Produces: runtime fields `selectedVideoBranchId`, `videoCardDetails`, `videoCardBranches`, `videoCardTasks`, `videoCardLoads`, `videoCardView`.
- Produces: `loadVideoCardWorkspace(cardId, { force })`, `invalidateVideoCardWorkspace(cardId)`, `selectVideoBranch(branchId)`.

- [ ] **Step 1: Add failing source-contract assertions**

Append assertions requiring these source fragments:

```ts
contains(app, 'selectedVideoBranchId: null', 'runtime tracks selected branch');
contains(app, 'videoCardBranches: new Map()', 'runtime caches card branches');
contains(app, 'loadVideoCardWorkspace', 'card detail is lazy loaded');
contains(app, 'video_branch_id: canvasRuntime.selectedVideoBranchId || null', 'save stores selected branch');
contains(app, 'parsed?.context?.video_branch_id', 'restore reads selected branch');
contains(app, 'UltimateCanvasVideoCards.generationContext', 'generation uses shared context builder');
```

- [ ] **Step 2: Run RED verification**

Run: `npx tsx scripts/smoke/ultimate-canvas-video-card-workflow-smoke.ts`

Expected: FAIL on `runtime tracks selected branch`.

- [ ] **Step 3: Add runtime state and lazy loading**

Extend `canvasRuntime` with the fields above. Implement `loadVideoCardWorkspace` with one in-flight promise per card and parallel same-origin GET requests:

```js
const request = Promise.all([
  requestJson(`/api/video-cards/${encodeURIComponent(cardId)}`, { cache: 'no-store' }),
  requestJson(`/api/video-cards/${encodeURIComponent(cardId)}/branches`, { cache: 'no-store' }),
  requestJson(`/api/video-cards/${encodeURIComponent(cardId)}/tasks`, { cache: 'no-store' })
]).then(([detail, branches, tasks]) => {
  canvasRuntime.videoCardDetails.set(cardId, detail);
  canvasRuntime.videoCardBranches.set(cardId, branches.branches || []);
  canvasRuntime.videoCardTasks.set(cardId, tasks.tasks || []);
  canvasRuntime.selectedVideoBranchId = workflow.chooseBranch(branches.branches || [], canvasRuntime.selectedVideoBranchId);
  return { detail, branches: branches.branches || [], tasks: tasks.tasks || [] };
}).finally(() => canvasRuntime.videoCardLoads.delete(cardId));
```

Switching projects must clear all four maps and the selected branch. Switching cards must stop task polling belonging to the old card, save the old document, then select the new card and validate its branch.

- [ ] **Step 4: Persist and restore branch context**

Add `video_branch_id` to `canvasDocumentPayload().context`. On restore, capture the saved branch ID before rendering nodes, load current branches, then call `chooseBranch`. Add each video node's `videoCardId` and `videoBranchId` to serialized node data.

- [ ] **Step 5: Include branch in all generation context payloads**

Replace the hand-built base object with `UltimateCanvasVideoCards.generationContext`, preserving `client_name`, `source_request_id`, and source metadata already required by the canvas.

- [ ] **Step 6: Run GREEN verification**

Run:

```powershell
node --check public/tools/ultimate-canvas/app.js
npx tsx scripts/smoke/ultimate-canvas-video-card-workflow-smoke.ts
npx tsx scripts/smoke/ultimate-canvas-complete-smoke.ts
```

Expected: all commands exit `0` and both smoke scripts print `passed`.

- [ ] **Step 7: Commit Task 2**

```powershell
git add public/tools/ultimate-canvas/app.js scripts/smoke/ultimate-canvas-video-card-workflow-smoke.ts scripts/smoke/ultimate-canvas-complete-smoke.ts
git commit -m "feat: persist canvas video branch context"
```

---

### Task 3: 现有视频卡菜单原位管理界面

**Files:**
- Modify: `public/tools/ultimate-canvas/app.js`
- Modify: `public/tools/ultimate-canvas/styles.css`
- Modify: `scripts/smoke/ultimate-canvas-video-card-workflow-smoke.ts`

**Interfaces:**
- Consumes: Task 2 cache/load functions.
- Produces: list/detail views inside existing `[data-context-menu="video-card"]`.
- Produces event selectors: `data-video-card-search`, `data-video-card-manage`, `data-video-card-view-back`, `data-video-card-section`, `data-video-card-refresh`.

- [ ] **Step 1: Add failing menu assertions**

Require the source to contain all selectors above and CSS to contain `.video-card-context-detail`, `.video-card-section-tabs`, `.video-card-task-list`, and a mobile media rule that constrains menu width to the viewport.

- [ ] **Step 2: Run RED verification**

Run: `npx tsx scripts/smoke/ultimate-canvas-video-card-workflow-smoke.ts`

Expected: FAIL on `data-video-card-search`.

- [ ] **Step 3: Implement list mode in the existing menu**

Keep project and video card triggers unchanged. Add a search input, refresh button, card count, and per-row manage icon. On first open, call `GET /api/projects/:id/video-cards`, replace the current project's card list in bootstrap, and filter by title, objective, owner, status, or spec text without another request.

- [ ] **Step 4: Implement detail mode in the same menu**

Add a back icon and four compact tabs: `信息`, `方向`, `记录`, `操作`. The detail renderer must read cached server data and show a loading/error/retry state without closing the menu. Opening detail calls `loadVideoCardWorkspace(cardId)`; changing tabs performs no navigation.

- [ ] **Step 5: Add stable responsive styles**

Use a maximum width of `min(560px, calc(100vw - 24px))`, a maximum body height based on viewport, fixed tab dimensions, scroll only inside the menu body, and single-column forms below `640px`. Do not change canvas dimensions or add fixed side/bottom regions.

- [ ] **Step 6: Run GREEN and visual static checks**

Run:

```powershell
node --check public/tools/ultimate-canvas/app.js
npx tsx scripts/smoke/ultimate-canvas-video-card-workflow-smoke.ts
git diff --check
```

Expected: all exit `0`.

- [ ] **Step 7: Commit Task 3**

```powershell
git add public/tools/ultimate-canvas/app.js public/tools/ultimate-canvas/styles.css scripts/smoke/ultimate-canvas-video-card-workflow-smoke.ts
git commit -m "feat: add in-place video card menu"
```

---

### Task 4: 卡片信息、生命周期和审批申请

**Files:**
- Modify: `public/tools/ultimate-canvas/app.js`
- Modify: `public/tools/ultimate-canvas/styles.css`
- Modify: `scripts/smoke/ultimate-canvas-video-card-workflow-smoke.ts`

**Interfaces:**
- Consumes: `requestFor` operations `card-update`, `card-seal`, `card-archive`, `card-discard`, `approval-ratio`, `approval-reopen`.
- Produces: `executeVideoCardOperation(operation, input)`, which calls `requestJson`, invalidates cache, reloads bootstrap and preserves the open menu when valid.

- [ ] **Step 1: Add failing assertions for forms and operations**

Assert presence of `data-video-card-info-form`, `data-video-card-seal`, `data-video-card-approval-ratio`, `data-video-card-approval-reopen`, and calls to `UltimateCanvasVideoCards.requestFor`.

- [ ] **Step 2: Run RED verification**

Run: `npx tsx scripts/smoke/ultimate-canvas-video-card-workflow-smoke.ts`

Expected: FAIL on `data-video-card-info-form`.

- [ ] **Step 3: Implement editable card information**

Render title, objective, platform, ratio, duration, target resolution, budget credits and budget currency. Only render enabled fields when server `permissions.can_manage` is true and the card is not sealed/archived. Submit a minimal patch containing only changed fields; keep user input after 400/403/409 responses.

- [ ] **Step 4: Implement lifecycle confirmations**

Reuse the existing confirmation overlay. The confirmation detail must include card title, status, task count and branch count. On success, reload the project card list; if the selected card is no longer generatable, choose the next active card or leave the canvas in an explicit no-card state.

- [ ] **Step 5: Implement inline approval requests**

For constrained ratio changes, submit `approval-ratio` with project/card IDs, target ratio and reason. For sealed/archived cards, submit `approval-reopen` with reason. Do not approve requests or elevate user roles from the canvas.

- [ ] **Step 6: Run GREEN verification**

Run:

```powershell
node --check public/tools/ultimate-canvas/app.js
npx tsx scripts/smoke/ultimate-canvas-video-card-workflow-smoke.ts
npx tsx scripts/smoke/ultimate-canvas-normal-user-access-smoke.ts
```

Expected: all exit `0`.

- [ ] **Step 7: Commit Task 4**

```powershell
git add public/tools/ultimate-canvas/app.js public/tools/ultimate-canvas/styles.css scripts/smoke/ultimate-canvas-video-card-workflow-smoke.ts
git commit -m "feat: manage video cards within canvas"
```

---

### Task 5: 方向操作和真实生成提交

**Files:**
- Modify: `public/tools/ultimate-canvas/app.js`
- Modify: `public/tools/ultimate-canvas/styles.css`
- Modify: `scripts/smoke/ultimate-canvas-video-card-workflow-smoke.ts`
- Modify: `scripts/smoke/ultimate-canvas-context-rules-smoke.ts`

**Interfaces:**
- Consumes: `requestFor('branch-create'|'branch-action')` and Task 2 selected branch state.
- Produces: branch selectors in the existing card menu and existing video prompt window.
- Produces: real `/api/tasks/create` payload carrying `video_branch_id`.

- [ ] **Step 1: Add failing branch and submission assertions**

Require source markers for branch create, set primary, close, merge, promote, branch selection in prompt UI, and exact `video_branch_id` inclusion in the task payload and saved node data.

- [ ] **Step 2: Run RED verification**

Run:

```powershell
npx tsx scripts/smoke/ultimate-canvas-video-card-workflow-smoke.ts
npx tsx scripts/smoke/ultimate-canvas-context-rules-smoke.ts
```

Expected: workflow smoke fails on missing branch controls.

- [ ] **Step 3: Render and mutate directions**

Render active and historical directions with summary counts. Implement create, select, set primary, close, merge to primary and promote to card through existing APIs. After each mutation, force-reload branches and choose a valid branch using the pure helper.

- [ ] **Step 4: Add direction to the existing prompt window**

Insert a branch `<select>` into the current video prompt properties, not a separate dialog. Updating it calls `selectVideoBranch`, updates the node's `videoBranchId`, and schedules document save.

- [ ] **Step 5: Submit to the real capability endpoint**

Keep the endpoint from `bootstrap.capabilities.video.endpoint` with `/api/tasks/create` fallback. Include project/card/branch/document/node IDs, generation parameters, reference IDs, idempotency key and `source_metadata.source = 'ultimate_canvas'`. Do not add any preview-server URL or third-party provider URL to product code.

- [ ] **Step 6: Run GREEN verification**

Run:

```powershell
node --check public/tools/ultimate-canvas/app.js
npx tsx scripts/smoke/ultimate-canvas-video-card-workflow-smoke.ts
npx tsx scripts/smoke/ultimate-canvas-context-rules-smoke.ts
npx tsx scripts/smoke/ultimate-canvas-complete-smoke.ts
```

Expected: all exit `0`.

- [ ] **Step 7: Commit Task 5**

```powershell
git add public/tools/ultimate-canvas/app.js public/tools/ultimate-canvas/styles.css scripts/smoke/ultimate-canvas-video-card-workflow-smoke.ts scripts/smoke/ultimate-canvas-context-rules-smoke.ts scripts/smoke/ultimate-canvas-complete-smoke.ts
git commit -m "feat: bind canvas generation to video branches"
```

---

### Task 6: 任务记录、版本、重试、迁移、拆分和合并

**Files:**
- Modify: `public/tools/ultimate-canvas/app.js`
- Modify: `public/tools/ultimate-canvas/styles.css`
- Modify: `scripts/smoke/ultimate-canvas-video-card-workflow-smoke.ts`

**Interfaces:**
- Consumes: Task 1 operations `version-*`, `task-retry`, `tasks-move`, `card-split`, `card-merge`.
- Produces: `refreshVideoTaskNode(task)`, `executeTaskVersion`, `retryVideoTask`, `moveVideoTasks`, `splitVideoCard`, `mergeVideoCard`.

- [ ] **Step 1: Add failing advanced-operation assertions**

Assert that task rows contain version controls and that result nodes expose play, download, retry, candidate, best and final actions. Assert source includes task move, card split and card merge request descriptors.

- [ ] **Step 2: Run RED verification**

Run: `npx tsx scripts/smoke/ultimate-canvas-video-card-workflow-smoke.ts`

Expected: FAIL on the first missing task action selector.

- [ ] **Step 3: Render task history and version roles**

In the existing menu's `记录` section render status, owner, branch, created time, point fields and current version role. For successful tasks, add candidate/current-best/final controls gated by `permissions.can_manage`. Refresh card detail and task list after each server-confirmed mutation.

- [ ] **Step 4: Enhance existing video result nodes**

Extend the existing generated action row with play/download links and permission-gated retry/version buttons. `refreshVideoTaskNode` must update both runtime node data and DOM without recreating the canvas node, then schedule save.

- [ ] **Step 5: Implement task migration and card split**

Use checkboxes in the current `记录` section. Migration asks for target card, optional target branch and reason. Split asks for a new title and reason. Preserve checked tasks when the server returns 400/403/409.

- [ ] **Step 6: Implement card merge**

In the current `操作` section choose an eligible target card from the refreshed project list and require a reason. Confirmation must show source and target card names. On success, select the target card and reload its details, branches and tasks.

- [ ] **Step 7: Preserve polling correctness**

Keep one serial timeout per task. Stop polling at terminal states, on node deletion and on context switch. A retry response with a new task ID must replace the node task identity and start exactly one new poll loop.

- [ ] **Step 8: Run GREEN verification**

Run:

```powershell
node --check public/tools/ultimate-canvas/app.js
npx tsx scripts/smoke/ultimate-canvas-video-card-workflow-smoke.ts
npx tsx scripts/smoke/ultimate-canvas-complete-smoke.ts
```

Expected: all exit `0`.

- [ ] **Step 9: Commit Task 6**

```powershell
git add public/tools/ultimate-canvas/app.js public/tools/ultimate-canvas/styles.css scripts/smoke/ultimate-canvas-video-card-workflow-smoke.ts scripts/smoke/ultimate-canvas-complete-smoke.ts
git commit -m "feat: complete canvas video card task workflow"
```

---

### Task 7: 本机 API 闭环、视觉验收和交付回执

**Files:**
- Create: `scripts/smoke/ultimate-canvas-preview-api-smoke.ts`
- Modify: `scripts/ultimate-canvas-preview-server.mjs`
- Modify: `docs/handoffs/ultimate-canvas-implementation-report.md`

**Interfaces:**
- Preview server must simulate all product endpoints without reading env, DB or online services.
- Preview smoke owns a child preview server on an unused loopback port and terminates it in `finally`.

- [ ] **Step 1: Write the failing preview API smoke**

Create a script that starts `node scripts/ultimate-canvas-preview-server.mjs <port>`, then tests:

```ts
const detail = await get(`/api/video-cards/${cardId}`);
assert.equal(detail.permissions.can_manage, true);
const branch = await post(`/api/video-cards/${cardId}/branches`, { title: '动作方向' });
await patch(`/api/video-cards/${cardId}/branches/${branch.branch.id}`, { action: 'set_primary' });
const task = await post('/api/tasks/create', { project_id: projectId, video_card_id: cardId, video_branch_id: branch.branch.id });
await patch(`/api/video-cards/${cardId}`, { candidate_task_id: task.id });
await patch(`/api/video-cards/${cardId}/tasks`, { action: 'move', target_video_card_id: targetCardId, task_ids: [task.id] });
await post(`/api/video-cards/${targetCardId}/split`, { title: '拆分卡', task_ids: [task.id] });
await post(`/api/video-cards/${targetCardId}/merge`, { target_video_card_id: cardId, reason: '闭环验证' });
const approval = await post('/api/approvals', { type: 'ratio_change', project_id: projectId, video_card_id: cardId, payload: { target_ratio: '9:16', change_reason: '测试' } });
assert.equal(approval.approval.status, 'pending');
```

- [ ] **Step 2: Run RED verification**

Run: `npx tsx scripts/smoke/ultimate-canvas-preview-api-smoke.ts`

Expected: FAIL because the preview server returns `501` for the first unimplemented video-card endpoint.

- [ ] **Step 3: Implement in-memory preview endpoints**

Add in-memory branches, tasks, version IDs and approvals. Implement the exact existing API paths from the design; never call `https://sd2.youdoodesign.com` or any provider. Reset state on server restart and return `frozen_cost: 0` for mock tasks.

- [ ] **Step 4: Run preview GREEN verification**

Run:

```powershell
node --check scripts/ultimate-canvas-preview-server.mjs
npx tsx scripts/smoke/ultimate-canvas-preview-api-smoke.ts
```

Expected: syntax exit `0`; smoke prints `ultimate-canvas-preview-api-smoke passed`.

- [ ] **Step 5: Run full automated verification**

Run:

```powershell
git diff --check
node --check public/tools/ultimate-canvas/video-card-workflow.js
node --check public/tools/ultimate-canvas/app.js
node --check public/tools/ultimate-canvas/canvas-engine.js
npx tsc --noEmit --pretty false
npx tsx scripts/smoke/ultimate-canvas-video-card-workflow-smoke.ts
npx tsx scripts/smoke/ultimate-canvas-preview-api-smoke.ts
npx tsx scripts/smoke/ultimate-canvas-complete-smoke.ts
npx tsx scripts/smoke/ultimate-canvas-normal-user-access-smoke.ts
npx tsx scripts/smoke/ultimate-canvas-context-rules-smoke.ts
npm run lint
npm run build
```

Expected: all exit `0`; existing unrelated warnings may remain but must be recorded verbatim in the report.

- [ ] **Step 6: Perform browser visual QA**

Start the loopback preview server and inspect at least `1440x900` and `390x844`. Verify:

- current canvas remains full size;
- video card menu list/detail modes stay within viewport;
- card forms, direction rows and task actions do not overlap;
- selecting a branch updates the existing prompt window;
- a mock task progresses `submitted/running -> succeeded` without duplicating the node;
- destructive confirmations name source and target cards.

- [ ] **Step 7: Update the implementation report**

Update all ten required report sections with exact changed files, validation commands and outcomes. State separately:

- product code is wired to real same-origin sd2 endpoints;
- whether a deployed ordinary-account test was performed;
- whether text/image/video were actually generated online;
- whether points were consumed;
- restricted configuration and core credit logic were untouched.

- [ ] **Step 8: Commit Task 7**

```powershell
git add scripts/smoke/ultimate-canvas-preview-api-smoke.ts scripts/ultimate-canvas-preview-server.mjs docs/handoffs/ultimate-canvas-implementation-report.md
git commit -m "test: verify complete canvas video card workflow"
```

- [ ] **Step 9: Attempt delivery push and create fallback patch**

Run:

```powershell
git push origin teammate/ultimate-canvas-complete
git diff --binary origin/teammate/ultimate-canvas-complete HEAD --output=..\ultimate-canvas-complete-final.patch
git apply --check --reverse ..\ultimate-canvas-complete-final.patch
Get-FileHash -Algorithm SHA256 ..\ultimate-canvas-complete-final.patch
```

Expected: push succeeds when credentials permit. If push returns `403`, preserve the clean branch, verified patch, report path and SHA256 for handoff.

---

## Plan Self-Review

- Every design requirement maps to a task: context/save in Task 2, in-place UI in Task 3, card management in Task 4, branches/real submission in Task 5, versions/advanced operations in Task 6, preview/verification/report in Task 7.
- New production behavior has an explicit RED command before implementation and a GREEN command after implementation.
- The plan uses only existing sd2 API routes and does not require schema, provider, secret or credit-core edits.
- `video_branch_id`, task identity and version roles use consistent names across module, app, save format and tests.
- No independent page, fixed workbench or admin bypass is introduced.
