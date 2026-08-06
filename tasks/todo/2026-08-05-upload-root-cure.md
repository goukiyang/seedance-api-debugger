# 上传链路根治收口

> **For Codex:** Use `${CODEX_HOME:-$HOME/.codex}/skills/executing-plans/SKILL.md` to implement this plan task-by-task.

**Goal:** 把 sd2 上传从“各页面功能”收口成一条可恢复、可定位、可验收的统一基础链路。

**Architecture:** 继续沿用当前已经建立的统一 Asset 上传层，不重写全站上传。普通图片和音频优先由本站 `/api/assets/upload` 直收并生成 `https://sd2.youdoodesign.com/uploads/...` 可访问链接；R2 只作为 CORS 验收通过后的加速层，不再作为小文件上传成功的必要条件；文件上传成功后，业务页面只用 `assetId` 挂载到参考图、图集、模板或反馈；大视频按独立直传或分块续传路径处理。

**Tech Stack:** Next.js 14 App Router、React 18、TypeScript、Prisma、SQLite、Cloudflare R2 S3 API、现有 `uploadFileAsAsset` / `uploadFileToHistory` helper。

---

## 1. 大白话目标复述

用户现在要的不是“某个按钮这次能上传”，而是以后上传不要反复坏。做到完成的标准是：用户在生成页、资产页、图集、模板、反馈里上传图片、视频或音频时，要么稳定成功，要么明确知道是文件不合规、网络中断、登录失效、存储配置问题，还是“文件已上传但加入当前页面失败”；后台也能直接看出卡在哪一段。

第一性原理判断：上传链路的本质是“把本地文件安全变成可复用的 Asset，再把 Asset 绑定到业务对象”。所以根治不是继续补单个报错，而是收口五件事：统一入口、本站直收兜底、R2 加速验收、业务挂载重试、后台阶段记录。

Ponytail 收口：不全量重写，不新引入上传平台，不先做复杂清理系统；先复用当前 Asset、`/uploads`、Prisma 和既有 smoke，把复发最高的缺口补齐。

## 2. 具体可执行任务

- [x] T1. 冻结当前上传入口基线，防止继续长出旧链路
  - 检查对象：`scripts/upload-entrypoint-inventory-smoke.ts`、`src/lib/http/file-upload.ts`、`src/app/api/assets/*upload*`、`src/components/**` 里所有上传入口。
  - 执行内容：跑入口盘点，确认用户可见上传入口只通过 `uploadFileAsAsset` / `uploadFileToHistory`；旧 multipart 只允许登录、外部工具代理或内部 raw fallback 这类明确例外。
  - 验证命令：`npx tsx scripts/upload-entrypoint-inventory-smoke.ts`、`npx tsx scripts/direct-upload-r2-smoke.ts`、`git diff --check`。
  - 完成标准：新增或修改入口时 smoke 能拦住直接 `FormData` 文件上传业务接口；例外列表有原因。

- [x] T2. 做 R2 CORS 开启验收门，不通过就继续关闭浏览器直传
  - 检查对象：`src/lib/assets/direct-upload.ts`、`src/app/api/assets/upload-ticket/route.ts`、R2 bucket CORS 配置、线上 `R2_DIRECT_UPLOAD_ENABLED`。
  - 执行内容：新增或完善只读 readiness smoke，安全检查 R2 配置是否齐全，不打印 `R2_SECRET_ACCESS_KEY`、签名 URL、uploadToken；用真实浏览器 PUT 小 PNG 验证 `PUT`、`Content-Type`、必要 headers 和公开访问。
  - 验收路径：先在后台确认 CORS 允许 `https://sd2.youdoodesign.com`；再临时开启直传；真实登录态上传小 PNG；最后确认 `/api/assets/upload-complete` 入库成功。
  - 完成标准：CORS 未通过时线上保持 `directUploadAvailable=false` 且稳定走 `/api/assets/upload-proxy`；CORS 通过后才允许开启 `R2_DIRECT_UPLOAD_ENABLED=true`。
  - 停止条件：需要读取、展示或复制密钥、cookie、完整签名 URL 时停止，改用安全摘要。
  - 2026-08-05 落地状态：代码侧已增加 `R2_DIRECT_UPLOAD_CORS_VERIFIED` 验收门；生产桶完成 CORS 后再打开该验收开关并做真实 PUT 验收。

- [x] T3. 补“上传成功但业务挂载失败”的恢复机制
  - 检查对象：`src/app/collections/[id]/ReferenceAlbumDetailClient.tsx`、`src/components/UploadedImagePicker.tsx`、`src/lib/hooks/useWorkspace.ts`、`src/components/templates/TemplateBoundImagePicker.tsx`、`src/components/FeedbackWidget.tsx`、相关业务挂载 API。
  - 执行内容：每个页面先上传成 Asset；如果后续加入图集、加入当前参考图、绑定模板卡片或提交反馈失败，前端保留本轮已上传的 `assetId`，显示“素材已上传成功，加入当前页面失败，可重试”，重试时只调用业务 JSON 挂载接口，不重新上传文件。
  - 最小实现：先用页面状态或 `sessionStorage` 保存本轮待挂载 assetId；暂不新增数据库表。刷新后用户仍可从历史上传里选回该 Asset。
  - 验证命令：新增/更新对应 smoke，例如图集挂载失败、模板绑定失败、反馈提交失败、工作区加入失败；再跑 `npx tsx scripts/reference-media-chain-smoke.ts` 和入口盘点 smoke。
  - 完成标准：人为让业务挂载接口返回 500 时，页面不说“上传失败”，也不要求用户重传文件。
  - 2026-08-05 落地状态：工作区、上传历史弹窗、模板绑定和反馈都已保留上传后的 assetId；挂载/提交失败时可只重试业务动作，不重新上传文件。

- [x] T4. 上传阶段后台可观测，10 秒内判断卡在哪
  - 检查对象：`src/app/api/assets/upload-ticket/route.ts`、`src/app/api/assets/upload-proxy/route.ts`、`src/app/api/assets/upload-complete/route.ts`、`src/app/api/assets/upload/route.ts`、`prisma/schema.prisma` 的 `OperationLog` / `ContentAuditLog`。
  - 执行内容：优先复用现有 `OperationLog` 或 `ContentAuditLog` 记录安全摘要；只记录阶段、用户 id、assetId、mime、文件大小、耗时、错误码、是否复用、是否挂载成功。
  - 不记录内容：签名 URL、uploadToken、cookie、手机号、头像 URL、完整公开资源 URL、用户本机路径。
  - 后台入口：管理员能按最近上传失败查看阶段：ticket / storage-put / proxy / complete / raw / mount。
  - 验证命令：补上传日志 smoke，构造失败响应后查询日志摘要；同时验证日志里不含 token/url 敏感字段。
  - 完成标准：用户说“上传失败”时，后台能区分是传输失败还是挂载失败。

- [x] T5. 大文件分块/断点续传，只对需要的文件启用
  - 检查对象：`SITE_UPLOAD_MAX_SIZE_BY_KIND` 当前图片 30MB、视频 200MB、音频 15MB；`src/lib/assets/direct-upload.ts` 当前是单次 PUT / proxy。
  - 执行内容：只对大文件启用 multipart，建议触发线为视频 `>50MB` 或服务端中转连续出现 `aborted/timeout`；小图片和小音频继续走现有简单链路。
  - 后端最小接口：
    - `POST /api/assets/multipart/start`：登录校验、文件元数据校验、创建 R2 multipart upload，返回 `uploadId`、key 和分片大小。
    - `POST /api/assets/multipart/sign-part`：签某个 part 的短期上传地址。
    - `POST /api/assets/multipart/complete`：校验 part 列表、完成 R2 合并、登记 Asset。
    - `POST /api/assets/multipart/abort`：用户取消或失败清理。
  - 前端最小行为：分片并发 2-3 个；断线后保留 `uploadId` 和已完成 part；重新上传只补失败 part；进度来自已传字节。
  - 验证命令：新增 multipart smoke，覆盖 start/sign/complete/abort、hash/大小不匹配、重复素材复用、失败重试不重传已完成 part。
  - 完成标准：大视频弱网失败后可以继续，不依赖一个长请求。
  - 2026-08-05 落地状态：代码侧已提供 multipart start/sign-part/complete/abort 和前端断点状态；真实弱网大视频验收需在 R2 CORS 验收开关打开后执行。

- [ ] T6. 全入口真实登录态验收矩阵
  - 检查入口：`/generate` 参考图和上传历史、`/assets` 图片/视频/音频、`/collections/:id` 多文件、模板绑定图片、反馈附件。
  - 每个入口至少覆盖：首次成功、重复素材复用、文件过大、类型不支持、未登录 JSON、传输中断文案、上传成功但挂载失败。
  - 验证方式：真实飞书登录态浏览器 + 公网 `https://sd2.youdoodesign.com`；必要时每个入口只用 1 个小文件，测试素材用 UI/API 隐藏或登记为 smoke，不批量污染数据。
  - 完成标准：页面刷新后结果仍在；重复上传显示成功复用；失败提示能指导下一步；后台日志能对应到阶段。

- [ ] T7. 部署、版本和回滚收口
  - 执行内容：所有代码完成后跑 `npm run lint`、相关 smoke、`npm run build` 或 `youdoo-sites build sd2`；部署只用 `/Users/gouki-youdoo/.youdoo/bin/youdoo-sites build sd2` 和 `restart sd2`。
  - 线上验证：`youdoo-sites status sd2`、本地 `/api/config`、公网 `/api/config`、公网 `/login`、目标入口页面、健康周期后 `runs` 不增长。
  - Git：聚焦提交，push 当前分支；创建修复前 rollback tag；登记 `/Volumes/Data/Projects/project-version-registry.md`。
  - 完成标准：明确区分本地、Git、线上、真实页面验收，不把其中一层冒充另一层。

## 3. 验收/审查内容

这些审查项需要创建独立子 agent 做只读审查；审查 agent 不改文件、不提交、不补实现，只判断是否达标、证据是否充分、风险是否遗漏，并输出“通过 / 不通过、证据、缺口、风险、下一步”。

- [ ] R1. 独立只读审查：入口统一性
  - 检查对象：所有用户可见上传入口和 `scripts/upload-entrypoint-inventory-smoke.ts`。
  - 通过标准：业务页面不直接接收文件本体作为主路径；所有例外有白名单和理由。
  - 证据来源：源码、入口盘点输出、相关 smoke。

- [ ] R2. 独立只读审查：R2 直传开启条件
  - 检查对象：R2 CORS 验收记录、直传开关、真实浏览器 PUT 结果、`upload-ticket` 返回。
  - 通过标准：CORS 未验收不得开启直传；开启后真实 PUT 成功，失败会自动回到同源中转。
  - 证据来源：配置摘要、浏览器网络结果、公网接口响应、后台日志。

- [ ] R3. 独立只读审查：挂载失败可恢复
  - 检查对象：图集、生成页、模板、反馈的“上传成功但挂载失败”场景。
  - 通过标准：页面保留 assetId 并允许只重试挂载；不会要求重新上传同一文件。
  - 证据来源：失败注入 smoke、真实页面截图/DOM、后台 Asset 记录。

- [ ] R4. 独立只读审查：大文件策略
  - 检查对象：视频大文件上传路径、multipart 接口、断点续传状态、取消清理。
  - 通过标准：大文件不依赖一个长请求；弱网失败后只补失败分片；小文件不被复杂链路拖慢。
  - 证据来源：multipart smoke、真实或本地大文件测试、R2 对象清理记录。

- [ ] R5. 独立只读审查：错误提示和后台可观测
  - 检查对象：用户错误文案、后台上传日志、敏感字段保护。
  - 通过标准：不出现 `Unexpected token '<'`、裸 HTML、裸 `Internal server error`；后台能定位阶段；日志不泄露 token/签名 URL/cookie。
  - 证据来源：错误场景 smoke、后台日志摘要、代码扫描。

- [ ] R6. 独立只读审查：真实登录态全入口
  - 检查对象：`/generate`、`/assets`、图集、模板、反馈。
  - 通过标准：每个入口完成成功、重复复用、不合规失败、刷新保留；不能用未登录 401 或静态页面代替真实登录态验收。
  - 证据来源：浏览器 DOM/截图、API 响应、后台 Asset/OperationLog 记录。

## 4. 审查内容是否对齐目标

- [ ] A1. 审查是否围绕“上传基础设施根治”，而不是只证明某个按钮可用。
  - 判断：R1-R6 覆盖统一入口、传输、挂载、日志、真实页面和大文件，不只看单条成功路径。

- [ ] A2. 审查是否区分文件上传成功和业务挂载成功。
  - 判断：只要 Asset 已创建但业务绑定失败，就必须按挂载失败处理，不能归类为上传失败。

- [ ] A3. 审查是否区分止血和根治。
  - 判断：延长超时、中文文案、服务端中转只算止血；R2 直传、分块续传、挂载重试、后台阶段记录才算根治闭环。

- [ ] A4. 审查是否保护用户和系统安全。
  - 判断：不泄露密钥、cookie、签名 URL、uploadToken；不批量污染生产素材；不自动 force push；不在 CORS 未验收时打开直传。

- [ ] A5. 审查是否保留最短可落地路径。
  - 判断：小文件继续走当前简单链路；只给大文件上分块；不引入新上传平台或大依赖，除非现有 R2 S3 API 无法满足。

---

## 5. 2026-08-06 修订：本站直收优先闭环

### 5.1 大白话目标复述

这次要解决的核心不是“再把 R2 配好一点”，而是让普通用户上传小图片、小音频时，不再被 R2、CORS、服务端代理超时这些外部环节拖住。最优路径调整为：本站服务端先把文件稳稳收下，生成一个 `https://sd2.youdoodesign.com/uploads/...` 的可访问链接；R2 只作为后续加速层，在 CORS 真的验收通过后再启用。

做到完成的标准是：同事那种 1.6MB 图片不应该再提示“文件较大、请压缩”；小图和小音频在 R2 未开启时也能直接上传成功；上传历史里的旧 `/uploads/...` 素材、自动压缩后的参考图、生成任务引用本地素材时，都不再偷偷走回 R2；大视频如果暂时仍依赖 R2 或分块上传，要给出明确边界，不再混在普通图片上传错误里。

### 5.2 本轮不做什么

- 不引入新上传平台或新大依赖；先复用当前 Next.js API、Asset 表、`/uploads` 静态读取和现有 smoke。
- 不在没有 CORS 验收证据时打开 R2 浏览器直传开关。
- 不做付费真实生成；生成页验收只验证素材能上传、能引用、能提交到创建前校验链路，付费 Provider 创建需另行授权。
- 不把大视频彻底 CDN 化；本轮先把边界讲清并给出稳定路径，后续再按视频大文件专项做续传/直传验收。

### 5.3 具体可执行任务

- [ ] T8. 上传策略改成“本站直收先成功，R2 只做加速”
  - 修改对象：`src/lib/http/file-upload.ts`、`scripts/direct-upload-r2-smoke.ts`。
  - 执行内容：当 upload ticket 返回 `directUploadAvailable=false` 且文件类型支持 raw fallback 时，前端直接走 `/api/assets/upload`，不要再先尝试 `/api/assets/upload-proxy`。`upload-proxy` 只保留给明确需要 R2 且当前文件不能 raw fallback 的路径。
  - 验证命令：`npx tsx scripts/direct-upload-r2-smoke.ts`。
  - 完成标准：R2 CORS 未验证时，小图片和小音频请求顺序是 `upload-ticket -> /api/assets/upload`；不出现“先等 proxy 失败，再回退 raw”的 15-60 秒延迟。

- [ ] T9. 本站 `/uploads` 链接归一化，避免硬编码成 R2
  - 修改对象：`src/lib/assets/site-upload.ts`、`src/lib/assets/direct-upload.ts`。
  - 执行内容：把 local-public helper 限制到 `/uploads/`，不要把任意 `/xxx` 都当成本地公开资源；Asset payload 根据真实 URL 判断 `storageProvider`，不要把复用素材统一写成 `r2`。
  - 验证命令：补或更新 `npx tsx scripts/direct-upload-r2-smoke.ts` 中的复用素材断言。
  - 完成标准：`/uploads/...` 返回 `local-public`，R2 URL 才返回 `r2`；重复素材直接复用同一个后台链接并显示上传成功。

- [ ] T10. 生成任务引用历史本地素材时不再重新上传 R2
  - 修改对象：`src/app/api/tasks/create/route.ts`、`src/app/api/ip/tasks/create/route.ts`。
  - 执行内容：把本地 `/uploads/...` 图片、视频、音频统一转换成同源公网 URL；生成任务只使用这个可访问链接，不再在创建任务阶段调用 `uploadPublicAsset` 去补传 R2。
  - 验证命令：`npx tsx scripts/reference-media-chain-smoke.ts`，并补充本地 `/uploads` 历史素材场景。
  - 完成标准：选择上传历史里的本地素材生成时，不出现“R2 上传失败”导致提交失败。

- [ ] T11. 自动压缩后的参考图走本站公开链接
  - 修改对象：`src/lib/provider/reference-image-safety.ts`。
  - 执行内容：图片过大自动压缩成功后，优先写入本站上传目录并返回 `https://sd2.youdoodesign.com/uploads/...`；R2 只作为可用时的加速上传，不作为压缩成功后的必要条件。
  - 验证命令：新增或扩展 reference safety smoke，覆盖“原图过大 -> 自动压缩 -> 生成可访问 local-public URL”。
  - 完成标准：用户素材不合规时，系统能先自动处理；自动处理失败才明确说“图片大小/尺寸问题”，不再显示“服务响应格式错误”。

- [ ] T12. 历史 `/uploads` 资产做可回滚 backfill
  - 修改对象：新增脚本 `scripts/backfill-local-upload-asset-urls.ts`，必要时只更新任务文档记录。
  - 执行内容：先 dry-run 统计 `Asset.original_url` 以 `/uploads/` 开头的有效记录，确认本地文件存在后，把它们改成 `https://sd2.youdoodesign.com/uploads/...`；执行前备份 SQLite，执行后输出更新/跳过/缺失数量。
  - 验证命令：`npx tsx scripts/backfill-local-upload-asset-urls.ts --dry-run`；真正执行需先确认数据库备份路径。
  - 停止条件：未拿到备份、发现同一条记录疑似跨用户污染、或脚本会改非 `/uploads/` URL 时停止。
  - 完成标准：历史上传图片能直接复用，不需要重新上传，也不会因 R2 不可用失败。

- [ ] T13. 清理旧 multipart/formData 风险入口
  - 修改对象：`src/app/api/assets/upload/route.ts`、`src/app/api/codex/assets/upload/route.ts`、`src/app/api/tools/ultimate-canvas/upload/route.ts`。
  - 执行内容：保留兼容入口，但大文件不要再走 `request.formData()` + `arrayBuffer()` 的旧解析方式；能走 raw helper 的统一走 raw helper，不能走的提前返回 JSON 错误。
  - 验证命令：构造非法 multipart、大于限制文件、未登录请求，确认响应都是 JSON，不返回 HTML。
  - 完成标准：不再复发 `Unexpected token '<'`、`<!DOCTYPE ... is not valid JSON` 这类“页面内容当 JSON 解析”的错误。

- [ ] T14. 视频上传边界单独定清楚
  - 修改对象：`src/lib/http/file-upload.ts`、`src/lib/assets/direct-upload.ts`、视频上传入口相关 smoke。
  - 执行内容：视频大文件不要复用图片/音频 raw fallback 文案；R2 CORS 未验证时，明确提示“当前视频大文件需要管理员开启 R2 CORS 或使用分块上传验收路径”，不要说用户文件太大。
  - 验证命令：用小视频和超出 raw fallback 的视频各跑一次上传入口 smoke。
  - 完成标准：图片、音频、视频三类失败原因分开；视频问题不会再污染普通图片上传判断。

- [ ] T15. 后台上传日志补“是否跳过 proxy / 是否 local-public”
  - 修改对象：`src/lib/assets/upload-log.ts` 及相关上传 API 调用点。
  - 执行内容：日志里增加安全摘要字段：`storageProvider`、`fallbackPath`、`skippedProxy`、`durationMs`、`assetId`、`fileKind`。不记录签名 URL、token、cookie、完整本机路径。
  - 验证命令：上传成功、raw 失败、重复复用各跑一次，检查 OperationLog 或上传日志摘要。
  - 完成标准：用户反馈“上传卡住”时，后台能在 10 秒内判断是 ticket、raw、proxy、complete、mount 还是外部 R2 问题。

- [ ] T16. 全链路验证、部署和固定审核线程审查
  - 修改对象：不固定，跟随 T8-T15 实际改动。
  - 验证命令：`npx tsx scripts/direct-upload-r2-smoke.ts`、`npx tsx scripts/reference-media-chain-smoke.ts`、`npx tsc --noEmit`、`npm run lint`、`npm run build`、`git diff --check`。
  - 线上验证：`/Users/gouki-youdoo/.youdoo/bin/youdoo-sites build sd2`、`restart sd2`、`status sd2`，再验证公网 `/api/config`、`/login` 和 `/generate` 上传入口；真实上传矩阵至少包含 1-2MB 图片、接近 30MB 图片、小音频、重复素材复用。
  - Git：聚焦 commit、push 当前分支，必要时登记 `/Volumes/Data/Projects/project-version-registry.md`。
  - 审核：发给固定审核线程 `审核001 - sd2 固定只读审查`，只读审查本轮 diff、测试证据、线上行为和风险。
  - 完成标准：本地、Git、线上、真实页面、独立审查五层都闭环；任一层没完成时不能说“彻底修好”。

### 5.4 验收/审查内容

这些审查项必须由固定审核线程或独立只读子 agent 执行；审查 agent 不改文件、不提交、不补实现，只输出“通过 / 不通过、证据、缺口、风险、下一步”。如果当轮工具不可用，由主线程按同一清单只读复查并明确标注“非独立审查，可信度低于子 agent”。

- [ ] R7. 审查 R2 未验证时，小图和小音频是否完全绕过 proxy-first 延迟。
  - 证据来源：`direct-upload-r2-smoke`、浏览器 Network、上传日志。
  - 通过标准：没有先请求 `/api/assets/upload-proxy` 再失败回退 raw 的路径。

- [ ] R8. 审查历史素材和重复素材是否复用同一个后台链接。
  - 证据来源：Asset 记录、生成页上传历史、重复上传 smoke。
  - 通过标准：重复素材显示成功，使用原有 Asset/URL，不要求当前账号重新上传同一份文件。

- [ ] R9. 审查生成任务是否还存在本地素材转 R2 的隐性依赖。
  - 证据来源：`tasks/create`、`ip/tasks/create` 源码和 reference media smoke。
  - 通过标准：本地 `/uploads` 素材进入生成 payload 时已经是同源公网 URL，不调用 R2 补传作为必要步骤。

- [ ] R10. 审查错误提示是否按真实原因分层。
  - 证据来源：用户可见文案、失败场景 smoke、后台日志。
  - 通过标准：小图片网络/服务端中断不再提示“文件较大请压缩”；图片真实超限时先自动压缩，失败才说大小/尺寸问题；服务返回 HTML 时给出登录/服务端页面响应原因。

- [ ] R11. 审查日志是否足以定位复发风险且不泄露敏感信息。
  - 证据来源：上传日志摘要、代码扫描。
  - 通过标准：能区分 ticket/raw/proxy/complete/mount；不含 token、cookie、签名 URL、完整本机路径。

- [ ] R12. 审查视频上传边界是否明确。
  - 证据来源：视频入口 smoke、文案、R2 CORS readiness 结果。
  - 通过标准：视频没有假装可走图片 raw fallback；大视频方案和普通图片上传问题分开。

### 5.5 审查内容是否对齐目标

- [ ] A6. 审查是否真的解决“1.6MB 图片也上传失败”的主问题。
  - 判断：验收必须包含 1-2MB 图片、接近 30MB 图片、小音频、重复素材，不能只用空接口测试。

- [ ] A7. 审查是否把 R2 从必要路径降级为加速路径。
  - 判断：R2 CORS 关闭时，小文件仍能成功；R2 成功时只是更快，不影响基础上传可用性。

- [ ] A8. 审查是否覆盖“上传成功但生成/挂载失败”的断点。
  - 判断：Asset 创建成功后，后续业务绑定失败必须能重试挂载，不能让用户重新传文件。

- [ ] A9. 审查是否避免过度工程。
  - 判断：没有新平台、没有大依赖、没有重写全站上传；只在真实复发点补统一策略和测试。

- [ ] A10. 审查是否清楚标出未完成边界。
  - 判断：大视频、R2 CORS、付费真实生成、数据库 backfill 执行，都要有独立确认或验收证据，不能和小图片上传修复混在一起宣布完成。
