# SD2 自动本地化生成视频策略 Todo

更新时间：2026-06-09

目标：每次视频生成任务在 Provider 侧成功后，系统自动把结果视频下载到服务器本地，写入 `public/videos/<taskId>.mp4`，数据库持久化 `local_video_path=/videos/<taskId>.mp4`，并尽量生成 `public/videos/thumbnails/<taskId>.jpg`，让任务页、列表页、后台和外部 API 都不依赖会过期的 Provider 签名 URL 做预览和截图。

## 当前现状与依据

- `src/lib/video/local-cache.ts` 的 `cacheTaskVideoToLocal` 已经具备本地保存能力：写入 `public/videos/<taskId>.mp4`，文件非空/大小校验后更新 `VideoTask.local_video_path`；遇到 403 时会尝试用 `getVideoTaskStatus` 刷新 `result_video_url`。
- `src/app/api/video/status/[id]/route.ts` 的 `GET` 在刷新 Provider 状态后，如果 `local_status=succeeded`，会调用 `cacheTaskVideoToLocal`，并同时处理 Provider 官方费用、点数结算、状态持久化。
- `src/app/api/video/download/[id]/route.ts` 的 `POST` 是手动下载入口，已复用 `cacheTaskVideoToLocal`。
- `src/app/api/video/thumbnail/[id]/route.ts` 的 `GET` 会先通过 `ensureLocalVideoForThumbnail` 尝试补齐本地视频，再用 ffmpeg 抽帧生成截图。
- `src/app/api/tasks/create/route.ts` 的 `POST` 在 `createVideoTask(providerInput)` 成功后只保存 `provider_task_id` 并返回 `submitted`，当前没有后台轮询或自动最终化任务。

结论：现有能力是“按需落盘”，不是“每次生成后自动落盘”。如果任务成功后没有人及时访问状态、下载或截图接口，Provider 签名 URL 过期后，本地视频和截图仍可能缺失。

## 成功标准

- 新生成任务不依赖用户打开详情页也能完成状态最终化：`submitted/running -> succeeded|failed|cancelled`。
- 成功任务自动落盘：`VideoTask.local_status='succeeded'` 且 `VideoTask.local_video_path='/videos/<taskId>.mp4'`。
- 本地文件真实可用：`public/videos/<taskId>.mp4` 存在、非空、可通过 `ffprobe` 读取时长和视频流。
- 截图可用：`/api/video/thumbnail/:taskId` 能返回图片；条件允许时主动生成 `public/videos/thumbnails/<taskId>.jpg`。
- 任务页、任务列表、后台输出和外部 API 返回都优先使用 `local_video_path`，Provider `result_video_url` 只作为短期来源，不作为长期预览地址。
- 结算闭环不被破坏：Provider 官方费用记录、点数扣费/退款、`completed_at` 仍只在终态时执行一次。
- 日志和文档不泄露 Provider 签名 URL、API key、cookie、token。

## 推荐策略

### 1. 抽出任务最终化服务

新增共享服务，建议路径：`src/lib/video/task-finalizer.ts`。

职责：

- 输入本地 `taskId`，读取 `VideoTask`。
- 调用 `getVideoTaskStatus(provider_task_id)` 刷新 Provider 状态。
- 统一持久化 `provider_status`、`local_status`、`raw_status_response`、`result_video_url`、`result_last_frame_url`、模型、分辨率、时长、错误信息等字段。
- 终态时统一处理 `completed_at`、Provider 官方费用记录、点数结算。
- 当终态为 `succeeded` 时调用 `cacheTaskVideoToLocal`。
- 本地视频保存成功后，可选择调用共享缩略图 helper 生成截图。

原则：不要把结算逻辑复制到后台 worker。`status` 路由、后台 runner、补偿脚本都应该调用同一个 finalizer，避免一次任务被多处重复扣费或重复结算。

### 2. 创建进程内自动轮询 runner

新增轻量 runner，建议路径：`src/lib/video/task-localization-runner.ts`。

触发点：

- 在 `src/app/api/tasks/create/route.ts` 中，Provider 创建成功并保存 `provider_task_id` 后，异步触发 runner。
- 触发不阻塞创建接口返回，创建接口仍快速返回 `submitted`。

运行策略：

- 每个 `taskId` 只允许一个 runner，使用进程内 `Map` 去重。
- 初始延迟 8-15 秒，之后每 10-20 秒调用 finalizer。
- 单任务最长轮询 15-20 分钟，超过后停止，由补偿任务接管。
- 遇到 `succeeded|failed|cancelled` 立即停止。
- 下载并发限制 2-3 个，避免多个大视频同时占满带宽或文件句柄。
- 日志只记录 `taskId`、阶段、状态、错误码，不记录完整签名 URL。

注意：Next.js/launchd 进程内 runner 是“及时落盘”的第一层保障，但进程重启、构建发布或异常退出会丢失内存状态，所以不能作为唯一保障。

### 3. 增加持久化补偿任务

增加第二层保障，建议二选一：

- 方案 A：内部接口 `/api/internal/video/finalize-pending`，由 launchd/cron 定时调用。
- 方案 B：Node 脚本 `scripts/finalize-pending-videos.ts`，由 launchd/cron 定时执行。

扫描范围：

- `local_status in ('submitted', 'running')` 且有 `provider_task_id` 的任务：继续刷新 Provider 状态。
- `local_status='succeeded'` 且 `local_video_path is null` 且有 `result_video_url` 的任务：补下载本地视频。
- 优先处理最近任务，尤其是 Provider URL 还没过期的任务。

建议频率：

- 每 2-5 分钟执行一次。
- 每轮最多处理 20-50 个任务。
- 每轮总运行时间设置上限，例如 60-120 秒。

补偿失败处理：

- 403 且刷新不到新 URL：记录“Provider 签名 URL 已过期，无法自动恢复”，不要自动重新生成付费任务。
- 网络超时：保留为下轮重试。
- 文件写入失败：记录磁盘路径、错误码、可用空间检查建议，不删除已存在的有效视频。

### 4. 截图生成策略

短期策略：

- 继续保持 `/api/video/thumbnail/:id` 的按需生成能力。
- 本地视频保存成功后，主动复用同一套 ffmpeg 抽帧逻辑生成缩略图。

推荐整理：

- 把 `thumbnail` 路由里的 `generateThumbnail`、路径校验、文件存在检查提取到 `src/lib/video/thumbnail.ts`。
- route 和 finalizer 共用 helper，避免两套 ffmpeg 参数不一致。

验收标准：

- `public/videos/thumbnails/<taskId>.jpg` 存在且非空。
- `/api/video/thumbnail/:taskId` 返回 200 和 `Content-Type: image/jpeg`。
- 如果 ffmpeg 不可用，视频落盘仍应成功，截图失败单独记录，不影响任务成功状态。

### 5. API 和前端展示规则

- `/api/video/status/:id`：返回时优先带 `local_video_path`；如果本地保存还在进行，可以附加内部状态字段，例如 `local_cache_status`，但不要泄露签名 URL。
- `/api/video/list`、任务详情页、后台输出页：预览优先使用 `local_video_path`；没有本地路径时显示“视频正在保存到本地”或“远程链接待保存”。
- `/api/video/download/:id`：继续作为手动补救入口，内部仍复用 `cacheTaskVideoToLocal`。
- 外部 API 文档：明确 `result_video_url` 是生成结果来源，不保证长期可预览；长期可用地址以 `local_video_path` 或网站返回的本地视频 URL 为准。

### 6. 数据与文件安全

- 不新增公开目录规则前，继续使用 `public/videos/<taskId>.mp4` 和 `public/videos/thumbnails/<taskId>.jpg`。
- `taskId` 必须做安全校验，只允许字母、数字、下划线、短横线。
- 下载使用临时文件，完整写入和校验后再 rename，避免半截 MP4 被页面读取。
- 不在日志、数据库额外字段、todo、文档中记录完整签名 URL。
- 后续如果视频量变大，再评估从 `public/videos` 迁到对象存储或独立 media volume；当前目标先闭环“生成后立即本地保存”。

## 执行计划

- [x] 梳理当前状态刷新、下载和截图入口，确认现状是按需落盘而非自动落盘。
- [x] 设计 `src/lib/video/task-finalizer.ts`：抽出 Provider 状态刷新、终态持久化、费用记录、点数结算、本地视频保存的统一函数。
- [x] 改造 `src/app/api/video/status/[id]/route.ts`：用 finalizer 替代内联刷新和结算逻辑，保持接口响应兼容。
- [x] 设计 `src/lib/video/task-localization-runner.ts`：提供 `startTaskLocalization(taskId)`，支持去重、轮询、超时、并发限制和脱敏日志。
- [x] 改造 `src/app/api/tasks/create/route.ts`：Provider 接受任务后异步启动 runner，不阻塞创建响应。
- [x] 增加补偿机制：实现内部定时接口或脚本，扫描 pending/running/succeeded-but-local-missing 任务并调用 finalizer。
- [x] 抽出 `src/lib/video/thumbnail.ts`：让 thumbnail route 和自动 finalizer 共用截图生成逻辑。
- [x] 更新列表、任务页、后台输出页的数据使用规则：已核对现有接口和页面会返回/优先使用 `local_video_path`，本轮未额外扩大修改。
- [x] 为历史成功但缺本地文件的任务写一次性 backfill 流程，只尝试恢复，不自动重新付费生成。
- [x] 补充外部 API 说明：生成成功后外部应轮询到终态，并优先使用网站本地视频地址；Provider 签名 URL 只作短期来源。
- [x] 验证构建和关键链路。
- [ ] 部署后跑一条真实或授权测试任务，确认无人打开详情页时也会自动落盘和生成截图。

## Git Plan

- 修改前检查 `git status`，确认现有用户改动，不混入无关文件。
- 建议在独立分支完成，例如 `codex/auto-localize-generated-videos`。
- 提交分组建议：
  - 提交 1：finalizer 抽取和 status route 复用。
  - 提交 2：runner 和 create route 触发。
  - 提交 3：补偿脚本/内部接口和 thumbnail helper。
  - 提交 4：前端/外部文档状态展示与验证记录。
- 若本地已有大量未提交改动，优先使用干净 worktree 或只提交本任务相关文件。

## 验证清单

- 构建验证：

```bash
npm run build
```

- 数据库验证：

```bash
sqlite3 prisma/dev.db "select id,source_type,local_status,result_video_url is not null as has_result,local_video_path from VideoTask order by created_at desc limit 20;"
```

- 本地视频文件验证：

```bash
test -f "public/videos/<taskId>.mp4" && ls -lh "public/videos/<taskId>.mp4"
ffprobe -v error -show_entries format=duration -show_streams "public/videos/<taskId>.mp4"
```

- 截图验证：

```bash
test -f "public/videos/thumbnails/<taskId>.jpg" && file "public/videos/thumbnails/<taskId>.jpg"
curl -I "https://sd2.youdoodesign.com/api/video/thumbnail/<taskId>"
```

- 公网视频验证：

```bash
curl -I "https://sd2.youdoodesign.com/videos/<taskId>.mp4"
```

- 行为验证：

```text
1. 创建任务后不打开任务详情页。
2. 等待 runner 或补偿任务自动刷新到 succeeded。
3. 检查 DB 已写入 local_video_path。
4. 检查 public/videos/<taskId>.mp4 存在且 ffprobe 可读。
5. 检查 thumbnail 可访问。
6. 打开任务页、列表页、后台输出页，确认预览使用本地视频。
```

## 停止条件

- 没有用户明确授权，不跑会消耗点数的真实生成任务。
- 如果发现结算逻辑无法安全抽出，先停下重新规划，不复制粘贴结算代码。
- 如果需要 Prisma schema 迁移，先单独评估迁移风险和现有数据兼容性。
- 如果 Provider 签名 URL 已过期且刷新不到新 URL，只记录不可恢复，不自动重新生成。
- 如果磁盘空间不足或 `public/videos` 不适合作为长期存储，先给出存储迁移方案再继续。

## 待确认问题

- 自动本地化是否覆盖所有生成来源，还是只覆盖 `source_type='codex_api'` 的外部 API 任务？推荐覆盖所有视频任务。
- 补偿任务采用内部接口还是独立脚本？推荐独立脚本加 launchd，更不依赖 HTTP 会话。
- 截图是只生成首帧缩略图，还是额外生成 contact sheet？推荐先首帧缩略图，contact sheet 留给验收工具。
- 视频本地保留多久？当前先永久保留，后续再设计 retention/清理策略。

## Review - 2026-06-09

- 已实现统一 finalizer：状态刷新、终态持久化、点数结算、Provider 官方扣费、本地视频保存和缩略图生成集中到 `src/lib/video/task-finalizer.ts`。
- 已实现创建后自动 runner：`src/app/api/tasks/create/route.ts` 在 Provider 接受任务后调用 `startTaskLocalization(taskId)`，不阻塞创建响应。
- 已实现补偿脚本：`scripts/finalize-pending-videos.ts` 可扫描 `submitted/running` 和 `succeeded` 但缺少 `local_video_path` 的任务；支持 `--dry-run`、`--limit`、`--max-seconds`。
- 已抽出截图 helper：`src/lib/video/thumbnail.ts` 供自动 finalizer 和 `/api/video/thumbnail/:id` 共用；截图失败不会影响视频任务成功状态。
- 已补 Provider 响应日志脱敏：`src/lib/provider/jimeng.ts` 不再直接打印完整签名 URL。
- 已验证：`npx tsc --noEmit --pretty false` 通过；`npx tsx scripts/finalize-pending-videos.ts --dry-run --limit 3 --max-seconds 10` 通过；`npm run build` 通过，仅有既有 `<img>` 和 React hook lint warning。
- 未执行：未跑真实付费生成任务，未部署生产，未配置 launchd/cron 定时执行补偿脚本。

---

# 任务详情页功能与交互重构 Todo

更新时间：2026-06-09

目标页面：`/tasks/[id]`，当前代表页面为 `https://sd2.youdoodesign.com/tasks/cmq1qrmem0028ycido2agm4nv`。

## 当前代码依据

- 页面主入口：`src/app/tasks/[id]/page.tsx` 的 `TaskDetailPage`。
- 结果区与操作：`TaskDetailPage` 内 `resultStateTitle`、`resultDecisionBody`、`handleDownloadToLocal`、`handleOpenVideo`、`handleCopyUrl`、`queryStatus`、`handleRetry`。
- 输入摘要与素材：`TaskDetailPage` 内 `parameterItems`、`advancedParameterItems`、`referenceImages`、`referenceAssets`。
- 排障与账务：`TaskDetailPage` 内 `extractProviderBilling`、`extractEmbeddedOfficialCharges`、`fetchOfficialCharges`、`handleMoveProject`、`ReferenceImageDebug`。
- 状态和样式：`getStatusText`、`getStatusClass`、`getRetentionText`、`costStatusLabel`，以及 `src/app/globals.css` 的 `task-result-*`、`task-detail-*`、`task-ops-*` 相关样式。

## 第一性原理

这个页面不是“任务详情档案页”，而是“生成结果决策页”。用户进来最想完成三件事：

1. 看结果是否成功、能不能播放。
2. 知道这次实际花了多少钱和多少点数。
3. 立刻执行下一步：保存、打开、复制链接、复用输入继续调整，或失败后重试。

运维、账务、项目归属、原始响应都必须保留，但它们不应抢第一屏主任务。

有没有更优雅的方式：把页面重构成“主舞台 + 决策侧栏 + 折叠审计区”，而不是继续向当前单页里堆卡片。这样既保留所有功能，又让普通用户只看最需要的内容，管理员按需展开高级功能。

## 页面核心任务

- 核心任务：围绕一个生成任务做结果确认和下一步处理。
- 3 秒内应看见：
  - 任务当前状态。
  - 视频结果或明确的空状态。
  - 实际扣费金额。
  - 最推荐的下一步按钮。
- 最高频动作：
  - 成功：保存视频、本地打开、复制本地链接、复用输入。
  - 生成中：刷新状态、开启自动刷新。
  - 失败：查看失败原因、复用输入、重新生成。

## 信息层级

### 一级信息，首屏必须可见

- 状态：生成中、已完成、失败、取消。
- 视频预览或空状态。
- 实际扣费：USD 金额，必要时同时展示点数。
- 本地保存状态：本地已保存、远程链接待保存、没有视频链接。
- 主操作按钮。

### 二级信息，首屏可见但弱化

- 输入摘要：模式、比例、时长、分辨率、参考图数量。
- 项目归属名称。
- 完成时间。
- Provider 状态简写。

### 三级信息，默认折叠或移到侧栏

- 完整提示词。
- 完整参数。
- 参考图片、首尾帧、参考视频、参考音频。
- official_charge 账本。
- Provider 返回扣费。
- billing_status、billing_time、usage tokens。
- Provider ID、clientRequestId。

### 四级信息，只给管理员或排障场景

- 项目归属调整。
- 参考图调试信息。
- raw_create_response。
- raw_status_response。

## 功能保留清单

必须保留，不允许在 UI 重构中删除：

- 返回任务列表。
- 新建任务。
- 状态 badge。
- retention 状态提示。
- 刷新结果。
- 自动轮询。
- 失败后重新生成。
- 视频预览。
- 视频预览失败提示。
- 保存视频到本地。
- 打开本地视频。
- 保存并复制或复制本地链接。
- 下载状态、进度、错误和重试保存。
- 复用输入。
- 失败原因。
- 输入摘要。
- 完整提示词。
- 完整参数。
- 参考图片、首尾帧、多帧图片、参考视频、参考音频。
- Workspace 参考图资产展示。
- 运维信息摘要。
- 官方成本状态。
- 官方真实成本。
- Provider 返回扣费。
- official_charge 账本记录。
- 项目归属调整和原因。
- 技术调试与原始响应。

## 推荐页面结构

### 顶部导航

保留弱导航，不抢主任务：

- 左侧：返回任务。
- 中间：任务短 ID、创建时间、状态。
- 右侧：新任务。
- 不在顶部放太多操作，避免和结果区主按钮竞争。

### 主舞台：生成结果

第一屏最大区域，承载视频和结果决策。

显示内容：

- 标题按状态变化：
  - 成功：生成结果。
  - 生成中：正在生成。
  - 失败：生成失败。
  - 无结果：暂无结果。
- 副文案只回答“现在该做什么”，不重复标题。
- 视频区域保持稳定比例，避免空状态、错误提示、视频加载时跳动。
- 视频右上角显示实际扣费，但不能遮挡播放器控制条。
- 视频下方显示本地保存状态。

主按钮规则：

- 成功且未本地保存：主按钮为“保存视频”。
- 成功且已本地保存：主按钮为“打开视频”。
- 生成中：主按钮为“刷新结果”。
- 失败：主按钮为“复用输入”。
- 无结果但有 provider task：主按钮为“刷新结果”。

次级按钮：

- 复制本地链接。
- 复用输入。
- 重新生成，只有失败时出现。
- 重试保存，只有保存失败时出现。

### 决策侧栏：本次任务概要

桌面端放右侧，移动端放在结果区下方。

必须包含：

- 实际扣费：USD。
- 点数扣除或冻结状态。
- 本地保存状态。
- 项目归属。
- 模式、比例、时长、分辨率。
- 完成时间。

交互规则：

- 侧栏只放决策需要的信息，不放原始 JSON。
- 每一项都用短标签和可复制值。
- Provider ID、clientRequestId 默认隐藏到“技术信息”。

### 输入复盘区

目标：让用户判断是否要复用输入继续调整。

默认展示：

- 提示词前 3 到 5 行。
- 输入参数 chips。
- 参考图缩略图前 4 张。

默认折叠：

- 完整提示词。
- 全部参数。
- 全量参考素材。
- Provider payload 的 resolved mode。

按钮：

- 复用输入。
- 复制提示词，可作为次级或 overflow。

### 参考素材区

合并当前重复展示的“参考素材”和“参考图资产”：

- 一个统一模块展示所有输入素材。
- 按类型分组：参考图、首尾帧、多帧图片、参考视频、参考音频。
- Workspace 资产显示资产名和 providerAssetId，但默认只展示资产名，ID 在 hover 或详情中显示。
- 超过 6 个素材默认折叠，提供“查看全部”。

### 排障与账务区

默认折叠，标题建议为“账务与排障”，不要让普通用户误以为必须处理。

首层可见：

- 官方成本状态。
- 官方真实成本。
- Provider 返回扣费。
- official_charge 是否存在。

二层折叠：

- official_charge 账本行。
- billing_status。
- billing_time。
- usage tokens。
- provider_task_id。
- clientRequestId。

管理员功能：

- 项目归属调整放在独立子面板。
- 必须展示当前项目、目标项目、原因、结果反馈。
- 如果目标项目等于当前项目，按钮禁用并说明原因。

技术调试：

- 单独折叠为“技术调试”。
- raw_create_response、raw_status_response、参考图解析信息默认关闭。
- JSON 区域必须支持复制和横向滚动，避免撑破页面。

## 状态设计

### Loading

- 不显示孤立的“加载中...”卡片。
- 使用骨架：
  - 顶部状态骨架。
  - 视频舞台骨架。
  - 侧栏摘要骨架。

### Succeeded

- 视频是主视觉。
- 主按钮根据本地保存状态变化。
- 实际扣费常驻展示。
- 如果未保存到本地，给出弱提示：远程链接可能过期，建议保存。

### Submitted / Running

- 主舞台显示进度感，不要只给空框。
- 主按钮为刷新结果。
- 自动轮询作为开关放在刷新旁。
- 如果轮询开启，显示下一次刷新倒计时或最近刷新时间。

### Failed

- 主舞台直接展示失败原因摘要。
- 主按钮为复用输入。
- 次按钮为重新生成。
- 排障信息折叠保留。

### Video Preview Failed

- 不只显示“视频预览失败”。
- 明确给出操作顺序：
  - 保存到本地。
  - 打开视频。
  - 复制本地链接。
  - 仍失败则刷新状态或复用输入。

### Local Save Failed

- 保存失败要显示错误原因、重试按钮、是否可能 Provider 链接过期。
- 如果已无远程链接，隐藏“保存视频”，主操作变为“刷新结果”或“复用输入”。

### No Permission / Not Found

- 保留返回列表。
- 不暴露敏感任务信息。
- 如果是留存状态导致不可见，给出普通用户可理解的提示。

## 交互细节

### 按钮层级

- 每个状态只允许一个最强主按钮。
- 保存、打开、刷新、复用、重新生成不能同一视觉权重。
- 危险或付费相关动作要有确认或明确提示。

### 复制行为

- 复制本地链接前，如果本地未保存，允许自动保存。
- 自动保存过程必须有进度和可取消或可重试反馈。
- 复制成功状态保留 2 秒。

### 保存行为

- 保存视频按钮应解释保存到哪里：本地长期链接。
- 已保存后按钮变为只读状态，主按钮切换为打开视频。
- 进度条只在真实保存中出现；完成后可折叠为状态行。

### 复用输入

- 复用输入在成功和失败状态都重要，但失败时应升为主操作。
- 复用前不需要确认，因为不消耗点数，只进入生成页。
- 复用入口旁边显示会带走哪些内容：提示词、比例、时长、参考素材。

### 项目归属调整

- 默认折叠。
- 管理员或可管理项目用户才显示。
- 修改前显示影响：成本归属将追加转移记录，不覆盖旧账。
- 原因必填。

## 移动端规划

- 顶部动作合并为一行：返回、状态、新任务。
- 视频舞台占满宽度。
- 决策侧栏下移为“任务摘要”折叠区，但实际扣费仍在视频下方常驻。
- 主按钮固定在结果区下，不做全局 sticky，避免遮挡视频 controls。
- 素材网格每行 2 到 3 个。
- JSON 和长 URL 必须横向滚动，不允许撑出视口。

## 视觉方向

产品型工具界面，走克制信息工作台，不做营销页面。

- 背景保持浅灰工作区。
- 结果舞台使用白色或轻蓝 tint，强调当前任务。
- 状态色只服务状态，不做装饰。
- 实际扣费使用中性高对比胶囊，不使用夸张红色，避免误读为错误。
- 操作按钮统一尺寸和图标规则。
- 不使用嵌套卡片。主舞台、侧栏、折叠区是并列区域。

## 实施计划

### P0：信息架构和首屏

- [ ] 把页面改为“主舞台 + 决策侧栏 + 下方详情”的结构。
- [ ] 定义 `TaskPrimaryAction`，按任务状态只输出一个主按钮。
- [ ] 把实际扣费、点数状态、本地保存状态放入首屏摘要。
- [ ] 把视频空状态、生成中状态、失败状态统一成稳定的结果舞台。
- [ ] 把视频预览失败提示改为操作步骤提示。
- [ ] 保留当前所有功能入口，不删除任何操作。

### P1：输入复盘和素材整理

- [ ] 合并“输入摘要”和“参考图资产”重复区域。
- [ ] 默认展示短提示词和关键参数，完整内容放到展开区。
- [ ] 参考素材按类型分组，超过 6 个折叠。
- [ ] 为提示词增加复制按钮。
- [ ] 复用输入旁展示将复用的内容范围。

### P1：账务与排障下沉

- [ ] 将“排障与账务”改为默认折叠的高级区。
- [ ] 首层只展示官方成本状态、官方真实成本、Provider 返回扣费、账本是否存在。
- [ ] official_charge 账本行放入二层折叠。
- [ ] Provider ID、clientRequestId、usage tokens 放入技术信息。
- [ ] raw_create_response、raw_status_response 支持复制和横向滚动。

### P1：项目归属调整

- [ ] 项目归属调整从账务信息中独立成“管理操作”子区。
- [ ] 展示当前项目、目标项目、原因和影响说明。
- [ ] 原因为空时禁用按钮并提示。
- [ ] 移动成功后刷新项目归属和成本归属状态。

### P2：状态反馈和细节 polish

- [ ] Loading 改为骨架屏。
- [ ] 自动轮询显示最近刷新时间或倒计时。
- [ ] 保存进度完成后折叠成状态行。
- [ ] 移动端检查视频 controls、扣费角标、主按钮不重叠。
- [ ] 所有按钮补齐 hover、focus、disabled、loading 状态。

## 建议拆分组件

- `TaskDetailPageShell`
- `TaskResultStage`
- `TaskDecisionPanel`
- `TaskPrimaryActions`
- `TaskInputReview`
- `TaskReferenceAssets`
- `TaskBillingSummary`
- `TaskProjectMovePanel`
- `TaskTechnicalDebugPanel`
- `TaskStateMessage`

## 验收清单

- [ ] 用户 3 秒内能判断任务状态、是否有视频、实际扣费、下一步点击什么。
- [ ] 成功、生成中、失败、无结果、预览失败、保存失败都有明确状态文案和操作路径。
- [ ] 每个状态只有一个最强主按钮。
- [ ] 保存、打开、复制、复用、刷新、重试、重新生成都仍可达。
- [ ] 输入参数和参考素材仍完整可查。
- [ ] official_charge 和 Provider 账务信息仍完整可查。
- [ ] 项目归属调整仍可用，并保留原因和日志语义。
- [ ] raw response 和参考图调试仍可用，但默认不干扰普通用户。
- [ ] 桌面和移动端无文字溢出、按钮重叠、视频控件遮挡。
- [ ] `npx impeccable detect 'src/app/tasks/[id]/page.tsx'` 通过。
- [ ] `npm run lint` 和 `npx tsc --noEmit` 通过。

## 停止条件

- 如果发现某个现有功能入口无法在新结构中保留，先停止并重新规划，不直接删除。
- 如果项目归属调整涉及权限规则变化，先读 API 约束再改 UI。
- 如果扣费字段含义不确定，不新增换算规则，只展示后端已确认字段。
- 如果需要新接口支持任务摘要，先做兼容方案，不破坏现有 `/api/video/status/[id]` 响应。

---

# 用户与点数管理后台重构 Todo

更新时间：2026-06-10

目标页面：`/admin/users`。当前 `/admin/points` 只做管理员鉴权后重定向到 `/admin/users`，所以“用户管理”和“点数管理”实际集中在同一个页面。

## 当前代码依据

- 页面入口：`src/app/admin/users/page.tsx` 的 `AdminUsersPage`，只允许管理员访问。
- 点数入口：`src/app/admin/points/page.tsx` 的 `AdminPointsPage`，管理员访问后直接 `redirect('/admin/users')`。
- 前端主组件：`src/app/admin/users/AdminUsersClient.tsx` 的 `AdminUsersClient`。
- 用户列表与创建：`src/app/api/admin/users/route.ts` 的 `GET`、`POST`。
- 用户详情、编辑、软删除：`src/app/api/admin/users/[id]/route.ts` 的 `GET`、`PATCH`、`DELETE`。
- 启用/禁用：`src/app/api/admin/users/[id]/enable/route.ts`、`src/app/api/admin/users/[id]/disable/route.ts`。
- 批量用户类型：`src/app/api/admin/users/bulk-profile/route.ts`。
- 账号合并：`src/app/api/admin/users/merge/route.ts`。
- 单人点数操作：`src/app/api/admin/credits/adjust/route.ts`。
- 批量发放点数：`src/app/api/admin/credits/bulk-grant/route.ts`。
- 点数流水：`src/app/api/admin/credits/ledger/route.ts`。
- 点数策略：`src/app/api/admin/credits/policy/route.ts`、`src/lib/credits/policy.ts`。
- 用户类型和能力档案：`src/lib/users/profiles.ts`。

## 当前功能盘点

### 1. 访问与路由

- `/admin/users`：管理员后台页面，非登录用户跳转 `/login`，非管理员跳转 `/generate`。
- `/admin/points`：没有独立界面，只重定向到 `/admin/users`。
- 页面标题是“用户与点数管理”，当前同时承担账号、权限、点数、策略、合并、流水等多个工作流。

### 2. 用户列表

- 加载所有非 `deleted` 用户。
- 展示姓名、账号、邮箱、账号来源、系统身份、飞书绑定状态、用户类型、能力档案、点数、状态、最近登录。
- 点数展示包含长期余额、长期冻结、每日额度剩余、每日额度冻结、总可用点数。
- 支持搜索姓名 / 账号 / 邮箱。
- 支持筛选账号来源、用户类型、能力档案、状态。
- 前端分页，每页 20 人。
- 支持勾选单个用户、全选当前筛选结果、清空选择。
- 支持“只选”某个用户，并自动把单人点数操作指向该用户。

### 3. 单个用户操作

- 编辑账户属性：姓名、账号、邮箱、账号来源、管理员/普通用户、用户类型、能力档案、状态、过期时间。
- 编辑必须填写原因。
- 编辑前会对敏感变化做确认，包括系统身份、状态、账号来源。
- 外部账号只能作为普通用户，能力档案强制为 `external_limited`。
- 管理员必须是内部账号；飞书绑定账号设为管理员时后端会按内部账号兜底。
- 不能让当前登录管理员失去后台访问权限。
- 不能移除最后一个可用管理员。
- 启用账号要求账号未删除、未过期。
- 禁用账号不能禁用当前登录账号，也不能禁用最后一个可用管理员。
- 删除是软删除：状态改为 `deleted`，历史任务和点数流水保留。
- 不能删除当前登录管理员，也不能删除最后一个可用管理员。

### 4. 创建用户

- 创建字段：姓名、账号、邮箱、初始密码、角色、账号来源、用户类型、能力档案、初始点数、原因。
- 用户名或邮箱不能重复。
- 管理员必须是内部账号。
- 外部账号强制普通用户、`other` 用户类型和 `external_limited` 能力档案。
- 可一键套用当前点数策略建议的初始点数。
- 创建后会自动创建 `CreditAccount`。
- 创建后会按策略或输入点数发放初始点数。
- 创建后会自动创建个人默认项目，并把用户加入为 `project_owner`。
- 创建、初始点数、默认项目都会写操作日志。

### 5. 点数策略

- 管理新用户初始点数。
- 初始点数区分内部新用户、外部新用户。
- 可控制是否应用到自注册、飞书首次登录自动创建、管理员创建用户。
- 管理每日固定额度。
- 每日额度区分内部默认、外部默认、各用户类型 override。
- 每日额度有效期限制为 1-168 小时。
- 每日额度按上海时间懒发放。
- 任务消费优先使用每日额度，再使用长期余额。
- 过期未使用每日额度可清零；已冻结额度等待任务结算后关闭或返还。

### 6. 单人点数操作

- 支持发放、扣减、修正为指定长期余额。
- 必须选择用户、输入点数、填写原因。
- 发放和扣减金额必须大于 0；修正允许为 0。
- 扣减只扣长期可用余额，不扣每日额度。
- 扣减不能超过长期可用余额。
- 修正后的长期余额不能低于已冻结点数。
- 操作需要浏览器二次确认。
- 操作会更新 `CreditAccount`，写 `CreditLedger`，写 `operationLog`。

### 7. 批量点数发放

- 对已选用户每人发放同样点数。
- 单次最多 200 个用户。
- 必须填写发放原因。
- 操作前会提示前三个用户名、总人数和总点数。
- 禁用用户也可入账，但启用前不能登录使用。
- 每个用户都会写 `admin_grant` 流水和操作日志。
- 批次本身也会写一条批量操作日志。

### 8. 批量修改用户类型

- 对已选用户批量修改用户类型和能力档案。
- 单次最多 200 个用户。
- 支持自动建议能力档案。
- 外部账号会强制使用 `other` 用户类型和 `external_limited` 档案。
- 必须填写修改原因。
- 每个用户写单条操作日志，并额外写批次日志。

### 9. 重复账号合并

- 先勾选源账号，再选择最终保留账号。
- 保留账号必须是启用状态。
- 源账号至少 1 个，单次最多 20 个。
- 管理员账号不能作为源账号，只能作为保留账号。
- 源账号会软删除并无法登录。
- 合并会转移或合并长期余额、冻结点数、月使用量、总使用量。
- 合并会写 `account_merge_in` 和 `account_merge_out` 点数流水。
- 合并会迁移视频任务、任务 owner、项目 owner、画布、参考图集、参考图、Provider 请求、成本账本、成本分摊、反馈、工作区、资产和资产集合。
- 合并会处理项目成员：保留更高角色、更活跃状态、更早加入记录。
- 合并会处理图集分享权限：合并权限 JSON，保留 active 状态。
- 合并会挑选并迁移最佳飞书身份，清空源账号飞书身份。
- 合并会写详细操作日志，包含迁移计数、点数转移和飞书身份转移。

### 10. 点数流水

- 展示最近点数流水，默认每页 50 条。
- 字段包含时间、用户、类型、变动、余额变化、冻结变化、原因。
- 后端支持按 `user_id` 和 `type` 过滤，但当前页面没有暴露这两个筛选入口。
- 流水按创建时间倒序展示。

## 当前易用性问题

- 一个页面同时展示用户列表、点数策略、账户编辑、批量类型、账号合并、批量发放、创建用户、单人点数操作和点数流水，第一屏焦点过多。
- `/admin/points` 是重定向，导航名称和页面实际结构不一致，用户会以为有独立点数页面但看不到。
- 所有高风险操作都平铺在右侧，创建、合并、批量发放、策略保存的视觉权重接近，容易误操作。
- 用户列表是主工作区，但右侧表单过多，普通查询、管理员操作和危险操作没有分层。
- 选择用户后的下一步不明确：勾选用户既可批量发放、批量修改、合并，也可单人点数操作。
- 点数策略是低频配置，却放在右侧最上方，压过高频的用户查看和单人处理。
- 点数流水和当前选中用户没有联动，排查某个用户点数问题需要手动找。
- 单人点数操作没有展示操作后的余额预览，只依赖 confirm 文案。
- 账号合并已经有强后端能力，但前端只是单个表单，缺少分步骤影响预览和迁移范围确认。
- 用户编辑、创建用户和策略配置使用大量 inline style，后续重构难以保持一致性。
- 表格列偏多，行内按钮过多；删除、禁用这类危险操作和普通编辑并列显示。

## 重构原则

- 不删除原功能。只能做入口归位、显隐分层、流程拆分和信息架构优化。
- 页面定位从“功能堆叠后台”改为“用户运营工作台”。
- 主任务是定位用户、理解账户/点数状态、执行最合适的下一步。
- 高频查看和单人处理优先；低频策略、批量、合并、危险操作下沉。
- 每个状态只给一个最强主按钮，其余动作进入次级按钮或更多菜单。
- 所有会改变权限、登录状态、点数、账号归属的操作必须保留原因、预览、二次确认和日志语义。

## 推荐页面结构

### 顶部：范围和关键状态

- 标题：用户与点数工作台。
- 保留当前管理员身份提示。
- 增加全局搜索框。
- 增加快速视图：
  - 全部用户
  - 可登录用户
  - 管理员
  - 飞书绑定
  - 点数异常
  - 今日额度不足
  - 待开通 / 已禁用 / 已过期
- 增加轻量统计：
  - 总用户数
  - 可登录用户数
  - 管理员数
  - 总长期余额
  - 总冻结点数
  - 今日额度剩余

### 主区：用户表格

- 第一屏只保留用户表格和右侧用户详情/动作面板。
- 表格建议列：
  - 用户：姓名、账号、邮箱、飞书标识。
  - 权限：管理员/普通、内部/外部、状态。
  - 类型：用户类型、能力档案。
  - 点数：长期可用、冻结、今日剩余。
  - 活跃：最近登录、创建时间。
  - 风险：过期、禁用、点数不足、无飞书绑定。
  - 操作：更多菜单。
- 行点击选中用户；行内只保留一个“详情/处理”入口。
- 禁用、删除、合并这类危险动作移入更多菜单或详情面板危险区。

### 右侧：选中用户决策面板

- 未选中时展示筛选结果摘要和常用入口。
- 选中用户后展示：
  - 账户状态：是否可登录、是否管理员、是否飞书绑定、是否过期。
  - 点数钱包：长期余额、长期冻结、今日额度、今日冻结、总可用。
  - 推荐动作：例如发放点数、启用账号、编辑属性、查看流水。
  - 最近 5 条点数流水。
  - 最近任务/消费摘要，后续可接入。
- 主按钮随状态变化：
  - active 普通用户：发放点数。
  - disabled/pending/expired：处理登录状态。
  - 管理员：编辑管理员身份。
  - 点数异常：查看流水。

### 批量操作条

- 只有勾选用户后才出现。
- 展示已选人数、管理员数量、外部账号数量、总可用点数、总冻结点数。
- 主要批量动作：
  - 批量发放点数。
  - 批量修改用户类型。
  - 发起账号合并。
- 危险或复杂批量动作进入分步弹窗，不在右侧常驻。

### 点数操作

- 单人点数操作从常驻表单改为“钱包抽屉”。
- 操作模式：发放、扣减、修正为。
- 展示当前长期余额、冻结、可扣余额、操作后余额。
- 扣减时实时提示最大可扣值。
- 修正时实时校验不能低于冻结点数。
- 必须填写原因。
- 确认弹窗展示 before / delta / after。

### 创建用户

- 从常驻表单改为“创建用户”抽屉或分步弹窗。
- 步骤建议：
  1. 身份信息：姓名、账号、邮箱、初始密码。
  2. 权限与类型：普通/管理员、内部/外部、用户类型、能力档案。
  3. 点数与项目：初始点数、每日额度预览、默认项目说明。
  4. 确认：展示将创建的账号、点数、项目和原因。
- 创建管理员时明确提示“管理员必须是内部账号”。
- 外部账号时隐藏无效选项，只说明会使用外部受限档案。

### 账号合并

- 从常驻表单改为独立向导。
- 步骤建议：
  1. 选择保留账号：只能选 active 账号。
  2. 选择源账号：排除管理员源账号，最多 20 个。
  3. 影响预览：点数转移、冻结转移、任务、项目、图集、成本、反馈、资产、飞书身份。
  4. 最终确认：输入原因并二次确认。
- 如果已选源账号包含管理员，直接阻断并解释“管理员只能作为保留账号”。
- 合并完成后展示迁移计数摘要。

### 点数策略

- 从主屏右侧常驻区移动到“策略”标签页或设置抽屉。
- 分成两个配置块：
  - 新用户初始点数。
  - 每日固定额度。
- 保存前展示变更 diff。
- 保存后提示影响范围：自注册、飞书自动创建、管理员创建、每日额度。
- 增加策略试算器：选择角色、账号来源、用户类型后预览初始点数和每日额度。

### 点数流水

- 从页面底部长表格升级为“流水”标签页或选中用户面板内嵌。
- 全局流水表增加筛选：
  - 用户
  - 类型
  - 时间范围
  - 操作人
  - 正向 / 负向 / 修正 / 冻结相关
- 选中用户时默认展示该用户流水。
- 流水行支持展开 metadata 和操作日志关联。

## 实施计划

### P0：信息架构和功能保全

- [x] 盘点 `/admin/users` 和 `/admin/points` 的当前功能与 API 约束。
- [x] 确认 `/admin/points` 是否保留重定向，还是改为点数管理标签直达链接。
- [x] 建立重构后的一级结构：顶部状态区、用户主表、右侧详情面板、批量操作条、低频配置区。
- [x] 列出所有现有功能入口在新结构中的位置，确保没有功能被删除。
- [x] 定义危险操作分层：禁用、删除、合并、管理员身份变更、点数扣减、点数修正。

### P1：用户表格和选中用户面板

- [x] 重构用户表格列，控制在 6-7 个扫描关键列。
- [x] 行点击选中用户，右侧展示账户、飞书、点数、额度、最近流水。
- [ ] 行内只保留详情入口和更多菜单，删除/禁用下沉。
- [x] 快速筛选改为视图 chip，保留高级筛选。
- [x] 用户分页保持每页 20，后续如数据量增加再改服务端筛选分页。

### P1：单人编辑和点数操作

- [ ] 把账户属性编辑改为抽屉，保留所有字段和影响预览。
- [ ] 账户属性保存前展示变更 diff 和原因。
- [ ] 把单人点数操作改为钱包抽屉，实时展示 before / delta / after。
- [ ] 扣减和修正操作保留后端约束提示。
- [ ] 保存成功后局部刷新用户和该用户流水。

### P1：批量操作

- [x] 勾选用户后显示批量操作条。
- [ ] 批量发放点数改为弹窗，展示人数、总点数、禁用用户提示。
- [ ] 批量修改用户类型改为弹窗，展示外部账号强制档案规则。
- [ ] 批量操作确认页保留原因和二次确认。
- [x] 批量完成后清空选择并刷新列表。

### P1：账号合并向导

- [ ] 把合并重复账号改为 4 步向导。
- [x] 保留账号只允许 active 用户。
- [x] 源账号阻止管理员，单次最多 20 个。
- [x] 影响预览展示点数、冻结、任务、项目、图集、成本、资产、飞书身份迁移范围。
- [x] 完成后展示后端返回的迁移计数。

### P2：策略和流水

- [x] 点数策略移到策略标签页或设置抽屉。
- [ ] 保存策略前展示变更 diff。
- [ ] 增加策略试算器，帮助管理员理解初始点数和每日额度。
- [ ] 点数流水增加用户、类型、时间范围、操作人筛选。
- [x] 选中用户后流水默认按该用户过滤。
- [ ] 流水行支持展开原因、metadata 和关联操作日志。

### P2：视觉与交互 polish

- [x] 移除 `AdminUsersClient` 中大面积 inline style，沉淀为 CSS class 或组件。
- [x] 页面使用安静的后台工作台风格，避免所有模块同等强度。
- [x] 主按钮、次按钮、危险按钮、文本按钮统一层级。
- [x] 表格、抽屉、弹窗、确认页补齐 loading、empty、error、disabled、focus 状态。
- [x] 移动端至少保证用户表可横向滚动，详情面板改为底部抽屉。

## 验收清单

- [ ] 管理员 3 秒内能看懂：当前筛选用户、选中用户状态、点数状态、下一步建议。
- [ ] `/admin/users` 当前所有功能在新结构里都有入口。
- [ ] `/admin/points` 的导航语义明确，不再让用户误以为页面丢失。
- [ ] 创建用户、编辑账户、启用、禁用、软删除、批量类型、批量发放、单人点数、账号合并、点数策略、点数流水全部可达。
- [ ] 管理员保护规则不被破坏：不能失去当前管理员权限、不能删除/禁用最后一个可用管理员。
- [ ] 外部账号规则不被破坏：外部账号只能普通用户，能力档案强制外部受限。
- [ ] 点数约束不被破坏：扣减只扣长期可用余额，修正不能低于冻结点数。
- [ ] 合并约束不被破坏：保留账号 active，源账号非管理员，源账号最多 20 个。
- [ ] 批量约束不被破坏：批量发放和批量类型单次最多 200 人。
- [ ] 所有高风险操作仍有原因、预览和二次确认。
- [ ] `npm run lint` 和 `npx tsc --noEmit --pretty false` 通过。

## 停止条件

- 如果新结构无法保留某个现有功能入口，先停止并重新规划，不直接删除。
- 如果需要改变点数、登录、管理员权限、账号合并后端规则，先单独评估并得到确认。
- 如果发现 `/admin/users` 当前线上行为和源码不一致，先用浏览器和接口确认真实状态，再继续设计。
- 如果需要新增数据库字段或 Prisma 迁移，先拆成独立任务。

## Review - 2026-06-10

- 已落地首屏信息架构：`src/app/admin/users/AdminUsersClient.tsx` 改为顶部统计、快速视图、用户主表、右侧用户决策面板、批量操作条和工具面板。
- 已保留原有业务功能入口：创建用户、编辑账户、启用、禁用、软删除、单人点数、批量发放、批量类型、账号合并、点数策略和全局点数流水仍在同页可达。
- 已把低频功能从首屏常驻区下沉到工具切换区：策略、创建、批量、合并、单人点数不再和用户列表同等抢焦点。
- 已加入选中用户决策面板：展示可登录状态、系统身份、总可用、总冻结、长期余额、今日额度、风险标签和最近 5 条点数流水。
- 已加入快速视图：全部用户、可登录、管理员、飞书绑定、点数异常、今日额度不足、待处理状态。
- 已加入批量操作条：勾选用户后展示人数、管理员数、外部账号数、总可用和总冻结，并提供批量发放、批量类型和账号合并入口。
- 已补样式：`src/app/globals.css` 新增后台工作台、表格、决策面板、工具面板、移动端响应式样式。
- 已验证：`npx tsc --noEmit --pretty false` 通过；`npm run lint` 通过但仍有既有 warning；`npx impeccable detect 'src/app/admin/users/AdminUsersClient.tsx'` 通过。
- 未完成：批量发放/批量类型还不是独立弹窗；账号合并还不是完整 4 步向导；全局流水还没有用户、类型、时间范围、操作人筛选；行内删除/禁用仍作为弱文本按钮保留，未做更多菜单。

---

# 后台反馈优化落地 Todo

更新时间：2026-06-10

目标：把后台反馈中的权限、连续生成、偏好保存、返回来源、图集管理、产出归属、账号展示和状态颜色问题分批落地。项目代付涉及计费主体变化，必须先独立 Spec，不混入普通 UI 修复。

## Batch 1：权限矩阵与隔离验证

- [x] 新增 `scripts/task-permission-matrix-smoke.ts`。
- [x] 复用当前 session cookie 签名方式，不打印 cookie、token 或签名 URL。
- [x] 自动选择本地 active 管理员、普通用户、项目成员作为样本。
- [x] 校验 `/api/video/list` 和 `/api/video/list?include_all=true` 不向普通用户/项目成员泄露非授权任务。
- [x] 校验非授权 `/api/video/status/:id` 返回 403/404。
- [x] 校验非授权 `/api/video/thumbnail/:id` 返回 403/404。
- [x] 校验非管理员访问 `/api/admin/outputs` 返回 401/403。
- [x] 校验项目成员只能访问自己有权限的项目任务列表。
- [x] 运行 `BASE_URL=http://localhost:3000 npx tsx scripts/task-permission-matrix-smoke.ts`，16 个 HTTP 检查通过。
- [x] 运行 `npx tsc --noEmit --pretty false`，通过。
- [x] 运行 `npm run build`，通过；仅有既有 `<img>` 和 React hooks lint warning。

结论：本批次没有发现越权，不需要修改权限业务逻辑。当前闭环是“权限验证闭环”，不是全反馈功能闭环。

## Batch 2：返回来源页和状态颜色语义

- [x] 新增 `src/lib/navigation/return-to.ts`，集中生成任务详情来源链接。
- [x] 任务详情页读取并净化 `return_to`，非法外链 fallback 到 `/tasks`。
- [x] `/tasks`、`/generate`、`/admin/outputs`、`/projects/:id`、`/admin`、`/admin/costs` 的任务详情入口已补 `return_to`。
- [x] 任务详情返回文案会按来源显示：返回任务、返回生成页、返回项目、返回产出留存、返回成本后台、返回后台。
- [x] `GenerationComposer` 增加 `hasAttemptedSubmit`，首次空 prompt 是蓝色 hint，点击提交后仍为空才是红色 error。
- [x] `ComposerStatusLine` 支持 `hint | progress | ok | error` 四种状态语义。
- [x] `提交中...` 使用 progress 语义，不再走 error 样式。
- [x] `status-running` 和生成页最近任务 running badge 改为绿色进行态；失败/危险仍保留红色。
- [x] 运行 `npx tsx -e "import { sanitizeReturnTo, taskReturnLabel, taskDetailHref } from './src/lib/navigation/return-to.ts'; ..."`，通过。
- [x] 运行 `npx tsc --noEmit --pretty false`，通过。
- [x] 运行 `npm run build`，通过；仅有既有 `<img>` 和 React hooks lint warning。
- [x] 运行 `BASE_URL=http://localhost:3000 npx tsx scripts/project-ui-smoke.ts`，通过。

说明：ClickOps CLI 健康检查、能力列表和可调用工具列表通过；本次启动 debug session 后，后续 CLI 调用未能保留该 session，未获得浏览器 snapshot，因此用构建和本地 UI smoke 作为本批次验证证据。

## Batch 3：连续生成和用户最后一次生成设置

- [x] 创建成功后，生成表单不再被长期结果卡阻塞。
- [x] 创建成功后，新任务立即进入最近任务顶部。
- [x] 支持多个已提交任务继续后台轮询，不因为继续创建下一段而停止旧任务刷新。
- [x] 成功提示改为轻量队列提示，支持查看详情和自动收起。
- [x] 新增 `UserPreference` 模型和迁移，保存用户生成偏好。
- [x] 新增 `/api/me/preferences/generation` GET/PATCH。
- [x] 新增生成偏好归一化 helper，避免保存签名 URL、素材 URL、本地路径或一次性上传地址。
- [x] 生成页登录后读取偏好，提交成功后异步保存偏好。
- [x] 本地 localStorage 作为偏好接口不可用时的 fallback。
- [x] 本地数据库未应用迁移时，偏好接口返回 `user_preference_table_missing`，不影响生成页使用。
- [x] 运行 `npm run db:generate`，通过。
- [x] 运行生成偏好归一化 smoke，通过。
- [x] 运行 `npx tsc --noEmit --pretty false`，通过。
- [x] 运行 `npm run build`，通过；仅有既有 `<img>` lint warning。
- [x] 运行 `BASE_URL=http://localhost:3002 npx tsx scripts/project-ui-smoke.ts`，通过。

注意：跨设备服务端偏好持久化依赖 `20260610083000_add_user_preferences` 迁移上线；本地未执行数据库写入迁移前会自动降级到 localStorage。

## Batch 4：图集封面、重命名、删除/归档入口

- [x] 列表 API 返回 `cover_image_url`，优先封面图，否则第一张 active 图片。
- [x] 封面 URL 走 `/api/reference-images/:imageId/content?variant=thumbnail`，继续复用参考图权限。
- [x] 图集卡片显示封面图，失败或空图集 fallback 到数量/空状态。
- [x] 图集卡片动作区增加“重命名 / 删除”，仅 `permissions.edit` 可见。
- [x] 图集详情页增加“重命名图集 / 删除图集”。
- [x] 删除确认文案说明：从列表隐藏，历史任务引用参考图仍保留。
- [x] DELETE 后端从 `deleted` 改为 `archived`，不再批量删除 `ReferenceImage`。
- [x] 列表 API 只返回 `status='active'`，归档图集不再出现在 `/collections`。
- [x] 运行 `npx tsc --noEmit --pretty false`，通过。
- [x] 运行 `npm run build`，通过；仅有既有 `<img>` lint warning。
- [x] 运行图集只读 smoke，通过：列表和详情都返回 `cover_image_url`，页面路由返回 200。
- [x] 运行 `BASE_URL=http://localhost:3002 npx tsx scripts/project-ui-smoke.ts`，通过。

注意：本批次没有执行真实 PATCH/DELETE，避免修改当前本地真实图集数据；写路径已通过类型检查和构建覆盖。

## Batch 5：产出留存和任务详情显示生成者头像、项目、来源

- [x] 新增 `src/lib/users/display.ts`，统一过滤技术用户名和合成飞书邮箱。
- [x] 新增 `src/components/UserIdentityBadge.tsx`，支持头像、姓名、fallback 首字母。
- [x] 后台产出 API owner/submitted/操作人摘要返回 `avatar_url` 和 `account_type`。
- [x] 产出留存列表用头像 badge 展示生成者。
- [x] 任务状态 API 返回 `owner` 和 `submitted_user`。
- [x] 任务详情页视频上方展示生成者、项目、来源和来源请求短 ID。
- [x] Codex API 来源显示 `source_label || Codex API`。
- [x] 运行用户显示格式化 smoke，通过。
- [x] 运行 `npx tsc --noEmit --pretty false`，通过。
- [x] 运行 `npm run build`，通过；仅有既有 `<img>` lint warning。
- [x] 运行 Batch 5 只读 smoke，通过。
- [x] 运行 `BASE_URL=http://localhost:3002 npx tsx scripts/project-ui-smoke.ts`，通过。

注意：本批次没有执行隐藏/恢复/生成等写动作；`impeccable` 未找到项目级 PRODUCT/DESIGN，本次按 product register 和现有后台视觉体系执行。

## Batch 6：账号展示名格式化，隐藏过长技术后缀

- [x] 顶部账号菜单使用统一 `displayUserName`。
- [x] 个人页主名称使用统一显示；合成飞书邮箱显示为“未绑定真实邮箱”。
- [x] 项目 owner、图集 owner、生成页项目选择、画布项目选择等用户可见标签使用统一显示。
- [x] 后台首页、成本页、项目详情、反馈页、集成页、生成驾驶舱和导出中的 owner/member 主显示使用统一格式化。
- [x] 后台用户页列表、批量操作预览、合并账号下拉和确认文案使用统一格式化。
- [x] 保留后台搜索、表单、审计日志里的原始 username/email，不改真实账号数据。
- [x] 运行用户显示格式化 smoke，通过。
- [x] 运行 `npx tsc --noEmit --pretty false`，通过。
- [x] 运行 `npm run build`，通过；仅有既有 `<img>` lint warning。
- [x] 运行 Batch 6 只读页面 smoke，通过。
- [x] 运行 `BASE_URL=http://localhost:3002 npx tsx scripts/project-ui-smoke.ts`，通过。
- [x] 运行 `npx impeccable detect src/components/AccountMenu.tsx`，通过。
- [x] 运行 `npx impeccable detect src/app/admin/users/AdminUsersClient.tsx`，通过。

注意：本批次没有修改 Feishu 绑定字段、登录逻辑、合并逻辑或数据库数据。

## 后续批次

- [x] 用户本质反馈对齐审计；已把反馈归纳为连续创作、状态理解、素材引用、权限归属、账务透明和导航上下文六类本质需求，见 `tasks/feedback-optimization-plan.md` 第 18 节。
- [x] 闭环检查更新；已区分需求理解闭环、规划闭环、本地实现闭环和生产回归闭环；最新闭环状态以本节后续批次和 `tasks/feedback-optimization-plan.md` 第 20 节为准。
- [x] Batch 7：项目代付独立 Spec 阶段 1；已完成现状分析和代码依据，见 `tasks/project-billing-scope-spec.md`。
- [x] Batch 7：管理页二级流水入口先行落地；`/admin/points` 已承载完整点数与额度流水，`/admin/users` 底部全局流水改为二级页入口，后台总览和成本页已补入口。
- [ ] Batch 7：项目代付独立 Spec 阶段 2；确认额度来源、代付开关、配置权限、扣费优先级、外部 API `project_id` 行为、历史任务口径和管理页二级流水页信息架构，推荐将完整点数与额度流水承载在现有 `/admin/points`。
- [ ] Batch 7：项目代付独立 Spec 阶段 3；确认风险决策、数据模型、迁移策略、服务拆分、验证脚本和回滚条件。
- [ ] Batch 7：项目代付实现；完整 Spec 三段确认后再修改 Prisma、账本、创建接口、finalizer、后台 UI 和外部 API 文档。
- [x] Batch 8：任务详情相对时间；已在实际扣费附近显示“生成于/更新于 刚刚、N 分钟前、N 小时前、N 天前”，并保留绝对时间用于审计。
- [x] Batch 9：提示词输入框放大/全屏编辑；已支持大面板编辑、完成写回、取消确认和 Esc 退出。
- [x] Batch 10A：`@图片` 当前素材插入；已按即梦官方 `@图片N` 主格式从当前 workspace 素材生成插入按钮，`PromptChecker` 兼容 `@图片N/@图片 N/@图N/图N`，继续复用现有 `reference_image_ids`。
- [ ] Batch 10B：`@图片` 图集选择；从参考图集选择图片，自动加入 workspace 并插入对应 `@图片N`，需在 10A 验收后再做。

### Batch 10 官方 `@图片N` 规则闭环 Todo

- [x] 规则研究：已确认即梦官方主格式是 `@图片N` / `@图片 N`，不是裸 `@图N`；旧格式只能作为历史 prompt 兼容。
- [x] UI 插入一致：`PromptEditor` 当前素材按钮输出 `@图片1`、`@图片2`，不再输出 `@图1`。
- [x] 校验一致：`PromptChecker` 识别 `@图片N`、`@图片 N`，并兼容 `@图N`、`图N`。
- [x] 用户可见文案一致：`PromptEditor`、`PromptChecker`、`ModeSelector`、`ReferenceAlbumPicker` 均使用官方 `@图片N` 口径。
- [x] 提交口径一致：`@图片N` 仍只是 prompt 自然语言引用，真实参考图继续由 `reference_image_ids` 按 workspace 顺序提交，不新增后端字段。
- [ ] 生产回归：用真实登录态打开 `/generate`，上传或选择 2 张参考图，插入 `@图片1/@图片2`，确认页面校验不报缺图。
- [ ] Payload 验收：抓一次创建请求，确认 prompt 包含 `@图片1/@图片2`，同时 `reference_image_ids` 顺序与当前 workspace 第 1、2 张参考图一致。
- [ ] 非付费优先：Payload 验收优先用拦截、dry-run 或测试环境完成；如必须真实提交生成，先取得明确授权。
- [ ] 删除/重排验收：删除或重排第 1 张参考图后，确认 `PromptChecker` 能提示引用越界或顺序变化风险，不能让 `@图片1` 静默指向错误素材。
- [ ] 外部 API 说明补充：如果外部 prompt 使用 `@图片N`，文档必须说明调用方要按同一顺序传 `reference_image_ids` / `reference_image_urls`，否则 `@图片N` 只是无效文本。
- [ ] Batch 10B 实现：从图集选择图片时，先加入 workspace，再按加入后的真实顺序插入 `@图片N`；失败时不得插入 prompt。
- [ ] Batch 10B 去重：如果图集图片已在 workspace 中，直接插入已有序号，不重复加入 `reference_image_ids`。
- [ ] Batch 10B 验收：从图集选择图片后，确认 workspace 缩略图、prompt `@图片N`、提交 payload 三者顺序一致。

## 停止条件

- 项目代付未完成 Spec 前，不修改账本、Prisma schema 或扣费逻辑。
- 图集删除如果从“归档集合”升级为“删除素材文件”，先确认历史任务引用保护策略。
- 外部 API 生成内容的自动下载、截图、归属链路需要和本地视频留存策略统一，不单独做一套。
- `@图片` 不能只插入文本，必须保证 prompt 引用和实际参考图参数一致；做不到映射时先停在轻量当前素材插入版。
- 即梦官方 `@图片N` 规则不得退回 `@图N` 作为主 UI 文案；`@图N` / `图N` 只能保留为历史 prompt 兼容。
- 没有验证 `reference_image_ids` 顺序前，不得把生产闭环标记为完成。

## 视频生成管理页规划需求：成本与产能驾驶舱

页面定位：将视频生成管理页收口为「视频生成成本与产能驾驶舱」，优先服务管理者判断生成规模、成本消耗、项目结构、成员效率和异常风险。

核心展示维度：

1. 视频生成量
2. 成本消耗
3. 项目占比
4. 清晰度消耗占比：480P / 720P / 1080P
5. 成员效率排行
6. 异常预警
7. 最近生成记录
8. 数据口径与交互规则

关键页面原则：

- 不要把「模型」和「清晰度」混在一起。
- 首页优先展示 480P / 720P / 1080P，因为这是管理者最容易理解、也最直接影响成本的维度。
- 模型维度可以作为二级筛选、详情下钻或辅助分析项，不作为首页主视角。
- 成本相关指标必须明确口径，区分实际扣费、估算成本、官方账单导入金额和平台点数消耗。
- 异常预警需要优先暴露会影响成本、额度、任务成功率或产能判断的问题。

待规划交互：

- [ ] 首页顶部展示生成量、总成本、平均单条成本、失败/异常任务数。
- [ ] 首页首屏展示生成趋势，至少包含生成次数、生成秒数和官方额度，并支持按日 / 按周 / 按月查看。
- [ ] 使用清晰度作为第一成本拆分维度，展示 480P / 720P / 1080P 占比和金额。
- [ ] 项目占比支持按生成量、官方成本和点数消耗切换排序，不展示失败维度。
- [ ] 成员效率排行支持按生成量、有效产出、平均成本和点数消耗查看，不展示失败维度。
- [ ] 最近生成记录保留任务、用户、项目、清晰度、实际扣费、状态和时间。
- [ ] 异常预警聚合额度不足、扣费异常、Provider 失败、下载失败、无归属项目等问题。
- [ ] 数据口径区域说明统计周期、币种、成本来源和延迟刷新规则。

### 项目现状对照

- 已有任务数据底座：`prisma/schema.prisma` 的 `VideoTask` 已保存 `resolution`、`duration`、`model`、`actual_cost`、`provider_official_amount_minor`、`provider_official_amount_micros`、`provider_cost_currency`、`project_id`、`user_id`、`owner_user_id`、`local_status`、`provider_cost_status`、`cost_allocation_status`，足够支撑生成量、清晰度、项目、成员、成本和异常统计。
- 已有成本总账底座：`prisma/schema.prisma` 的 `CostLedger` / `CostAllocation` 已保存任务、用户、项目、Provider、官方账单、金额、币种、置信度和分摊关系，适合作为官方成本和对账口径。
- 已有产出列表接口：`src/app/api/admin/outputs/route.ts` 的 `GET` 已返回任务、清晰度、模型、项目、用户、点数扣费、官方扣费、留存状态和分页；但 `summary` 目前只按 `retention_status` 和 `local_status` 汇总，没有按清晰度、项目、成员或成本聚合。
- 已有产出留存页面：`src/app/admin/outputs/AdminOutputsClient.tsx` 的 `AdminOutputsClient` 当前定位是“产出留存”，按视频帧核对、隐藏/恢复、归属追溯；它展示单条实际扣费，但不是管理驾驶舱。
- 已有后台总览：`src/app/admin/page.tsx` 的 `AdminPage` 已展示本月官方金额、待确认成本、账本自检、接口失败、新反馈、活跃账号、最近任务；但首页主视角仍是供应商余额和计费链路，没有视频生成量、清晰度消耗占比、项目占比和成员效率。
- 已有成本复盘页：`src/app/admin/costs/page.tsx` 的 `AdminCostsPage` 已覆盖官方成本、供应商余额、待确认成本、异常待办、账本自检、待处理队列、Provider 请求异常和最近总账；但缺少管理者第一眼需要的产能结构和清晰度结构。
- 已有导出口径：`src/app/api/admin/costs/export/route.ts` 的 `GET` 导出 CSV 时已包含 `task_resolution`、`task_model`、`task_duration`、`project_id`、`project_name`、`user_id`、金额和币种；说明当前数据已能导出，但还没有聚合 API 给页面直接消费。
- 已有价格规则：`src/lib/pricing.ts` 的 `calculateEstimatedCost` 和 `src/lib/pricing-client.ts` 的 `calculateEstimatedCostClient` 已按 `480p / 720p / 1080p` 计算点数，证明清晰度是稳定的一等参数，不应在驾驶舱首页被模型维度稀释。

### 需要闭环调整的地方

- [ ] 明确落地点：将 `/admin` 首屏升级为「视频生成成本与产能驾驶舱」，保留供应商余额和计费链路作为风险区；`/admin/outputs` 继续做产出明细与留存操作，`/admin/costs` 继续做成本复盘与对账。
- [ ] 新增聚合口径：在后台服务端聚合或新增 `/api/admin/generation-dashboard`，返回时间范围内的生成量、成功数、失败数、总点数、官方成本、平均单条成本、清晰度占比、项目占比、成员排行、异常列表和最近生成记录。
- [ ] 清晰度优先：驾驶舱第一层图表和指标按 `resolution` 聚合，只展示 `480p / 720p / 1080p / 未记录`；`model` 只放到二级筛选或明细列，不和清晰度并列成首页主维度。
- [ ] 成本口径分层：页面必须同时但分层显示 `actual_cost`（平台点数扣除）、`provider_official_amount_micros/minor`（官方美金成本）、`estimated_cost`（预估点数）、`frozen_cost/refund_amount`（冻结/退款），默认主成本用官方成本；官方缺失时显示“待官方确认”，不能用点数冒充美金成本。
- [ ] 项目占比闭环：项目占比按 `VideoTask.project_id` 聚合，缺失项目归入“未归属项目”，并把未归属项目计入异常预警，入口跳到 `/admin/costs` 待处理队列或 `/admin/outputs?project_id=...`。
- [ ] 成员效率闭环：成员排行按 `owner_user_id` 优先、回退 `user_id` 聚合，展示生成量、成功量、点数消耗、官方成本和平均成本；点击成员跳到 `/admin/outputs?owner_user_id=...`。
- [ ] 异常预警闭环：复用 `src/lib/costs/audit.ts` 的账本自检，并补充驾驶舱级异常：失败可能收费、待官方确认、未归属项目、成本未分摊、Provider 请求失败、长时间 pending、重复 `provider_task_id`、任务已完成但缺少本地视频/缩略图。
- [ ] 最近生成记录闭环：最近记录保留任务 ID、提示词摘要、用户、项目、清晰度、时长、状态、点数扣除、官方成本、成本状态；详情跳转使用 `taskDetailHref(task.id, '/admin')`，不要复制一套详情页。
- [ ] 数据口径说明：在驾驶舱底部或帮助抽屉写明统计周期、刷新方式、币种换算、官方成本优先级、点数和美金区别、清晰度归一化规则、未记录数据如何处理。
- [ ] 导出闭环：复用 `/api/admin/costs/export` 的字段，新增与当前筛选一致的驾驶舱导出入口，避免页面看的是聚合口径、导出却是全量总账口径。

### 推荐实施顺序

- [x] P0：新增驾驶舱聚合查询，先支持默认“本月”数据和 `7d / 30d / 本月 / 自定义` 时间筛选。
- [x] P0：改造 `/admin` 首屏模块顺序：顶部 KPI -> 清晰度成本占比 -> 项目占比 + 成员排行 -> 异常预警 -> 最近生成记录 -> 数据口径。
- [x] P0：把 `model` 降为筛选项或明细列，首页不做模型大卡片。
- [x] P1：为项目、成员、异常和最近记录补跳转参数，保证从聚合指标能回到明细列表。
- [x] P1：补充空状态、加载态、成本缺失态和官方金额待确认态，避免管理者误读。
- [ ] P2：增加导出当前驾驶舱数据、保存常用时间范围、按项目/成员展开二级明细。

### 验收标准

- [ ] 首页第一屏能回答：本周期生成了多少视频、花了多少官方成本、主要成本花在哪个清晰度、哪个项目/成员消耗最高、有哪些异常需要处理。
- [ ] 清晰度图表只按 `480p / 720p / 1080p / 未记录` 展示，不把模型作为同级主维度。
- [ ] 任一聚合数字都能追溯到明细任务或成本记录。
- [ ] 官方成本缺失时明确显示“待官方确认”，不把平台点数展示成美元。
- [ ] 异常预警每一类都有可点击处理入口或明确说明为什么无法处理。
- [ ] `/admin/outputs` 和 `/admin/costs` 的原有功能入口保留，不因驾驶舱改造被删除。

### 具体细节任务规划

> 执行前约束：这是中等以上 UI + 数据口径改造。先确认本规划，再进入代码实现；实现中发现数据口径偏差，先回写本规划，再改代码。

#### 任务目标对齐

**总目标**：把 `/admin` 从普通后台总览升级为「视频生成成本与产能驾驶舱」，让管理者在第一屏判断本周期视频产能、官方成本、清晰度消耗结构、项目/成员消耗和异常待办，并且每个数字都能追溯到明细。

| 目标 ID | 目标 | 对应任务 | 成功信号 | 不做什么 |
| --- | --- | --- | --- | --- |
| G1 | 第一屏回答经营问题：生成了多少、花了多少、哪里花得最多、哪里异常 | P0-1、P0-2、P0-3、P0-4 | `/admin` 首屏有 KPI、清晰度主舞台、项目/成员、异常预警、最近记录 | 不做一堆等权重小卡片，不让供应商余额继续压过生成驾驶舱 |
| G2 | 清晰度成为首页主成本维度 | P0-1、P0-3、P0-4、P1-1 | 首页图表只按 `480p / 720p / 1080p / 未记录` 展示，点击能进明细 | 不把 `model` 和 `resolution` 混成同级主维度 |
| G3 | 成本口径不混淆 | P0-1、P0-2、P0-3、P1-4、P1-3 | 官方美元成本、平台点数、预估点数、冻结/退款分层显示；官方缺失显示“待官方确认” | 不把 `actual_cost` 点数显示成 USD，不用预估点数冒充真实扣费 |
| G4 | 聚合数字可追溯 | P1-1、P1-2、P1-3 | 清晰度、项目、成员、异常、最近记录都有明细跳转或导出 | 不新增孤立 dashboard 数据，不复制一套任务详情页 |
| G5 | 异常预警可处理 | P0-1、P1-2、P1-4 | 每个异常都有数量、原因、处理入口和口径说明 | 不只展示红色数字，不把异常做成不可点击提示 |
| G6 | 保留原后台功能 | P0-0、P0-3、P1-1 | `/admin/outputs` 隐藏/恢复、`/admin/costs` 对账、`/admin/users` 用户点数入口仍可达 | 不为了驾驶舱改造删除原有功能入口 |
| G7 | 可验证、可上线 | P0-0、详细验证计划 | 类型检查、lint、build、smoke、上线健康检查都有明确命令 | 不在 build 失败或口径未确认时重启生产服务 |

**目标依赖顺序**

- [ ] 先闭环 G3 成本口径：如果金额口径不清，后续图表都可能误导。
- [ ] 再闭环 G2 清晰度维度：确认历史数据归一化后，再做首页主舞台。
- [ ] 再闭环 G1 首屏信息结构：用聚合数据喂给 `/admin`。
- [ ] 再闭环 G4/G5 追溯和异常处理：所有数字必须可回到 `/admin/outputs` 或 `/admin/costs`。
- [ ] 最后闭环 G6/G7：确认原功能保留、验证命令通过、上线链路健康。

**执行判定**

- [ ] P0 完成的定义：G1、G2、G3 的默认本月视图可用，且不影响原后台入口。
- [ ] P1 完成的定义：G4、G5 可追溯和可处理，导出与页面筛选口径一致。
- [ ] P2 完成的定义：不改变核心口径，只改善使用效率和空/加载/记忆状态。
- [ ] 如果某个任务不能服务上表任何目标，默认不做或降级到 P2。

#### P0-0：执行前基线和保护

- [ ] 运行 `git status --short`，确认当前已有改动归属，不把无关文件混入本次实现。
- [ ] 不改 `prisma/schema.prisma`，除非实现时证明现有字段无法表达驾驶舱口径；当前判断是不需要新增表。
- [ ] 不删除 `/admin/outputs`、`/admin/costs`、`/admin/users`、`/admin/projects` 的现有入口。
- [ ] 不改变真实扣费、点数冻结、退款、Provider 请求和官方账单写入逻辑；本期只做读侧聚合和展示。
- [ ] 实现前先跑一次 `npx tsc --noEmit --pretty false`，记录当前基线是否通过。

#### P0-1：新增驾驶舱聚合服务层

**目标**：把统计口径集中到一个服务文件，页面和 API 不各算一套。

**文件**

- [ ] Create: `src/lib/admin/generation-dashboard.ts`

**实现要点**

- [ ] 定义 `DashboardRangeKey = '7d' | '30d' | 'month' | 'custom'`。
- [ ] 定义 `GenerationDashboardQuery`：`range`、`dateFrom`、`dateTo`、`projectId`、`ownerUserId`、`resolution`。
- [ ] 定义 `GenerationDashboardData`，至少包含：
  - `range`
  - `kpis`
  - `resolution_breakdown`
  - `project_breakdown`
  - `member_ranking`
  - `warnings`
  - `recent_tasks`
  - `data_notes`
- [ ] 实现 `parseDashboardRange(searchParams, now)`：默认本月；自定义范围最大先限制为 180 天，避免一次性扫全库。
- [ ] 实现 `normalizeDashboardResolution(value)`：只允许 `480p / 720p / 1080p`，其他归为 `unknown`。
- [ ] 实现 `officialCostMicros(task)`：优先 `provider_official_amount_micros`，否则 `provider_official_amount_minor * 10000`，没有官方成本返回 `null`。
- [ ] 实现 `taskActorId(task)`：优先 `owner_user_id`，回退 `user_id`。
- [ ] 实现 `getGenerationDashboardData(query)`：
  - 从 `VideoTask.created_at` 做时间过滤。
  - 只 select 驾驶舱需要字段，避免读取 raw response 和大 JSON。
  - 聚合生成量、成功量、失败量、总点数、官方成本、平均单条官方成本。
  - 按清晰度聚合数量、成功量、失败量、点数、官方成本。
  - 按项目聚合数量、成功量、点数、官方成本；`project_id = null` 归为“未归属项目”。
  - 按成员聚合数量、成功量、点数、官方成本、平均成本。
  - 生成最近 10 条任务记录。
  - 生成异常预警：待官方确认、失败可能收费、未归属项目、成本未分摊、Provider 请求失败、长时间 pending、重复 `provider_task_id`、终态任务缺成本账本。
- [ ] 复用 `src/lib/costs/audit.ts` 的 `getCostLedgerAuditSummary()`，不要复制账本自检逻辑。

**验证**

- [ ] 新增或临时运行 helper smoke：`npx tsx -e "import { getGenerationDashboardData } from './src/lib/admin/generation-dashboard.ts'; ..."`。
- [ ] 期望：能返回 `resolution_breakdown` 且键只包含 `480p / 720p / 1080p / unknown`。

#### P0-2：新增驾驶舱 API

**目标**：给页面交互和后续导出提供稳定 JSON 边界。

**文件**

- [ ] Create: `src/app/api/admin/generation-dashboard/route.ts`

**实现要点**

- [ ] `GET` 使用 `getAdminUser(request)` 校验管理员。
- [ ] 从 query 读取：`range`、`date_from`、`date_to`、`project_id`、`owner_user_id`、`resolution`。
- [ ] 调用 `getGenerationDashboardData`。
- [ ] 返回 `{ dashboard, generated_at }`。
- [ ] 错误时沿用后台 API 风格：401/403 透出鉴权错误，其他返回 500 + `加载驾驶舱失败`。

**验证**

- [ ] `npx tsc --noEmit --pretty false`
- [ ] 本地登录态可用时访问 `/api/admin/generation-dashboard?range=month`，确认 JSON 包含 `kpis`、`resolution_breakdown`、`warnings`。

#### P0-3：改造 `/admin` 首屏为驾驶舱

**目标**：让后台首页第一屏回答“生成量、官方成本、清晰度消耗、项目/成员消耗、异常待办”。

**文件**

- [ ] Modify: `src/app/admin/page.tsx`
- [ ] Create: `src/app/admin/AdminGenerationDashboardClient.tsx`

**页面结构**

- [ ] 顶部 `PageBanner` 标题改为“视频生成成本与产能驾驶舱”。
- [ ] 第一行 KPI：
  - 本周期视频生成量
  - 官方成本
  - 平均单条官方成本
  - 异常待办
- [ ] 第二块主舞台：清晰度成本占比，只展示 `480p / 720p / 1080p / 未记录`。
- [ ] 第三块：项目占比和成员效率排行并列展示。
- [ ] 第四块：异常预警，按可处理优先级排序。
- [ ] 第五块：最近生成记录。
- [ ] 底部：数据口径与交互规则。

**交互规则**

- [ ] 时间范围用分段控件：`本月 / 7天 / 30天 / 自定义`。
- [ ] 切换范围后通过 API 刷新，不整页跳转。
- [ ] 项目、成员、异常、最近任务都必须能跳到明细。
- [ ] 供应商余额和账本自检保留，但移动到风险辅助区，不抢第一视角。
- [ ] 原后台总览的“计费与成本、用户与点数、项目管理、产出留存、接口配置、反馈管理”入口保留在快捷入口区。

**禁止**

- [ ] 不做模型大卡片。
- [ ] 不把 `actual_cost` 点数显示成美元。
- [ ] 不让状态 chip 抢过清晰度和成本主视角。

#### P0-4：补驾驶舱样式

**文件**

- [ ] Modify: `src/app/globals.css`

**样式模块**

- [ ] `.admin-generation-dashboard`
- [ ] `.admin-dashboard-toolbar`
- [ ] `.admin-dashboard-kpi-grid`
- [ ] `.admin-dashboard-resolution-stage`
- [ ] `.admin-dashboard-breakdown-row`
- [ ] `.admin-dashboard-ranking`
- [ ] `.admin-dashboard-warning-list`
- [ ] `.admin-dashboard-recent-table`
- [ ] `.admin-dashboard-data-notes`

**设计约束**

- [ ] 产品后台风格：克制、信息密度高、少装饰。
- [ ] 第一屏不超过三个强焦点：KPI、清晰度主舞台、异常提示。
- [ ] 移动端顺序：KPI -> 清晰度 -> 异常 -> 项目 -> 成员 -> 最近记录 -> 口径。
- [ ] 不新增大面积渐变、装饰图形或营销式 hero。

#### P1-1：补 `/admin/outputs` 明细追溯参数

**目标**：所有驾驶舱聚合数字都能回到明细任务。

**文件**

- [ ] Modify: `src/app/api/admin/outputs/route.ts`
- [ ] Modify: `src/app/admin/outputs/AdminOutputsClient.tsx`

**实现要点**

- [ ] API `buildWhere` 增加 `resolution` 校验：`480p / 720p / 1080p / unknown`。
- [ ] API 支持 `date_from` / `date_to` 已有，继续复用。
- [ ] 页面高级筛选增加清晰度筛选。
- [ ] 从 URL 初始化 `resolution`、`date_from`、`date_to`、`owner_user_id`、`project_id`，让驾驶舱跳转后筛选状态可见。
- [ ] 输出卡片继续保留隐藏/恢复功能，不因追溯改造删除。

**跳转规则**

- [ ] 清晰度卡片：`/admin/outputs?resolution=480p&date_from=...&date_to=...`
- [ ] 项目卡片：`/admin/outputs?project_id=...&date_from=...&date_to=...`
- [ ] 成员卡片：`/admin/outputs?owner_user_id=...&date_from=...&date_to=...`
- [ ] 最近任务：`taskDetailHref(task.id, '/admin')`

#### P1-2：异常预警处理入口

**目标**：异常不是只展示数字，每一类都能进入处理位置。

**文件**

- [ ] Modify: `src/lib/admin/generation-dashboard.ts`
- [ ] Modify: `src/app/admin/AdminGenerationDashboardClient.tsx`
- [ ] Optional Modify: `src/app/admin/costs/page.tsx`

**预警类型和入口**

- [ ] `pending_official_cost`：跳 `/admin/costs`，锚定或过滤待确认成本。
- [ ] `failed_possible_charge`：跳 `/admin/costs`，查看失败但可能收费任务。
- [ ] `unallocated_project`：跳 `/admin/outputs?project_id=unassigned` 或 `/admin/costs` 待处理队列。
- [ ] `provider_request_failed`：跳 `/admin/costs` Provider 请求异常区。
- [ ] `stale_pending_provider_request`：跳 `/admin/costs` 账本自检区。
- [ ] `duplicate_provider_task_id`：跳 `/admin/costs` 账本自检区。
- [ ] `missing_local_video`：跳 `/admin/outputs?status=succeeded&has_local_video=false`，如果本期不做该筛选，则先跳 `/admin/outputs?status=succeeded` 并在说明里标注。

#### P1-3：导出当前驾驶舱数据

**目标**：页面看到什么，导出就是什么口径。

**文件**

- [ ] Create: `src/app/api/admin/generation-dashboard/export/route.ts`
- [ ] Modify: `src/app/admin/AdminGenerationDashboardClient.tsx`

**实现要点**

- [ ] 复用 `getGenerationDashboardData` 的时间和筛选口径。
- [ ] CSV 至少包含两段：
  - `summary`：KPI、清晰度、项目、成员、异常。
  - `recent_tasks`：任务 ID、时间、用户、项目、清晰度、时长、状态、点数、官方成本、成本状态。
- [ ] 导出文件名：`generation-dashboard-YYYY-MM-DD.csv`。
- [ ] 页面导出按钮拼接当前筛选 query。

#### P1-4：补数据口径说明

**文件**

- [ ] Modify: `src/app/admin/AdminGenerationDashboardClient.tsx`

**必须写清楚**

- [ ] 统计周期以 `VideoTask.created_at` 为准。
- [ ] 官方成本优先读 `provider_official_amount_micros`，回退 `provider_official_amount_minor`。
- [ ] `actual_cost` 是平台点数，不是美元。
- [ ] `estimated_cost` 是预估点数，不能代表真实扣费。
- [ ] 清晰度只归一为 `480p / 720p / 1080p / 未记录`。
- [ ] 任务无项目时归入“未归属项目”。
- [ ] Provider 官方金额未返回时展示“待官方确认”。

#### P2：体验补强

- [ ] 支持保存上次选择的时间范围到 localStorage，仅影响本机显示，不写用户偏好表。
- [ ] 支持项目/成员榜单展开查看更多。
- [ ] 支持按项目或成员筛选后保持全页联动。
- [ ] 增加骨架屏和空状态。
- [ ] 为金额字段统一两位小数展示，微单位金额不得被四舍五入到 0。

### 详细验证计划

- [ ] `git diff --check -- src/lib/admin/generation-dashboard.ts src/app/api/admin/generation-dashboard/route.ts src/app/admin/page.tsx src/app/admin/AdminGenerationDashboardClient.tsx src/app/admin/outputs/AdminOutputsClient.tsx src/app/api/admin/outputs/route.ts src/app/globals.css`
- [ ] `npx tsc --noEmit --pretty false`
- [ ] `npm run lint`
- [ ] `npm run build`
- [ ] `npx tsx scripts/generation-dashboard-smoke.ts`
- [ ] 本地浏览器检查 `/admin`：
  - 看得到“视频生成成本与产能驾驶舱”。
  - 第一屏主维度是清晰度，不是模型。
  - 点击 `480p / 720p / 1080p` 能进入对应 `/admin/outputs` 明细。
  - 官方成本缺失显示“待官方确认”。
  - 点数不会显示成美元。
- [ ] 上线后执行：
  - `/Users/gouki-youdoo/.youdoo/bin/youdoo-sites build sd2`
  - `/Users/gouki-youdoo/.youdoo/bin/youdoo-sites restart sd2`
  - `/Users/gouki-youdoo/.youdoo/bin/youdoo-sites status`
  - `curl -sS -D - https://sd2.youdoodesign.com/api/health | head -c 1000`

### 停止条件和回滚点

- [ ] 如果发现清晰度字段历史数据混有 `480P / 720P / 1080P` 大写或其他枚举，先补归一化规则，不直接丢弃数据。
- [ ] 如果官方成本字段缺失比例过高，页面仍可上线，但必须强化“待官方确认”状态，不能用点数顶替美元。
- [ ] 如果 `/admin/outputs` 当前筛选参数改造影响隐藏/恢复功能，立即停止并先修明细页回归。
- [ ] 如果 `npm run build` 失败，不执行 `youdoo-sites restart sd2`。
- [ ] 如果实现需要改 `prisma/schema.prisma`、扣费逻辑或 Provider 写入逻辑，先暂停并重新确认方案。

### 落地记录 - 2026-06-10

- [x] 新增 `src/lib/admin/generation-dashboard.ts`，集中处理时间范围、清晰度归一化、官方成本微单位、项目占比、成员排行、异常预警和最近生成记录。
- [x] 新增 `/api/admin/generation-dashboard`，管理员鉴权后返回驾驶舱 JSON。
- [x] 新增 `/api/admin/generation-dashboard/export`，按当前筛选导出驾驶舱聚合和最近任务 CSV。
- [x] 新增 `src/app/admin/AdminGenerationDashboardClient.tsx`，支持本月、7 天、30 天、自定义时间范围、刷新和导出。
- [x] 改造 `/admin` 为「视频生成成本与产能驾驶舱」，保留供应商余额、计费成本、产出留存、用户点数、项目管理等入口。
- [x] `/admin/outputs` 支持从 URL 初始化 `resolution`、`date_from`、`date_to`、`owner_user_id`、`project_id`，并在高级筛选中展示清晰度和日期筛选。
- [x] `/api/admin/outputs` 支持 `resolution=480p/720p/1080p/unknown` 和 `project_id=unassigned` 追溯查询。
- [x] `/admin/costs` 补 `audit-checks`、`pending-costs`、`provider-errors` 锚点，异常预警可以跳转到处理区域。
- [x] 新增 `scripts/generation-dashboard-smoke.ts`，验证本月范围、清晰度聚合键和点数/美元口径说明。
- [x] 根据参考图调整驾驶舱分析区：项目占比和清晰度占比改为圆环图，圆环使用 `aspect-ratio: 1 / 1` 保证正圆。
- [x] 页面成员排行、项目占比和驾驶舱 CSV 导出移除失败相关比率字段，后续规划也不再把失败维度作为展示或排序维度。
- [x] 按参考图补“每日生成量与成本”趋势模块：支持按日 / 按周 / 按月切换，展示生成次数、生成秒数和官方额度；驾驶舱导出同步增加 `trend_day / trend_week / trend_month`。
- [x] 本地验证：`git diff --check`、`npx tsc --noEmit --pretty false`、`npx tsx scripts/generation-dashboard-smoke.ts`、`npm run lint`、`npm run build`、`npx impeccable detect` 通过。
- [x] 上线验证：`youdoo-sites build sd2`、`youdoo-sites restart sd2`、`youdoo-sites status`、`/api/health` 通过；`.next-prod` 可检索到新标题、新清晰度模块和新 API。
- [ ] 浏览器视觉自动化验收未闭环：Codex in-app browser 能列出 `sd2.youdoodesign.com/admin/users` 标签，但导航 `/admin` 超时；本次以构建产物、生产健康和 smoke/API 鉴权作为验收证据。
- [ ] P2 未做：保存时间范围、项目/成员展开更多、全页联动筛选增强。

---

## 2026-06-10 金额展示双币种统一计划

### 问题定义

- 当前项目里金额展示口径不完全统一：
  - `formatAmountMinorWithCny`、`formatAmountMicrosWithCny` 已经能显示美元和人民币换算。
  - `formatAmountMinorWithFixedCny`、`formatAmountMicrosWithFixedCny` 已用于部分列表和后台页，能固定两位人民币。
  - `formatProviderUsdCharge` 仍只返回 `$xx USD`，会让任务详情、生成页等位置只看到美金。
  - 趋势图金额标签为了空间只显示 `$xx.xx`，但 title 和汇总应继续显示完整双币种。
- 管理和审计场景里，隐藏币种信息会增加误读风险；点击切换虽然省空间，但会让同一金额在不同用户/不同状态下看起来不一致。

### 推荐方案

- [x] 采用“默认同时显示美金 + 人民币换算”作为全项目统一规则。
- [x] 不把点击切换作为默认交互；只在极窄卡片或图表点位上允许短金额，完整金额必须放在 title、详情、表格或侧栏里。
- [x] 美元展示：`$0.35 USD`。
- [x] 人民币展示：`约 ¥2.55`。
- [x] 组合展示：`$0.35 USD（约 ¥2.55）`。
- [x] CNY 原币展示：`¥2.55 CNY` 或 `¥2.55`，不再额外重复换算。
- [x] 未确认金额继续显示：`待官方确认`。

### 影响范围

- [x] `src/lib/costs/currency.ts`
  - 收敛金额 helper。
  - `formatProviderUsdCharge` 改为返回双币种固定两位文案。
  - 增加必要的测试样例或轻量 smoke。
- [x] `src/app/tasks/[id]/page.tsx`
  - 任务详情“实际扣费”、侧栏成本、成本流水统一使用双币种。
- [x] `src/app/tasks/page.tsx`
  - 我的任务列表金额统一双币种，保留两位小数。
- [x] `src/app/generate/page.tsx`
  - 最近任务卡片金额不覆盖截图，不写进视频/图像，只在卡片文字区显示双币种。
- [x] `src/app/admin/outputs/AdminOutputsClient.tsx`
  - 产出留存列表金额统一双币种。
- [x] `src/app/admin/costs/page.tsx`
  - 成本管理页 KPI、任务表、流水表统一双币种。
- [x] `src/app/admin/AdminGenerationDashboardClient.tsx`
  - 驾驶舱 KPI、汇总、明细列表统一双币种；趋势图点位保持短标签，但 title 用完整双币种。
- [x] `src/app/projects/[id]/page.tsx`
  - 项目详情成本总览和成本表统一双币种。
- [x] `src/app/admin/page.tsx`
  - 供应商余额如果是 USD，也显示人民币换算。
- [x] `src/app/admin/costs/ProviderBalancePanel.tsx`
  - 供应商余额快照统一显示双币种固定两位。
- [x] `src/app/admin/costs/OfficialChargeImportForm.tsx`
  - 官方扣费导入预览统一显示双币种固定两位。
- [x] CSV 导出：
  - 保留原始币种/原始金额字段。
  - 增加人民币换算字段，避免导出后丢口径。

### 验收标准

- [x] 全项目用户可见的官方金额默认可同时看到原币种和人民币换算。
- [x] 不再出现只显示 `$xx USD` 但没有人民币换算的任务/产出/成本金额。
- [x] 金额不显示在视频画面或截图缩略图上，只显示在文本区域。
- [x] 小数点后保留两位，微单位金额不得显示成 `$0.00 USD（约 ¥0.00）` 误导用户；小于 0.01 的金额要按既有微金额规则或显示 `< $0.01`。
- [x] `actual_cost` 点数不伪装成美元；点数、官方扣费、人民币换算三者继续分层。

### 验证计划

- [x] `git diff --check -- src/lib/costs/currency.ts src/app/tasks/[id]/page.tsx src/app/tasks/page.tsx src/app/generate/page.tsx src/app/admin/outputs/AdminOutputsClient.tsx src/app/admin/costs/page.tsx src/app/admin/costs/ProviderBalancePanel.tsx src/app/admin/costs/OfficialChargeImportForm.tsx src/app/admin/AdminGenerationDashboardClient.tsx src/app/projects/[id]/page.tsx src/app/admin/page.tsx src/app/api/admin/generation-dashboard/export/route.ts src/app/api/projects/[id]/costs/export/route.ts scripts/currency-format-smoke.ts`
- [x] `npx tsc --noEmit --pretty false`
- [x] `npm run lint`
- [x] `npm run build`
- [x] 针对金额 helper 增加或执行 smoke，覆盖 USD、CNY、null、微单位金额。
- [x] 构建产物只读检查 `.next-prod/server`、`.next-prod/static`，确认双币种 helper、CSV 人民币列和金额换行 CSS 已进入生产包。
- [x] 上线后执行 `youdoo-sites build sd2`、`youdoo-sites restart sd2`、`youdoo-sites status`、公网 `/api/health`。

### 待确认

- [x] 方案 A：默认同时显示美金和人民币换算。已采用。
- [ ] 方案 B：金额可点击，在美金和人民币之间切换。不采用默认方案，审计页面会隐藏一半信息。

### 落地记录 - 2026-06-10

- [x] `formatProviderUsdCharge` 从只显示 `$xx USD` 改为 `$xx.xx USD（约 ¥xx.xx）`。
- [x] 微单位金额小于 0.01 时显示 `< $0.01 USD`，避免误读为 0。
- [x] 任务详情、生成页最近任务、任务列表、后台产出、后台成本、供应商余额、项目复盘、后台首页统一使用固定双币种 helper。
- [x] 导出补人民币估算列：驾驶舱导出增加 `official_costs_cny_estimate`，项目导出补 `official_cost_micros/final_cost_micros` 及对应人民币估算。
- [x] 最近任务和任务详情金额胶囊允许换行，不再把长金额挤出文本区或压到缩略图上。
- [x] 新增 `scripts/currency-format-smoke.ts` 覆盖 USD、CNY、空值和微金额边界。
- [x] 上线 `sd2` 后公网 `/api/health` 返回 200；`youdoo-sites status` 显示 `sd2` 为 OK。
