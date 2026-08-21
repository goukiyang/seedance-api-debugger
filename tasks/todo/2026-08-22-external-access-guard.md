# 外部用户权限收口与风险闭环

> **For Codex:** 后续执行本计划时，先读取 `${CODEX_HOME:-$HOME/.codex}/skills/executing-plans/SKILL.md`，按任务逐项执行；涉及权限边界时同时使用 `defense-in-depth` 思路，不能只做前端隐藏。

**目标：** 外部用户只能使用授权范围内的 IP 生成、自己的任务、资产管理和参考图集；普通生成、模板、无线画布、旧全局 Seedance 资产接口、协作项目管理等能力必须从外部权限里收掉，同时内部用户原流程不受影响。

**推荐架构：** 先不引入重型权限框架，新增一个轻量统一的 feature guard，把 `SessionUser.account_type` 和现有 `isExternalUser()` 作为唯一角色判断入口。页面层负责“不显示/默认进 IP 生成”，接口层负责“直连也不能绕过”，测试层用一张外部访问矩阵防回归。

**技术栈：** Next.js 14 App Router、TypeScript、现有 `src/lib/auth/session.ts` / `src/lib/auth/api-helpers.ts`、Prisma、脚本 smoke test。

---

## 0. 本轮风险复核补充（2026-08-22）

这次复核后，计划需要额外补齐这些容易漏的口子：

- 不能只点名几个 API，要先建立“全 API 权限矩阵”。当前 `src/app/api` 下有大量路由，外部收口如果只改 `/api/tasks/create`、`/api/templates`、`/api/tools/ultimate-canvas`，仍可能漏掉 `/api/assets/generate`、`/api/tasks/enhance-video/create`、`/api/video/retry/[id]`、`/api/tasks/estimate`、`/api/workspace/**`、`/api/reference-*`、`/api/album-shares/**`、`/api/project-invites/**` 等边缘入口。
- “资产管理可用”不能等于“所有 assets API 都可用”。外部用户应允许普通素材上传、自己的资产库、参考图集所需接口；但 `旧全局 Seedance Asset`、`/api/assets/generate` 图片生成、`/api/assets/upload-and-create` 创建官方 Seedance asset 这类能力默认不属于外部开放范围，除非确认 IP 生成主链路必须依赖。
- “我的任务可见”不能等于“普通生成可复用/增强/重试可用”。外部可以看自己的历史任务和 IP 任务，但普通任务重试、增强视频生成、普通生成估价、模板复用、画布复用默认都要从外部权限里收掉。
- 任务列表/状态接口要做外部脱敏。外部即使能看自己的任务，也不应该看到内部模板名、`template_key`、`agent_run_id`、`selected_agent_plan_key`、`source_request_id`、provider task id、官方成本字段、内部存储 key 等内部结构字段，除非明确是用户需要看的业务字段。
- 公开接口要明确分类，不能“一刀切加登录”。`/api/provider/seedance/callback` 属于 provider 回调，应该继续走 token/secret 校验；`/api/health` 和 `/api/config` 应只返回最小公开健康信息；登录/注册/飞书 OAuth 相关接口不能被外部权限误挡。
- 外部账号识别要补一次只读数据核查。现有 `isExternalUser()` 会把无飞书身份的普通用户按外部处理，这是符合“邮箱登录属于外部”的规则，但落地前必须只读列出受影响账号数量，避免把历史内部邮箱测试账号误判后没人知道。
- 线上闭环要覆盖缓存和真实登录态。前端导航改动必须验证新 BUILD_ID、外部真实账号刷新后的 DOM、内部账号刷新后的 DOM；不能只看本地源码或匿名页面。

## 1. 大白话目标复述

这次不是再改几个导航按钮，而是把“外部人员进系统以后能做什么、不能做什么”收成一条稳定规则：

- 外部用户定义：非管理员，且 `account_type === 'external'`；兼容历史邮箱账号，没有飞书身份的普通用户也按外部处理，沿用现有 `src/lib/access/external-role.ts`。
- 外部可见/可用：`IP生成`、`资产管理`、`我的任务`、`参考图集管理`，以及这些页面完成 IP 授权视频生成所必须的素材选择、素材上传、任务查看、视频播放。
- 外部不可见/不可用：普通生成页、模板页、模板生成、动画模板、无线画布，以及能绕过页面直接调用的相关接口。
- 内部用户不变：飞书内部账号、管理员、已有内部普通用户继续看到原来的生成、模板、资产、IP生成、无线画布等完整工作流。
- 完成标准：外部用户刷新页面后看不到禁用入口；即使用接口直连，也拿不到模板/画布/普通生成/旧全局资产等能力；内部用户对应页面和接口仍正常。

## 2. 具体可执行任务

### P0：先堵能绕过页面的服务端接口

- [ ] T0. 建立全 API 权限矩阵，先分类再改代码
  - 文件：新建 `scripts/external-access-route-matrix-smoke.ts`，必要时配套新建 `src/lib/access/feature-guard.ts` 后由脚本读取。
  - 做法：扫描 `src/app/api/**/route.ts`，把每个路由分到四类：
    - `external_allowed`：外部允许，例如 IP 生成、自己的任务查看、自己的资产库、参考图集必要接口、上传必要接口、通知/个人点数/个人偏好。
    - `internal_only`：内部才允许，例如普通生成、模板、无线画布、图片生成、增强视频、旧 Seedance asset 管理、团队协作管理。
    - `admin_only`：后台、成本、用户、provider 配置、审核等后台接口。
    - `public_signed_or_minimal`：登录、注册、飞书 OAuth、provider callback、health/config 最小公开信息。
  - 完成标准：实现前先输出一张矩阵；任何未分类路由默认视为失败，不允许“漏了就算了”。

- [ ] T1. 新增统一 feature guard
  - 文件：新建 `src/lib/access/feature-guard.ts`
  - 做法：基于 `src/lib/access/external-role.ts` 的 `isExternalUser(user)`，提供 `assertFeatureAllowed(user, feature)` 和 `assertInternalOnly(user, message?)`。
  - 建议 feature key：
    - `standard_generate`
    - `ip_generate`
    - `template_view`
    - `template_generate`
    - `ultimate_canvas`
    - `legacy_seedance_assets`
    - `asset_library`
    - `reference_album`
    - `task_view`
    - `team_project_manage`
    - `asset_image_generate`
    - `video_enhance`
    - `task_retry`
    - `public_signed_callback`
  - 外部白名单：`ip_generate`、`asset_library`、`reference_album`、`task_view`。
  - 完成标准：后续所有页面和接口都引用这个 helper，不再散落写 `account_type` 判断。

- [ ] T2. 普通生成接口禁止外部用户直连
  - 文件：修改 `src/app/api/tasks/create/route.ts`
  - 做法：拿到 `user`、解析请求体后，区分 IP 生成请求和普通生成请求；外部用户只有明确的 IP 生成路径允许继续，普通生成、模板生成、画布生成直连都返回 403。
  - 注意：不要破坏 Codex API 授权链路和内部用户普通生成；不要发起真实扣费生成作为测试。
  - 完成标准：外部用户 POST 普通生成返回 403；外部用户 IP 生成仍可提交；内部用户普通生成仍通过原校验。

- [ ] T2A. 普通生成相邻能力一起收口，避免换入口绕过
  - 文件：
    - `src/app/api/video/retry/[id]/route.ts`
    - `src/app/api/tasks/enhance-video/create/route.ts`
    - `src/app/api/tasks/estimate/route.ts`
    - `src/app/api/video/create/route.ts`
    - `src/app/generate/enhance/page.tsx`
    - `src/app/generate/quick/page.tsx`
  - 做法：外部用户不能通过“重试普通任务”“增强视频”“普通生成估价”“旧创建接口”“快速生成页/增强页”绕回普通生成或付费生成能力。`/api/video/create` 已是 410，也要在矩阵里标为 deprecated，不当作开放入口。
  - 完成标准：外部用户访问这些普通/增强入口返回 403、410 或跳 `/generate/ip`；内部用户原能力不变。

- [ ] T3. 视频播放接口补任务归属权限
  - 文件：修改 `src/app/api/video/play/[id]/route.ts`
  - 做法：先 `getSessionUser(request)`，再复用任务查看权限 helper，例如 `assertCanViewTask` 或与下载/缩略图接口一致的判断；无权限返回 403。
  - 注意：保留 Range 播放、重定向到 provider URL、本地视频流式播放逻辑。
  - 完成标准：外部用户只能播放自己有权查看的任务视频；不能猜 task id 播放他人视频。

- [ ] T3A. 任务列表/状态接口对外部做字段脱敏
  - 文件：
    - `src/app/api/video/list/route.ts`
    - `src/app/api/video/status/[id]/route.ts`
    - `src/app/api/ip/video/list/route.ts`
    - `src/app/api/ip/video/status/[id]/route.ts`
    - `src/app/api/tasks/[id]/reuse/route.ts`
    - `src/app/tasks/page.tsx`
    - `src/app/tasks/[id]/page.tsx`
  - 做法：外部用户仍可看自己的任务，但响应里默认隐藏内部字段：模板详情、`template_key`、`agent_run_id`、`selected_agent_plan_key`、`source_request_id`、provider task id、官方成本字段、内部存储 key、内部错误原文。IP 任务错误继续用 `safeVolcengineIpUserMessage()`。
  - 完成标准：外部“我的任务”和 IP 任务状态可用，但不暴露内部工作流和 provider/成本实现细节；内部用户仍可看到排查所需字段。

- [ ] T4. 旧 Seedance 全局资产接口对外部收口
  - 文件：
    - `src/app/api/assets/list/route.ts`
    - `src/app/api/assets/create-from-url/route.ts`
    - `src/app/api/assets/[id]/route.ts`
    - `src/app/api/assets/[id]/provider-delete/route.ts`
  - 做法：这些接口属于旧的全局 Seedance asset 管理，不是外部用户资产库主链路；统一要求登录，并对外部用户返回 403。内部用户保持原能力。
  - 完成标准：外部用户不能列出、创建、改名、软删或 provider-delete 全局 Seedance asset；内部用户不受影响。

- [ ] T4A. 资产能力分层，保留上传但禁用生成/官方 asset 创建
  - 文件：
    - 允许外部继续使用但要确认归属：`src/app/api/assets/library/route.ts`、`src/app/api/assets/upload-ticket/route.ts`、`src/app/api/assets/upload-proxy/route.ts`、`src/app/api/assets/upload/route.ts`、`src/app/api/assets/multipart/**/route.ts`、`src/app/api/workspace/**/route.ts`
    - 默认外部禁用：`src/app/api/assets/generate/route.ts`、`src/app/api/assets/upload-and-create/route.ts`
    - 前端入口：`src/components/SeedanceAssetPanel.tsx`、`src/app/assets/page.tsx`
  - 做法：外部资产管理只保留“上传/选择/查看自己的素材、加入参考图集”这类必要能力；AI 图片生成、创建官方 Seedance asset、把素材推到旧官方素材库的能力默认内部专用。
  - 完成标准：外部用户能上传和管理自己的素材，但不能用资产页触发图片生成、增强生成或官方 Seedance asset 创建；内部用户不受影响。

- [ ] T5. 旧图集 collection 更新/删除接口补权限
  - 文件：修改 `src/app/api/collections/[id]/route.ts`
  - 做法：先要求登录；若这是旧 collection 模块且没有用户归属字段，最小方案是外部用户禁用 PATCH/DELETE，内部用户保留。若能明确归属，则改为 owner/admin 才能改。
  - 完成标准：外部用户不能直连删除或修改旧图集；内部用户现有管理动作不受影响。

### P1：补页面入口和协作类边界

- [ ] T6. 页面导航继续按外部角色隐藏，但不能影响内部
  - 文件：
    - `src/components/generate/GeneratePageClient.tsx`
    - 顶部/侧边导航所在组件，执行前用 `rg "composer-topbar-nav|composer-topbar|externalHidden"` 精确定位。
  - 做法：外部用户顶部主导航只保留 `资产`、`IP生成`；资产/任务/参考图集这类页面的侧边栏只保留 3 个管理入口：`我的任务`、`资产管理`、`参考图集`。普通生成、模板、模板生成、动画模板、无线画布隐藏。不要把“IP生成”塞进侧边栏导致 3 个入口要求跑偏；IP 入口放顶部主导航。
  - 完成标准：外部页面刷新后不显示禁用入口；内部用户仍显示完整入口。

- [ ] T7. 页面级服务端兜底重定向
  - 文件：
    - `src/app/generate/page.tsx`
    - `src/app/templates/page.tsx`
    - `src/app/template-generate/page.tsx`
    - `src/app/tools/ultimate-canvas/page.tsx`
    - `src/app/generate/enhance/page.tsx`
    - `src/app/generate/quick/page.tsx`
    - 如有无线画布旧路径，也一起纳入。
  - 做法：外部用户进入禁用页面时统一跳到 `/generate/ip`；内部用户不跳。
  - 完成标准：外部用户手输 URL 也进不去普通生成/模板/画布页面。

- [ ] T8. 模板接口禁止外部读取和生成
  - 文件：
    - `src/app/api/templates/route.ts`
    - `src/app/api/templates/[id]/route.ts`
    - `src/app/api/templates/module-builder/generate/route.ts`
    - `src/app/api/templates/module-builder/save/route.ts`
    - `src/app/api/templates/config-builder/generate/route.ts`
    - `src/app/api/templates/config-builder/save/route.ts`
    - 其他 `src/app/api/templates/**/route.ts`
  - 做法：外部用户对模板读取、模板构建、模板生成统一 403；管理员/内部用户保持原逻辑。
  - 完成标准：外部用户不能通过接口拿模板详情、模板规则、模板素材或发起模板生成。

- [ ] T9. 无线画布接口禁止外部直连
  - 文件：
    - `src/app/api/tools/ultimate-canvas/bootstrap/route.ts`
    - `src/app/api/tools/ultimate-canvas/document/route.ts`
    - `src/app/api/tools/ultimate-canvas/generate/route.ts`
    - `src/app/api/tools/ultimate-canvas/upload/route.ts`
    - `src/app/api/tools/ultimate-canvas/localization-health/route.ts`
  - 做法：接口入口统一加 `assertInternalOnly(user)`；如果某个健康检查必须公开，只返回最小健康状态，不返回项目/用户/模型信息。
  - 完成标准：外部用户不能加载画布 bootstrap、保存文档、上传画布素材或触发画布生成。

- [ ] T10. 项目协作管理对外部收口
  - 文件：
    - `src/app/projects/page.tsx`
    - `src/app/projects/[id]/page.tsx`
    - `src/app/api/projects/route.ts`
    - `src/app/api/projects/[id]/members/route.ts`
    - `src/app/api/projects/[id]/members/[userId]/route.ts`
    - `src/app/api/projects/[id]/invites/route.ts`
  - 做法：外部用户保留个人默认空间和自己的任务归属；禁用 team project 创建、成员管理、邀请链接等协作扩散能力。内部用户不变。
  - 完成标准：外部用户不能创建团队项目、邀请成员、改成员角色；仍能使用个人空间保存 IP 生成任务。

- [ ] T10A. 分享/邀请类入口单独审查
  - 文件：
    - `src/app/api/project-invites/[token]/join/route.ts`
    - `src/app/api/album-shares/[id]/route.ts`
    - `src/app/api/reference-albums/[id]/shares/route.ts`
    - `src/app/api/reference-albums/[id]/shares/revoke-all/route.ts`
    - `src/app/api/reference-albums/[id]/public-submissions/route.ts`
  - 做法：外部用户可以使用被授权的参考图集，但不能创建对外扩散的项目邀请、不能越权分享/撤销他人图集；公开提交入口如果必须存在，要确认 token/权限/过期时间。
  - 完成标准：外部用户只能用已有授权资源，不能把系统资源继续扩散给其他人。

### P2：信息暴露和长期方案

- [ ] T11. `/api/config` 拆成公开最小信息和登录后完整信息
  - 文件：修改 `src/app/api/config/route.ts`，同步审查 `src/app/api/health/route.ts`。
  - 做法：公开响应只保留前端启动必须字段；模型、provider base URL、队列、H3、计费等运行信息需要登录后才返回，外部用户再按 feature guard 裁剪。`/api/health` 只保留服务存活，不暴露 provider 是否配置这类内部信息。
  - 完成标准：未登录访问不暴露内部运行配置；登录后的内部用户仍能拿到原需要的配置；外部用户只拿到 IP 生成必要配置。

- [ ] T11A. 公开签名回调保持可用但锁紧
  - 文件：`src/app/api/provider/seedance/callback/route.ts`
  - 做法：不要给 provider callback 加普通登录态，否则上游回调会断；它必须继续依赖 `VIDEO_DELIVERY_CALLBACK_SECRET` / `SEEDANCE_CALLBACK_SECRET` 的 token/header 校验，并在矩阵里归为 `public_signed_or_minimal`。
  - 完成标准：无 token 返回 401；token 正确时原回调流程不受影响；日志和响应不泄露敏感 payload。

- [ ] T11B. 外部账号影响范围只读核查
  - 文件：新增或临时运行只读脚本，建议 `scripts/external-user-impact-report.ts`
  - 做法：只读统计以下账号数量，不改数据库：
    - `account_type = external`
    - `account_type = internal` 但无飞书身份、且非 admin
    - admin / disabled / expired 用户
  - 完成标准：上线前知道哪些历史邮箱普通账号会按外部收口；如发现需要保留内部权限的历史测试账号，先让管理员在后台改资料，不在代码里写特例。

- [ ] T12. 暂不引入新权限依赖，保留开源升级口
  - 候选方案：
    - CASL：适合 JS/TS 同构权限，能和 UI/API/Prisma 条件共享，MIT。仓库：`https://github.com/stalniy/casl`
    - node-casbin：适合复杂 RBAC/ABAC/策略文件，Apache-2.0。仓库：`https://github.com/apache/casbin-node-casbin`
    - Oso sample：适合参考多租户、RBAC/ReBAC/ABAC 建模，不作为第一阶段依赖。示例：`https://github.com/osohq/sample-file-share-local-node`
  - 当前选择：先写轻量 `feature-guard.ts`，因为本次只有“内部/外部 + 少数功能开关”，引入框架会增加迁移风险。
  - 升级触发：后续出现客户级租户、项目级角色继承、素材级分享、审批例外、临时授权等复杂规则时，再评估 CASL 或 Casbin。

### 测试和验证

- [ ] T13. 新增外部权限矩阵 smoke test
  - 文件：新建 `scripts/external-access-matrix-smoke.ts`
  - 做法：用源码静态检查 + 可选本地服务 HTTP 检查两层覆盖。
  - 至少检查：
    - `src/app/api/**/route.ts` 全部出现在矩阵里；未分类即失败。
    - `src/lib/access/feature-guard.ts` 存在，且外部白名单不包含 `standard_generate`、`template_view`、`template_generate`、`ultimate_canvas`、`legacy_seedance_assets`、`team_project_manage`。
    - P0/P1 路由文件引用 `assertFeatureAllowed` 或 `assertInternalOnly`。
    - `src/app/api/video/play/[id]/route.ts` 引用任务查看权限，不再裸查 `videoTask.findUnique` 后直接播放。
    - 导航组件仍按 `isExternalUser()` 或 feature guard 过滤外部入口。
    - 外部允许的上传/资产/参考图集接口必须有 owner/user/project 权限约束；不能因为在白名单里就裸查全表。
    - `public_signed_or_minimal` 路由必须有 token/secret 校验或只返回最小公开信息。
  - 完成标准：脚本失败时能明确指出哪个路由漏守门。

- [ ] T14. 手动/真实页面验收
  - 外部用户：登录后默认进入 `/generate/ip`；顶部只看到 `资产`、`IP生成`；资产/任务/参考图集侧边栏只保留 `我的任务`、`资产管理`、`参考图集` 3 个入口；看不到普通生成、模板、无线画布；IP 生成页文案为“可以生成IP授权视频”；看不到“普通生成/查看我的项目/火山官方 API”和“视频卡”那两行。
  - 内部用户：普通生成、模板、资产、IP生成、无线画布仍可见；普通生成和模板工作流不被误挡。
  - 接口直连：外部用户访问禁用 API 返回 403/401；内部用户访问原有 API 保持原行为。

- [ ] T15. 运行命令
  - `npm run lint`
  - `npm run build`
  - `node scripts/external-access-matrix-smoke.ts`
  - 如进入线上闭环，再按 sd2 服务器生产托管规则验证：
    - `ssh gouki@42.193.221.253 'systemctl is-active sd2-gray.service'`
    - `ssh gouki@42.193.221.253 'cd /srv/video-api-debugger/app && cat .next-prod/BUILD_ID'`
    - `curl -sS -D - https://sd2.youdooart.com/api/config -o /tmp/sd2-public-config.json`
    - 真实浏览器刷新 `https://sd2.youdooart.com/generate/ip`

## 3. 验收/审查内容

这些审查项需要创建独立子 agent 做只读审查；审查 agent 不改文件、不提交、不补实现，只判断是否达标、证据是否充分、风险是否遗漏，并输出“通过 / 不通过、证据、缺口、风险、下一步”。如果当前运行策略不允许创建子 agent，则由主线程按同一清单只读复查，但这不是独立审查，可信度低于子 agent。

- [ ] R1. 外部角色入口审查
  - 检查对象：`src/components/generate/GeneratePageClient.tsx`、顶部/侧边导航组件、`src/app/generate/page.tsx`、`src/app/templates/page.tsx`、`src/app/template-generate/page.tsx`、`src/app/tools/ultimate-canvas/page.tsx`。
  - 通过标准：外部用户不可见普通生成、模板、模板生成、动画模板、无线画布；默认入口是 `/generate/ip`；内部用户入口不减少。
  - 证据来源：代码、真实浏览器截图或 DOM 文本。

- [ ] R2. 服务端直连防绕过审查
  - 检查对象：`src/app/api/**/route.ts` 全量矩阵，重点包括 `src/app/api/tasks/create/route.ts`、`src/app/api/templates/**/route.ts`、`src/app/api/tools/ultimate-canvas/**/route.ts`、旧 `src/app/api/assets/**`、`src/app/api/tasks/enhance-video/create/route.ts`、`src/app/api/video/retry/[id]/route.ts`、`src/app/api/assets/generate/route.ts`、`src/app/api/collections/[id]/route.ts`。
  - 通过标准：每个 API 都有分类；外部用户对禁用能力拿到 403/401/410；内部用户仍走原能力；没有只靠前端隐藏的禁用项。
  - 证据来源：`scripts/external-access-matrix-smoke.ts`、必要时本地/线上 HTTP 返回码。

- [ ] R3. 数据隔离审查
  - 检查对象：`src/app/api/video/play/[id]/route.ts`、任务列表/下载/缩略图相关接口、资产库和参考图集接口。
  - 通过标准：外部用户只能查看自己的任务、自己的资产、自己有权使用的参考图集；不能通过 task id、asset id、collection id 猜测访问别人数据；能看的任务也要隐藏内部模板、agent、provider、官方成本、内部存储 key。
  - 证据来源：权限 helper 调用链、smoke test、真实接口返回。

- [ ] R4. 内部用户不受伤审查
  - 检查对象：内部用户普通生成、模板、无线画布、资产管理、项目协作入口和关键 API。
  - 通过标准：内部用户可见入口没有少；接口没有被外部规则误挡；`npm run build` 通过。
  - 证据来源：代码路径、构建结果、内部账号页面截图或 DOM 检查。

- [ ] R5. 高风险停止条件审查
  - 检查对象：本轮 diff、测试命令、部署步骤。
  - 通过标准：没有数据库迁移；没有真实扣费生成测试；没有删除生产资产；没有 force push；没有覆盖 `.env`、`storage`、上传文件或生产构建目录。
  - 证据来源：`git diff`、命令日志、部署记录。

- [ ] R6. 真实账号与线上缓存审查
  - 检查对象：外部测试账号、内部测试账号、服务器 BUILD_ID、线上 `_next/static/<BUILD_ID>` 资源、真实 DOM。
  - 通过标准：外部账号刷新后看到外部菜单和禁用接口 403；内部账号刷新后完整菜单和原接口仍可用；浏览器没有加载旧 JS。
  - 证据来源：公网 DOM/截图、`BUILD_ID`、接口返回码。

## 4. 审查内容是否对齐目标

- [ ] A1. 审查不能只看“导航隐藏”
  - 判断：如果 R1 通过但 R2 不通过，本任务仍然不算完成；因为外部人员可以绕过页面直接打接口。

- [ ] A2. 审查不能把外部用户一刀切禁掉
  - 判断：如果外部用户无法使用 IP 生成、自己的任务、资产管理或参考图集，本任务不算完成；因为目标是“收口”，不是“封号”。

- [ ] A3. 审查必须证明内部用户没受影响
  - 判断：如果没有内部用户路径证据，本任务不算完成；用户明确要求“不要影响其他角色正常使用”。

- [ ] A4. 审查必须覆盖不可逆/付费风险
  - 判断：测试不能触发真实扣费生成，不能调用 provider-delete 删除真实资产，不能跑数据库迁移；如确需真实外部用户线上验收，必须先拿到明确授权。

- [ ] A5. 审查必须覆盖“允许能力”的内部边界
  - 判断：资产管理、参考图集、我的任务是允许入口，但允许的是“自己的/有授权的”资源；如果白名单接口没有 owner/project/share 权限约束，仍然不算完成。

## Git Plan

- 当前生产源：`/Volumes/Data/Projects/video-api-debugger-v12-full-todo`
- 当前分支：`codex/video-delivery-fast-path`
- 规划提交：只提交 `tasks/todo.md` 和 `tasks/todo/2026-08-22-external-access-guard.md`。
- 后续实现建议：若用户确认“落地”，优先在当前生产分支上做聚焦 commit；如实现期间发现同文件混入旧改动或需大改权限结构，再切 `codex/external-access-guard` 工作分支隔离。
- 部署策略：规划阶段不部署；实现阶段只有通过 lint/build/smoke 后，才按 sd2 服务器生产托管规则上线验证。

## 停止条件

- 发现外部用户 IP 生成必须依赖某个被计划禁用的接口，但还没确认替代路径时，先停下重规划。
- 发现某个旧资产/collection API 没有归属字段，不能安全区分 owner 时，先外部禁用、内部保留；不要临时猜归属。
- 发现某个接口无法明确分类为 `external_allowed`、`internal_only`、`admin_only`、`public_signed_or_minimal` 时，先停下补矩阵，不继续实现。
- 发现外部账号真实验收没有可用测试账号，不能宣称线上闭环；只能说代码/接口层已验证。
- 任何测试需要真实扣费生成、删除 provider 资产、迁移数据库、改 `.env`、force push 或覆盖生产上传目录时，先停止并请求明确授权。
- 内部用户普通生成、模板或无线画布被误挡时，优先回滚该 guard，再重拆规则。
