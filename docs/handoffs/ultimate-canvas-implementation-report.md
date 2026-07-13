# 无线画布完整实施回执

日期：2026-07-11

分支：`teammate/ultimate-canvas-complete`

Task 8 基线：`f72fc26716ef43d4905e5ea03bb511139c32f20e`

## 1. 本次目标理解

本系列工作在现有无线画布内完成项目、视频卡、图片与视频生成节点的原位交互闭环，不新建第二套生成流程。Task 8 增加最低优先级的视频点数预估：每个视频节点独立防抖 350ms，参数变化会中止上一请求，只调用同源现有 `/api/tasks/estimate?resolution=...&duration=...`。预估仅供参考，成功显示“预计 N 点”，失败显示“提交后由后台计算”，不影响提交按钮；图片继续显示“后台计费”。前端不保存计价公式，预估状态也不进入画布文档。

## 2. 实际修改了哪些文件

从交付起点到 Task 8 的修改/新增文件如下：

- 前端：`public/tools/ultimate-canvas/app.js`、`canvas-engine.js`、`canvas-save-coordinator.js`、`generation-node-interactions.js`、`generation-node-workflow.js`、`generation-task-coordinator.js`、`video-card-workflow.js`、`index.html`、`styles.css`。
- 本地预览与自动验证：`scripts/ultimate-canvas-preview-server.mjs`、`ultimate-canvas-preview-api-smoke.ts`、`ultimate-canvas-generation-lifecycle-smoke.ts`、`ultimate-canvas-save-coordinator-smoke.ts`、`ultimate-canvas-generation-node-interactions-smoke.ts`、`ultimate-canvas-result-layout-smoke.ts`、`ultimate-canvas-generation-node-workflow-smoke.ts`、`ultimate-canvas-generation-task-coordinator-smoke.ts`、`ultimate-canvas-video-card-workflow-smoke.ts`、`ultimate-canvas-complete-smoke.ts`、`ultimate-canvas-context-rules-smoke.ts`、`ultimate-canvas-normal-user-access-smoke.ts`。
- 既有接口与显示规则：`src/app/api/tools/ultimate-canvas/bootstrap/route.ts`、`src/app/api/video-cards/[id]/route.ts`、`src/app/api/video-cards/[id]/tasks/route.ts`、`src/app/api/video/retry/[id]/route.ts`、`src/lib/projects/display.ts`、`src/lib/video-cards/display.ts`。
- 设计、计划与回执：`docs/superpowers/specs/2026-07-11-ultimate-canvas-generation-nodes-design.md`、`2026-07-11-ultimate-canvas-video-card-in-place-design.md`、`2026-07-11-ultimate-canvas-liblib-interactions-design.md`，对应三个计划文件，以及本回执。
- Task 8 另同步了三个旧烟测中的最终 cache key 断言：`ultimate-canvas-generation-node-workflow-smoke.ts`、`ultimate-canvas-context-rules-smoke.ts`、`ultimate-canvas-video-card-workflow-smoke.ts`。

## 3. 每个文件改了什么

- `app.js`：完成项目/视频卡上下文、引用选择、节点折叠与弹层、图片原位结果、下游视频创建、视频任务轮询恢复，以及 Task 8 的瞬时视频预估。预估以分辨率和时长签名防止旧响应覆盖新设置；单节点删除执行定向清理，整画布清空、文档恢复、项目/视频卡上下文切换及 `pagehide` 均在替换上下文前执行全量清理。
- `canvas-engine.js`、`styles.css`：提供固定尺寸节点、节点下方编辑面板、单一弹层入口、引用兼容/禁用状态、稳定结果区域和窄屏布局；图片与视频均保留可编辑提交控件，选中状态不再改变卡片尺寸。
- 三个 generation 模块：分别集中交互纯函数、生成请求/响应契约和任务轮询协调，覆盖引用去重、持久化清洗、连接回滚、轮询替换及过期响应保护。`generation-node-interactions.js` 还提供生产与烟测共用的 `clearVideoEstimateEntries`：每个非空 timer 清理一次、每个 controller 中止一次，即使中止抛错也继续并最终清空 Map。
- `video-card-workflow.js`：集中视频卡、方向、任务版本、重试、迁移、拆分、合并和审批请求契约。
- `index.html`：按依赖顺序加载模块；最终 hardening 生产模块 `generation-node-interactions.js`、`generation-task-coordinator.js`、`canvas-save-coordinator.js`、`app.js` 使用 cache key `20260712-final-hardening`。未在 hardening 中修改的 `styles.css`、`canvas-engine.js`、`generation-node-workflow.js` 保留其既有 `20260711-liblib-interactions` key。
- `ultimate-canvas-preview-server.mjs`：仅监听本机并以内存 mock 覆盖画布 API；Task 8 的 `/api/tasks/estimate` mock 使用 `Math.ceil(duration * 3)`，该公式只存在于预览服务器，不进入生产文件。
- 烟测脚本：覆盖普通用户权限、上下文隔离、节点模式和参数、引用选择、原位结果、连接回滚、轮询协调、保存恢复、预览 API、选中节点尺寸稳定，以及 Task 8 的预估端点、350ms 防抖、请求中止、签名保护和文案。
- 既有后端文件：补齐画布 bootstrap、视频卡管理/任务归属/重试沿用方向及纯显示规则；未新增或修改后端生成路由。

## 4. 跑了哪些验证命令

先按 TDD 运行并记录 RED：

```powershell
npx tsx scripts/ultimate-canvas-generation-node-interactions-smoke.ts
npx tsx scripts/ultimate-canvas-preview-api-smoke.ts
```

随后运行：`git diff --check`；8 个画布 JavaScript 文件的 `node --check`；全部 11 个 `ultimate-canvas-*-smoke.ts`；`npx tsc --noEmit --pretty false`；`npm run lint`；`npm run build`。自动验证代理未改动 4399 预览进程；父代理在代码审查通过后重启本地预览服务器，并在应用内浏览器完成最终交互验收。

## 5. 验证结果是否通过

- RED 符合预期：交互烟测因最终 cache key/预估实现缺失退出 1；预览 API 对 `/api/tasks/estimate` 返回 501，退出 1。
- 评审修复 RED 符合预期：第一次因缺少 `clearAllVideoEstimates` 失败；第二次因项目/视频卡 bootstrap 切换未清理失败。实现共享 helper 与生命周期接线后，两组断言均转为 GREEN。
- GREEN 与完整套件全部退出 0：8 个语法检查、11 个烟测、TypeScript、lint、build 均通过；预览 API 烟测在随机本机端口启动并自行清理子进程。
- `npm run lint` 有 38 条既有 warning：6 条 `react-hooks/exhaustive-deps`、32 条 `@next/next/no-img-element`；修改的无线画布文件无新增 lint warning。构建成功生成 76 个静态页面，并包含 `/api/tasks/estimate` 与无线画布路由。
- 应用内浏览器九项验收全部通过：紧凑/展开、画布引用选择、禁用模式及原因、单弹层与 Escape、同节点图片结果、图片结果创建并连接视频节点、刷新后视频轮询恢复、390px 视口、控制台零新增 warning/error。
- 最终选中状态实测：图片和视频卡片选中前后计算尺寸始终为 `350×240px`；视频结果操作行固定为 `24px` 高并完整位于卡片内，属性面板从卡片下方开始。点击“生成视频”后仍能创建下游节点和连接。
- 390px 视口下，`documentElement.clientWidth === scrollWidth === 390`；选中卡片宽度为 `350px`，属性面板宽度为 `366px`，二者中心点一致；既有规格弹层仍完整位于视口内。

## 6. 是否真实调用了文字/图片/视频生成

没有。本次仅运行源代码检查、Node 烟测、TypeScript、lint、构建和随机本机端口的内存 mock API。没有访问线上 sd2，没有调用任何第三方或真实文字、图片、视频模型。生产前端只引用既有同源接口；本地预览返回的文字、图片、视频和点数预估均为 mock。

## 7. 是否消耗了点数

没有，消耗点数为 0。没有创建线上生成或重试任务，没有冻结、扣除、返还或调整点数。Task 8 预估请求为信息展示，失败不禁用提交；本地 mock 不连接真实账户或计费系统。

## 8. 是否碰过后台设置、密钥、点数核心逻辑

没有读取或修改 `.env`、后台 API 设置、provider 密钥/地址、认证或管理员绕过、数据库 schema、点数冻结/扣减/退款核心逻辑，也没有修改后端生成路由。Task 8 只消费现有 `/api/tasks/estimate`，生产代码未持久化任何计价公式；预览公式仅位于本机 mock 文件。

## 9. 还没做完的内容

- 本地浏览器验收已经完成；视频预估跨项目/视频卡切换的旧响应隔离由共享清理函数、可执行烟测和两轮独立审查覆盖，未使用线上账号制造真实慢请求。
- 尚未部署到线上环境，也未用真实普通账号核对线上 estimate/provider 字段、失败/超时状态、资产播放下载和真实点数流水。
- 已尝试 `git push origin teammate/ultimate-canvas-complete`，远端以 403 拒绝当前身份 `K4y2025` 对 `goukiyang/seedance-api-debugger` 的写入。完整二进制安全补丁输出到 `E:\Ultimate-canvas\ultimate-canvas-complete-final.patch`，覆盖 `origin/teammate/ultimate-canvas-complete..HEAD` 的全部提交，供有权限的维护者直接应用。

## 10. 风险和建议下一步

1. 部署到受控预览环境后，先验证不扣点路径、普通用户权限和估算失败降级，再由有授权的用户决定是否进行最小真实生成测试。
2. 线上重点核对 `/api/tasks/estimate` 的 `estimatedCost` 字段、分辨率/时长组合、请求取消行为及旧响应不会覆盖新设置。
3. 保持点数预估为信息层；后端仍是最终计费来源，前端不得复制或持久化计价规则。
4. 现有 38 条仓库级 lint warning 与本范围无关，可在独立维护任务中处理，避免混入本次交付。

## Browser QA follow-up: generated result layout

Parent browser QA confirmed that the image result and editor remain on the same node. It also found a layout defect at 71% zoom: the selected card ended at `y=746.21`, while the visible create-video action began at `y=792.54`, underneath the following image properties panel. The action locator was visible to Playwright, but the overlapping panel intercepted the click.

The defect is fixed in CSS. The final selection-stability pass supersedes the earlier content-driven selected-card rule: selected and unselected image/video cards both remain `350x240`; selected result previews are compacted inside that fixed card; and the 24px action row stays available through horizontal scrolling without a visible scrollbar. The same-node editor remains a separate centered panel below the card. Ports remain at the card's vertical center, and the existing `ResizeObserver` continues to refresh connection paths.

The semantic smoke now rejects selection-based card enlargement and verifies exact fixed dimensions, bounded media, mobile width, action-row and connector declarations. It confirms that `ResizeObserver` setup remains in source but does not execute observer behavior. Parent browser re-verification passed: result actions remain inside the card, the editor starts below it, and clicking create-video still produces a downstream video node and connection.

### Review hardening follow-up

Modified files for the final layout follow-up are `public/tools/ultimate-canvas/styles.css`, `scripts/ultimate-canvas-result-layout-smoke.ts`, `scripts/ultimate-canvas-generation-node-interactions-smoke.ts`, and this handoff. The stylesheet keeps selected image/video cards at the compact base size, centers the existing editor panel below them, and only shrinks cards below 350px when the viewport itself is narrower.

TDD RED for selection stability was recorded with `npx tsx scripts/ultimate-canvas-result-layout-smoke.ts`: the existing production rule returned `620px` instead of the required `350px`. A second RED captured the compressed video action row before its fixed 24px height was added. After the CSS fix, the semantic layout smoke and all 11 canvas smokes passed, followed by TypeScript, lint, build, and `git diff --check`.

The semantic smoke parses the stylesheet AST and checks exact declarations; it does not itself provide computed browser rectangles, stacking/hit-test evidence, clicks, or executed `ResizeObserver` behavior. Parent browser QA supplied the missing rendering evidence: desktop result geometry and hit testing passed, 390px document overflow stayed at zero, the mobile popover stayed within 12px viewport margins, and the browser console reported zero warning/error entries.

## Final production hardening (2026-07-12)

This pass closes every Critical and Important finding from the whole-branch review without adding a second canvas workflow or changing backend generation, pricing, provider, credit, authentication, admin, or database behavior.

### Production changes

- Generation submissions now capture a context epoch, project ID, video-card ID, canvas document ID, node ID, and original node object. Project/card switches, canvas clears, and document restores invalidate the epoch before context replacement. Deferred stale image/video successes and failures cannot mutate or decorate a replacement node, register polling, change status, show completion/error notices, or schedule a save.
- One shared normalized nonterminal predicate covers submitted, queued, pending, processing, running, and normalized `in_progress` variants when a video node owns a real task ID. Video submit readiness and rendering also consume transient in-flight ownership; taskless legacy status cannot lock submit. Image regeneration remains available. The polling coordinator enforces one task owner per node and ignores responses from replaced ownership.
- `canvas-save-coordinator.js` provides a single-flight, latest-wins queue with an injected executor. No canvas document POST runs concurrently. Intermediate dirty revisions coalesce, failure does not wedge later saves, flush persists the newest snapshot, and stale-context responses cannot update the current document ID or save state.
- Capability normalization preserves outer `enabled`, `message`, and `reason`, preserves explicit empty interaction arrays, disables missing/unavailable capabilities, and caps every mode maximum by `max_reference_images`. Image specifications consume normalized `interaction.size_options`; `resolutions` remains only a compatibility alias.
- Mode counts, reference selection limits/status, compatibility markers, and submit gating use durable available reference IDs, including restored nested result/asset forms. Connected images without a durable ID remain visible as unavailable but cannot enable a mode.

### TDD evidence and tests

The first focused RED run failed for the intended missing behavior:

- `ultimate-canvas-generation-node-interactions-smoke.ts`: normalized capability `enabled` was missing.
- `ultimate-canvas-generation-task-coordinator-smoke.ts`: one node retained two active tasks (`2 !== 1`).
- `ultimate-canvas-generation-lifecycle-smoke.ts`: `captureGenerationContext` did not exist.
- `ultimate-canvas-save-coordinator-smoke.ts`: `canvas-save-coordinator.js` did not exist.
- A second save RED proved stale context delivery by changing the current document from `replacement-document` to `stale-document`.

New executable coverage is in `scripts/ultimate-canvas-generation-lifecycle-smoke.ts` and `scripts/ultimate-canvas-save-coordinator-smoke.ts`. Existing interaction and task-coordinator smokes now cover disabled/missing/enabled capability recovery, image `size_options`, explicit empty arrays, capped maxima, normalized nonterminal statuses, video duplicate readiness, nested durable references, unavailable-reference mode gating, one-node ownership, and stale replaced-task responses.

All 11 `ultimate-canvas*-smoke.ts` scripts pass, including the local mock preview API smoke. Eight JavaScript syntax checks pass (the seven existing canvas scripts plus the new save coordinator), as do `npx tsc --noEmit --pretty false`, `git diff --check`, `npm run lint`, and `npm run build`. Lint retains only pre-existing warnings in unrelated React files.

### Safety and acceptance

No online text, image, or video generation was run. No retry or paid task was created, and points consumed were exactly zero. `.env`, API/admin settings, provider secrets, credit rules, database schema, backend pricing/provider/generation routes, package metadata, and lockfiles were not read or modified. Production calls remain same-origin sd2 calls for an ordinary user.

父代理已在最终提交后重跑桌面与移动端浏览器验收：非终态视频任务提交按钮保持禁用，保存后刷新可恢复并继续轮询；图片可在原节点再次生成；可用素材能加入参考列表并建立连接，计数从 `0/10` 变为 `1/10`；保存状态回到“已保存”。

## Re-review correction (2026-07-12)

The follow-up review identified that a newly created canvas document ID is mutable save metadata rather than generation context identity. Generation validity now depends on context epoch, project ID, video-card ID, node ID, and original node object identity; a first autosave changing `documentId` from null to a created ID no longer discards a valid generation response. Guarded cleanup runs exactly once for success, failure, and stale outcomes. A stale card-switch response cannot attach a task/result, while the captured transient submit button/status is safely cleared even if the original element or node has been detached.

Image capability normalization now preserves explicit empty `interaction.size_options` while also exposing the configured outer `capability.size` as `fixedSize`. Enabled fixed-size providers remain submit-ready and render the fixed size read-only. Providers with neither selectable sizes nor a fixed size are disabled with the specific unavailable-spec reason rather than a positive backend message such as `可用`.

The current hardening inventory includes `public/tools/ultimate-canvas/canvas-save-coordinator.js`, `scripts/ultimate-canvas-generation-lifecycle-smoke.ts`, and `scripts/ultimate-canvas-save-coordinator-smoke.ts`. The production cache key for `app.js`, generation interactions, task coordination, and save coordination is `20260712-final-hardening`. Lifecycle coverage now separates document-only metadata creation, same-object card switching, and detached replacement cleanup; capability coverage separates empty-plus-fixed, empty-without-fixed, absent-field defaults, and explicit selectable lists.

No online generation or paid retry was run, and points consumed remain zero. Protected backend/provider/credit/schema/package/secret areas remain untouched. Parent desktop/mobile browser acceptance passed after this correction commit.

## Transient pending video correction (2026-07-12)

Video submission ownership before the backend returns a real task ID is now runtime-only. The node retains its previous durable status while the submit button/loading status and a context-bound transient tracker prevent duplicate requests. Therefore a project/video-card switch flush cannot save a synthetic `submitted` node. A stale response removes only its captured transient ownership and never attaches a task/result.

For a current response, `taskId`, normalized nonterminal status, and generation result are written together before decoration, polling registration, and the queued canvas save. Hydration repairs legacy video nodes that have a nonterminal durable status without `taskId`: status becomes `idle`, stale error/result/loading markers are removed, and one current-context save is scheduled after restore through `canvas-save-coordinator.js`. The recovery helper is idempotent, so the persisted idle document does not create a restore/save loop. Legitimate restored `running + taskId` nodes remain blocked and are registered for polling.

Deferred lifecycle coverage now verifies pre-response serialization, switch/flush/stale resolution and restore, current task-owned response persistence, taskless legacy recovery, and legitimate running-task restore. No online generation or paid retry was run; points remain zero. Parent browser acceptance passed after this commit.

## Context invalidation submission release (2026-07-12)

Context invalidation now bulk-releases every captured image/video submission entry before incrementing the epoch. Each entry owns a transient UI cleanup closure only; invalidation removes loading/status presentation without changing durable node task/result data. The tracker clears its map before invoking cleanup callbacks, so a same-ID image or video submission can start immediately in the new context even when the old backend promise remains unresolved.

Tracker completion remains identity-based. If the old promise later settles, its `finish(nodeId, oldEntry)` cannot remove or clean a newer `nodeId` entry, and it does not rerender over the newer request. Deferred coverage verifies old unresolved submission, invalidation cleanup, immediate same-ID replacement, stale old completion, identity-safe new ownership, and image/video bulk release。父代理最终浏览器验收已通过；没有运行线上生成或付费重试，点数消耗仍为 0。

## 最终父代理验收（2026-07-11）

- 视频节点提交后立即进入单请求占用状态，“生成视频”按钮禁用，不能在后端返回前重复创建付费任务；任务保存后刷新页面可恢复，并最终显示“视频生成完成”。
- 图片节点保留完整规格与提交控件，规格显示 `9:16 · 1K · 1张`；本机 mock 图片在同一节点原位展示，并可继续再次生成或创建下游视频节点。
- 参考选择流程可从素材库选中持久化素材，参考计数由 `0/10` 更新为 `1/10`，节点显示“参考图 1”，同时新增可追踪的参考图片节点与连接；退出后保存状态回到“已保存”。
- 390px 视口下 `documentElement.clientWidth === scrollWidth === 390`；选中节点计算宽度为 `350px`，属性区为 `366px`，二者中心点一致；规格弹层完整位于视口内。
- 浏览器最终 warning/error 日志为 0。上述流程全部使用 `ultimate-canvas-preview-server.mjs` 的本机内存 mock，没有访问线上 sd2、没有调用真实模型、没有消耗点数。

## 选中节点尺寸稳定修复（2026-07-13）

- 根因是 `styles.css` 对选中图片/视频卡片显式设置了 `width: 620px; height: 350px`，有结果时又改为内容驱动高度，因此不是画布缩放，而是选中态样式主动放大。
- 图片和视频卡片现在选中前后都保持 `350×240px`；下方参数编辑器仍正常展开并以卡片中心对齐。生成结果预览限制为 92px，操作行固定为 24px 并可横向滚动，按钮没有被裁切或移出卡片。
- 桌面浏览器实测选中视频卡为 `350×240px`，操作行 `clientHeight === scrollHeight === 24` 且底部位于卡片底部之上；390px 下文档无横向溢出，卡片和属性面板中心点一致，控制台 warning/error 为 0。
- TDD、11 个画布烟测、`npx tsc --noEmit --pretty false`、`npm run lint`、`npm run build` 与 `git diff --check` 均通过。没有调用线上生成、没有消耗点数、没有触碰受保护设置或后端核心逻辑。

## 比例节点与图片规格同步修复（2026-07-13）

本节覆盖上方旧的固定图片卡尺寸结论。视频节点继续使用最大 `350px` 长边；图片节点改为独立的最大 `640px` 长边，以便横向图片框与原有 `640px` 提示词面板对齐。两类节点都继续按当前生成比例计算另一条边，窄屏时统一限制为 `viewportWidth - 24px`，提示词面板本身仍保持原有 `640px` 桌面宽度和自然高度。

- `public/tools/ultimate-canvas/generation-node-interactions.js`：新增可测试的图片/视频长边策略，图片为 640、视频为 350，并保留移动端 12px 双侧边距。
- `public/tools/ultimate-canvas/app.js`：按节点类型应用长边策略；打开中的规格弹层会在节点状态刷新后从当前数据重新渲染，因此比例、尺寸、数量、摘要按钮和节点尺寸使用同一份状态。
- `scripts/ultimate-canvas-generation-node-interactions-smoke.ts`：覆盖图片/视频桌面与移动端长边，并实际执行规格弹层刷新函数，验证比例、尺寸、数量和重新定位。
- `scripts/ultimate-canvas-result-layout-smoke.ts`：覆盖 21:9 图片节点 `640 x 274.286`，验证其横向宽度与提示词面板一致。

TDD RED 分别因缺少 `generationNodeLongEdge` 失败；实现后两个聚焦烟测转为 GREEN。应用内浏览器实测图片规格从 1:1 切回 21:9 后，下拉和摘要均显示 `21:9`，节点变量为 `640 x 274.286`，提示词面板为 `640px`，中心点一致；视频 9:16 仍为 `196.875 x 350`。测试结束后已恢复图片节点原有 21:9 设置和 100% 画布缩放。

本轮没有调用真实文字、图片或视频生成，没有创建付费重试，消耗点数为 0。没有读取或修改 `.env`、后台 API 设置、provider 密钥、点数核心规则、数据库 schema、后端生成路由或普通账号权限逻辑。

## 视频节点尺寸与任务菜单修正（2026-07-13）

本节覆盖上一节“视频节点最大 350px”的旧结论。图片和视频生成节点现在都使用最大 `640px` 长边，并继续按各自生成比例计算另一条边；原有 `640px` 提示词面板不变。390px 视口下，两类节点和提示词面板都限制为 `366px` 最大宽度，保留 12px 双侧边距。

- `public/tools/ultimate-canvas/generation-node-interactions.js`：视频节点桌面长边由 350 调整为 640，未知节点类型仍保留 350 的保守回退。
- `public/tools/ultimate-canvas/styles.css`：任务“更多”菜单的链接和按钮统一使用暗色、透明背景、32px 高度和无下划线样式，并增加一致的悬停反馈；任务地址、权限和操作处理逻辑没有变化。
- 两个现有 smoke 增加视频 21:9 `640 x 274.286`、窄屏尺寸和任务菜单声明断言。TDD RED 分别捕获旧的 350 上限和缺失的菜单样式，修复后转为 GREEN。

应用内浏览器实测：21:9 视频节点为 `640 x 274.286`，与 `640px` 提示词面板中心对齐；390px 视口下为 `366 x 156.857`，`clientWidth === scrollWidth === 390`；“更多”中的任务详情、预览、下载、重试和版本按钮均为暗色无下划线菜单项。未调用真实生成，点数消耗仍为 0，受保护的后台设置、密钥、点数核心规则和数据库 schema 均未触碰。

## SD2 同源真实后端接入（2026-07-13）

### 1. 本次目标理解

本次为完整集成回执，覆盖 Git 范围 5bb620cb366af65f5f0857645300f26d19b1a63a..d15e318，而非仅记录某一个 Task。目标是在保留既有认证和普通用户访问限制的前提下，让 Ultimate Canvas 的生产请求通过 SD2 同源业务路由完成 bootstrap、文档、素材库、上传、预估、生成提交与任务轮询；本地预览继续使用 Mock，且浏览器不持有任何第三方 API 密钥。

### 2. 实际修改了哪些文件

本范围共修改 16 个文件：

- .gitignore
- docs/handoffs/ultimate-canvas-implementation-report.md
- public/tools/ultimate-canvas/app.js
- public/tools/ultimate-canvas/backend-contract.js
- public/tools/ultimate-canvas/generation-api.js
- public/tools/ultimate-canvas/index.html
- scripts/ultimate-canvas-context-rules-smoke.ts
- scripts/ultimate-canvas-generation-node-interactions-smoke.ts
- scripts/ultimate-canvas-generation-node-workflow-smoke.ts
- scripts/ultimate-canvas-normal-user-access-smoke.ts
- scripts/ultimate-canvas-preview-api-smoke.ts
- scripts/ultimate-canvas-preview-server.mjs
- scripts/ultimate-canvas-same-origin-backend-smoke.ts
- scripts/ultimate-canvas-video-card-workflow-smoke.ts
- src/app/api/tools/ultimate-canvas/bootstrap/route.ts
- src/app/api/tools/ultimate-canvas/generate/route.ts

### 3. 每个文件改了什么

- .gitignore：忽略 .superpowers/sdd/ 的本地任务记录。
- docs/handoffs/ultimate-canvas-implementation-report.md：记录本次同源接入及其验证、安全边界和未完成事项；本节为该范围的最终集成回执。
- public/tools/ultimate-canvas/backend-contract.js：新增前端后端契约层；按文字、图片、视频能力分别维护同源业务路由白名单，并精确放行画布已有的审批与单任务重试路由；校验任务状态模板；集中处理状态和响应错误，并提供普通用户可理解的安全文案。
- public/tools/ultimate-canvas/generation-api.js：通过契约层校验配置下发的能力端点，拒绝跨能力或未允许的业务路由，并统一保留错误状态与响应；浏览器端不直接接触第三方 API Key。
- public/tools/ultimate-canvas/app.js：将应用 bootstrap、画布文档、素材库、上传、预估与任务轮询全部改为通过 requestJson 访问同源后端；读取并显示生产 SD2/本地 Mock 后端标识，保留既有认证和普通用户检查。
- public/tools/ultimate-canvas/index.html：按依赖顺序加载后端契约模块，并更新 backend-contract.js、generation-api.js 和 app.js 的脚本缓存版本。
- src/app/api/tools/ultimate-canvas/bootstrap/route.ts：在既有访问控制不变的情况下，返回生产后端标识 backend: { mode: 'sd2', transport: 'same-origin', mock: false }。
- src/app/api/tools/ultimate-canvas/generate/route.ts：保留原有认证和普通用户授权检查，将文字生成不可用时的响应改为面向普通用户的“文本生成能力暂不可用，请稍后联系管理员。”文案。
- scripts/ultimate-canvas-preview-server.mjs：本地预览 bootstrap 响应标识为 Mock，确保预览不会伪装为 SD2 生产后端。
- scripts/ultimate-canvas-same-origin-backend-smoke.ts：新增同源后端集成烟测，覆盖能力路由白名单、请求契约、任务状态、错误文案、生产/Mock 标识和浏览器无第三方密钥。
- scripts/ultimate-canvas-normal-user-access-smoke.ts：补充普通用户安全访问和文案断言。
- scripts/ultimate-canvas-context-rules-smoke.ts、scripts/ultimate-canvas-generation-node-interactions-smoke.ts、scripts/ultimate-canvas-generation-node-workflow-smoke.ts、scripts/ultimate-canvas-video-card-workflow-smoke.ts：更新 app.js 缓存版本断言，防止旧缓存掩盖本次接入。
- scripts/ultimate-canvas-preview-api-smoke.ts：验证本地预览 bootstrap 明确返回 Mock 同源运行时标识。
- 其余上述 smoke 变更共同确保本地 Mock API 预览与既有节点、视频卡和上下文流程仍可执行。

### 4. 跑了哪些验证命令

- 执行全部 12 个 scripts/ultimate-canvas-*-smoke.ts 烟测脚本。
- 对 public/tools/ultimate-canvas/backend-contract.js、generation-api.js、app.js、canvas-engine.js 执行 node --check。
- 执行 npx tsc --noEmit --pretty false。
- 执行 git diff --check。
- 在精确功能代码 HEAD d15e318 的干净 detached 外部 worktree 中执行 npm run lint 和 npm run build。
- 针对契约与缓存版本的 5 个 smoke 单独复跑：ultimate-canvas-same-origin-backend-smoke.ts、ultimate-canvas-context-rules-smoke.ts、ultimate-canvas-generation-node-interactions-smoke.ts、ultimate-canvas-generation-node-workflow-smoke.ts、ultimate-canvas-video-card-workflow-smoke.ts。

### 5. 验证结果是否通过

通过。功能代码 HEAD d15e318 上，12 个 ultimate-canvas-*-smoke.ts 脚本全部通过；4 个 node --check、TypeScript 检查和 git diff --check 均通过。干净 detached 外部 worktree 的 npm run lint 和 npm run build 也通过；两者只保留既有 warning，构建产出 76 个页面。上述 5 个契约与缓存版本 smoke 均通过，并覆盖审批、重新打开视频卡与单任务重试的允许路由及相邻非法路由。最终 hardening 后的本地浏览器复测也已通过：页面显示“本地 Mock”，bootstrap 返回 `mode: mock`、`transport: same-origin`、`mock: true`，用户角色为普通 `user`，三个浏览器脚本均加载 `20260713-sd2-same-origin` 缓存版本，控制台 warning/error 为 0。

### 6. 是否真实调用了文字/图片/视频生成

没有。只运行了静态检查、Node/TypeScript 烟测、构建和本地 Mock 预览验证；未调用真实文字、图片或视频生成服务，也未创建付费重试。

### 7. 是否消耗了点数

没有。点数消耗为 0；没有创建真实付费生成、付费重试、扣点、冻结、返还或调整操作。

### 8. 是否碰过后台设置、密钥、点数核心逻辑

没有。未读取或修改 .env、后台 API 设置、provider 密钥、第三方服务地址、点数核心逻辑、credits 规则或数据库 schema；也未改动这些受保护区域的行为。生产前端仅调用同源业务路由，浏览器中没有直接第三方 API Key。

### 9. 还没做完的内容

- 尚未部署到 https://sd2.youdoodesign.com。
- 尚未在获授权的普通账号上进行非付费/真实线上验收。
- 尚未确认目标分支 push 或线上部署成功；后续可按权限执行 push，或提供 patch 作为回退交付。

### 10. 风险和建议下一步

- 部署至 SD2 后，先用获授权的普通账号验证同源 bootstrap、能力不可用降级、任务状态与普通用户提示，再决定是否进行任何最小真实生成验收。
- 后端业务路由、任务状态模板或响应字段变更时，应同步更新 backend-contract.js 和 ultimate-canvas-same-origin-backend-smoke.ts，避免前端白名单与真实接口漂移。
- 保持本地预览的 Mock 标识与生产 SD2 标识可区分，继续禁止在浏览器暴露第三方密钥。
- 在具备写权限后执行目标分支推送；若仍受限，交付当前 commit 的 patch，不宣称已推送或已上线。
## Task 2 browser QA and delivery receipt (2026-07-13)

Task 2 validated the approved Task 1 commit `3060e46` (`fix: move video settings into footer`) without changing application code. Task 1 production changes are `public/tools/ultimate-canvas/canvas-engine.js`, `public/tools/ultimate-canvas/index.html`, and `public/tools/ultimate-canvas/styles.css`. Its updated smoke files are `scripts/ultimate-canvas-context-rules-smoke.ts`, `scripts/ultimate-canvas-generation-node-workflow-smoke.ts`, `scripts/ultimate-canvas-result-layout-smoke.ts`, and `scripts/ultimate-canvas-video-card-workflow-smoke.ts`.

RED/GREEN evidence: the Task 1 diff shows the prior video `generation-summary-row` above `generation-node-toolbar` and the prior footer as wrapping flex. The approved revision moves the same mode/spec controls after `video-model-info` inside `video-props-footer`, places `video-footer-right` after them, and changes the desktop footer to a three-column grid. `ultimate-canvas-result-layout-smoke.ts` now asserts toolbar-before-footer, model-before-settings-before-cost/submit, and the grid placements. The full 12-script smoke run was GREEN.

Local Mock preview evidence: `node scripts/ultimate-canvas-preview-server.mjs 4400` was started hidden from this worktree. `http://127.0.0.1:4400/tools/ultimate-canvas/index.html` returned HTTP 200 with `Cache-Control: no-store`; bootstrap returned `backend.mode: "mock"`, `transport: "same-origin"`, and `mock: true`. The returned HTML loaded this branch's cache keys: `styles.css?v=20260713-video-footer-controls` and `canvas-engine.js?v=20260713-video-footer-controls`.

早期 Task 8 缓存键描述仅代表当时状态；当前 `styles.css`/`canvas-engine.js` 以 `20260713-video-footer-controls` 为准。

Browser QA status: COMPLETE. At desktop `1105 x 1272`, `documentElement.clientWidth/scrollWidth` was `1105/1105` (no horizontal overflow). The video footer's direct children were ordered `video-model-info`, `generation-summary-row`, and `video-footer-right`; the summary parent was `video-props-footer`. Its grid columns measured approximately `206.573px 177.521px 206.573px`; summary padding and border-bottom were both `0`; the toolbar remained above the footer and the old top summary row was absent. Both desktop mode and specification popovers opened normally, with the specification popover fully within the viewport. Changing the visible Mock ratio from `9:16` to `16:9` immediately changed the footer summary to `16:9 · 1080p · 5s` and synchronized the selected popover item to `16:9`.

At narrow `390 x 844`, `documentElement.clientWidth/scrollWidth` was `390/390` (no horizontal overflow). The footer measured about `364.667px x 90.667px`; the summary occupied `grid-column: 1 / -1` on row one, while model and `video-footer-right` occupied row two. The mode popover rect was `x=158, y=357.146, width=220, height=400.396, right=378, bottom=757.542`, fully within the viewport. The specification popover showed `16:9 · 1080p · 5s` and measured `x=12.656, y=439.208, width=365.333, height=318.333, right=377.990, bottom=757.542`, also fully within the viewport. Browser console warnings/errors: `0/0`.

Verification commands and results:

- `Get-ChildItem scripts -Filter 'ultimate-canvas-*-smoke.ts' | Sort-Object Name | ForEach-Object { npx tsx $_.FullName; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }`: PASS, 12/12 scripts.
- `node --check public/tools/ultimate-canvas/canvas-engine.js`: PASS.
- `node --check public/tools/ultimate-canvas/app.js`: PASS.
- `npx tsc --noEmit --pretty false`: PASS.
- `npm run lint` in this nested worktree: environmental FAIL (exit 1), not a product failure, from duplicate `@next/next` plugin paths through `.eslintrc.json` and `..\\..\\.eslintrc.json`; the same source HEAD passed lint/build in the clean external detached worktree.
- Clean detached external worktree `E:\Ultimate-canvas\seedance-api-debugger-task2-verify-3060e46` at the same source HEAD `3060e46bf76e243fb1a1f8c3e9daac735d464264`: after `npm ci`, `npm run lint` PASS with pre-existing warnings; `npm run build` PASS with the same pre-existing lint/autoprefixer warnings.
- `git diff --check`: PASS after this receipt was written (only the expected line-ending warning was emitted).

No real text, image, or video generation occurred. No paid retry, credit mutation, point consumption, or provider call occurred; points consumed: 0. `.env`, admin settings, provider configuration/secrets, credits logic, and database schema were not read or changed. Self-review: the only intended production modification is this appended receipt update; browser acceptance is complete. No remaining Task 2 concern.
