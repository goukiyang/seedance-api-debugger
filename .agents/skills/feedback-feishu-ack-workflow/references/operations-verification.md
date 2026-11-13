# 排障、恢复与验证

## 查证顺序

先定位用户说的反馈、时间和入口，优先查现有API/日志/原工单，不用新发测试卡代替调查。原文、截图、open_id/message_id及nonce按需私有读取，汇报脱敏。没有具体条目时查有界汇总，不导出全部内容。

| 层 | 证据 | 回答什么 |
|---|---|---|
| 提交 | 原operationId、账号草稿、原请求 | 是否发出、是否待确认 |
| 保存 | feedback-submit原回执和Feedback | 是否保存、原id、附件实际保存数量 |
| 入队 | Notification和feedback-flow | 启用/身份/事件id/nonce是否一致 |
| 图片 | preparation.items及excluded | 没保存、未附卡、上传未知或ready |
| 发送 | meta.state/firstSendAt/attempts/lease/receiptId | 未尝试、重试、平台受理或未知 |
| 网关 | 精确Nginx路由、gateway健康、回调到达 | 是否到正确分支 |
| 确认 | 验签、ack绑定、receivedAt | 真入库还是toast错误 |
| 展示 | 回调card响应、lifecycle API、页面重读 | 哪处显示没有刷新 |

默认只读，不执行processor、timer start、业务PATCH/POST或删除租约来“查一下”；这些会发送或改状态。

## 常见症状

| 症状 | 先核 | 恢复边界 |
|---|---|---|
| 提交一直等/未知 | 原回执/Feedback、账号、operationId | GET原号；not_found不换号，不把飞书等待当提交必需 |
| 有反馈没通知行 | enabled、recipient配置/账号、事务 | 缺配置可能跳过入队，不假定总有failed行，不补发历史 |
| pending不前进 | timer、真实sender cwd、lease/nextAttemptAt/准备 | oneshot inactive正常；不用旧current链接判断版本 |
| 有正文没图 | saved/notSaved、Asset、ready/skipped/excluded | 保存与外发两层；上传unknown不盲重传，发后不另刷图 |
| 只有图数量无图片 | 旧type/旧冻结布局、真实img_key | 不把私有URL当key，不升级旧消息 |
| 收到多条 | feedbackId/operationId/uuid/type/firstSendAt | 区分多次提交和重复发送，不删行清证据，不承诺绝对恰好一次 |
| 点已收到报错 | 两层验签/时钟、真实操作者、context原message_id | 定位失败层，不取消身份或消息绑定 |
| 原通知回执尚未确认 | 行sent、receiptId与原消息、发送回执是否存 | 人看到卡不等于服务器已绑定，不强行放行 |
| 转发他人点不了 | 原recipient/open_id | 正常权限，不开放所有管理员代点 |
| 重复点冲突 | 根revision/CAS/receivedAt | 重读原结果，不重置时间或另建确认 |
| 卡片没变后台有时间 | 回调card返回、客户端更新 | 业务已成功，不撤销、不另发 |
| 网站还显示未确认 | 同feedbackId、面板是否重读、API.receivedAt | 当前没有持续自动轮询承诺，先定位显示滞后 |
| HTTP200但没确认 | toast.type/content、receivedAt | 业务错误可200，不只看状态码 |
| unknown存在failed行 | metadata.state/ambiguousSend/error_message | failed不代表肯定没发，不改pending/new uuid重放 |
| 回测卡没到 | 原作者active/绑定、轮次、retest事件 | 原接收人不是原作者，无绑定可站内回测，不猜收件人 |
| 查看/归档后不通知作者 | 是否显式mark_fixed、公开说明/轮次 | 正常语义，不把普通保存改成自动发信 |

## 安全的只读检查

路径、服务名以目标实际配置为准。SD2沿已有SSH通道先读：

```sh
systemctl show sd2-gray.service -p MainPID -p WorkingDirectory -p ActiveState
systemctl show sd2-feedback-delivery.service -p WorkingDirectory -p ActiveState
systemctl show sd2-feedback-delivery.timer -p ActiveState
systemctl show sd2-credit-gateway.service -p MainPID -p ActiveState
```

由当前PID查/proc/<pid>/cwd，读同目录目标文件并比较字节。unit模板不是有效配置；只读必要字段，不输出整个Environment/凭据。gateway health不证明真实回调成功。

从实际运行配置安全定位数据库，用SQLite mode=ro并保持WAL可见。别假定prisma/dev.db，也别给运行DB用immutable跳过WAL。只做统计可参考：

```sql
SELECT type,status,COUNT(*) FROM Notification
WHERE type IN ('feedback_feishu_v1','feedback_ack_feishu_v1','feedback_retest_feishu_v1')
GROUP BY type,status;

SELECT COUNT(*) AS flows,
 SUM(CASE WHEN json_extract(value_json,'$.acknowledgment.receivedAt') IS NOT NULL THEN 1 ELSE 0 END) AS acknowledged
FROM PlatformSetting WHERE key LIKE 'feedback-flow:v1:%';
```

聚合不能证明每条都正确授权，具体反馈还要核绑定。读取失败保未知，不用0代替失败。

## 恢复边界

- 原操作未知保原号/输入/hash，读原回执，仅沿授权入口恢复原操作。不另建feedbackId、通知事件或轮次解卡。
- 发送未知保原uuid、冻结内容、firstSendAt和已有不确定性；安全窗内按原worker合同处理，超窗unknown待核，不无限发。
- 身份/权限失效停该投递、保原记录，不改寄新绑定、不删反馈/原件。
- 图片失败在首发前按真实未附原因处理；反馈保存仍成功。消息可能已受理后不另发兜底。
- sender还处理retest/video/image/bridge，不因反馈问题停其他链或清整个Notification队列。
- 网关还路由额度/legacy宿主。没有当前有效授权，不改回调域名、其他分支、其他项目env或重启无关服务。
- 程序回退保Feedback/PlatformSetting/Notification、原件、账务、回执，不回库、不把新type改旧type重发。核相容读者，沿项目现有发布引擎，不另造发布系统。

## 最小充分验证

**只梳理/写技能**：核源码、原要求和必要运行事实，检查frontmatter/引用/命令/语义。不改业务就不构建部署，不自动真人发信/点击。

**已授权改实现**：复用有效工程检查，测试真实实现的事务/身份/CAS/原号/未知分支，不复制业务逻辑进测试。关注：

| 场景 | 可观察结果 |
|---|---|
| 原号重放/改内容 | 同号同输入返回原反馈，不同输入拒绝 |
| 正常/越权/失效附件 | 只保存与外发合法原件，缺项数量真实 |
| 两worker争抢 | 仅租约持有者写结果，uuid/冻结消息不变 |
| 明确拒绝/网络未知/超窗 | 后次拒绝不抹前次未知，终态不盲重发 |
| 正常/重复确认 | 原人写一次时间，重复读原值 |
| 错人/nonce/app/tenant/message | 不写接收事实，HTTP200不冒通过 |
| 确认已存、卡片刷新失败 | 保业务事实，不第二次发信 |
| 接收/查看/归档/修复 | 独立，普通保存不发回测 |
| 本人/他人/旧轮回测 | 仅本人当前轮生效，未知沿原号 |

**真实客户端层**：遵守目标项目手验边界。仅获相应授权才真实提交/外发/客户端操作；接收确认由真实接收人作出，不能替其点。SD2默认用户手验。

收口分开报告：代码支持、工程检查、配置/进程、平台受理、真实点击到站、持久确认、卡片/本站实际显示。未手验就标待手验，不为“完整”伪报通过。
