# 提交生成到稳定下载就绪优化

## 1. 大白话目标复述

用户要的不是“页面上能看到任务成功”这么简单，而是从点击提交生成开始，到系统拿到一个稳定可播放、可下载、不会很快失效的视频文件，整条链路尽量短、尽量稳。

当前最大问题不是模型生成本身慢，而是模型已经生成完成后，视频被搬到我们自己的稳定存储这一步经常延后很久。数据库抽样显示：

- 最近 7 天 Provider 生成完成：137 个成功任务，平均约 343 秒，P50 约 286 秒，P90 约 606 秒。
- 最近 7 天稳定公网缓存完成：135 个任务，平均约 8278 秒，P50 约 811 秒，P90 约 33100 秒，另有 2 个成功任务缺稳定缓存。
- 真正拖慢体验的是 Provider 完成后的缓存/下载链路：49 个任务能在 2 分钟内缓存，其余不少任务延迟到 10 分钟、1 小时甚至更久。

这次目标是把“提交生成 -> 稳定下载就绪”的平均时间压到接近 Provider 本身耗时：先把 P50 控制到 5.5-7 分钟，P90 控制到 11-13 分钟；后续再根据真实数据继续压缩。浏览器系统下载到本地文件夹的完成时间无法稳定被网页直接证明，本阶段以“我们自己的稳定下载 URL 已准备好”为主指标。

最优路线：短期不引入 Redis/BullMQ，不为了队列把系统搞重；先在当前 SQLite/Prisma 基础上做一个持久化视频交付队列。生成完成后用回调第一时间入队，后台 worker 直接把 Provider 视频流式搬到 R2/TOS 稳定存储。轮询只做兜底。未来迁到 server/PostgreSQL 后，再把这个队列替换成 pg-boss。

依据：

- Seedance/KIE 官方文档建议生产环境使用 `callBackUrl`，避免只靠轮询；结果 URL 通常有有效期，需要尽快下载保存。
- pg-boss 是 PostgreSQL 上的 Node.js 后台任务队列，适合 server 迁移后的持久化队列。
- BullMQ 是 Redis 队列，能力强但当前项目没有 Redis，现阶段引入会增加部署和维护成本。

## 2. 具体可执行任务

- [x] T0. 先锁定不影响其他功能的实施边界
  - 范围：首期只处理普通 Seedance 视频任务：`provider = seedance`，且不包含 `generation_mode = enhance_video`，不包含 `provider = volcengine_mediakit`，不包含 IP 生成入口。
  - 要做：实施前列出所有调用 `startTaskLocalization`、`finalizeVideoTaskStatus`、`cacheTaskVideoToLocal`、`ensurePublicVideoDelivery` 的入口，并标注“普通生成 / IP 生成 / 超分增强 / 批量下载 / 历史补偿”。
  - 完成标准：普通 Seedance 新交付链路先独立上线；IP 生成、视频超分、批量下载、手动下载、旧任务播放继续走现有兼容路径，除非后续单独开任务迁移。

- [x] T1. 补全耗时观测字段和基线脚本
  - 范围：`prisma/schema.prisma`、`src/lib/video/**`、`scripts/**`。
  - 要做：明确记录 `提交时间`、`Provider 完成时间`、`稳定下载入队时间`、`下载开始时间`、`下载完成时间`、`交付状态`、`重试次数`、`最后错误`。
  - 保护：schema 只做向后兼容的 nullable/additive 变更；迁移前备份 SQLite；先用 dry-run 脚本查影响数量，不直接写历史数据。
  - 完成标准：能用只读脚本输出最近 24 小时、7 天的 submit->provider、provider->delivery、submit->delivery 的平均值、P50、P90 和缺失数；如修改 `prisma/schema.prisma`，同时确认 `schema-base.prisma` 是否需要同步或明确保持不动的原因。

- [x] T2. 生成提交时固定写入系统回调地址
  - 范围：`src/app/api/tasks/create/route.ts`、Provider 适配相关文件。
  - 要做：任务创建时自动设置系统级回调地址，优先使用 `NEXT_PUBLIC_BASE_URL` 或服务端配置拼出固定回调地址；Provider 适配层继续使用当前项目已有字段名 `callback_url`，不要把外部文档里的大小写直接硬塞进业务层；用户传入的临时 callback 不能覆盖生产稳定链路。
  - 保护：系统回调和外部调用方传入的 callback 要分离保存；不能简单吞掉外部 callback。若 Codex/API 调用方依赖原 callback，系统回调完成后需要转发，或至少记录待转发失败状态。
  - 完成标准：新建普通 Seedance 任务请求 Provider 时一定带系统回调地址，并把最终采用的系统回调地址、外部 callback 记录写入任务参数或专用字段便于审计；缺配置时直接给管理员可理解错误，不静默退回慢轮询。

- [x] T3. 新增 Provider 回调入口
  - 范围：建议新增 `src/app/api/provider/seedance/callback/route.ts` 或同等清晰路径。
  - 要做：接收 Provider 完成通知，校验来源或共享密钥，按 `provider_task_id/task_id` 幂等更新任务状态，并立即写入视频交付队列。回调 payload 如果字段不完整，只作为“唤醒信号”，再走一次 Provider 状态查询获取权威结果。
  - 保护：回调和轮询必须共用同一套“终态落库 + 点数结算 + Provider 成本记录”逻辑，优先从 `finalizeVideoTaskStatus` 抽出共享函数；禁止在 callback route 里另写一套结算。
  - 完成标准：同一个回调重复发送不会重复扣点、不会重复创建多个下载任务、不会把终态任务打回 running；接口应快速返回，不在回调请求里做大文件下载。

- [x] T4. 建立 SQLite 持久化视频交付队列
  - 范围：`prisma/schema.prisma`、`src/lib/video/delivery-queue.ts`。
  - 要做：新增最小够用的队列表，包含任务 ID、状态、优先级、重试次数、下次执行时间、锁定时间、错误信息和完成时间；用唯一键或语义锁保证同一任务同一交付类型只存在一个有效 job。
  - 完成标准：重启服务后未完成的交付任务不会丢；同一视频只能有一个有效交付任务；失败后按退避策略重试；队列为空时不影响现有页面和接口响应。

- [x] T5. 做独立 worker，把视频直接流式搬到稳定存储
  - 范围：`src/lib/video/public-delivery.ts`、`src/lib/assets/public-storage.ts`、建议新增 `scripts/process-video-delivery-jobs.ts`。
  - 要做：worker 从队列取任务，拿 Provider 结果 URL，遇到 403/过期先刷新结果 URL，然后把视频直接流式上传到 R2/TOS；避免先下载到本地再整文件读入内存再上传。
  - 保护：不要直接破坏现有 `uploadPublicAsset(buffer, ...)`，它还服务图片和素材上传；应新增视频专用 `uploadPublicVideoStream` 或同等 helper，保留原 buffer API 兼容。
  - 完成标准：成功后写入 `public_video_url/public_video_cached_at` 和交付耗时字段；失败时保存可读错误并可重试；单任务大文件不会把 Node 进程内存顶高；worker 有独立启动方式、日志位置、健康检查、卡死锁释放和部署后存活验证。

- [x] T6. 降级现有本地缓存 runner 为兜底，不再当主链路
  - 范围：`src/lib/video/task-localization-runner.ts`、`src/app/api/video/status/[id]/route.ts`。
  - 要做：状态查询不再阻塞等待缓存/缩略图；发现 Provider 已完成但交付未入队时，只负责补入队或触发高优先级补偿。
  - 保护：保留 `finalize-pending-videos.ts`、手动 `/api/video/download/[id]`、批量下载和历史补偿脚本的旧能力；不要让旧任务因为没有新队列表记录而无法播放或下载。
  - 完成标准：用户打开资产页或状态页不会因为缓存下载卡住；刷新/轮询最多推动补偿，不承担主交付；旧任务仍可按 `public_video_url -> local_video_path -> result_video_url` fallback 播放。

- [x] T7. 前端和 API 状态改成用户能理解的阶段
  - 范围：`src/app/api/video/status/[id]/route.ts`、`src/app/api/video/download/[id]/route.ts`、任务列表/资产管理/最近任务相关组件。
  - 要做：区分 `生成中`、`已生成，正在准备稳定下载`、`稳定下载已就绪`、`准备失败，可重试`。下载按钮优先使用稳定公网 URL；未就绪时允许用户触发高优先级准备。
  - 保护：状态展示只能新增交付状态，不能把 `local_status` 的业务含义改乱；资产页、任务页、最近任务里已有的成功/失败/超分标签不能被交付状态覆盖；新增或修改下载准备接口必须继续执行 `getSession` 和 `assertCanViewTask` 权限检查。
  - 完成标准：用户不会看到“生成成功但点下载没反应”；失败时能看到明确原因和重试入口；能明确区分“可预览”和“稳定下载已就绪”。

- [x] T8. 补偿历史成功但未稳定缓存的视频
  - 范围：优先复用 `scripts/backfill-public-video-delivery.ts` 和队列 helper。
  - 要做：只读扫描历史成功任务，找出缺 `public_video_url/public_video_cached_at` 的任务；确认数量后再安全入队补偿。
  - 完成标准：不会覆盖已有稳定 URL；补偿脚本默认 dry-run，真实执行需要显式参数。

- [x] T9. Server 迁移后的升级路径预留
  - 范围：规划和代码边界，不先落重依赖。
  - 要做：当前队列 helper 保持接口清晰，未来迁 PostgreSQL 后可替换为 pg-boss；只有 server 已有 Redis 或并发明显超过 SQLite 承载时才考虑 BullMQ。
  - 完成标准：本阶段不新增 Redis 运维负担；未来替换队列时不需要重写业务状态流。

- [ ] T10. Git Plan 和部署计划
  - 当前分支：`codex/seedream-5-pro-image-provider`。
  - 实施建议：正式落地时新建聚焦分支 `codex/video-delivery-fast-path`，不要把大改混进无关分支。
  - 提交分组：先提交 schema/队列基础，再提交 callback/worker，再提交 UI 状态和补偿脚本，最后提交验证记录。
  - 部署标准：实现后必须执行 `youdoo-sites build sd2`、`youdoo-sites restart sd2`，并从公网验证 `/api/config`、目标页面和新生成任务状态。

## 3. 验收/审查内容

这些审查项需要创建独立子 agent 做只读审查；审查 agent 不改文件、不提交、不补实现，只判断是否达标、证据是否充分、风险是否遗漏，并输出“通过 / 不通过、证据、缺口、风险、下一步”。

- [ ] R1. 链路耗时验收
  - 检查对象：新建任务的数据库时间字段、交付队列表、稳定下载 URL。
  - 通过标准：至少 3 个新任务能记录 submit->provider、provider->delivery、submit->delivery；未做付费真生成时，必须用模拟 Provider 回调和本地假视频完成链路验证。
  - 证据来源：只读 SQL 查询、worker 日志、API 响应。

- [ ] R2. 回调与幂等验收
  - 检查对象：回调 API、任务状态更新、点数结算、队列入队逻辑。
  - 通过标准：重复回调不会重复扣点、不会重复入队、不会覆盖已完成稳定 URL；非法签名或缺密钥请求被拒绝且不泄露敏感信息；外部调用方原 callback 被记录并按设计转发或明确留痕失败。
  - 证据来源：单测、模拟回调请求、数据库只读检查。

- [ ] R3. 交付 worker 验收
  - 检查对象：队列 claim/lock/retry、Provider URL 刷新、R2/TOS 上传、失败重试。
  - 通过标准：worker 重启后任务仍能继续；单任务失败会记录错误并重试；成功任务写入稳定 URL；视频交付不再依赖状态页被用户打开；线上部署后能证明 worker 被 launchd/youdoo-sites 或等价进程管理实际拉起。
  - 证据来源：worker 测试、日志、只读 SQL、稳定 URL HEAD/GET、进程/健康检查输出。

- [ ] R4. 性能和资源验收
  - 检查对象：视频下载/上传实现。
  - 通过标准：主交付路径不使用整文件 `readFile` 再上传大视频；状态查询接口不做长时间文件下载；大文件传输有超时、重试和错误提示。
  - 证据来源：代码审查、构建结果、模拟大文件测试。

- [ ] R5. 用户体验验收
  - 检查对象：资产页、任务列表、下载入口、错误提示。
  - 通过标准：用户能看懂当前是生成中还是稳定下载准备中；下载未就绪时有明确状态和可重试动作；稳定 URL 准备好后刷新仍可下载。
  - 证据来源：APP 内置浏览器或 Playwright 截图、API 响应、刷新后复查。

- [x] R6. 线上部署验收
  - 检查对象：`sd2.youdoodesign.com` 线上实例。
  - 通过标准：`youdoo-sites build sd2`、`youdoo-sites restart sd2` 成功；公网 `/api/config` 正常；新构建已加载；跨一个健康守护周期服务稳定；worker 进程和日志也必须在同一轮验收里通过。
  - 证据来源：`youdoo-sites status sd2`、本地和公网 `curl`、构建 ID、目标页面刷新。

- [ ] R7. 独立只读子 agent 审查
  - 检查对象：本计划涉及的 schema、API、worker、UI、脚本和验证证据。
  - 通过标准：子 agent 明确输出通过/不通过、证据、缺口、风险、下一步；不得修改文件、不得提交、不得补实现。
  - 证据来源：子 agent 审查回执。若子 agent 工具不可用，由主线程按同一清单只读复查并标明“非独立审查，可信度低于子 agent”。

- [ ] R8. 现有功能回归验收
  - 检查对象：普通生成、IP 生成、视频超分增强、资产管理列表、任务详情播放、手动下载、批量下载、历史补偿脚本。
  - 通过标准：未进入新交付队列的旧任务仍能按原 fallback 播放/下载；IP 和超分任务不被普通 Seedance 回调/队列错误接管；资产管理不会因为交付状态字段缺失而报错或误显示失败；`/api/video/download/[id]` 和任何新增下载准备接口都保留登录与任务可见性校验。
  - 证据来源：`rg` 调用点清单、单测或脚本 smoke、APP 内置浏览器刷新资产页和任务详情页。

- [ ] R9. 账务和审计回归验收
  - 检查对象：`settleTask`、`CreditLedger`、`CostLedger`、`ProviderApiRequest`、`OperationLog`。
  - 通过标准：回调、轮询、补偿、手动刷新多路径同时触发时，任务只结算一次；Provider 成本记录不重复；失败/取消退款逻辑不变；最终采用的回调地址和交付任务状态可追溯。
  - 证据来源：重复回调测试、重复刷新测试、只读 SQL、日志脱敏检查。

## 4. 审查内容是否对齐目标

- [ ] A1. 审查是否证明“稳定下载就绪”，而不是只证明“任务成功”
  - 判断：R1/R3/R5 必须看到稳定公网 URL 写入和可访问，不能只看 Provider 返回成功。

- [ ] A2. 审查是否覆盖平均时长和长尾时长
  - 判断：验收必须同时看平均值、P50、P90 和缺失数，避免只挑一个跑得快的样例。

- [ ] A3. 审查是否避免过度工程
  - 判断：当前 Mac/SQLite 阶段不得为了优化引入 Redis/BullMQ；除非已经进入 server/PostgreSQL 迁移并确认基础设施。

- [ ] A4. 审查是否保护账务、权限和敏感信息
  - 判断：回调、下载、重试、日志和错误提示不能重复扣点、不能越权看他人任务、不能打印 token/cookie/API key。

- [ ] A5. 停止条件
  - 判断：如果 Provider 回调 payload 或签名规则无法确认、R2/TOS 流式上传接口不兼容、schema 变更存在数据风险、SQLite 备份未完成、真实付费生成未授权，暂停在模拟链路和只读验证，不冒进消耗或部署。

- [ ] A6. 审查是否覆盖非目标功能
  - 判断：R8/R9 必须证明 IP 生成、视频超分、资产页、旧任务播放下载、批量下载和账务结算没有被本次优化误伤；如果证据不足，不能上线。

## 5. 2026-08-11 落地执行记录

- [x] 代码落地：普通 Seedance 任务新增系统回调、稳定下载队列、流式上传、后台 worker、状态/下载 API、资产页和任务详情页状态提示。
- [x] 旧链路保护：IP 生成和视频超分不进入普通 fast-path；非 fast-path 状态查询继续保留本地缓存和缩略图旧兜底。
- [x] 安全边界：回调缺密钥 fail-closed；任务创建前预检回调配置，缺密钥不创建任务、不冻结点数；下载接口继续执行登录和任务可见性校验。
- [x] 数据库保护：迁移前已备份 SQLite 到 `/Volumes/Data/Backups/sd2-db/sd2-dev-before-video-delivery-20260811-200457.db`；本次只新增 nullable 字段和 `VideoDeliveryJob` 队列表。
- [x] 运维落地：新增 `video:deliver-public` worker 命令；本机 LaunchAgent `com.youdoo.sd2.video-delivery-worker` 已启动，15 秒一轮，每批最多 3 个任务。
- [x] 观测与补偿：新增 `video:delivery-metrics`；`video:delivery-backfill --queue` 默认 dry-run，最近 7 天 dry-run 发现 3 个缺稳定 URL 的成功任务。
- [x] 本地验证：`video-delivery-fast-path smoke`、`video-delivery-queue smoke`、`provider-status-router smoke`、`task-finalizer-terminal-guard smoke`、`check-video-public-delivery-rules`、`npm run lint`、`npm run build` 均通过；lint/build 只剩项目既有 `<img>` 和 hook warning。
- [x] 独立只读审查：子 agent 复审通过，上线阻塞项为无；批量下载 public URL 缺显式 timeout 被标为 P2，不阻塞本次上线。
- [x] 真实回填修正：R2 未知长度视频流上传已改为先落临时文件拿到 `ContentLength` 再上传；worker 增加 5 分钟硬超时、`--once` 退出保护、Provider 签名结果 URL 转存前刷新、stale worker 写回保护。
- [x] 真实回填证据：最近 7 天 3 个缺稳定 URL 的成功任务中，2 个已补齐稳定 URL；1 个任务 `cmsogtwfb026d145ryfzx922r` 刷新 Provider 地址后仍在 R2 转存阶段 5 分钟超时，已进入 `failed`，不会继续卡住队列。
- [x] 最新指标：`npm run video:delivery-metrics -- --days 7` 显示 `stable_download_ready=137`、`missing_stable_download=1`、`queued_to_delivery.count=3`、`delivery_start_to_finish.p50_seconds=309`；当前缺口是 R2 传输能力/链路限制，不是页面状态未刷新。
- [x] 线上闭环：提交 `29eaffd50f55fede00889a9d1757a3a49b4bc6cf` 已推送到 `origin/codex/video-delivery-fast-path`；`youdoo-sites build sd2` 生成生产 BUILD_ID `XEWKlOy84beCz0KEQfa8s`；`youdoo-sites restart sd2` 成功；本地 `/api/config`、公网 `/api/config`、公网 `/login` 均 200；公网 `/assets` HTML 命中新 BUILD_ID 和“资产管理/选择/超分”入口；跨健康守护周期后 sd2 `runs=25` 未增长，worker LaunchAgent `last exit code=0`。


## 6. 2026-08-13 最优解二阶段规划：生成完成后统一媒体入库

### 6.1 大白话目标复述

这次要解决的是“生成完以后还要等很久才能稳定预览、截图、下载”的问题。最优解不是重做生成系统，而是把所有入口统一到一条媒体交付流水线：普通生成页、外部 API、无线画布、后台任务，只要生成出视频，都进入同一个 `VideoTask -> 媒体入库 job -> 本地保存 / 对象存储 / 截图 / 下载地址` 链路。

本阶段不做真实付费生成压测，先做无消耗的代码、模拟视频、回调、worker、下载接口和页面状态闭环。真正能压缩的时间是：发现 provider 已完成的等待、生成后重复下载/转存的等待、截图阻塞、下载接口服务器中转。

Ponytail 约束：不引入 Redis/BullMQ，不重建队列系统，不改点数结算主链路；先复用现有 SQLite 队列、Provider 回调、`public_video_url`、`local_video_path`、`thumbnail`、`delivery_stage`。

### 6.2 实施任务

- [x] F0. 锁定真实改动面和不可碰边界
  - 修改范围：`src/app/api/video/**`、`src/lib/video/**`、`src/lib/assets/public-storage.ts`、生成结果相关前端组件、相关 smoke scripts。
  - 不改范围：点数定价、扣点结算规则、Provider 下单参数、用户权限模型、IP 生成和视频超分业务逻辑。
  - 完成标准：列出 `create -> status -> callback -> delivery worker -> play/download -> thumbnail` 的当前调用点，确认普通生成页、外部 API、无线画布最终都落到同一个 `VideoTask`。

- [x] F1. 下载接口改成最快路径
  - 目标：`/api/video/download/[id]` 在已有 `public_video_url` 时，不再由 Next 服务先 `fetch` 整个视频再转发。
  - 做法：保留登录态和 `assertCanViewTask` 权限校验；校验通过后对公开视频走 302 跳转，或生成短期签名 URL 后跳转；本地文件仍保留现有流式下载兜底。
  - 完成标准：公开视频下载不占用 Node 长连接和带宽；本地文件下载仍带正确文件名；无权限用户仍不能下载他人视频。

- [x] F2. 状态接口明确返回“可预览”和“可稳定下载”
  - 目标：用户不要把“生成成功”误认为“稳定下载已完成”。
  - 做法：复用并补齐 `delivery_stage`、`preview_available`、`stable_download_ready`；必要时新增 `play_url`、`download_url`、`thumbnail_url`、`retry_after_ms`，供网页、外部 API、无线画布统一使用。
  - 完成标准：provider 已有结果 URL 时页面可先预览；`public_video_url` 未准备好时下载按钮显示准备中/可重试；外部 API 能按字段判断下一步，而不是猜状态。

- [x] F3. 建立“一次下载，多处产出”的媒体入库 job
  - 目标：同一个 MP4 不要为了本地保存、对象存储、截图被重复拉取。
  - 做法：新增或重构 `src/lib/video/media-ingest.ts`：刷新 provider 结果 URL -> 下载到受控临时文件 -> 校验文件大小和 mp4 可读性 -> 原子移动到 `public/videos` -> 用同一文件上传对象存储 -> 用同一文件抽缩略图 -> 最后一次性写回任务字段。
  - 完成标准：一个 job 成功后同时得到 `local_video_path`、`public_video_url`、`thumbnail_path` 或明确的分项失败状态；中途失败不会留下 0B 文件或半成品 URL。

- [x] F4. worker 改为主交付入口，状态页只做唤醒和兜底
  - 目标：视频交付不能依赖用户打开状态页或刷新页面。
  - 做法：provider 回调成功后立即入队；状态接口发现成功但未入队时只补入队；worker 负责媒体入库和重试。
  - 完成标准：新任务即使没人打开页面，也会自动进入本地保存、对象存储和截图流程；重复回调、重复刷新不会产生多个有效 job。

- [x] F5. 回调优先，轮询兜底，轮询不要假勤奋
  - 目标：尽量接近 provider 真实完成时间，但不刷爆 provider。
  - 做法：确认 `VIDEO_DELIVERY_CALLBACK_SECRET` 和公网回调 base URL；回调不可用时才走后台轮询；轮询改为前期较快、后期降频，并返回 `retry_after_ms` 给前端/外部调用方。
  - 完成标准：回调缺配置时下单前能给管理员明确错误或走明确兜底；轮询不会无上限频繁刷新；日志能看出任务是 callback 唤醒还是 polling 唤醒。

- [x] F6. 前端统一状态和按钮行为
  - 范围：生成页最近任务、资产管理生成片段、任务详情、无线画布视频节点、外部 API 文档/示例如有相关状态说明。
  - 做法：播放按钮只看 `preview_available`；下载按钮只看 `stable_download_ready` 或 `download_url`；截图缺失时显示“截图准备中/暂无截图”，不影响视频播放下载。
  - 完成标准：不再出现“生成成功但视频无法预览/下载没反应/截图空白却没有解释”的状态。

- [x] F7. 历史任务和老视频兜底不破坏
  - 目标：以前已经生成的视频不能因为新链路上线后无法下载。
  - 做法：下载和播放仍按 `public_video_url -> local_video_path -> result_video_url` 的兼容顺序处理；历史补偿脚本默认 dry-run，确认数量后再入队。
  - 完成标准：老任务可播放/可下载的继续可用；缺稳定 URL 的历史任务可批量补偿；补偿不覆盖已有稳定 URL。

- [x] F8. 指标和验收脚本补齐
  - 目标：以后能知道到底慢在 provider、发现完成、下载、上传、截图里的哪一步。
  - 做法：补齐指标脚本输出 `submit_to_provider`、`provider_to_ingest_start`、`ingest_start_to_local`、`ingest_start_to_public`、`ingest_start_to_thumbnail`、`submit_to_stable_download` 的平均值、P50、P90、失败数。
  - 完成标准：不用真实付费生成，也能用 mock job 和历史数据跑出可读报告；真实任务上线后同一脚本能继续使用。

- [x] F9. 无消耗测试闭环
  - 测试范围：下载接口 public URL 跳转、权限拒绝、队列幂等、回调重复、provider URL 过期刷新、媒体入库临时文件清理、截图生成失败不阻塞下载。
  - 建议命令：`npm run lint`、`npm run build`、现有 `video-delivery-* smoke`、新增或更新一个 media ingest smoke。
  - 完成标准：不做真实视频生成也能证明主链路逻辑；如要真实生成，必须另行明确授权消耗点数。

- [ ] F10. 部署和线上验证
  - 做法：代码验证通过后再 `youdoo-sites build sd2`、`youdoo-sites restart sd2`；验证公网 `/api/config`、目标页面、下载接口、worker 状态；跨一个健康守护周期复查。
  - 完成标准：公网页面加载新构建；worker 实际运行；下载接口行为和页面状态在真实浏览器里可见。
  - 当前状态：本地代码、smoke、lint、build 已通过；尚未做线上部署和真实生成，因为本阶段不消耗点数。

### 6.3 2026-08-13 落地记录

- [x] 下载最快路径：`/api/video/download/[id]` 在已有稳定公开视频时改为权限校验后 302 跳转，不再由 Next 服务整段中转。
- [x] 统一媒体入库：新增 `src/lib/video/media-ingest.ts`，普通 Seedance 视频成功后复用 `cacheTaskVideoToLocal` 只拉取一次，再用同一个本地 MP4 做对象存储上传和截图。
- [x] 稳定链接保护：入库前增加 `ffprobe` 本地 MP4 可读性校验；坏文件不会写入 `public_video_url`。
- [x] 状态接口补齐：`/api/video/status/[id]` 返回 `play_url`、`download_url`、`thumbnail_url`、`retry_after_ms`、`preview_available`、`stable_download_ready`，让网页、无线画布和外部 API 不再靠猜。
- [x] 前端轮询闭环：普通生成页、模板生成页、无线画布视频节点在 `succeeded` 后仍会按后端 `retry_after_ms` 继续等稳定下载，不重复创建任务。
- [x] 复审补洞：`/api/video/list` 已补交付字段；生成页/模板页刷新后会继续追 `succeeded-but-preparing`；状态页终态快路径不再反复查 Provider；坏 MP4 会删除并清 `local_video_path`；无线画布恢复旧节点不会提前暴露下载。
- [x] 指标脚本补齐：`video:delivery-metrics` 输出 provider 完成到入库开始、入库排队、入库到稳定下载、提交到稳定下载等分段，并明确没有独立时间戳的分段不输出假数字。
- [x] 无消耗验证：已通过 `thumbnail-pipeline-smoke`、`video-delivery-fast-path-smoke`、`video-delivery-queue-smoke`、`ultimate-canvas-video-card-workflow-smoke`、`provider-status-router-smoke`、`task-finalizer-terminal-guard-smoke`、`check-video-public-delivery-rules`、`enhance-video-create-route-smoke`、`npm run video:delivery-metrics -- --days 7`、`npx tsc --noEmit --pretty false`、`npm run lint`、`npm run build`。
- [x] 独立只读复审：子 agent 初审不通过后，主线程补齐 4 个闭环缺口；同一子 agent 复审通过，剩余为线上部署验证、真实付费生成未授权、服务器需有 `ffprobe/ffmpeg`、历史脏数据可后续清理。
- [ ] 线上验收：待部署后用公网页面和接口验证新构建、worker 运行、真实历史任务下载跳转和截图状态；不在本轮无授权消耗真实视频生成点数。

### 6.4 独立只读审查任务

这些审查项需要创建独立子 agent 做只读审查；审查 agent 不改文件、不提交、不补实现，只判断是否达标、证据是否充分、风险是否遗漏，并输出“通过 / 不通过、证据、缺口、风险、下一步”。如果子 agent 工具不可用，由主线程按同一清单只读复查，并标明“非独立审查，可信度低于子 agent”。

- [x] FR1. 目标对齐审查
  - 检查对象：本阶段所有改动和 API 返回字段。
  - 通过标准：所有入口最终都走统一 `VideoTask` 媒体入库链路；没有只修某个页面导致外部 API 或无线画布掉队。

- [x] FR2. 性能审查
  - 检查对象：下载接口、media ingest、worker。
  - 通过标准：公开视频下载不再经过服务器整段中转；主入库路径同一视频只下载一次；状态查询不做长时间文件下载。

- [x] FR3. 安全和账务审查
  - 检查对象：权限、点数、成本、日志。
  - 通过标准：下载仍有权限校验；重复回调/刷新不重复扣点；日志不打印 token、cookie、签名完整 URL 或 provider 密钥。

- [x] FR4. 旧任务回归审查
  - 检查对象：旧视频、IP 生成、视频超分、批量下载、手动下载。
  - 通过标准：非本次目标链路不被新 worker 错误接管；旧任务 fallback 仍可用。

- [ ] FR5. 线上闭环审查
  - 检查对象：生产构建、公网页面、worker、下载接口。
  - 通过标准：不是只看到 commit/build 通过，而是公网真实页面和接口已经加载新行为。

### 6.5 停止条件和特别注意

- Provider 回调签名规则、结果 URL 刷新规则不清楚时，先停在模拟链路，不做真实消耗。
- 发现会改动点数、结算、权限、Provider 下单参数时，停下来重新确认边界。
- R2/TOS 上传不能稳定支持大文件或未知 Content-Length 时，先走临时文件 + 明确超时，不做内存 buffer 大文件上传。
- 服务器磁盘空间不足、临时文件清理不可靠、worker 无进程管理时，不上线自动下载全部视频。
- 任何公网下载地址如果包含完整临时签名，不写入日志、文档或回执。
