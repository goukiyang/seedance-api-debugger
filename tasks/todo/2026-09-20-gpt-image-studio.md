# GPT Image 独立生图页与固定上下文

## 1. 大白话目标复述

新增独立图片生成页面：所有登录用户可用；仅管理员编辑全站固定上下文，自动保存；参考图片选填，最多两张；正文输入、快捷与自定义生成张数、生成结果预览与单张/批量下载。不做连续修改。来源：本任务用户确认，2026-09-20。

生产目标 https://sd2.youdooart.com；部署源 /Volumes/Data/Projects/video-api-debugger-v12-full-todo。2026-09-20 已从 53d0274 / v0.2.1 升级至独立发布提交 6a95da91 / v0.3.0。本地 7e1940f 的批量视频下载修复未发布，未混入本次上线。

## 2. 具体可执行任务

| 编号 | 任务 | 完成标准 | 当前状态 |
|---|---|---|---|
| I1 | 核对接口与现有能力 | 确认真实模型、计费及复用入口 | 已完成；真实模型已核实，独立单价由管理员设置 |
| I2 | 实现生图页与上下文设置 | 权限、上传、生成、保存、下载完整衔接 | 已完成；隔离数据库/模拟模型与真实浏览器操作通过，未执行付费生成 |
| I3 | 验证与发布 | 检查通过，线上页面可用并有回退点 | 已完成；v0.3.0 正式页、静态资源、进程与回退点已核对 |

- 实证：通过已有服务端配置调用中转 /v1/models，200，包含 gpt-image-2、gpt-image-2.5-flare、gpt-image-2.5-sunburst；不输出凭据、未付费生成。
- 现有 src/lib/integrations/image-generation.ts 走 Gemini/Seedream，保持不变；新增独立 src/lib/image-studio 适配器。
- 复用现有 uploadFileAsAsset、ZoomableImagePreview、PlatformSetting 与 getAdminUser。设置使用版本冲突检查；普通用户响应不含上下文原文。
- 积分采用管理员独立配置，初始为空；管理员填好固定上下文与单价后开放生成，不擅自采用视频价格或默认免费。菜单向所有登录用户开放，仅上下文设置入口/接口限管理员。
- 已实现：固定上下文快照、任务持久化与幂等、素材归属校验、PNG 保存、部分成功和失败恢复、PNG/ZIP 下载、刷新恢复、普通用户不能读/改上下文。
- Git：开发分支 codex/gpt-image-studio；干净发布分支 codex/image-studio-release 从线上 53d0274 起只引入本功能，保留原 tasks 脏改，不发布暂停的旧视频下载修改。
- 开源参考：已读 OpenAI Node SDK images.ts 的 generations JSON 与 edits multipart 实现；不安装新 SDK，使用现有 fetch/FormData，避免增加依赖。https://github.com/openai/openai-node/blob/main/src/resources/images.ts 。模型文档 https://developers.openai.com/api/docs/models/gpt-image-2.5-flare 。适配器模拟验证不等于中转付费接口已跑通。

## 3. 验收/审查内容

这些审查项需要创建独立子 agent 做只读审查；审查 agent 不改文件、不提交、不补实现，只判断是否达标、证据是否充分、风险是否遗漏，并输出“通过 / 不通过、证据、缺口、风险、下一步”。

- [x] R1. 目标验收
  - 检查对象：新页面、settings API、provider 及后续任务/下载链路。
  - 通过标准：普通用户可生成但不能获取或改上下文；0/1/2 图及张数校验；重试不重复计费；结果可下载；改动不影响原视频/Gemini/Seedream链路。
  - 必须区分：类型检查、模拟接口、真实付费生成、生产页面验证。付费测试需单独授权。

## 4. 审查内容是否对齐目标

- [x] A1. R1 是否对齐目标
  - 判断：审查项是否真的能证明目标完成，而不是只检查表面动作。

## 5. 前一阶段检查（历史记录，不是当前整项验收）

- `npx tsx scripts/image-studio-provider-smoke.ts`：通过；纯文字 JSON、双图 multipart、模型/张数边界、空输出与上游错误脱敏；没有真实付费请求。
- `git diff --cached --check`：本轮暂存文件通过；全库差异另有既有 todo 改动，未混入暂存。
- 全库 `npx tsc --noEmit --incremental false` 在本机磁盘读取等待数分钟后主动终止；随后定向 `node node_modules/typescript/bin/tsc -p /tmp/sd2-image-studio-tsconfig.json --noEmit` 完成，exit 0，本轮模块及其导入依赖类型检查通过。不是全库构建通过。
- 固定审核任务 019f44c6-64d3-7753-acd0-f31fc16763fb 阶段只读复核通过；仅覆盖页面/设置/适配器基础，不包含未实现任务与下载，也非生产验收。
- 审核最初质疑 `image[]`，后用官方 SDK uploads.ts 数组编码实现复核并撤回该阻塞；保留中转真实付费兼容性未验证的缺口。https://github.com/openai/openai-node/blob/main/src/internal/uploads.ts
- 普通用户权限、自动保存的浏览器真实操作尚未实测；未部署、未做真实付费生成、未改数据库或积分。生成入口仍禁用，不展示可用假象。

## 6. 继续实施（2026-09-20）

- 用户要求“推进做完”。不再让计价未决定阻塞其余实现：管理员分别设置 Flare/Sunburst 单价，空值不开放生成，0 明确表示不扣站内积分但上游仍收费。固定上下文未填写同样明确提示。初始值不擅自写生产。
- 新增独立 ImageStudioTask 表，按图片冻结/结算积分，沿用每日配额和余额分配，不改视频扣费规则。新增表为增量迁移；线上执行前备份并检查表结构，不做全库 db push。
- 每次提交使用固定请求 ID；每张独立队列任务和租约；服务重启后超时任务释放冻结积分且不自动重发。结果未知时明确提醒再次生成可能重新调用上游。
- 服务器 worker 最多同时处理两张；持久化任务/上下文/模型/价格快照/结果及用量，刷新恢复；历史每批24条；普通用户只能读自己的任务，DTO 不暴露上下文。
- 新增受鉴权保护的 PNG/ZIP 下载接口，ZIP 复用现有 yazl；保留手动保存链接；上传复用现有链路并支持粘贴/拖放。
- 发布计划：从实际生产 53d0274 建干净发布分支，只移入 image-studio 改动；不含暂停的批量视频下载修改。版本 0.3.0；已存在 ReleaseNotice 机制，更新摘要对应此功能。
- 统一验证：隔离 SQLite 假数据、mock provider，无付费；覆盖幂等/冻结/扣费/返还/过期恢复/上下文快照/越权，以及类型检查、候选构建、固定审查任务和生产实际浏览器。真实付费生图未获授权，不执行。

## 7. 本轮验证记录

- 定向 TypeScript 检查通过；修正了 ZIP 流和集合转换的类型兼容问题。
- provider smoke 通过：JSON、双图 multipart、错误脱敏、输出与数量边界；无真实网络生成。
- 隔离 SQLite integration smoke 通过：上下文快照、重复提交/结算、逐张扣费/失败释放、他人记录隔离、设置冲突、租约恢复和 PNG 保存。首轮出现已有 Prisma 初始化 PRAGMA 与写入竞争警告，但断言全部通过；未修改共享 Prisma 行为。
- 固定审核任务 019f44c6-64d3-7753-acd0-f31fc16763fb 本轮完整只读审查通过，无阻塞项。审查侧运行被沙箱 IPC 限制，运行证据由执行侧补齐。部署需验证 tsx/worker 服务；极端迟到结果可能留下孤立资产，但不会重复扣费。
- 普通用户设置响应不含上下文，服务端管理员权限校验；参考图与下载逐项校验本人资产；远程图片防私网/DNS 重绑定，限制大小与格式。
- 生产 53d0274、tsx 依赖、存储空间和原有四个服务健康已核对。发布仍须使用独立提交，排除旧批量视频下载变更。

## 8. 上线与最终证据（2026-09-20）

- 正式入口：https://sd2.youdooart.com/image-studio 。发布提交 6a95da91eeb6ac0b6c4bc6e1f571f895cae746b5，v0.3.0，BUILD_ID `3hBDppTGlvvB5qWRt4FfJ`。源码包 SHA256 `1b8b2f52df6530d1ab5f7cb231a11ce44664e233d1ec3b6bc6bafd9b59c6769b`，上传前后相符，排除密钥、数据库、上传资产和旧视频。
- Git：开发提交 a1ff21c 已推送；独立发布分支已推送并用 GitHub ref 复核。回退 tag `rollback/2026-09-20-before-image-studio` 已推送，指向 53d0274。
- 服务器：候选构建通过（既有 globals.css/其他页面 lint 警告保留，未越界修改）；新增 ImageStudioTask 表使用事务增量建表，没有全库 db push；旧源码、旧构建与 SQLite 一致性备份保留在 `/srv/video-api-debugger/backups/image-studio-6a95da91eeb6ac0b6c4bc6e1f571f895cae746b5/`。回退停用新增 worker 并恢复旧源码/构建，不覆盖继续产生的生产数据。
- `sd2-gray.service`、`sd2-image-studio.service`、积分网关/派发 timer、飞书 relay 均 active；图片 worker NRestarts=0，独立进程固定使用 `/data/video-api-debugger/var-lib/dev.db`，日志无启动错误。
- 真实浏览器：服务器候选版本接隔离测试库，经仅本机可达的 SSH 转发验收。普通用户菜单可见、设置按钮不可见，PUT 设置 403；他人图片下载 403；无效提交 400；上传成功且刷新后图片选择、正文和张数保留；单张 PNG 下载通过，双张 ZIP 下载通过 `unzip -t`；管理员上下文/模型/双模型单价自动保存后刷新一致；桌面和390px页面/弹窗可用。测试素材为合成色块，未使用生产用户数据或真实模型生成。
- 浏览器提交两张带参考图任务后，用注入的 mock provider 处理隔离队列，断言固定上下文、模型、单图请求和参考图数量，两个任务 succeeded。候选预览的公共素材基地址沿用生产构建，新增测试资产 URL 的跨域预览不作为正式图片显示证明；图片组件显示与 PNG/ZIP 验收使用隔离本地合成素材。真实中转付费兼容性仍未验证。
- 正式站：登录态下实际打开新菜单和页面，接口/静态资源成功；旧0.2.1客户端发现0.3.0并弹更新提示，点稍后后再次检查不重复弹；重新加载进入新版本。公网 config/login 均200且 `X-SD2-Origin: server-42-193`。生产固定上下文和两种价格仍为空，生成保持禁用并提示先完成设置。
- 本地 Mac dev 服务因磁盘读取等待较长停止，未用它替代正式验收；服务器隔离预览与转发已停止。原 tasks 文档改动完整保留。临时截图 `/tmp/sd2-image-ui-desktop.png`、`/tmp/sd2-image-ui-mobile.png`、`/tmp/sd2-image-ui-settings-mobile.png`、`/tmp/sd2-image-production.png`；可重新生成，未作为长期资料外发。
- 后续唯一业务前置：管理员输入真实固定上下文及 Flare/Sunburst 单价。0 仅代表不扣站内积分，不代表中转免费。未获额外授权，未执行真实付费生图。
- 守门员：涉及权限/点数/队列，独立只读审查与隔离运行验证已补齐；无本轮分级误判。未改视频生成/扣费规则，未覆盖生产资产。

## 9. 文件与命令对账

以下路径均相对于 `/Volumes/Data/Projects/video-api-debugger-v12-full-todo`，未列入文件的旧改动不属于本次发布。

| 文件 | 本轮用途 |
|---|---|
| src/app/image-studio/page.tsx | 登录保护与页面入口 |
| src/app/image-studio/studio.tsx | 上传、张数、提交、结果、下载、自动保存与刷新恢复 |
| src/app/image-studio/studio.module.css | 独立工作区与响应式样式 |
| src/app/api/image-studio/settings/route.ts | 设置读取、管理员写入、参数检查 |
| src/app/api/image-studio/tasks/route.ts | 提交与本人分页记录 |
| src/app/api/image-studio/download/route.ts | 鉴权 PNG/ZIP 下载 |
| src/lib/image-studio/settings.ts | 模型、上下文、价格及版本冲突检查 |
| src/lib/image-studio/provider.ts | 文生图/双图请求适配 |
| src/lib/image-studio/tasks.ts | 幂等、冻结/结算、任务持久化与所有权 |
| src/lib/image-studio/worker.ts | 队列、上游处理、保存与过期恢复 |
| src/lib/image-studio/media.ts | 图片验证与安全读取 |
| src/lib/navigation.ts | 所有登录用户的菜单入口 |
| src/lib/release.ts | 更新提醒摘要 |
| prisma/schema.prisma | 独立图片任务模型 |
| prisma/migrations/20260920090000_image_studio/migration.sql | 增量建表与索引 |
| scripts/process-image-studio.ts | 持续处理与优雅退出 |
| scripts/sd2-image-studio.service | 生产 worker 服务 |
| scripts/image-studio-provider-smoke.ts | 上游协议模拟验证 |
| scripts/image-studio-integration-smoke.ts | 隔离业务验证 |
| package.json、package-lock.json | 仅版本号0.3.0，无依赖变更 |
| AGENTS.md | 正式来源与后续读取入口 |
| tasks/todo/2026-09-20-gpt-image-studio.md | 任务、证据、风险和上线记录 |

执行并通过的主要命令：

```sh
node node_modules/typescript/bin/tsc -p /tmp/sd2-image-studio-tsconfig.json --noEmit
node --import tsx scripts/image-studio-provider-smoke.ts
env DATABASE_URL=file:/tmp/sd2-image-studio-test-r2.db node --import tsx scripts/image-studio-integration-smoke.ts
NEXT_DIST_DIR=.next-prod-candidate-image npm run build
unzip -t /tmp/sd2-image-ui-download.zip
git diff --cached --check
```

完整发布差异：https://github.com/goukiyang/seedance-api-debugger/compare/53d02740e935920aac7776f27ea44763dd0c1f44...6a95da91eeb6ac0b6c4bc6e1f571f895cae746b5 。本地同等命令：`git diff 53d0274 6a95da91`。

账号页实测显示 SD2 v0.3.0，手动检查更新显示“当前已是最新版本”。上线后再次检查五个服务均健康，图片任务表为0条，确认没有产生生产付费测试任务。清理本机 `.next-image-test` 时强制删除命令被工具拒绝，未改用绕过方式；临时构建留在本地，未提交、未上传、无运行服务。
