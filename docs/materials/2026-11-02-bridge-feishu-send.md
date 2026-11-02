# BR-FEISHU01：插件出图发到本人飞书

项目：video-api-debugger。基线：`37c8eb37f7073ce3e65f934e82514bc0a600f2b8` / v0.126.6；目标版本 v0.127.0，分支 `codex/bridge-feishu-send-20261102`。工单：[HANDOFF-feishu-send.md](../../HANDOFF-feishu-send.md)。

## 范围与状态

三个接口及独立消费者已实现，既有本地工程检查通过。当前本地分支 HEAD 为 `205bf68d958d2048ad943bafd0c2f683e6206661` / v0.127.0；用户本次明确告知已推送 origin，并授权发布。2026-11-02 本次发布在只读核对后因 Git 元数据写入被环境拒绝而停止，**未部署**。下方旧 Git 阻点及“将来上线注意”为实现阶段历史，当前状态以本节及下面的发布尝试为准；不把 mock 或服务检查当作插件/飞书收件手验。

## 发布尝试：现网基线变化与环境阻点（2026-11-02）

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

## Git 交付

计划单个聚焦提交至 `origin/codex/bridge-feishu-send-20261102`；远端沿本仓既有 `https://github.com/goukiyang/seedance-api-debugger.git`。但本轮实际 `git add` 失败：无法创建 `/Volumes/Data/Projects/video-api-debugger/.git/worktrees/bridge-feishu-send-20261102/index.lock`，返回 `Operation not permitted`。只读核对确认 gitdir 与 common-dir 都是上述原路径，不是符号链接指向别处；没有绕过写入拒绝。

**目前没有本轮提交号，没有推送**。代码与文档均留在指定工作树。现存 upstream 仍是 `origin/codex/bridge-device-binding-20261101`，不能用它的 ahead/behind 当本轮推送结果，也不能把原基线推到新分支冒本轮交付。解除当前环境对该 Git 元数据写入的限制后，可沿以下聚焦清单收口（无需重做未变化的测试）：

```sh
git add HANDOFF-feishu-send.md docs/materials/2026-11-02-bridge-feishu-send.md docs/materials/index.md tasks/todo.md package.json package-lock.json src/lib/release.ts scripts/process-feedback-deliveries.ts scripts/test-bridge-feishu-send.ts scripts/fixtures/video-feishu.cjs src/lib/bridge/feishu-contract.ts src/lib/bridge/feishu-source.ts src/lib/bridge/feishu-send.ts src/lib/bridge/feishu-delivery.ts src/app/api/bridge/feishu/send/route.ts 'src/app/api/bridge/feishu/send/[id]/route.ts'
git diff --cached --check
git commit -m "feat(bridge): send plugin images to the signed-in user's Feishu (BR-FEISHU01)"
git push -u origin codex/bridge-feishu-send-20261102
```

插件对照：已读本机插件仓库 `cc/feishu-send:background/feishu-send.js`；GitHub指定页面当前工具读取失败，未声称核对远端最新副本。接口按用户提供的完整工单合同实现，包含旧副本尚未调用的预检。

## 将来上线注意

- 本轮**未部署**，没有部署回执。后续只有获得用户明确上线授权后才执行。
- Web 与 `sd2-feedback-delivery.service` 的独立 `current` 源目录要同步本版；沿现有 service/timer，不新建服务。worker 必须读取同一 `DATABASE_URL` 和 `public/uploads` 原件。
- 复用 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_ALLOWED_TENANT_KEY`，与用户绑定租户一致。不要改管理员固定收件人来代替当前用户；本队列不依赖反馈管理员开关。
- 真实应用权限本轮未查，无现有应用缺权的事实证据；若上线手验发现缺 `im:resource` / `im:message:send_as_bot`，停止相关发送并告知用户，不新增应用或权限。
- 原 timer 每轮结束后20秒触发，一轮一个 bridge 事件；排队/四图上传可能超过插件30秒查询窗口。超时仍保留事件，可沿原 id 查询，不能把 queued 冒充 sent。
- 回退 Web 和独立 worker 程序即可；旧 worker 忽略新类型，未完成事件保留。保留 Notification 回执、UserPreference 限频记录及原图，不回滚业务数据库；unknown 不清零、不换号补发。
- 用户手验仍待完成：插件预检、四图上传、本人飞书卡片（图可点开）、提示词和作品链接、按钮最终已发送状态。

本轮新发现的线索与问题：未新增任务外业务问题。旧测试夹具缺依赖与本次并发事务过期均已在本任务必要验证范围内处理。
