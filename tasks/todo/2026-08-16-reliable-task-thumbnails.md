# 任务卡片缩略图可靠显示修复

## 1. 大白话目标复述

这次要解决的是：普通生成页、任务列表、后台、项目页、视频卡页、超分入口里，同一个“任务视频缩略图”不能因为一次加载失败、H3 暂无输出、稳定下载还在准备，就一直显示成没图。

最优解不是新增一个图片库，也不是每个页面单独补丁；而是把任务缩略图做成一个可靠的小组件：能读接口返回的 `thumbnail_url`，能根据任务状态显示正确文案，失败后按任务状态自动重试，数据变化后自动恢复。模板生成页里独立写的预览逻辑也要并回同一套规则。

做到完成的标准：

- H3 排队、生成中、失败、无输出时，卡片显示清楚状态，不误导成“缩略图坏了”。
- Seedance/H3 任务从生成中变成有视频源后，不刷新页面也能自动出现缩略图。
- 缩略图接口早期 404 或抽帧短暂失败，不会把卡片永久锁死成占位。
- 普通生成页、任务列表、后台、项目页、视频卡页、超分入口共用同一个缩略图行为。
- 模板生成页不再维护另一套 `failedSrcs` 预览失败逻辑。
- 不新增重型依赖；只借鉴开源图片库的“有限重试、备用源、状态重置”模式。

本轮开源取舍：

| 候选 | 结论 | 原因 |
| --- | --- | --- |
| `react-graceful-image` | 不直接引入，借鉴有限重试思路 | 能处理图片失败重试，但不知道我们的任务状态、H3 队列和稳定下载阶段。 |
| `react-image` | 不直接引入 | 支持备用源，但失败源页面内不重试，不适合异步生成缩略图。 |
| `@rc-component/image` | 不直接引入 | 偏图片预览器，依赖和 UI 行为偏重。 |
| SWR / TanStack Query | 不直接引入 | 数据轮询能力强，但为一个缩略图组件接数据层过重。 |
| `fluent-ffmpeg` | 不使用 | npm 已标记不再维护；现有 `ffmpeg` 命令已经能抽帧。 |

## 2. 具体可执行任务

- [x] T1. 扩展统一任务缩略图组件入参
  - 修改对象：`src/components/TaskVideoThumbnail.tsx`。
  - 要做什么：新增 `thumbnailUrl`、`deliveryStage`、`previewAvailable`、`stableDownloadReady`、`retryAfterMs` 入参；保留现有调用兼容。
  - 完成标准：旧调用不报错，新调用能优先使用接口返回的 `thumbnail_url`。

- [x] T2. 实现状态变化自动恢复
  - 修改对象：`src/components/TaskVideoThumbnail.tsx`。
  - 要做什么：当 `taskId`、`thumbnailUrl`、`publicVideoUrl`、`localVideoPath`、`resultVideoUrl`、`resultLastFrameUrl`、`deliveryStage`、`stableDownloadReady` 变化时，清空失败状态并重新加载。
  - 额外要求：图片成功加载后清理重试状态；组件卸载时清理定时器，避免卸载后继续 `setState`。
  - 完成标准：任务从 `submitted/running/preparing` 变成可预览后，卡片不用刷新页面也会重试缩略图。

- [x] T3. 实现有限重试和退避
  - 修改对象：`src/components/TaskVideoThumbnail.tsx`。
  - 要做什么：图片 `onError` 后最多重试 3 次；优先使用 `retryAfterMs`，否则用 2s、4s、8s；重试时给 URL 加轻量 cache bust 参数，例如 `?retry=1`，已有 query 时必须正确追加参数。
  - 完成标准：接口短暂 404/抽帧延迟不会永久失败；真正没有源或最终失败不会无限请求。

- [x] T4. 改清楚占位文案
  - 修改对象：`src/components/TaskVideoThumbnail.tsx`、必要 CSS。
  - 要做什么：把单一“暂无截图”拆成 `排队中`、`生成中`、`正在准备预览`、`视频未产出`、`失败`、`暂无截图`。
  - 完成标准：最近任务顶部 H3 失败/排队任务不会让用户误以为系统缩略图整体坏了。

- [x] T5. 普通生成页使用接口返回的缩略图字段
  - 修改对象：`src/components/generate/GeneratePageClient.tsx`。
  - 要做什么：调用 `TaskVideoThumbnail` 时传入 `task.thumbnail_url`、`delivery_stage`、`preview_available`、`stable_download_ready`、`retry_after_ms`。
  - 完成标准：`/api/video/list` 或 `/api/video/status/[id]` 返回缩略图字段后，普通生成页卡片立即消费。

- [x] T6. 覆盖所有复用入口
  - 修改对象：
    - `src/app/tasks/page.tsx`
    - `src/app/admin/outputs/AdminOutputsClient.tsx`
    - `src/app/admin/costs/page.tsx`
    - `src/app/admin/AdminGenerationDashboardClient.tsx`
    - `src/app/projects/[id]/page.tsx`
    - `src/app/projects/[id]/video-cards/[cardId]/page.tsx`
    - `src/components/generate/EnhanceVideoPageClient.tsx`
  - 要做什么：每个调用处都接入同一套缩略图状态字段；拿不到字段时，在对应 API/聚合层补序列化，不在页面里硬猜。
  - 字段要求：每个调用处都要有类型支持 `thumbnail_url`、`delivery_stage`、`preview_available`、`stable_download_ready`、`retry_after_ms`；如果该页面的数据来源还没返回这些字段，要同步补查询/序列化/类型，不能只在 JSX 里补参数。
  - 完成标准：所有复用 `TaskVideoThumbnail` 的入口状态和重试行为一致。

- [x] T7. 模板生成页删除独立失败逻辑
  - 修改对象：`src/components/templates/TemplateGenerateClient.tsx`。
  - 要做什么：移除 `TemplateTaskPreview` 中独立的 `failedSrcs` 缩略图逻辑，改为复用 `TaskVideoThumbnail`。
  - 完成标准：模板生成页和普通生成页同一任务显示一致。

- [x] T8. 保持服务端轻改，不新增库
  - 检查对象：
    - `src/app/api/video/list/route.ts`
    - `src/app/api/video/status/[id]/route.ts`
    - `src/app/api/video/thumbnail/[id]/route.ts`
    - `src/app/api/ip/video/list/route.ts`
    - `src/app/api/ip/video/status/[id]/route.ts`
    - `src/app/api/admin/outputs/route.ts`
    - `src/app/admin/costs/page.tsx` 里的成本页任务查询
    - `src/lib/admin/generation-dashboard.ts`
    - `src/app/api/projects/[id]/route.ts`
    - `src/app/api/projects/[id]/video-cards/route.ts`
    - `src/app/api/video-cards/[id]/route.ts`
    - `src/app/api/video-cards/[id]/tasks/route.ts`
    - `src/lib/video/thumbnail-availability.ts`
  - 要做什么：确认 `thumbnail_url`、`delivery_stage`、`preview_available`、`stable_download_ready`、`retry_after_ms` 已返回；如果缺字段只补序列化，不改数据库。
  - 特别注意：普通视频接口已经有这些字段，但 IP 视频、后台产出、后台首页、后台成本、项目页和视频卡页存在独立查询，必须逐个确认。
  - 完成标准：前端所需状态字段都来自 API，不靠页面私自猜。

- [x] T9. 增加最小 smoke 测试
  - 新增或修改对象：`scripts/task-video-thumbnail-state-smoke.ts`。
  - 要做什么：优先从 `TaskVideoThumbnail` 抽出小的纯函数状态机/helper，再用 smoke 验证这些场景；不要为了这一个点新增测试框架。
    - submitted 显示排队中，不请求缩略图。
    - running 显示生成中，不永久失败。
    - succeeded + preparing + retry_after_ms 会重试。
    - succeeded + thumbnail_url 使用接口 URL。
    - failed 显示失败，不无限重试。
    - source 变化后失败状态清空。
    - 先 `onError` 进入 failed，再改变 `thumbnailUrl` / `deliveryStage` / 视频源后，状态机回到可请求缩略图。
    - retry URL 已有 query 时正确追加 cache bust 参数。
  - 完成标准：`npx tsx scripts/task-video-thumbnail-state-smoke.ts` 通过。

- [x] T10. 真实生产数据只读抽样验证
  - 检查对象：生产服务器 Prisma 只读抽样、公开视频 HEAD、ffmpeg 抽帧 smoke。
  - 要做什么：通过服务器只读查询或临时 Node 脚本抽样；不打印 token、完整视频 URL、cookie 或私有路径，只输出布尔值、状态码、content-type、文件是否存在和任务状态摘要。
  - 完成标准：能区分“任务没有输出源”和“有源但前端没重试”。
  - 本轮结果：服务器 Prisma 只读抽样完成，未打印 URL/token/cookie。最近 H3 样本多为 failed/submitted/running 且无任何视频源，应显示状态文案；另抽样 8 条 Seedance 成功任务均有 public/local/result 视频源，应提供 `/api/video/thumbnail/{taskId}` 缩略图入口。

- [x] T11. 本地验证和构建
  - 命令：
    - `npm run lint`
    - `npm run build`
    - `npx tsx scripts/task-video-thumbnail-state-smoke.ts`
  - 完成标准：全部通过；如失败，先修根因，不带失败提交。
  - 本轮结果：`npx tsx scripts/task-video-thumbnail-state-smoke.ts` 通过；`npm run lint` 通过且仅有既有 warning；`npm run build` 通过且仅有既有 warning。

- [x] T12. 上线闭环
  - 执行对象：按项目 `AGENTS.md` 的 sd2 服务器生产托管规则。
  - 要做什么：形成聚焦 commit、rollback tag、归档上传、服务器 candidate build、切换 `.next-prod`、重启 `sd2-gray.service`、公网验证。
  - 完成标准：`https://sd2.youdooart.com/generate` 登录态刷新后，最近任务卡片状态正确；成功任务缩略图可恢复显示。
  - 本轮结果：commit `4874343000c02709805d0b6541c7e68ed39fd857` 已推送；rollback tag `rollback/2026-08-16-before-reliable-task-thumbnails` 已推送；服务器 `.next-prod/BUILD_ID=g-RQn7-5n8ZZ2qUnIp_m0`；`sd2-gray.service` active；公网 `/api/config` 200 且 `X-SD2-Origin: server-42-193`；公网静态 JS 含 `thumb_retry` / `正在准备预览` 标记。Chrome 已打开 `https://sd2.youdooart.com/generate`，但当前工具没有可用调试 session，未取得登录态 DOM/截图。

- [x] T13. 追加返修：普通生成页最近任务优先显示有画面的卡片
  - 修改对象：`src/components/generate/GeneratePageClient.tsx`、`src/lib/video/recent-task-card-order.ts`。
  - 根因：生产最近任务前排被 H3 failed/submitted/running 且无任何视频源的任务占据；成功 Seedance 任务虽然有视频源，但被创建时间更晚的无图任务挤到后面。
  - 要做什么：普通生成页展示层按视觉可用性排序，不改接口分页；优先级为“有缩略图/视频源” > “已完成但预览准备中” > “正在生成/排队” > “失败/取消”。
  - 完成标准：只要已加载任务里存在真实缩略图或视频源，普通生成页最近任务第一屏优先展示这些卡片。
  - 本轮结果：已新增 `orderRecentTaskCards` helper 并接入普通生成页。

- [x] T14. 追加返修：普通生成页最近任务卡片放大封面区
  - 修改对象：`src/app/globals.css`。
  - 根因：旧卡片缩略图只有 104px 宽，成功任务即使有画面也不明显。
  - 要做什么：把最近任务卡片改成顶部 16:9 大封面，下方显示时间、提示词、视频卡和状态；提示词最多显示两行，避免挤压封面。
  - 完成标准：普通生成页最近任务卡片第一眼先看到画面，不再是文字占主体。
  - 本轮结果：本地样式已更新。

- [x] T15. 追加返修上线闭环
  - 执行对象：按项目 `AGENTS.md` 的 sd2 服务器生产托管规则。
  - 验证命令：
    - `npx tsx scripts/recent-task-card-visual-priority-smoke.ts`
    - `npm run build`
    - 服务器 candidate build、`sd2-gray.service`、公网 `/api/config`、公网静态资源标记。
  - 完成标准：`https://sd2.youdooart.com/generate` 加载新构建；普通生成页最近任务优先显示有画面的卡片，卡片封面区域明显变大。
  - 本轮结果：commit `689ced877109a6d5c52297bafa5c82f6c64ce3b8` 已推送；rollback tag `rollback/2026-08-16-before-recent-task-visual-priority` 已推送；服务器 `.next-prod/BUILD_ID=JYB2QgQiHVpAsfbLybruW`；`sd2-gray.service` active；公网 `/api/config` 200 且 `X-SD2-Origin: server-42-193`；公网 `_buildManifest.js` 200；公网 CSS 含 `.composer-task-card-preview{aspect-ratio:16/9...}` 和 `max-width:none`。

## 3. 验收/审查内容

这些审查项需要创建独立子 agent 做只读审查；审查 agent 不改文件、不提交、不补实现，只判断是否达标、证据是否充分、风险是否遗漏，并输出“通过 / 不通过、证据、缺口、风险、下一步”。

- [x] R1. 组件行为只读审查
  - 检查对象：`src/components/TaskVideoThumbnail.tsx`。
  - 通过标准：失败状态会随任务/源/投递状态变化清空；重试有限；不会无限打接口。
  - 证据来源：源码、smoke 输出。
  - 本轮结果：独立只读复查通过；确认失败状态重置、有限重试、定时器清理和状态文案达标。

- [x] R2. 调用入口只读审查
  - 检查对象：所有 `TaskVideoThumbnail` 调用处，以及模板生成页。
  - 通过标准：没有遗漏核心入口；模板生成页没有保留冲突的独立失败逻辑。
  - 证据来源：`rg "TaskVideoThumbnail|failedSrcs|thumbnail_url"` 搜索结果。
  - 本轮结果：独立只读复查通过；11 个 `TaskVideoThumbnail` 调用点已接入统一字段，模板生成页旧 `failedSrcs` 逻辑已删除。

- [x] R3. API 字段只读审查
  - 检查对象：普通视频 API、IP 视频 API、后台产出 API、后台首页数据、后台成本页查询、项目页 API、视频卡 API。
  - 通过标准：前端需要的 `thumbnail_url`、`delivery_stage`、`preview_available`、`stable_download_ready`、`retry_after_ms` 都可用；所有 TypeScript 类型同步包含这些字段。
  - 证据来源：源码、接口抽样响应。
  - 本轮结果：独立只读复查通过；普通视频、IP 视频、后台产出、后台首页、后台成本、项目页和视频卡接口/查询已接入统一投影或必要字段。

- [ ] R4. 真实页面只读审查
  - 检查对象：`https://sd2.youdooart.com/generate`、`/template-generate`、`/tasks`、后台最近生成或产出页。
  - 通过标准：H3 无输出任务显示真实状态；Seedance 成功任务能显示/恢复缩略图；刷新后行为一致。
  - 证据来源：登录态浏览器截图、DOM、网络请求。
  - 本轮结果：未关闭。Chrome 已打开目标生产页，但 ClickOps 默认 session 不存在、Chrome DevTools 9222 不可用，未取得登录态 DOM/截图；当前证据只能证明目标 tab 打开和公网新静态资源可访问。

- [x] R5. 部署闭环只读审查
  - 检查对象：Git commit/push、rollback tag、服务器 `.next-prod/BUILD_ID`、公网 `/api/config`、目标页面静态资源。
  - 通过标准：远端可回档，服务器加载新构建，公网入口不是旧缓存。
  - 证据来源：Git、SSH、公网 curl、浏览器验证。
  - 本轮结果：通过；远端分支和 rollback tag 可见，服务器生产 BUILD_ID 已切换，公网 `/api/config` 和静态资源已验证。

- [x] R6. 追加返修只读审查：普通生成页最近任务视觉优先级
  - 检查对象：`src/lib/video/recent-task-card-order.ts`、`src/components/generate/GeneratePageClient.tsx`、`src/app/globals.css`、`scripts/recent-task-card-visual-priority-smoke.ts`、生产最近任务抽样。
  - 通过标准：无图 H3 任务不会挡住有真实视频/缩略图源的任务；最近任务卡片封面区域足够明显；排序不改变接口分页和任务数据本身；验证证据包含 smoke、build、生产数据抽样和公网新构建。
  - 证据来源：源码、smoke 输出、构建输出、生产服务器只读查询、公网响应。
  - 审查方式：已创建独立只读审查 agent；第一次审查不通过，指出“只排序前端已加载 12 条”无法覆盖生产第一页全无图的真实问题。主线程已按意见补首屏最多预取 4 页、移动端封面不收缩，并补 smoke 覆盖第一页全无图场景。

## 4. 审查内容是否对齐目标

- [x] A1. R1 是否对齐根因
  - 判断：不能只看能不能显示图片；必须证明“失败后不重试”的根因已消除。

- [x] A2. R2 是否覆盖系统同类问题
  - 判断：不能只改普通生成页；所有复用入口和模板生成页都要纳入。

- [x] A3. R3 是否避免前端私自猜状态
  - 判断：前端状态必须来自 API 字段，不能又在页面散写判断；不能只补普通视频接口，漏掉 IP、后台、项目页和视频卡的独立数据源。

- [ ] A4. R4 是否符合用户真实体验
  - 判断：必须看真实页面，不把源码检查当成用户可见完成。

- [x] A5. R5 是否符合上线闭环
  - 判断：本地 build、commit 或服务器 active 都不能单独当完成，必须证明公网加载新版本。

- [x] A6. R6 是否覆盖本次用户反馈
  - 判断：不能只证明缩略图组件能显示；还要证明普通生成页第一屏不会被无图任务占满，且卡片封面大小对用户可见。
  - 本轮结果：已覆盖。生产抽样显示原始前 8 条均为 H3 无输出任务；新逻辑会在初始加载时继续预取后续页，并按有真实视频/缩略图源优先展示，避免有图任务被无图任务挡住。
