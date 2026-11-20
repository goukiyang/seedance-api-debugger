# GPT 验收后台 0.150.0 保护发布

任务 sd2-gpt-background-review-20261120；原发布窗口 gpt-review-20261120-efe282e。Windows 负责 0.18.0、浏览器资料及真实账号验收，公司 Mac 仅接力后台。

## 输入及范围

- 隔离源码：`/Volumes/Data/Projects/video-api-debugger-worktrees/gpt-background-review-20261120`。原提交 `efe282e5c574913887e7e06348848511add4f37d`；实际回调修复提交 `ccc0474af5e2e41c561b3e8b4e2cc0691fa35791`，分支 `codex/gpt-review-real-callback-20261120` 已推送并远端核同。版本保持0.150.0。
- 原 Mac 临时准备目录当前缺失。沿服务器原 attempt01 接续，新尝试为 `/data/video-api-debugger/release-staging/gpt-background-review-20261120/attempt02`；2603个源码 Git blob 已核同，新输入包 SHA256 `b7fe65d9547a080dfbe8ff32be5946df1b5e13e9a350bf82646f1d9a019fcf07`。
- 发布前源 `c857f7122a12c945bbf9e53d127570db50894ff5` / 0.149.0 / BUILD `8xILj89cDwDY-1HfKVpRs` 健康。原相容 guard `eacd05ecb8080166a71daccfa43fb63d8d23da60` / `0.148.23+points-pricing-guard.1` / BUILD `sQ39rb_c1TBf2KqmFxvUz` 保留。

## 修复及证据

- 精确登记真实回调 `https://chatgpt.com/connector/oauth/lrPNES-xwBHJ`，保留旧回调 `https://chatgpt.com/connector_platform_oauth_redirect`。授权确认跳转与 CSP 复用验证地址；授权码保存申请地址，换码精确匹配，保留 PKCE、账号绑定及一次性使用。没有通配符。
- 实际路由和临时 SQLite 验证通过：两个合法地址的授权确认/换码；错误地址、尾斜线、额外查询参数、通配符、重复参数及双向跨回调拒绝；错误请求不消耗合法码，成功后重放拒绝。模型为模拟实现，没有生产用户内容或付费调用。
- attempt01 的 `bridge-storage.log` 实际7类、旧断言6类，工程失败 exit1；Next 构建与切换尚未开始。只修正既有断言，原日志、输入及退出码不覆盖；新 attempt02 的 `previous-attempt-preserved.json` 登记旧失败及摘要。
- attempt02 源兼容预检通过：数据库结构与持久合同不变，未执行 SQL；变更 lint、外部隔离工程、directory/storage/review及完整 tsc 通过。

## 当前状态与保护

已部署，待Windows真实账号及原对话手动验收。实际线上0.150.0，源 `ccc0474af5e2e41c561b3e8b4e2cc0691fa35791`，BUILD `TAQR8fhGfagEQj0l6mvrk`。attempt02完整构建及构建绑定准入通过，1.1.2 seamless发布run `88b98ab7-92a5-4ced-bb5a-b1b02e94e149` 八步complete/exit0；原窗口已记部署完成。

七服务同源同BUILD，双域release与health通过；3条旧未知请求全字段摘要与价格配置核同，没有数据库恢复。两个OAuth发现地址和POST initialize/tools/list均200，清单为 `link_review`、`submit_revision`，scope `reviews.submit`。匿名合法回调均302进登录；错误地址/通配符/额外查询均400。未进行Windows真实账号换码或原对话功能验收。

技术回执：[部署结果](../../docs/materials/2026-11-20-gpt-background-review/public-deployed.json)、[OAuth与工具清单](../../docs/materials/2026-11-20-gpt-background-review/gpt-review-public-check.json)、[完整构建](../../docs/materials/2026-11-20-gpt-background-review/main-build-success.json)、[原失败历史摘要](../../docs/materials/2026-11-20-gpt-background-review/previous-attempt-preserved.json)。恢复入口沿原plan `/data/video-api-debugger/release-staging/88b98ab7-92a5-4ced-bb5a-b1b02e94e149/seamless-plan.json` 与原相容guard，仅回程序不回业务数据。

工程证据边界：隔离worktree的CodeGraph更新命令本轮index返回exit1，未当作结构查询通过；本次局部关系以实际源文件、调用入口和真实工程验证复核。构建内置既有warnings保留，未扩改无关页面。

沿原 build-controller.sh、封存1.1.2 seamless引擎、publish.sh、verify-published.py。旧请求自然排空，保账号草稿、队列、已受理/未知原号、费用配置、账本和媒体；恢复只回程序，不回业务数据库。真实ChatGPT功能待Windows用户手验。

本轮新发现的线索与问题：未新增任务外问题。

Windows原会话最终回执已单次提交；原始受理结果见 [回执记录](../../docs/materials/2026-11-20-gpt-background-review/windows-final-receipt.json)。投递受理不代表Windows功能验收完成。
