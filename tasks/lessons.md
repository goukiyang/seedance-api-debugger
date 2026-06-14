# Lessons

## 2026-06-14 - 新 App Router 客户端页上线前必须跑生产构建

- 问题/背景：资产管理页 `/assets` 是客户端页面，使用 `useSearchParams()` 读取 `type=video` 初始筛选。
- 诱因/根因：`tsc` 和 `lint` 都能通过，但 Next 生产构建会要求 `useSearchParams()` 位于 Suspense 边界内，否则预渲染 `/assets` 时失败。
- 当时思路：不把未提交候选页面直接上线；先用独立 `NEXT_DIST_DIR=.next-prod-assets-dry-run npm run build` 验证真实生产构建，再修阻塞。
- 改动位置：`src/app/assets/page.tsx`、命令 `NEXT_DIST_DIR=.next-prod-assets-dry-run npm run build`。
- 怎么改：把真实页面内容拆为 `AssetsPageContent`，默认导出用 `Suspense` 包裹并提供稳定加载态；构建后清理 dry-run 目录，并撤掉 Next 自动写入 `tsconfig.json` 的临时 types 路径。
- 验证结果：`DATABASE_URL=file:./prisma/dev.db npx tsc --noEmit --pretty false`、`npm run lint`、`NEXT_DIST_DIR=.next-prod-assets-dry-run npm run build` 通过。
- 可复用经验：页面类候选功能只通过类型检查不够；涉及 App Router、`useSearchParams()`、动态路由或客户端数据拉取时，发布前必须跑一次生产构建，且用临时 `NEXT_DIST_DIR` 避免污染线上构建目录。

## 2026-06-14 - 模板 Agent 落地要优先保护现有数据库字段

- 问题/背景：Seedance 2.0 模板驱动 Agent 工作台新增模板、规则、AgentRun、Memory 和任务快照字段，需要同步本地 SQLite 验证默认模板与四方案生成。
- 诱因/根因：本地数据库已有历史表和字段，但 `_prisma_migrations` 缺少部分旧迁移记录；`prisma migrate deploy` 会卡在早期已存在表，`prisma db push` 又提示会删除旧字段 `VideoCard.ratio_locked`。
- 当时思路：先备份 `prisma/dev.db`，拒绝 `db push --accept-data-loss`，只手动应用本次新增迁移 SQL，避免为了新功能破坏既有视频卡比例数据。
- 改动位置：`prisma/schema.prisma`、`prisma/migrations/20260614093000_add_template_agent_workbench/migration.sql`、`src/components/GenerationComposer.tsx`、`src/app/api/tasks/create/route.ts`、`src/app/api/templates/*`、`src/app/api/agent/*`。
- 怎么改：模板/规则/Prompt/AgentRun/Memory 使用最小可用模型；生成页保留原有项目、视频卡、参考图和 Seedance 参数，只在上方增加模板、需求、方案和 Prompt 预览主路径；任务创建写入模板和 Agent 快照。
- 验证结果：`npx prisma validate`、`npm run db:generate`、`npx tsc --noEmit --pretty false`、局部 `npm run lint`、`npm run build` 通过；本地 smoke 生成默认模板 A/B/C/D 四方案。
- 可复用经验：Prisma 迁移状态和实际 SQLite schema 不一致时，不要用 `db push --accept-data-loss` 图快；先备份，再只应用本次新增的非破坏性 SQL，保留历史字段和用户数据。

## 2026-06-13 - 新建入口必须暴露账务口径

- 问题/背景：公共项目预算池上线后，用户在新建项目时看不到当前项目会走默认个人积分记账还是公共项目预算记账。
- 诱因/根因：账务分流只落在任务创建、结算和项目详情展示，创建项目入口仍只收项目名和说明，没有把 `team` 默认记账与 `public` 预算记账的差异提前呈现。
- 当时思路：不改变后端默认创建普通协作项目的低风险行为，先在创建前明确展示两种记账方式，并把预算记账导向公共项目立项审批，创建后在项目列表显示当前记账口径。
- 改动位置：`src/app/projects/page.tsx`、`src/app/approvals/page.tsx`、`src/app/globals.css`。
- 怎么改：新增记账方式单选区；默认记账提交创建 `team` 项目；预算记账带项目名和说明跳转 `/approvals?type=project_create`；审批中心读取 URL 预填审批类型和申请理由；项目卡显示“记账：默认记账/预算记账”。
- 验证结果：`git diff --check`、`npx tsc --noEmit --pretty false`、`npm run lint`、`NEXT_DIST_DIR=.next-prod-dry-run npm run build` 已通过；公网 `/projects` 返回 200 且包含默认记账和预算记账；浏览器验证预算单选按钮会切换提交按钮，审批页 query 能预填公共项目立项和申请理由。
- 可复用经验：任何账务、权限、审批或可见状态规则发生变化，必须检查“创建入口、列表、详情页、执行动作、错误提示”五个位置是否都同步解释清楚。

## 2026-06-13 - 趋势图不能用抽样隐藏关键每日桶

- 问题/背景：每日生成量与成本图在本月有 13 个日桶时，前端只显著呈现了少量标签和节点，用户看到像“只有两个”，且柱状位置和实际数据感知不一致。
- 诱因/根因：前端把所有日期压进固定 300px 坐标系，并用抽样逻辑隐藏日期/成本标签；数据桶本身是完整的，但呈现层压缩和省略让用户无法逐日核对。
- 当时思路：先用服务端聚合函数验证真实日桶数量和非零日期，再把图表改成每个 bucket 固定宽度、可横向滚动、每柱显示次数、每个成本点保留节点和非零成本标签。
- 改动位置：`src/app/admin/AdminGenerationDashboardClient.tsx`、`src/app/globals.css`。
- 怎么改：移除 `showTrendLabel` 抽样；按日桶数量计算 SVG 宽度；日期轴和图表放入同一滚动容器；零值日也保留稳定占位柱；tooltip 使用完整成本口径。
- 验证结果：服务端本月日趋势为 2026-06-01 至 2026-06-13 共 13 桶，总任务 71，非零日为 06-03、06-06、06-09、06-10、06-11、06-13；`npm run lint -- --file src/app/admin/AdminGenerationDashboardClient.tsx`、`git diff --check`、`npx impeccable detect`、`NEXT_DIST_DIR=.next-prod npm run build` 通过；`sd2` 已重启，公网静态 CSS 可拉到新类名。
- 可复用经验：数据可视化先核对后端 bucket 和真实非零日期，再定前端尺度；每日趋势图默认不能为了“看起来干净”抽样隐藏可核对的日柱、节点或日期。

## 2026-06-13 - 公共预算池上线必须先拆清读写边界

- 问题/背景：公共项目生成改为项目预算池扣费，需要新增预算账户、预算流水、任务冻结、成功实扣、失败释放和项目页展示。
- 诱因/根因：预算 summary 最初如果自动 upsert 账户，会让项目详情这类只读接口产生写库副作用；同时新代码依赖新增 SQLite 表，未同步 schema 会直接导致线上 500。
- 当时思路：先确认运行库已有 `ProjectBudgetAccount` / `ProjectBudgetLedger`，再把 summary 改为缺账户返回 0 快照，只有预算调整和任务冻结等写动作才创建账户。
- 改动位置：`prisma/schema.prisma`、`prisma/migrations/20260613212000_add_project_budget_accounts/migration.sql`、`src/lib/projects/budget.ts`、`src/app/api/tasks/create/route.ts`、`src/lib/video/task-finalizer.ts`。
- 怎么改：公共项目按 `billing_scope=project` 走项目预算冻结/结算，个人项目保留 `CreditAccount` 路径；项目预算流水使用任务级幂等键防止重复冻结或重复实扣。
- 验证结果：`npm run db:generate`、`git diff --check`、`npx tsc --noEmit --pretty false`、`npm run lint`、`npm run build` 通过；临时 SQLite migration smoke 通过；事务回滚 smoke 覆盖预算追加、冻结、重复冻结、成功结算和重复结算。
- 可复用经验：账务类上线不能只看构建通过；必须同时验证运行库 schema、读接口无写副作用、冻结/结算幂等、失败释放和线上构建已加载。

## 2026-06-10 - 官方金额默认双币种显示

- 问题/背景：用户要求项目内显示金额时，要么同时显示美金和人民币，要么支持点击在两个币种之间切换。
- 诱因/根因：项目里已有部分 helper 会显示人民币换算，但 `formatProviderUsdCharge` 仍只显示 `$xx USD`，不同页面对同一官方扣费的展示不一致。
- 当时思路：管理、成本、任务详情和导出属于审计场景，默认隐藏某个币种会增加误读风险；采用“原币种 + 人民币估算”同时展示，极窄图表点位只允许短标签，完整值放在 title 或详情里。
- 改动位置：`src/lib/costs/currency.ts`、`src/app/tasks/[id]/page.tsx`、`src/app/generate/page.tsx`、`src/app/admin/costs/page.tsx`、`src/app/admin/costs/ProviderBalancePanel.tsx`、`src/app/admin/costs/OfficialChargeImportForm.tsx`、`src/app/projects/[id]/page.tsx`、`src/app/admin/page.tsx`、导出路由和 `src/app/globals.css`。
- 怎么改：公共金额 helper 固定输出 `$0.35 USD（约 ¥2.55）`；小于 0.01 的金额显示 `< $0.01 USD`；页面统一调用固定双币种 helper；CSV 保留原始金额并增加人民币估算列；长金额胶囊允许换行。
- 验证结果：`scripts/currency-format-smoke.ts`、`npx tsc --noEmit --pretty false`、`npm run lint`、`npm run build`、`npx tsx scripts/generation-dashboard-smoke.ts`、`youdoo-sites build sd2`、`youdoo-sites restart sd2` 通过；线上 `sd2` health 返回 200。
- 可复用经验：官方扣费、人民币估算、平台点数必须分层；金额类审计页面默认双币种明示，不用点击切换隐藏关键信息。

## 2026-06-10 - SVG 图表和图标不得非等比拉伸

- 问题/背景：视频生成管理页趋势图上线后，用户指出图表视觉元素被拉伸，圆点、金额标签和线条观感很差。
- 诱因/根因：SVG 使用固定 `viewBox` 后仍通过 CSS 固定高度撑满容器宽度，等价于非等比缩放；`preserveAspectRatio="none"` 这类做法会让圆形标记、文字和图标被压扁或拉宽。
- 当时思路：把图表坐标系、容器比例和 stroke 视觉尺寸拆开处理，容器只做等比缩放，线条和标记使用稳定尺寸。
- 改动位置：`src/app/admin/AdminGenerationDashboardClient.tsx`、`src/app/globals.css`。
- 怎么改：趋势图改为固定 `300x100` 坐标系，CSS 使用 `aspect-ratio: 3 / 1` 和 `height: auto`，移除非等比高度拉伸，并调整圆点、线宽、金额标签尺寸。
- 验证结果：`git diff --check -- src/app/admin/AdminGenerationDashboardClient.tsx src/app/globals.css tasks/lessons.md`、`npx tsc --noEmit --pretty false`、`npx impeccable detect 'src/app/admin/AdminGenerationDashboardClient.tsx'`、`npm run lint`、`npm run build`、`youdoo-sites build sd2`、`youdoo-sites restart sd2` 通过；线上 `https://sd2.youdoodesign.com/api/health` 返回 200。in-app browser 只读快照超时，未作为完成证据。
- 可复用经验：数据可视化里的圆点、图标和文字不能依赖非等比缩放；需要变宽时只调整坐标布局或容器比例，不能把 SVG 当背景图强拉。

## 2026-06-10 - 驾驶舱参考图必须拆到主图表和指标口径

- 问题/背景：视频生成管理页参考图要求“每日生成量与成本”，用户纠正指出只做了圆环占比，没有做生成秒数、次数、额度趋势。
- 诱因/根因：实现时把参考图理解成整体视觉风格，优先落了项目/清晰度占比，漏拆参考图中最关键的柱线趋势模块。
- 当时思路：把趋势作为驾驶舱首屏的产能和成本主图，后端统一聚合按日/按周/按月数据，前端用同一口径渲染柱线图。
- 改动位置：`src/lib/admin/generation-dashboard.ts`、`src/app/admin/AdminGenerationDashboardClient.tsx`、`src/app/api/admin/generation-dashboard/export/route.ts`、`src/app/globals.css`、`scripts/generation-dashboard-smoke.ts`。
- 怎么改：新增 `trends.day/week/month`，每个 bucket 包含生成次数、生成秒数、点数和官方额度；页面新增“每日/每周/每月生成量与成本”图，柱子显示次数，两条折线显示秒数和官方额度；导出补 `trend_day/trend_week/trend_month`。
- 验证结果：`npx tsc --noEmit --pretty false`、`npx tsx scripts/generation-dashboard-smoke.ts`、`npm run lint`、`npm run build`、`youdoo-sites build sd2`、`youdoo-sites restart sd2` 通过；线上 `sd2` health 返回 200。
- 可复用经验：按参考图做管理驾驶舱时，必须先拆出主图表、指标口径和交互切换，不得只抽视觉样式或次级占比模块。

## 2026-06-10 - 连续生成和用户默认生成参数

- 问题/背景：后台反馈要求“任务已创建后可以继续创建下一段”和“每个人默认保存最后一次生成设置”。
- 诱因/根因：原生成页把创建结果作为主卡片长期占位，轮询也绑定单个 `result.id`；默认参数只来自组件常量和复用任务草稿，没有用户级偏好。
- 当时思路：把“任务创建成功”从表单主流程中拆出去，作为队列提示和最近任务更新；用户偏好只保存可复用配置，不保存素材 URL、签名 URL、本地路径或一次性上传地址。
- 改动位置：`src/app/generate/page.tsx`、`src/components/GenerationComposer.tsx`、`src/app/api/me/preferences/generation/route.ts`、`src/lib/preferences/generation.ts`、`prisma/schema.prisma`。
- 怎么改：新增 `UserPreference` 和生成偏好 API；生成页读取偏好并在提交成功后异步保存；提交成功后新任务进入最近任务顶部，旧任务继续后台轮询；结果卡改为轻量队列提示。
- 验证结果：`npm run db:generate`、生成偏好归一化 smoke、`npx tsc --noEmit --pretty false`、`npm run build`、`BASE_URL=http://localhost:3002 npx tsx scripts/project-ui-smoke.ts` 均通过。
- 可复用经验：用户默认值服务端持久化要有 localStorage 降级，尤其是 Prisma 迁移尚未应用时；连续生成不能把轮询生命周期绑死在当前表单结果卡上。

## 2026-06-10 - 图集删除入口和历史引用保护

- 问题/背景：后台反馈要求图集卡片有截图，并补齐图集删除、重命名等管理入口。
- 诱因/根因：列表 API 只返回 `cover_image_id`，前端只能显示图片数量；后端 DELETE 原本会把图集和图集内图片都标记为 deleted，容易破坏历史任务对参考图的追溯。
- 当时思路：先定义“删除图集”的产品语义为从管理列表隐藏，而不是删除素材；封面图继续走参考图内容接口，保留权限边界。
- 改动位置：`src/app/api/reference-albums/route.ts`、`src/app/api/reference-albums/[id]/route.ts`、`src/app/collections/ReferenceAlbumsClient.tsx`、`src/app/collections/[id]/ReferenceAlbumDetailClient.tsx`、`src/app/globals.css`。
- 怎么改：列表 API 返回 `cover_image_url`；列表和详情补重命名/删除入口；DELETE 改为归档图集并保留 `ReferenceImage`；列表只展示 active 图集。
- 验证结果：`npx tsc --noEmit --pretty false`、`npm run build`、图集只读 smoke、`BASE_URL=http://localhost:3002 npx tsx scripts/project-ui-smoke.ts` 均通过。
- 可复用经验：给“删除”补入口前必须先确认数据语义，尤其是被历史任务引用的素材；优先用归档隐藏替代级联删除。

## 2026-06-10 - 生成者头像和技术账号显示

- 问题/背景：后台反馈要求产出留存和任务详情都显示生成者头像，同时账号显示不要暴露过长技术后缀。
- 诱因/根因：产出 API 只返回基础用户字段，前端各处用局部 `userLabel` 拼接；Feishu fallback 邮箱和 open id 用户名容易直接进入用户可见区域。
- 当时思路：先抽统一显示 helper 和头像 badge，再让后台产出列表和任务详情共用；Batch 6 后续账号展示名修复可继续复用。
- 改动位置：`src/lib/users/display.ts`、`src/components/UserIdentityBadge.tsx`、`src/app/api/admin/outputs/route.ts`、`src/app/admin/outputs/AdminOutputsClient.tsx`、`src/app/api/video/status/[id]/route.ts`、`src/app/tasks/[id]/page.tsx`、`src/app/globals.css`。
- 怎么改：API 增加 `avatar_url/account_type`；状态接口返回 `owner/submitted_user`；产出列表和任务详情用统一 badge 展示生成者；来源显示按 `codex_api -> source_label || Codex API` 处理。
- 验证结果：用户显示格式化 smoke、`npx tsc --noEmit --pretty false`、`npm run build`、Batch 5 只读 smoke、项目 UI smoke 均通过。
- 可复用经验：用户可见身份必须经过统一格式化，不能直接展示原始 username/email；头像展示也要有稳定 fallback，避免无头像用户在列表里丢失身份线索。

## 2026-06-10 - 账号展示名和原始身份字段分层

- 问题/背景：飞书自动创建账号可能产生 `ou_...` 用户名和 `feishu_...@feishu.local` 合成邮箱，直接展示会让用户看到很长的技术后缀。
- 诱因/根因：多个页面各自拼接 `name || username || email`，没有区分用户可见身份和后台审计身份。
- 当时思路：用户可见区域统一走 `displayUserName`；真实 username/email 保留在搜索、表单、审计日志和绑定信息中，不修改原始数据。
- 改动位置：`src/components/AccountMenu.tsx`、`src/app/account/page.tsx`、项目/图集/后台用户/成本/反馈/集成/驾驶舱相关页面，以及 `src/lib/users/display.ts`。
- 怎么改：顶部账号、个人页、项目 owner、图集 owner、后台用户列表、批量操作预览、合并账号下拉和导出中的 owner/member 主显示统一格式化；合成飞书邮箱在个人页显示为“未绑定真实邮箱”。
- 验证结果：用户显示格式化 smoke、`npx tsc --noEmit --pretty false`、`npm run build`、Batch 6 只读页面 smoke、项目 UI smoke、`impeccable detect` 均通过。
- 可复用经验：账号展示要分层，主 UI 展示人能读懂的身份，调试和审计保留原始字段；不要为了解决显示问题去改登录源数据。

## 2026-06-10 - 点数流水从用户管理拆到二级页

- 问题/背景：管理页的点数流水需要容易找到，但不能把用户管理首页挤成完整账本表。
- 诱因/根因：`/admin/points` 之前只重定向到 `/admin/users`，导致“点数管理”语义和页面实际结构不一致；`/admin/users` 同时承担用户表、点数操作、策略、合并和全局流水，信息过载。
- 当时思路：把主页面和账本明细分层。`/admin/users` 保留账号和点数操作，完整流水放到 `/admin/points`，再从后台总览、用户页和成本页给明确入口。
- 改动位置：`src/app/admin/points/page.tsx`、`src/app/admin/points/AdminPointsClient.tsx`、`src/app/api/admin/credits/ledger/route.ts`、`src/app/admin/users/AdminUsersClient.tsx`、`src/app/admin/page.tsx`、`src/app/admin/costs/page.tsx`、`src/app/globals.css`。
- 怎么改：新增“点数与额度流水”二级页，支持用户、任务、类型、关键词、时间筛选和分页；用户页底部全局流水改成入口卡；选中用户右侧保留最近摘要并跳转到用户筛选流水；后台总览和成本页补入口。
- 验证结果：`npx tsc --noEmit --pretty false`、`npm run lint`、`npm run build` 通过；本地 `http://127.0.0.1:3020/admin/points` 通过管理员 cookie HTTP 验证和 Playwright 截图检查。
- 可复用经验：后台账本类页面要有稳定二级入口，主工作台只放摘要和上下文跳转；成本现金账本和点数账本要分开，避免审计口径混淆。

## 2026-06-10 - Prompt 引用必须和真实素材参数同步

- 问题/背景：用户反馈任务详情需要相对时间、长提示词需要放大编辑、生成页需要 `@图片`，本质是要减少连续创作中断，并让 prompt 与参考图形成真实绑定。
- 诱因/根因：任务详情只显示绝对时间，不利于快速判断生成新旧；`PromptEditor` 固定 4 行，长 prompt 编辑成本高；原 footer 只有“输入 @ 使用素材”的提示，没有把 `@图片N` 插入和 workspace 素材顺序连起来。
- 当时思路：先落地低风险体验项，再做当前素材 `@图片N` 插入；`@图片N` 只作为 prompt 标记，提交仍使用现有 `reference_image_ids`，不新增后端字段，不假装支持全图集搜索。
- 改动位置：`src/app/tasks/[id]/page.tsx`、`src/components/PromptEditor.tsx`、`src/components/GenerationComposer.tsx`、`src/app/globals.css`、`tasks/feedback-optimization-plan.md`、`tasks/todo.md`。
- 怎么改：任务详情新增 `formatRelativeTime/formatTaskTime`；PromptEditor 增加大面板编辑、完成写回、取消确认和 Esc 退出；GenerationComposer 根据 `workspace.assets` 生成 `图片1/图片2` 标签并传给 PromptEditor；PromptEditor 在光标处插入 `@图片N`。
- 验证结果：`npx tsc --noEmit --pretty false`、`npm run lint`、`npm run build`、`npx impeccable detect src/components/PromptEditor.tsx` 通过；本地 `/generate` 未登录会跳登录，未绕过登录态做真实生成。
- 可复用经验：素材引用类需求不能只做 UI 文案；必须保证 prompt 标记、workspace 素材顺序和提交参数一致。官方主格式使用 `@图片N` / `@图片 N`，旧的 `@图N` / `图N` 只能作为兼容输入，不应作为主 UI 文案。跨图集选择必须先加入 workspace，再按真实顺序插入 `@图片N`，不能绕过实际 `reference_image_ids`。

## 2026-06-10 - 图集选择 @图片N 必须过滤重复并延后写 prompt

- 问题/背景：用户要求继续落地即梦官方 `@图片N` 规则，补齐从参考图集选择图片后自动加入工作台并插入 prompt 的 Batch 10B。
- 诱因/根因：原 `ReferenceAlbumPicker` 只把图集图片加入 workspace，不会把对应 `@图片N` 写回提示词；如果重复选择已在 workspace 的参考图，还可能被 9 张上限误挡。
- 当时思路：不新增后端字段，不改真实提交协议；前端先识别已存在 `referenceImageId`，只新增缺失图片，等加入成功后再按 workspace 的真实顺序插入 `@图片N`。
- 改动位置：`src/components/GenerationComposer.tsx`、`src/components/ReferenceAlbumPicker.tsx`、`docs/sd2-external-api-integration.md`、`tasks/todo.md`、`tasks/feedback-optimization-plan.md`。
- 怎么改：选择器接收当前 workspace 的 `referenceImageId` 列表；已存在图片不占新增名额；确认后 `GenerationComposer` 过滤重复 ID，计算已有和新增图片的真实 `图片N` 标签，API 调用失败时不写 prompt，成功后追加 `@图片N`。
- 验证结果：`npx tsc --noEmit --pretty false`、`npm run lint`、prompt reference smoke、`npx impeccable detect src/components/GenerationComposer.tsx`、`npx impeccable detect src/components/ReferenceAlbumPicker.tsx`、`npm run build` 均通过；未做真实付费生成。
- 可复用经验：引用型 UI 必须把选择器、workspace 状态、prompt 标记和提交 payload 当成一个闭环验证；重复选择要复用已有序号，不能重复占用上限，也不能在后端加入失败时提前污染 prompt。

## 2026-06-11 - 生成页最近任务无限下拉不能破坏轮询

- 问题/背景：用户要求生成页“最近任务”不要固定 6 条，而是页面自然下滑，拉到一定程度再加载更多。
- 诱因/根因：原 `src/app/generate/page.tsx` 在初始加载、终态刷新和提交成功三处都 `.slice(0, 6)`，导致历史任务不可继续浏览；如果只删除 slice，又会一次性拉太多缩略图和历史任务。
- 当时思路：不改任务 API、不改扣费和 Provider；复用 `/api/video/list?page&limit`，在前端做小型时间线状态机，并把轮询刷新第一页改成 merge，避免覆盖已加载的更早页。
- 改动位置：`src/app/generate/page.tsx`、`src/app/globals.css`、`tasks/todo.md`。
- 怎么改：新增 `RECENT_TASK_PAGE_SIZE=12`、分页/加载/错误状态、`mergeTasksById` 和 `normalizeRecentTaskListResponse`；最近任务底部用 `IntersectionObserver` sentinel 自动加载下一页，并保留“加载更多/重试/到底”状态；提交成功只插顶部，不再裁剪旧列表。
- 验证结果：`git diff --check`、`npx tsc --noEmit --pretty false`、`npm run lint`、`npm run build`、`npx impeccable detect src/app/generate/page.tsx` 通过；本地未登录访问 `/generate` 307 跳转登录，`/api/video/list?page=1&limit=12` 返回 401，登录态滚动验收待补。
- 可复用经验：无限下拉不是简单把 limit 调大；必须同时设计初始页、下一页、提交插入、轮询刷新、失败重试和到底状态，尤其不能让刷新第一页清空用户已经加载的历史页。

## 2026-06-11 - 共享图集复用授权记录，不复制图集

- 问题/背景：需要把已有个人/项目图集转为共享图集，同时已有公共图集文件夹和审核流也在演进。
- 诱因/根因：共享图集和公共图集都涉及“别人能用”，但底层语义不同；如果混成一个流程，会把定向授权误做成复制到公共库，或让公共图集绕开审核。
- 当时思路：共享图集只新增/更新 `AlbumShare` 授权，不复制图片、不复制图集；公共图集继续使用公共文件夹和提交审核流程。
- 改动位置：`src/app/api/reference-albums/[id]/shares/route.ts`、`src/app/api/album-shares/[id]/route.ts`、`src/app/api/reference-albums/[id]/shares/revoke-all/route.ts`、`src/components/ShareAlbumDialog.tsx`、`src/app/collections/ReferenceAlbumsClient.tsx`、`src/app/collections/[id]/ReferenceAlbumDetailClient.tsx`、`src/app/globals.css`。
- 怎么改：共享列表返回授权对象展示信息；补共享权限更新和关闭全部共享接口；列表和详情接入统一共享设置弹窗，支持权限预设、过期时间、单个移除和全部关闭。
- 验证结果：`git diff --check`、`npx tsc --noEmit --pretty false`、`npm run lint`、`npm run build`、`npx impeccable detect src/components/ShareAlbumDialog.tsx` 通过；未执行数据库写入和多账号浏览器验收。
- 可复用经验：权限共享类需求先确认“授权同一资源”还是“复制成新资源”；共享图集应复用 `AlbumShare`，公共图集才走复制和审核。关闭全部共享必须恢复 visibility，但不能破坏项目图集原有项目权限。

## 2026-06-13 - 预览区域不要用“视频帧”做用户可见标签

- 问题/背景：用户反馈最近任务、任务列表和后台产出留存里的“视频帧”措辞会让人误以为金额或标签写在截图/视频内容上，要求去掉该说法。
- 诱因/根因：页面把缩略图、视频预览和空状态都统一叫“视频帧”，这个词偏技术实现，不符合用户在卡片里快速识别任务内容的心智。
- 当时思路：只改用户可见文案和最近任务卡正文层级，不改任务数据、预览来源、扣费、Provider 或隐藏/恢复逻辑。
- 改动位置：`src/app/generate/page.tsx`、`src/app/tasks/page.tsx`、`src/app/admin/outputs/AdminOutputsClient.tsx`、`src/app/admin/page.tsx`、`src/app/globals.css`、`tasks/todo.md`。
- 怎么改：把用户可见的“视频帧/等待视频帧/暂无视频帧/失败无视频帧”统一改为“预览图/等待预览/暂无预览/失败无预览”；最近任务卡提示词拆成日期和正文两段，日期前置，正文使用更小字号并限制两行。
- 验证结果：`rg` 确认运行代码与任务文档无“视频帧”残留；`git diff --check`、`npx tsc --noEmit --pretty false`、`npm run lint`、`npm run build` 通过；本地 3100 浏览器验收 `/generate`、`/tasks`、`/admin/outputs` 均无“视频帧”，且 `/generate` 最近任务正文计算字号为 `8px`、桌面无横向溢出。
- 可复用经验：预览卡片的标签应描述用户感知对象，优先用“预览/预览图/视频预览”，不要暴露“帧”这种实现词；金额、状态、标签必须放在卡片 UI 层，不能让用户误解为叠加在图片或视频内容上。

## 2026-06-13 - 最近任务截图位空态不要渲染文字节点

- 问题/背景：用户再次指出 `/generate` 最近任务卡片的视频截图区域仍能看到“视帧/视频帧”类字样，说明前一轮只改文案和隐藏样式，没有把截图位文字节点彻底去掉。
- 诱因/根因：缩略图区域保留了空态文本节点，再依赖 CSS 隐藏；一旦运行实例、样式加载或缓存与预期不一致，用户仍可能看到无意义占位字。
- 当时思路：最近任务截图位只承担图片缩略图职责；无缩略图时保留视觉空容器，不再渲染任何空态文字或读屏占位。
- 改动位置：`src/app/generate/page.tsx`、`src/app/globals.css`。
- 怎么改：删除 `RecentTaskPreview` 的空态 `<span>`，同时移除仅为该节点服务的 `.sr-only` 样式。
- 验证结果：`npm run lint` 通过，仍只有项目既有 warning；`rg` 确认最近任务卡片实现中不再有空态文案节点。
- 可复用经验：用户要求“不要显示某文字”时，优先删除渲染路径，不要只改成隐藏类或替换成读屏文本；对截图、缩略图、媒体占位这类视觉区域尤其要避免任何文字节点残留。

## 2026-06-13 - 趋势图不能隐藏关键金额，部署必须用当前线上基线

- 问题/背景：后台“每日生成量与成本”中，用户看不到 2026-06-12 的记录，也看到多天没有金额文字。
- 诱因/根因：数据库中 2026-06-12 本身没有 `VideoTask`，但趋势图前端为了避免 SVG 标签拥挤，只对部分日期显示金额文本；同时部署时如果从偏旧 worktree 构建，会把当前线上视频卡功能回退。
- 当时思路：先用 SQLite 按毫秒时间戳聚合核对真实每日数据，再修 UI 显示策略；构建时必须以当前线上主基线 `codex/video-card-p0-closure` 为准，而不是复用旧隔离 worktree。
- 改动位置：`src/app/admin/AdminGenerationDashboardClient.tsx`、`src/app/globals.css`、`.next-prod`、`/Volumes/Data/Projects/project-version-registry.md`。
- 怎么改：在趋势卡片内增加“每日金额明细”网格，每个 bucket 都显示日期、官方额度、生成次数和生成秒数；零生成日期显示 `$0.00`，有任务但无官方金额显示“待官方确认”。
- 验证结果：SQLite 聚合确认 2026-06-12 为 0 条，2026-06-11 为 20 条/238 秒/`$19.236434`；`npm run lint`、`NEXT_DIST_DIR=.next-prod-daily-cost-final npm run build` 通过；最终 `.next-prod/BUILD_ID=vQvEpiY67E45lQz-cl-sq`，公网 build manifest 200，`youdoo-sites status sd2` OK，远端分支和 rollback tag 可见。
- 可复用经验：成本驾驶舱的关键金额不能只藏在 hover title 或抽样标签里；必须有完整可扫的明细。线上部署要先确认基线包含当前已上线功能，隔离 worktree 只能用于避免脏改动，不能替代基线校验。

## 2026-06-13 - 线上反馈必须检查 `.next-prod` 和重启服务

- 问题/背景：最近任务卡片修复已经提交并推送，但用户在线上仍看到旧的日期位置、字号和“视频帧”文字。
- 诱因/根因：`sd2` 线上服务健康，但 `.next-prod/BUILD_ID` 仍停在 2026-06-12，说明生产构建没有同步到最新 2026-06-13 提交；Git 远端可见不等于线上已部署。
- 当时思路：先用 `youdoo-sites status/doctor sd2` 排除外链和端口问题，再检查 `.next-prod` 时间戳和公开静态资源，最后执行生产构建与重启。
- 改动位置：`.next-prod`、`com.youdoo.site.sd2` 运行实例、`/Volumes/Data/Projects/project-version-registry.md`。
- 怎么改：运行 `/Users/gouki-youdoo/.youdoo/bin/youdoo-sites build sd2` 重新生成 `.next-prod`，再运行 `/Users/gouki-youdoo/.youdoo/bin/youdoo-sites restart sd2`。
- 验证结果：`youdoo-sites status sd2` 显示 launchd/port/build/local/public 均 OK；公开 build manifest `/_next/static/v7408tGryidB-EuLEW8-D/_buildManifest.js` 返回 200；公开 CSS 中 `.composer-task-card-prompt-text` 为 `font-size:8px`，公开 JS 中只剩 `composer-task-card-prompt-time` 和 `composer-task-card-prompt-text`，没有 `sr-only` 或“视频帧”。
- 可复用经验：用户说“线上还是旧的”时，必须把部署当成单独闭环：检查 `.next-prod/BUILD_ID`、运行 `youdoo-sites build/restart`、再从公网静态资源和健康检查验证，不要只汇报 Git commit/push。

## 2026-06-13 - 1080p 项目生成审批必须前后端双闸

- 问题/背景：非个人项目的 1080p 生成会直接影响团队成本，需要在生成前显式确认审批，且复用/重试不能绕过该确认。
- 诱因/根因：如果只在前端展示提示，API 直调仍可能创建 1080p 项目任务；如果只在后端拦截，用户不知道为什么无法提交。
- 当时思路：前端在非个人项目 + 1080p 时显示确认复选框并禁用提交；后端 `/api/tasks/create` 再按项目类型和分辨率硬拦截；复用/重试草稿保留确认状态，避免参数丢失。
- 改动位置：`src/components/GenerationComposer.tsx`、`src/app/generate/page.tsx`、`src/app/api/tasks/create/route.ts`、`src/app/api/tasks/[id]/reuse/route.ts`、`src/app/api/video/retry/[id]/route.ts`、`src/app/globals.css`。
- 怎么改：提交参数新增 `resolution_approval_confirmed`；非个人项目 1080p 未确认时前端阻断并禁用按钮；后端创建任务前返回 403；任务 params 快照记录 `resolutionApprovalConfirmed`，复用/重试草稿带回该字段。
- 验证结果：`git diff --check`、`npx tsc --noEmit --pretty false`、`npm run lint`、`npm run build` 通过；本地 3100 浏览器验收团队项目切到 1080p 时确认框出现且未勾选禁用提交，勾选后提交按钮恢复，切到 720p 后确认框消失；未触发真实生成。
- 可复用经验：涉及成本或权限的生成限制必须“UI 可解释 + API 强制”，并把复用、重试、草稿恢复一起纳入同一条参数链路。

## 2026-06-13 - @ mention 插入后必须自动补空格

- 问题/背景：用户补充反馈，输入 `@` 选择图片后如果不自动补空格，继续输入下一个 `@` 不会触发候选弹窗。
- 诱因/根因：`replaceMentionRange` 只在插入位置后面已有非空白字符时补空格；当 mention 插在文本末尾时会得到 `@图片1`，用户继续输入会变成 `@图片1@`，检测器无法把第二个 `@` 识别成新 mention 边界。
- 当时思路：把空格作为 mention token 的必要分隔符处理；只要插入内容不以空白结尾，且后方不是空白，就补一个空格。
- 改动位置：`src/lib/prompt/mention.ts`。
- 怎么改：移除“后面必须已有字符才补空格”的条件，让文本末尾选择 `@图片N` 也得到 `@图片N `。
- 验证结果：本地 smoke 覆盖 `@图` 替换为 `@图片1 `、正文中间替换保留单个空格、已有空格不重复补空格、`@图片1 @` 后第二个 `@` 可被检测。
- 可复用经验：mention token 不是普通文本追加，插入后必须形成独立词边界；否则下一次 `@`、解析和提交前引用校验都会被前一个 token 粘连影响。

## 2026-06-11 - 上线前必须同步 SQLite schema

- 问题/背景：参考图集页出现 `Internal server error`，公网日志报 `main.ReferenceAlbum.public_folder_id` 不存在，同时工作台日志报 `main.Asset.status` 和 `UserPreference` 缺失。
- 诱因/根因：源码和 `.next-prod` 已包含公共图集、历史图片和用户生成偏好相关查询，但运行库 `prisma/dev.db` 没有同步对应 SQLite schema。
- 当时思路：先从公网接口和 `/tmp/youdoo-site-sd2.err.log` 证实真实错误，再只补缺失的 additive schema，避免用全量 `db push` 扩大数据面。
- 改动位置：`prisma/migrations/20260611100000_add_public_reference_album_workflow/migration.sql`、`prisma/migrations/20260611103000_add_asset_history_status/migration.sql`、`prisma/migrations/20260610083000_add_user_preferences/migration.sql`、`.next-prod`、`youdoo-sites build sd2`、`youdoo-sites restart sd2`。
- 怎么改：先备份 `prisma/dev.db` 到 `/Volumes/Data/Backups/video-api-debugger`，再应用缺失迁移；随后重新 build/restart `sd2`。本次发现 `youdoo-sites build sd2` 后新路由进入 `.next` 但没有进入 `.next-prod`，因此额外将 `.next` 安全同步到 `.next-prod` 后再次 restart。
- 验证结果：schema 检查确认 `ReferenceAlbum.public_folder_id`、`ReferenceAlbumFolder`、`PublicAlbumSubmission`、`Asset.status`、`UserPreference` 均存在；`youdoo-sites status sd2` 显示 local/public 200；未登录请求 `/api/reference-albums?scope=mine` 和 `/api/reference-album-folders` 返回 401 而非 500/404；`/collections` 返回 307 到登录页。
- 可复用经验：涉及 Prisma schema 的页面改动不能只 build 代码；上线闭环必须包含运行库 schema 检查、缺失迁移应用、确认新增 API route 真实存在于 `.next-prod`、service restart 和公网接口验证。未同步 DB 或 `.next-prod` 时，Next 构建通过不代表页面可运行。

## 2026-06-12 - 前端验收必须确认服务实例来自当前工作区

- 问题/背景：生成页 PromptEditor 自适应高度改动后，首次用 3000 端口做 Playwright 验证，DOM 仍显示旧 CSS：`resize: none`、`max-height: none`。
- 诱因/根因：3000 端口已有 Node 服务在监听，但不是当前改动后的实例；只检查“端口可访问”无法证明页面运行的是当前工作区代码。
- 当时思路：先保留构建和静态验证，再启动隔离端口 3100，用同一只读 session cookie 对当前工作区服务做 DOM 实测。
- 改动位置：`src/components/PromptEditor.tsx`、`src/app/globals.css`、`tasks/todo.md`。
- 怎么改：PromptEditor 增加 textarea 自适应高度 helper；桌面高度上限 320px，移动端上限 280px；超过上限内部滚动；CSS 放开纵向 resize。
- 验证结果：`git diff --check`、`npx tsc --noEmit --pretty false`、`npm run lint`、`npm run build`、`npx impeccable detect src/components/PromptEditor.tsx` 通过；本地 3100 端口 Playwright 验证短文本、长文本、超长文本、移动端回缩和放大编辑回归均通过。
- 可复用经验：前端 UI 验收不要复用不明来源的旧端口；如果 DOM/CSS 与 diff 不一致，优先启动隔离端口并验证 URL、CSS computed style、关键交互和无横向溢出。

## 2026-06-12 - 批量下载视频先做即时 ZIP，再接后台任务

- 问题/背景：用户希望在项目卡和任务列表里批量下载视频，优先满足项目页面“一键下载视频包”的应用体验。
- 诱因/根因：原系统只有任务详情/结果页的单条视频下载入口，项目列表没有面向成果交付的下载动作；如果直接做“全部历史视频同步打包”，大项目会遇到请求超时、Provider 外链过期和权限边界变复杂的问题。
- 当时思路：第一批先落地用户侧即时 ZIP：项目卡按当前用户可见项目任务打包，任务列表支持本页多选；超过 20 个转入后续后台任务规划，不在同步请求里硬撑。
- 改动位置：`src/lib/video/bulk-download.ts`、`src/app/api/video/bulk-download/route.ts`、`src/lib/video/download-client.ts`、`src/app/projects/page.tsx`、`src/app/tasks/page.tsx`、`src/app/api/projects/route.ts`、`src/app/globals.css`。
- 怎么改：新增批量下载服务层和 API；服务端逐条复用 `assertCanViewTask()` / `assertCanViewProject()` 做权限校验，复用 `cacheTaskVideoToLocal()` 拉取或刷新视频；ZIP 内写入视频文件和 `manifest.csv`，单个失败不影响其它成功视频入包；无权任务在 manifest 中只保留 taskId 和通用失败原因，不泄露项目、生成者、提示词或扣费元数据；项目卡和任务列表增加确认弹窗、下载中状态和移动端适配。
- 验证结果：`git diff --check`、`npx tsc --noEmit --pretty false`、`npm run lint`、`npm run build`、`npx impeccable detect src/app/projects/page.tsx`、`npx impeccable detect src/app/tasks/page.tsx`、本地 API smoke 和 Playwright 桌面/移动端检查通过。
- 可复用经验：成果批量下载要先定义同步上限和后台兜底；ZIP 依赖必须经过真实 Next build 验证，`archiver` 在当前构建链路会因 ESM exports 条件失败，最终使用 `yazl` 更稳。

## 2026-06-13 - `@ mention` 必须拆成公共解析和页面候选源

- 问题/背景：用户要求还原即梦输入 `@` 自动弹窗体验，并把普通生成页和画布页的 `@` 能力合并。
- 诱因/根因：普通 `/generate` 只有按钮插入 `@图片N`，画布 `/generate/canvas` 有自动弹窗但正则和替换逻辑写在节点组件里；历史图片加入 workspace 后也没有插回 prompt。
- 当时思路：第一批先闭环真实图片绑定，不把主体库和 Prisma schema 混进基础弹窗；公共层只做无状态 mention 检测、替换、解析，普通页和画布页分别提供自己的候选源。
- 改动位置：`src/lib/prompt/mention.ts`、`src/components/PromptMentionPopover.tsx`、`src/components/PromptEditor.tsx`、`src/components/GenerationComposer.tsx`、`src/components/PromptChecker.tsx`、`src/components/canvas/full/nodes.tsx`、`src/app/globals.css`、`tasks/todo.md`。
- 怎么改：抽 `detectMentionAtCursor`、`replaceMentionRange`、`parseImageMentions`；PromptEditor 捕获当前 mention range，支持主输入框和放大编辑框；GenerationComposer 对当前图直接返回 `@图片N`，对历史/图集来源用 Promise 等选择器确认后返回真实序号；画布页复用公共检测和替换，但保持“已连线图片”候选。
- 验证结果：共享 mention smoke、`npx tsc --noEmit --pretty false`、`npm run lint`、`npm run build`、`npx impeccable detect` 三个目标通过；本地 3100 Playwright 验证 `/generate` 自动弹窗、键盘插入、图集来源插入、历史入口、放大编辑框、390px 无横向溢出，以及 `/generate/canvas` 生成卡 `@` 空状态不退化。
- 可复用经验：引用型输入命令要把“候选展示”和“真实素材绑定”分离。异步选择历史/图集图片时，编辑器必须缓存 pending range，选择成功后再替换原 `@query`；不能退回 append 到末尾，也不能提交 provider 不理解的 `@主体名`。

## 2026-06-13 - 视频卡迁移先 nullable，再 backfill，再应用层强制

- 问题/背景：V1.2 P0 要求所有新生成必须归属视频卡，但本地已有 124 条历史 `VideoTask` 只有 `project_id`，没有 `video_card_id`。
- 诱因/根因：如果直接把 `VideoTask.video_card_id` 做成非空 FK，会卡住历史数据和 SQLite 迁移；如果只改前端选择视频卡，外部 API、画布生成、失败重试仍可能绕过归属。
- 当时思路：第一批采用兼容迁移：DB 字段先 nullable，应用层对新任务强制 `video_card_id`；历史任务用兜底视频卡 backfill；账本不重写，只按任务当前卡归属聚合展示。
- 改动位置：`prisma/schema.prisma`、`prisma/migrations/20260613160000_add_video_cards/migration.sql`、`scripts/backfill-video-cards.ts`、`src/lib/video-cards/*`、`src/app/api/tasks/create/route.ts`、`src/app/generate/page.tsx`、`src/components/canvas/full/CanvasWorkspace.tsx`。
- 怎么改：新增 `VideoCard` 和 `VideoTask.video_card_id`；新增视频卡权限/聚合 helper；标准生成页和画布页都必须选择视频卡；复用/重试继承原卡；项目页主视图改为视频卡列表；任务详情能回到视频卡。
- 验证结果：备份 `prisma/dev.db` 后应用迁移；backfill 创建 22 张兜底视频卡，迁移 124 个历史任务；SQL 验证 `missing_card=0`、`cross_project=0`，`CreditLedger` 和 `CostLedger` 计数/汇总不变；`prisma validate`、`tsc`、`lint`、`build` 通过。
- 可复用经验：给历史数据补强归属关系时，先用 nullable 字段保护上线，再用可重复 dry-run/apply 脚本迁移旧数据；所有创建入口、复用入口、重试入口和画布入口必须同时补齐，否则“新任务必填”只是局部约束。

## 2026-06-13 - 视频卡必须按项目子资源验证信息架构

- 问题/背景：用户指出视频卡不应该和项目同级；V1.2 第一阶段实际只完成了视频卡归属闭环，不等于整份需求已完成。
- 诱因/根因：之前只检查“任务归属视频卡”和入口能访问，没有把 URL、入口层级、返回链路和线上部署一起按“项目 -> 视频卡 -> 生成记录”的信息架构验收。
- 当时思路：把视频卡工作台迁到 `/projects/[id]/video-cards/[cardId]`，旧 `/video-cards/[id]` 只保留兼容跳转；所有项目页、任务页、生成页和画布页入口都指向项目内路径。
- 改动位置：`src/app/projects/[id]/video-cards/[cardId]/page.tsx`、`src/app/video-cards/[id]/page.tsx`、`src/app/projects/[id]/page.tsx`、`src/app/tasks/[id]/page.tsx`、`src/app/generate/page.tsx`、`src/components/canvas/full/CanvasWorkspace.tsx`、`src/lib/navigation/return-to.ts`。
- 怎么改：项目内页面校验 `video_card.project_id === projectId`；旧路由查出项目后 307 跳转；任务详情返回文案优先识别项目内视频卡路径。
- 验证结果：`npx tsc --noEmit --pretty false`、`npm run lint`、`npm run build`、`npx impeccable detect`、`youdoo-sites build sd2`、`youdoo-sites restart sd2` 通过；公网新路径 200，旧路径 307 到项目内路径，`youdoo-sites status sd2` OK。
- 可复用经验：用户指出“设计上不该同级”时，不能只改视觉或按钮；必须按信息架构检查数据归属、URL 层级、入口、返回链路、旧链接兼容和线上真实 URL。

## 2026-06-13 - 高规格生成审批不能只靠前端确认

- 问题/背景：V1.2 要求 1080p、预算、比例变更和视频卡重开都要可追溯审批；旧实现只有生成页复选框。
- 诱因/根因：前端复选框只能表达用户声明，不能证明审批存在，也不能追溯申请人、处理人、理由、有效期和拒绝原因。
- 当时思路：先建立统一 `ApprovalRecord` 和审批中心，再把 1080p 生成校验切到后端有效审批查询；生成页只保留显式确认和审批入口。
- 改动位置：`prisma/schema.prisma`、`src/lib/approvals.ts`、`src/app/api/approvals/*`、`src/app/approvals/page.tsx`、`src/app/api/tasks/create/route.ts`、`src/components/GenerationComposer.tsx`。
- 怎么改：新增审批记录表和 API；审批中心支持发起、通过、拒绝；非个人项目 1080p 生成必须查到 `resolution_1080p` 的 approved 且未过期记录，否则后端拒绝；最近 rejected 记录会把拒绝原因返回给生成页。
- 验证结果：`npx prisma validate`、`npm run db:generate`、`git diff --check`、`npx tsc --noEmit --pretty false`、`npm run lint`、`NEXT_DIST_DIR=.next-prod-dry-run npm run build`、`/tmp` SQLite approval smoke、`youdoo-sites build/restart/status sd2` 和公网 `/approvals`/`api/approvals` 验证通过。
- 可复用经验：任何高成本动作的“确认”都应拆成两层：前端确认只负责交互意图，后端必须验证可追溯审批实体；拒绝原因也要从审批记录回流到触发页面。

## 2026-06-13 - 反馈消单必须区分已验证闭环和高风险未闭环

- 问题/背景：用户要求把反馈页未完成项一次性落地并自动消单，其中同时包含 UI 细节、生成者头像、通知中心和项目代付。
- 诱因/根因：反馈列表里既有低风险显示层问题，也有通知模型和项目代付账务闭环；如果把所有反馈都按同一粒度处理，容易把未完成的 schema/账本/结算需求误归档。
- 当时思路：先把已具备清晰边界的 F1-F4 做成代码闭环和验证闭环，只归档对应反馈；F5 通知中心和 F6 项目代付保持未归档，继续受 Spec 和停止条件保护。
- 改动位置：`src/app/generate/page.tsx`、`src/components/GenerationComposer.tsx`、`src/components/ImageSetToolbar.tsx`、`src/app/projects/[id]/page.tsx`、`src/app/projects/[id]/video-cards/[cardId]/page.tsx`、相关项目/视频卡 API、`tasks/todo.md`。
- 怎么改：生成页最近任务改为相对时间和提示词同一行；空提示词保持 hint 色；图集按钮改成“保存素材为图集 / 创建空图集”；项目和视频卡任务列表复用 `UserIdentityBadge` 并补 `avatar_url/account_type`；只归档已验证的 5 条反馈。
- 验证结果：`git diff --check`、`npx tsc --noEmit --pretty false`、`npm run lint`、`npm run build` 通过；本地 3015 HTTP smoke 无 500；5 条已完成反馈归档，通知中心和项目代付反馈保持 `new`。
- 可复用经验：反馈自动消单必须绑定“实现 + 验证 + 对应反馈 ID”；通知、预算、扣费、退款和 schema 迁移类反馈不能用 UI 改动替代，也不能在未完成 Spec 前归档。

## 2026-06-14 - 视频卡归档不变量不能只靠新建入口

- 问题/背景：V1.2 要求每个生成任务都归属项目和视频卡，但任务详情里的项目归属调整接口会把 `video_card_id` 清空；封板视频卡也仍可通过 PATCH 修改候选、当前最佳和最终版。
- 诱因/根因：之前只在 `/api/tasks/create` 强制新任务选择视频卡，没有把后续移动、归档调整、封板后版本修改这些“二次变更入口”纳入同一不变量。
- 当时思路：先修会破坏数据基础的入口，移动任务必须选择目标项目下的视频卡；封板/归档卡禁止直接修改；再增加只读巡检脚本，后续每批都能快速验证现有数据没有回退。
- 改动位置：`src/app/api/tasks/[id]/project/route.ts`、`src/app/api/video-cards/[id]/route.ts`、`src/app/tasks/[id]/page.tsx`、`scripts/audit-video-card-invariants.ts`、`tasks/todo.md`。
- 怎么改：移动任务 API 新增目标视频卡校验，拒绝封板/归档目标卡，并在移出原最佳/最终版任务时清理原卡指针；视频卡 PATCH 禁止直接改 `status`，已封板/归档卡不能直接修改；任务详情管理面板增加目标视频卡选择；新增只读巡检脚本检查无项目、无视频卡、项目/卡错配、失效版本指针和封板后版本变更日志。
- 验证结果：`npx tsc --noEmit --pretty false`、`npx tsx scripts/audit-video-card-invariants.ts`、`npm run lint` 通过；巡检脚本返回 0 个基础归档异常。
- 可复用经验：业务不变量必须覆盖创建入口和所有二次变更入口。凡是会移动、重归档、封板、重开或改版本角色的 API，都要用同一套后端校验和只读巡检脚本证明没有制造孤儿任务或错配归属。

## 2026-06-14 - 审批记录必须驱动真实业务副作用

- 问题/背景：V1.2 要求公共项目立项、追加预算、1080p、比例变更和视频卡重开都通过审批闭环生效；旧审批中心只会把记录改成 approved/rejected。
- 诱因/根因：只有 `ApprovalRecord` 表和审批页面，不代表公共项目已创建、预算已入账或高成本动作已受控；如果验收只看“有记录”，会继续产生假完成。
- 当时思路：先落地公共项目立项和追加预算两条最小业务副作用，再用事务回滚 smoke 证明审批通过会改业务状态，审批拒绝不会改预算。
- 改动位置：`src/lib/approvals.ts`、`src/app/api/approvals/route.ts`、`src/app/api/approvals/[id]/route.ts`、`src/app/approvals/page.tsx`、`src/app/projects/page.tsx`、`scripts/approval-effects-smoke.ts`。
- 怎么改：`project_create` 通过后创建 `type='public'` 项目、项目负责人关系和预算账户；`budget_increase` 通过后调用 `adjustProjectBudget` 写入 `ProjectBudgetLedger`；拒绝只记录决策原因，不改预算。
- 验证结果：`npx tsx scripts/approval-effects-smoke.ts` 通过，脚本验证公共项目创建、初始预算流水、追加预算通过入账、追加预算拒绝不入账、操作日志写入，并主动回滚测试数据。
- 可复用经验：审批类需求的完成标准必须是“记录 + 权限 + 业务副作用 + 失败/拒绝不半更新 + 可回证验证”，不能把审批状态字段当成业务闭环。
