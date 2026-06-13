# Feedback Optimization Implementation Plan

> **For Codex:** Use `${CODEX_HOME:-$HOME/.codex}/skills/executing-plans/SKILL.md` to implement this plan task-by-task.

**Goal:** 把后台反馈逐个转成可执行的优化方案，覆盖权限、计费、连续生成、图集管理、产出归属、账号展示、状态语义、长提示词编辑、相对时间和素材引用。

**Architecture:** 先把 P0 安全和账本问题拆出来独立验证/设计，再处理不改变账本语义的生产效率和 UI 问题。所有涉及权限、计费和产出归属的改动必须以后端数据和 API 为准，前端只做展示，不作为安全边界。

**Tech Stack:** Next.js 14 App Router、React 18、TypeScript、Prisma、SQLite、现有 `VideoTask` / `Project` / `ReferenceAlbum` / `CreditLedger` / `CostLedger` 模型。

---

## 0. 背景与执行原则

### 数据来源

当前反馈来自 `prisma/dev.db` 的 `Feedback` 表。只读查询结果：

- 总数：19 条。
- 新反馈：15 条。
- 已归档：4 条。
- 主要提交人：杨波、张映珊、侯策超。
- 主要页面：`/generate`、`/tasks`、`/tasks/:id`、`/collections`。

### 已读代码依据

- 任务权限：`src/lib/projects/permissions.ts` 的 `getTaskWhereForUser`、`assertCanViewTask`。
- 任务列表 API：`src/app/api/video/list/route.ts`。
- 任务详情状态 API：`src/app/api/video/status/[id]/route.ts`。
- 任务删除 API：`src/app/api/tasks/[id]/route.ts`。
- 生成页：`src/app/generate/page.tsx`。
- 生成器组件：`src/components/GenerationComposer.tsx`。
- 图集列表页：`src/app/collections/ReferenceAlbumsClient.tsx`。
- 图集详情页：`src/app/collections/[id]/ReferenceAlbumDetailClient.tsx`。
- 图集 API：`src/app/api/reference-albums/route.ts`、`src/app/api/reference-albums/[id]/route.ts`。
- 图集权限：`src/lib/reference-albums/permissions.ts`。
- 后台产出 API 和页面：`src/app/api/admin/outputs/route.ts`、`src/app/admin/outputs/AdminOutputsClient.tsx`。
- 账号展示：`src/components/AccountMenu.tsx`。
- 颜色和状态样式：`src/app/globals.css`。

### 全局执行原则

- 权限问题先验证，再修复；不能只改前端。
- 项目代付必须先写 Spec，再动账本代码。
- 图集删除默认软删除，不能破坏历史任务引用。
- 产出归属展示要统一 `owner_user_id`、`user_id`、`project_id`、`source_type`、`source_label` 的口径。
- 状态颜色要按语义统一：错误才用红色，进行态/引导态不用红色。
- 每批改动后必须运行 `npx tsc --noEmit --pretty false` 和 `npm run build`。

---

## 1. P0 权限隔离：普通用户是否看到他人任务

### 原始反馈

> 查一下每个角色里看我的任务是否会看到其他人的产出内容，按道理只有管理员可以看到所有人

### 问题定义

这是数据隔离问题。用户真正关心的是：普通用户、项目成员、项目管理员、系统管理员分别能看到哪些任务、视频、截图和后台产出。只要某个 API 返回了越权数据，前端 UI 隐藏都不能算修复。

### 当前实现依据

- `src/lib/projects/permissions.ts`
  - `getTaskWhereForUser(user, projectId, options)` 负责生成任务列表查询条件。
  - `assertCanViewTask(user, task)` 负责任务详情、状态、截图等单任务权限。
- `src/app/api/video/list/route.ts`
  - 使用 `getTaskWhereForUser` 查询 `/api/video/list`。
- `src/app/api/video/status/[id]/route.ts`
  - 先查询 task，再调用 `assertCanViewTask`。
- `src/app/api/video/thumbnail/[id]/route.ts`
  - 先查询 task，再调用 `assertCanViewTask`。
- `src/app/api/admin/outputs/route.ts`
  - 通过 `getAdminUser` 限制管理员访问。

### 目标行为

- 普通用户只看到自己的个人任务，以及自己有权限项目中的任务。
- 项目成员能看到所在项目允许查看的任务。
- 项目管理员只能看到自己管理项目内的任务，不自动等于全站管理员。
- 系统管理员可以看全站任务和后台产出。
- `/tasks` 页面和 `/api/video/list` 的返回一致。
- `/tasks/:id`、`/api/video/status/:id`、`/api/video/thumbnail/:id` 的单任务权限一致。
- `/admin/outputs` 只有系统管理员可访问。

### 优化方案

先新增只读权限矩阵脚本，固定验证各类角色的访问边界。只有发现越权，才修改权限函数。这样避免在没有证据时盲目改权限逻辑。

建议新增：

- `scripts/task-permission-matrix-smoke.ts`

脚本职责：

- 找到或要求传入 4 类测试用户：普通用户、项目成员、项目管理员、系统管理员。
- 找到每类用户自己的任务、同项目任务、非同项目任务、无项目任务。
- 构造 session cookie。
- 请求以下接口并断言状态：
  - `/api/video/list`
  - `/api/video/list?include_all=true`
  - `/api/video/status/:id`
  - `/api/video/thumbnail/:id`
  - `/admin/outputs`
  - `/api/admin/outputs`
- 输出矩阵报告，不打印 token、cookie。

如果发现不一致，再修改：

- `src/lib/projects/permissions.ts`
  - 收敛 `getTaskWhereForUser` 和 `assertCanViewTask` 的判断口径。
- `src/app/api/video/list/route.ts`
  - 保证 `include_all` 只对 admin 生效。
- `src/app/api/video/status/[id]/route.ts`
  - 保证状态刷新前先鉴权。
- `src/app/api/video/thumbnail/[id]/route.ts`
  - 保证截图文件返回前先鉴权。

### 任务清单

- [x] 新建 `scripts/task-permission-matrix-smoke.ts`。
- [x] 在脚本里复用现有 session cookie 签名方式，参考 `scripts/project-ui-smoke.ts`。
- [x] 查询测试用户和测试任务，不足时输出跳过原因，不自动创建付费任务。
- [x] 覆盖 `/api/video/list`，断言普通用户不返回非授权任务。
- [x] 覆盖 `/api/video/status/:id`，断言非授权任务返回 403 或 404。
- [x] 覆盖 `/api/video/thumbnail/:id`，断言非授权任务返回 403 或 404。
- [x] 覆盖 `/api/admin/outputs`，断言非管理员返回 401/403。
- [x] 若发现越权，修 `src/lib/projects/permissions.ts`。本次矩阵未发现越权，未改权限业务逻辑。
- [x] 若发现某个 API 没调用权限 helper，补上。本次核对的 list/status/thumbnail/admin outputs 均已有后端鉴权。
- [x] 在 `tasks/feedback-optimization-plan.md` 或执行记录里贴矩阵结果摘要。

### 验收命令

```bash
npx tsx scripts/task-permission-matrix-smoke.ts
npx tsc --noEmit --pretty false
npm run build
```

### 风险与注意

- 不要用管理员账号的结果推断普通用户权限。
- 不要把 404 和 403 混为错误；隐藏资源存在性时可以返回 404。
- 不要只检查页面，必须检查 API。

### 执行记录 - 2026-06-10

已新增 `scripts/task-permission-matrix-smoke.ts`，通过当前本地服务 `BASE_URL=http://localhost:3000` 跑完 16 个 HTTP 检查：

- 管理员：`/api/video/list`、`/api/video/list?include_all=true`、`/api/admin/outputs` 均返回 200。
- 普通用户 `kay`：任务列表返回 200，`include_all=true` 不扩大权限；访问非授权任务状态、截图、非授权项目列表均返回 403；访问 `/api/admin/outputs` 返回 403。
- 项目成员 `eson`：任务列表返回 200，`include_all=true` 不扩大权限；访问非授权任务状态、截图、非授权项目列表均返回 403；访问自己有权限的项目列表返回 200；访问 `/api/admin/outputs` 返回 403。
- 本次只做只读权限验证，未发现越权，因此没有修改 `src/lib/projects/permissions.ts` 或 API route 业务逻辑。

验证命令：

```bash
BASE_URL=http://localhost:3000 npx tsx scripts/task-permission-matrix-smoke.ts
npx tsc --noEmit --pretty false
npm run build
```

验证结果：

- 权限矩阵脚本通过。
- TypeScript 检查通过。
- 构建通过；仅存在既有 `<img>` 和 React hooks lint warning。

---

## 2. P0 项目代付与项目额度

### 原始反馈

> 把项目设置成一个只要在这个管理员指定的项目里，就能自动扣除点数，相当于项目帮用户付费；每个项目管理员都可以独立设置额度

### 问题定义

这是计费主体变化。当前生成链路以用户为扣费主体，项目只用于归属和成本分摊。项目代付要求项目拥有额度、冻结、扣除、退款和审计能力。

### 当前实现依据

- `prisma/schema.prisma`
  - `VideoTask.billing_scope` 已存在，默认 `user`，注释里已有 `user | project | system`。
  - `VideoTask.billing_account_id` 已存在。
  - `Project` 当前没有项目点数账户字段。
  - `CreditAccount` 和 `CreditLedger` 当前以 `user_id` 为核心。
- `src/app/api/tasks/create/route.ts`
  - 创建任务时写死 `billing_scope: 'user'`、`billing_account_id: user.id`。
  - 使用 `allocateTaskCredits` 冻结用户点数。
- `src/lib/credits/policy.ts`
  - `allocateTaskCredits`、`settleTaskCredits` 面向用户账户。

### 目标行为

- 系统管理员可以给项目启用代付。
- 项目管理员可以在授权范围内配置项目额度，前提是产品规则允许。
- 成员在项目内生成时，系统根据项目代付规则决定扣项目额度还是用户点数。
- 任务成功、失败、取消都能正确结算或退款。
- 后台能看到该任务由哪个项目代付、谁触发、消耗多少。
- 外部 API 传入 `project_id` 时也遵守同一套计费规则。

### 推荐架构

分三层实现：

1. **Spec 层**：先确认项目额度产品规则。
2. **账本层**：新增项目额度账户与流水，不复用用户 `CreditAccount`。
3. **生成层**：把当前 `allocateTaskCredits` 抽象成可按 `billing_scope` 选择的统一冻结/结算服务。

建议新增模型：

- `ProjectCreditAccount`
  - `project_id`
  - `balance`
  - `frozen_credits`
  - `monthly_used`
  - `total_used`
- `ProjectCreditLedger`
  - `project_id`
  - `type`
  - `amount`
  - `balance_before`
  - `balance_after`
  - `frozen_before`
  - `frozen_after`
  - `related_task_id`
  - `operator_id`
  - `reason`
  - `metadata_json`
- `ProjectBillingPolicy`
  - 或使用 `Project` 扩展字段，但更推荐独立表，避免把策略塞进项目主体。

建议新增服务：

- `src/lib/credits/billing-scope.ts`
  - `resolveBillingScopeForTask(user, project, request)`
  - 决定 `billing_scope` 和 `billing_account_id`。
- `src/lib/credits/project-policy.ts`
  - 项目额度读取、冻结、结算、退款。
- `src/lib/credits/generation-billing.ts`
  - `allocateGenerationCredits`
  - `settleGenerationCredits`
  - 对上层隐藏用户/项目两种扣费差异。

### 任务清单

- [ ] 新建项目代付 Spec，路径建议 `tasks/project-billing-scope-spec.md`。
- [ ] 明确项目额度来源：管理员充值、周期额度、手动拨款，先选一种。
- [ ] 明确扣费优先级：项目代付开启时优先项目，额度不足是否回退用户点数。
- [ ] 明确谁能配置：系统管理员、项目 owner、项目管理员。
- [ ] 明确外部 API 行为：`project_id` 有权限且项目代付开启才可用项目额度。
- [ ] 更新 `prisma/schema.prisma`，新增项目额度账户、流水和策略表。
- [ ] 新增迁移并生成 Prisma Client。
- [ ] 新增 `src/lib/credits/project-policy.ts`。
- [ ] 新增 `src/lib/credits/generation-billing.ts`，包住现有用户扣费逻辑。
- [ ] 修改 `src/app/api/tasks/create/route.ts`，不要再写死 `billing_scope: 'user'`。
- [ ] 修改任务失败处理，按 `billing_scope` 退款。
- [ ] 修改 status/finalizer 里的成功结算，按 `billing_scope` 扣除。
- [ ] 后台项目页增加额度配置入口。
- [ ] 后台成本导出增加 `billing_scope`、`billing_account_id`、项目额度流水字段。
- [ ] 外部 API 文档补充项目代付规则。

### 验收命令

```bash
npm run db:generate
npx tsc --noEmit --pretty false
npm run build
```

建议新增脚本：

```bash
npx tsx scripts/project-billing-smoke.ts --dry-run
```

真实验收需要授权后再跑付费生成：

```bash
ALLOW_PAID_PROVIDER_SMOKE=1 npx tsx scripts/workbench-closure-smoke.ts
```

### 风险与注意

- 这项不能和颜色、图集按钮一起改。
- 不允许绕过现有冻结再扣除的闭环。
- 失败退款必须幂等。
- 账本需要能回答：谁生成、哪个项目代付、扣了多少、失败是否退回。

---

## 3. P1 创建成功后不阻塞下一次生成

### 原始反馈

> 如果已经创建成功，进入排队，那任务已创建的提示应该消失，可以创建下一段

### 当前实现依据

- `src/app/generate/page.tsx`
  - `handleSubmit` 成功后 `setResult(data)`。
  - 最近任务区域会显示最近任务。
  - 轮询 `result.id`。
- `src/components/GenerationComposer.tsx`
  - `result` 存在时展示 `composer-result`。
  - `composer-result` 文案为“任务已创建”。
  - 结果块下方有“新建任务”按钮。
  - 表单参数栏仍在结果块之后，但视觉上会被结果块打断。

### 目标行为

- 创建成功后，任务进入队列提示。
- 生成表单立即恢复可编辑和可提交。
- 成功提示不长期占据表单主区域。
- 用户可以连续创建下一段，不需要点击“新建任务”才能继续。

### 优化方案

把 `result` 从“主区域结果卡”改成“非阻塞任务队列提示”。

推荐行为：

- 成功后把任务插入最近任务顶部。
- 顶部或侧边显示轻量提示：“任务已加入队列，可继续创建下一段”。
- 提示 4-6 秒后自动收起，或允许用户手动关闭。
- 表单保留当前参数和素材，prompt 是否清空需要按产品选择：
  - 推荐默认保留 prompt，便于连续微调。
  - 增加“清空提示词”或“新建空白任务”按钮。
- 轮询仍继续，但不要用轮询结果覆盖表单区域。

### 任务清单

- [x] 在 `src/app/generate/page.tsx` 中把单任务轮询改成后台任务队列轮询。
- [x] 成功后立即把新任务插入 `recentTasks` 顶部。
- [x] 在 `GenerationComposer` 中移除长期占位的 `composer-result` 主卡，改成轻量 `queue notice`。
- [x] `queue notice` 提供“查看详情”链接。
- [x] 保留轮询逻辑，但把生成完成结果交给最近任务卡片展示。
- [x] 确认 `isSubmitting=false` 后按钮可再次提交。
- [x] 加入自动消失定时器，避免提示永久占位。
- [x] 调整 CSS：新增 `composer-queue-notice`，不使用错误色。

### 验收

- 创建任务成功后，不点击“新建任务”也能继续编辑 prompt。
- 创建任务成功后，提交按钮恢复可用。
- 最近任务出现新任务。
- 旧任务继续轮询，不影响新任务表单。

### 验证命令

```bash
npx tsc --noEmit --pretty false
npm run build
```

如不跑真实生成，可用 mock/非付费路径验证 UI 状态；真实闭环需用户授权。

### 执行记录 - 2026-06-10

已把生成成功后的交互从“结果卡阻塞表单”改为“轻量队列提示 + 后台轮询”：

- `src/app/generate/page.tsx` 新增 `activePollingTaskIds`，允许多个已提交任务继续轮询，不再因为继续编辑下一段而停止旧任务状态刷新。
- `src/app/generate/page.tsx` 在提交成功后立即把新任务插入最近任务顶部，并在终态时刷新最近任务和点数。
- `src/components/GenerationComposer.tsx` 把成功结果区改成 `queue notice`，只保留队列提示、状态摘要、查看详情和收起动作。
- `src/app/globals.css` 新增队列提示样式，不使用错误色。
- 本次没有跑真实付费生成；连续生成的真实提交闭环仍需授权后用实际任务验证。

---

## 4. P1 保存每个人最后一次生成设置

### 原始反馈

> 每个人用的生成模式，要默认保存最后一次生成的设置

### 当前实现依据

- `src/components/GenerationComposer.tsx`
  - 使用 `DEFAULT_GENERATION_MODE`、`DEFAULT_RATIO`、`DEFAULT_DURATION`、`DEFAULT_RESOLUTION`。
  - 复用任务时会用 `reuseDraft` 回填。
- `src/app/generate/page.tsx`
  - 提交时传 `generation_mode`、`ratio`、`duration`、`resolution` 等参数。
- 当前没有看到用户级生成偏好 API 或模型。

### 目标行为

- 用户下次进入生成页时，默认使用自己上一次成功提交的参数。
- 不保存一次性素材 URL、临时签名地址、idempotency_key。
- 不同用户之间偏好隔离。
- 多设备可同步，至少同一浏览器可复用。

### 推荐方案

分两阶段：

第一阶段低风险：

- 使用 localStorage 保存偏好，key 包含用户 ID。
- 提交成功后保存生成参数。
- 页面加载时读取并应用。

第二阶段正式能力：

- 新增服务端用户偏好表或复用统一用户设置表。
- 新增 `/api/me/preferences/generation`。
- 登录后读取服务端偏好；本地 localStorage 作为 fallback。

推荐直接做第二阶段，因为反馈强调“每个人”，不是“当前浏览器”。

建议新增模型：

- `UserPreference`
  - `id`
  - `user_id`
  - `key`
  - `value_json`
  - `created_at`
  - `updated_at`
  - unique `[user_id, key]`

建议 key：

```text
generation_defaults_v1
```

建议保存字段：

- `generation_mode`
- `ratio`
- `duration`
- `resolution`
- `generate_audio`
- `return_last_frame`
- `watermark`
- `seed_mode`，只保存是否随机，不保存每次随机 seed。
- 可选：`project_id`，需要确保下次仍有项目权限。

### 任务清单

- [x] 新增 `UserPreference` Prisma 模型。
- [x] 新增 `src/lib/preferences/generation.ts`，负责校验和默认值归一化。
- [x] 新增 `src/app/api/me/preferences/generation/route.ts`，支持 GET/PATCH。
- [x] GET 时校验用户权限，如果保存的 `project_id` 已不可访问，则不返回该项目。
- [x] 修改 `src/app/generate/page.tsx`，加载当前用户后请求生成偏好。
- [x] 修改 `src/components/GenerationComposer.tsx`，支持 `initialSettings`。
- [x] 提交成功后 PATCH 保存最后一次参数。
- [x] 本地 localStorage 作为 API 失败时 fallback。
- [x] 更新错误处理：偏好保存失败不阻塞生成。

### 验收

- 用户 A 改成首尾帧、9:16、10 秒、720p 后提交。
- 用户 A 刷新页面后仍默认这些参数。
- 用户 B 登录后不继承用户 A 的参数。
- 保存的项目无权限后，不自动选中该项目。

### 验证命令

```bash
npm run db:generate
npx tsc --noEmit --pretty false
npm run build
```

### 执行记录 - 2026-06-10

已实现服务端用户偏好 + 本地 fallback：

- `prisma/schema.prisma` 新增 `UserPreference`，并新增迁移 `prisma/migrations/20260610083000_add_user_preferences/migration.sql`。
- `src/lib/preferences/generation.ts` 统一生成默认值、合法值校验和 JSON 解析/序列化；只保存可复用设置，不保存素材 URL、签名 URL、本地路径或一次性上传地址。
- `src/app/api/me/preferences/generation/route.ts` 支持 GET/PATCH；本地数据库尚未执行迁移时返回 `user_preference_table_missing`，生成页继续使用 localStorage fallback，不阻塞生成。
- `src/app/generate/page.tsx` 登录后读取偏好，提交成功后异步保存偏好；保存失败不影响任务创建。
- `src/components/GenerationComposer.tsx` 支持 `initialSettings`，复用任务 `reuseDraft` 优先级高于默认偏好，避免覆盖用户主动复用的任务参数。

验证命令：

```bash
npm run db:generate
npx tsx -e "import { normalizeGenerationDefaults, serializeGenerationDefaults, parseStoredGenerationDefaults } from './src/lib/preferences/generation.ts'; /* smoke */"
npx tsc --noEmit --pretty false
npm run build
BASE_URL=http://localhost:3002 npx tsx scripts/project-ui-smoke.ts
```

验证结果：

- Prisma Client 生成通过。
- 生成偏好归一化 smoke 通过。
- TypeScript 检查通过。
- 生产构建通过；仅有既有 `<img>` lint warning。
- 本地当前数据库未执行 `UserPreference` 迁移时，`GET /api/me/preferences/generation` 返回 200，并带 `unavailable=user_preference_table_missing`，页面不会因此崩溃。
- 只读项目 UI 冒烟通过。

上线注意：

- 要让跨设备偏好真正持久化，部署时必须应用 `20260610083000_add_user_preferences` 迁移；迁移前功能会自动降级到浏览器 localStorage。
- 本次未执行 PATCH 写库冒烟，避免把测试偏好写入真实本地用户数据；PATCH 路径已由类型检查、构建和 Prisma Client 生成覆盖。

---

## 5. P1 任务详情返回来源页

### 原始反馈

> 返回任务这个按键，改成哪里来的回哪里去

### 当前实现依据

- `src/app/tasks/[id]/page.tsx`
  - 空状态返回 `/tasks`。
  - 顶部返回链接写死 `/tasks`，文案“返回任务”。
- 多个入口可能打开任务详情：
  - `/tasks`
  - `/generate` 最近任务
  - `/admin/outputs`
  - `/projects/:id`
  - 外部链接。

### 目标行为

- 从哪里进入任务详情，就回到哪里。
- 直接打开任务链接时，默认回 `/tasks`。
- 不依赖浏览器 history 作为唯一逻辑。

### 优化方案

使用显式 `return_to` 查询参数。

入口链接改造：

- `/tasks` 中任务链接：`/tasks/:id?return_to=/tasks`
- `/generate` 最近任务：`/tasks/:id?return_to=/generate`
- `/admin/outputs`：`/tasks/:id?return_to=/admin/outputs`
- `/projects/:id`：`/tasks/:id?return_to=/projects/:id`

任务详情页：

- 读取 `useSearchParams().get('return_to')`。
- 只允许站内相对路径，防止 open redirect。
- fallback 为 `/tasks`。
- 文案根据来源调整：
  - `/admin/outputs` -> 返回产出留存
  - `/generate` -> 返回生成页
  - `/projects/...` -> 返回项目
  - 默认 -> 返回任务

### 任务清单

- [x] 新增 `src/lib/navigation/return-to.ts`，提供 `sanitizeReturnTo` 和 `taskReturnLabel`。
- [x] 修改 `src/app/tasks/[id]/page.tsx`，使用 `useSearchParams` 解析 `return_to`。
- [x] 修改 `src/app/tasks/page.tsx` 的任务链接。
- [x] 修改 `src/app/generate/page.tsx` 最近任务链接。
- [x] 修改 `src/app/admin/outputs/AdminOutputsClient.tsx` 产出链接。
- [x] 搜索所有 `href={`/tasks/${id}`}` 并补 return_to。
- [x] 为非法 `return_to=https://evil.com` 加 fallback。

### 验收

- 从 `/generate` 打开任务，返回回 `/generate`。
- 从 `/admin/outputs` 打开任务，返回回 `/admin/outputs`。
- 直接打开 `/tasks/:id`，返回 `/tasks`。
- 外部恶意 return_to 不生效。

### 执行记录 - 2026-06-10

已新增 `src/lib/navigation/return-to.ts`，集中处理任务详情来源页：

- `sanitizeReturnTo` 只允许站内路径 `/tasks`、`/generate`、`/projects...`、`/admin...`，拒绝 `https://evil.com`、`//evil.com`、`/api/...`、反斜杠和控制字符。
- `taskDetailHref` 统一生成 `/tasks/:id?return_to=...`。
- `taskReturnLabel` 根据来源显示“返回任务 / 返回生成页 / 返回项目 / 返回产出留存 / 返回成本后台 / 返回后台”。
- 已覆盖 `/tasks`、`/generate`、`/admin/outputs`、`/projects/:id`、`/admin`、`/admin/costs` 和官方账单表单中的任务详情入口。

验证：

```bash
npx tsx -e "import { sanitizeReturnTo, taskReturnLabel, taskDetailHref } from './src/lib/navigation/return-to.ts'; ..."
npx tsc --noEmit --pretty false
npm run build
BASE_URL=http://localhost:3000 npx tsx scripts/project-ui-smoke.ts
```

结果：全部通过；ClickOps CLI 可启动 session，但本次 session 未在后续 CLI 调用中保留，因此未拿到浏览器 snapshot，已用构建和本地 UI smoke 替代。

### 验证命令

```bash
npx tsc --noEmit --pretty false
npm run build
```

---

## 6. P1 图集卡片需要截图/封面

### 原始反馈

> 参考图集的图集卡片需要有截图

### 当前实现依据

- `prisma/schema.prisma`
  - `ReferenceAlbum.cover_image_id` 已存在。
- `src/app/api/reference-albums/route.ts`
  - `serializeAlbum` 返回 `cover_image_id`，但没有返回 `cover_image_url`。
  - 只返回 `_count.images`。
- `src/app/collections/ReferenceAlbumsClient.tsx`
  - 卡片封面区域只显示“X 张”或“空图集”。

### 目标行为

- 图集卡片显示可识别缩略图。
- 有 `cover_image_id` 时优先显示封面图。
- 没有封面时使用第一张 active 图片。
- 空图集显示空状态。

### 优化方案

API 返回封面信息，前端卡片展示图片。

接口设计：

```ts
cover_image_id: string | null
cover_image_url: string | null
```

图片 URL 使用现有安全内容接口：

```text
/api/reference-images/:imageId/content?variant=thumbnail
```

### 任务清单

- [x] 修改 `src/app/api/reference-albums/route.ts`，查询每个 album 的封面图或第一张 active 图片。
- [x] 修改 `serializeAlbum`，返回 `cover_image_url`。
- [x] 修改 `src/app/collections/ReferenceAlbumsClient.tsx` 的 `AlbumItem` 类型。
- [x] 修改 `album-card-cover`，有图时渲染 `<img>`。
- [x] 图片加载失败时 fallback 到“X 张”。
- [x] 补 CSS：固定封面比例，避免卡片跳动。
- [x] 确保封面图片接口仍走参考图权限。

### 验收

- 有图集显示封面。
- 空图集显示空状态。
- 无权限图片不泄露。
- 卡片布局不因图片加载而跳动。

### 验证命令

```bash
npx tsc --noEmit --pretty false
npm run build
```

### 执行记录 - 2026-06-10

已补图集卡片封面：

- `src/app/api/reference-albums/route.ts` 只返回 active 图集，并为每个图集返回 `cover_image_url`。
- 有 `cover_image_id` 且封面仍为 active 图片时优先用封面；否则使用第一张 active 图片。
- 封面 URL 统一走 `/api/reference-images/:imageId/content?variant=thumbnail`，继续复用参考图权限校验。
- `src/app/collections/ReferenceAlbumsClient.tsx` 卡片有图时显示封面图；图片加载失败或空图集时 fallback 到数量/空状态。
- `src/app/globals.css` 固定封面比例，避免图片加载造成卡片跳动。

---

## 7. P1 图集删除按钮

### 原始反馈

> 图集没有删除按键

### 当前实现依据

- `src/app/api/reference-albums/[id]/route.ts`
  - 已有 `DELETE`。
  - 会把 `ReferenceAlbum.status` 改为 `deleted`。
  - 同时把该 album 下 `ReferenceImage.status` 改为 `deleted`。
- `src/lib/reference-albums/permissions.ts`
  - `assertCanEditAlbum` 已存在。
- `src/app/collections/ReferenceAlbumsClient.tsx`
  - 列表卡片未提供删除按钮。
- `src/app/collections/[id]/ReferenceAlbumDetailClient.tsx`
  - 详情页有编辑权限判断，但未看到删除图集按钮。

### 目标行为

- 有编辑权限的用户可以删除/归档图集。
- 删除前有确认。
- 删除后列表刷新。
- 历史任务引用不被破坏。

### 关键风险

当前 DELETE 会把图集内 `ReferenceImage` 也标记 `deleted`。如果历史任务需要通过 `reference_image_ids` 回看参考图，这可能影响历史追溯。删除图集更安全的语义应是：

- 图集不再出现在列表。
- 图集内图片不再作为可选素材。
- 历史任务引用仍可追溯。

### 优化方案

把“删除”产品语义定义为软删除/归档，并保留历史引用。

建议：

- 短期：前端按钮调用 DELETE，但文案写“删除图集”，提示“历史任务引用不受影响”。
- 中期：调整后端 DELETE，避免直接把所有 `ReferenceImage` 标记为 `deleted`，或增加 `archived` 状态区分。

### 任务清单

- [x] 先确认是否允许修改 DELETE 行为；若不确认，先不改后端，只补按钮和警告。
- [x] 在 `ReferenceAlbumsClient` 卡片上为 `permissions.edit` 用户显示删除按钮。
- [x] 阻止删除按钮点击冒泡，避免跳转详情。
- [x] 弹出确认：删除后图集不再显示，历史任务仍保留引用。
- [x] 调用 `DELETE /api/reference-albums/:id`。
- [x] 成功后从列表移除该 album。
- [x] 在详情页也增加删除入口。
- [x] 如果调整后端 DELETE，增加操作日志 detail，说明是否保留图片。

### 验收

- 无编辑权限用户看不到删除按钮。
- 有编辑权限用户可删除。
- 删除后 `/collections` 列表不显示。
- 历史任务详情不应因为删除图集而报错。

### 验证命令

```bash
npx tsc --noEmit --pretty false
npm run build
```

### 执行记录 - 2026-06-10

已补图集删除入口，并收敛删除语义：

- `src/app/collections/ReferenceAlbumsClient.tsx` 为可编辑图集显示“删除”按钮，按钮不再嵌在详情链接内部，避免点击冲突。
- `src/app/collections/[id]/ReferenceAlbumDetailClient.tsx` 在详情操作区增加“删除图集”。
- 删除前确认文案明确：图集从列表隐藏，历史任务引用的参考图仍保留。
- `src/app/api/reference-albums/[id]/route.ts` 的 DELETE 从“图集 deleted + 图片全部 deleted”改为“图集 archived + 图片保留 active”，并记录 `preserved_reference_images: true`。
- 列表 API 只返回 `status='active'` 图集，因此 archived 图集会从 `/collections` 隐藏；直接历史引用仍不会因为图片被批量删除而丢失。

注意：本次未执行真实 DELETE 请求，避免修改本地真实图集数据；DELETE 路径已通过类型检查和构建覆盖。

---

## 8. P1 图集重命名、新建入口和管理动作

### 原始反馈

> 已保存的，图集名字修改，没有做这个功能和按钮，新建图集按钮删除

### 当前实现依据

- `src/app/api/reference-albums/[id]/route.ts`
  - `PATCH` 已支持 `name`、`description`、`status`。
- `src/app/api/reference-albums/route.ts`
  - `POST` 已支持新建个人/项目/公共图集。
- `src/app/collections/ReferenceAlbumsClient.tsx`
  - 页面顶部已有新建图集区域。
  - 卡片未提供重命名入口。
- `src/components/ImageSetToolbar.tsx`
  - 生成器里已有保存/新建图集弹窗逻辑。

### 目标行为

- 用户能从图集列表或详情页重命名图集。
- 新建入口明确、稳定、可发现。
- 删除、重命名、进入详情不要互相冲突。

### 优化方案

补齐前端管理入口，不重复造后端能力。

前端交互：

- 图集卡片右上角显示更多菜单。
- 菜单项：重命名、删除。
- 详情页标题旁提供重命名按钮。
- 新建图集区域改成更明确的 primary action。

### 任务清单

- [x] 修改 `ReferenceAlbumsClient`，为 `AlbumItem.permissions.edit` 增加卡片操作菜单。
- [x] 实现重命名弹窗或 inline 编辑。
- [x] 调用 `PATCH /api/reference-albums/:id`。
- [x] 成功后更新本地 `albums` 状态。
- [x] 失败时显示错误，不吞掉后端错误。
- [x] 修改 `ReferenceAlbumDetailClient`，在标题区增加重命名入口。
- [x] 梳理新建图集入口文案和按钮位置。
- [x] 补 CSS，菜单不遮挡卡片主要内容。

### 验收

- 有编辑权限用户可重命名。
- 无编辑权限用户看不到编辑入口。
- 重命名后列表和详情页同步显示新名称。
- 新建图集入口在空列表时也可见。

### 验证命令

```bash
npx tsc --noEmit --pretty false
npm run build
```

### 执行记录 - 2026-06-10

已补图集管理动作：

- 列表卡片为可编辑图集显示“重命名 / 删除”动作。
- 详情页为可编辑图集显示“重命名图集 / 删除图集”动作。
- 重命名调用既有 `PATCH /api/reference-albums/:id`，成功后局部更新列表或详情标题。
- 新建图集入口保留在列表顶部，继续作为稳定主入口。
- CSS 增加卡片动作区和危险动作样式，动作区不覆盖卡片主体点击区域。

验证命令：

```bash
npx tsc --noEmit --pretty false
npm run build
BASE_URL=http://localhost:3002 npx tsx scripts/project-ui-smoke.ts
```

额外只读 smoke：

```bash
BASE_URL=http://localhost:3002 node - <<'JS'
// GET /collections
// GET /api/reference-albums?scope=all
// GET /api/reference-albums/:id
// GET /collections/:id
JS
```

验证结果：

- TypeScript 检查通过。
- 生产构建通过；仅有既有 `<img>` lint warning。
- 图集只读 smoke 通过：当前样本用户可读 22 个图集，列表和详情都返回 `cover_image_url`，页面路由返回 200。
- 项目 UI 只读 smoke 通过。

---

## 9. P1 产出留存和视频详情显示生成者头像

### 原始反馈

> 在产出留存队列里，所有的项目都应该显示生成者和生成者的头像，包括在打开具体视频的时候，视频上方也应该有显示

### 当前实现依据

- `src/app/api/admin/outputs/route.ts`
  - 已返回 `owner` 和 `submitted_user`，但 userSummary 当前不包含 `avatar_url`。
- `src/app/admin/outputs/AdminOutputsClient.tsx`
  - `OutputItem.owner` 已存在。
  - 列表 meta 已显示 `userLabel(output.owner)`。
  - 没有头像组件。
- `src/app/api/video/status/[id]/route.ts`
  - 当前任务详情状态接口返回 task，但需要确认是否包含 owner/user 关系。
- `src/app/tasks/[id]/page.tsx`
  - `VideoTask` 类型没有 owner/user/avatar 字段。

### 目标行为

- 产出留存列表每条都显示生成者头像和名称。
- 任务详情页视频上方显示生成者头像、名称、项目、来源。
- Web 生成和 Codex API 生成都能显示来源。
- 如果没有头像，用姓名首字母/汉字 fallback。

### 推荐方案

新增统一人员展示组件，避免各页面自己拼。

建议新增：

- `src/components/UserIdentityBadge.tsx`
  - props：`user`、`size`、`showEmail`、`subtitle`。
  - 支持头像失败 fallback。
- `src/lib/users/display.ts`
  - `displayUserName(user)`
  - `displayUserSubtitle(user)`
  - 隐藏 Feishu 技术邮箱。

API 改造：

- `src/app/api/admin/outputs/route.ts`
  - `userSummary` 增加 `avatar_url`。
- `src/app/api/video/status/[id]/route.ts`
  - 查询 task 时 include/select `owner`、`user`、`project`。
  - 返回 `owner`、`submitted_user`、`source_type`、`source_label`、`source_request_id`。

页面改造：

- `AdminOutputsClient` 用 `UserIdentityBadge` 替代纯文本 `userLabel`。
- `tasks/[id]/page.tsx` 在视频区域上方增加“生成者/项目/来源”信息条。

### 任务清单

- [x] 新增 `src/lib/users/display.ts`。
- [x] 新增 `src/components/UserIdentityBadge.tsx`。
- [x] 修改 `src/app/api/admin/outputs/route.ts`，返回 `avatar_url`。
- [x] 修改 `src/app/admin/outputs/AdminOutputsClient.tsx` 类型和 UI。
- [x] 修改 `src/app/api/video/status/[id]/route.ts`，返回 owner/submitted_user/project/source。
- [x] 修改 `src/app/tasks/[id]/page.tsx` 的 `VideoTask` 类型。
- [x] 在任务详情页视频上方渲染生成者、项目、来源。
- [x] Codex API 来源显示 `source_label || Codex API`。

### 验收

- 后台产出列表可见头像和名称。
- 任务详情页视频上方可见生成者头像。
- 没有头像时显示 fallback。
- 外部 API 任务能显示来源名称。

### 验证命令

```bash
npx tsc --noEmit --pretty false
npm run build
```

### 执行记录 - 2026-06-10

已补统一用户身份展示和任务来源展示：

- `src/lib/users/display.ts` 新增用户显示格式化：隐藏 `feishu_...@feishu.local`、`ou_...` 等技术身份，优先显示姓名、真实邮箱、普通用户名。
- `src/components/UserIdentityBadge.tsx` 新增头像/姓名 badge，支持头像失败 fallback。
- `src/app/api/admin/outputs/route.ts` 的 owner/submitted/操作人摘要增加 `avatar_url` 和 `account_type`。
- `src/app/admin/outputs/AdminOutputsClient.tsx` 的产出列表用 `UserIdentityBadge` 展示生成者头像和名称。
- `src/app/api/video/status/[id]/route.ts` 返回 `owner` 和 `submitted_user`，并保留 `project/source_type/source_label/source_request_id`。
- `src/app/tasks/[id]/page.tsx` 在视频区域上方增加“生成者 / 项目 / 来源 / 请求”信息条；Codex API 来源显示 `source_label || Codex API`。
- `src/app/globals.css` 增加统一身份 badge 和任务详情身份条样式，移动端自动堆叠。

验证命令：

```bash
npx tsx -e "import { displayUserName, displayUserSubtitle, isSyntheticFeishuEmail, isTechnicalUsername } from './src/lib/users/display.ts'; ..."
npx tsc --noEmit --pretty false
npm run build
BASE_URL=http://localhost:3002 npx tsx scripts/project-ui-smoke.ts
```

额外只读 smoke：

```bash
BASE_URL=http://localhost:3002 node - <<'JS'
// GET /admin/outputs
// GET /api/admin/outputs?limit=3&include_deleted=true
// GET /tasks/:id
// GET /api/video/status/:id for provider_task_id=null task
JS
```

验证结果：

- 用户显示格式化 smoke 通过。
- TypeScript 检查通过。
- 生产构建通过；仅有既有 `<img>` lint warning。
- Batch 5 只读 smoke 通过：产出 API owner 带 `avatar_url`，任务详情页返回 200，安全状态任务返回 `owner/submitted_user`。
- 项目 UI 只读 smoke 通过。

注意：

- 本批次未执行隐藏/恢复/生成等写动作。
- `impeccable` 未找到项目级 `PRODUCT.md` / `DESIGN.md`，本次按 product register 和现有后台视觉体系执行。

---

## 10. P1 账号信息后缀太长

### 原始反馈

> 为什么我的这个账号的信息后缀这么长，别人都是邮箱？帮我改改显示

### 当前实现依据

- `src/components/AccountMenu.tsx`
  - `displayName = user.name || user.username || user.email`。
  - 如果 Feishu 用户没有真实邮箱，可能展示 `ou_...` 或 `feishu_...@feishu.local`。
- `src/lib/auth/feishu.ts`
  - `fallbackEmail` 会生成 `feishu_<identifier>@feishu.local`。
  - `usernameBase` 可能使用 Feishu openId 后缀。

### 目标行为

- 用户可见区域优先展示姓名。
- 不把 `ou_...`、`feishu_...@feishu.local` 作为主身份文本。
- 技术 ID 仍保留在数据库和后台调试信息，不删除。

### 优化方案

新增统一展示格式化函数，不改原始身份字段。

显示优先级：

1. `name`
2. 真实邮箱，排除 `@feishu.local`
3. 手机号，如后续接口返回
4. 短用户名，过滤 `ou_`、`feishu_`
5. `用户 <id前6位>`

建议新增：

- `src/lib/users/display.ts`
  - `isSyntheticFeishuEmail(email)`
  - `isTechnicalUsername(username)`
  - `displayUserName(user)`
  - `displayUserSecondary(user)`

### 任务清单

- [x] 新增 `src/lib/users/display.ts`。
- [x] 写纯函数测试或脚本验证常见输入：
  - `name=杨波, username=ou_xxx, email=feishu_xxx@feishu.local`
  - `name=null, email=real@example.com`
  - `name=null, username=goukiyang`
- [x] 修改 `AccountMenu.tsx` 使用 `displayUserName`。
- [x] 修改后台产出、图集 owner、项目 owner 等用户标签，统一使用格式化函数。
- [x] 管理员详情页可继续显示技术 ID，但应放在“调试/绑定信息”区域。

### 验收

- 杨波账号顶部展示“杨波”，不展示长 `ou_...`。
- 真实邮箱用户仍可展示邮箱或邮箱前缀。
- Feishu 绑定字段未被修改。

### 验证命令

```bash
npx tsc --noEmit --pretty false
npm run build
```

### 执行记录 - 2026-06-10

已完成账号展示格式化：

- 复用 `src/lib/users/display.ts`，统一隐藏 `ou_...`、`feishu_...@feishu.local` 等技术身份。
- `src/components/AccountMenu.tsx` 顶部账号主名称改用 `displayUserName`。
- `src/app/account/page.tsx` 主名称改用 `displayUserName`；合成飞书邮箱显示为“未绑定真实邮箱”。
- 项目、生成页项目选择、图集列表/详情、图集选择器、画布工作台、后台项目、后台首页、成本页、项目详情、反馈页、集成页、生成驾驶舱和相关 CSV 导出中的 owner/member 主显示改用统一格式化。
- `src/app/admin/users/AdminUsersClient.tsx` 的用户列表主名称、批量操作预览、合并账号下拉和确认文案改用格式化名称；原始 username/email 仍保留在搜索、表单和后端审计字段中。

验证命令：

```bash
npx tsx -e "import { displayUserName, displayUserSubtitle, isSyntheticFeishuEmail, isTechnicalUsername } from './src/lib/users/display.ts'; ..."
npx tsc --noEmit --pretty false
npm run build
BASE_URL=http://localhost:3002 npx tsx scripts/project-ui-smoke.ts
npx impeccable detect src/components/AccountMenu.tsx
npx impeccable detect src/app/admin/users/AdminUsersClient.tsx
```

额外只读 smoke：

```bash
BASE_URL=http://localhost:3002 node - <<'JS'
// GET /account, /projects, /collections, /generate
// GET /admin/users, /admin/projects, /admin/integrations, /admin/feedback
// GET /api/auth/me
JS
```

验证结果：

- 用户显示格式化 smoke 通过。
- TypeScript 检查通过。
- 生产构建通过；仅有既有 `<img>` lint warning。
- Batch 6 只读页面 smoke 通过。
- 项目 UI 只读 smoke 通过。
- `impeccable detect` 通过且无输出问题。

注意：

- 没有修改真实 Feishu 绑定字段、登录逻辑、账号合并逻辑或数据库数据。
- API 审计字段和搜索逻辑仍保留原始 username/email，便于管理员追溯。

---

## 11. P2 “请写提示词”不要红色

### 原始反馈

> 请写提示词这几个字，也不要用红色，蓝色即可

### 当前实现依据

- `src/components/GenerationComposer.tsx`
  - `statusText` 在 prompt 为空时返回 `请填写提示词`。
  - 状态展示由 `ComposerStatusLine` 和 CSS 决定。
- `src/components/PreSubmissionChecker.tsx`
  - prompt 为空被标记为 `error`。
- `src/app/globals.css`
  - 存在 `composer-status-error`、`pre-check-badge-error` 等红色语义。

### 目标行为

- 用户尚未输入 prompt 时，展示为引导，不是错误。
- 只有用户点击提交后仍为空，才展示为错误。
- 引导态使用蓝色或中性色。

### 优化方案

区分三种状态：

- `idle_hint`：未输入、未提交，蓝色。
- `blocking_error`：点击提交后为空，红色。
- `valid`：已输入并校验通过，绿色或中性。

### 任务清单

- [x] 修改 `GenerationComposer`，增加 `hasAttemptedSubmit` 状态。
- [x] prompt 为空且未提交时，状态为 hint。
- [x] prompt 为空且已提交时，状态为 error。
- [x] 修改 `ComposerStatusLine` 支持 `tone="hint|progress|ok|error"`。
- [x] 修改 `PreSubmissionChecker`，空 prompt 在未提交前不显示红色 badge。当前代码未发现独立 `PreSubmissionChecker`，实际红色来源在 `ComposerStatusLine`，已在该组件修正。
- [x] 调整 `globals.css`，新增蓝色 hint 样式。

### 验收

- 刚进页面时，“请填写提示词”不是红色。
- 点击提交但 prompt 为空时，才显示红色错误。
- 其他错误仍为红色。

### 执行记录 - 2026-06-10

已把 `GenerationComposer` 的状态展示拆成 `submitBlocker`、`hasAttemptedSubmit` 和 `composerStatus`：

- 首次进入生成页时，空 prompt 展示为蓝色 hint。
- 用户点击提交后仍为空，才转为红色 error。
- `提交中...` 走 progress 语义，不再走 error 样式。
- `ComposerStatusLine` 支持 `hint | progress | ok | error` 四种 tone。

### 验证命令

```bash
npx tsc --noEmit --pretty false
npm run build
```

---

## 12. P2 “提交中”不要红色

### 原始反馈

> 提交中不应该是个红色，用绿色即可

### 当前实现依据

- `src/components/GenerationComposer.tsx`
  - `statusText` 在提交时返回 `提交中...`。
- `src/app/globals.css`
  - 进行态和错误态样式需要统一审计。

### 目标行为

- `提交中` 是进行态，使用绿色、蓝色或中性色。
- `排队中`、`生成中` 也保持进行态语义。
- 只有失败、错误、危险操作使用红色。

### 优化方案

定义全站状态颜色语义：

- `idle/hint`：蓝色或中性。
- `progress/submitted/running`：绿色或蓝色。
- `success/succeeded`：绿色。
- `warning`：黄色。
- `error/failed/danger`：红色。

### 任务清单

- [x] 梳理 `globals.css` 中 `status-submitted`、`status-running`、`composer-status-error`、`pre-check-*`。
- [x] 修改 `ComposerStatusLine`，提交中使用 `tone="progress"`。
- [x] 修改提交按钮 loading 样式，避免沿用 danger/error。当前按钮 loading 使用蓝色 spinner，未沿用 danger/error，无需额外改动。
- [x] 检查 `/tasks`、`/generate` 最近任务、`/admin/outputs` 的 submitted/running badge。
- [x] 补一个状态颜色映射注释，避免以后再混用。

### 验收

- “提交中”不再红色。
- “排队中/生成中”不再红色。
- “失败/错误”仍然红色。
- 颜色在生成页、任务页、后台产出页一致。

### 执行记录 - 2026-06-10

已统一状态颜色语义：

- `status-submitted` 继续使用蓝色，表示排队/提示。
- `status-running` 改为绿色，表示进行中。
- `composer-task-card-status.running` 改为绿色。
- `composer-status-progress` 使用绿色；`composer-status-hint` 使用蓝色；`composer-status-error` 仍为红色。
- `globals.css` 增加状态颜色语义注释：蓝色=提示/排队，绿色=进行/成功，黄色=注意，红色=失败/危险。

### 验证命令

```bash
npx tsc --noEmit --pretty false
npm run build
```

---

## 13. 推荐实施批次

### Batch 1：权限审计，不改业务

目标：确认是否存在越权。

任务：

- 新增 `scripts/task-permission-matrix-smoke.ts`。
- 跑出权限矩阵。
- 如果无越权，只记录结论。
- 如果有越权，进入 Batch 2。

验证：

```bash
npx tsx scripts/task-permission-matrix-smoke.ts
```

### Batch 2：安全修复

目标：修复 Batch 1 发现的越权。

任务：

- 修改 `src/lib/projects/permissions.ts`。
- 修改遗漏鉴权的 API。
- 跑权限矩阵。

验证：

```bash
npx tsx scripts/task-permission-matrix-smoke.ts
npx tsc --noEmit --pretty false
npm run build
```

### Batch 3：连续生成与偏好

目标：让用户能连续生成，并保存上次参数。

状态：已完成本地实现和验证。真实付费生成闭环待授权后验证。

任务：

- [x] 改生成成功提示。
- [x] 增加用户生成偏好。
- [x] 加载/保存默认参数。

验证：

```bash
npm run db:generate
npx tsc --noEmit --pretty false
npm run build
BASE_URL=http://localhost:3002 npx tsx scripts/project-ui-smoke.ts
```

### Batch 4：图集管理

目标：补齐封面、重命名、删除。

任务：

- API 返回封面 URL。
- 列表卡片显示封面。
- 前端补重命名和删除入口。
- 必要时调整 DELETE 语义。

验证：

```bash
npx tsc --noEmit --pretty false
npm run build
```

### Batch 5：产出归属与账号展示

目标：每条产出能看清谁生成、属于哪个项目、来源是什么。

任务：

- 新增统一用户展示工具和 badge。
- 后台产出显示头像。
- 任务详情视频上方显示生成者/项目/来源。
- 隐藏 Feishu 技术 ID。

验证：

```bash
npx tsc --noEmit --pretty false
npm run build
```

### Batch 6：状态颜色语义

目标：红色只用于错误和危险。

任务：

- 修改提示词引导态。
- 修改提交中进行态。
- 统一状态 badge 颜色。

验证：

```bash
npx tsc --noEmit --pretty false
npm run build
```

### Batch 7：项目代付独立 Spec 和实现

目标：设计并落地项目级额度，不破坏现有用户点数。

任务：

- 先写 `tasks/project-billing-scope-spec.md`。
- Spec 确认后再做 Prisma、service、API、后台 UI。
- 最后跑真实或模拟扣费闭环。

验证：

```bash
npm run db:generate
npx tsc --noEmit --pretty false
npm run build
```

真实付费验证必须单独授权。

---

## 14. 总验收清单

- [x] 普通用户不能看到他人非授权任务。
- [x] 项目成员只能看到有权限项目任务。
- [x] 系统管理员能看全站后台产出。
- [ ] 创建成功后可立即继续创建下一段。
- [ ] 用户最后一次生成参数可恢复。
- [x] 任务详情返回来源页。
- [ ] 图集卡片有封面。
- [ ] 有权限用户可重命名图集。
- [ ] 有权限用户可删除/归档图集。
- [ ] 产出留存列表显示生成者头像和名称。
- [ ] 视频详情上方显示生成者、项目、来源。
- [ ] Feishu 技术 ID 不作为主展示名。
- [x] “请填写提示词”默认不是红色。
- [x] “提交中/排队中/生成中”不是红色。
- [ ] 项目代付有独立 Spec，未混入普通 UI 修复。

---

## 15. 不要做的事

- 不要为了修权限反馈只隐藏前端按钮。
- 不要在没有 Spec 的情况下改项目代付。
- 不要硬删除图集素材导致历史任务丢参考图。
- 不要把 Feishu open_id/email fallback 写死替换掉，应该做展示层格式化。
- 不要把状态颜色单点覆盖成绿色，必须按全站状态语义统一。
- 不要在验证脚本里打印 session cookie、token 或签名 URL。

---

## 16. 反馈对齐与闭环审计 - 2026-06-10

### 16.1 总结论

当前规划已经覆盖本轮后台反馈的 12 个问题，但闭环状态不是同一种：

- UI/交互类反馈已经拆到可执行任务和验收路径，可以按 Batch 分批落地。
- 权限类反馈已经明确要做 API 层验证，不能只用页面表现判断闭环。
- 图集删除、项目代付、产出归属属于业务规则问题，必须先确认数据语义，再改 UI 或账本。
- 项目代付不是普通优化项，是计费主体变化；它只能算“已规划闭环”，不能算“已实现闭环”，必须单独 Spec 确认后再动代码。

因此，本文件满足“反馈分析和修改方案规划”的要求；但不代表业务功能已经完成上线。真正闭环要以实现、构建、角色权限验证、必要的数据库/账本验证和线上回归为准。

### 16.2 逐条反馈对齐表

| 原始反馈 | 对应章节 | 当前覆盖状态 | 闭环缺口 / 特别注意 |
|---|---:|---|---|
| 返回任务按键改成哪里来的回哪里去 | 5 | 已拆成 `return_to` 来源页方案 | `return_to` 必须只允许站内相对路径，防止 open redirect；非法值要 fallback 到 `/tasks`。 |
| 创建成功进入排队后提示消失，可以创建下一段 | 3 | 已拆成连续生成工作流 | 表单可重置，但最近任务轮询不能丢；不能让用户误以为旧任务停止了。 |
| 保存每个人最后一次生成设置 | 4 | 已拆成用户偏好方案 | 推荐服务端 `UserPreference`；不要保存一次性素材 URL、签名 URL、临时上传地址或隐私内容。 |
| “请写提示词”不要红色 | 11 | 已拆成 UI 语义修正 | 要区分首次空白引导和提交后的校验错误；只有真正错误才用红色。 |
| 普通角色看我的任务是否看到其他人产出 | 1 | 已列为 P0 权限隔离 | 闭环必须跑不同角色/API 查询；不能只看前端是否隐藏。 |
| “提交中”不应该红色 | 12 | 已拆成状态颜色语义 | 需要全站统一状态颜色映射，避免一个地方改完另一个地方仍然红色。 |
| 图集名字修改/新建/删除 | 7、8 | 已拆成图集管理入口 | 删除语义要先确认是归档集合还是删除素材；不能破坏历史任务引用。 |
| 图集卡片需要截图 | 6 | 已拆成封面 URL 和卡片展示 | 封面图不能绕过权限；无封面时要有稳定 fallback。 |
| 图集没有删除按键 | 7 | 已拆成删除/归档入口 | 默认优先软删除/归档，避免误删 ReferenceImage。 |
| 产出留存队列/视频详情显示生成者头像 | 9 | 已拆成 owner 展示字段 | 要统一 `owner_user_id`、任务创建人、项目成员、外部 API 发起方的口径。 |
| 账号信息后缀太长 | 10 | 已拆成展示名格式化 | 只做展示层格式化，不改 Feishu open_id、email fallback 或绑定数据。 |
| 项目代付/项目管理员设置额度 | 2、Batch 7 | 已拆成独立 Spec 前置项 | 这是账本和扣费主体变化，必须确认冻结、扣除、退款、额度不足、外部 API project_id 行为后再实现。 |

### 16.3 闭环检查

- 需求覆盖：已覆盖 12/12 条反馈。
- 修改方案：每条反馈都有目标、现状判断、推荐方案、涉及文件、任务拆解和验收方式。
- 优先级：P0/P1/P2 已区分，权限和项目代付没有混入普通 UI 修复。
- 验证路径：已有构建验证、角色权限验证、UI 回归、必要的真实/模拟扣费验证路径。
- 风险控制：已有“不要做的事”，本节进一步补充了权限、账本、删除语义、临时 URL、身份口径等高风险点。
- 未闭环部分：功能尚未实现；项目代付仍缺独立 Spec；权限隔离必须用真实角色或脚本验证后才能宣称闭环。

### 16.4 必须特别注意的点

1. 项目代付必须硬隔离成独立任务。它不是“给项目管理员加一个额度输入框”，而是新增计费主体和账本责任边界。
2. 权限问题必须以后端 API 返回为准。前端隐藏按钮只算体验优化，不算权限闭环。
3. 图集删除必须保护历史任务。推荐先做集合归档或解除集合关系，确认没有任务引用后再考虑素材级删除。
4. 用户偏好只保存可复用配置。不要保存签名 URL、临时下载地址、本地路径、一次性上传地址或可能泄露素材权限的内容。
5. 返回来源页必须防开放跳转。任何 `http://`、`https://`、`//evil.com`、跨域路径都必须拒绝。
6. 产出归属要统一口径。至少区分“谁发起生成”“归属哪个项目”“是否由项目代付”“外部 API 是哪个调用方”。
7. 状态颜色要做系统规则。提交中、排队中、生成中是进行态，不是错误态；红色只留给失败、危险、删除确认。
8. 对外 API 生成的内容也要进入统一产出/下载/截图/归属链路，不能只覆盖网页生成入口。

### 16.5 更新后的执行判定

可以直接进入实现的批次：

- Batch 1：权限审计与隔离。
- Batch 2：返回来源与状态颜色。
- Batch 3：连续生成与偏好。
- Batch 4：图集封面和管理。
- Batch 5：产出归属与账号展示。

需要先补 Spec 或规则确认的批次：

- Batch 7：项目代付独立 Spec 和实现。
- 图集删除如果要从“归档集合”升级到“删除素材文件”，必须额外确认保留策略。
- 外部 API 统一自动下载、截图、归属链路如果与本轮反馈一起做，需要和现有 `tasks/todo.md` 中的视频本地留存策略对齐后再实现。

---

## 17. 第二轮新增反馈细化任务 - 2026-06-10

### 17.1 本轮新增反馈来源

只读查询 `Feedback` 表后，发现 2026-06-10 新增 3 条尚未进入前一轮 12 条规划的反馈：

| 时间 | 页面 | 提交人 | 反馈原文 | 本质需求 |
|---|---|---|---|---|
| 2026-06-10 09:25 UTC | `/tasks/:id` | 杨波 | 生成结果页面，实际扣费旁边，要显示生成时间时间不是单纯时间，而事例如刚刚，2分钟，5分种一天前，2天前等等， | 任务详情页需要“发生时间感”，帮助用户快速判断这次扣费/生成是刚发生还是历史记录。 |
| 2026-06-10 06:57 UTC | `/generate` | 张映珊 | 希望可以增加@图片功能，这样跑起来会更准确 | 提示词和参考图要形成一体化素材引用，不只是单独上传图片。 |
| 2026-06-10 06:47 UTC | `/generate` | 侯策超 | 建议增加一个放大提示词输入框的功能，如果提示词过多的话全屏看，或者放大看更清晰，操作更加便捷，更加方便修改 | 长提示词编辑需要更大的工作区，减少小文本框内编辑的认知负担。 |

### 17.2 优先级判断

- P1：任务详情相对时间。改动范围小，直接提升任务结果页理解效率。
- P1：提示词输入框放大/全屏编辑。改动范围集中在 `PromptEditor`，直接提升高频创作体验。
- P2：`@图片` 引用能力。当前 `PromptEditor` 已有“输入 @ 使用素材”提示，但还没有实际选择/插入/解析能力；这会触及素材选择、workspace、prompt 标记、生成参数和外部 API 口径，需要先做语义收敛。

### 17.3 Batch 8：任务详情相对时间

#### 问题定义

用户在任务详情页看“实际扣费”时，需要同步知道这次任务是什么时候完成的。绝对时间适合审计，但不适合快速判断“刚刚完成、几分钟前、一天前”。因此要在结果决策区显示相对时间，并保留绝对时间用于精确核对。

#### 当前代码依据

- `src/app/tasks/[id]/page.tsx`
  - `formatDateTime(value)` 当前返回 `new Date(value).toLocaleString('zh-CN')`。
  - `taskCompletedText = formatDateTime(task.completed_at || task.updated_at)`。
  - 结果决策区在“实际扣费”下方展示“完成时间”，目前只显示绝对时间。

#### 推荐方案

新增一个小型时间格式 helper，不引入第三方库：

- `formatRelativeTime(value, now = Date.now())`
  - `< 60 秒`：`刚刚`
  - `< 60 分钟`：`N 分钟前`
  - `< 24 小时`：`N 小时前`
  - `< 7 天`：`N 天前`
  - 更久：回落到 `YYYY/MM/DD`
- `formatTaskTime(value)`
  - 返回 `{ relative, absolute }`。
  - UI 主显示 `relative`，`title` 放 `absolute`。

#### 细节任务

- [ ] 在 `src/app/tasks/[id]/page.tsx` 增加 `formatRelativeTime` 和 `formatTaskTime`。
- [ ] 将 `taskCompletedText` 改为 `taskCompletedTime = formatTaskTime(task.completed_at || task.updated_at)`。
- [ ] 结果决策区把“完成时间”显示为相对时间，`strong title={taskCompletedTime.absolute}`。
- [ ] 如实际扣费旁边需要更近的视觉关系，可在 `task-decision-price` 下增加一行 `task-decision-time`，文案为 `生成于 ${taskCompletedTime.relative}`。
- [ ] 保留“完成时间”行或调整为“精确时间”，避免丢失审计能力。
- [ ] 如果 `completed_at` 为空但 `updated_at` 有值，文案应避免误导，可显示 `更新于 N 分钟前`。

#### 验收

```bash
npx tsc --noEmit --pretty false
npm run lint
npm run build
```

建议补一个轻量 smoke：

```bash
npx tsx -e "import('./src/app/tasks/[id]/page.tsx').catch(() => console.log('page module is client-heavy; rely on build'))"
```

手工/浏览器验收：

1. 打开最近完成任务详情页。
2. “实际扣费”附近能看到 `刚刚 / N 分钟前 / N 小时前 / N 天前`。
3. 鼠标悬停或同区域仍能看到完整绝对时间。
4. 页面没有因为相对时间字符串变长导致排版挤压。

### 17.4 Batch 9：提示词输入框放大/全屏编辑

#### 问题定义

长提示词是核心生产资料，用户需要在更大空间里阅读、修改、复制和检查引用。当前 `PromptEditor` 固定 `rows={4}`，适合短 prompt，不适合复杂 prompt。

#### 当前代码依据

- `src/components/PromptEditor.tsx`
  - 当前只接收 `value/onChange/onFormat`。
  - 使用固定 textarea：`className="composer-prompt-textarea"`、`rows={4}`、`MAX_CHARS=2000`。
  - footer 已显示 `@` 使用提示和字符数。
- `src/components/GenerationComposer.tsx`
  - 直接渲染 `<PromptEditor value={prompt} onChange={setPrompt} />`。
- `src/app/globals.css`
  - 已有 composer 类样式，可追加编辑器放大弹层样式。

#### 推荐方案

先做“可放大编辑”，不要一次做复杂富文本：

- 在 `PromptEditor` 内部增加 `expanded` 状态。
- 默认 textarea 保持现状。
- footer 或输入框右上角增加按钮：`放大编辑`。
- 点击后打开全屏或大面板编辑器：
  - 大 textarea 占主要区域，支持 2000 字限制。
  - 顶部显示“提示词编辑”。
  - 操作：`完成`、`取消`。
  - `完成` 写回当前 prompt。
  - `取消` 放弃弹层内未保存修改。
- 支持 `Esc` 关闭，关闭前如果内容有变化需要二次确认。
- 不做 Markdown、富文本、自动改写，避免破坏纯 prompt。

#### 细节任务

- [ ] 修改 `src/components/PromptEditor.tsx`，增加本地 `expanded`、`draft` 状态。
- [ ] 把 `MAX_CHARS` 限制复用到弹层 textarea。
- [ ] 默认 footer 增加 `放大编辑` 按钮，按钮不应遮挡字符数。
- [ ] 弹层打开时初始化 `draft=value`。
- [ ] 弹层 `完成` 时调用 `onChange(draft)` 并关闭。
- [ ] 弹层 `取消` 时如果 `draft !== value`，用确认提示防止误关。
- [ ] 加 `useEffect` 监听 `Escape`，调用同一套取消逻辑。
- [ ] 在 `src/app/globals.css` 增加 `.composer-prompt-expanded-*` 样式，保证桌面和移动端无横向溢出。
- [ ] 检查 `GenerationComposer` 无需改 props；如果后续 `@图片` 需要插入能力，再扩展 `PromptEditor` props。

#### 验收

```bash
npx tsc --noEmit --pretty false
npm run lint
npm run build
npx impeccable detect src/components/PromptEditor.tsx
```

浏览器验收：

1. `/generate` 默认输入框仍显示 4 行，不影响现有生成流程。
2. 点击“放大编辑”打开大面板。
3. 在大面板输入长 prompt，字符数同步。
4. 点击“完成”后主输入框内容更新。
5. 点击“取消”不保存未完成修改。
6. 移动端宽度下弹层无横向滚动，按钮不溢出。

### 17.5 Batch 10：`@图片` 引用能力

#### 问题定义

反馈不是要一个装饰性的 `@` 文案，而是希望“提示词里的图片引用”和“实际传给生成接口的参考图”能对应起来，提高生成准确性。

当前 `PromptEditor` footer 已提示“输入 @ 使用素材或参考”，但系统没有：

- `@` 触发的素材选择器。
- 把选中的图片插入 prompt 的标记。
- 从 prompt 标记回溯到 workspace 参考图。
- 防止 prompt 引用和实际 reference images 不一致的机制。

#### 当前代码依据

- `src/components/PromptEditor.tsx`
  - 当前只是普通 textarea，没有选择器或 token。
- `src/components/GenerationComposer.tsx`
  - `workspace.assets` 是当前生成素材来源。
  - 提交时把 `workspace.assets` 中的 `referenceImageId` 传给 `referenceImageIds`。
  - `handleAddReferenceImages` 可通过 `ReferenceAlbumPicker` 把图集图片加入 workspace。
- `src/lib/hooks/useWorkspace.ts`
  - `addReferenceImages(referenceImageIds)` 已能把参考图加入 workspace assets。
  - `loadReferenceAlbum(albumId)` 可把图集图片替换进 workspace。
- `src/components/ReferenceAlbumPicker.tsx`
  - 已有选择参考图的入口，可作为 `@图片` 的数据源之一。

#### 推荐分阶段方案

阶段 A：`@` 插入当前 workspace 图片引用，不引入新数据结构。

- 用户在 prompt 中点击“插入图片引用”或输入 `@` 后，从当前已上传/已选素材中选择。
- 插入文本标记：`@图片1`、`@图片2`。
- 继续复用现有 `checkPrompt` 对 `图片1/图片2` 的校验。
- 优点：实现小，能立刻让 prompt 和现有参考图对应。
- 限制：不能从所有图集中搜索图片。

阶段 B：`@` 可从参考图集选择图片并自动加入 workspace。

- 在 `PromptEditor` 或 `GenerationComposer` 增加 `onInsertReferenceImage` 回调。
- 用户选择图集图片后，先调用 `workspace.addReferenceImages([id])`。
- 加入成功后，根据新素材顺序插入 `@图片N`。
- 需要处理去重：已在 workspace 的参考图不重复添加，直接插入已有序号。

阶段 C：统一素材引用语义。

- 明确 `@图片N` 只是 prompt 辅助标记，不新增后端字段。
- 外部 API 仍传 `reference_image_ids/reference_image_urls`。
- 未来如需结构化 prompt mentions，再新增 `prompt_mentions_json`，当前不做。

#### Batch 10A 细节任务：先做当前素材插入

- [ ] 修改 `src/components/PromptEditor.tsx`，增加可选 props：
  - `referenceLabels?: Array<{ label: string; title: string }>`
  - `onInsertReferenceLabel?: (label: string) => void`
- [ ] 用 `textarea.selectionStart/selectionEnd` 把 `@图片N` 插入光标位置。
- [ ] 修改 `src/components/GenerationComposer.tsx`，根据 `workspace.assets` 生成 `referenceLabels`：
  - 第 1 张：`图片1`
  - 第 2 张：`图片2`
  - title 使用素材名称或来源。
- [ ] 如果没有素材，插入入口置灰，文案为“先上传或选择图片”。
- [ ] 保持现有 `PromptChecker` 校验，不新增后端字段。
- [ ] 更新 footer 文案，避免承诺“所有图集搜索”。

#### Batch 10B 细节任务：再接图集选择

- [ ] 设计 `ReferenceMentionPicker` 或复用 `ReferenceAlbumPicker`，先确认交互形态。
- [ ] 在 `GenerationComposer` 中新增 `handleMentionReferenceImage(imageId)`。
- [ ] 调用 `workspace.addReferenceImages([imageId])` 后计算该图片在 `workspace.assets` 中的序号。
- [ ] 插入 `@图片N`。
- [ ] 如果图片添加失败，显示错误，不插入 prompt。
- [ ] 增加去重逻辑，避免同一参考图被重复加入 workspace。

#### 验收

Batch 10A：

```bash
npx tsc --noEmit --pretty false
npm run lint
npm run build
npx impeccable detect src/components/PromptEditor.tsx
```

浏览器验收：

1. `/generate` 上传或选择 2 张图。
2. 在 prompt 光标处插入 `@图片1`。
3. 文本中出现 `@图片1`，提交前 `PromptChecker` 不报缺图。
4. 删除第 1 张图后，提示词引用校验能提示引用数量不足或顺序变化风险。

Batch 10B：

1. 点击 `@图片` 入口。
2. 从图集选择图片。
3. 图片进入 workspace。
4. prompt 插入对应 `@图片N`。
5. 提交 payload 仍包含正确 `reference_image_ids`。

#### 风险与停止条件

- 不要做富文本编辑器，先保持纯文本 prompt。
- 不要只插入 `@图片` 文本却不加入 reference image，否则会制造“看起来引用了，实际没传图”的假闭环。
- 如果无法稳定映射图片到 `workspace.assets` 顺序，先停在 Batch 10A，不做 Batch 10B。
- 不要把临时签名 URL、本地路径或私有素材 URL 存进用户偏好。

### 17.6 新增批次建议

- Batch 8：任务详情相对时间，低风险，优先落地。
- Batch 9：提示词输入框放大/全屏编辑，低到中风险，优先落地。
- Batch 10A：`@图片` 当前素材插入，中风险，先做轻量版。
- Batch 10B：`@图片` 从图集选择并自动加入 workspace，中到高风险，需在 10A 验收后再做。

### 17.7 第二轮闭环检查

- 需求覆盖：新增 3/3 条反馈已拆解。
- 修改方案：每条都有目标、现状依据、涉及文件、任务拆解和验收方式。
- 特别注意：`@图片` 不能只做 UI 文案；必须保证 prompt 引用和实际 reference image 参数一致。
- 未闭环部分：本节当时只是细化任务规划；Batch 8、Batch 9、Batch 10A 后续已落地，最新状态以第 20 节为准。

---

## 18. 用户本质反馈对齐审计 - 2026-06-10

### 18.1 总判断

这批反馈的本质不是“修几个按钮和文案”，而是把 SD2 从单次生成表单升级成多人协作的视频生产工作台。用户真实在意的是：

1. 生成过程不中断，能连续创作。
2. 结果、时间、扣费和归属都能快速看懂。
3. 参考图和 prompt 能绑定在一起，提高生成准确性。
4. 多人协作时权限可信，身份可读。
5. 点数、项目代付和官方成本能查账。
6. 导航能回到原工作上下文。

因此后续执行要按“生产工作台闭环”验收，而不是按“反馈原文里出现了某个按钮”验收。

### 18.2 本质需求对齐表

| 本质需求 | 对应原始反馈 | 当前规划/实现 | 闭环标准 | 当前状态 |
|---|---|---|---|---|
| 连续创作不中断 | 创建成功进入排队后提示消失；可以创建下一段 | Batch 3 已落地连续生成和最近任务后台轮询 | 提交后表单可继续编辑；旧任务仍轮询；成功/失败状态可追踪 | 本地已实现，仍需生产回归 |
| 个性化生成习惯可恢复 | 每个人最后一次生成设置默认保存 | Batch 3 已新增 `UserPreference` 和生成偏好 API | 跨设备恢复参数；不保存签名 URL、素材 URL、本地路径 | 本地已实现，依赖迁移上线 |
| 状态语义不制造误报 | “请写提示词”不要红色；“提交中”不要红色 | Batch 2 已调整 hint/progress/error 语义 | 只有真实错误用红色；进行态用绿色/中性色；引导态用蓝色 | 本地已实现 |
| 任务结果可快速理解 | 实际扣费旁边显示相对生成时间 | Batch 8 已落地 | 显示“刚刚/N 分钟前/N 天前”，同时保留绝对时间 | 本地已实现，仍需生产回归 |
| 长 prompt 可舒服编辑 | 提示词输入框放大/全屏 | Batch 9 已落地 | 大面板编辑、完成写回、取消不污染、移动端不溢出 | 本地已实现，仍需生产回归 |
| prompt 与图片引用一致 | 增加 `@图片` 功能，让生成更准确 | Batch 10A 已按官方 `@图片N` 格式落地，Batch 10B 图集选择待做 | 插入 `@图片N` 必须对应真实 workspace/reference image，payload 仍传正确 `reference_image_ids` | 当前素材本地已实现，图集选择未实现 |
| 素材可识别、可管理 | 图集卡片截图；图集改名/删除 | Batch 4 已落地图集封面、重命名、归档删除 | 图集封面受权限控制；删除不破坏历史任务引用 | 本地已实现 |
| 权限边界可信 | 普通角色是否看到别人任务 | Batch 1 已做权限矩阵 smoke | API 层不返回越权任务、状态、截图和后台产出 | 本地验证通过 |
| 生成归属清晰 | 产出留存和视频详情显示生成者头像 | Batch 5/6 已做 owner/submitted_user 和显示名格式化 | 产出、任务详情、后台列表统一显示人可读身份 | 本地已实现 |
| 技术账号不干扰使用 | 飞书技术 ID 后缀太长 | Batch 6 已做展示名格式化 | 主 UI 不暴露 `ou_...` / `feishu_...@feishu.local`，审计仍保留原始字段 | 本地已实现 |
| 账务透明可追溯 | 项目代付；点数流水二级页 | Batch 7 Spec + `/admin/points` 先行落地 | 用户自付/项目代付/系统账务主体清晰，冻结、扣除、退款可追溯 | 点数流水页已落地；项目代付未实现 |
| 导航不丢上下文 | 返回任务按钮哪里来的回哪里去 | Batch 2 已做 `return_to` | 来源页安全回跳；非法外链 fallback | 本地已实现 |

### 18.3 当前还没对齐到“本质闭环”的地方

1. `@图片` 仍是最大语义风险。当前只是规划，执行时必须先保证“插入文本”和“实际参考图参数”一致，否则会形成假功能。
2. 项目代付仍停在 Spec 阶段。虽然 `/admin/points` 已有账本入口，但项目额度账户、项目流水、项目冻结/扣除/退款还没实现。
3. 任务详情相对时间和 prompt 放大编辑还没落地。它们是用户高频体验问题，适合作为下一批低风险实现。
4. 反馈表状态仍有很多 `new`。功能是否完成不能靠反馈状态判断；需要等功能上线/验收后再决定是否标记 reviewed 或 archived。
5. 生产闭环未完全确认。当前多项是本地实现和本地验证，仍要区分生产部署和线上回归。

### 18.4 下一步执行顺序建议

1. 先做 Batch 8：任务详情相对时间。低风险、范围小、直接回应最新反馈。
2. 再做 Batch 9：prompt 放大/全屏编辑。集中在 `PromptEditor`，收益高。
3. 再做 Batch 10A：从当前素材插入 `@图片N`。先保证引用和 payload 不脱节。
4. Batch 10A 验收后，再判断是否进入 Batch 10B：从图集选择图片并自动加入 workspace。
5. 项目代付继续走 Spec 阶段 2/3，不能和 UI 小改混在一起。

### 18.5 执行时的对齐检查清单

- 每个 UI 改动都要回答：它是否减少了连续创作中的中断。
- 每个状态/时间/扣费展示都要回答：用户能否更快判断“发生了什么”。
- 每个素材引用改动都要回答：prompt 里的引用是否真的进入生成参数。
- 每个权限/归属改动都要回答：后端 API 是否也符合规则，而不只是前端隐藏。
- 每个账务改动都要回答：谁生成、谁付款、冻结多少、成功扣多少、失败退哪里。
- 每个导航改动都要回答：用户是否能回到刚才的工作现场。

---

## 19. 闭环检查更新 - 2026-06-10

### 19.1 闭环口径

本轮“闭环”不能只看任务是否写进 todo，也不能只看页面有没有按钮。闭环需要同时满足：

1. 反馈原话已经归因到真实用户目标。
2. 目标已经拆成产品行为、后端规则、数据口径和验收方式。
3. 代码或 Spec 已按风险等级落地。
4. 本地验证通过，且高风险项有后端/API/账本验证，不只看前端。
5. 生产环境完成上线回归。
6. 反馈状态在确认上线后再处理，避免“文档完成但用户问题未解决”。

### 19.2 当前闭环状态分层

| 分层 | 内容 | 当前判断 | 证据/依据 | 后续动作 |
|---|---|---|---|---|
| 已本地闭环 | 权限隔离、返回来源、状态颜色、连续生成、最近任务轮询、图集封面/改名/归档、生成归属、显示名格式化、点数流水二级页、任务详情相对时间、prompt 放大编辑、当前素材和图集选择 `@图片N` 插入 | 本地实现与验证已完成 | 前序批次记录、smoke/API 验证、`/admin/points` 落地记录；本轮 `tsc/lint/build/impeccable detect` 通过 | 部署后做生产回归 |
| 已本地闭环 | 任务详情相对时间 | 已落地 Batch 8 | `src/app/tasks/[id]/page.tsx` 新增 `formatRelativeTime/formatTaskTime`，实际扣费旁展示“生成于/更新于 N 分钟前”，精确时间保留在审计行和 title | 生产任务详情回归 |
| 已本地闭环 | prompt 放大/全屏编辑 | 已落地 Batch 9 | `src/components/PromptEditor.tsx` 新增大面板编辑、完成写回、取消确认和 Esc 退出；`src/app/globals.css` 补桌面/移动端样式 | 生产生成页回归 |
| 已本地闭环，仍需生产抓包验收 | `@图片` 引用 | 已落地 Batch 10A/10B | `GenerationComposer` 基于 `workspace.assets` 生成 `referenceLabels`；`PromptEditor` 插入 `@图片N`；`ReferenceAlbumPicker` 选择图集图片后自动加入 workspace 并插入真实序号，提交仍走现有 `reference_image_ids` | 生产回归和 Payload 抓包仍待做 |
| 已有入口但账务主体未完成 | 项目代付 | 未闭环 | `/admin/points` 已能查点数流水；项目额度账户、代付开关、冻结/扣除/退款优先级仍在 Spec 阶段 | 继续 Batch 7 Spec 阶段 2/3，不和 UI 小改混做 |
| 已分析但待运营处理 | 反馈状态 | 未闭环 | 后台反馈仍可保留 `new`，不能因计划完成就标记 resolved | 等生产验证后再 reviewed/archived |

### 19.3 不能误判为闭环的点

1. 只写了计划，不等于用户问题闭环。
2. 只改前端展示，不等于权限、账务、素材引用闭环。
3. `@图片` 只插入文字但没有同步 `reference_image_ids`，是反向风险，不允许算完成。
4. `/admin/points` 只能解决“流水容易找到”，不能替代项目代付账务主体。
5. 本地 build/smoke 通过不等于线上用户可用；生产域名、登录态、真实数据、真实角色仍要回归。

### 19.4 下一步闭环顺序

1. Batch 8：任务详情相对时间。验收重点是实际扣费附近同时有相对时间和绝对时间。
2. Batch 9：prompt 放大/全屏编辑。验收重点是完成写回、取消不污染、移动端不溢出。
3. Batch 10A：当前素材 `@图片N` 插入。验收重点是 UI 文本、workspace 素材顺序和提交 payload 一致。
4. Batch 10B：图集选择后再插入 `@图片N` 已本地落地；后续只做生产回归和 Payload 抓包，不触发未授权付费生成。
5. Batch 7 项目代付：继续 Spec，先确认账务规则，再改 schema、账本和创建接口。

### 19.5 生产回归清单

- 普通用户、项目成员、管理员分别访问任务列表、任务详情、产出、图集和后台接口。
- 连续提交两个生成任务，确认第一个任务继续轮询，第二个任务可正常创建。
- 打开 `/admin/points`，按用户、任务 ID、日期筛选流水，确认和任务详情扣费一致。
- 任务详情确认完成时间、实际扣费、生成者、项目归属和视频/截图可读。
- `@图片` 实现后必须抓一次创建请求 payload，确认 `reference_image_ids` 与插入的 `@图片N` 对应。
- 项目代付实现后必须验证成功扣费、失败退款、余额不足、外部 API `project_id` 和审计流水。

### 19.6 本次检查结论

当前反馈处理已经完成“需求理解闭环”和“规划闭环”，低风险 UI/权限/归属功能已完成本地实现闭环；本轮已补齐任务详情相对时间、prompt 放大编辑、当前素材 `@图片N` 插入和图集选择后插入 `@图片N`。整体仍不能宣称“用户反馈全闭环”，因为项目代付账务主体和生产环境回归仍未完成，且 `@图片N` 仍需要生产登录态下的 Payload 抓包确认。后续执行应继续按 19.4 的顺序推进，避免把高风险账务和轻量体验改动混在一起。

---

## 20. 落地执行记录 - 2026-06-10

### 20.1 已落地范围

- Batch 8：任务详情相对时间。`src/app/tasks/[id]/page.tsx` 新增相对时间 helper，实际扣费旁显示“生成于/更新于 N 分钟前”，同时保留精确时间。
- Batch 9：prompt 放大/全屏编辑。`src/components/PromptEditor.tsx` 支持大面板编辑，完成写回，取消确认，Esc 退出；样式写入 `src/app/globals.css`。
- Batch 10A：当前素材 `@图片N` 插入。`src/components/GenerationComposer.tsx` 根据当前 workspace 素材生成引用标签，`PromptEditor` 在光标处插入 `@图片N`，不新增后端字段。
- Batch 10B：图集选择 `@图片N` 插入。`ReferenceAlbumPicker` 选择参考图后交给 `GenerationComposer` 过滤已存在图片，只新增缺失项，成功后按真实 workspace 顺序追加 `@图片N`；失败时不写入 prompt。

### 20.2 仍未落地范围

- `@图片N` 生产/Payload 验收：需要真实登录态或请求拦截确认 prompt、workspace 缩略图和 `reference_image_ids` 顺序一致；未授权前不做真实付费生成。
- Batch 7 项目代付：项目额度、代付开关、冻结、扣除、退款、外部 API `project_id` 规则仍停在 Spec 阶段。
- 反馈状态处理：生产回归完成前，不把后台反馈误标成 resolved。

### 20.3 验证结果

- `npx tsc --noEmit --pretty false`：通过。
- `npm run lint`：通过，仍有项目既有 `react-hooks/exhaustive-deps` 和 `@next/next/no-img-element` 警告。
- `npm run build`：通过，65 个静态页生成完成。
- `npx tsx -e "...checkPrompt(...)"`：通过，覆盖 `@图片1`、`@图片 2`、旧格式 `@图1` 和越界引用。
- `npx impeccable detect src/components/PromptEditor.tsx`：通过，无输出。
- `npx impeccable detect src/components/GenerationComposer.tsx`：通过，无输出。
- `npx impeccable detect src/components/ReferenceAlbumPicker.tsx`：通过，无输出。
- 本地 dev server：`http://127.0.0.1:3020` 可访问；未登录访问 `/generate` 会 307 跳转登录页，未绕过登录态做真实生成。

### 20.4 生产回归重点

- 用已有登录态打开 `/generate`，确认大面板编辑、取消确认、完成写回和移动端布局。
- 上传或选择 2 张当前素材，插入 `@图片1/@图片2`，确认 `PromptChecker` 不报缺图。
- 从参考图集选择新增图片，确认缩略图进入 workspace，prompt 追加真实序号 `@图片N`。
- 从参考图集选择已在 workspace 的图片，确认只插入已有序号，不重复占用 9 张上限。
- 抓一次创建请求，确认提交 payload 的 `reference_image_ids` 与当前 workspace 素材一致。
- 打开真实任务详情，确认实际扣费旁显示相对时间，审计行仍有绝对时间。

### 20.5 即梦官方 `@图片` 规则一致性修正

- 官方主格式：`@图片1` / `@图片 1`。当前 UI 插入按钮统一输出 `@图片N`。
- 兼容旧格式：`PromptChecker` 继续识别旧 prompt 里的 `@图N` / `图N`，避免历史提示词失效。
- 用户可见文案：`PromptEditor`、`PromptChecker`、`ModeSelector`、`ReferenceAlbumPicker` 都改为官方 `@图片N` 口径。
- 仍不新增后端字段：`@图片N` 只是 prompt 中的自然语言引用，真实素材仍由 `reference_image_ids` 传给生成接口。
- 图集选择：选择器会识别已在工作台的 `referenceImageId`，重复选择只插入已有序号，不重复加入 workspace；新增图片成功加入后才插入对应 `@图片N`。
- 闭环标准：插入 `@图片1` 后，校验能识别第 1 张参考图；提交请求仍包含对应 workspace 顺序下的 `reference_image_ids`。
