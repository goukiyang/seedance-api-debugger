# SD2 生产桥「插件错误上报」接口并入发布

## 1. 目标复述

Chrome 插件「SD2 生产桥」出错时要自动上报到 SD2，开发（Claude）能用管理员账号按天读到错误，不再让用户手动导出日志。接口已经写好并本地提交，**本单只负责把它并入现有发布流程并上线**，不改接口行为。用户 gouki 2026-11-01 明确选择「交给 Codex 发布」。

## 2. 具体任务

- [x] 读交接说明：`docs/handoff-bridge-client-reports-2026-11-01.md`（在 worktree `/Volumes/Data/Projects/video-api-debugger-worktrees/bridge-config-20261031`，分支 `claude/bridge-config-20261031`，提交 `d221c97ad`、`fe8db9108`）。
- [x] 核对同分支上两个更早且从未部署的提交，一并纳入评估：`c309149e6`（远程配置下发 + 隐私页）、`e667014c9`（浮窗令牌 / `/api/bridge/me` / `/bridge/panel` 页）。bridge 代码此前只在 `codex/*` 分支上，先与现有 `codex/*` 的 bridge 代码对齐，避免重复或冲突。
- [x] 只新增两个文件：`src/lib/bridge/client-reports.ts`、`src/app/api/bridge/client-reports/route.ts`。复用 `OperationLog`（`action=bridge_client_report`），**不新增表、不做 migration**。
- [x] 主目录有未提交改动，用独立 worktree 并入，不覆盖他人改动。
- [x] 按现有流程做类型检查、候选构建、版本/构建一致性、健康与公网可达检查；保留回退点。
- [ ] 部署后验证：未登录 `POST /api/bridge/client-reports` 返回 401；管理员 `GET /api/bridge/client-reports` 返回 `{ok:true,reports:[]}`；普通用户 GET 返回 403。
- [x] 回执写「已部署，待用户手动验收」，附版本与入口；不把构建成功说成功能验收。

## 3. 验收（用户手验）

- [ ] 用户在装了插件 v0.2.14 的 Chrome 里触发一次已知错误后，管理员 GET 能读到对应记录。
- [ ] 同一错误一天内只有一条；10 分钟内同一用户超过 30 条会被拒（429）。
- [ ] 上报内容里没有聊天文字、没有 token/cookie、没有 data: 图片内容。

## 4. 不做的事

- 不改接口行为、不改数据库结构、不动现有业务路由。
- 不自动浏览器测试或收费测试。

## Git Plan

- 在独立 worktree 并入并推送；主目录里别人的未提交改动保持不动。
- 构建失败或服务异常则保留原运行版本，回执写明原因。
- 上线后通知 gouki，Claude（GPT 抓图线程）随后用管理员账号按天汇总上报。

## 2026-11-01 Codex 发布接续

**已部署，待用户手动验收。** 入口 `https://sd2.youdooart.com/api/bridge/client-reports`；版本 v0.123.0，运行源码 `74d55961a91369996257043c5262a9f3bd5be602`，BUILD `eR2ihrtuj-7sSeQDLx8pW`，01:57:43Z 公网收口。已与现有 bridge 对齐；c309149e6/e667014c9 无 report 的必要依赖，本批仅评估，未合并远程配置、panel令牌/页面或frame权限。

原 route 字节及端点/鉴权/字段/响应/去重/限频/GET语义保持。原 cleaner 会把 message/items自由正文和URL query等写入OperationLog，故按本单“没有聊天/token/data图片”要求，仅补现有服务端脱敏：技术字段白名单，自由正文不可逆摘要，DOM结构白名单，URL去query/hash，data payload不保留，UTF8完整JSON不超过48KB。实际producer的fingerprint/kind/module/event兼容；未加表或migration，也未改插件。

Linux定向lint、完整tsc与完整Next通过；实际service/route隔离工程证明脱敏、401/403/200、去重/限频及kind前缀。部署层已核7服务同源、4timer、6启动门、7份静态资源200+SHA一致；真实公网匿名GET和空POST均401。管理员/普通用户真实登录GET和插件真实收报未执行，仍待手验，不以隔离身份结果冒充公网实收；原验收勾选保留。未试发生产报告、未创建用户/伪造session、未进行浏览器验收。

回退复用 `88f57e096c02a649b60b9788d469e5a0dadde68c` / v0.122.0+safe-retry-guard.1 / BUILD `bg-8r9i2u70uwEA2qJvwF` 原完整产物；只回程序，不回当前配置、数据库、账本、媒体或回执。report退404沿插件既有6小时暂停/恢复合同。部署原证保正式根私有 `docs/materials/2026-10-31-save500-sunburst/implementation/release/attempt02/`，恢复入口 `guard-restore.md`，未线上演练。源码分支 `codex/save500-sunburst-20261031` 已推送；本段为交接状态，不对外发送消息。
