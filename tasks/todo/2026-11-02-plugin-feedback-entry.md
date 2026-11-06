# BR-FEEDBACK01 插件右上角信封反馈入口与后端复用

- 日期：2026-11-02（America/Los_Angeles）
- 工单版本：v1.0.0 / R01
- 状态：链路取证与设计完成，可进入实施；**本轮仅工单，未实施、未部署、未实发反馈**。
- 用户要求：把网站后端发送反馈的链路和设计复用到 SD2 生产桥插件，在顶部右侧放小信封入口。
- 正式项目：`/Volumes/Data/Projects/video-api-debugger`；关联插件：`/Volumes/Data/Projects/sd2-production-bridge`。
- 取证源码：后端干净副本 `/Volumes/Data/Projects/video-api-debugger-worktrees/cover-directory-one-second-20261101`，`6629e540dadaa816d17e6784a904d24ec50262a1`；插件干净整合副本 `/Volumes/Data/Projects/.worktrees/sd2b-integration`，`36091a44b59f9eccda2ebfbcc1e854ba0ac94806`、源码 manifest v0.3.6。
- 版本边界：插件正式目录当前检出的是 `cc/remote-config` / v0.2.12，不能直接把新功能落回该旧线而覆盖整合成果。以上提交仅是取证位置，实施前核对当时真实发布线、未提交改动和并行占用；不把历史提交固定为未来起点。未核验用户当前安装版本。

## 1. 目标与范围

让用户在 ChatGPT、Midjourney、即梦的插件浮层顶部右侧点击信封，即可描述问题并附上可选图片；反馈进入网站原反馈工作台、本人历史和现有飞书通知链。

完成标准：入口可见；一次提交形成一条本人反馈；返回反馈编号后显示“已提交”；截图按原权限核验；网络丢回执可以核对原提交；飞书异步发送，不让用户等待管理员实收。

本单包括共用插件表单、两个头部适配、后台网关、后端领域服务复用、插件来源识别与提交回执。网站React表单与插件原生DOM运行环境不同：复用后端领域能力/接口合同，三个插件站点共用一个UI组件，保留现有框架。沿用现有 Feedback、Asset、Notification、PlatformSetting；**不新增表、不做历史回填或迁移**。

不包含重做反馈管理系统、私信/即时聊天、自动截图、自动上传聊天/提示词、自动技术错误上报改造、扩展新权限或商店上架。本单不恢复已暂停的性能工程，也不替其他工单勾选完成。

## 2. 已核对的现有链路

| 环节 | 实际实现与证据 | 本次处理 |
| --- | --- | --- |
| 网站入口 | `src/components/AppShell.tsx` 挂载 `src/components/FeedbackWidget.tsx`；现为右下浮动“提意见”，含正文、图片、按用户区分的草稿 | 网站入口保持；插件采用同样的内容结构和反馈含义 |
| 网站上传 | Widget 调 `src/lib/http/file-upload.ts` 的 `uploadFileAsAsset`，沿原资产上传协议保存本人 Asset | 复用服务器上传协议、归属与指纹核验；插件增加必要的 SW 传输适配 |
| 反馈创建 | `src/app/api/feedback/route.ts` 的 POST：非空正文、可选 session、附件快照，在同一事务创建 Feedback 并入通知队列 | 抽取同一领域提交函数，网站与新插件入口共用；网站旧请求行为兼容 |
| 附件安全 | `src/lib/feedback/attachments.ts` 的 `snapshotFeedbackAttachments`：本人 active Asset、URL/ID/hash/MIME/体积一致，去重；原件在发送前复核 | 原函数直接复用；不接受任意远程图片地址代替 Asset |
| 通知入队 | `src/lib/feedback/notification.ts` 的 `enqueueFeedbackNotification`，与反馈保存同事务；按配置选择既有管理员收件人并核身份 | 不在插件放飞书凭据或另选收件人；通知关闭时仍可保存反馈 |
| 实际投递 | `scripts/process-feedback-deliveries.ts` → `src/lib/feedback/delivery.ts`；复用 outbox、CAS 租约、退避、receiptId、unknown 及最多12次/50分钟的现有窗口 | 沿原 worker；新入口不直接调用飞书发送 |
| 飞书展示 | 现有图文卡、截图、管理员“查看意见”链接与处理回执 | 只补清楚的插件来源标签，不改变原投递协议/收件人/操作保护 |
| 用户与管理 | `/feedback`、`/feedback/[id]`；`/admin/feedback` 及原管理 API，保本人和管理员权限 | 继续使用原入口、处理/回测流程 |
| 插件身份 | `background/auth.js` 通过 SW `getMe()` 读网站 Cookie 会话并广播；网关 `background/sd2-api.js` 已用 `credentials: 'include'` | 复用；本功能无需新增令牌或借用设备绑定身份 |
| 插件外壳 | v0.3.6：MJ/即梦共用 `content/common/panel-shell.js`；ChatGPT 仍有自己的 `content/chatgpt/panel.js` 头部；共同使用 `shared/panel-theme.js` | 一个共用反馈模块、两个轻量挂载点，不分别实现三个反馈表单 |

重要区别：`/api/bridge/client-reports` 与插件 `BRIDGE_REPORT` 是自动技术遥测，服务端对自由正文做摘要，且有每日指纹去重/暂停策略；**不能承接这次用户意见与截图**。本单不改该链。

旧 `/api/feedback/upload` 已明确废弃，不能接入。当前插件 `assetsUpload` 是简化 multipart 调用；服务器仍有旧兼容分支，但它缺少本次需要的完整 owner/requestId/原上传核对记录，不能直接据其网络错误重传。

## 3. 用户界面与交互

### 3.1 信封位置

- ChatGPT 头部及 MJ/即梦共用头部：在账号区域右侧、`⋯`/显示模式切换区域之前，放一个同现有 `.ib` 尺寸的按钮，线性信封 SVG 约16px，复用主题和焦点样式。`aria-label`、title 为“反馈”。
- 完整、极简模式常显；胶囊模式保原展开含义，展开后可见同一入口。信封不藏进更多菜单，不新增默认红点、长文标签或独立悬浮球。
- 点击按钮不触发面板拖动、折叠、队列启动或网页发送；两处头部只挂载同一公共组件。

```text
现有标题/状态 …… [网站登录] [SD2账号] [信封] [⋯] [显示模式]
                                        └─ 反馈
                                           哪里不好用，或想怎样改？
                                           [正文输入区]
                                           [添加图片 / 可粘贴截图]
                                           来源摘要 · 附带信息
                                           [关闭]       [提交反馈]
```

### 3.2 反馈面板

- 点击打开锚定信封的紧凑编辑层，默认向下、右侧对齐，边缘避让；宽度约360px并受可用视口限制，内部滚动，提交/关闭可达。复用现有 Shadow DOM、主题及事件隔离，不引入另一套 UI 框架。
- 一个正文输入框必填，图片可选；不再要求标题、分类、用户姓名或手填设备信息。Enter正常换行，输入法确认不提交；提交只由明确提交动作触发。
- 来源自动显示“SD2生产桥 · ChatGPT/MJ/即梦 · 插件版本”。附带信息按需展开，可查看并移除当前页面位置；URL不带 query/hash，不采集聊天正文、提示词、第三方账号/Cookie、令牌或文件路径。
- 选择文件/拖入/粘贴截图为用户主动动作。沿网站前端限制 jpg/png/webp、单图5MB；服务器原核验仍最终生效。不为此申请截屏或额外站点权限。
- 已上传图片可移除当前反馈引用；不删除 Asset 原件，避免影响其它引用。失败图片保留状态，用户可重试/移除后提交。
- 关闭键、点外部、Esc走同一关闭路径并保留真实草稿；只关最上层，不点击穿透。编辑区内拖动、图片拖放、选择文件不误关。关闭后焦点回信封。
- 反馈打开时，Esc先作用于反馈；按键/粘贴不触发网页聊天、插件队列提交或胶囊切换。CG和共用壳的全局快捷键入口需识别当前反馈层；关闭后恢复原快捷键。
- 面板移动/缩放时跟随锚点；若外壳收起导致锚点消失，保存草稿并关闭反馈，重新展开后可恢复。小窗口采用可用视口内的紧凑面板，不裁掉关闭、错误或提交。

### 3.3 状态与恢复

| 状态 | 用户看到/能做什么 | 系统行为 |
| --- | --- | --- |
| 未登录/登录失效 | 原位置提示“登录 SD2 后提交”，使用既有登录入口，保已存在的本人草稿 | 不降级成匿名反馈；账号从服务端 Cookie 会话取得 |
| 编辑 | 正文、图片与一个提交键 | 按 SD2用户+站点+标签/反馈实例保存草稿；后台校验身份后才发送 |
| 图片上传中/失败 | 对应图片局部进度/错误，可移除或沿原请求核对 | 不清空正文，不因图片失败创建另一条反馈 |
| 提交中 | “正在提交”，防重复操作；可以安全收起 | 在真正发请求前持久保存 operationId 与冻结输入，关闭不表示取消服务器请求 |
| 已保存反馈 | “已提交”，有“查看反馈”链接，回到原工作位置 | 以网站事务提交及反馈编号为准；不显示“飞书已送达”来冒后台保存 |
| 部分附件未核验 | “反馈已提交，X张图片未保存”，原反馈链接可用 | 复用返回的 saved/notSaved 计数，不能无提示丢图或再次自动创建反馈 |
| 结果未知 | 保留原稿与操作，提供“核对提交”；需要重试时仍是原编号、原输入 | 先查原回执；GET未找到不是原POST必然未受理。无自动换号/重发 |
| 切换账号 | 保存原账号草稿，切换到新账号独立草稿 | 不把原账号正文、附件、回执套给新账号；迟到结果只结算回原归属 |

自动技术遥测的“401/404暂停6小时”不能套到手动反馈。新接口404时显示暂不可用并保稿，兼容接口恢复后再核对；不偷偷改走匿名接口。

## 4. 复用架构与接口设计

```mermaid
flowchart TD
  H[插件头部信封] --> F[共用反馈面板]
  F --> SW[现有后台消息网关与Cookie会话]
  SW --> U[原资产上传准备/发送/核对]
  U --> A[本人Asset]
  SW --> B[新增插件反馈薄API]
  A --> S[共用反馈提交服务]
  B --> S
  S --> T[同事务：Feedback、来源/提交回执、原通知outbox]
  T --> R[返回反馈编号与附件结果]
  R --> F
  T --> W[原feedback delivery worker]
  W --> L[原飞书图文卡与查看意见链接]
  T --> M[原管理工作台与本人历史]
```

### 4.1 身份和传输

- 页面反馈组件只发明确的 `FEEDBACK_UPLOAD`、`FEEDBACK_SUBMIT`、`FEEDBACK_QUERY` 等扩展消息；所有 SD2 网络请求仍由 SW 的 `background/sd2-api.js` 发起。
- 新反馈消息仅允许本扩展的现有站点 content script/扩展自有页面；按实际 sender 取得站点，固定 SD2 目标 origin。正文和图片输入均作为不可信输入校验，不开放任意 URL 代理或任意后台命令。
- 新反馈 API 使用当前有效网站 Cookie session，匿名401；服务端重新校验 `expectedUserId` 与当前用户一致，切号冲突409。该字段只是匹配校验，不能当身份凭据。附件上传沿现有 `X-Upload-Owner-Id` 保护。
- 本功能不把 session Cookie、panel token 或飞书凭据放进 content script 消息/草稿，不扩大 Bearer、设备绑定或 iframe 权限。`/bridge/panel` 原令牌机制不需要为此改造。

### 4.2 后端共享提交服务

在 `src/lib/feedback/submission.ts`（新增）集中抽取正文规范化、附件快照、Feedback创建与 `enqueueFeedbackNotification`。站内 POST 调同一函数，保原匿名正文、附件筛选、响应、辅助上传日志及通知关闭时仍保存的行为。

新增薄入口 `src/app/api/bridge/feedback/route.ts`：

| 方法 | 契约 |
| --- | --- |
| POST | `{operationId, expectedUserId, content, imageUrls, uploadedAssetIds, context:{site,extensionVersion,pageUrl?}}`；首次201、同号同输入200回放，均返回 `{success:true,replayed,feedback:{id},attachments:{saved,notSaved}}`。context由服务端白名单规范化，站点仅chatgpt/midjourney/jimeng；pageUrl可缺省，携带时只能对应站点且去query/hash。 |
| GET `?operationId=…&expectedUserId=…` | 同账号精准核对原回执；返回 accepted及原feedback.id/附件计数，或not_found。未登录401、原身份不匹配409；不返回他人内容，也不借管理员身份读其它用户草稿。 |
| 冲突/异常 | 同号不同输入409；校验失败400；内部错误返回可判别原因并保客户端原操作。无法确认事务结果时按未知处理，不能宣称“肯定没有保存”。 |

**提交回执不是飞书receiptId。** 沿现有反馈修复操作的 PlatformSetting 持久回执惯例：

- 唯一键 `feedback-submit:v1:<userId>:<operationId>`，保存规范化输入摘要、反馈编号、已保存附件计数和必要版本；同事务写 Feedback、该回执、来源元数据及原 outbox。
- operationId在用户点击一次提交时生成，冻结对应输入；原号先精准查既有回执，再核新附件/执行新创建。同号同输入直接返回保存结果；不同输入冲突。并发依赖数据库唯一键和原事务，不能只靠SW内存去重。
- `feedback-source:v1:<feedbackId>` 保存小型插件来源元信息（站点/版本/规范化页面位置），避免更改Feedback schema或把资料塞进任务编号、User-Agent或正文。保留原 content；不复制聊天记录。
- 两类键按唯一key读写，沿 `catalog-directory-writes.ts` 已核的失效分类不会触发模板/资产目录版本；禁止无条件扫描PlatformSetting或逐条全表查来源。来源详情按feedbackId精准读取；列表按规范pathname映射来源，必要本页元信息批量按key取。
- 回执与反馈数据一起保留，程序回退不清回执。网站旧入口此次保兼容；它尚无提交级幂等的机制，另见D-20261102-02，不冒本单已修。

### 4.3 图片上传和草稿

- 新反馈截图使用既有 raw-v2 协议的小图片路径：`POST /api/assets/upload-ticket`（`mode:raw`）→ `POST /api/assets/upload` → 原号GET核对及需要时 `/recover`；参考现有 `file-upload.ts` 的 `performRawUpload`/恢复实现，不复制大文件、云直传及分片整套流程。
- 发字节前持久化 ownerId、uploadRequestId、hash、MIME、size和raw-v2阶段/nonce；校验准备回执后才发原文件。服务端继续校验hash/实际字节、归属、资产安全和原受理状态。
- SW网关补必要的协议适配，后台保存的是原文件；本功能不裁切、缩放或转码。网络未知只查原上传，不因超时换号传第二遍；只有服务器原证明允许恢复时才沿原号接续。
- Chrome扩展消息按JSON序列化设计，复用已存在的dataURL/base64→Blob适配传单图，校验解码后的真实体积。草稿只存文字、asset引用和小型操作描述，不在storage.local塞图片base64或整份日志。
- 未完成上传的本地File在页签重载后不能冒称已恢复：保留文字和上传标记，提示重新选择同一文件，核同指纹后查询/恢复原上传。已上传Asset无需重复上传。
- `chrome.storage.local`新增有版本、按SD2用户、站点及标签/反馈实例隔离的反馈键，SW和UI沿原协议读写；发送中冻结快照不随新编辑变化。首次写入失败不得宣称草稿已保存，已提交新编辑也不能被迟到返回清掉。同站多标签不覆盖彼此正在编辑的正文；恢复旧草稿保原页面上下文，不静默改为新页面。

### 4.4 来源和后续处理

- 插件反馈的 `Feedback.pathname` 使用服务端规范值 `/plugin/chatgpt`、`/plugin/midjourney`、`/plugin/jimeng`；`page_url`为用户允许附带的规范化实际页面地址，可为空。
- 在新增纯映射模块 `src/lib/feedback/source.ts` 统一三项来源标签，供 `feedbackPageName` 与后台客户端复用，不把含Prisma/飞书配置的服务端模块导入客户端。飞书卡和后台可识别“插件 · ChatGPT/MJ/即梦”；版本等细节从来源元数据按需展示，不给用户多一组表单。
- 继续用原管理员反馈详情链接、飞书确认/修复回测及本人 `/feedback/[id]`。新来源不变成新的权限身份，不绕过原反馈归属。

## 5. 明确的修改位置与工作包

以下路径分别相对各仓库；新增名称是本单设计，现有文件是已读证据。实施时仅核变化，不重新安排整套调查。

| 包 | 后端 video-api-debugger | 插件 sd2-production-bridge | 可核对结果 |
| --- | --- | --- | --- |
| W1 共用领域与回执 | 新 `src/lib/feedback/submission.ts`；改 `src/app/api/feedback/route.ts` 提取调用；新 `src/app/api/bridge/feedback/route.ts` | 无 | 原网站行为兼容；插件登录、身份匹配、同号回放/冲突、同事务反馈+回执+outbox成立 |
| W2 共用反馈组件与网关 | 原上传协议不另造接口 | 新 `content/common/feedback.js`、`background/feedback.js`；改 `background/index.js`、`background/sd2-api.js`、`shared/protocol.js`、`shared/constants.js`、`shared/storage-keys.js` | 一个表单/草稿/提交状态；明确消息路由、会话及raw-v2原号恢复，无任意代理 |
| W3 两处头部接入 | 无 | `content/chatgpt/panel.js` 与 `content/common/panel-shell.js`；`manifest.json`按依赖顺序加载共用模块 | 三站同一信封/表单；拖动、胶囊/极简/完整、Esc与原队列行为保留 |
| W4 原工作台与投递标识 | 新增纯映射 `src/lib/feedback/source.ts`；改 `src/lib/feedback/notification.ts` 页面名映射及 `src/app/admin/feedback/AdminFeedbackClient.tsx`；原 `src/app/api/admin/feedback/route.ts` / `[id]/route.ts` 按本页/单条精准投影来源 | 仅复用现有“查看反馈”跳转 | 原后台和飞书能定位插件来源，原截图/接收/回测兼容 |
| W5 检查与发布收口 | 原反馈工程夹具、类型/lint/构建及既有部署检查 | 现有`tests`风格新增定向反馈用例，沿原构建/打包约定 | 真实检查与待手验分开记录；后端先于新插件可用 |

- [ ] W1：共享提交函数与插件薄API/回执完成，原网站接口结果及权限不变。
- [ ] W2：公共编辑层、SW消息、已核上传协议和持久恢复完成。
- [ ] W3：ChatGPT、MJ、即梦入口及两处快捷键/拖动适配完成。
- [ ] W4：来源映射、原后台和本人历史/投递链兼容完成。
- [ ] W5：必要工程检查与发布保护完成；A01–A10留用户手验。

## 6. 架构判断与残留

共享资源是同一反馈表、资产、PlatformSetting、Notification及SQLite写事务。采用共用领域服务与独立认证薄入口，避免两套反馈写入/收件人配置；文件网络上传、读取和飞书调用均不进入新增提交事务。事务仅做必要的归属/快照及持久写入。

原素材上传可能复用已有同字节Asset；移除反馈图片因此只解除引用。回执/来源用精准key查询，避免用户数增长时全表扫描或人为让所有模板目录失效。UI公共组件仅两个头部适配，不为本功能统一重做整个面板。

具体残留：网站旧POST提交级幂等仍缺失；既有简化插件上传在其它功能的恢复能力不由本单扩大修正；插件真实Cookie/粘贴/布局/飞书实收需要后续授权手验。本单没有宣称这些缺口已经修好，也没有新增消息队列、设备token、存储平台或权限。

## 7. 够用验证与用户手验

按实际影响为L2：新增本人反馈写入与既有通知链，权限/附件/提交回执是重点；不改变费用或扩大共享权限。当前仅设计与源证核对，未执行下面实施检查。

工程检查使用隔离身份、数据库和替身外部transport，禁止因测试真实发送飞书、创建生产反馈或触发生成费用：

- 共享提交的原网站兼容，正文/附件验证、用户A/B/未登录身份，错误不冒成功。
- 同operation并发/迟到/重试只一条Feedback和一份outbox；同号不同输入409；事务中途失败整组回滚；GET原号正确隔离，not_found不触发自动POST。
- 图片准备/发送结果未知、SW重启、重选同文件，保原owner/requestId/hash；第三方URL、错asset/URL、非法MIME/体积不会被当有效截图保存。
- 草稿/回执跨账号隔离；晚返回不覆盖新编辑；未上传File不冒持久恢复；移除引用不删原Asset。
- 新来源两个PlatformSetting前缀不引入模板/资产版本失效；来源查询精确key/本页批量；原网站匿名契约及原自动client-reports不变。
- 后端按项目现有定向检查、完整类型/lint/候选构建和发布机制；插件按现有测试、JS语法、manifest加载顺序和打包检查。不为工单新建全面验收平台。

| 手验项 | 操作与通过标准 |
| --- | --- |
| A01 | 三站完整/极简头部右上有同款信封；胶囊展开可找到；旧模式、拖动、缩放与队列保留 |
| A02 | 点击锚定打开；窗口边缘/窄窗口/长内容下关闭和提交可达；面板移动后跟随 |
| A03 | 关闭/外部/Esc保草稿并回焦点；内部拖放不误关；Esc不收起原队列、输入法不提交 |
| A04 | 正文+粘贴/选择截图提交后有本人反馈编号，后台和本人历史能找到，来源/实际页面正确 |
| A05 | 飞书接收原图文卡/截图与正确后台链接，按原管理员范围；提交完成不等待飞书送达 |
| A06 | 离线、请求回执丢失、SW重启后核对原操作，重复点击不形成两条反馈或两次通知 |
| A07 | 登录失效/切号不匿名发送、不串文字/附件/回执；回原账号可恢复现场 |
| A08 | 图片上传失败或被排除清楚说明；已上传不重复上传；未保存的本地File需重选如实提示 |
| A09 | 网站原反馈正文/截图/管理员处理/飞书回测正常；自动技术上报不受影响 |
| A10 | 后端回退或接口404时保草稿/原回执，旧插件继续原功能；程序恢复不删除反馈、媒体或回执 |

项目默认用户手验。真实页面、用户反馈写入和飞书实收只在相应授权下执行；构建/隔离工程不冒A01–A10通过。

## 8. Git、实施顺序与恢复

本轮文档在正式根保存；正式根脏改保持，工单和自己的索引/发现条目通过既有干净副本形成聚焦文档提交，推送正确后端remote；不升级应用或插件版本、不部署。

未来实施：核当前后端/插件发布线及脏改 → W1/W2 → W3/W4 → 够用检查 → 后端保护部署 → 插件按现有版本/打包发布规则交付 → 用户手验。两仓库分开提交与版本，不能把当前旧root插件分支覆盖整合分支；不回滚他人变更。

后端失败保原运行版；若必须回程序，保Feedback、Asset、Notification和全部新元数据/回执。插件404保草稿和原操作，不降级匿名接口或自动重提；接口恢复后原号核对。旧插件不删除新键；恢复新版可继续。新前端与旧后端的暂不可用不冒提交失败或原记录不存在。

若实际来源/身份、上传协议或新接口与本单出现实质不符，先保资料并定位差异；不靠放宽权限、去掉回执保护、改发送收件人或静默丢附件通过检查。新增浏览器权限、商店上架、跨项目外发及生产数据覆盖不含在本工单授权内。

## 9. 取证覆盖、资料与设计收口

已完成：网站入口→上传→事务→投递→后台/本人查看的源码核对；插件正式/整合分支、两个头部、共用主题、SW消息和Cookie网关核对；旧上传入口排除、raw-v2恢复及现有反馈操作回执模式核对；界面/状态/身份/原号恢复/发布兼容设计。

当前缺口属实施与手验：真实安装版本、跨站Cookie、渲染位置、SW终止恢复及飞书实收未测；本轮未产生新生产反馈。代码索引方面，后端干净副本与插件整合副本均无索引；正式根现有索引对应其它分支及脏改，不能代替。本轮按只读取证例外定向查源，未建/同步索引、未修改插件项目状态，也不冒已写CodeGraph。

本次没有新图片/视频附件；没有拿历史用户截图或私有反馈JSON公开。下列已读实现是正式链路材料：

- 后端源码永久参考：[反馈创建](https://github.com/goukiyang/seedance-api-debugger/blob/6629e540dadaa816d17e6784a904d24ec50262a1/src/app/api/feedback/route.ts)、[附件](https://github.com/goukiyang/seedance-api-debugger/blob/6629e540dadaa816d17e6784a904d24ec50262a1/src/lib/feedback/attachments.ts)、[通知](https://github.com/goukiyang/seedance-api-debugger/blob/6629e540dadaa816d17e6784a904d24ec50262a1/src/lib/feedback/notification.ts)、[投递](https://github.com/goukiyang/seedance-api-debugger/blob/6629e540dadaa816d17e6784a904d24ec50262a1/src/lib/feedback/delivery.ts)、[已有持久回执惯例](https://github.com/goukiyang/seedance-api-debugger/blob/6629e540dadaa816d17e6784a904d24ec50262a1/src/lib/feedback/lifecycle.ts)、[上传客户端](https://github.com/goukiyang/seedance-api-debugger/blob/6629e540dadaa816d17e6784a904d24ec50262a1/src/lib/http/file-upload.ts)。
- 插件源码永久参考：[共用头部](https://github.com/goukiyang/sd2-production-bridge/blob/36091a44b59f9eccda2ebfbcc1e854ba0ac94806/content/common/panel-shell.js)、[ChatGPT头部](https://github.com/goukiyang/sd2-production-bridge/blob/36091a44b59f9eccda2ebfbcc1e854ba0ac94806/content/chatgpt/panel.js)、[网关](https://github.com/goukiyang/sd2-production-bridge/blob/36091a44b59f9eccda2ebfbcc1e854ba0ac94806/background/sd2-api.js)、[消息处理](https://github.com/goukiyang/sd2-production-bridge/blob/36091a44b59f9eccda2ebfbcc1e854ba0ac94806/background/index.js)。
- Chrome官方：消息使用JSON序列化，不能假设File/Blob可直接经消息传递；持久草稿采用扩展storage，不能用宿主网页localStorage。[消息传递](https://developer.chrome.com/docs/extensions/develop/concepts/messaging)、[storage](https://developer.chrome.com/docs/extensions/reference/api/storage)。
- MV3 worker可能终止，故操作描述须在发送前保存；不靠内存变量/永久保活当恢复机制。[生命周期](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)。这是API设计依据，不是本插件已完成的实测。

体验收口：入口不藏菜单；一个主任务/一个提交键；来源自动带、详细信息按需；没有成功确认弹窗或飞书等待；关闭保稿、未知查原号、切号隔离、三个站点共享。上述是设计结论，实际位置/交互仍待手验。

## 10. 本轮新发现的线索与问题

D-20261102-02：网站现有反馈POST无耐久提交幂等，重试机制可能重复创建反馈。已确认源码机制，未核生产重复数量；插件新路径按本单设计防重，网站旧入口后续另排，不顺手扩改。登记于正式根 `tasks/discoveries.md`。

## 12. BR-FEEDBACK02 反馈截图与素材目录隔离（2026-11-05，实施中）

用户已明确授权本次定向修改后端，替代原桌面工单在此项上的禁改边界。上文旧前置状态保留历史；R02实施与发布原证在正式根同名原单§11。本轮基于线上aff41ac30/v0.134.1，在`codex/feedback-material-isolation-20261105`隔离修复，插件沿原`cc/desktop-app`接续。候选后端0.134.2、插件0.6.17，尚未部署。

- 新反馈上传把用途冻结到原编号/指纹/nonce/核对和恢复，网站与三站插件同口径；服务器未确认用途时不降级发送字节。旧版未知raw/direct上传仍查原合同，不换号重发。
- Asset保持active，反馈附件/通知仍读取原件；仅对素材发现增加专用标记。正常素材用于反馈不隐藏，反馈图后来明确导入时在原事务复用原件、保留元信息并登记普通用途，并行胜出路径一致。无DDL、费用/权限扩大或媒体删除。
- 线上只读核对：11张插件固定名截图均有本人反馈的精确URL关联，0张绑定工作区/参考图/素材集/生成结果。兼容过滤仅排除此类旧图；有正常绑定或明确普通导入标记的保留，不批量改历史数据。
- SQL目录、Prisma兼容列表及总数一致；旧目录revision和本地素材缓存升代。原目录写追踪补Feedback、WorkspaceAsset与素材集绑定，避免旧客户端提交反馈或后续正常引用后复用旧目录。
- 插件反馈10组、后端实际函数与真实Prisma/私有完整schema SQLite的6组、网站原raw/direct请求恢复、原反馈提交10项、目录回执8项均通过。最初复用旧依赖导致类型检查失败，切换匹配当前Works schema的既有依赖后全类型检查通过，未更改业务断言或共用依赖。最终构建/提交/发布回执待追加。
- 相容guard基于当前d2eea332，保留Works/抠图/角色配方读取，并理解新上传用途；关闭新反馈用途上传但保原号读取。发布沿现有保护窗口、完整主/guard构建、数据/价格保护与程序恢复，不回业务数据。未实发反馈/飞书或真实生成，最终界面用户手验。
