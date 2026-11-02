# BR-FEISHU01：插件出图发到本人飞书

项目：video-api-debugger。实现原基线 `37c8eb37f / v0.126.6`；本次发布及回退基线 `6629e540dadaa816d17e6784a904d24ec50262a1 / v0.126.7`。发布分支 `codex/bridge-feishu-send-20261102-r2`，源码 `32a956d4b508e085cb60defb1830176e2e43b811` / v0.127.0。工单：[HANDOFF-feishu-send.md](../../HANDOFF-feishu-send.md)。

## 范围与状态

**已部署，待用户手动验收。** 2026-11-02T08:39:37.175495Z 公网核对完成，运行源码为上述 `32a956d4b` / **v0.127.0**，BUILD **`ybCPF_HfWFqDOgMeIxfX4`**。Web 与原 feedback worker 均已加载本版，公网匿名 GET `/api/bridge/feishu/send` 返回401「未登录」。本轮没有真实发送测试消息，没有 DDL、业务数据修改或飞书应用/权限变更。

按用户第二轮指令，**未执行 git fetch/commit/push**；本地 HEAD 与已有 `origin/codex/bridge-feishu-send-20261102-r2` 引用均为 `32a956d4b`，没有冒称本轮重新查询远端。发布记录、索引及固定 todo 留在当前工作区，由用户提交推送。原 `HANDOFF-feishu-send.md` 未跟踪文件保留。以下首次发布和实现阶段 Git 阻点为历史，当前状态以第二轮发布记录为准。

## 第二轮保护发布完成（2026-11-02）

用户已明确授权上线，并提供 rebase 后候选及新的 v0.126.7 回退目标。08:11Z 首次 SSH、准备候选前和08:39Z切换前均核对现网仍为 `6629e540d / v0.126.7 / qnhbdC9RfbHdNzOGAiN0Z`，没有覆盖后来上线的提交。没有创建 Git 标签或改写 Git 元数据。

### 发布入口与候选

- 已读取本仓 `ops/sd2-release-prepare.mjs`、`ops/sd2-release-profile.json`、现网部署文档及 `server-deploy-closure`。文档中的旧命令实际执行失败：

  ```sh
  node ops/sd2-release-prepare.mjs check-template /Volumes/Data/Projects/video-api-debugger/docs/materials/2026-10-19-upload-unknown-recovery
  ```

  退出1，`ops/sd2-release-prepare.mjs:177` 要求 `sd2-release-profile.v1`，实际为 `sd2-release-profile.v2`。v2 `prepare-full` 仍绑定另一批完整应用/schema迁移合同，不能套到本次明确无DDL的任务；没有修改该入口或伪造它的成功回执。
- 本次沿用**当前 v0.126.7 实际成功的无DDL保护流程**：正式根 `docs/materials/2026-11-01-admin-usage-read-snapshot/release/stage10-attempt01/` 的14份发布脚本，继续调用仓库 `candidate-inputs.mjs`、完整原生检查、价格保护及实际启动门。仅在本次私有临时副本替换固定 main/guard 身份、精确允许新增 `test:bridge-feishu` 脚本，并增加匿名 GET 新接口检查；未修改冻结的 `release-engine`、旧发布脚本或历史回执。另准备本次候选控制命令与固定程序回退脚本。此接续与文档旧命令的差异如实保留，不冒称执行了 v2 full-release run。
- 本机私有材料：`/private/tmp/br-feishu01-release-20261102/`；服务器持久材料：`/data/video-api-debugger/release-staging/bridge-feishu-send-20261102/attempt01/`。`script-provenance.json` 记录继承来源与差异，`source-pair-contract.json` 证明 main/guard 与基线的 Prisma schema、migration 字节完全相同。
- 从精确提交归档2076个源码文件，不含 `.env`、数据库、依赖或私人资料；归档 SHA256 `3ef35d5c126b75bf059e6828308abf0cb554b4437aabc9a3185294eaa46c8420`。22个初始上传文件逐字校验通过。独立候选位于 `/data/video-api-debugger/managed-releases/32a956d4b508e085cb60defb1830176e2e43b811`，真实 `/data` 挂载和空间已核对。
- 本次9份 bridge实现/测试/worker相关文件与已测试的原 `205bf68d9` 字节相同，复用原14组 bridge、旧视频飞书30组及用户明确提供的 rebase 后测试证据；34份未变的相关工程输入也核对一致。新候选仍独立完成原生构建检查、全量类型/lint和完整Next构建。
- 原生检查 run `2c8a52e3-a1c5-4b09-8b23-74a10c3b5564` 成功；类型/lint 08:31:54.540Z 均退出0；完整Next构建 08:36:43.598560Z 成功，BUILD `ybCPF_HfWFqDOgMeIxfX4`。既有 Browserslist、CSS及React Hook提醒保留，没有改依赖或放宽检查。构建使用独立测试库/私有Prisma客户端，未改运行版生成客户端。

### 切换、数据保护与上线检查

- 保护 pair `c2ea9dd2-e757-4069-923a-1a5f85eca7ca`；08:39:03Z 开始切换，08:39:37Z 正常退出0，未进入恢复。11组旧服务进程退出、旧源码进程组排空，无SIGKILL；其中 credit/feedback 两个oneshot按既有流程以SIGTERM退出并重置终态标记，未将其记录改写成正常exit0。
- 08:39:20.217718Z 一致SQLite备份及完整性检查完成：上述服务器目录下 `database-before.sqlite`，SHA256 `58c6601112cb47b5f5d74e25fc3a11a90931e02bc883e86418d8425dfa8bd49d`。配置/程序指针备份为 `configuration-before/`。上线后数据库文件身份、schema及价格全字段与切换前一致；未执行DDL、回填、Notification/限频CRUD探针或数据恢复。
- main/guard 六项真实启动门通过，七个常驻服务恢复，四个原timer均active。Web 实际PID `3448505`，运行目录、提交、版本和BUILD与候选一致。沿既有保护拓扑同步程序指针，没有改飞书应用、权限或环境配置正文。
- 服务器公网证明和本机独立curl均确认 `GET https://sd2.youdooart.com/api/bridge/feishu/send` 为 **401**、正文 `{"ok":false,"error":"未登录"}`；公网 `/api/release` 为v0.127.0，实际BUILD清单及页面资源SHA与候选相同。原匿名鉴权边界保持。
- `sd2-feedback-delivery.service` 从新工作目录相对加载 `scripts/process-feedback-deliveries.ts`。原timer自然触发的新worker于 **08:40:45.802Z** 完成，回执为v0.127.0，包含 `feedback/retest/video/image/bridge` 五队列，`failedQueues: []`；该轮发送/处理均为0。oneshot完成后 `inactive/dead` 且exit0是正常状态，不冒充常驻进程。
- worker 的 bridge/video/image 消费者SHA与候选一致，旧视频/图片消费者同回退版逐字相同；Web/worker均读取 `/data/video-api-debugger/var-lib/uploads/assets` 原图目录并沿原服务数据库接线。原 `.env` 与 `.env.feedback` 的字节及文件身份未变。
- 仅检查既有worker日志中的指定缺权标记，未发现 `im:resource`、`im:message:send_as_bot`、`99991672` 错误；**没有在飞书后台查询或验证实际scope授权，也没有真实上传/发信测试**。因此不把无日志错误当作权限已核实或收件手验通过。真实插件四图/提示词/链接和旧通知收件效果仍由用户手验。

### 固定程序回退入口

目标为 `6629e540dadaa816d17e6784a904d24ec50262a1` / **v0.126.7** / BUILD **`qnhbdC9RfbHdNzOGAiN0Z`**，原构建完成时间 `2026-11-02T04:43:38.704158+00:00` 保持；源码、完整构建和原生检查证据已核验，未重建guard。

```sh
ssh -o BatchMode=yes root@42.193.221.253 'bash /data/video-api-debugger/release-staging/bridge-feishu-send-20261102/attempt01/rollback.sh /data/video-api-debugger/release-staging/bridge-feishu-send-20261102/attempt01/release-input.json'
```

该入口先核固定产物及运行源码仍属于本pair，停止原timer并排尽固定服务，恢复本次备份的程序/启动许可指针，再启动服务并核公网v0.126.7；不恢复数据库、账本、Notification回执、限频记录、原图或飞书环境配置。后继版本上线会拒绝本脚本自动回退。脚本语法、恢复产物及两版真实启动门已有证据，**未在生产演练回退**。

### 回执与本轮边界

服务器上述持久目录下：`deployment-result.json` 为总回执，`main-build-success.json`、`source-pair-contract.json`、`guard-reuse-ready.json`、`startup-pair-checks.json`、`database-protected.json`、`public-deployed.json`、`postflight.json`、`pricing-protection-after.json` 为对应证据。`postflight.json` 固定保留本次worker快照，不依赖随后会更新的 `last-run.json`。13份安全回执已下载到本机私有目录并核SHA；数据库、完整价格行和配置备份仅留服务器，不随Git上传。

本机curl记录同时包含代理CONNECT的200和源站最终401。初次整理脚本误取首段状态而断言失败，已按实际HTTP响应序列核对末段401及正文，没有重发请求或改动部署；修正和13份回执校验保存在本机 `verified-receipts.json`。

本轮没有SSH、网络或目录写入拒绝。另有一次**可选本机进程列表读取**被沙箱拒绝，原命令如下，退出1：`zsh:1: operation not permitted: ps`。

```sh
ps -Ao pid,ppid,etime,command | rg 'prepare-source.mjs|git archive|tar -|br-feishu01-release-20261102' && ls -lh /private/tmp/br-feishu01-release-20261102/main-source.tar.gz
```

已停止该可选读取，没有换工具/主机查询本机进程；已启动的归档仅从原任务回执收到退出0。没有重试上轮被拒绝的Git写入。本轮项目应用源码未修改；文档留工作区，用户后续自行提交推送。

本轮新发现的线索与问题：未新增任务外业务问题。旧发布文档/入口与v2配置不匹配是本次直接遇到的接续问题，已记录实际兼容路径，未扩为发布系统重构。

## 首次发布尝试：现网基线变化与环境阻点（历史，2026-11-02）

记录时间：2026-11-02T06:35:57Z。用户已明确授权本次上线，引用其 06:30Z 原话「我之前不是说过了么。这些以后都一律同意」；没有再次索取上线批准。沿 `ops/sd2-release-prepare.mjs`、`ops/sd2-release-profile.json`、现网部署文档及 `server-deploy-closure` 核对发布范围，不真实发送飞书消息。

已完成的只读核对：

- 本地分支为 `codex/bridge-feishu-send-20261102`，HEAD 为上述 `205bf68d9`，remote 为 `https://github.com/goukiyang/seedance-api-debugger.git`。已有未跟踪 `HANDOFF-feishu-send.md` 原样保留。
- root SSH 成功。`sd2-gray.service` 为 active/running；Web 与 `sd2-feedback-delivery.service` 的 WorkingDirectory 均为 `/data/video-api-debugger/managed-releases/6629e540dadaa816d17e6784a904d24ec50262a1`。投递 service 当时 inactive/dead，配套 timer 为 active/waiting；没有手动启动投递。
- 该目录 `.deployed-commit` 为 `6629e540dadaa816d17e6784a904d24ec50262a1`，package 版本为 **v0.126.7**，`.next-prod/BUILD_ID` 为 **`qnhbdC9RfbHdNzOGAiN0Z`**。实际现网已不同于本次请求所列 `37c8eb37f / v0.126.6`。
- 服务器本机匿名 GET `http://127.0.0.1:3302/api/bridge/feishu/send` 返回 **404**；这不是公网检查，也不是部署后结果。
- 本地没有现网 `6629e540…` 对象，`git show` 返回 `fatal: bad object`。为核对新版本差异，执行下列 fetch，被环境拒绝：

```sh
git fetch --no-tags origin 6629e540dadaa816d17e6784a904d24ec50262a1
```

原错误（退出码 255）：

```text
error: cannot open '/Volumes/Data/Projects/video-api-debugger/.git/worktrees/bridge-feishu-send-20261102/FETCH_HEAD': Operation not permitted
```

按用户“沙箱若挡住……不要绕过：停在那一步”的要求，停止 Git 写入与后续发布，没有更换 Git 目录、使用 `--no-write-fetch-head`、更换工具或提权绕过。记录仅更新到当前工作树，**本次发布记录未提交、未推送**；既有功能提交的远端状态按用户提供信息记录，没有冒称本轮重新核实。

未执行：固定入口候选准备、归档上传、服务器构建/内置检查、新数据保护备份、Web/worker 切换、停服、生产数据写入、DDL、飞书配置/权限变更、真实消息发送及部署后公网检查。既有视频/图片飞书通知源码差异和工程结果见原实现记录，本次没有部署，未验证新版本下真实通知效果。现有应用的 `im:resource` / `im:message:send_as_bot` 权限未核实，不能声称已确认或缺失。

回退：本次未切版，不需要执行回退。用户指定的 `37c8eb37f / v0.126.6` 仍是计划程序回退目标，**未完成其现存产物、保护入口及与当前 v0.126.7 差异的核验，不提供未经核实的可执行回退命令**；任何接续均只回程序，不回数据库、Notification 回执、限频记录或原图。

接续缺口：先解除当前 Git 元数据写入限制，再核对实际现网 `6629e540…` 的来源和差异，确保本候选不覆盖后来上线的改动；以届时实际运行版本准备固定发布入口、候选与回退。此次没有启动 release run，也没有发布锁或待恢复停服操作。插件真实发送仍由用户手验。

本轮新发现的线索与问题：未新增任务外问题；现网基线变化和环境拒绝均属于本次发布直接阻点。

## 架构判断与实现

- 复用 `Notification` 的主键、类型/状态索引与 JSON 元数据；`UserPreference` 只保存每人最近一分钟最多十个受理时间。**不加 DDL、不改 Prisma schema、不新增 migration**。
- 新增 `bridge_feishu_v1` 队列，接入现有 `scripts/process-feedback-deliveries.ts` 的 `Promise.allSettled` 调度；旧反馈、重测、视频和图片队列的实现与筛选保持。站内通知 API 固定筛选 `in_app`，不会把本队列当站内通知。
- （用户, requestId）确定性事件主键与短 SQLite 事务保证幂等。事务内不读原图、不访问网络；已排队/发送中/已发送/未知的重复 POST 返回原记录，不消耗新投递额度。
- 并发工程测试实际发现：SQLite 排队可产生 P1008，同时使已打开事务到期报 P2028。只在本接口对这两类已结束事务最多重入三次；不改共享 Prisma helper。固定事件主键也可识别已提交回执，不会再次创建事件。
- 只有明确失败且无上传/消息不确定标记才允许同 requestId 重试。重试保留原绑定、asset 快照、提示词、链接、已上传 image key 与固定消息 UUID；新请求体不覆盖原内容。
- 每个事件一张 interactive 卡片：来源与图片数、最多 1000 字提示词及截断说明、1–4 张可预览原图、合法作品链接。text 使用 plain_text。
- 发送仅使用 fresh 当前用户的 `feishu_open_id`，绑定摘要包括用户、open_id、应用与租户。素材必须本人且 active；原图按 hash 地址从 `public/uploads/assets` 读取，核对字节数、sha256、真实路径与文件身份。发送前再核绑定、归属、资产快照与原件是否变化。
- 逐事件 CAS 租约隔离重复 worker；扫描最多 50 行，每轮默认处理 1 个事件，延期记录轮转。明确暂时拒绝最多自动尝试 3 次；外部上传/发送意图先持久化，结果未知、发送中崩溃或回执写入失败保留原意图，不自动重发。
- 内部 `unknown` 对 GET/POST 均返回 `failed` 与固定 reason「结果未知，请到飞书里看一下是否已收到」，兼容只识别 failed 的旧插件。
- 上一轮 state lock 权限阻点已解除。本轮 hook 登记成功；新文件名通配未被 hook 识别时补了明确路径后正常写入，没有绕过。沿用已安装依赖，没有重装、rebase 或 reset。

## 修改文件

| 文件 | 内容 |
| --- | --- |
| `src/app/api/bridge/feishu/send/route.ts` | GET 预检、POST 入队；session 鉴权、中文错误、no-store |
| `src/app/api/bridge/feishu/send/[id]/route.ts` | 仅本人状态查询 |
| `src/lib/bridge/feishu-contract.ts` | 参数/持久事件合同、状态投影、固定 UUID、卡片 |
| `src/lib/bridge/feishu-send.ts` | 绑定预检、幂等建事件、明确失败重试、耐久限频 |
| `src/lib/bridge/feishu-source.ts` | 本人素材与原图 hash 读取检查 |
| `src/lib/bridge/feishu-delivery.ts` | 原图上传、一次卡片发送、租约、有限重试、未知终止 |
| `scripts/process-feedback-deliveries.ts` | 接入 bridge 队列及源码 hash 回执 |
| `scripts/test-bridge-feishu-send.ts` | 实际路由/SQLite/原图与严格网络 mock 测试 |
| `scripts/fixtures/video-feishu.cjs` | 补旧测试遗漏的真实 prompt-groups 依赖接线，不改生产视频逻辑 |
| `package.json` / `package-lock.json` | v0.127.0；新增 test:bridge-feishu，锁文件只同步版本 |
| `src/lib/release.ts` | 用户语言的更新标题及两条大纲 |
| `tasks/todo.md`、本文件、`docs/materials/index.md` | 任务与交付记录；用户提供的 HANDOFF 原文随提交保留 |

## 工程检查

- `npm run test:bridge-feishu`：14/14 通过，退出0，日志 `/tmp/br-feishu01-tests-r3.log`。临时 SQLite 根据现有 schema 初始化，合成用户、会话、原图；所有 fetch 严格 mock。覆盖预检401/bound、中文400/403/409/413/429、并发幂等、四图原字节、失败重试、未知不重发、崩溃租约、有限重试、绑定/hash/归属变化、只查本人、旧类型隔离与实际 worker 入口。
- `node scripts/test-video-feishu.cjs`：30/30 通过，退出0。首次因旧夹具漏接 `./prompt-groups` 导入而无法启动，补齐真实依赖后原断言全部通过。
- `./node_modules/.bin/tsc --noEmit --incremental false`：退出0、0错误，最终日志 `/tmp/br-feishu01-typecheck-r3.log`。前两次分别发现本次 sources 数组类型声明、测试 ArrayIterator 与当前编译目标不相容，已补类型并改普通数组索引循环；未修改 tsconfig 或放宽类型检查。
- `npm run lint`：退出0，0 error、271 条既有 warning；本次文件未新增 warning。
- `next lint --file ...` 对两个新路由、四个 bridge 模块、投递 worker 和新测试脚本：退出0，No ESLint warnings or errors。日志 `/tmp/br-feishu01-focused-lint.log`。
- `git diff --check`：通过；提交前再检查暂存差异与敏感文件。
- package 与 lock 两处版本均为0.127.0；新增文件空白检查通过，schema/上传/既有视频与图片投递目录差异为空。
- 首次 worker 子进程在独立空 tsx 缓存目录冷启动达到测试60秒上限，未调用真实网络；已复用系统临时编译缓存，保留独立测试 DB/原图及严格 mock，启动检查上限为120秒。
- 第二轮并发限频复测复现上文 P2028，已按实际原因修复；未通过的原日志保留，不冒称一次全绿。

日志位于本机 `/tmp/br-feishu01-*`，不含真实服务凭据，不随 Git 上传。没有运行收费生成、浏览器验收或生产 DB 命令。

主线程复核：新路由只用 session 本人；卡片无任意收件参数；资产核本人、原件字节与绑定；旧通知按类型隔离；已明确失败与未知结果分别处理。工程检查不冒独立审查或实际收件验收。

## 实现阶段 Git 交付（历史，当前状态见上方）

计划单个聚焦提交至 `origin/codex/bridge-feishu-send-20261102`；远端沿本仓既有 `https://github.com/goukiyang/seedance-api-debugger.git`。但本轮实际 `git add` 失败：无法创建 `/Volumes/Data/Projects/video-api-debugger/.git/worktrees/bridge-feishu-send-20261102/index.lock`，返回 `Operation not permitted`。只读核对确认 gitdir 与 common-dir 都是上述原路径，不是符号链接指向别处；没有绕过写入拒绝。

**目前没有本轮提交号，没有推送**。代码与文档均留在指定工作树。现存 upstream 仍是 `origin/codex/bridge-device-binding-20261101`，不能用它的 ahead/behind 当本轮推送结果，也不能把原基线推到新分支冒本轮交付。解除当前环境对该 Git 元数据写入的限制后，可沿以下聚焦清单收口（无需重做未变化的测试）：

```sh
git add HANDOFF-feishu-send.md docs/materials/2026-11-02-bridge-feishu-send.md docs/materials/index.md tasks/todo.md package.json package-lock.json src/lib/release.ts scripts/process-feedback-deliveries.ts scripts/test-bridge-feishu-send.ts scripts/fixtures/video-feishu.cjs src/lib/bridge/feishu-contract.ts src/lib/bridge/feishu-source.ts src/lib/bridge/feishu-send.ts src/lib/bridge/feishu-delivery.ts src/app/api/bridge/feishu/send/route.ts 'src/app/api/bridge/feishu/send/[id]/route.ts'
git diff --cached --check
git commit -m "feat(bridge): send plugin images to the signed-in user's Feishu (BR-FEISHU01)"
git push -u origin codex/bridge-feishu-send-20261102
```

插件对照：已读本机插件仓库 `cc/feishu-send:background/feishu-send.js`；GitHub指定页面当前工具读取失败，未声称核对远端最新副本。接口按用户提供的完整工单合同实现，包含旧副本尚未调用的预检。

## 实现阶段上线注意（历史，第二轮发布已完成）

- 本轮**未部署**，没有部署回执。后续只有获得用户明确上线授权后才执行。
- Web 与 `sd2-feedback-delivery.service` 的独立 `current` 源目录要同步本版；沿现有 service/timer，不新建服务。worker 必须读取同一 `DATABASE_URL` 和 `public/uploads` 原件。
- 复用 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_ALLOWED_TENANT_KEY`，与用户绑定租户一致。不要改管理员固定收件人来代替当前用户；本队列不依赖反馈管理员开关。
- 真实应用权限本轮未查，无现有应用缺权的事实证据；若上线手验发现缺 `im:resource` / `im:message:send_as_bot`，停止相关发送并告知用户，不新增应用或权限。
- 原 timer 每轮结束后20秒触发，一轮一个 bridge 事件；排队/四图上传可能超过插件30秒查询窗口。超时仍保留事件，可沿原 id 查询，不能把 queued 冒充 sent。
- 回退 Web 和独立 worker 程序即可；旧 worker 忽略新类型，未完成事件保留。保留 Notification 回执、UserPreference 限频记录及原图，不回滚业务数据库；unknown 不清零、不换号补发。
- 用户手验仍待完成：插件预检、四图上传、本人飞书卡片（图可点开）、提示词和作品链接、按钮最终已发送状态。

本轮新发现的线索与问题：未新增任务外业务问题。旧测试夹具缺依赖与本次并发事务过期均已在本任务必要验证范围内处理。
