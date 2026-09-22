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
