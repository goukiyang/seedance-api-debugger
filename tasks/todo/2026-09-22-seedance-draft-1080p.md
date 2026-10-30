# Seedance 2.5 Draft 到 1080p 直出

> 项目：`video-api-debugger`；记录日期：2026-09-22；风险：L3（用户可见、涉及计费和 Provider 状态）。
> 生产基线：`c68b3cff3a2d9d94bc41be121b2215930a4432d`；本任务分支：`codex/seedance-draft-1080p`。
> 目标页面：`https://sd2.youdooart.com/generate`。本轮通过干净隔离目录合入服务器生产分支，不触碰生产工作树中画布相关脏改。
> 当前状态：代码、迁移、Mock 与本地低层校验已完成；`draft_task` 已按原版嵌套对象契约输出，费用复用现有按模型计价规则；版本升至 `0.12.0`，真实 Provider 升级开关默认关闭，lint/build 将在生产依赖环境补跑。

## 1. 大白话目标复述

让用户先用 Seedance 2.5 生成低成本的样片 Draft，确认内容后，直接从样片卡片发起一次 1080p 正式生成。正式任务必须只引用本地 Draft ID，沿用样片内容，不再让用户重传 prompt、素材、seed、画幅和时长；Draft 与正式生成分开留痕、分开计费、分开轮询和落盘。

供应商公开 SPA 示例能确认请求存在 `draft` 字段，但当前没有找到可核验的 `draft_task` 升级接口。因此本轮实现接口契约、数据关系、UI 入口和 Mock 回归，同时把真实供应商升级调用放在能力开关后，默认关闭；不能把普通 provider task ID 冒充 Draft ID。

## 2. 具体可执行任务

- [x] D1. 固化 Provider 契约和能力开关
  - 文件：`src/lib/provider/seedance-draft.ts`、`src/lib/provider/jimeng.ts`、`src/types/index.ts`。
  - 内容：定义 Draft 创建、Draft 升级请求的最小字段；升级 `content` 只能包含嵌套的 `draft_task: { id }`；能力开关默认关闭；补齐查询按 `clientRequestId` 恢复所需的适配器。
  - 完成标准：纯函数能被 Mock 检查；关闭开关时不会发真实升级请求。

- [x] D2. 接入 Draft 创建
  - 文件：`src/app/api/tasks/create/route.ts`、`prisma/schema.prisma`、迁移文件。
  - 内容：只允许 Seedance 2.5 使用 Draft 模式；保存本地 Draft 标记和 provider Draft ID；沿用现有幂等、素材快照、点数冻结和失败退款流程。
  - 完成标准：普通生成行为不变；Draft 与正式任务可区分，且不能混入 1080p 正式结果。

- [x] D3. 增加本地 Draft ID -> 1080p 正式任务路由
  - 文件：`src/lib/tasks/seedance-draft-upgrade.ts`、`src/app/api/tasks/[id]/draft-upgrade/route.ts`、`src/app/api/codex/video/draft-upgrade/route.ts`。
  - 内容：只接收本地 Draft ID；校验归属、状态、模型和开关；复用 1080p 审批、幂等、计费和项目预算；正式任务创建后只将 `draft_task` 发送给 Provider。
  - 完成标准：无 Draft、非本人 Draft、未完成 Draft、普通 provider ID 和关闭开关均被拒绝；正式任务有来源关联。

- [x] D4. 在现有生成页接入用户可感知入口
  - 文件：`src/components/GenerationComposer.tsx`、`src/components/generate/GeneratePageClient.tsx`、相关任务列表接口。
  - 内容：Seedance 2.5 下显示“样片 Draft”状态；Draft 成功卡片显示“沿用样片内容生成 1080p”；prompt、素材、model、ratio、duration 锁定为样片来源，未确认能力时明确显示不可用原因。
  - 完成标准：不新建平行页面；刷新后入口和状态仍可见；不伪造百分比或成功状态。

- [x] D5. 完成任务关系、资产和后台可追踪性
  - 文件：`prisma/schema.prisma`、任务详情/列表接口、必要的后台查询字段。
  - 内容：保存 `is_draft`、provider Draft ID、正式任务来源 Draft ID、升级模式和契约快照；任务详情能看出 Draft 与正式结果的关系。
  - 完成标准：查询只暴露本地 ID；管理员可以区分样片和正式产出，且不泄露 provider 密钥或签名 URL。

- [x] D6. 补齐轮询、超时和恢复边界
  - 文件：`src/lib/provider/jimeng.ts`、任务状态/最终落盘相关入口。
  - 内容：Draft 和正式任务复用现有轮询及视频缓存/缩略图流程；升级提交超时保留可恢复状态，按 client request ID 查询，不在结果不明时误退款或重复提交。
  - 完成标准：成功、失败、未决超时三条路径均有明确本地状态和用户文案。

- [x] D7. 核对计费、审批与成本隔离
  - 文件：现有计费/审批调用点及升级服务。
  - 内容：Draft 和 1080p 正式生成各自产生记录；正式生成沿用现有 1080p 审批和项目预算；provider 官方费用与内部点数不混为现金成本。
  - 完成标准：Mock 能证明各自只冻结/结算一次；重复请求按幂等结果返回。

- [x] D8. 对齐资产、缩略图和生成记录列表
  - 文件：现有 `/api/video/list`、任务详情和生成记录组件。
  - 内容：Draft 卡片保留稳定缩略图占位或真实首帧；正式结果沿用现有本地缓存、公开交付和缩略图链路；列表最左列仍是视频画面入口。
  - 完成标准：Draft/正式任务均能在现有记录链路中找到，不引入第二套资产路径。

- [x] D9. 对齐外部 API 和终极画布边界
  - 文件：Codex 视频 API 和现有画布 bootstrap/能力配置入口。
  - 内容：外部升级 API 只接收本地 Draft ID；不改生产画布脏工作树，不把 provider ID 透传给客户端；和画布线程共享字段时只做最小接口兼容。
  - 完成标准：本地 API、Codex API、能力配置的字段口径一致；画布已有改动不被覆盖。

- [x] D10. Mock 回归、构建检查和 Git 交付
  - 文件：`scripts/seedance-draft-upgrade-smoke.ts`、相关代码与迁移。
  - 内容：不执行真实付费生成；用 fetch mock 检查 payload、拒绝边界、幂等和开关；运行语法、Prisma、smoke、diff 检查；创建聚焦提交、rollback tag 并推送任务分支，由主控合入并部署服务器。
  - 完成标准：测试证据可复现，工作树干净，远端分支和回退点可见；完整 lint/build 在生产依赖环境补跑。

## 3. 验收/审查内容

这些审查项需要创建独立子 agent 做只读审查；审查 agent 不改文件、不提交、不补实现，只判断是否达标、证据是否充分、风险是否遗漏，并输出“通过 / 不通过、证据、缺口、风险、下一步”。本轮按 L3 风险保留只读审查，不让审查 agent 改共享工作树。

- [~] R1. 契约与安全边界
  - 检查对象：Provider builder、Draft 升级路由、API 输入校验。
  - 通过标准：升级 content 只有 `draft_task`；无 provider ID 直通；开关默认关闭；错误不泄露密钥。

- [~] R2. 数据和计费边界
  - 检查对象：Prisma 关系、事务、审批、点数和成本台账调用。
  - 通过标准：Draft/正式任务分开留痕；一次请求最多冻结一次；失败/未决状态不误结算。

- [~] R3. 用户流程和页面结果
  - 检查对象：现有生成页、任务卡片、列表字段和状态文案。
  - 通过标准：用户能看懂去哪里确认和如何升级；入口与状态真实；刷新后仍可恢复。

- [~] R4. 运行与交付证据
  - 检查对象：Mock、lint、tsc、build、Git 远端和生产状态。
  - 通过标准：不做真实付费生成；本地和 Git 证据完整；本轮生产未部署且原因清楚。

## 4. 审查内容是否对齐目标

- [x] A1. R1 是否覆盖“Draft ID 不能伪装成普通 provider ID”。
- [x] A2. R2 是否覆盖“样片和正式生成分开计费、审批、台账”。
- [x] A3. R3 是否覆盖“锁定来源内容，用户只看到可感知结果”。
- [x] A4. R4 是否覆盖“默认关闭的真实 Provider 升级能力不能被 Mock 通过冒充为线上可用”。

`[~]` 表示本轮已完成主控自查和可执行的本地证据，但按原计划需要的独立只读审查，或受依赖环境影响的完整 lint/build，尚未完成。

## 5. 风险与停止条件

- RISK-1：供应商公开材料没有给出 `draft_task` 升级请求和响应，默认关闭真实升级调用；若后续验证到不同的官方契约，必须单独更新适配器和 Mock。
- RISK-2：1080p 审批和项目预算是高风险业务，复用现有策略，不复制另一套扣费实现；发现需要改变审批语义时停止并回报。
- RISK-3：画布生产工作树有未提交改动，本分支不复制、不重写、不部署；需要合并时交给主控线程按冲突边界处理。
- STOP：出现 provider 需要新凭据、真实付费验证、生产数据覆盖、破坏性 Git 操作或现有画布改动冲突时暂停，保留已验证代码和证据。

## 6. 2026-10-30 恢复推进

用户先反馈“未能使用，查明原因”，随后明确“推进”，本轮按现有账号及当前生产版本接通样片与正式片。C1 原因核查、C2 修复发布及真实链路验证均已完成，最终证据见第7节。第1–5节保留原阶段计划；当前验收以C1/C2和最终证据为准，原D1-D10实现勾选不单独代表供应商链路可用。

| 编号 | 任务内容 | 完成标准 | 当前状态 |
|---|---|---|---|
| C1 | 查明 Draft 转 1080p 未能使用的原因 | 核对代码、部署和接口证据，给出具体原因与下一步 | 已完成 |
| C2 | 接通并启用 Draft 转 1080p | 正式站可创建样片、升级并取得独立的 1080p 结果，计费与任务关系正确 | 已完成 |

- 生产现状：`sd2-gray.service` 实际运行 `ed76434ee1f18c2df27a57cf0972eddcaf63cb78` / v0.118.4，BUILD_ID `i0569MPSAvCeG0cjEnDIB`，相关路由已存在；正式站与本机 `/api/config` 的 Draft 创建/升级均为 false。不能用 `/srv/video-api-debugger/app` 的旧部署标记冒充活动版本。
- 原因：能力开关缺省关闭，实际两个变量均未设置；前端禁用入口，后端拒绝请求。先前代码/Mock 完成不能代表用户可用。
- 新证据：[BytePlus 官方教程](https://docs.byteplus.com/en/docs/ModelArk/seedance-2-5)明确 Draft 仅 480p，成片仅 1080p，`content` 使用嵌套 `draft_task: { id }`，来源模型与关键参数沿原 Draft，两个步骤独立计费；2026-10-28 10:00 UTC+8 起新 Draft 有效期 14 天，旧 Draft 仍为 7 天。
- 对现用 `etc.seedance-api.net/server/api/call` 做不存在样片编号的无生成探针，返回 `InvalidParameter`、`param=content[0].draft_task.id`、要求成功 Draft 的明确消息。该结果证明网关识别字段，尚不代表真实两步生成已通过。
- 已通过正式 `/api/codex/config` 核对专用普通服务账号；只使用其自有个人项目，不以管理员作为生成/资产/计费所有者。4 秒 480p 样片正式报价为 18 点，复用当前 `pricing_policy_v1`，不另造价格或把内部点数当供应商实际账单。
- 实施分支 `codex/seedance-draft-enable-20261030` 直接基于当前活动提交隔离，旧 0.12.0 分支不整体合入生产。环境显式 false 继续可关闭能力；普通 Seedance 2.0、既有审批、报价与结算、已受理任务和生产数据保持原流程。
- 固定审核 C2-REV-01 发现旧升级提交路径按错误文本判断未知，坏 JSON、2xx 缺 ID、供应商已返回 ID 后的本地登记失败可能误退款，首轮候选 `e9b763fb` 因此不发布。改为按实际发送阶段及结构化结果判断：未发送或明确拒绝可结算失败；发送后结果未知或已知上游 ID 时保留原请求和冻结，只查询原号，登记异常也不退款。
- 已更新现有离线 smoke 的默认启用/显式关闭及 480p 合同，并覆盖坏 JSON、缺 ID、明确拒绝、5xx、连接中断、受理后本地异常和发送前失败。隔离服务器使用假 Key、拦截 fetch，无生产数据库、真实调用或收费；首轮完整 Next 构建已通过，但修正后的候选仍须重新构建与复查，不将旧构建作为新代码证据。
- 复核再补 HTTP 状态与拒绝正文冲突的边界：仅成功网关包装或明确的拒绝型 4xx 可按拒绝码释放；5xx、408、409 均保留不确定状态。R02 `81db1d5e` 已完成构建但未切线上，后续以包含该修正的 R03 源码重新构建。另对真实 `createSeedanceDraftUpgrade` 函数执行 11 场景内存账本隔离测试，观察一次冻结、未知不退款、受理后登记失败保 ID、按原号恢复、明确拒绝/发送前失败可退款及同 key 不重发，全部通过；这不是生产账务或真实数据库集成验收。
- R03 `e5c4af85` 完整构建、主/恢复6个原启动门及7服务切换通过，正式站 v0.118.5 / BUILD `IFKfQBM8Jqzc2fzlvs0J-` 的页面资源与能力开关已核实。首次真实验证在生成/冻结前被旧 Codex wrapper 的 `intent_id无效` 拦下；只读确认任务/账本均为0、冻结0，无供应商调用。新增兼容只在原 Codex 创建/升级入口，按已认证普通账号调用原 `prepareVideoCreationIntent`，再交原受理流程；不放开公共准备API认证、不伪造Cookie、不直接写业务数据或借无关项目视频卡。9项隔离编排验证通过，覆盖鉴权先行、费用上限/修订保留、准备阻断、原intent不替换、原号去重委托及本地Draft绑定；新增补丁仍须聚焦复核、完整构建及实际两步结果。
- Codex 准备兼容按固定审核意见继续复用原 `recordPreparationRejection`：只围绕准备服务抛错处理，确定 pre-intent 4xx 留原号拒绝回执；409/5xx未知、已有 intent 后的 availability 阻断不伪造拒绝。两入口保留 AuthError/VideoPromptGroupError 原状态。扩充后的14项隔离编排检查通过，使用原回执模块和内存存储核对拒绝后同key换输入仍阻断，且升级输入保留真实合同的 source_draft、continuation、baseline、action/entry 和1080p；不是生产数据库或真实扣费验收。

## 7. 交付记录（2026-10-30）

本轮修复在 v0.118.5 发布并完成实测，应用提交 `a8c6d4d78df80ddab2be261a57ba25e21189fe23`，BUILD_ID `oGORrogXd002IRkOek7pG`，正式入口为 https://sd2.youdooart.com/generate 。本轮同一修复交付内的候选重建保持版本号。R04为本次发布候选轮次；真实视频验证为v0.118.5 / R01，只有一组4秒两步生成。

交付前另一轮发布已接续至 **v0.119.0 / `f4ccc79eb2fe10f8fa6c3ecfeb9f54aa8a7d44dd` / BUILD `k3VgJtQpN-pOs1FD1z3sn`**。已在实际运行进程目录逐一核对，本次8个功能源码的SHA256与实测版完全一致，公网版本、两个能力开关及Codex缺请求号的无生成校验均通过；没有重复生成视频或追加扣费。[接续版本保留核对](../../docs/materials/2026-10-30-seedance-draft-enable/final-runtime-continuation.json)记录当前状态。视频/扣费证据仍标注实际生成时的v0.118.5，不把后续站点版本冒作视频版本。

原因已收口：缺省关闭的能力开关拦住入口；样片只允许480p；Codex旧入口缺少新版生成准备记录。启用时同时修正了旧升级链在结果未明时误退款的风险，沿用网页的准备、审批、报价与受理流程。

| 真实步骤 | 本地任务 | 实际文件 | 实扣/遗留冻结 |
|---|---|---|---|
| 480p Draft | `3af4402b-2986-4764-ae4a-5a47ba2addba` | 854×480，4.041667秒，1,052,386字节 | 18 / 0点 |
| 沿用该Draft的1080p正式片 | `cmvv9bq7a001atwtspsmch8sf` | 1920×1080，4.041667秒，1,997,971字节 | 18 / 0点 |

供应商实际返回的 Draft 标记和升级来源ID、站内父任务关系均已核对；两步有独立的供应商任务ID。每步各一条冻结和一条成功实扣记录，共36点，没有重复扣费。视频由原保存流程落盘，ffprobe读取实际文件，两条站内视频URL均HTTP200。首次旧协议400被确认没有生成/扣费后，沿同一原请求号补齐协议继续；没有重生成第三条。上述36点为站内点数，不冒充供应商现金成本。

### 7.1 改动文件及内容

| 文件 | 本轮内容 |
|---|---|
| `src/lib/provider/seedance-draft.ts` | 已核验能力缺省开启、显式false可关闭；共享480p常量与结构化提交结果分类。 |
| `src/app/api/tasks/create/route.ts` | Draft仅允许Seedance2.5和480p，冻结前拒绝不合法规格。 |
| `src/components/GenerationComposer.tsx` | 勾选样片切480p，历史不兼容参数保留并阻止误提交，显示两步计费。 |
| `src/lib/provider/jimeng.ts` | 升级调用区分明确拒绝与结果未知，5xx/408/409及坏响应不误当拒绝。 |
| `src/lib/tasks/seedance-draft-upgrade.ts` | 按发送阶段与已受理ID保留原单和冻结，按原号恢复；纠正关闭提示。 |
| `src/lib/integrations/codex.ts` | 新增复用原生成准备服务的编排，保留原号拒绝回执、价格修订及费用上限。 |
| `src/app/api/codex/video/create/route.ts` | 认证后为缺少intent的v2请求准备原记录，再交普通生成处理器；保留已知错误状态。 |
| `src/app/api/codex/video/draft-upgrade/route.ts` | 对本地Draft升级接同一准备协议，保留原ID限制和普通升级处理器。 |
| `scripts/seedance-draft-upgrade-smoke.ts` | 更新默认启停/480p合同，补坏响应与冲突HTTP状态的隔离反例。 |
| `package.json`、`package-lock.json` | 同步0.118.5；没有增删或升级依赖。 |
| `src/lib/release.ts` | 复用已有项目升级提醒，简述样片与1080p两步和独立计费。 |
| `docs/sd2-external-api-integration.md` | 修正480p、嵌套draft_task协议、动态计费和v2调用示例。 |
| 本工单、`tasks/todo.md`、`docs/materials/index.md` | 同步C1/C2结果、验证边界、资料索引和回退位置。 |
| `docs/materials/2026-10-30-seedance-draft-enable/` | 两份隔离脚本/结果、脱敏生产与媒体账本证据、统一diff、程序回退入口。 |

### 7.2 验证命令与结果

下列命令已实际执行；`E`为隔离源码目录，带假Key和拦截fetch，没有生产数据库。普通smoke及11项升级、14项准备编排检查均通过，隔离脚本与结果同存资料目录；不把替身检查称为数据库或真实账务集成。

```sh
E=/data/video-api-debugger-engineering/seedance-draft-safety-20261030-r02
cd "$E"
runuser -u gouki -- env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$E" NODE_ENV=test node --require ./scripts/server-runtime.cjs --import tsx scripts/seedance-draft-upgrade-smoke.ts
runuser -u gouki -- env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$E" NODE_ENV=test node --require ./scripts/server-runtime.cjs --import tsx upgrade-financial-fixture.cjs
runuser -u gouki -- env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$E" NODE_ENV=test node --require ./scripts/server-runtime.cjs --import tsx codex-preparation-fixture.cjs
```

R04构建通过完整Next/types/lint；构建脚本内部以隔离数据库和 `NEXT_DIST_DIR=.next-prod-candidate` 运行 `node_modules/.bin/next build`。主/恢复6项原启动门均通过，7个服务加载同一实际源码。公网生成页JS的SHA256与候选一致，内网/公网能力开关、登录页、持久目录可写及原私密身份策略已核对。

```sh
systemd-run --unit=sd2-seedance-draft-build-20261030-r04 --description="SD2 Draft Codex preparation compatibility build" /bin/bash /data/video-api-debugger/release-staging/seedance-draft-enable-20261030-r04/build-pair.sh
python3 /data/video-api-debugger/release-staging/seedance-draft-enable-20261030-r04/public-proof.py
python3 /data/video-api-debugger/release-staging/seedance-draft-enable-20261030-r04/health.py
node /tmp/sd2-draft-enable-20261030-r04/verify-live.mjs create
node /tmp/sd2-draft-enable-20261030-r04/verify-live.mjs upgrade
node --env-file=.env /data/video-api-debugger/release-staging/seedance-draft-enable-20261030-r04/read-verification.mjs
ffprobe -v error -select_streams v:0 -show_entries stream=width,height:format=duration,size -of json /data/video-api-debugger/var-lib/videos/3af4402b-2986-4764-ae4a-5a47ba2addba-mvv9ak4i-3781136.mp4
ffprobe -v error -select_streams v:0 -show_entries stream=width,height:format=duration,size -of json /data/video-api-debugger/var-lib/videos/cmvv9bq7a001atwtspsmch8sf-mvv9clz8-3782825.mp4
git diff --check
git diff --cached --check -- . ':(exclude)docs/materials/2026-10-30-seedance-draft-enable/implementation.patch'
git apply --reverse --check docs/materials/2026-10-30-seedance-draft-enable/implementation.patch
git ls-remote --heads origin codex/seedance-draft-enable-20261030
git ls-remote --tags origin refs/tags/rollback/sd2-before-codex-draft-prepare-20261030
```

最后一条Node命令在实际应用根运行；ffprobe由它分别调用，真实文件路径见脱敏实测证据的 `local_video_path`，未将签名URL放进命令或记录。[部署证据](../../docs/materials/2026-10-30-seedance-draft-enable/deployment-proof.json)与[真实视频/账本证据](../../docs/materials/2026-10-30-seedance-draft-enable/live-proof.json)已归档。应用提交和程序恢复分支已推送，额外保护tag分别保留原 `ed76434` 与R04切换前 `e5c4af85`。生成的统一diff保留Git原始上下文空行，最终暂存空白检查仅排除此补丁文件，并以反向 `git apply --check` 核对其与当前源码一致，不删改补丁的上下文空白。

### 7.3 风险、边界及遗留

固定审核线程对未知扣费保护和Codex准备兼容均已聚焦复核通过，原记录在 `tasks/audit-001-review.md`。源码、构建、部署、真实API、视频文件和实扣验证已完成；未代做浏览器或页面人工验收，依项目规则留用户手验，不冒称独立线上验收通过。

修改限定本次Seedance Draft/Codex调用链和必要发布记录。未改变费率、权限、身份签发、数据库结构，未直接写业务数据或恢复/覆盖数据库；两条测试任务和36点账本均由正常API写入。运行数据保留切换前相同位置；其中storage历史上位于 `/data/video-api-debugger/releases/80d5cf6f1ec489ea93257d42e8dd5c7e4e782560/storage`，与规则中规范var-lib位置有差异，已核实同原路径、位于数据盘且备份目录可写。本轮不迁移或清理该目录，避免影响现有数据。上传和视频继续位于var-lib持久目录。

本次R04的历史程序恢复点为 `2c8b45fa4acbde7909b531120511ff139b9c1195` / `0.118.4+draft-disabled-guard.1`，曾完整构建并通过本批原启动门，只关闭新样片/升级，保留已受理任务和原身份协议，记录见[固定程序恢复](../../docs/materials/2026-10-30-seedance-draft-enable/recovery.txt)。**后续v0.119.0已接管发布，不得把R04旧入口直接用于现行站点；当前恢复须使用接续发布自己的相容恢复点。** 本任务未替接续发布验收恢复。恢复不回数据库、媒体、扣费或业务值，未在线演练。守门员等价核对已完成；分级/归类误判：无。

### 7.4 统一diff

[本轮统一diff：原生产ed76434到实际应用a8c6d4d7](../../docs/materials/2026-10-30-seedance-draft-enable/implementation.patch)。仅包含本轮应用代码、已有离线smoke、版本和接口文档，不混入其他工作树脏改；交付记录和资料文件随同一任务分支另行归档。
