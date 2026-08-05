# 上传链路根治收口

> **For Codex:** Use `${CODEX_HOME:-$HOME/.codex}/skills/executing-plans/SKILL.md` to implement this plan task-by-task.

**Goal:** 把 sd2 上传从“各页面功能”收口成一条可恢复、可定位、可验收的统一基础链路。

**Architecture:** 继续沿用当前已经建立的统一 Asset 上传层，不重写全站上传。浏览器优先直传 R2，失败时走本站服务端中转；文件上传成功后，业务页面只用 `assetId` 挂载到参考图、图集、模板或反馈；大文件再升级分块续传。

**Tech Stack:** Next.js 14 App Router、React 18、TypeScript、Prisma、SQLite、Cloudflare R2 S3 API、现有 `uploadFileAsAsset` / `uploadFileToHistory` helper。

---

## 1. 大白话目标复述

用户现在要的不是“某个按钮这次能上传”，而是以后上传不要反复坏。做到完成的标准是：用户在生成页、资产页、图集、模板、反馈里上传图片、视频或音频时，要么稳定成功，要么明确知道是文件不合规、网络中断、登录失效、存储配置问题，还是“文件已上传但加入当前页面失败”；后台也能直接看出卡在哪一段。

第一性原理判断：上传链路的本质是“把本地文件安全变成可复用的 Asset，再把 Asset 绑定到业务对象”。所以根治不是继续补单个报错，而是收口五件事：统一入口、R2 直传、分块续传、业务挂载重试、后台阶段记录。

Ponytail 收口：不全量重写，不新引入上传平台，不先做复杂清理系统；先复用当前 Asset/R2/Prisma 基础，把复发最高的缺口补齐。

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
