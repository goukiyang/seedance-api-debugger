# GPT Image 独立生图页与固定上下文

## 1. 大白话目标复述

新增独立图片生成页面：所有登录用户可用；仅管理员编辑全站固定上下文，自动保存；参考图片选填，最多两张；正文输入、快捷与自定义生成张数、生成结果预览与单张/批量下载。不做连续修改。来源：本任务用户确认，2026-09-20。

生产目标 https://sd2.youdooart.com；部署源 /Volumes/Data/Projects/video-api-debugger-v12-full-todo。2026-09-20 已从 53d0274 / v0.2.1 升级至独立发布提交 6a95da91 / v0.3.0。本地 7e1940f 的批量视频下载修复未发布，未混入本次上线。

## 2. 具体可执行任务

| 编号 | 任务 | 完成标准 | 当前状态 |
|---|---|---|---|
| I1 | 核对接口与现有能力 | 确认真实模型、计费及复用入口 | 已完成；真实模型已核实，独立单价由管理员设置 |
| I2 | 实现生图页与上下文设置 | 权限、上传、生成、保存、下载完整衔接 | 已完成；v0.4.0 修复交付并通过真实上游测试，见第12节 |
| I3 | 验证与发布 | 检查通过，线上页面可用并有回退点 | 已完成；v0.4.0 已上线，登录页面与回退点已核验，见第12节 |

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

## 10. 真实图片失败根因调查（2026-09-20）

用户报告“本次未能交付图片，冻结积分已释放。上游结果未确认”。本节替代此前“仅剩管理员配置”的交付判断；历史模拟测试结果保留，但不能作为真实上游兼容性通过的证据。

| 编号 | 任务 | 完成标准 | 状态 |
|---|---|---|---|
| F1 | 查明图片生成失败根因 | 找到实际失败环节与证据，明确修复方案 | 已完成；同输入真实调用复现 URL 被忽略，随后安全下载器报 ERR_INVALID_IP_ADDRESS |

### 已验证证据

- 正式代码仍为 `6a95da91` / v0.3.0；图片 worker active、NRestarts=0。生产任务只有同批两张失败，模型 `gpt-image-2.5-flare`、2张参考图，从提交到终态分别28.321秒和57.722秒，均无 asset_id。
- 只读积分账本核实：2笔冻结共100积分，2笔失败返还共100积分。站内积分已退，不等于中转费用也退。
- 用既有配置只读请求中转 `/api/log/token`，两次原请求均为 `/v1/images/edits`，消耗记录 type=2、上游耗时25秒和27秒，各有quota=40000；未读取或输出密钥、提示词、固定上下文、参考图内容。
- 中转官方文档 https://api.muskapis.com/docs/zh-CN/api/image 明确输出可为Base64或URL，示例是 `data[].url`。将该格式注入正式适配器（无网络生成）时立即复现“图片服务未返回可保存的图片”；`data[].b64_json` 对照被接受。
- 用户先授权1张付费诊断，随后将上限放宽至10张；本轮实际只发出1次生成请求，复用失败任务输入，未调用站内提交/扣费、未写生产任务或积分、未自动重试。
- 真实诊断在28.266秒得到HTTP200，响应顶层字段为 `created,data,output_format,quality,size,model,usage`；唯一图片字段是 `url`，无 `b64_json`。当前 `provider.ts:34` 忽略该图片，抛“图片服务未返回可保存的图片”。由真实同输入调用确认返回解析缺陷，原两次响应正文因代码丢弃而无法追溯逐字内容。
- 使用既有 `readStudioImage` 尝试下载这张真实输出，得到 `TypeError / ERR_INVALID_IP_ADDRESS / Invalid IP address: undefined`。服务器Node v20.20.2，DNS lookup回调收到 `options.all=true`，现有代码返回单IP参数而非地址数组。对公开静态文件使用正确回调形状的独立只读对照得到HTTP200；未因此修改生产代码。
- `worker.ts:30` 的无参数catch还会丢弃失败阶段、原始错误和HTTP状态，把请求、解析、保存问题都写成“上游结果未确认”，因此首次线上报错无法直接定位。测试图片未成功落盘，不宣称已经拿到可播放/下载的交付结果。

### 修复边界与待验收

- [x] 兼容Base64及HTTPS URL输出，沿用安全取图、图片格式/尺寸校验和本地资产保存；不能仅添加 `response_format` 参数后假定中转一定遵守。
- [x] 修正固定DNS地址下载器的单地址/数组回调，保留私网阻断、DNS固定、大小/超时/重定向限制；不通过移除安全检查绕过错误。
- [x] 记录脱敏的失败阶段、HTTP状态、错误类别及可用请求编号；不写密钥、原始上下文、图片Base64、签名URL。区分生成拒绝、结果未知与生成成功但交付失败，不自动重新付费生成。
- [x] 补全URL/Base64、真实Node20下载、危险地址拒绝、保存/结算失败、单次请求不重发的回归；修复后在剩余授权预算内做最小真实取图、持久保存、页面刷新预览与实际下载验收。
- [x] 以当前正式发布分支隔离发布修复，排除暂停的旧批量视频下载修改；保留候选构建和回退点，不覆盖既有失败任务/余额/用户素材。

本轮只进行诊断和固定记录更新；未改业务源文件、未重启/部署、未修改管理员设置或用户余额。临时诊断脚本 `/tmp/sd2-image-diagnose-once.cjs` 在本机及服务器，仅用于单次授权取证，没有密钥/提示词硬编码，不属于产品交付文件。守门员：真实付费动作按本轮授权执行1次；其余生产操作只读，无分级误判。

## 11. 修复与模块补充需求（2026-09-21，进行中）

用户追加并确认：图片或描述至少提供一种，图片支持Ctrl+V；模块可保存到账号下并跨电脑恢复，新建空白模块在下方排列，保留原模块及结果。每个模块有独立上下文，另设全站通用上下文，生成时共同生效。沿用原权限：上下文编辑及读取原文只对管理员开放，其他用户可使用模块和生成；模块/任务数据仍按账号隔离，不新增共享权限。

| 编号 | 任务 | 完成标准 | 状态 |
|---|---|---|---|
| F1 | 查明图片生成失败根因 | 找到实际失败环节与证据，明确修复方案 | 已完成 |
| F2 | 修复交付并补齐输入方式 | 支持链接取图、仅图片生成、粘贴图片 | 已完成 |
| F3 | 验证并上线 | 真实生成后可预览下载，正式页面生效 | 已完成 |
| F4 | 模块保存与新建 | 账号保存、下方追加、结果隔离、模块与通用上下文正确生效 | 已完成 |

- 范围：仅 image-studio 相关页面、接口、任务/下载器、测试和增量表结构，版本0.4.0。保持旧视频、Gemini/Seedream、积分规则不变。
- 新增 ImageStudioModule、ImageStudioTask.module_id 可空字段及索引；旧任务不回写、不迁移归属，默认模块查询兼容null记录。发布前一致性备份，只执行新增表/字段SQL，禁止全库db push。
- 模块草稿保存前保留本地恢复；显式保存/生成前保存到服务器；上下文设置自动保存并检查版本冲突。新建请求固定ID防止重复。模块列表每批12个，离屏模块不定时轮询；结果列表延用分批读取。
- 粘贴只进入当前活动模块，设置弹窗/预览期间不截取图片；纯文本粘贴保留原行为，上传中/提交未确认/达到2张限制不得重复加入。
- 同批统一验证：适配器URL/Base64与脱敏错误、Node20真实DNS下载、防私网；隔离DB模块权限/版本冲突/上下文快照/仅图生成/积分结算；候选构建；独立只读审查；真实页面保存/新建/粘贴/刷新、授权预算内真实生图与PNG/ZIP下载。付费上限10次，本轮此前已用1次，不自动耗尽预算。
- Git与发布：开发 codex/gpt-image-studio 仅精确暂存本轮文件；发布分支 codex/image-studio-release 从1dd19fe继承正式6a95da91，只引入本功能，排除旧批量视频下载修改。回退保留旧代码/构建和新表数据，不恢复覆盖用户数据库。

### 验证与审查（2026-09-21）

- 用户再次澄清：确认的是保存参考图、描述、张数和对应结果到账号，刷新或换电脑继续使用；新建在下方追加，旧模块不变。并未撤销后补充的两层上下文要求。
- provider smoke、隔离 SQLite integration smoke、TypeScript及服务器候选生产构建通过。验证URL/Base64、危险地址拒绝、Node20下载、模块归属与版本冲突、图片单独输入、上下文快照、积分成功结算/失败释放；保留现有无关CSS/React warning。
- 独立只读审查发现并已修复：非首模块重新加载引发通用设置旧草稿回写、上传中编辑上下文的补保存、未保存上下文离页保护、GET/PUT交错覆盖。最终只读复核通过。上下文原文不写浏览器本地存储，只保存服务端；普通用户接口不返回原文，越权写入实测403。
- 隔离候选浏览器：真实管理员/普通用户测试账号登录；原生剪贴板图片+Command/Ctrl+V成功；空白不可生成、仅图片可生成；模块保存服务端并刷新恢复，新建追加第二模块不影响第一模块。1440px与390px截图已检查，390px无横向溢出。
- 在隔离测试账号调用真实上游2次（加诊断1次，总计3/10次），仅图片请求21.08秒、仅文字请求20.28秒，均succeeded并写入图片资产，未修改生产账号积分。浏览器真实PNG下载完成并确认为1264x848有效图片。模块结果查询、权限与存储使用候选版本实际接口，不用伪造响应冒充成功。
- 临时运行证据：`/tmp/sd2-image-modules-desktop.png`、`/tmp/sd2-image-modules-mobile.png`、`/tmp/sd2-image-fix-native.png`；临时服务器候选`/tmp/sd2-image-fix-check`，测试数据与生产隔离。生产发布与最终公网验收另记，以上不冒充已上线。

## 13. 图片比例与生成结果删除（2026-09-21，进行中）

| 编号 | 任务 | 完成标准 | 状态 |
|---|---|---|---|
| A1 | 图片比例选择与管理 | 常用比例、自定义自动保存、悬停删除，生成实际生效 | 进行中 |
| A2 | 生成图片删除 | 单张删除、二次确认，刷新后不再显示，保留其他内容 | 进行中 |

- 已确认：增加常用比例下拉、其他输入、完成输入自动保存到选项、悬停删除自定义项；追加生成图片删除按钮。
- 实施：常用比例含自动、1:1、16:9及反向、4:3及反向、3:2及反向、4:5及反向、2:1及反向、21:9及反向、3:1及反向。自定义按账号保存，最多32项，等价比例去重；Enter/离开输入框提交，失败保留输入可重试。移动端/键盘同样能删除。比例随模块保存，并在任务提交时快照为实际size，旧任务自动比例/旧提交幂等保持兼容。
- 模型尺寸范围1:3至3:1、16像素倍数。保持约1MP（655360至1572864像素），优先精确比例，不可整除时展示取整请求尺寸，不擅自裁切/拉伸。记录实际返回尺寸，不把请求参数冒充实际结果。
- 删除仅本人已生成结果，经二次确认软删除任务展示；不物理删共享Asset/源文件、不删积分流水、不退已消耗积分。下载API拒绝已删除结果，前端去掉选中项并防在途轮询回插。
- 范围仅image-studio、4个纯新增列、对应测试、版本0.5.0和固定记录。视频/其他图片模型、积分策略、权限范围不变。保护未提交todo及旧未发布视频下载代码，干净发布分支从f9c54bb接续，运行回退点96585c3。
- 复用核验：已读[OpenAI Node开源SDK images.ts](https://github.com/openai/openai-node/blob/master/src/resources/images.ts)的size声明及[官方模型参数](https://developers.openai.com/zh-Hans/api/docs/guides/image-prompting)，不引入SDK/新依赖；沿用项目fetch、Prisma和lucide。中转[官方绘图文档](https://api.muskapis.com/docs/zh-CN/api/image)的非lean源包可读，size示例1024x1024，但无2.5细节，真实中转支持须另验，不能只凭OpenAI声明判定。
- 验收统一进行：比例解析/JSON和multipart传参/尺寸限制；账号隔离/模块保存/任务快照/幂等；删除重复请求/越权/计费不变/资产保留；真实浏览器下拉、输入自动保存、刷新、hover、取消/确认删除；只读审查和正式候选发布、升级提醒。真实生图沿用此前10张授权上限，已用3张，最多再用2张验证比例，不自动重试。

### 同版本检查与集中修正

- 首轮构建及类型通过。测试5:3预期误写1280x768，算法实际1360x816离1048576像素更近，两个断言集中修正，不改已验证的尺寸计算。补齐精细小数约分后可重复解析校验、删除收藏不改变已选模块比例，以及dialog居中/盒尺寸。
- 复测provider smoke和全套隔离SQLite integration smoke通过，含自定义等价去重/32项限制/账号隔离、模块比例保存、任务size快照、旧请求幂等、越权/非成功拒删、重复软删除、Asset保留、积分和流水完全不变。
- 同候选真实Flare调用2次：文生图5:3请求/返回1360x816，27.912秒；带参考图9:16请求/返回720x1280，19.588秒。均已持久化PNG，不拉伸不裁切；用隔离测试账号，不写生产任务/积分。累计已用5/10次原授权，不再重复付费复测相同provider代码。
- Ego浏览器隔离候选实际通过：4:1提示并阻止生成；10:6自动约分5:3并存服务端，保存模块后刷新恢复；悬停删除比例列表项成功；删除图片取消保留4张、确认后3张、选中清零、刷新仍3张；390px无横向溢出。首轮移动弹窗靠左上问题已纳入上述集中修正，最终视觉复测待补。
- 固定只读任务“审核001 - sd2 固定只读审查”审查通过（2026-09-21）；审查者未做生产写入/付费/提交。最终补丁及发布脚本另交其复核。
- 无关 `tasks/todo.md:43` 原有空行导致全库diff检查失败，本轮未覆盖；发布前以本轮精确文件再检查，不把无关脏改纳入发布。

## 12. v0.4.0 最终交付（2026-09-21）

- 正式入口：https://sd2.youdooart.com/image-studio 。运行提交 `96585c3901cab78a225f0aaa3397362040187149`，BUILD_ID `y9OeME-1zJRJHFWWZrmfu`；开发功能提交 `9073b1ec3a354ab840661f99c057c63cf105f9e1`。两个分支均已推送并远端复核。本节关闭第10节的修复待验收项；历史失败记录不删除、不自动重试扣费。
- 发布归档排除 `.env*`、上传、视频、storage、DB等运行数据；上传前后 SHA256 一致：`fe9ba3f2ba84a70e47e89f05566a715d3745e22ac2f713be46d3d4e9318ba33e`。发布窗口已登记并确认，本次流程实际执行守门检查，而非只写配置。
- 一致性备份、旧源码与旧构建位于 `/srv/video-api-debugger/backups/image-modules-96585c3901cab78a225f0aaa3397362040187149/`；回退tag `rollback/2026-09-21-before-image-modules` 已推送并指向6a95da91。先执行事务内纯增量SQL，再生成Client与候选构建，旧任务归属不回写。回退保留新增表/字段，不覆盖上线后用户数据。
- 部署脚本独立审查通过：修正增量SQL先后顺序、两次构建目录移动间失败的回退、逐服务健康检查。新构建通过后切换 `.next-prod`，主服务/图片worker/积分网关/积分timer/飞书relay逐一active；主服务和图片worker均NRestarts=0。
- 公网 `/api/config`、`/login` 返回200且来源 `server-42-193`；本机3302 API200；`/api/release` 为0.4.0。浏览器实际加载 `/_next/static/chunks/app/image-studio/page-69c4a94993c4b7b2.js`，该资源公网200。
- 已登录正式账号打开新页面，通用上下文/模块上下文/保存模块/新建模块入口可见。原有2张参考图、正文和生成张数2保留；按原内容保存为“模块1”，刷新后服务端仍为saved=true、2refs、count=2；原2条失败历史保留。未添加生产测试任务、未改生产上下文或用户积分。
- 更新提醒真实验证：保持旧0.3.0页面，正式发布后收到0.4.0提醒；“稍后”持久去重，手动检查可重新打开；点击立即刷新并确认后载入0.4.0，检测完成清除旧提醒记录。标题“发现新版本”20px加粗，摘要对应本次功能。
- 真实测试生成共3次（诊断1+修复验收2，授权上限10）；修复验收使用同版本隔离账号/数据库和真实上游，输出都成功持久保存。原生浏览器PNG、2张ZIP均成功下载，`unzip -t` 两个条目均OK，图片实际加载。正式站未重复付费测试，权限/积分未被测试篡改。
- 截图临时证据：`/tmp/sd2-image-modules-production.png`、`/tmp/sd2-image-update-production.png`、`/tmp/sd2-image-modules-results.png`。PNG/ZIP证据 `/tmp/sd2-image-fix-native.png`、`/tmp/sd2-image-fix-native.zip`。预览服务和SSH转发已停止；临时文件不进入发布。
- 守门员：涉及上下文权限、任务与增量表，已独立只读审查、隔离业务验证与可回退发布；无本轮分级误判。未改视频/Gemini/Seedream规则或依赖，原有无关todo和本地构建目录未覆盖/提交。

## 14. 独立图片模型与 API 通道（2026-09-22，进行中）

| 编号 | 任务 | 完成标准 | 状态 |
|---|---|---|---|
| M1 | 独立图片 API | 图片生成只读取 `image_generation_api_v1`，不读取 GPT-5.5 共用 Musk 配置；新增 `https://api.ai-media.vip/v1` 可选通道 | 已实现，待上线验证 |
| M2 | 模型目录 | 图片页可选 Banana 2、Banana Pro、GPT Image 2、GPT Image 2.5 Flare、GPT Image 2.5 Sunburst，并映射到真实上游模型 ID | 已实现，待上线验证 |
| M3 | 上游成本 | 记录每张图片的美元成本快照；Banana 2 `$0.06`、Banana Pro `$0.096`、Flare/Sunburst `$0.064`；GPT Image 2 价格待补充，不擅自推算 | 已实现，待上线验证 |
| M4 | 回归与发布 | 类型、Lint、构建、协议 smoke 通过；数据库增量迁移、服务重启、公网 `/image-studio` 与图片专用配置验证 | 进行中 |

实现边界：上游美元成本与用户站内积分分开保存；GPT Image 2 可展示但成本显示“待配置”，避免把未确认价格写成事实。生成张数和生成按钮位于画面描述下方；比例默认显示“自动（跟随原图）”。用户后续追加的大图空白处关闭、左右键切图属于下一项预览交互，待本批上线后补做。

### M4 发布结果（2026-09-22）

- 发布提交：`ac5999c091a44e6c910523eec7b14a40d90aca5e`，版本 `0.7.0`；回退 tag：`rollback/2026-09-22-before-musk-image-api`。
- 服务器源码归档 SHA256：`8e1b8f6aa1df65e5f667605ecd6f900c7b82f3dbf69ba87b41c9603264efe261`；运行目录 `/srv/video-api-debugger/app`，上一版构建保留在 `.next-prod-prev-ac5999c`。
- 生产数据库先做 SQLite backup，再只增量增加 `ImageStudioTask.provider_cost_usd`；未执行 `prisma migrate deploy`，未覆盖旧迁移、资产、任务或积分流水。
- 线上候选构建 BUILD_ID：`D32tj9inwbmObNl9niewb`；`sd2-gray.service` 与 `sd2-image-studio.service` 均 active，NRestarts 均为 0；公网 `/api/release` 返回 `0.7.0` 和本次图片模型摘要。
- 公网静态资源验证包含：Banana 2/Pro、GPT Image 2、Flare、Sunburst、`自动（跟随原图）`、20000 字限制和 `api.ai-media.vip`；浏览器自动化工具本轮连接超时，未把它冒充成登录态视觉验收。生产未执行付费生图。

本轮17个修改文件及用途（相对上述正式源码目录）：

| 文件 | 修改内容 |
|---|---|
| `src/app/image-studio/studio.tsx`、`studio.module.css` | 多模块保存/新建、两层上下文、仅图生成、原生粘贴、保存冲突保护及响应式排列 |
| `src/app/api/image-studio/modules/route.ts`、`src/lib/image-studio/modules.ts` | 账号隔离模块存储、分页、版本冲突、上下文权限 |
| `src/app/api/image-studio/tasks/route.ts`、`src/lib/image-studio/tasks.ts` | 按模块查结果、上下文快照、兼容旧记录及无描述输入 |
| `src/lib/image-studio/provider.ts`、`media.ts`、`worker.ts` | URL/Base64输出兼容、Node20固定DNS取图、脱敏失败阶段 |
| `prisma/schema.prisma`、`prisma/migrations/20260921001000_image_studio_modules/migration.sql` | 模块表、可空任务归属字段和索引 |
| `scripts/image-studio-provider-smoke.ts`、`scripts/image-studio-integration-smoke.ts` | 协议/安全与权限/保存/任务回归 |
| `package.json`、`package-lock.json`、`src/lib/release.ts` | 唯一版本0.4.0及更新摘要，无依赖变化 |
| 本todo | 确认需求、问题、验证和发布证据 |

本轮通过的主要命令（测试DB与生产隔离）：

```sh
STUDIO_PUBLIC_DOWNLOAD_TEST=1 node --import tsx scripts/image-studio-provider-smoke.ts
DATABASE_URL=file:/tmp/sd2-image-studio-test-fix-r2-20260921.db node --import tsx scripts/image-studio-integration-smoke.ts
node node_modules/typescript/bin/tsc -p /tmp/sd2-image-studio-tsconfig.json --noEmit
NEXT_DIST_DIR=.next-prod-candidate-image-modules npm run build
unzip -t /tmp/sd2-image-fix-native.zip
git diff --check -- src/app/image-studio src/lib/image-studio prisma/schema.prisma
```

统一diff：https://github.com/goukiyang/seedance-api-debugger/compare/1dd19fe1a72ee57fdd1571d6c7eb3a0f182a7dbf...96585c3901cab78a225f0aaa3397362040187149 。本地副本 `/tmp/sd2-image-modules-v0.4.0.diff`。未关闭的问题：无本轮阻塞项；历史失败图片无法按原响应追回，须由用户决定是否重新生成。

## 14. A1-A6 图片生成闭环补强（2026-09-21，发布前）

| 编号 | 任务 | 完成标准 | 状态 |
|---|---|---|---|
| A1 | 比例选择与保存 | 常用/自定义比例、实际尺寸传递、模块/任务快照、旧请求兼容 | 本地实现与验证完成，待线上验收 |
| A2 | 结果删除 | 本人软删除、二次确认、刷新不回插、Asset/积分流水保留 | 本地实现与验证完成，待线上验收 |
| A3 | 生成结果进入资产库 | 复用既有 Asset 归档、权限和筛选；图片列表不依赖上传素材开关 | 本地实现与验证完成，待线上验收 |
| A4 | 完整生成快照与重新生成 | 保存上下文/模块/提示词/模型/张数/比例/参考图等；恢复不自动提交扣费，未保存内容有保护 | 本地实现与隔离验证完成，待线上验收 |
| A5 | 模块级模型与定价 | 模型/价格归属模块；管理员价格权限；服务端按当前模块规则计费，历史价格不影响新扣费 | 本地实现与隔离验证完成，待线上验收 |
| A6 | 参考图上限 | 选择、上传、粘贴、保存、复现、服务端和 Provider 统一最多10张 | 已实现，10张上游生成待确认 |

- 本轮新增迁移为纯增量列：模块 `model`、`prices_json`、`reproduce_task_id`，任务 `snapshot_json`；存量模块/任务按旧字段和全局历史默认值兼容，任务快照不回写。
- 复现来源已持久化到模块并按当前账号校验；历史复现只冻结历史全局/模块上下文，真正提交使用用户当前确认的参考图；编辑提示词、比例、张数、参考图、模型和积分不会隐式退出，只有显式退出历史模式或管理员修改模块上下文才退出；上传或保存中不能恢复；生成成功后清除历史绑定。
- 资产库 generated-only 改用 `Asset EXISTS ImageStudioTask` 的参数化有界查询与 count，普通用户仍固定按本人资产权限筛选；删除生成记录只隐藏任务展示，不删共享 Asset 或积分流水。
- 版本由 `0.5.0` 升为 `0.6.0`（SemVer MINOR），更新摘要通过既有 ReleaseNotice 唯一版本来源。
- 验证通过：`npx prisma generate`；`npm run lint`（仅保留既有全库 warning）；定向 `tsc`；provider smoke；隔离 SQLite integration smoke（含跨设备模块 source、历史上下文保持、当前参考图生效、权限、幂等、结算/退款、PNG、软删）；候选 `npm run build`；精确范围 `git diff --check`。没有新增付费调用。
- 固定只读审核线程复审通过，确认曾发现的 `saveModule(null)` 旧 revision 清除风险已修复；审核记录已追加到 `tasks/audit-001-review.md`。正式服务器发布、候选切换、线上页面与 A1/A2/A3/A4/A5/A6 浏览器证据待本节后续补记。
- 上游风险已反馈主控：MuskAPIs 官方文档本轮只明确多图融合传两张，不能把文档示例推断为供应商保证十张；本轮不做真实付费十图测试，不在产品记录中宣称上游已支持十张。

## 15. v0.6.0 A1-A6 正式发布收口（2026-09-21）

| 编号 | 任务 | 完成标准 | 状态 |
|---|---|---|---|
| A1 | 比例选择与保存 | 常用/自定义比例、实际尺寸传递、模块/任务快照、旧请求兼容 | 已完成 |
| A2 | 结果删除 | 本人软删除、二次确认、刷新不回插、Asset/积分流水保留 | 已完成 |
| A3 | 生成结果进入资产库 | 复用既有 Asset 归档、权限和筛选；图片列表不依赖上传素材开关 | 已完成 |
| A4 | 完整生成快照与重新生成 | 保存完整设置；恢复不自动提交扣费，未保存内容有保护 | 已完成 |
| A5 | 模块级模型与定价 | 模型/价格归属模块；管理员价格权限；服务端按当前规则计费 | 已完成 |
| A6 | 参考图上限 | 选择、上传、粘贴、保存、复现、服务端和 Provider 统一最多10张 | 已实现，10张上游生成待确认 |

- 正式目标：`https://sd2.youdooart.com/image-studio`；发布分支 `codex/image-studio-release`；代码提交 `3ca1728c34bb22c677a730222bfec8e9baf29a88`；版本 `0.6.0`；生产 BUILD_ID `ds5-BZ7DJjoAJQRSjb7OI`。
- 发布归档：`/tmp/sd2-image-studio-a6-3ca1728-v2.tar`，本地与服务器 SHA256 均为 `cf90767f6b86142294fb09f34caaf93e3bde1c3c8cbdb08b93cee9a6275b23c8`；运行期 `.env`、`node_modules`、`.next-prod`、上传、视频、storage 和数据库未随源码包覆盖。
- 数据库：先停止图片 worker，备份 `/data/video-api-debugger/var-lib/dev.db` 到 `/srv/video-api-debugger/backups/image-studio-a6-3ca1728/dev.db`，备份 SHA256 `792dc45e8aba8c5e6bfc37fc72e28f81a938138e688f9dd9d0b8af08e538aded`；仅执行 `20260921110000_image_studio_module_settings_snapshots` 纯增量 SQL，前后 `PRAGMA quick_check=ok`。
- 回退：`rollback/2026-09-21-before-image-studio-a6` 已推送，解引用指向发布前线上 `629a692c9e32cb2267062ded08852c4c3d5790ef`；旧构建保留为服务器 `/srv/video-api-debugger/app/.next-prod-prev-a6-3ca1728`。
- 服务与公网：`sd2-gray.service`、`sd2-image-studio.service` active，健康周期后均 `NRestarts=0`；本机 `127.0.0.1:3302/api/release`、公网 `/api/release` 均为 `0.6.0`，公网 `/login` 和新 BUILD_ID 的 `_buildManifest.js` 为200，匿名 `/image-studio` 按预期跳登录；来源头为 `server-42-193`。
- 浏览器验收（TaskSpace4，正式管理员登录态）：新版本页面显示参考图 `2/10`，仅证明当前计数/上限显示，不证明已在浏览器完成10张选择或粘贴；比例菜单包含常用比例、自定义“其他”及 `3:1/1:3`；模块设置展示模型与管理员积分单价并提示自动保存；生成结果在资产页默认“图片”筛选中可见；点击历史“重新生成”仅恢复表单并明确提示点击“生成图片”后才创建任务扣积分；删除确认已打开并点击“取消”，未删除生产数据。旧客户端的更新提醒已实际显示并通过“立即刷新”载入0.6.0；本轮未重复验证“稍后/手动重新打开”与未保存草稿拦截，沿用既有 v0.4.0 证据。
- 隔离候选上限回归（不接生产数据库/存储）：TaskSpace4 在 `localhost:3408` 先用文件选择累计9张，再用合成粘贴加入第10张；继续粘贴第11张后显示“最多选择10张参考图”，前10张仍保留为 `10/10`。模块自动保存后刷新页面仍为 `10/10`，隔离 SQLite 中该模块 `reference_ids` 数组长度为10、revision为4。未点击生成、未扣费；临时 Next 服务、SSH 隧道和3408端口已关闭。
- 验证命令：候选 `npm run build`、候选本机 `/api/release`/`/api/config`/`/login`；公网 `/api/release`/`/api/config`/`/login`/`/image-studio`/静态 BUILD_ID；图片 Provider smoke、隔离 SQLite integration smoke、定向 `tsc`、精确范围 `git diff --check`；均通过。未执行真实付费生成，未确认上游十图能力，未确认删除生产记录。
- 上游限制保持不变：MuskAPIs 官方资料本轮只明确两张图融合；产品可保证本地选择/保存/服务端/Provider 的最多10张边界，但不能宣称供应商已保证十张上游生成能力。

## 16. F2 9月21日参考图失效修复（2026-09-21）

| 任务 | 完成标准 | 状态 |
|---|---|---|
| F2 | 受影响 Asset 恢复公网访问；生成页同源浏览器能加载参考图；运行目录不会随发布再次脱离持久盘 | 已完成 |

- 根因：`Asset.original_url` 和 `hash` 没有错误，反馈中的 7938、ea0f、c88f 三个文件都在 `/data/video-api-debugger/var-lib/uploads/assets`，文件内容 SHA256 与文件名一致；A6 发布后 `/srv/video-api-debugger/app/public/uploads` 却是普通目录，三文件只在持久盘、没有出现在发布目录，所以本机 3302 和公网 `/uploads/assets/...` 均 404。同期 `public/videos` 也是普通目录，`storage` 缺失；这是发布后运行目录软链未落地且没有被 preflight 拦截，不是数据库 URL 失效，也不是 `/uploads` 动态路由代码失效。
- 生产恢复：停写并核对 `sd2-gray.service`、`sd2-image-studio.service`、视频/备份 timer 后，保留两侧清单和 SHA256；uploads 侧补回 app-only 文件，videos 侧保留 shared 旧冲突文件并以当前 app 版本合并，storage 直接接回持久盘；随后恢复为：`public/uploads -> /data/video-api-debugger/var-lib/uploads`、`public/videos -> /data/video-api-debugger/var-lib/videos`、`storage -> /data/video-api-debugger/var-lib/storage`。回退资料与 50 个视频冲突文件副本位于 `/data/video-api-debugger/var-lib/backups/f2-runtime-recovery-20260921-163402/`；原发布目录副本保留在 `/srv/video-api-debugger/app/public/.f2-original-20260921-163402-*`。未改数据库、Asset URL、反馈状态、积分、用户素材内容，也未触发付费生成。
- 真实结果：7938、ea0f、c88f 三条受影响 Asset 以及 9月21日反馈截图 fd3e 的公网 `HEAD/GET` 均为 200，完整下载 SHA256 与 Asset hash 一致，`Range: bytes=0-1023` 均返回 `206/1024`。登录态浏览器在正式 `/generate` 页面上下文中用同源 `HEAD + Image` 加载四张图，均 `loaded=true`；前三张实际尺寸 `1672x941`，反馈截图 `1749x1014`。截图工具单独取图超时，未把它冒充为截图通过；浏览器图片节点与尺寸证据仍有效。
- 防复发：`ops/server/sd2/preflight.sh` 新增运行目录软链、`/var/lib -> /data` 映射、持久目录、目录写权限、图片 worker/timer active 和主服务/图片 worker `NRestarts=0` 检查；`ops/server/sd2/cutover-commands.md` 将发布前/切换后的两次 preflight 写成同一发布的强制门禁；`scripts/server-runtime-dirs-smoke.ts` 固化脚本和入口检查。以后 preflight 遇到普通目录、目标不在 `/data/video-api-debugger/var-lib`、运行 unit 不健康或 `gouki` 不可写时直接失败，不进入发布验收。
- 生产健康：恢复后 `sd2-gray.service`、`sd2-image-studio.service`、`sd2-finalize-pending.timer`、`sd2-video-delivery.timer`、`sd2-backup.timer` 均 active，主服务和图片 worker `NRestarts=0`，本机 `127.0.0.1:3302/api/config` 通过。反馈记录仍保留为原始证据，未自动改为已处理。
- 本轮验证：`node --import tsx scripts/server-runtime-dirs-smoke.ts`、`bash -n scripts/server-ensure-runtime-dirs.sh ops/server/sd2/preflight.sh`、精确 `git diff --check` 通过；公网四个素材的 HEAD/GET、SHA256、Range 及登录态浏览器图片加载通过。未做生成、扣费或数据库写入。
- 防复发门禁已落到实际服务器：本地/发布分支/服务器 `/srv/video-api-debugger/app/ops/server/sd2/preflight.sh` 的 SHA256 均为 `2d6aad75af2aa31b7e7b307c06993bb1c744467bcb4b4c009263f03c99f4dd8b`；旧服务器脚本保留为 `/srv/video-api-debugger/app/ops/server/sd2/preflight.sh.f2-before-20260921`。服务器实际文件已通过 `bash -n`，本地控制端执行 `EXPECT_PROD_ON_SERVER=1 SERVER=root@42.193.221.253 bash ops/server/sd2/preflight.sh` 通过。仓库和服务器均未发现独立 A6 发布脚本，正式切换统一受 `ops/server/sd2/cutover-commands.md` 的发布前/切换后双 preflight 门禁约束。

## 17. F3 生成提示词上限调整（2026-09-21）

| 任务 | 完成标准 | 状态 |
|---|---|---|
| F3 | `/generate`（含共用 IP 入口）的输入、粘贴、恢复、保存、服务端请求统一允许最多 20,000 字；20,001 字明确阻止；正式页面刷新可见 | 已完成 |

- 已定位：`src/components/PromptEditor.tsx` 与 `src/components/GenerationComposer.tsx` 当前限制为 2,000；`/api/tasks/create` 与 `/api/ip/tasks/create` 没有主提示词同等长度拒绝，但 Agent/最终快照会截到 12,000，导致输入、保存和请求口径不一致。
- 独立入口暂不纳入本轮：`/image-studio` 画面描述为 12,000，`/tools/ultimate-canvas` 提示词为 12,000；除非另行确认，不改成视频生成提示词的 20,000 规则。
- 执行计划：建立视频生成提示词共享上限常量；更新主输入框、放大编辑、引用标记插入和程序化恢复的超限提示；两条视频创建 API 在扣费/创建任务前拒绝 20,001 字，并把快照上限同步到 20,000；补隔离边界 smoke 和正式 `/generate` 页面验收，不调用真实生成、不扣费。
- 验收证据：共享常量边界测试、前端源码/服务端源码检查、服务器候选 `npm run build`（含类型检查）通过；本地 `npm run lint` 在本机无输出长时间未结束，正式构建仅保留既有 lint/Autoprefixer warning。正式页面刷新后计数显示 `0 / 20000`，20,000 字可保留，20,001 字显示超限且不允许提交；公网 `/api/config`、`/api/release` 与 4 张 F2 图片回归继续通过。

### F3 实施与正式发布结果

- 共享 `MAX_GENERATION_PROMPT_CHARS = 20_000`，主 `/generate` 与 `/generate/ip` 共用；主输入、放大编辑、引用/mention 插入、方案生成、草稿/历史恢复、提交按钮和两条创建 API 均按同一边界处理。20,001 字不再被 `maxLength` 或 `slice` 静默截短，而是显示“提示词最多 20000 字，当前 20001 字”并阻止提交。
- `/api/tasks/create` 与 `/api/ip/tasks/create` 在扣费/建任务前校验用户提示词、方案提示词快照和最终提示词快照；快照不再截到 12,000。H3 后续添加的系统上下文仍按既有流程保存，不把系统追加文本误当成用户输入超限。`/image-studio` 与 `/tools/ultimate-canvas` 的独立 12,000 字规则未改。
- 版本由 `0.6.0` 升为 `0.6.1`，`/api/release` 更新摘要与实际 F3 变化一致。开发远端 `codex/gpt-image-studio` 为 `020dec7190eec61ee7df8cb27dc871abf292b32c`；正式发布分支 `codex/image-studio-release` 为 `de3865a9db8c9abafd5bf3763167c39e8dc3543f`；回退 tag `rollback/2026-09-21-before-f3-prompt-limit` 指向发布前 `b89140fcd357283c91c56db4cf3be30e501f8f14`。
- 正式包已按 SHA256 `8dca3fc3908a82ab77f39cc086178483231daa9898961a66fd0b736e9c4fd2d` 上传服务器；候选构建 `npm run build` 通过（保留既有 ESLint/Autoprefixer warning），候选 BUILD_ID `J52leeag6XyiHAgYAigqJ`。生产已切换到上述 commit / v0.6.1，旧 BUILD_ID `ds5-BZ7DJjoAJQRSjb7OI` 保留在 `/srv/video-api-debugger/app/.next-prod-prev-f3-de3865a9db8c`。
- 发布前、切换后和一个健康守护周期后的 `EXPECT_PROD_ON_SERVER=1 SERVER=root@42.193.221.253 bash ops/server/sd2/preflight.sh` 均通过；主服务与图片 worker active，`NRestarts=0`，公网 `/api/config`、`/api/release`、`/login` 正常，匿名 `/generate` 按预期跳登录。公网生成页静态 chunk 返回 200 并命中 `20000`。
- 已授权的 Xiaobo Chrome Agent Window 在刷新并核对当前版本后实际验收普通 `/generate` 与 `/generate/ip`：初始计数 `0 / 20000`；填入 20,000 字显示 `20000 / 20000`；填入 20,001 字显示明确超限文案，输入不以截断成功态保留，提交按钮 DOM 为 `disabled=true`。未点击生成，未扣点，未写数据库。
- F2 四个受影响公网图片在本轮切换后继续通过 HEAD 200、Range `206/1024`、完整下载 SHA256 与 Asset hash 一致：`7938d39d3028d0dde4e462cab0f1063b03c1bc1b8731dc20e74069d71d73318c`、`ea0fa44f2ac49d0721eca51f2a1cf058ff699041c2f4ba148cddc3171da88d66`、`c88f7f91074a3f4c5f08ef98fb95ffd4bdfc1075fcc33f29d444f66fdbf3af1c`、`fd3eb06425c0e97d95db477964b04592ad39120f52a4941e1d3651d12da94247`。
- 本轮没有真实视频/IP生成、付费上游调用、积分变更或数据库写入；原有 `tasks/todo.md`、`tasks/todo/hygiene-log.md` 和非本轮构建/素材脏改均未纳入 F3 提交。固定只读审核线程对 F3 专项结论为通过；其先前的 Seedance 2.5 审查结论未作为本轮证据使用。

## F4 模板保存、分组快捷栏与封面页（2026-09-22）

| 任务 | 完成标准 | 状态 |
|---|---|---|
| F4 | 新模板默认最高质量；模块底部可恢复默认、另存为管理员/我的模板；模板可在模板库新建应用；分组侧栏显示子项；所有模板提供 3:4 封面页；不影响既有分组分页、自动保存、生成结果和失败结果删除 | 已完成，线上可用 |

- 规则：GPT Image 2 默认高，Flare/Sunburst 默认最高，Banana 模型沿用模型唯一可用档位；切换模型时自动切换到该模型的最高可用档位。恢复默认只重置模块配置，不删除参考图、banner 或历史生成结果。
- 模板权限：管理员另存为的模板全员可见；普通用户另存为的模板仅本人可见。应用管理员模板时复制参考素材的资产记录到当前用户，保留同一存储文件但不越过资产 owner 权限。
- 页面：左侧“分组快捷栏”下展示当前分组的模板名称；新增“全部封面”入口，卡片整体 3:4，上方约四分之三显示 banner/首张参考图，下方约四分之一显示名称和描述，点击封面回到对应模块。
- 数据：新增 `ImageStudioPreset` 表和 `/api/image-studio/presets` 读写/应用接口；现有模块的全局积分、分组分页、自动保存、参考图最多10张及生成结果状态保持原链路。
- 发布证据：提交 `565c4cf` 已推送 `codex/gpt-image-studio`，回退 tag 为 `rollback/2026-09-22-before-image-studio-presets`；生产 `/srv/video-api-debugger/app/.deployed-commit=565c4cf`、版本 `0.10.0`、BUILD_ID `_eSwpKMD1JrDehWv5DKtv`；候选构建与本地 `npm run build` 通过，保留既有 lint/Autoprefixer warning。
- 数据库：生产数据库已备份到 `/data/video-api-debugger/srv-backups/image-studio-presets-20260922192207/dev.db`，原库与备份 SHA256 均为 `cecc1d9ea9a6c09b0e1e71f0e7f9ae50e140b73c38a7ae66b8d62468fac50b64`；模板表创建成功，`PRAGMA quick_check=ok`，迁移已标记 applied。
- 公网：`https://sd2.youdooart.com/api/release` 返回 `0.10.0`，公网静态图片生成 chunk 200 且包含“分组快捷栏 / 全部封面 / 另存为管理员模板”；匿名模板接口按预期返回登录要求。主服务 active，健康接口正常；图片 worker 由同一运行用户恢复为手动进程，因普通 SSH 用户无权执行 systemd start，`sd2-image-studio.service` 当前状态仍为 inactive，这是后续应补的服务权限问题，不影响当前进程处理但不符合长期托管标准。
- 回归边界：未执行真实付费生图、模板跨账号实际应用或删除生产数据；浏览器自动接管当前前台不是 Chrome，未伪造登录态截图验收，已用构建路由、静态资源、公网 release/health、数据库和运行进程证据完成最小验证。

## 18. 生图模板交互补充（2026-09-23，进行中）

| 编号 | 任务 | 完成标准 | 状态 |
|---|---|---|---|
| T1 | Banner 与标题编辑体验 | Banner 使用上传图片原始比例自适应高度；标题默认只显示大号加粗文案，点击后才进入编辑 | 已实现，待构建验收 |
| T2 | 固定参考图数量 | 模板可设置 1/2/4/8/10 张；上传、粘贴、恢复、自动保存和服务端校验遵守同一上限；固定1张时粘贴直接覆盖现有图片 | 已实现，待构建验收 |
| T3 | 模型与质量布局 | 图片质量紧邻生成模型显示；主面板和模块上下文弹窗保持同一布局 | 已实现，待构建验收 |
| T4 | 自动保存与权限 | 移除“保存模块”按钮，继续自动保存；管理员可编辑管理员模板，普通用户只编辑自己的创作者模块 | 已实现，待线上验收 |
| T5 | 图片预览关闭 | 点击打开图片所在的空白区域可以关闭，图片本身仍保持预览/拖拽行为 | 已实现，待线上验收 |

- 数据：为 `ImageStudioModule` 和 `ImageStudioPreset` 增加 `reference_limit` 增量字段，默认10；不执行全库 `db push`，发布时只应用对应迁移。
- 版本：本轮版本升为 `0.12.1`，release 摘要同步实际用户可见变化。
- 风险：固定为1张时一次粘贴多张只保留最后一张；上游仍可能有自己的参考图数量限制，产品本地最多10张不等于供应商保证10张。

### T1-T5 发布结果（2026-09-23）

- Git 提交：`30fb1a32b9391a963a34bb0e6acdffd7d6e9c649`，分支 `codex/gpt-image-studio` 已推送；回退点 `rollback/2026-09-23-before-image-studio-template-ux` 指向发布前线上提交 `5b36d3c335330809d165acaf797cf966cda6f6b3`。
- 发布包：本地与服务器 SHA256 均为 `74d4b34eca659ef0747ef414a69cf3c99a986df0ca72cedcec233a502397b109`；服务器候选构建 `JCLJ-BorhAyX_7rF0NlQ6`，线上 `.deployed-commit` 与目标提交一致。
- 数据库：迁移前备份保存在 `/srv/video-api-debugger/backups/image-studio-template-ux-30fb1a32b9391a963a34bb0e6acdffd7d6e9c649/dev.db`，备份与迁移后数据库 `pragma quick_check` 均为 `ok`；`reference_limit` 两列和迁移记录已核对。
- 公网：`https://sd2.youdooart.com/api/release` 返回 `0.12.1`，`/api/config`、`/api/health`、`/login` 正常；匿名访问 `/image-studio` 按预期跳转登录；`sd2-gray.service` 与 `sd2-image-studio.service` 均 active，连续健康检查后 `NRestarts=0`。
- 浏览器缺口：本轮无法接管用户现有登录态 Chrome，原因是 DevTools endpoint 返回404；因此未把登录后视觉细节标为已验收。源码、构建、运行时、数据库和公网版本证据已通过，登录态页面需在 Chrome 允许调试后补一次真实视觉检查。

## 19. 模板可见性、保存权限与生成图片访问边界（2026-09-23）

| 编号 | 任务 | 完成标准 | 状态 |
|---|---|---|---|
| T1 | Banner 满宽适配 | 模板 Banner 撑满内容区宽度，按原图比例自适应，不被固定最大高度截断 | 已完成，线上构建已加载 |
| T2 | 模板库可见性 | 登录用户可以查看并应用管理员及其他创建者的模板；应用后复制成自己的模块配置 | 已完成，代码与接口构建验证通过 |
| T3 | 保存权限与入口 | 当前配置保存按钮改为手动可感知状态，未改动灰显，改动后亮起；另存为合并为一个入口 | 已完成，线上版本为0.12.2 |
| T4 | 生成图片访问边界 | 生成结果通过登录和用户归属校验的接口读取，匿名不能直接查看生成结果 | 已完成，匿名生成结果直链线上返回404，普通素材仍返回200 |
| T5 | 构建发布 | 版本、Git、服务器候选构建、服务、公网接口和关键页面资源一致 | 已完成，守护周期后服务稳定 |

- 权限解释：模板源数据不直接开放修改；普通用户通过“新建并应用”获得自己的模块副本，因此可以保存自己的配置，但不能修改管理员或其他创建者的源模板。管理员和创建者的模块设置/上下文按钮沿用现有归属规则。
- 行为调整：模板模块配置不再 700ms 自动提交，保留生成前保存兜底；用户可以看到“保存当前模板配置”按钮在未保存时亮起，保存后变灰。上下文说明同步改为提示点击该按钮保存。
- 安全：新增 `/api/image-studio/assets/[assetId]`，只允许已登录且拥有对应成功任务和资产的用户读取图片；生图结果列表不再返回公开 `/uploads` 地址，同时旧 `/uploads/...` 直链按生成任务归属守门，避免历史地址绕过权限。
- 风险：普通上传参考图仍沿用既有资产 URL 体系，未改变其他资产、视频和参考图集的访问规则；本轮限制的是图片生成结果的外部读取。
- 发布提交：`c096588a6efa4405a7bf465329b1e64e4fb9b08c`、`0fe3d6b`、`e8795ea` 已推送；回退点 `rollback/2026-09-23-before-image-studio-access` 指向发布前版本；线上 BUILD_ID 为 `mkxJQrQZNKSqTQSBJbbq4`，版本 `0.12.2`。
- 图片访问复核：匿名生成图片 `/uploads/assets/48c7cd2413798d40822e9cf5cbe87fbd62e73df6c530ac14f80f622a58837fe2.png` 返回404；普通参考素材 `/uploads/assets/47b3d71e25034abf398192912f5e56e5bf1dc39c58571354437a1d4498a06b6d.jpg` 返回200；`/api/health`、`/api/release` 正常，服务 `NRestarts=0`。
- 上传故障复盘：部署包曾覆盖线上 `public/uploads` 持久化软链接，造成 `EACCES: permission denied, mkdir .../public/uploads/assets`。已运行既有 `scripts/server-ensure-runtime-dirs.sh` 恢复到 `/data/video-api-debugger/var-lib/uploads`，并验证 `gouki` 对 `assets`、`thumbs` 可写；未改数据库、未执行付费生图。
- 登录态页面仍缺真实浏览器视觉证据；模板跨账号应用和一次真实登录上传需在 Chrome 调试连接恢复后补验。

## 20. 上线后普通上传故障复核（2026-09-23）

| 编号 | 任务 | 完成标准 | 状态 |
|---|---|---|---|
| U1 | 真实客户端复现 | 在登录态 image-studio 页面抓到普通上传、上传票据和缩略图请求结果 | 已完成 |
| U2 | 根因定位 | 区分登录、请求体大小、代理超时、HTML错误页和服务端目录权限 | 已完成 |
| U3 | 线上恢复 | 恢复上传持久化目录，验证服务用户可写且不影响普通素材链路 | 已完成 |
| U4 | 登录态闭环 | 上传成功、缩略图可见、参考区可继续使用，不触发付费生成 | 已完成 |

- 根因：此前部署包覆盖了线上 `public/uploads` 持久化软链接，服务用户 `gouki` 在普通上传接口中创建 `public/uploads/assets` 时得到 `EACCES`；不是登录失效，也不是 Nginx 的 413/502/504。线上 Nginx 当前 `client_max_body_size=1024m`，代理读写超时均为300秒。
- 运行修复：已运行既有 `scripts/server-ensure-runtime-dirs.sh /srv/video-api-debugger/app`，恢复 `public/uploads -> /data/video-api-debugger/var-lib/uploads`，并验证 `assets`、`thumbs` 对 `gouki` 可写；未改数据库结构。
- 真实浏览器：Xiaobo Chrome Agent Window 复用登录态，刷新后确认 v0.12.2；普通上传请求返回 JSON 200，上传票据返回200，上传后的图片请求返回200，参考区实际显示新缩略图并从2/10变为4/10；随后移除测试图片，未保存模块配置，未点击生成。
- 诊断证据：浏览器网络记录包含一次旧的无效测试图片 500（服务端 JSON 报 `Input buffer contains unsupported image format`）和一次真实有效上传 200；服务日志中的历史失败为 `EACCES mkdir '/srv/video-api-debugger/app/public/uploads/assets'`。`recordAssetUploadLog` 本身有独立 try/catch，不是二次抛错根因。
- 资料：用户原始截图和本轮成功验收截图已登记在 `docs/materials/index.md`；未输出视频签名链接或凭据。线上未执行付费生成；本轮上传测试生成了一个管理员名下的 `browser-upload-smoke.png` 资产记录，未保存到模块配置。

## 21. 无线画布并联、布局与节点上下文（2026-09-24）

| 编号 | 任务 | 完成标准 | 状态 |
|---|---|---|---|
| C1 | 画布节点交互 | 输入/模板/输出卡片可操作，上传素材卡片的选择、重试、删除点击可达 | 已完成，线上回归通过 |
| C2 | 工具流并联与布局 | 一对多、多对一及分支汇合可保存，运行时按拓扑并行推进；整理后主路径清晰、分支并列 | 已完成，线上回归通过 |
| C3 | 通用规则与节点上下文 | 普通模板只读生效的通用规则；每个模板节点独立编辑、独立保存，不覆盖通用上下文 | 已完成，线上回归通过 |
| C4 | 无线画布视觉 | 隐藏系统左导航但保留画布工具栏；模板下拉深色可读；高级设置默认收起 | 已完成，线上回归通过 |
| C5 | 发布与证据 | 候选构建、Git、服务、公网接口、登录态页面和健康守护周期一致 | 已完成，线上与健康守护周期通过 |

- 根因沿用 U3 结论：线上上传目录必须由 `scripts/server-ensure-runtime-dirs.sh` 接回 `/data/video-api-debugger/var-lib/uploads`；本轮部署不得把持久化软链覆盖成发布包普通目录。当前服务器已核对为 `gouki:gouki` 可写，未改数据库、点数或 Provider 密钥。
- 代码范围：`canvas-engine.js` 增加节点上下文保存状态、主路径整理、分支样式和连接端点清理；`toolflow-workflow.js` 把画布卡片事件接到文档级事件代理，并让节点上下文只有显式保存才写入；`toolflow-runtime.ts` 合并通用/模板/节点上下文并按 ready wave 并行推进；`app.js` 将整理布局接入适配按钮；页面和导航改为满屏无线画布；版本升为 `0.13.1`，并补齐旧快照模板节点的默认字段归一化。
- 首轮 0.13.0 本地证据：`npm run test:toolflow`、`npm run lint`、`node --check public/tools/ultimate-canvas/{canvas-engine.js,app.js,toolflow-workflow.js}`、`git diff --check` 和候选 `npm run build` 通过，候选 BUILD_ID `uv7KWpa4vBL8Flkd-M4xq`；lint/构建仅保留既有 ESLint 与 Autoprefixer warning。0.13.1 修复后的复测见下方发布结果。
- 线上回归要求：保留现有画布文档的输入素材，部署后真实点击删除并刷新确认已移除；展开任一模板高级设置，编辑上下文后确认按钮亮起，点击保存后变灰并刷新仍保留；整理画布后确认主路径、并联连线和删除/重连不回归。未执行真实生图，不消耗点数。

### C1-C5 发布结果（2026-09-24）

- Git：`dc09db743b89e122102c80d8a60ba009843f0b5b`（`fix: normalize restored canvas template nodes`）已推送到 `codex/gpt-image-studio`；回退点 `rollback/2026-09-24-before-canvas-parallel-ui`、`rollback/2026-09-24-before-canvas-restore-fix` 均已推送。
- 本地验证：`npm run test:toolflow`、`npm run lint`、`node --check public/tools/ultimate-canvas/{canvas-engine.js,app.js,toolflow-workflow.js}`、`git diff --check` 和候选 `npm run build` 均通过；仅保留既有 lint/Autoprefixer warning，未执行付费生图或数据库写入。
- 服务器：线上 `.deployed-commit=dc09db7`、`.deployed-version=0.13.1`、`.next-prod/BUILD_ID=td33WXt7v-N5040rnJWiU`；`sd2-gray.service` 与 `sd2-image-studio.service` active，`NRestarts=0`，本地 health 通过；`EXPECT_PROD_ON_SERVER=1 SERVER=root@42.193.221.253 bash ops/server/sd2/preflight.sh` 通过。
- 上传运行目录：`public/uploads` 已恢复指向 `/data/video-api-debugger/var-lib/uploads`，生产用户 `gouki` 可写；部署过程保留运行目录，未再次覆盖持久化软链。
- 公网：`/api/release` 返回 `0.13.1`，`/api/config`、`/login` 返回200，未登录访问 `/tools/ultimate-canvas` 按预期跳转登录；健康守护周期后服务仍 active、`NRestarts=0`。
- 登录态画布：页面显示 `Seedance 2.0 v0.13.1`。旧 flow-template 节点填写上下文后按钮由“已保存”变为“保存节点上下文”，点击后刷新仍保留；随后已清空临时上下文和提示词，刷新后均为空且按钮回到“已保存”。输入节点资产删除后刷新仍保持空；连接删除/重连及自动布局保存后刷新保持；深色下拉文字与背景可读。浏览器截图留存于 `/tmp/sd2-canvas-0131-final.png`。

## 22. 图片生成体验闭环汇总（2026-09-24，当前批次）

本节把本批次已收到但尚未完成最终线上验收的要求合并登记，后续按依赖顺序推进，不再拆出重复 todo：

| 分组 | 完成标准 | 当前状态 | 依赖/证据缺口 |
|---|---|---|---|
| 1. 生图 API / 模型 / 分辨率 / 质量 / 比例 | 独立图片 API；模型能力对应分辨率；GPT 使用具体像素；自动比例取首张有效原图真实宽高；服务端重新校验并写快照 | 本地实现完成；类型、构建、Provider smoke 已通过 | 需生产迁移、发布后 API/页面验证；不执行付费生成 |
| 2. 模板封面 / 标题 / 描述 / 分页 | 代表生成图优先；单参考图前后封面；object-fit cover 不拉伸；标题约两倍、最多两行；封面最多三行/页且刷新/空页正确 | 本地实现完成；封面分页与视觉静态断言通过 | 需正式登录页面桌面/移动验收 |
| 3. 结果卡片元信息 / 相对时间 / 复制上下文 | 模型缩写与质量/分辨率同行；相对时间带完整时间提示；有历史上下文才显示复制按钮，复制最终上下文、提示词、模型、质量、比例且不含内部标识 | 本地实现完成；UI smoke 通过 | 需浏览器实际复制成功/失败反馈验收 |
| 4. 大图预览 / 左右切换 / 对比 / 缩放平移关闭 | 同一结果列表左右键首尾循环；切换同步元信息并按参考图数量重置对比；单参考图才显示对比；左右/上下对比共享缩放平移；Esc/空白/双击/滚轮保留 | 本地实现完成；UI smoke 通过 | 需正式页面至少两张历史结果的真实浏览器验收 |
| 5. 删除 / 下载选择模式 | 删除仅在结果区域悬浮层出现且成功/失败共用一个入口；底部不再重复删除；复选框只在下载模式出现；确认下载/取消/完成/关闭预览后退出模式 | 本地实现完成；UI smoke 通过 | 需桌面/移动页面验收，不删除生产数据 |
| 6. 画布节点 / 并行 / 上下文保存 | 保持 v0.13.1 已上线的并联、布局、节点上下文、上传目录持久化修复；新增分辨率/自动比例能力不破坏旧画布 | 既有功能已上线；本批次 Canvas 参数改动本地 smoke 通过 | 需公网页面与既有画布回归，不执行付费生图 |
| 7. 测试 / Git / 部署 | 全批次回归、聚焦提交/推送/回退点；生产迁移与安全候选构建；公网资源、页面、健康守护周期和版本一致 | 进行中 | 必须先完成 1-6 的同版本回归，再迁移/构建/切换/浏览器验收 |

已解决的交互冲突：删除最终只保留结果区域悬浮入口；底部保留下载、复制上下文、重新生成；复选框不占位且仅下载选择模式显示；对比按钮只对“当前生成图恰好一张参考图”显示；封面分页按响应式列数保持最多三行；自动比例优先第一张有有效宽高的参考图，无法解析时回到模型默认；模型切换时分辨率归一到该模型可用档位。

执行顺序固定为：本地类型/构建与全批次 smoke → 精确 diff/版本和迁移检查 → 聚焦提交并推送回退点 → 生产数据库备份并应用增量迁移 → 候选构建、运行目录/preflight、切换与健康守护周期 → 公网版本/静态资源/API → 登录态桌面和移动页面验收；全程不发起付费生成。

### 22.1 0.13.4 正式发布与真实验收（2026-09-24）

本批次 1-7 已完成闭环。最终实现提交为 `7b83b1c324a56bfa0da9061f63cde25345d847cc`，分支 `codex/gpt-image-studio` 已推送；正式版本为 `0.13.4`。上线前线上版本 `0.13.3` 的可回退点使用 `rollback/2026-09-24-before-image-studio-0.13.4-live`，指向 `a643c11abe03ec53162a17590810a63e249930ff`。

- 本地验证全部通过：`npx tsc --noEmit`、`npx prisma validate`、`npx tsx scripts/image-studio-provider-smoke.ts`、`npx tsx scripts/image-studio-ui-smoke.ts`、`npx tsx scripts/ultimate-canvas-generation-node-interactions-smoke.ts`、`npx tsx scripts/ultimate-canvas-generation-node-workflow-smoke.ts`、`npx tsx scripts/toolflow-smoke.ts`、相关 `node --check`、`npm run lint`、`npm run build`、`git diff --check`。仅保留既有 lint/Autoprefixer warning；Provider smoke 未发起付费调用。
- 生产迁移与运行：增量迁移 `20260924090000_image_studio_resolution` 已应用，数据库完整性检查通过；上传目录仍由 `public/uploads` 指向 `/data/video-api-debugger/var-lib/uploads`，生产用户可写。候选构建成功后切换到 BUILD_ID `-OrW6rdngd9YXd-uXB3y1`，旧 BUILD_ID `I26DICEzaQjJQycr4s4Pr` 保留；`.deployed-commit`、`.deployed-version`、公网 `/api/release` 均与 `7b83b1c` / `0.13.4` 一致。
- 发布前、切换后及跨过健康守护周期的 `EXPECT_PROD_ON_SERVER=1 bash ops/server/sd2/preflight.sh` 均通过；`sd2-gray.service`、`sd2-image-studio.service` active，`NRestarts=0`，公网 `/api/config`、`/api/health`、`/login` 正常。
- Xiaobo Chrome Agent Window 登录态真实验收通过：桌面与 iPhone 14 视图的封面最多三行分页、刷新后页码恢复、空页边界夹紧；模板封面使用代表生成图、单参考图前后布局；原图比例显示真实宽高和请求尺寸；结果卡片显示短模型、质量、分辨率、尺寸和相对时间；有历史上下文时可复制且显示成功反馈。
- 大图预览验证通过：单参考图才显示对比入口，左右/上下对比可切换；同一结果列表使用左右键切换并首尾循环，元信息同步更新；下载模式只在进入后显示复选框，取消后退出；结果媒体区域每张结果仅有一个删除悬浮入口，底部没有重复删除入口。未执行生产删除或付费生图。
- 封面页在首次发布后发现并修复了两处刷新恢复边界：`a643c11` 修复首次读取本地页码，`7b83b1c` 修复模块异步加载时过早夹紧；最终 `0.13.4` 已重新部署并完成刷新复验。
- 本轮未纳入提交的既有脏改（`tasks/audit-001-review.md`、未跟踪候选构建目录、`tmp/` 及其他 todo）均保持原样，未覆盖、未回滚、未误提交。

结论：第 22 节列出的 1-7 项均已完成；原始上传权限故障已通过运行目录保护和线上可写验证闭环。固定记录可继续作为后续图片工作室迭代的唯一入口。

### 22.2 0.13.5 画布并行连接命中回归（2026-09-24）

用户反馈高级画布仍不能创建并行连接。本次先在真实登录态 v0.13.4 页面复现，再定位到前端端口命中层：连接线和临时线使用 `pointer-events: stroke`，SVG path 覆盖端口后，`_onMouseUp` 的 `elementFromPoint().closest('.node-connector')` 得不到连接端口，因此第二条分支不会进入 `_createConnection`。`validateToolFlowGraph` 已允许输入一对多、模板多对一，`advanceToolFlowRun` 已按同一 topological ready wave 调度全部分支并等待汇合父节点；序列化/恢复 smoke 也通过，均不是根因。

- 修复范围：`canvas-engine.js` 改为用 `elementsFromPoint` 跳过 SVG 覆盖层查找端口；`styles.css` 让连接线不拦截端口，同时保留删除控制自己的命中；`index.html` 更新资源 cache key；`scripts/toolflow-smoke.ts` 增加 SVG 覆盖命中回归与 CSS 断言；更新工作流 smoke 的 cache key；版本和 release 摘要升为 `0.13.5`。
- 本地验证：`npx tsx scripts/toolflow-smoke.ts`、`npm run test:toolflow`、`npx tsx scripts/ultimate-canvas-generation-node-interactions-smoke.ts`、`npx tsx scripts/ultimate-canvas-generation-node-workflow-smoke.ts`、相关 `node --check`、`npx tsc --noEmit`、`npm run lint`、`npm run build`、`git diff --check` 均通过；仅保留既有 ESLint/Autoprefixer warning。运行时并行调度以 ready-wave 代码和 toolflow smoke 验证，未点击真实运行，避免消耗点数或调用付费 Provider。
- Git：`414d8732e0ad4e59fe3ef282cc82aea144c4c31a`（`fix: restore parallel canvas connection hit testing`）已推送到 `codex/gpt-image-studio`；回退 tag `rollback/2026-09-24-before-canvas-parallel-ports-0.13.5` 指向上一线上提交 `21294da`。发布归档 SHA256 为 `66e6aeedf96f741bb65f0ef26c92073a98b7dc73805c84b8974baa3071fb0ffa`。
- 服务器：部署前后 `bash ops/server/sd2/preflight.sh` / `EXPECT_PROD_ON_SERVER=1 bash ops/server/sd2/preflight.sh` 均通过；候选构建 manifest、`BUILD_ID` 和资源标记通过，线上 `.deployed-commit=414d8732e0ad`、`.deployed-version=0.13.5`、`.next-prod/BUILD_ID=RlYUNNfGqN3mh4tGI0hm7`；旧构建 `.next-prod-prev-0.13.4-20260924-061303` 保留。数据库备份位于 `/srv/video-api-debugger/backups/release-0.13.5-20260924-061039/dev.db`，SHA256 为 `d7be62056e71b3a15b2e6c02ac1fc100e6f054d34de6b013631aefd66ac06346`；未执行迁移、未改变上传/视频/存储持久化 symlink。
- 公网：`/api/release` 返回 `0.13.5`，`/api/config`、`/api/health`、`/login` 返回200；`sd2-gray.service` 保持 active、`NRestarts=0`，跨过约70秒健康周期后仍正常。
- 真实页面：Xiaobo Chrome Agent Window 登录态显示 `Seedance 2.0 v0.13.5`，实际加载 `canvas-engine.js/styles.css?v=20260924-canvas-parallel-ports`。当前画布保存并刷新后保留 `node-3 -> node-7`、`node-3 -> node-10`、`node-7 -> node-5`、`node-10 -> node-5` 四条并行边（另有既有 `node-2 -> node-1`）；输入 fan-out=2、输出 merge=2。真实删除 `node-7 -> node-5` 后重新拖拽连接成功，保存接口返回200，硬刷新后仍恢复；拖动节点时对应 SVG path 的 `d` 同步变化。未执行真实生图、未消耗点数。
- 本轮既有脏改（`tasks/audit-001-review.md`、未跟踪候选构建目录、`tasks/todo/2026-08-26-ultimate-canvas-module-refresh.md`、`tmp/`）保持原样，未提交。

### 22.3 0.13.6 大图查看器真实对比入口（2026-09-24）

用户确认旧验收记录中的“对比”不符合当前页面实际体验。本次在公网登录态先复现：双参考图结果正确隐藏入口，单参考图结果只有图标入口，用户不容易识别为对比功能。现已将查看器顶部入口改为明确的“对比”按钮，并显示当前“左右对比/上下对比”状态；真实参考图和生成图仍由查看器状态传入，不是静态占位。

- 代码：入口为 `src/components/ZoomableImagePreview.tsx`；父层 `src/app/image-studio/studio.tsx` 的 `singleReferenceComparison(task)` 只在快照中恰好一张参考图且有 `originalUrl/thumbnailUrl` 时传入；对比布局、方向状态、同步 `scale/offset`、结果切换重置、Esc/空白关闭均在查看器中完成。
- Git：`f54190c8745f8eecc7b1c32bbbd49cc5b410e412`（`feat: expose image result comparison controls`）已推送；回退 tag `rollback/2026-09-24-before-image-studio-compare-0.13.6` 已推送，指向 `c5ef6c4`。
- 构建与发布：本地 `npm run build` 通过；发布包 SHA256 为 `484be5e72e57a0fc37a38672f29b88b95f69748c0a65c63383386faa8f613446`；线上 `.deployed-commit=f54190c8745f`、`.deployed-version=0.13.6`、`.next-prod/BUILD_ID=pg3sbTbW5zlSJ8VF8HVTT`，旧构建 `.next-prod-prev-0.13.5-20260924-071528` 保留。数据库备份位于 `/srv/video-api-debugger/backups/release-0.13.6-20260924-071327/dev.db`，未执行迁移或数据写入。
- 公网：`/api/release` 返回 `0.13.6`，`/api/config`、`/api/health`、`/login` 返回200；部署前后 preflight 通过，跨过约70秒健康周期后 `sd2-gray.service` active、`NRestarts=0`。
- 登录态手动页面：页面显示 `Seedance 2.0 v0.13.6`。双参考图结果的全屏查看器没有 `data-image-preview-compare` 入口；单参考图结果实际显示“对比”按钮，点击后加载真实参考图 URL 和生成图 URL，出现双面板。方向按钮从“左右”切换到“上下”，两个面板的 transform 同步；左右键切换结果后对比模式重置，Esc 关闭查看器。未点击生成、下载、删除或保存配置。
- 按用户本次要求，不新增或安排自动测试门槛，后续以用户手动查看为准；浏览器控制台仅见 Chrome 扩展自身 `chrome-extension://invalid/` 资源错误，产品接口与图片请求均为200。

## 23. 管理员模板共享开关与受保护素材权限闭环（2026-09-24，进行中）

用户补充确认：管理员生图模板标题旁需要真实的“共享给同事”开关，默认开启；只有创建该模板的管理员能看到、操作和修改，普通公司内部 Feishu 用户只能使用当前仍共享的管理员模板，外部账号和匿名用户不能进入模板或读取受保护素材。关闭共享只阻止之后的新任务，已经提交的任务继续完成，历史结果继续保留。

| 编号 | 任务 | 完成标准 | 当前状态 |
|---|---|---|---|
| S1 | 身份与模板可见性 | 以 `account_type` 和 Feishu tenant identity 判定公司内部身份；匿名/外部不返回模板；创建管理员可查看自己的私有模板 | 代码与匿名边界已完成；真实管理员/内部/外部登录态页面验收受 Chrome DevTools 404 阻塞 |
| S2 | 真实共享开关 | 标题旁显示真实 Switch；保存失败回滚界面状态；仅创建管理员可修改 | 代码已完成；真实登录态页面验收待可接入 Chrome |
| S3 | 来源绑定与提交守门 | 应用模板生成的个人模块绑定源模板；普通生图、旧画布、历史重放、工具流在事务内重新检查共享状态 | 已完成：本地 build、toolflow smoke 与线上构建均通过，未发起付费生图 |
| S4 | 受保护素材 | 模板封面/参考图不再暴露原始 `/uploads` 地址；通过受控资产接口按模板显式引用授权；不自动公开历史生成结果 | 代码已完成；匿名原始 `/uploads` 与受控资产未知 ID 均返回 404，已登录资产授权待页面会话验收 |
| S5 | 兼容迁移与回退 | 旧管理员模板默认共享；已有管理员模块和可识别的个人副本完成来源绑定；生产库先备份，迁移可核验、可回退 | 已完成：迁移已落库核验，生产 DB 备份可读且有 SHA256，旧 `.next-prod` 与 rollback tag 已保留 |
| S6 | 发布与身份验收 | 不发起付费生图；完成管理员、内部同事、匿名、外部身份边界验证，构建、版本、健康守护周期和线上资源一致 | 线上发布、匿名边界、版本/构建/健康周期已完成；三类登录身份页面验收待 Chrome 会话接入 |

发布证据（2026-09-24）：最终代码提交 `bea44640cbb1414a936c0aff15c7a74e9d45c113`，版本 `0.14.0`，线上 `BUILD_ID=8Tc9Miqp7fRlxY24qnydg`；`/api/release` 返回 `0.14.0`，`/api/config`、`/login` 均为 200，公网响应带 `X-SD2-Origin: server-42-193`。匿名 `/api/image-studio/presets` 返回 401，匿名未知受控资产返回 404；线上 `/api/image-studio/template-assets/[assetId]` 已进入生产构建。生产数据库迁移 `20260924100000_image_studio_preset_sharing`、`20260924103000_image_studio_module_source_preset` 已应用，`PRAGMA quick_check` 返回 `ok`；生产备份为 `/data/video-api-debugger/srv-backups/image-studio-template-sharing-20260924-before-migration/dev.db`，SHA256 与线上库一致。上传目录实际解析到 `/data/video-api-debugger/var-lib/uploads`，既有持久化软链保留；`sd2-gray.service`、`sd2-image-studio.service`、`sd2-credit-gateway.service` 及 `sd2-credit-delivery.timer` 均 active，线上 BUILD_ID 已切换且旧 `.next-prod-prev-template-sharing-20260924` 保留。回退 tag：`rollback/2026-09-24-before-template-sharing`。Chrome 登录态因当前 DevTools 接入不可用，未读取或输出任何 cookie/token，管理员/内部同事/外部账号的真实页面验收仍留给手动验收。

边界：只处理图片模板/素材授权和由此导致的上传访问问题，不改变点数、Provider、生成 worker 对已提交任务的处理，不覆盖既有 `public/uploads` 持久化软链和生产数据。关闭模板共享不撤销已提交任务，也不删除历史结果；模板只显式共享 banner/参考图，不把历史生成结果自动变成模板素材。
