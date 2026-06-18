# 未闭环功能完整扫描报告

日期：2026-06-18  
项目目录：`/Volumes/Data/Projects/video-api-debugger-v12-full-todo`  
当前分支：`codex/v12-full-todo`  
当前已上传 HEAD：`f65e151` / `rollback/2026-06-18-sd2-deployed-checkpoint`  
无线画布文本 LLM 提交点：`d8f1356` / `rollback/2026-06-18-ultimate-canvas-llm`  
扫描性质：代码扫描 + TODO 核对；未执行付费真实生成，未做登录态浏览器全链路验收。

> 2026-06-19 状态修正：本报告是历史扫描快照。无线画布文本/图片/视频生成接入、项目/视频卡上下文、画布保存恢复、上传入库、素材/历史面板、视频轮询、任务本地化、来源追踪、点数流水来源筛选、素材库参考图自动补挂 workspace、图片首尾帧草图模式已经在后续提交中落地。仍保留未执行项：真实付费视频生成到终态、真实扣点/返还截图、登录态浏览器视觉验收。

## 1. 第一性原理结论

用户要的不是“多一个能打开的画布页面”，而是：

1. 任何入口只要说能生成，就必须走同一套 sd2 后台体系。
2. 生成必须有项目 / 视频卡归属，能进入任务、资产、点数、后台流水。
3. 生成后必须能轮询到终态，视频自动保存到服务器本地，截图 / 缩略图可预览，结果可下载。
4. 页面上不能出现“能输入、能点、看起来已接入”，但实际只是前端 mock 或占位。
5. 代码改动必须上传 Git，形成可回退版本；本地未提交不算闭环。

按这个标准看：无线画布文本 / 脚本 LLM 已经接通并上传，但还有一批“界面已出现、业务没闭环”的功能。

## 2. 扫描方法

本轮扫描覆盖了这些方向：

- Git 状态：`git status --short --branch`
- 无线画布：`public/tools/ultimate-canvas/*`、`src/app/tools/ultimate-canvas/page.tsx`、`src/app/api/tools/ultimate-canvas/generate/route.ts`
- 图形生成后端：`src/app/api/assets/generate/route.ts`
- 视频生成 / 本地化：`src/app/api/tasks/create/route.ts`、`src/lib/video/task-finalizer.ts`、`src/lib/video/local-cache.ts`、`src/lib/video/task-localization-runner.ts`、`scripts/finalize-pending-videos.ts`
- 模板系统：`src/app/admin/templates/*`、`src/app/api/templates/*`、`src/components/templates/*`、`src/lib/templates/*`
- 页面占位 / 跳转：`src/app/**/page.tsx`
- 现有任务记录：`tasks/todo.md`、`tasks/ultimate-canvas-feature-gap-audit.md`

补充说明：CodeGraph 在该目录没有初始化，所以本轮用 `rg` 和定向读文件完成扫描。

状态修正：本报告原始扫描发生在 `f65e151` 检查点上传前。涉及“未提交 / dirty / 未上传”的源码状态，已在 `f65e151` 和 rollback tag `rollback/2026-06-18-sd2-deployed-checkpoint` 中整理上传；未闭环判断仍以功能验收标准为准。

## 3. 已经闭环的部分

### 3.1 无线画布文本 / 脚本 LLM

状态：已实现、已提交、已推送。

证据：

- `public/tools/ultimate-canvas/app.js:41`：只配置了 `text` 和 `script` endpoint。
- `src/app/api/tools/ultimate-canvas/generate/route.ts`：只支持 `text`、`script`，调用 Musk LLM，返回文本结果。
- `git log -- public/tools/ultimate-canvas src/app/tools/ultimate-canvas src/app/api/tools/ultimate-canvas`：最新提交为 `d8f1356 接通无线画布文本 LLM 生成接口`。
- `git log` 显示该提交已在 `origin/codex/v12-full-todo`，并有 rollback tag：`rollback/2026-06-18-ultimate-canvas-llm`。

结论：截图里“文本节点输入但没接 LLM”的问题，当前代码里的 text/script 路径已经修过并形成远端版本。

### 3.2 视频任务自动本地保存底座

状态：有实现底座，但还不是“永远自动”的完整闭环。

已做：

- `src/app/api/tasks/create/route.ts:898`：Provider 接受任务后会调用 `startTaskLocalization(taskId)`。
- `src/lib/video/task-localization-runner.ts`：内存轮询任务状态，终态后调用 finalizer。
- `src/lib/video/task-finalizer.ts`：成功任务会调用 `cacheTaskVideoToLocal` 并生成缩略图。
- `src/lib/video/local-cache.ts`：把 `result_video_url` 下载到 `public/videos/{task_id}.mp4`，写回 `local_video_path`。
- `src/app/api/codex/video/create/route.ts` 复用 `/api/tasks/create`，所以外部 Codex API 创建视频理论上也会进入同一条本地化链路。
- `scripts/finalize-pending-videos.ts`：有补偿脚本，可扫描 running / submitted / succeeded-but-local-missing 任务。

未闭环点：

- `startTaskLocalization` 是进程内存任务，服务重启后正在跑的轮询会丢。
- `scripts/finalize-pending-videos.ts` 只是脚本；`tasks/todo.md` 已记录“未配置 launchd/cron 定时执行补偿脚本”。
- 所以目前是“创建后会尝试自动保存”，不是“系统级保证所有任务都会最终补偿保存”。

推荐动作：

- P0：把 `scripts/finalize-pending-videos.ts` 接到 launchd / cron，每 1-3 分钟跑一次小批量补偿。
- P0：补一个只读健康页或后台卡片，显示“待本地化任务数、失败原因、最近补偿时间”。
- 验收：手动制造一个 `succeeded` 且 `local_video_path=null` 的任务，补偿脚本能自动下载视频并生成 `/api/video/thumbnail/:id` 截图。

## 4. P0 未闭环问题

### P0-1：无线画布图片 / 视频生成仍然是 mock

现象：

- 文本 / 脚本节点能调用 LLM。
- 图片节点、视频节点、首尾帧视频节点仍然没有创建真实 sd2 任务。

证据：

- `public/tools/ultimate-canvas/app.js:41-46` 只配置了：
  - `text: /api/tools/ultimate-canvas/generate`
  - `script: /api/tools/ultimate-canvas/generate`
- `public/tools/ultimate-canvas/generation-api.js:94`：没有 endpoint 时会走 `mockGenerate`。
- `public/tools/ultimate-canvas/generation-api.js:64-72`：mock 结果返回 `provider: 'mock'` 和“生成占位，尚未接入真实生成服务”。
- `public/tools/ultimate-canvas/app.js:180-190`：image/video 如果是 mock，会显示“尚未接入真实生成、点数扣减和任务轮询”。

本质问题：

- 用户看到的是普通生成工具 UI，但 image/video 没有进入任务、点数、资产、状态轮询。

推荐动作：

- 接入视频：把 `video` / `text-to-video` / `image-to-video` / `first-last-frame-video` 映射到 `/api/tasks/create`。
- 接入图形：把 `image` / `text-to-image` / `image-to-image` / `upscale-image` 映射到 `/api/assets/generate`。
- 没有 endpoint 时不要静默 mock 成功，应明确禁用按钮或显示“该模式未接入”。

验收标准：

- 画布里点视频生成后，能拿到真实 `task_id`。
- 节点状态从 submitted / running 到 succeeded / failed。
- 成功后节点展示视频预览、截图、下载、任务详情入口。
- 后台任务列表、项目详情、点数流水能查到这次生成。

### P0-2：图形生成后端已有，但无线画布没调用

现象：

- 后端已经有图形生成接口。
- 无线画布图片节点没有调用这个接口。

证据：

- `src/app/api/assets/generate/route.ts` 要求 `video_card_id`，会检查项目权限、Musk/Gemini 图形生成配置、下载生成图片、上传资产、创建参考图。
- `public/tools/ultimate-canvas/app.js` 当前只给 text/script 配 endpoint。

本质问题：

- 后端能力和前端画布之间断开了。
- 用户以为“文生图 / 图生图 / 高清修复”可用，实际停在 mock。

推荐动作：

- 给画布注入 `project_id`、`video_card_id`、`canvas_document_id`、`canvas_node_id`。
- 图片生成 payload 调 `/api/assets/generate`。
- 成功后把返回的 `asset_id`、`reference_image_id`、`thumbnailUrl` 写回节点。

验收标准：

- 画布文生图成功后，资产库出现生成图片。
- 节点展示真实缩略图，不再显示“图片生成占位”。
- 后台 OperationLog 能看到 `canvas_node_id` 对应记录。

### P0-3：无线画布没有项目 / 视频卡归属

现象：

- `/tools/ultimate-canvas` 外层只做登录检查。
- iframe 内没有真实项目、视频卡、账户点数上下文。
- 页面头部仍显示“独立工具”“预览版，不扣点”。

证据：

- `src/app/tools/ultimate-canvas/page.tsx:7-41`：只渲染 iframe，没有读取项目 / 视频卡 / 点数。
- `src/app/tools/ultimate-canvas/page.tsx:20`：页面写着“预览版，不扣点”。

本质问题：

- 这和目标“无线画布只是现有后台体系里的一个普通生成工具入口”冲突。

推荐动作：

- 外层页面读取当前用户可用项目、默认项目、可用视频卡、点数余额、模型配置。
- iframe 用同源 bootstrap 或 `postMessage` 接收这些数据。
- 没有项目 / 视频卡时，真实生成按钮禁用，并引导先选择项目 / 视频卡。

验收标准：

- 任意真实生成请求都必须带 `project_id` 和 `video_card_id`。
- 后台项目页能看到来自无线画布的任务和资产。

### P0-4：画布内容没有保存 / 恢复闭环

现象：

- 节点、连线、提示词、导演台状态都在前端内存里。
- 刷新后会丢。

证据：

- 旧画布相关 API 和库当前处于删除状态：
  - `D src/app/api/canvases/[id]/route.ts`
  - `D src/app/api/canvases/export/route.ts`
  - `D src/app/api/canvases/route.ts`
  - `D src/lib/canvas/document.ts`
  - `D src/lib/canvas/permissions.ts`
- 新无线画布静态 JS 中没有保存到后端的文档 API。

本质问题：

- 创作工具如果不能保存，就不能进入项目工作流，也不能复用、复盘、协作。

推荐动作：

- 明确复用 `CanvasDocument` 还是新建 Ultimate Canvas 文档 API；优先复用现有模型，避免重复造表。
- 保存 `nodes`、`connections`、`viewport`、`project_id`、`video_card_id`、资产引用、任务引用。
- 做自动保存状态：保存中、已保存、失败可重试。

验收标准：

- 创建节点、连线、输入提示词后刷新，内容完整恢复。
- 生成成功后节点仍能关联真实任务和资产。

### P0-5：点数 / 成本 / 流水没有接入无线画布

现象：

- 画布里有类似 `⚡ 6` 的静态点数感知。
- 页面又写“预览版，不扣点”。
- image/video mock 明确说明“点数扣减未接入”。

证据：

- `public/tools/ultimate-canvas/app.js:185`：mock 描述包含“尚未接入真实生成、点数扣减和任务轮询”。
- `src/app/tools/ultimate-canvas/page.tsx:20`：显示“不扣点”。

本质问题：

- 用户无法知道会扣多少点，后台也无法把成本归属到项目 / 视频卡 / 工具入口。

推荐动作：

- 参数变化时调用估价能力。
- 生成前展示预计点数和余额。
- 真实生成统一走 `/api/tasks/create`，复用现有冻结、结算、失败退款、点数流水。

验收标准：

- 生成前能看到预计点数。
- 生成成功 / 失败后，后台点数流水能看到来源为无线画布。

### P0-6：生成历史、素材库、本地上传没有接后台

现象：

- 从生成历史选择：点击只提示未接入。
- 本地上传：只创建前端节点，不上传服务器，不入库。
- 素材面板不是站内资产库。

证据：

- `public/tools/ultimate-canvas/app.js:557`：`from-history` 只提示“生成历史还没有接入后台任务记录”。
- `public/tools/ultimate-canvas/app.js:532-570`：`triggerUpload` 只是根据本地文件类型创建节点，没有调用上传 API。
- `public/tools/ultimate-canvas/index.html` 有“生成历史待接入”。

本质问题：

- 首尾帧、图生视频、参考图都需要 provider 可访问的公开 URL 或站内资产 ID；本地文件路径不能直接生成。

推荐动作：

- 本地上传先走站内资产上传，拿到 `asset_id` / `reference_image_id` / 可访问 URL。
- 历史面板接项目任务 / 资产列表。
- 支持把历史图片、视频、参考图拖回画布。

验收标准：

- 上传本地图片后，节点能显示真实缩略图和 asset id。
- 该图片可直接用于图生视频或 first_last_frame。
- 历史任务能从画布内选择并复用。

### P0-7：老画布隐藏 / 删除已形成远端版本，恢复策略仍需明确

现象：

- 旧画布代码和 API 的删除已经进入 `f65e151` 检查点。
- 后续如果需要复用旧 `CanvasDocument` 思路，必须明确从历史版本恢复哪部分能力。

证据：

`git diff --name-status` 显示旧画布删除：

- `D src/app/api/canvases/[id]/route.ts`
- `D src/app/api/canvases/export/route.ts`
- `D src/app/api/canvases/route.ts`
- `D src/app/canvas-workspace.css`
- `D src/app/generate/canvas/page.tsx`
- `D src/components/canvas/CanvasBetaWorkspace.tsx`
- `D src/components/canvas/full/CanvasWorkspace.tsx`
- `D src/components/canvas/full/seedanceApi.ts`
- `D src/lib/canvas/document.ts`
- `D src/lib/canvas/permissions.ts`

本质问题：

- Git 现在已有回退点，但产品上仍要决定“旧画布完全归档”还是“抽取旧保存能力复用到新无线画布”。

推荐动作：

- 如需恢复旧保存能力，先从历史版本定向恢复服务层，不要恢复旧入口。
- 确认是否已把旧画布源码打包 zip 保存。
- 验证 `/workbench`、导航、middleware 都不会再把用户带回旧画布。

验收标准：

- 旧画布源码已归档。
- Git 远端有提交和 rollback tag：`f65e151` / `rollback/2026-06-18-sd2-deployed-checkpoint`。
- 公网页面不会出现旧画布入口。

## 5. P1 未闭环问题

### P1-1：模板系统阶段代码已上传，但 TODO 仍有关键未完成

现象：

- 模板系统新增文件已进入 `f65e151` 检查点。
- `tasks/todo.md` 里模板工作台、卡片编辑、图片绑定、发布检查、质量复盘仍有大量未完成项。

已纳入检查点的文件示例：

- `src/app/admin/templates/`
- `src/app/api/templates/[id]/context-cards/`
- `src/app/api/templates/config-builder/`
- `src/app/api/templates/module-builder/`
- `src/components/templates/AdminTemplatesClient.tsx`
- `src/components/templates/TemplateBoundImagePicker.tsx`
- `src/components/templates/TemplateContextCardsPanel.tsx`
- `src/lib/templates/module-builder.ts`
- `src/lib/templates/template-config-builder.ts`
- `scripts/template-builder-entrypoints-smoke.ts`
- `scripts/template-llm-contract-smoke.ts`

仍未完成的关键项：

- `/admin/templates/[id]` 仍复用 `AdminTemplatesClient initialTemplateId`，不是独立模板详情工作台。
- 卡片级自动保存、保存失败重试、LLM 改写撤回未闭环。
- 图片选择器搜索、先选中再确认绑定、图片不可用状态未闭环。
- 试生成记录、发布检查、质量复盘、角色分层未闭环。
- 真实登录态浏览器验收未闭环。

推荐动作：

- 模板系统单独拆成一个提交，不要和无线画布混在一起。
- 先补 P0：独立详情工作台、卡片保存、LLM 撤回、发布前检查。
- 再做 P1：质量复盘、诊断页、运营角色入口。

验收标准：

- 管理员进入 `/admin/templates/[id]` 第一屏就是模板详情工作台，不需要打开旧抽屉。
- 新增卡片、编辑内容、绑定图片、刷新后全部保留。
- LLM 改写可撤回。
- 发布前必须试生成并通过检查。

### P1-2：V1.2 成本 / 项目 / 审批系统仍未完整闭环

现象：

- `tasks/todo.md` 第一段已经明确：整份 V1.2 未完整落地。
- 当前已有模型、页面、审批记录，但没有形成完整业务闭环。

证据：

- `tasks/todo.md:7`：明确写着“不得把有模型 / 有页面 / 有审批记录误判为业务已闭环”。

本质问题：

- 这类系统的核心不是“能填表”，而是审批结果必须改变业务状态，预算必须约束真实生成，流水必须能审计。

需要继续核对的点：

- 公共项目预算池是否真实限制所有生成入口。
- 1080p 额度申请通过后是否真实影响生成权限。
- 比例变更 / 重开 / 高成本生成审批通过后是否真实改变对应视频卡或任务状态。
- 外部 API 生成是否也带项目、视频卡、点数归属。

推荐动作：

- 按 V1.2 TODO 拆成“预算约束”“审批副作用”“流水审计”“外部 API 覆盖”四个提交。
- 每个提交都补最小 smoke 或接口级验证。

### P1-3：资产库能力部分实现，但需要确认所有入口覆盖

现象：

- `/assets` 页面和 `/api/assets/library` 已经存在，能汇总视频任务、资产、参考图。
- 但 Git 状态里资产相关文件仍有大量修改，本轮没有确认它们都已提交 / 上传。

证据：

- `src/app/assets/page.tsx`：有资产页筛选、选择、批量下载、批量移动、加入工作区 / 图集等能力。
- `src/app/api/assets/library/route.ts`：把视频任务、资产、参考图统一成资产库条目。
- 相关资产 API / 组件已进入 `f65e151` 检查点，如 `src/app/api/assets/create-from-url/route.ts`、`src/app/api/assets/upload-and-create/route.ts`、`src/lib/assets/storage.ts`、`src/components/SeedanceAssetPanel.tsx`。

本质问题：

- 资产库不是单页问题，而是所有生成入口都要把结果归档进去。

推荐动作：

- 列出所有生成入口：主生成页、模板生成、外部 API、无线画布、图形生成。
- 验证每个入口成功后都能在 `/assets` 查到结果。
- 验证视频缩略图、图片下载、批量下载、移动项目 / 视频卡权限。

### P1-4：无线画布协作 / 分享 / 通知 / 用户菜单 / 反馈仍是占位

现象：

- 按钮存在，但只有“待接入”提示。

证据：

- `public/tools/ultimate-canvas/index.html` 中存在：
  - `btn-collab`
  - `btn-share`
  - `btn-notification`
  - `user-avatar`
  - `tool-feedback`
- `public/tools/ultimate-canvas/app.js:510-514`：统一把 `data-coming-soon` 显示为提示。

本质问题：

- 这些功能如果展示在正式工具顶部，会让用户误以为可用。

推荐动作：

- MVP 期先隐藏或置灰。
- 反馈入口优先接现有反馈系统。
- 通知入口复用站内通知中心。
- 分享 / 协作等到项目权限、画布保存后再做。

### P1-5：导演台只完成本地交互，没有接真实 AI / 模型 / 视频任务

现象：

- 导演台能本地操作角色、机位、截图。
- AI 识图、几何模型库、真实 first_last_frame 视频生成都还没接。

证据：

- `public/tools/ultimate-canvas/app.js:2122`：AI 识图导入未接图像理解接口。
- `public/tools/ultimate-canvas/app.js:2143`：几何模型库未接入。
- `public/tools/ultimate-canvas/app.js:2155-2156`：只创建视频节点，真实 first_last_frame 生成接口待接入。

推荐动作：

- 先把导演台截图作为真实资产上传。
- 再把“首尾帧视频”接到 `/api/tasks/create` 的 first_last_frame 模式。
- AI 识图导入单独接图像理解 API，不要和普通 LLM 混用。

## 6. P2 未闭环问题

### P2-1：页面占位 / 跳转路由仍较多

现象：

- 一些路由不是正式页面，只是跳转到其他页面。

例子：

- `src/app/admin/tasks/page.tsx` -> `/admin/projects`
- `src/app/admin/exceptions/page.tsx` -> `/admin/projects`
- `src/app/admin/resources/page.tsx` -> `/admin/projects`
- `src/app/admin/pricing/page.tsx` -> `/admin/users`
- `src/app/points/page.tsx` -> `/generate`
- `src/app/videos/page.tsx` -> `/assets?type=video`
- `src/app/workbench/page.tsx` -> `/tools/ultimate-canvas`

判断：

- 这些不一定都是 bug；如果产品策略就是合并入口，可以保留。
- 但如果导航里仍展示这些名字，会让用户以为有二级页面，实际没有。

推荐动作：

- 导航只保留真实可用入口。
- 如果是合并入口，页面标题和导航命名要统一，避免用户找不到。

### P2-2：无线画布基础编辑体验还不是正式创作工具级别

未闭环项：

- 撤销 / 重做。
- 多选批量移动、复制、删除。
- 小地图。
- 移动端 / 小屏策略。
- 键盘可访问性。
- 3D 资源懒加载。

推荐动作：

- 等 P0 生成闭环完成后再补。
- 不要先花大量时间打磨这些体验，否则会把“不能真实生成”的根问题掩盖掉。

## 7. 已完成上传 / 后续不应直接混合开发的内容

当时生产工作区里的已上线源码已整理为检查点提交 `f65e151`，并推送 rollback tag `rollback/2026-06-18-sd2-deployed-checkpoint`。下面这些分组仍然有参考价值：后续继续开发时，应按业务意图拆分，而不是把未闭环新功能继续混进同一个提交。

### 建议提交 A：旧画布归档 / 隐藏

包含：

- 旧 `/generate/canvas` 页面删除或隐藏。
- 旧 canvas API 删除或归档。
- 导航和 middleware 指向新无线画布。

风险：

- 如果新无线画布还没保存 API，删旧 `src/lib/canvas/*` 可能会让后续复用 CanvasDocument 的工作缺少现成逻辑。

建议：

- 先确认旧画布 zip 归档文件存在，再提交。

### 建议提交 B：模板系统工作台

包含：

- `src/app/admin/templates/*`
- `src/app/api/templates/*`
- `src/components/templates/*`
- `src/lib/templates/*`
- 模板 smoke 脚本。

风险：

- 当前 TODO 里模板还有 P0 未完成，不能标记为全功能完成。

建议：

- 可以先提交“模板工作台阶段版”，但版本说明必须写清楚未闭环项。

### 建议提交 C：无线画布正式生成闭环

包含：

- 项目 / 视频卡 bootstrap。
- image/video 真实 endpoint。
- 状态轮询、预览、下载、资产回写。
- 点数 / 流水。

风险：

- 会触及生成、点数、资产、任务、Provider，必须单独开发和验证。

### 不应提交

- `.next-prod-prev/`
- `node_modules`
- `storage`
- 任何 `.env`、API Key、token、cookie、临时签名 URL。

## 8. 推荐落地顺序

### 第 1 步：先把误导性入口收口

目标：

- 没接真实后端的按钮，不再看起来像已经能生成。

任务：

- image/video 无 endpoint 时改成明确错误或禁用，不再返回 mock 成功。
- 页面“预览版，不扣点”改成更准确的状态，或者只在未接正式生成时显示。
- 协作、分享、通知、头像、反馈、历史选择等明确隐藏 / 置灰 / 接真实系统。

验收：

- 用户不会再遇到“能输入、能点、但啥都没发生”的误导。

### 第 2 步：打通无线画布正式生成 MVP

目标：

- 让无线画布成为真正的普通生成工具。

任务：

- 外层注入项目 / 视频卡 / 点数 / endpoint。
- 视频节点调用 `/api/tasks/create`。
- 图片节点调用 `/api/assets/generate`。
- 节点轮询 `/api/video/status/:taskId?refresh=true`。
- 成功后展示预览、截图、下载、任务详情。

验收：

- 文生视频、文生图、首尾帧至少各跑通一个非 mock 流程。
- 后台任务、资产、点数流水都能查到来源。

### 第 3 步：补齐自动本地保存的系统级保证

目标：

- 所有通过本站接口创建的视频任务，最终都能被服务器本地保存和生成截图。

任务：

- 配置 launchd / cron 跑 `scripts/finalize-pending-videos.ts`。
- 后台增加待本地化任务监控。
- 对外部 API 创建任务做接口级验证。

验收：

- 服务重启后，遗留 running / succeeded-but-local-missing 任务仍能被补偿处理。
- `/api/video/play/:id` 和 `/api/video/thumbnail/:id` 可用。

### 第 4 步：提交和上传分批闭环

目标：

- 每一批都是可回退版本。

任务：

- 旧画布归档提交。
- 模板系统阶段提交。
- 无线画布正式生成提交。
- 自动本地保存补偿提交。

验收：

- 每个提交都有远端分支可见。
- 每个稳定点有 rollback tag 或等价保护分支。
- 版本登记到 `/Volumes/Data/Projects/project-version-registry.md`。

## 9. 总结

当前最容易误判的地方有三个：

1. 无线画布 text/script LLM 已经接好，不代表 image/video 生成接好了。
2. 图形生成 API 已经存在，不代表无线画布已经调用它。
3. 视频本地保存底座已经存在，不代表服务重启后所有任务都有系统级补偿保证。

下一轮如果开始落地，建议先做 P0-1 到 P0-3：无线画布 image/video 真实生成、项目 / 视频卡归属、点数和任务轮询。这样能最快把“可交互 Demo”变成“现有后台体系里的正式生成工具”。
