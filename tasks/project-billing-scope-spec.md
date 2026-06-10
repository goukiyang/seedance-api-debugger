# 项目代付与项目额度 Spec

状态：阶段 1 已完成，等待确认后进入阶段 2。

更新时间：2026-06-10

## 阶段 1：现状分析和代码依据

### 第一性原理

“项目代付”不是给项目页面增加一个额度输入框，而是把一次生成任务的计费责任从“用户个人账户”扩展到“项目账户”。系统必须在任务创建、点数冻结、任务终态结算、失败退款、后台审计和外部 API 调用中回答同一组问题：

1. 谁发起了生成。
2. 任务归属哪个项目。
3. 本次由谁付款：用户、项目，还是系统。
4. 付款账户是否有足够额度。
5. 成功时扣了多少，失败/取消时退回哪里。
6. 后台能否追溯这笔账。

不可变约束：

- 不能跳过当前“先冻结、终态再扣除/退款”的闭环。
- 不能让失败任务重复退款，或成功任务重复扣费。
- 不能把项目额度和用户个人点数混在同一条账本语义里，否则后续无法审计。
- 外部 API 传 `project_id` 也必须遵守同一套权限和计费规则，不能另起一套逻辑。
- 未完成 Spec 和确认前，不修改账本、Prisma schema 或扣费逻辑。

### 当前代码证据

| 位置 | 函数/模型 | 已确认事实 | 对项目代付的影响 |
|---|---|---|---|
| `prisma/schema.prisma:13` | `model VideoTask` | `VideoTask` 已有 `user_id`、`owner_user_id`、`project_id`。 | 任务已经能表达“谁提交”和“归属项目”，但不代表项目能付款。 |
| `prisma/schema.prisma:79` | `model VideoTask` | 已有 `estimated_cost`、`actual_cost`、`frozen_cost`、`refund_amount`、`credit_freeze_snapshot`。 | 现有冻结/扣除字段可继续描述任务级费用，但需要知道这些费用属于哪个计费主体。 |
| `prisma/schema.prisma:88` | `model VideoTask` | 已有 `billing_scope String @default("user") // user \| project \| system` 和 `billing_account_id`。 | schema 已预留计费主体字段，但当前创建链路仍写死用户计费。 |
| `prisma/schema.prisma:223` | `model Project` | `Project` 有 owner、creator、members、tasks、cost ledgers 等关系。 | 项目能承载归属和复盘关系，但当前没有项目点数账户或项目额度策略。 |
| `prisma/schema.prisma:345` | `model CreditAccount` | `CreditAccount.user_id` 是唯一键，并强依赖 `User` 关系。 | 现有点数账户是用户账户，不适合直接复用为项目账户。 |
| `prisma/schema.prisma:361` | `model CreditBucket` | 每日额度桶以 `user_id` 为主体。 | 如果项目额度也需要周期额度，必须另行设计，不能直接使用用户 daily quota。 |
| `prisma/schema.prisma:389` | `model CreditLedger` | 点数流水以 `user_id` 为必填字段，并关联 `User`。 | 项目代付需要独立项目流水，或先明确是否允许用项目 owner 代记账；推荐独立项目流水。 |
| `src/lib/credits/policy.ts:27` | `CreditPolicyUser` | 计费用户类型只包含 User 字段。 | 当前策略入口从类型层面就是用户中心。 |
| `src/lib/credits/policy.ts:175` | `ensureCreditAccount` | 通过 `user_id` upsert 用户点数账户。 | 项目无法通过该函数获得独立账户。 |
| `src/lib/credits/policy.ts:382` | `allocateTaskCredits` | 入参是 `CreditPolicyUser`，会调用用户 daily quota 和用户 `CreditAccount`，不足时抛错。 | 创建任务冻结目前只能冻结用户点数。 |
| `src/lib/credits/policy.ts:476` | `settleTaskCredits` | 入参包含 `userId`，终态时更新用户账户并返回扣费/退款结果。 | 成功扣除和失败退款目前只能回到用户账户。 |
| `src/app/api/tasks/create/route.ts:49` | `POST` | 创建任务接口是统一生成入口，网页和重试都会走这里。 | 计费规则应在这里或其下层统一解析，不能只改某个页面。 |
| `src/app/api/tasks/create/route.ts:396` | `POST` | 新任务写入 `user_id: user.id`、`owner_user_id: user.id`、`project_id: project.id`。 | 任务归属已经完整，但计费主体仍未独立解析。 |
| `src/app/api/tasks/create/route.ts:405` | `POST` | 创建时写死 `billing_scope: 'user'`、`billing_account_id: user.id`。 | 项目代付的第一处实现缺口在创建数据写入。 |
| `src/app/api/tasks/create/route.ts:428` | `POST` | 创建事务内调用 `allocateTaskCredits(... user ..., estimatedCost, task.id)`。 | 即使改了 `billing_scope` 字段，也必须同步改冻结服务，否则账本仍扣用户。 |
| `src/app/api/tasks/create/route.ts:621` | `settleTaskAsFailed` | Provider 创建失败后调用 `settleTaskCredits`，并写用户 `CreditLedger`。 | 创建失败退款链路也需要按计费主体结算。 |
| `src/lib/video/task-finalizer.ts:193` | `settleTask` | 终态结算内部读取任务并检查是否已有成功/失败结算流水。 | 幂等保护存在，但当前保护检查的是用户 `CreditLedger`。 |
| `src/lib/video/task-finalizer.ts:211` | `settleTask` | 调用 `settleTaskCredits` 时传入 `userId`。 | 成功/失败/取消终态结算目前只支持用户账户。 |
| `src/lib/video/task-finalizer.ts:225` | `settleTask` | 成功时创建 `task_success_deduct` 用户流水。 | 项目代付需要写项目流水，并保留发起人信息。 |
| `src/lib/video/task-finalizer.ts:247` | `settleTask` | 失败/取消时创建 `task_failed_refund` 用户流水。 | 项目退款必须退回项目账户，不应退给用户。 |
| `src/lib/video/task-finalizer.ts:334` | `finalizeVideoTaskStatus` | 状态刷新到终态后，如果有 `task.user_id` 和 `frozen_cost`，调用 `settleTask(taskId, task.user_id, ...)`。 | finalizer 是最终扣费主路径，项目代付必须在这里闭环。 |
| `src/app/api/video/retry/[id]/route.ts:49` | `POST` | 重试接口读取原任务参数、项目，并再次请求 `/api/tasks/create`。 | 重试是二次创建；项目代付规则应跟随新创建任务重新解析，不应复用旧账单。 |

### 当前结论

1. 当前系统已经记录任务归属项目，也预留了 `billing_scope` 和 `billing_account_id`，但实际生成计费仍是用户账户。
2. 项目没有独立点数账户、冻结字段、周期额度桶或流水模型。
3. 冻结、成功扣费、失败退款、创建失败退款全部绑定用户 `CreditAccount` / `CreditLedger`。
4. 项目代付不能只改 `VideoTask.billing_scope`，否则会出现字段显示“项目付款”，实际却冻结和扣除用户点数的账实不一致。
5. 重试入口会重新调用创建接口，所以它不需要单独扣费逻辑，但必须明确“重试任务按当时项目代付规则重新冻结和结算”。

### 已确认缺口

- 计费主体解析缺口：缺少 `resolveBillingScopeForTask` 之类的统一决策入口。
- 项目账户缺口：缺少项目额度余额、冻结额度、使用量字段。
- 项目流水缺口：缺少项目级冻结、扣除、退款、管理员拨款和审计流水。
- 结算抽象缺口：现有 `allocateTaskCredits` / `settleTaskCredits` 只能处理用户。
- 外部 API 行为缺口：`project_id` 当前只能决定项目归属，不能自动代表项目付款。
- 后台配置缺口：缺少项目代付开关、额度来源、管理员可配置范围和额度不足策略。

### 阶段 2 需要确认的产品规则

下一阶段只写功能点和产品规则，不写代码。需要确认：

已收到的产品方向：

- 管理页的点数流水可以放二级页面设计。主页面只放余额、冻结、最近摘要、异常提示和入口，完整用户/项目流水、筛选、导出、审计明细进入二级页，避免管理首页被账本明细挤占。

推荐信息架构：

- 主入口使用现有路由 `src/app/admin/points/page.tsx` 对应的 `/admin/points`。这个页面当前只鉴权后重定向到 `/admin/users`，语义上已经预留给“点数”，最适合升级为“点数与额度流水”二级页。
- 后台总览 `/admin` 的快捷入口保留“用户与点数”指向 `/admin/users`，新增或调整一个更精确的“点数流水”入口指向 `/admin/points`。用户找“账号管理”进 `/admin/users`，找“账本明细”进 `/admin/points`。
- `/admin/users` 保留用户表、批量发放、单人点数操作和选中用户最近 5 条流水；页面底部的全局流水表后续迁到 `/admin/points`，原位置改为“查看完整流水”入口。
- `/admin/projects` 和项目详情页保留项目额度摘要、代付开关、冻结/可用/本月已用等决策信息；完整项目流水通过 `/admin/points?scope=project&project_id=...` 打开。
- `/admin/costs` 继续负责 Provider 余额、官方扣费、现金成本、成本分摊和自检；不要把点数流水主表放进成本页，避免“点数账本”和“官方现金成本账本”混淆。成本页只在需要对账时提供跳转到 `/admin/points?task_id=...`。
- 任务详情页如果展示本次点数扣除，只放本任务摘要；完整流水通过 `/admin/points?task_id=...` 查看。

`/admin/points` 页面建议分区：

1. 顶部摘要：全站用户点数余额、冻结点数、项目额度余额、项目冻结、今日异常流水数。
2. 筛选条：账本主体 `user | project | system`、用户、项目、任务 ID、流水类型、时间范围、正负变动、关键词。
3. 流水表：时间、主体、触发人、项目、任务、类型、变动、余额变化、冻结变化、原因、来源。
4. 详情抽屉：展示关联任务、冻结快照、退款/扣除闭环、操作人、幂等键和原始 metadata 摘要。
5. 导出入口：按当前筛选导出 CSV，但不导出 token、签名 URL 或敏感 metadata。

命名建议：

- 页面标题：`点数与额度流水`。
- 后台总览入口：`点数流水`。
- 用户页入口：`查看完整流水`。
- 项目页入口：`查看项目额度流水`。
- 成本页入口：`查看点数账本`，只在任务/项目对账上下文中出现。

1. 项目额度来源：系统管理员手动拨款、项目管理员自助设置、周期额度，先采用哪一种。
2. 项目代付开关：默认关闭还是项目创建后默认开启。
3. 配置权限：系统管理员、项目 owner、项目管理员分别能做什么。
4. 扣费优先级：项目代付开启且额度不足时，是失败，还是回退用户点数。
5. 外部 API：调用方传入 `project_id` 且有权限时，是否默认走项目代付。
6. 历史任务：历史 `billing_scope='user'` 是否保持不变，不做迁移。
7. 管理页信息架构：主页面展示哪些账户摘要，二级流水页展示哪些筛选、审计、导出能力。
8. 报表口径：后台成本导出中项目代付和用户自付如何同时展示。

### 阶段门禁

本文件当前只完成阶段 1：现状分析和代码依据。确认后进入阶段 2：功能点和产品规则；阶段 2 确认后再进入阶段 3：风险决策和实现计划。完整 Spec 三段确认前，不修改 `src/**`、`prisma/**` 或扣费相关业务逻辑。
