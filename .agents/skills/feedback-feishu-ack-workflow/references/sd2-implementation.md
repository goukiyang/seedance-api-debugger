# SD2 实现与证据

## 查证对象

首次只读运行核对自 **2026-11-12 23:31 America/New_York**（次日04:31 UTC）开始。以下是快照，不是后续运行保证。

- 正式根 `/Volumes/Data/Projects/video-api-debugger`；调查时checkout为 `codex/mediakit-video-enhance` / `05807fcdd`，有既有脏改且缺后续反馈实现，不能直接当现网。
- `sd2-gray.service`真实进程cwd：`/data/video-api-debugger/managed-releases/2c338614b0dc189937fdbcaa7c6b63e33f1b2096`，package版本0.148.11。
- 结构查询用已有工作区 `/Users/gouki-youdoo/.codex/worktrees/seamless-release/video-api-debugger` / `9bab0751774666a1eddbc15691098471e4e105ed`；CodeGraph准备和真实context查询成功。此树与运行提交的反馈/回调/展示相关路径比较无差异，不表示两整版相同。
- 已从服务器读取9核心文件SHA并核对应实现：submission、notification、delivery、flow-state、lifecycle、feedback-relay、feedback-actions、FeedbackLifecyclePanel、gateway；实际网关执行文件也同SHA。
- 只读DB汇总：旧feedback_feishu_v1有36条sent，新feedback_ack_feishu_v1有23条sent；23个根flow中3个有receivedAt。无原文、用户/open_id/message_id、nonce或密钥输出，无业务写入。
- timer active，sender是oneshot，两轮间inactive正常。实际systemd WorkingDirectory为当前managed release；旧feedback-delivery/current链接较旧，不是此时实际执行来源。
- sd2-credit-gateway.service active；127.0.0.1:8790/health返回ok/configured。未造反馈、试发或真人点击；历史持久记录不证明当前所有客户端渲染效果。

后续重查须鲜核进程cwd、有效unit和只读DB来源，不复用PID/数量/老目录。Node可能启动后由dotenv载入基础配置，/proc environ缺变量不能直接证明未配置；不要据此改env。共享网关域名是既有接线，不授权读其他项目凭据或改其业务。

## 源码地图

下表路径相对仓库。在旧checkout可读已核部署对象，例如 `git show 2c338614:src/lib/feedback/lifecycle.ts`，不要为看代码切走用户分支。

| 层 | 路径 | 查什么 |
|---|---|---|
| 网站 | src/components/FeedbackWidget.tsx | 账号草稿、上传、pending、原提交核对、成功提示 |
| 客户端原号 | src/lib/feedback/submission-client.ts | 原操作、本机pending协议 |
| 网站API | src/app/api/feedback/route.ts | GET回执、POST事务、辅助日志隔离 |
| 插件API | src/app/api/bridge/feedback/route.ts | 已登录身份、共用保存核心、来源 |
| 保存 | src/lib/feedback/submission.ts | hash、原号重放、Feedback/receipt/source/通知同事务 |
| 附件 | src/lib/feedback/attachments.ts | 真实Asset、受控原件、上传、未附说明 |
| 通知 | src/lib/feedback/notification.ts | 配置/身份指纹/卡片/uuid/元信息/入队 |
| 投递 | src/lib/feedback/delivery.ts | CAS、图片准备、冻结、回执、退避/unknown |
| 定时器 | ops/sd2-feedback-delivery.timer及.service | 模板默认，实际仍核systemd有效配置 |
| sender | scripts/process-feedback-deliveries.ts | feedback/retest/video/image/bridge共享进程 |
| 外层回调 | ops/feishu-credit-gateway.mjs | 飞书原始验签、purpose路由、重签 |
| 内层验签 | src/lib/feishu/feedback-relay.ts | HMAC/时窗/app/tenant/operator/source |
| 回调API | src/app/api/feishu/feedback-actions/route.ts | 确认小事务、toast、原卡更新响应 |
| 状态 | src/lib/feedback/flow-state.ts | 根状态/轮次/nonce/revision及CAS |
| 业务 | src/lib/feedback/lifecycle.ts | acknowledgeFeedback、markFeedbackFixed、reviewFeedbackFix、白名单视图 |
| 后台 | src/app/admin/feedback/AdminFeedbackClient.tsx | feedbackId详情、管理状态/备注/生命周期 |
| 后台API | src/app/api/admin/feedback/[id]/route.ts | lifecycle读、mark_fixed、普通保存分流 |
| 本人 | src/app/feedback/page.tsx及[id]/page.tsx | 本人列表/详情和登录返回 |
| 本人API | src/app/api/feedback/[id]/route.ts | 本人读取及回测 |
| 展示 | src/components/feedback/FeedbackLifecyclePanel.tsx及feedback-flow.module.css | 接收时间、轮次、公开说明/回测、隔离草稿 |
| 回测投递 | src/lib/feedback/retest-delivery.ts | 原作者绑定、轮次通知、已回测/被替代轮 |
| 站内通知 | src/app/api/notifications/route.ts及[id]/route.ts | 仅in_app，全部已读不能吞feishu待发 |

## 持久模型

复用Feedback、Notification、PlatformSetting；这次能力没有新增专门表，不是另有完整审计平台。

| 载体 | 键/type | 内容 |
|---|---|---|
| Feedback | 原feedback.id | user_id/content/image_urls_json/pathname/page_url/task_id/UA/status/admin_note/归档 |
| PlatformSetting | feedback-submit:v1:<userId或guest>:<operationId> | 输入hash及成功结果，现代原提交恢复 |
| PlatformSetting | feedback-source:v1:<feedbackId> | 插件站点/版本及清查询/hash后的URL |
| PlatformSetting | feedback-flow:v1:<feedbackId> | version/feedbackId/revision/currentRound/acknowledgment |
| acknowledgment | 根记录内 | recipientId/identity/notificationId/nonce/receivedAt |
| Notification | feedback_ack_feishu_v1 | 新反馈给原接收人的事件 |
| Notification | feedback_feishu_v1 | 旧通知兼容，不换type重发 |
| PlatformSetting | feedback-repair:v1:<feedbackId>:<round> | summary/管理员/发布时间/原操作/hash/通知/本人回测 |
| PlatformSetting | feedback-repair-op:v1:<feedbackId>:<operationId> | 原修复操作对应hash/轮次 |
| Notification | feedback_retest_feishu_v1 | 原作者回测通知，按反馈+轮次去重 |

新反馈uuid为sha256("feedback_ack_feishu_v1:"+feedbackId)前32位，旧type用旧前缀。初始化ack生成24字节随机nonce（48hex），根revision=1/currentRound=0/receivedAt=null。配置无效不生成可用ack；缺接收配置/账号不改寄别人。

根保存用key+旧value_json作CAS，核revision递增。首次确认写receivedAt/revision+1/updated_by，重复保原时间。没有独立callback event_id表，不能说已部署完整事件审计；幂等来自原消息绑定、receivedAt和CAS。

投递元信息包括version/eventKey/feedbackId/uuid/identity/state/attempts/nextAttemptAt/firstSendAt/leaseToken/leaseUntil/receiptId/ambiguousSend/lastErrorCode/ackVersion/ackNonce、冻结message和可选preparation。

**双层状态：**metadata.state为pending/sent/failed/unknown；行status写pending/sent/failed。终态unknown表现为行status=failed、meta.state=unknown和feedback_delivery_unknown_manual_check。只查行status会把可能已发送误读成肯定没发。

## 配置与回调接线

本站配置名：FEISHU_FEEDBACK_ENABLED、FEISHU_FEEDBACK_RECIPIENT_USER_ID、FEISHU_FEEDBACK_IDENTITY_SHA256；应用配置FEISHU_APP_ID、FEISHU_APP_SECRET、FEISHU_ALLOWED_TENANT_KEY。只列名字，不放值。

identity=sha256(JSON.stringify([系统userId,真实openId,appId,tenant]))。接收人必须等于配置ID、active/admin/未过期、同tenant且指纹匹配；配置变更不让旧事件重定向。

```text
Feishu card.action.trigger
 → https://artreview.youdooart.com/webhooks/feishu/card-actions
 → 精确Nginx location → 127.0.0.1:8790
 → sd2-credit-gateway.service
 → source=sd2_feedback_ack_v1
 → http://127.0.0.1:3302/api/feishu/feedback-actions
 → verifyFeedbackRelay → acknowledgeFeedback → 根状态
```

网关实际文件 `/srv/video-api-debugger/app/ops/feishu-credit-gateway.mjs`，与业务managed release是不同部署对象。额度source和其他legacy转发保持。不能见ArtReview域名就说没接本项目，也不能借历史授权重配其他项目。

外层：必要时AES-256-CBC解密；原raw body验SHA256(timestamp+nonce+encryptKey+raw)、verification token、app/event和5分钟时窗；反馈分支保header/event/context，context取payload.context或event.context。

内层：当前用FEISHU_APP_SECRET作HMAC-SHA256；签名正文为 `sd2-feedback-relay-v1\n<毫秒timestamp>\n<转发raw>`（两处反斜杠n表示实际换行），headers为x-sd2-feedback-time和x-sd2-feedback-signature；60秒时窗、32768字节上限，再核app/tenant/card.action.trigger/source及可用operator tenant。与额度purpose分离，不是已经另配独立密钥。

确认事务还核feedbackId/nonce/openId/messageId格式、ack存在及nonce、当前接收绑定/真实点击open_id、Feedback存在、Notification的type/channel/target/status=sent、metadata.identity/uuid/nonce/feedbackId，以及 **receiptId=context.open_message_id**。不是只验按钮source。

本站确认事务maxWait750ms/timeout1250ms；网关反馈请求超时2500ms。业务错误toast也可能HTTP200，不能只看状态码。卡片更新是回调raw card响应，不是再发消息。

## 实现参数（不是飞书通用限制）

| 项 | 当前选择 |
|---|---|
| timer | 启动20秒后，上轮结束20秒后；不保证提交后恰好20秒送达 |
| 每轮 | 查最旧100条，默认最多领10条 |
| 租约 / HTTP | 90秒 / 8秒 |
| 自动恢复窗 / 尝试 | firstSendAt起50分钟 / 最多12次 |
| 退避 | 15秒指数增长，上限10分钟 |
| 附件 / 卡片图 | 快照128项 / 附卡20张 |
| 单图 | JPEG/PNG/WebP、非空≤10MiB；核原件hash/大小/格式/解码 |
| 准备 | 30分钟/100轮；每领取2图，每进程轮4次上传、40MiB预算 |
| 图片重试 | 明确可重试错误最多3次，上传unknown不盲重传 |
| 消息 | 最终请求≤30000字节，v2冻结content解析≤26000字节 |

残留uploading但没可恢复key时标skipped及unknown原因。首发前可带真实未附说明冻结卡片；消息已开始后不另发无图/文字兜底。旧元信息有firstSendAt而缺ambiguousSend时按可能已发保守处理。

## 原要求与证据入口

相对正式项目根：

- tasks/todo/2026-10-09-feedback-feishu-notify.md：通知、体验、合法图片授权。
- tasks/todo.md：FRAME-PREVIEW/CANVAS-MEDIA R02/R06的FB-ACK、最小产品路径；旧未实施是历史阶段。
- tasks/todo/2026-10-27-feedback-24h.md：F24-S01、真实控制台配置、共享网关配套授权、R07/0.112.0部署。
- tasks/todo/2026-11-12-feedback-feishu-skill.md：本次调查/制作/校验记录。

官方：[发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create)、[上传图片](https://open.feishu.cn/document/server-docs/im-v1/image/create)、[卡片交互](https://open.feishu.cn/document/common-capabilities/message-card/add-card-interaction/interactive-components/button?lang=zh-CN)。本次重开前两动态页没有可读正文，新版callback页不可读；未靠摘要声称鲜核全部平台限制。上表取源码，官方去重/时限合同沿原工单已读来源；更换接口、卡片版本或验签时重核官方现行合同。
