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
- [x] T4a. 保留原 ArtReview 回调，设计隔离的积分分流及签名/身份/重放校验；2026-09-15 用户授权上线后已实现，代码与测试完成，真实切流另验。不随意新建应用导致已有 openId 失配。
- [ ] T4b. 验证旧审核卡不受影响、积分选择和确认卡更新、重复点击单次到账、发送失败重试；真实发分测试须明确对象和额度。
- 本轮未部署、未迁移生产数据、未改飞书配置或真实积分。已交固定审核001独立复核。原先认为只需补配置的判断被真实共享回调证据推翻。

### 上线实施（用户于 2026-09-15 明确授权）

- 新增独立 gateway 监听 127.0.0.1:8790；飞书后台 URL 不变，仅 nginx 原精确 webhook 转入 gateway。非积分卡原始 body/签名头交原 8788；积分卡 namespace 固定，先验飞书签名/token/app，再以域分离 HMAC 交 SD2，SD2 继续验租户/身份/nonce/事务。不修改 ArtReview 业务源码、不新增权限、不复制密钥。
- 生产旧 relay 日志的脱敏时间戳形状证明存在 Go 日期格式；gateway 同时支持秒、毫秒、Go 日期，签名使用原始字符串，保持 5 分钟窗口。专项测试包含该形状与过期/篡改/跨租户、旧卡原文透传。
- 生产只读预检：活跃且已绑定公司飞书的杨波管理员已唯一确认；现有 app/token/encrypt 配置布尔检查通过，token API code0；飞书后台 im:message 应用身份已开通。bot-info 查询返回 99991661，不以该查询替代消息投递实测。
- v0.2.0 由 package.json 维护唯一版本，锁文件仅同步版本元信息、不改依赖；个人页检查更新、全局轻量检测、稍后去重及刷新确认已补。历史 0.1.0 没有检测代码，首次须手动刷新；新检测不可能反向注入旧客户端。
- 两批完整 Next 构建通过，积分数据库专项与 gateway 专项通过。独立 tsc 与构建并发曾遇生成类型文件竞争，最终采用完整构建内的类型校验，不把中间失败记成源码错误。
- 发布脚本 `ops/deploy-credit-release.sh` 预备源码/旧构建/SQLite一致性备份，检查旧commit/build/nginx未变，新增表兼容迁移，失败恢复源码/构建/nginx并停止新服务，保留新增表避免覆盖生产数据；公网签名探针只使用不存在的请求ID，绝不真实发分。
- [x] 正式切换、公开版本、gateway/timer、双通道签名探针；2026-09-15 v0.2.0 已启用。主服务、gateway、发送 timer、原 ArtReview relay 均 active，公开 release/config/login 正常。
- [ ] 最终登录页面与手机实际发放验收：不以签名探针、通知投递或服务健康替代。

### 2026-09-15 发布结果与验收缺口

- 功能提交 dace85d，直接积分入口修正 bb0d764 已推送 origin/codex/credit-applications-20260915；当前生产 bb0d764de4a905c89a5db5e48b4b2f2ec4d37c4c，BUILD_ID=qAryIFswnPwowleHRJCcb，版本仍为同轮交付 0.2.0。
- 已备份数据库并兼容新增两表；未覆盖生产数据库、未真实发分。初版回退目录 /srv/video-api-debugger/backups/credits-dace85d5f7bbe067144483ccc3ffee9c3c907192；入口修正回退目录 /srv/video-api-debugger/backups/points-bb0d764de4a905c89a5db5e48b4b2f2ec4d37c4c。Git 回退 tag rollback/2026-09-15-before-credit-applications 已推远端。
- 本地积分专项、gateway 专项与完整构建通过；入口修正通过导航断言、独立审核001和服务器完整候选构建。上线后公开加密签名探针通过，旧通道结果一致；探针使用不存在的申请ID，无积分写入。
- 飞书入口卡已实际投递管理员并在客户端看到、点击打开网站。真实 Chrome 登录后发现 /points 只有标题：shellRoutes 遗漏导致 AppShell 不加载用户，积分弹窗返回空。已将 /points 纳入现有登录态加载入口，未改鉴权边界。
- 修正后 Chrome 无 AX/截图，重连仍无画面；接续 App Browser 可列出登录页，但选择页签和恢复连接均超时。最终页面、顶部积分点击、手动更新提醒未取得修正后真实画面证据，不能标为通过。
- 剩余：恢复浏览器连接后补最终页面验收；由明确的低于500点用户提交真实申请，管理员手机选额后二次确认，核对单笔到账及申请人通知。未执行真实发分，不宣称业务全链路闭环。
