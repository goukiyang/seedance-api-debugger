# 视频截图稳定固化与历史补偿

## 1. 大白话目标复述

这次不是只修 `/assets` 某个图片不显示，而是把整个系统里“视频、图片、音频、截图、预览、下载、缓存”这类运行时媒体结果统一检查一遍。目标是：生成成功或上传成功后，用户在资产页、任务页、生成页、模板页、图集页和后台列表里看到的预览图都来自稳定资产，不再靠页面临时生成、不再因为缓存或旧链接导致全页没图。

做到完成的标准：

- 新生成的视频任务完成后，会产出稳定视频地址和稳定截图地址。
- 资产页、任务页、模板页等入口使用同一套“是否可预览、是否可截图、是否可下载”的判断规则。
- 历史没有截图、截图坏了、截图地址过期的任务能被补偿脚本批量修复或标记真实失败原因。
- 上传视频素材、参考图、模板素材、反馈截图等非任务媒体，也有清楚的缩略图/预览兜底策略。
- 线上 `https://sd2.youdooart.com` 真实页面能看到缩略图，不只停留在代码入口存在。

## 2. 系统级同类风险排查表

| 编号 | 风险面 | 当前线索/相关位置 | 为什么会出现同类问题 | 影响入口 | 根治动作 | 验收标准 |
| --- | --- | --- | --- | --- | --- | --- |
| S1 | 视频任务截图 | `src/app/api/video/thumbnail/[id]/route.ts`、`src/lib/video/thumbnail.ts`、`src/lib/video/thumbnail-availability.ts` | 现在部分入口按需抽图，且截图来源规则不统一；有的视频有 `result_video_url`，但资产页不一定认为它可截图。 | 资产页、任务页、模板生成页、后台视频列表 | 把截图产出前移到任务完成后台流程；新增统一媒体可用性 helper；页面只读稳定截图字段。 | 新任务成功后数据库有稳定截图状态/地址；刷新资产页不触发大量临时抽图；截图 200。 |
| S2 | 视频稳定播放/下载 | `src/lib/video/public-delivery.ts`、`src/lib/video/local-cache.ts`、`src/app/api/video/play/[id]/route.ts`、`src/app/api/video/download/[id]/route.ts` | 视频结果可能停在第三方临时链接、本地路径或内部链接；预览可用和下载可用不是一回事。 | 任务详情、资源管理预览、批量下载 | 固化为站内/R2/TOS 稳定视频地址；预览、下载、ZIP 都读同一分发状态。 | 同一个任务单播、预览、批量下载都使用稳定地址；第三方链接过期不影响已固化任务。 |
| S3 | Asset 上传视频缩略图 | `src/app/api/assets/upload*`、`src/lib/assets/storage.ts`、`src/app/api/assets/library/route.ts` | 历史反馈已提示 Asset 视频缩略图和任务视频缩略图是两条链路；上传视频可能只有原视频，没有缩略图。 | 上传历史、资产页、生成页选择历史素材 | 上传视频后异步抽封面并写入 `Asset.thumbnail_url`；失败写 `thumbnail_status/error`。 | 上传一个视频素材后资产页能看到封面；历史视频素材不会全是“视频素材”占位。 |
| S4 | 上传图片/参考图缩略图 | `src/app/api/assets/upload/route.ts`、`src/app/api/reference-albums/[id]/images/route.ts`、`src/app/api/reference-images/[id]/content/route.ts` | 图片原图和缩略图可能一个成功一个失败；旧 `/uploads` 或旧域名链接可能失效。 | 上传历史图片、参考图集、生成页参考图、模板绑定图 | 统一图片上传结果校验：原图、缩略图、尺寸、文件大小、hash、可访问性都写入同一资产记录。 | 新上传图原图和缩略图公网 200；重复上传复用稳定地址；旧域名会归一到新域名。 |
| S5 | 模板素材预览 | `src/components/templates/*`、`src/lib/templates/*` | 模板卡片直接读 `thumbnail_url || url`，如果资产坏了，没有统一失败态和补偿。 | 模板库、模板编辑、模板生成页 | 模板素材只绑定资产 ID 或参考图 ID；展示时走统一媒体投影，不直接信任旧 URL。 | 模板卡片刷新后仍显示图；坏链接显示可修复状态，不吞成空白。 |
| S6 | 生成页参考素材条 | `src/components/ReferenceThumb.tsx`、`src/components/ReferenceStrip.tsx`、`src/components/UploadedImagePicker.tsx` | 生成页有图片、视频、音频三类参考素材，但预览兜底和错误展示分散在组件里。 | `/generate` 参考素材、历史上传弹窗 | 统一 `WorkspaceAssetItem` 的预览模型：图片显示缩略图，视频显示封面，音频显示音频占位和可播放状态。 | 添加图片/视频/音频后都能稳定预览；坏素材有明确提示，不影响其他素材显示。 |
| S7 | 资产页 IndexedDB 缓存 | `src/app/assets/page.tsx`、`src/lib/assets/library-cache.ts` | 当前缓存只保留 `/` 开头地址，R2/TOS 等完整 https 地址会被清空；网络同步失败时用户看到无图缓存。 | `/assets` 首屏、筛选切换、弱网回看 | 缓存允许经过白名单校验的同源/R2/TOS 公网媒体 URL；缓存项保存媒体状态，不把 URL 静默置空。 | 断网/慢网时缓存仍能显示上次可用缩略图；不会把外链图全部清掉。 |
| S8 | `/uploads` 运行时文件服务 | `src/app/uploads/[...path]/route.ts`、`next.config.js` | 运行中新写入 `public/uploads` 的文件不能只依赖 Next 静态目录；历史已出现过新文件公网 404。 | 上传图片、生成图片、参考图、模板图 | 保留动态 `/uploads` 路由；补视频/音频/缩略图 Range、HEAD、MIME 回归。 | 服务启动后新写入上传文件立刻公网 200；HEAD 和 Range 正常。 |
| S9 | 后台列表/最近任务缩略图 | `src/app/admin*`、`src/app/tasks/page.tsx`、`src/app/api/video/list/route.ts` | 后台和任务页可能各自拼缩略图 URL，规则和资产页不同。 | 后台最近生成、后台产出、任务列表 | 后台和任务页都使用统一媒体投影字段，不再重复判断。 | 同一任务在后台、任务页、资产页显示同一缩略图和同一状态。 |
| S10 | 批量下载/ZIP manifest | `src/lib/video/bulk-download.ts`、`src/lib/video/download-client.ts` | ZIP 会遇到视频链接过期、缓存未完成、单个文件失败；manifest 存在不等于用户真实可下载。 | 资产页批量下载、任务批量导出 | 批量下载只接受稳定分发已就绪任务；未就绪任务先进入刷新/补偿队列，manifest 写清失败原因。 | 20 个任务内可稳定打包；失败项不会卡死整体下载，并能在 manifest 看到原因。 |
| S11 | Provider/官方素材预览 | `src/components/SeedanceAssetPanel.tsx`、`src/components/SeedanceAssetSelector.tsx`、`src/lib/provider/*` | 官方素材预览 URL 可能是第三方地址，和本站资产地址生命周期不同。 | Seedance 官方素材面板、官方素材选择器 | 官方素材创建成功后同步保存本站 Asset 预览；前端优先用本站稳定预览。 | 官方素材列表刷新后仍能显示预览；第三方预览过期不影响本站历史素材。 |
| S12 | 反馈截图/诊断附件 | `src/components/FeedbackWidget.tsx`、反馈上传链路 | 反馈截图如果只在本地对象 URL 或临时上传结果里，后端排查时可能看不到附件。 | 反馈页、后台反馈诊断 | 反馈附件必须走统一 Asset 上传，保存 asset ID、hash、缩略图和访问权限。 | 后台反馈能打开附件缩略图和原图；失败时不显示“系统性错误”泛化文案。 |
| S13 | 画布/工具内媒体节点 | `public/tools/ultimate-canvas`、`src/app/api/tools/ultimate-canvas/upload/route.ts` | 工具内节点可能保存旧 URL 或本地路径，脱离资产表后无法统一补偿。 | 无线画布、项目内生成节点 | 工具节点保存 asset/task/reference ID，展示时通过统一媒体投影拿 URL。 | 画布刷新、迁移、部署后节点图仍可显示；坏图可追溯到资产记录。 |
| S14 | 用户头像/身份图片 | `src/components/AccountMenu.tsx`、`src/components/UserIdentityBadge.tsx`、用户展示组件 | 虽不是视频截图，但同样是外链图片；失败后会影响身份识别。 | 顶部账号、成员、后台用户 | 头像保持真实 URL 但必须有稳定 fallback；不进入视频截图补偿队列。 | 头像坏链不影响页面布局；有默认头像兜底。 |
| S15 | 静态工具硬编码媒体规则 | `public/tools/ultimate-canvas/app.js`、`public/tools/ultimate-canvas/generation-node-workflow.js` | 静态画布脚本里仍有 `/api/video/thumbnail`、`result_video_url`、`downloadUrl` 等本地拼接规则，可能绕过统一 helper。 | 无线画布视频节点、素材库节点、生成节点 | 静态工具也改为消费统一 API 返回的媒体投影字段；禁止在工具端重新推导截图/下载规则。 | `rg` 复查静态工具里不再存在冲突媒体判断；画布节点和资产页显示一致。 |
| S16 | 数据库变更与迁移风险 | `prisma/schema.prisma`、历史迁移、服务器 SQLite | 新增截图状态字段会碰到历史迁移、生产 SQLite、回滚兼容问题；只改 schema 不等于生产库可用。 | 所有任务/资产接口 | 先查实际生产表结构；迁移脚本可重复执行；旧代码读新字段、新代码读旧数据都要兼容。 | 本地迁移、服务器候选库迁移、回滚前后接口都能启动；不会被历史失败迁移卡住。 |
| S17 | FFmpeg/ffprobe 运行环境风险 | `src/lib/video/thumbnail.ts`、服务器 systemd 环境 | 本地有 FFmpeg 不代表服务器有；路径、权限、编码器、超时和大视频内存都可能失败。 | 任务收尾、上传视频缩略图、历史补偿 | 部署前检查 `ffmpeg`/`ffprobe` 路径；抽帧设置超时、最大输入、失败日志；缺失时给明确运维错误。 | 服务器 `command -v ffmpeg ffprobe` 通过；抽帧 smoke 输出成功/失败原因。 |
| S18 | 并发与队列压力风险 | finalizer、media ingest、补偿脚本、页面请求 | 如果大量任务同时完成或历史补偿一次跑太多，抽帧会吃 CPU/IO；页面请求触发抽帧会拖慢首屏。 | 资产页、任务页、后台收尾 worker | 抽帧只在后台限流执行；页面接口不做重活；补偿脚本支持 batch、limit、resume。 | 并发任务不会让页面超时；补偿脚本可中断续跑。 |
| S19 | 权限和租户隔离风险 | `/api/video/thumbnail/[id]`、`/uploads`、对象存储公开地址 | 把截图变成稳定 URL 后，可能绕过任务权限；私有任务缩略图不应被无权限用户枚举。 | 私有项目、管理员/普通用户资产页、分享场景 | 明确哪些缩略图可公开、哪些必须走鉴权 API；公开对象使用不可猜 key；删除/隐藏后访问策略同步。 | 未登录或无权限用户不能看私有缩略图；公开视频缩略图仍可正常展示。 |
| S20 | 缓存失效和版本化风险 | 浏览器缓存、IndexedDB、CDN、`Cache-Control` | 同一个截图 URL 被替换后，浏览器/CDN 可能继续显示旧图或坏图。 | 资产页、任务页、模板页、画布 | 缩略图 URL 带版本或内容 hash；重生成后更新 URL；IndexedDB schema 版本升级时清理旧坏缓存。 | 重生成截图后刷新页面能看到新图；旧缓存不会长期覆盖真实结果。 |
| S21 | 删除、隐藏、归档与文件清理风险 | retention、soft delete、Asset 删除、项目归档 | 缩略图固化后可能留下孤儿文件；删除视频但截图仍可访问会造成隐私和存储问题。 | 删除失败视频、隐藏资产、项目归档 | 软删除保留审计但同步限制访问；物理清理走后台清理任务和审计记录。 | 删除/隐藏后普通用户不可访问缩略图；清理任务不会误删仍被引用文件。 |
| S22 | 监控与自动发现风险 | 后台日志、反馈、OperationLog、smoke | 如果没有监控，截图失败只会等用户反馈才知道；无法判断是否再次系统性复发。 | 运维后台、反馈页、每日诊断 | 增加缩略图失败统计、最近失败样本、每日 smoke 或后台诊断入口。 | 后台能看到失败数量和样本；异常增长能被每日反馈/诊断发现。 |

## 3. 具体可执行任务

- [ ] T1. 建立统一媒体投影和状态模型
  - 修改对象：`src/lib/video/thumbnail-availability.ts` 或新增 `src/lib/media/media-projection.ts`。
  - 要做什么：统一输出 `previewUrl`、`thumbnailUrl`、`downloadUrl`、`thumbnailStatus`、`previewAvailable`、`stableDownloadReady`、`reason`。
  - 完成标准：资产页、任务列表、状态接口不再各自散写“哪些字段算可预览/可截图”。

- [ ] T2. 给 `VideoTask` 增加稳定截图字段和状态
  - 修改对象：`prisma/schema.prisma`、相关序列化接口。
  - 要做什么：增加视频截图地址、存储来源、截图状态、错误原因、生成时间字段；如已有等价字段则复用，不重复建模。
  - 完成标准：任务完成后截图是否成功有明确记录，不再只能靠文件是否存在猜。

- [ ] T3. 把视频任务完成链路改成先固化截图
  - 修改对象：`src/lib/video/task-finalizer.ts`、`src/lib/video/media-ingest.ts`、`src/lib/video/thumbnail.ts`。
  - 要做什么：成功任务缓存/分发视频后，用 FFmpeg 抽帧，写入稳定截图地址和状态；失败只影响截图状态，不回滚视频成功和点数结算。
  - 完成标准：新成功任务在后台完成后即具备稳定截图，不需要用户打开资产页才触发。

- [ ] T4. 补齐 Asset 上传视频缩略图链路
  - 修改对象：`src/app/api/assets/upload*`、`src/lib/assets/storage.ts`。
  - 要做什么：上传视频素材时抽一张封面并写入 `Asset.thumbnail_url`；图片继续用图片缩略图；音频使用稳定音频占位。
  - 完成标准：上传视频素材在资产页、生成页历史素材弹窗里有封面。

- [ ] T5. 修复资产页缓存策略
  - 修改对象：`src/app/assets/page.tsx`、`src/lib/assets/library-cache.ts`。
  - 要做什么：缓存允许可信公网媒体 URL；缓存中保存媒体状态和失败原因；网络同步失败时不把可用缩略图清空。
  - 完成标准：弱网或接口失败时可以显示上次有效缩略图，并提示“当前显示缓存”。

- [ ] T6. 统一所有展示入口
  - 修改对象：`src/app/assets/page.tsx`、`src/app/api/assets/library/route.ts`、`src/app/api/video/list/route.ts`、`src/app/api/video/status/[id]/route.ts`、`src/components/templates/*`、`src/components/UploadedImagePicker.tsx`、`src/components/ReferenceThumb.tsx`。
  - 要做什么：各入口统一读取媒体投影字段；不再手写 `thumbnail_url || url` 的散乱规则。
  - 完成标准：同一资产/任务在不同页面显示同一张缩略图和同一状态。

- [ ] T7. 历史任务和历史素材补偿脚本
  - 新增对象：`scripts/backfill-video-thumbnails.ts` 或复用现有 finalize 脚本。
  - 要做什么：扫描成功任务、Asset 视频、参考视频，补齐缺失截图；无法补的写原因，不静默跳过。
  - 完成标准：dry-run 能列出待修数量；真实执行后输出成功、失败、跳过明细。

- [ ] T8. 补测试和 smoke
  - 修改/新增对象：`scripts/*thumbnail*smoke.ts`、必要的 API smoke。
  - 要做什么：覆盖任务视频、Asset 视频、图片上传、缓存外链、批量下载未就绪过滤。
  - 完成标准：本地至少通过 `npm run lint`、`npm run build` 和新增 smoke；不需要付费生成。

- [ ] T9. 服务器上线和真实页面验证
  - 修改对象：按项目 `AGENTS.md` 的 sd2 服务器生产托管规则执行。
  - 要做什么：本地提交、rollback tag、归档上传、服务器候选构建、切换 `.next-prod`、重启 `sd2-gray.service`、公网验证。
  - 完成标准：`https://sd2.youdooart.com/assets` 登录态真实页面能看到历史视频/图片缩略图；公网 API 和静态资源确认加载新构建。

- [ ] T10. 补齐上线前运维检查
  - 修改对象：部署脚本、smoke 脚本或服务器检查命令记录。
  - 要做什么：检查生产表结构、`ffmpeg`/`ffprobe`、缩略图目录或对象存储权限、Range/HEAD、systemd 环境变量。
  - 完成标准：上线前能明确回答“库能不能迁、工具能不能抽、文件能不能读写、服务能不能回滚”。

- [ ] T11. 补齐权限、缓存、清理和监控闭环
  - 修改对象：鉴权 API、缓存策略、清理脚本、后台诊断或 OperationLog。
  - 要做什么：定义公开/私有缩略图访问边界；缩略图 URL 版本化；删除/隐藏后访问限制；记录失败指标和样本。
  - 完成标准：不会因为缩略图固化引入越权访问、旧图缓存、孤儿文件和无监控复发。

## 4. 验收/审查内容

这些审查项需要创建独立子 agent 做只读审查；审查 agent 不改文件、不提交、不补实现，只判断是否达标、证据是否充分、风险是否遗漏，并输出“通过 / 不通过、证据、缺口、风险、下一步”。

- [ ] R1. 规则统一审查
  - 检查对象：所有返回 `thumbnailUrl`、`previewUrl`、`downloadUrl`、`thumbnail_url`、`play_url` 的 API 和组件。
  - 通过标准：没有散落的冲突判断；任务视频和 Asset 视频两条链路都覆盖。
  - 证据来源：`rg` 搜索结果、关键文件 diff、相关 smoke 输出。

- [ ] R2. 新任务截图闭环审查
  - 检查对象：任务成功后的 finalizer、media ingest、thumbnail 写库逻辑。
  - 通过标准：视频成功不依赖页面打开触发截图；截图失败有状态和原因；不影响点数结算。
  - 证据来源：单测/smoke、构造任务样本、日志输出。

- [ ] R3. 历史补偿审查
  - 检查对象：历史成功任务、Asset 视频、参考视频的 dry-run 和真实修复输出。
  - 通过标准：能统计待修、成功、失败、跳过；失败原因可读；不误改无权限或已删除数据。
  - 证据来源：补偿脚本输出、数据库只读抽样、文件/URL 访问结果。

- [ ] R4. 真实页面审查
  - 检查对象：`https://sd2.youdooart.com/assets`、任务列表、生成页历史素材弹窗、模板页。
  - 通过标准：登录态刷新后能看到稳定缩略图；图片、视频、音频状态正确；没有全页空图或旧域名破图。
  - 证据来源：真实浏览器 DOM、截图、网络请求状态。

- [ ] R5. 部署证据审查
  - 检查对象：Git commit/push、rollback tag、服务器 `.next-prod/BUILD_ID`、`sd2-gray.service`、公网 `/api/config`。
  - 通过标准：远端可回档，服务器加载新构建，公网入口是 `sd2.youdooart.com`。
  - 证据来源：Git 命令、SSH 命令、公网 curl、浏览器验证。

- [ ] R6. 运维与安全闭环审查
  - 检查对象：生产表结构、FFmpeg 环境、并发限流、缩略图权限、缓存版本化、删除清理、失败监控。
  - 通过标准：不仅能显示图，还不会引入越权、CPU 打满、旧缓存、孤儿文件和无声失败。
  - 证据来源：服务器检查命令、鉴权测试、并发/补偿 dry-run、缓存重生成测试、后台失败统计。

## 5. 审查内容是否对齐目标

- [ ] A1. R1 是否对齐系统级目标
  - 判断：不能只看资产页；必须证明所有媒体展示入口都不再散写冲突规则。

- [ ] A2. R2 是否对齐根治目标
  - 判断：不能只证明 `/api/video/thumbnail/:id` 存在；必须证明截图在后台完成时固化。

- [ ] A3. R3 是否对齐历史问题
  - 判断：不能只修新任务；必须处理历史没图、坏图、过期链接。

- [ ] A4. R4 是否对齐用户体验
  - 判断：不能只靠 HTTP 200；必须看到真实页面里的缩略图。

- [ ] A5. R5 是否对齐上线闭环
  - 判断：不能把本地 build 或 Git push 当线上完成；必须有服务器和公网证据。

- [ ] A6. R6 是否对齐防复发目标
  - 判断：不能只解决“现在能看到图”；必须覆盖部署、权限、并发、缓存、清理和监控这些复发入口。
