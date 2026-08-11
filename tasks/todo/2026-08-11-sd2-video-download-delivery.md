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

- [ ] T0. 先锁定不影响其他功能的实施边界
  - 范围：首期只处理普通 Seedance 视频任务：`provider = seedance`，且不包含 `generation_mode = enhance_video`，不包含 `provider = volcengine_mediakit`，不包含 IP 生成入口。
  - 要做：实施前列出所有调用 `startTaskLocalization`、`finalizeVideoTaskStatus`、`cacheTaskVideoToLocal`、`ensurePublicVideoDelivery` 的入口，并标注“普通生成 / IP 生成 / 超分增强 / 批量下载 / 历史补偿”。
  - 完成标准：普通 Seedance 新交付链路先独立上线；IP 生成、视频超分、批量下载、手动下载、旧任务播放继续走现有兼容路径，除非后续单独开任务迁移。

- [ ] T1. 补全耗时观测字段和基线脚本
  - 范围：`prisma/schema.prisma`、`src/lib/video/**`、`scripts/**`。
  - 要做：明确记录 `提交时间`、`Provider 完成时间`、`稳定下载入队时间`、`下载开始时间`、`下载完成时间`、`交付状态`、`重试次数`、`最后错误`。
  - 保护：schema 只做向后兼容的 nullable/additive 变更；迁移前备份 SQLite；先用 dry-run 脚本查影响数量，不直接写历史数据。
  - 完成标准：能用只读脚本输出最近 24 小时、7 天的 submit->provider、provider->delivery、submit->delivery 的平均值、P50、P90 和缺失数；如修改 `prisma/schema.prisma`，同时确认 `schema-base.prisma` 是否需要同步或明确保持不动的原因。

- [ ] T2. 生成提交时固定写入系统回调地址
  - 范围：`src/app/api/tasks/create/route.ts`、Provider 适配相关文件。
  - 要做：任务创建时自动设置系统级回调地址，优先使用 `NEXT_PUBLIC_BASE_URL` 或服务端配置拼出固定回调地址；Provider 适配层继续使用当前项目已有字段名 `callback_url`，不要把外部文档里的大小写直接硬塞进业务层；用户传入的临时 callback 不能覆盖生产稳定链路。
  - 保护：系统回调和外部调用方传入的 callback 要分离保存；不能简单吞掉外部 callback。若 Codex/API 调用方依赖原 callback，系统回调完成后需要转发，或至少记录待转发失败状态。
  - 完成标准：新建普通 Seedance 任务请求 Provider 时一定带系统回调地址，并把最终采用的系统回调地址、外部 callback 记录写入任务参数或专用字段便于审计；缺配置时直接给管理员可理解错误，不静默退回慢轮询。

- [ ] T3. 新增 Provider 回调入口
  - 范围：建议新增 `src/app/api/provider/seedance/callback/route.ts` 或同等清晰路径。
  - 要做：接收 Provider 完成通知，校验来源或共享密钥，按 `provider_task_id/task_id` 幂等更新任务状态，并立即写入视频交付队列。回调 payload 如果字段不完整，只作为“唤醒信号”，再走一次 Provider 状态查询获取权威结果。
  - 保护：回调和轮询必须共用同一套“终态落库 + 点数结算 + Provider 成本记录”逻辑，优先从 `finalizeVideoTaskStatus` 抽出共享函数；禁止在 callback route 里另写一套结算。
  - 完成标准：同一个回调重复发送不会重复扣点、不会重复创建多个下载任务、不会把终态任务打回 running；接口应快速返回，不在回调请求里做大文件下载。

- [ ] T4. 建立 SQLite 持久化视频交付队列
  - 范围：`prisma/schema.prisma`、`src/lib/video/delivery-queue.ts`。
  - 要做：新增最小够用的队列表，包含任务 ID、状态、优先级、重试次数、下次执行时间、锁定时间、错误信息和完成时间；用唯一键或语义锁保证同一任务同一交付类型只存在一个有效 job。
  - 完成标准：重启服务后未完成的交付任务不会丢；同一视频只能有一个有效交付任务；失败后按退避策略重试；队列为空时不影响现有页面和接口响应。

- [ ] T5. 做独立 worker，把视频直接流式搬到稳定存储
  - 范围：`src/lib/video/public-delivery.ts`、`src/lib/assets/public-storage.ts`、建议新增 `scripts/process-video-delivery-jobs.ts`。
  - 要做：worker 从队列取任务，拿 Provider 结果 URL，遇到 403/过期先刷新结果 URL，然后把视频直接流式上传到 R2/TOS；避免先下载到本地再整文件读入内存再上传。
  - 保护：不要直接破坏现有 `uploadPublicAsset(buffer, ...)`，它还服务图片和素材上传；应新增视频专用 `uploadPublicVideoStream` 或同等 helper，保留原 buffer API 兼容。
  - 完成标准：成功后写入 `public_video_url/public_video_cached_at` 和交付耗时字段；失败时保存可读错误并可重试；单任务大文件不会把 Node 进程内存顶高；worker 有独立启动方式、日志位置、健康检查、卡死锁释放和部署后存活验证。

- [ ] T6. 降级现有本地缓存 runner 为兜底，不再当主链路
  - 范围：`src/lib/video/task-localization-runner.ts`、`src/app/api/video/status/[id]/route.ts`。
  - 要做：状态查询不再阻塞等待缓存/缩略图；发现 Provider 已完成但交付未入队时，只负责补入队或触发高优先级补偿。
  - 保护：保留 `finalize-pending-videos.ts`、手动 `/api/video/download/[id]`、批量下载和历史补偿脚本的旧能力；不要让旧任务因为没有新队列表记录而无法播放或下载。
  - 完成标准：用户打开资产页或状态页不会因为缓存下载卡住；刷新/轮询最多推动补偿，不承担主交付；旧任务仍可按 `public_video_url -> local_video_path -> result_video_url` fallback 播放。

- [ ] T7. 前端和 API 状态改成用户能理解的阶段
  - 范围：`src/app/api/video/status/[id]/route.ts`、`src/app/api/video/download/[id]/route.ts`、任务列表/资产管理/最近任务相关组件。
  - 要做：区分 `生成中`、`已生成，正在准备稳定下载`、`稳定下载已就绪`、`准备失败，可重试`。下载按钮优先使用稳定公网 URL；未就绪时允许用户触发高优先级准备。
  - 保护：状态展示只能新增交付状态，不能把 `local_status` 的业务含义改乱；资产页、任务页、最近任务里已有的成功/失败/超分标签不能被交付状态覆盖；新增或修改下载准备接口必须继续执行 `getSession` 和 `assertCanViewTask` 权限检查。
  - 完成标准：用户不会看到“生成成功但点下载没反应”；失败时能看到明确原因和重试入口；能明确区分“可预览”和“稳定下载已就绪”。

- [ ] T8. 补偿历史成功但未稳定缓存的视频
  - 范围：优先复用 `scripts/backfill-public-video-delivery.ts` 和队列 helper。
  - 要做：只读扫描历史成功任务，找出缺 `public_video_url/public_video_cached_at` 的任务；确认数量后再安全入队补偿。
  - 完成标准：不会覆盖已有稳定 URL；补偿脚本默认 dry-run，真实执行需要显式参数。

- [ ] T9. Server 迁移后的升级路径预留
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

- [ ] R6. 线上部署验收
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
