# 积分申请与飞书审批

## 1. 大白话目标复述

用户点击顶部积分打开申请弹窗；可用积分严格少于 500 时可申请，由指定管理员在手机飞书选 2000/5000/10000，再确认发放。发放增加个人长期积分，网站与飞书均反馈结果。2026-09-15 用户授权落地。

生产目标：https://sd2.youdooart.com。真实源：video-api-debugger-v12-full-todo，codex/video-delivery-fast-path；开工 HEAD 与服务器部署标记一致为 9d690e2。风险 L4（积分、审批身份、数据库），不修改生成扣费或项目预算，不修改 ArtReview 中转服务。

## 2. 具体可执行任务

- [x] T1. 新增申请、唯一待办、发送队列数据表；申请/审批/撤回接口，审批与余额/流水/通知同事务（本地代码和隔离数据库测试，不代表生产迁移）。
- [x] T2. 顶部二级弹窗、记录、审批备用入口；姓名带头像；低于 500 仅在提交时检查，审批显示最新可用（代码与构建通过，真实页面待验）。
- [x] T3. 飞书现代 card.action.trigger 签名、加密、租户/应用/审批人/nonce 校验；选择额度后再次确认；消息失败重试不重复发分（本地协议测试，手机联调待验）。
- [ ] T4. 核对生产审批人稳定账号 ID、同一飞书应用的身份、机器人权限和固定回调；配置缺失保持关闭，不伪装已开放。
- [x] T5. 全部修改后统一运行隔离数据库专项测试、类型检查、构建；独立审查后聚焦提交推送（候选代码 c3a443d7e5086f695f9191d61841f76ff22cf9b8，已推送独立分支，非上线版本）。
- [ ] T6. 数据备份、兼容迁移、候选构建、可回退发布、定时发送服务、正式页面与手机实测；确认实际发放测试对象后测试，不擅自向真实用户发积分。

复用：现有 getCreditSummary、CreditAccount、CreditLedger、站内 Notification、UserIdentityBadge 和原生 dialog，无新增依赖。已读飞书官方 Node SDK dispatcher/request-handle.ts（https://github.com/larksuite/node-sdk/blob/main/dispatcher/request-handle.ts），仅参考协议，以 Node crypto 实现严格校验。已读服务器 ArtReview relay 源码，不直接复用其业务配置，防跨项目串线。

配置项（只登记变量名，禁止写凭据）：CREDIT_REQUESTS_ENABLED、CREDIT_REQUEST_APPROVER_ID、FEISHU_APP_ID、FEISHU_APP_SECRET、FEISHU_ALLOWED_TENANT_KEY、FEISHU_CREDIT_ENCRYPT_KEY、FEISHU_CREDIT_VERIFICATION_TOKEN。固定回调 /api/feishu/credit-actions，处理脚本 scripts/process-credit-request-deliveries.ts，systemd 模板 ops/sd2-credit-delivery.*。

## 3. 验收/审查内容

这些审查项需要创建独立子 agent 做只读审查；审查 agent 不改文件、不提交、不补实现，只判断是否达标、证据是否充分、风险是否遗漏，并输出“通过 / 不通过、证据、缺口、风险、下一步”。

- [ ] R1. 目标验收
  - 对象：requests.ts、回调验签、通知队列、弹窗、迁移；固定只读审核任务检查重复/并发审批、非本人、过期确认、余额变化、外部账号、配置缺失、失败重试和原有扣费不变。
  - 命令：npx tsx scripts/credit-requests-smoke.ts（临时新建数据库，绝不连接生产）、npx tsc --noEmit、npm run build。
  - 真实证据：生产 /points 与顶部弹窗；申请刷新仍存在；手机选额度后确认；数据库仅一笔流水；申请人飞书到账通知；未完成真实点击不得宣称闭环。

## 4. 审查内容是否对齐目标

- [ ] A1. R1 是否对齐目标
  - 必须分别证明本地实现、Git 远端、生产迁移/构建、真实飞书点击与到账通知。配置、测试、回退任一未满足，不启用功能。

## 5. 本轮验证与待接续

- 2026-09-15：两批统一验证。`npx tsx scripts/credit-requests-smoke.ts` 两次通过；第二次从已核对的 9d690e2 schema 建独立临时数据库，再执行本次 migration SQL，覆盖并发、唯一待办、额度边界、非审批人、nonce、确认过期、余额上涨、单次到账、拒绝、停用后历史/撤回、分页、通知重试和加密验签。未写生产数据、未向真人发分/发送测试通知。
- `npx tsc --noEmit --incremental false` 第一批通过；两批 `NEXT_DIST_DIR=.next-credit-candidate npm run build` 均通过（含第二批类型检查）。构建仅有原有页面的 hook/img/CSS 警告。本轮构建移到忽略目录 `.next.bad-credit-candidate-20260915`，恢复自动改动的 tsconfig，避免污染提交。
- 独立审核001指出的停用历史不可见、无法撤回、30条截断、关闭后刷新、提交响应账号隔离已修正。第二轮提出重复 showModal 抛异常，经 HTML 标准第1步核对为误报（已有 open 且 is modal 为 true 时 return）；来源 https://html.spec.whatwg.org/multipage/interactive-elements.html#dom-dialog-showmodal，已发审核方复核。不以这些代码证据冒充实际页面验收。
- 审核001随后确认并撤销 showModal P1，剩余为飞书配置、真实交互与发布验收缺口；未发现仍需修改的核心发分代码阻塞。审核为独立只读，审查任务未修改源码或执行真实发分。
- Git 候选分支：`codex/credit-applications-20260915`，不合入生产分支、不部署未联调功能。原有 audit/todo/画布任务脏改保留，仅精确暂存本轮内容。
- 原登录卡点已解除：2026-09-15 通过飞书客户端现有登录态进入公司开发者后台，不再需要重复扫码。未读取/输出凭据，未改其他项目的 relay。

### 2026-09-15 实测复核

- 线上验收不通过：生产仍为 `9d690e2`，主服务 active，积分发送 timer inactive，公网 `/api/feishu/credit-actions` 返回 404，服务器不存在候选回调源文件。
- 网站公开 OAuth 的 appId 为 `cli_a95d717de7389bc4`。已登录飞书后台同应用事件与回调页面显示 `card.action.trigger` 请求地址为 `https://artreview.youdooart.com/webhooks/feishu/card-actions`。两个业务共用应用，禁止直接覆盖原回调。
- 只读核对现有 relay `server.mjs`：callbackKey 按来源登记，但回传先规范化 decision，依赖已登记 deliveryId/nonce。当前积分卡不能未经适配直接接入。
- 候选再次运行 `npx tsx scripts/credit-requests-smoke.ts`，退出 0、全部断言 PASS；启动阶段存在 SQLite pragma `database is locked` 警告。测试仅使用临时数据库和模拟飞书网络，不能冒充手机成功证据。
- [ ] T4a. 保留原 ArtReview 回调，设计隔离的积分分流及签名/身份/重放校验；明确跨项目修改范围、兼容测试和回退后实施。不随意新建应用导致已有 openId 失配。
- [ ] T4b. 验证旧审核卡不受影响、积分选择和确认卡更新、重复点击单次到账、发送失败重试；真实发分测试须明确对象和额度。
- 本轮未部署、未迁移生产数据、未改飞书配置或真实积分。已交固定审核001独立复核。原先认为只需补配置的判断被真实共享回调证据推翻。
- 待接续：确认审批人账号 ID、飞书机器人权限与回调配置；补真实页面、手机二次确认和到账通知测试；按发布规则完成版本号唯一来源、旧客户端更新提示/手动检查（现项目尚未核实该能力，不能只改 package 版本冒充完成）；生产数据库备份/迁移、worker、候选构建、回退点与公网验证后才能开启开关。
