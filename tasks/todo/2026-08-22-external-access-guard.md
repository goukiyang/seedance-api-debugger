# 外部用户权限收口与风险闭环

> **For Codex:** 后续执行本计划时，先读取 `${CODEX_HOME:-$HOME/.codex}/skills/executing-plans/SKILL.md`，按任务逐项执行；涉及权限边界时同时使用 `defense-in-depth` 思路，不能只做前端隐藏。

**目标：** 外部用户只能使用授权范围内的 IP 生成、自己的任务、资产管理和参考图集；普通生成、模板、无线画布、旧全局 Seedance 资产接口、协作项目管理等能力必须从外部权限里收掉，同时内部用户原流程不受影响。

**推荐架构：** 先不引入重型权限框架，新增一个轻量统一的 feature guard，把 `SessionUser.account_type` 和现有 `isExternalUser()` 作为唯一角色判断入口。页面层负责“不显示/默认进 IP 生成”，接口层负责“直连也不能绕过”，测试层用一张外部访问矩阵防回归。

**技术栈：** Next.js 14 App Router、TypeScript、现有 `src/lib/auth/session.ts` / `src/lib/auth/api-helpers.ts`、Prisma、脚本 smoke test。

---

## 1. 大白话目标复述

这次不是再改几个导航按钮，而是把“外部人员进系统以后能做什么、不能做什么”收成一条稳定规则：

- 外部用户定义：非管理员，且 `account_type === 'external'`；兼容历史邮箱账号，没有飞书身份的普通用户也按外部处理，沿用现有 `src/lib/access/external-role.ts`。
- 外部可见/可用：`IP生成`、`资产管理`、`我的任务`、`参考图集管理`，以及这些页面完成 IP 授权视频生成所必须的素材选择、素材上传、任务查看、视频播放。
- 外部不可见/不可用：普通生成页、模板页、模板生成、动画模板、无线画布，以及能绕过页面直接调用的相关接口。
- 内部用户不变：飞书内部账号、管理员、已有内部普通用户继续看到原来的生成、模板、资产、IP生成、无线画布等完整工作流。
- 完成标准：外部用户刷新页面后看不到禁用入口；即使用接口直连，也拿不到模板/画布/普通生成/旧全局资产等能力；内部用户对应页面和接口仍正常。

## 2. 具体可执行任务

### P0：先堵能绕过页面的服务端接口

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
  - 外部白名单：`ip_generate`、`asset_library`、`reference_album`、`task_view`。
  - 完成标准：后续所有页面和接口都引用这个 helper，不再散落写 `account_type` 判断。

- [ ] T2. 普通生成接口禁止外部用户直连
  - 文件：修改 `src/app/api/tasks/create/route.ts`
  - 做法：拿到 `user`、解析请求体后，区分 IP 生成请求和普通生成请求；外部用户只有明确的 IP 生成路径允许继续，普通生成、模板生成、画布生成直连都返回 403。
  - 注意：不要破坏 Codex API 授权链路和内部用户普通生成；不要发起真实扣费生成作为测试。
  - 完成标准：外部用户 POST 普通生成返回 403；外部用户 IP 生成仍可提交；内部用户普通生成仍通过原校验。

- [ ] T3. 视频播放接口补任务归属权限
  - 文件：修改 `src/app/api/video/play/[id]/route.ts`
  - 做法：先 `getSessionUser(request)`，再复用任务查看权限 helper，例如 `assertCanViewTask` 或与下载/缩略图接口一致的判断；无权限返回 403。
  - 注意：保留 Range 播放、重定向到 provider URL、本地视频流式播放逻辑。
  - 完成标准：外部用户只能播放自己有权查看的任务视频；不能猜 task id 播放他人视频。

- [ ] T4. 旧 Seedance 全局资产接口对外部收口
  - 文件：
    - `src/app/api/assets/list/route.ts`
    - `src/app/api/assets/create-from-url/route.ts`
    - `src/app/api/assets/[id]/route.ts`
    - `src/app/api/assets/[id]/provider-delete/route.ts`
  - 做法：这些接口属于旧的全局 Seedance asset 管理，不是外部用户资产库主链路；统一要求登录，并对外部用户返回 403。内部用户保持原能力。
  - 完成标准：外部用户不能列出、创建、改名、软删或 provider-delete 全局 Seedance asset；内部用户不受影响。

- [ ] T5. 旧图集 collection 更新/删除接口补权限
  - 文件：修改 `src/app/api/collections/[id]/route.ts`
  - 做法：先要求登录；若这是旧 collection 模块且没有用户归属字段，最小方案是外部用户禁用 PATCH/DELETE，内部用户保留。若能明确归属，则改为 owner/admin 才能改。
  - 完成标准：外部用户不能直连删除或修改旧图集；内部用户现有管理动作不受影响。

### P1：补页面入口和协作类边界

- [ ] T6. 页面导航继续按外部角色隐藏，但不能影响内部
  - 文件：
    - `src/components/generate/GeneratePageClient.tsx`
    - 顶部/侧边导航所在组件，执行前用 `rg "composer-topbar-nav|composer-topbar|externalHidden"` 精确定位。
  - 做法：外部用户顶部只保留 `资产`、`IP生成`；侧边栏只保留 `我的任务`、`资产管理`、`参考图集`、`IP生成`；普通生成、模板、模板生成、动画模板、无线画布隐藏。
  - 完成标准：外部页面刷新后不显示禁用入口；内部用户仍显示完整入口。

- [ ] T7. 页面级服务端兜底重定向
  - 文件：
    - `src/app/generate/page.tsx`
    - `src/app/templates/page.tsx`
    - `src/app/template-generate/page.tsx`
    - `src/app/tools/ultimate-canvas/page.tsx`
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

### P2：信息暴露和长期方案

- [ ] T11. `/api/config` 拆成公开最小信息和登录后完整信息
  - 文件：修改 `src/app/api/config/route.ts`
  - 做法：公开响应只保留前端启动必须字段；模型、provider base URL、队列、H3、计费等运行信息需要登录后才返回，外部用户再按 feature guard 裁剪。
  - 完成标准：未登录访问不暴露内部运行配置；登录后的内部用户仍能拿到原需要的配置。

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
    - `src/lib/access/feature-guard.ts` 存在，且外部白名单不包含 `standard_generate`、`template_view`、`template_generate`、`ultimate_canvas`、`legacy_seedance_assets`、`team_project_manage`。
    - P0/P1 路由文件引用 `assertFeatureAllowed` 或 `assertInternalOnly`。
    - `src/app/api/video/play/[id]/route.ts` 引用任务查看权限，不再裸查 `videoTask.findUnique` 后直接播放。
    - 导航组件仍按 `isExternalUser()` 或 feature guard 过滤外部入口。
  - 完成标准：脚本失败时能明确指出哪个路由漏守门。

- [ ] T14. 手动/真实页面验收
  - 外部用户：登录后默认进入 `/generate/ip`；顶部只看到 `资产`、`IP生成`；侧边入口只保留 `我的任务`、`资产管理`、`参考图集`、`IP生成`；看不到普通生成、模板、无线画布；IP 生成页文案为“可以生成IP授权视频”；看不到“普通生成/查看我的项目/火山官方 API”和“视频卡”那两行。
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
  - 检查对象：`src/app/api/tasks/create/route.ts`、`src/app/api/templates/**/route.ts`、`src/app/api/tools/ultimate-canvas/**/route.ts`、旧 `src/app/api/assets/**`、`src/app/api/collections/[id]/route.ts`。
  - 通过标准：外部用户对禁用能力拿到 403/401；内部用户仍走原能力；没有只靠前端隐藏的禁用项。
  - 证据来源：`scripts/external-access-matrix-smoke.ts`、必要时本地/线上 HTTP 返回码。

- [ ] R3. 数据隔离审查
  - 检查对象：`src/app/api/video/play/[id]/route.ts`、任务列表/下载/缩略图相关接口、资产库和参考图集接口。
  - 通过标准：外部用户只能查看自己的任务、自己的资产、自己有权使用的参考图集；不能通过 task id、asset id、collection id 猜测访问别人数据。
  - 证据来源：权限 helper 调用链、smoke test、真实接口返回。

- [ ] R4. 内部用户不受伤审查
  - 检查对象：内部用户普通生成、模板、无线画布、资产管理、项目协作入口和关键 API。
  - 通过标准：内部用户可见入口没有少；接口没有被外部规则误挡；`npm run build` 通过。
  - 证据来源：代码路径、构建结果、内部账号页面截图或 DOM 检查。

- [ ] R5. 高风险停止条件审查
  - 检查对象：本轮 diff、测试命令、部署步骤。
  - 通过标准：没有数据库迁移；没有真实扣费生成测试；没有删除生产资产；没有 force push；没有覆盖 `.env`、`storage`、上传文件或生产构建目录。
  - 证据来源：`git diff`、命令日志、部署记录。

## 4. 审查内容是否对齐目标

- [ ] A1. 审查不能只看“导航隐藏”
  - 判断：如果 R1 通过但 R2 不通过，本任务仍然不算完成；因为外部人员可以绕过页面直接打接口。

- [ ] A2. 审查不能把外部用户一刀切禁掉
  - 判断：如果外部用户无法使用 IP 生成、自己的任务、资产管理或参考图集，本任务不算完成；因为目标是“收口”，不是“封号”。

- [ ] A3. 审查必须证明内部用户没受影响
  - 判断：如果没有内部用户路径证据，本任务不算完成；用户明确要求“不要影响其他角色正常使用”。

- [ ] A4. 审查必须覆盖不可逆/付费风险
  - 判断：测试不能触发真实扣费生成，不能调用 provider-delete 删除真实资产，不能跑数据库迁移；如确需真实外部用户线上验收，必须先拿到明确授权。

## Git Plan

- 当前生产源：`/Volumes/Data/Projects/video-api-debugger-v12-full-todo`
- 当前分支：`codex/video-delivery-fast-path`
- 规划提交：只提交 `tasks/todo.md` 和 `tasks/todo/2026-08-22-external-access-guard.md`。
- 后续实现建议：若用户确认“落地”，优先在当前生产分支上做聚焦 commit；如实现期间发现同文件混入旧改动或需大改权限结构，再切 `codex/external-access-guard` 工作分支隔离。
- 部署策略：规划阶段不部署；实现阶段只有通过 lint/build/smoke 后，才按 sd2 服务器生产托管规则上线验证。

## 停止条件

- 发现外部用户 IP 生成必须依赖某个被计划禁用的接口，但还没确认替代路径时，先停下重规划。
- 发现某个旧资产/collection API 没有归属字段，不能安全区分 owner 时，先外部禁用、内部保留；不要临时猜归属。
- 任何测试需要真实扣费生成、删除 provider 资产、迁移数据库、改 `.env`、force push 或覆盖生产上传目录时，先停止并请求明确授权。
- 内部用户普通生成、模板或无线画布被误挡时，优先回滚该 guard，再重拆规则。
