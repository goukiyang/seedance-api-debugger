# Lessons

## 2026-06-27 - 多 checkout 功能上线不能整分支 merge

- 问题/背景：AI MediaKit 视频超分功能先在旧 checkout 的 `codex/mediakit-video-enhance` 分支完成，再要推进到真实线上工作树 `/Volumes/Data/Projects/video-api-debugger-v12-full-todo`。
- 诱因/根因：功能分支和 live 分支相差大量历史提交；直接 merge 会带入旧 checkout 的删除、旧页面和旧任务文档，风险远大于功能本身。
- 当时思路：先跑 live gate，确认 `codex/v12-full-todo` 干净且等于远端；给当前线上 commit 打 rollback tag；只 cherry-pick AI MediaKit 相关提交，冲突时保留 live 已有火山 IP Provider 和长期 todo，再手动补 AI MediaKit 能力。
- 改动位置：`src/lib/provider/video-task-status.ts`、`src/lib/video/local-cache.ts`、`src/lib/video/task-finalizer.ts`、`src/app/admin/integrations/AdminIntegrationsClient.tsx`、`src/app/tasks/[id]/page.tsx`、`tasks/todo.md`。
- 怎么改：Provider 状态分发合并成 Seedance / 火山 IP / AI MediaKit 三路；任务详情页保留 live 的对象存储/慢速备用链路判断，只给 AI MediaKit 任务增加超分文案和入口；后台整合页保留原有配置能力并新增 AI MediaKit API Key 卡片。
- 验证结果：AI MediaKit 四个 smoke、`npx tsc --noEmit --pretty false`、`npm run lint`、`npm run build` 通过；构建 manifest 包含 `/admin/integrations/aimediakit` 和 `/api/tasks/enhance-video/create`。
- 可复用经验：多 checkout 场景上线功能时，先判断分支历史差异；如果不是 fast-forward 或小范围 merge，不要整分支合入，改用带回滚点的提交级 cherry-pick，并在冲突中优先保护 live 已验证能力。

## 2026-06-17 - 模板编辑页要按真实操作闭环摆放

- 问题/背景：模板上下文卡片已经有卡片、编辑器和提示词预览，但用户反馈“页面结构崩了”“最终提示词影响放在最底部，不要放在侧边”“编辑栏可以放在侧边”。
- 诱因/根因：之前把旧抽屉加宽，再把卡片、编辑器和提示词影响塞进同一个工作区，视觉上像临时后台；最终提示词影响离“保存/试生成前核对”太远，用户无法一眼判断强制/参考和绑定图片到底如何进入最终提示词。
- 当时思路：按真实任务重排：左侧/中间是卡片画布，右侧只编辑当前卡片并作为 sticky 操作菜单，保存动作也归入右侧编辑栏；底部横向区域专门做最终提示词影响核对，必须是工作台最后一块但不做固定条；详情页直接进入工作台，不再先点编辑按钮打开弹层。
- 改动位置：`src/components/templates/TemplateContextCardsPanel.tsx`、`src/components/templates/TemplateEditorDrawer.tsx`、`src/components/templates/AdminTemplatesClient.tsx`、`src/app/globals.css`、`src/lib/templates/workbench.ts`。
- 怎么改：`TemplateEditorDrawer` 增加 inline 工作台模式；`/admin/templates/[id]` 直接渲染卡片工作台；最终提示词影响区移到底部并常显强制、参考、绑定图片三列，随页面自然滚动且完整换行展示；保存状态和保存按钮移进右侧编辑栏；卡片列表超高时在主舞台内收缩滚动，避免把整页撑爆；空内容草稿卡片不再被保存链路过滤。
- 验证结果：`tsc`、`lint`、`git diff --check`、`impeccable detect`、`npm run build`、空卡片序列化 smoke、`youdoo-sites build/restart/status sd2` 通过；公网 CSS 命中新布局类名，`/api/config` 和 `/login` 返回 200。
- 可复用经验：工作台页面不要用“抽屉加宽”替代信息架构；编辑器可以在侧边并保持可用，保存动作属于编辑器；最终影响、核对和提交前判断必须放在底部或主流程末端，贴近用户做决定的位置，且不要用固定高度截断关键内容。

## 2026-06-15 - LLM 功能不能只落 UI 骨架

- 问题/背景：模板模块页面已有 `Module Builder` 面板和 Musk API 基础地址/模型配置，但用户继续反馈“llm 的需求做了么，我没看见对应的 ui”等缺口。
- 诱因/根因：前一批只完成可见入口和本地结构化草稿，尚未接入 API Key、真实 LLM 调用、AgentRun/Memory 审计和权限验证；“能看到面板”容易被误判为“LLM 已落地”。
- 当时思路：先用 smoke 测试锁住 Module Builder Agent 的 JSON 解析和校验协议，再补 Musk API Key、OpenAI-compatible 调用、管理员生成接口和前端真实请求。
- 改动位置：`src/lib/integrations/musk.ts`、`src/lib/templates/module-builder.ts`、`src/app/api/templates/module-builder/generate/route.ts`、`src/app/admin/integrations/AdminIntegrationsClient.tsx`、`src/components/GenerationComposer.tsx`、`src/components/templates/TemplateEditorDrawer.tsx`。
- 怎么改：Musk 配置增加 API Key 但不回显；Module Builder 接口只生成草稿，不直接保存模块；生成过程写入 `AgentRun`、`AgentRunStep`、`TemplateMemory` 和 `OperationLog`；主工作台 UI 显示等待、错误、追问、规则和执行链路。
- 验证结果：`npx tsx scripts/module-builder-agent-smoke.ts`、`./node_modules/.bin/tsc --noEmit --pretty false`、`npm run lint`、`npm run build`、`youdoo-sites build sd2`、`youdoo-sites restart/status sd2` 通过；公网静态 chunk 命中真实 Module Builder API 和 API Key 配置标识。
- 可复用经验：凡是标成 LLM/Agent 的功能，验收必须至少覆盖“模型配置含密钥、服务端调用器、结构化输出校验、权限、审计链路、前端真实请求”；只有本地模拟或静态 UI 时必须明确标注为骨架。

## 2026-06-14 - 删除/归档类按钮不要依赖浏览器原生 confirm

- 问题/背景：用户反馈生成页项目删除按钮点击后没有起效。
- 诱因/根因：前端先调用 `window.confirm`，在当前浏览器/WebView 环境里确认层可能被拦截、不明显或没有继续触发请求；线上操作日志也没有新的 `project_delete/project_archive`，说明点击很可能没有走到后端。
- 当时思路：后端继续保留“空项目可删除、已有任务或图集只能归档”的保护规则，只把前端确认交互改为站内弹窗，让用户看到明确动作和后端错误提示。
- 改动位置：`src/app/generate/page.tsx`、`src/app/globals.css`、`src/app/api/projects/[id]/route.ts`。
- 怎么改：删除按钮点击后设置 `pendingProjectRemoval` 并关闭项目菜单；弹窗里展示项目名、任务数、图集数和确认按钮；确认后再发 `DELETE` 或 `PATCH action=archive`。
- 验证结果：`git diff --check`、`npx tsc --noEmit --pretty false`、`npm run lint`、`npm run build`、`youdoo-sites build sd2`、`youdoo-sites restart/status sd2` 通过；公网生成页 JS 包命中新的确认文案。
- 可复用经验：用户可见的危险操作默认用站内确认弹窗，不依赖浏览器原生 confirm；后端保护规则不应为了“按钮能点”而放松，前端要把阻止原因清楚回显。

## 2026-06-14 - 飞书网页登录默认走同源 302 授权入口

- 问题/背景：用户反馈飞书登录显示“初始化失败”，但公网 `/api/auth/feishu/authorize-url` 直接请求能正常返回授权 URL。
- 诱因/根因：前端登录按钮原先在同一个 `try` 中先 `fetch` JSON，再 `window.location.assign()` 跳转外部飞书域名；如果 WebView、浏览器策略或外部跳转阶段抛错，会被误归类为“初始化失败”。
- 当时思路：把公网 OAuth 入口改成同源后端 302，前端只跳 `/api/auth/feishu/authorize`，由后端创建 state cookie 并重定向到飞书；localhost 仍保留原来的 CLI fallback。
- 改动位置：`src/app/api/auth/feishu/authorize/route.ts`、`src/app/login/page.tsx`、`src/app/register/page.tsx`。
- 怎么改：新增 `GET /api/auth/feishu/authorize`；登录页和注册页在非 localhost 环境直接跳同源授权入口；保留 `authorize-url` JSON 接口作为兼容和本地 fallback。
- 验证结果：`npx tsc --noEmit --pretty false`、`npm run build`、线上候选构建、`youdoo-sites restart/status sd2` 通过；公网 `/api/auth/feishu/authorize?next=/generate` 返回 303 到 `accounts.feishu.cn` 并写入 `feishu_oauth_state`；登录页/注册页新静态 JS 包包含同源授权入口。
- 可复用经验：OAuth 公网页面默认不要依赖前端 fetch 后再跳第三方授权域名；登录入口应优先使用同源后端 redirect，错误状态再落到站内 callback 页面展示。

## 2026-06-14 - 新 App Router 客户端页上线前必须跑生产构建

- 问题/背景：资产管理页 `/assets` 是客户端页面，使用 `useSearchParams()` 读取 `type=video` 初始筛选。
- 诱因/根因：`tsc` 和 `lint` 都能通过，但 Next 生产构建会要求 `useSearchParams()` 位于 Suspense 边界内，否则预渲染 `/assets` 时失败。
- 当时思路：不把未提交候选页面直接上线；先用生产构建暴露 App Router 预渲染问题，再按 Next 生产规则修页面结构。
- 改动位置：`src/app/assets/page.tsx`、`tsconfig.tsbuildinfo` 缓存、命令 `/Users/gouki-youdoo/.youdoo/bin/youdoo-sites build sd2`。
- 怎么改：把真实页面内容拆为 `AssetsPageContent`，默认导出用 `Suspense` 包裹并提供稳定加载态；清理引用旧临时 distDir 的 `tsconfig.tsbuildinfo` 增量缓存后重新构建。
- 验证结果：`./node_modules/.bin/tsc --noEmit`、`npm run lint`、`/Users/gouki-youdoo/.youdoo/bin/youdoo-sites build sd2`、`/Users/gouki-youdoo/.youdoo/bin/youdoo-sites restart sd2` 通过；公网 `/assets` 和浏览器框选验证通过。
- 可复用经验：页面类候选功能只通过类型检查不够；涉及 App Router、`useSearchParams()`、动态路由或客户端数据拉取时，发布前必须跑真实生产构建；若临时 `NEXT_DIST_DIR` 用于 dry-run，结束后要清理增量编译缓存，避免后续构建引用已不存在的 types。

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

## 2026-06-15 - LLM 入口必须放在管理员的自然操作点

- 问题/背景：用户多次反馈“找不到用 LLM 生成模块的入口”，实际原因不是后端没有能力，而是入口放在抽屉顶部 Agent 面板里，和管理员预期的“新增模块 / 新增规则”操作点错位。
- 诱因/根因：把 Agent 能力当成独立功能块展示，而不是嵌入用户原本要完成的动作；结果用户在新增模块和新增规则时看不到 LLM。
- 当时思路：保留整套模板配置入口，但把单模块和单规则生成入口移到模块绑定区、规则分组区，并让每个具体行自动带入类型。
- 改动位置：`src/components/templates/TemplateEditorDrawer.tsx`、`src/app/globals.css`、`src/app/api/templates/module-builder/*`、`src/lib/templates/module-library.ts`、`tasks/todo.md`。
- 怎么改：模块页加入 `+ 新增模块（LLM）` 和每行 `LLM 生成`；规则页加入 `+ 新增规则（LLM）` 和每组 `LLM 生成本类规则`；内联展开 Module Builder / Rule Builder，支持生成、预览、应用、保存、拒绝、查看链路。
- 验证结果：入口 smoke、LLM 合约 smoke、类型检查、lint、构建、设计扫描均通过；线上 `sd2` 构建发布后公网 chunk 已命中新入口文案，健康守护周期后服务稳定。
- 可复用经验：Agent 主执行不是“多放一个聊天框”。后台 LLM 能力必须嵌入用户正在做的按钮和表单附近，生成结果必须有预览、人工确认、保存、追溯和失败回退，才算闭环。

## 2026-06-14 - 模板生成必须作为独立任务面落地

- 问题/背景：用户指出截图里的模板生成页不是普通 `/generate` 的增强版，而是独立的模板生成页面；之前把模板工作台塞进普通生成页，导致信息架构共生、普通生成变复杂、todo 状态也容易误判。
- 诱因/根因：表面上都是“生成视频”，但普通生成的第一性原理是自由 Prompt/素材驱动，模板生成的第一性原理是固定品牌、角色、Logo、规则后让用户只输入本次变量并选择方案；两条路径的主任务不同，不能共用同一个首屏。
- 当时思路：不删除既有能力，而是给 `GenerationComposer` 增加模板模式开关；普通 `/generate` 默认关闭模板工作台，新增 `/template-generate` 独立外壳承载模板页，模板抽屉和 Agent 链路页按截图补齐信息层级。
- 改动位置：`src/app/template-generate/page.tsx`、`src/components/templates/TemplateGenerateClient.tsx`、`src/components/GenerationComposer.tsx`、`src/components/templates/TemplateEditorDrawer.tsx`、`src/app/admin/agent-runs/[id]/page.tsx`、`src/app/templates/page.tsx`、`src/app/globals.css`、`tasks/todo.md`。
- 怎么改：新增独立模板生成路由；模板页顶部明确项目/视频卡归属和模板生成任务；`GenerationComposer` 通过 `templateMode="workbench"` 才显示模板区、需求区、方案卡和 Prompt 预览；普通生成页默认不加载模板工作台；模板抽屉改为 `模块 / 规则 / 资产`；Agent 链路详情增加 9 步链路卡、规则命中和输入输出对比。
- 验证结果：`git diff --check`、`npx tsc --noEmit --pretty false`、`npm run lint`、`npm run build`、`npx impeccable detect` 通过；本地 `http://localhost:3100/template-generate` 返回 200 且包含模板生成页首屏，`/generate` 仍按普通生成页登录保护跳转。
- 可复用经验：当用户纠正“这不是同一个页面”时，优先按主任务和第一性原理拆页面，不要只靠显隐开关把两个工作流堆在一个页面里；保留功能不等于同屏暴露，低频配置进抽屉，调试证据进链路页，主页面只服务用户最短生成路径。

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

## 2026-06-14 - Agent 链路页必须和实际落库步骤同源

- 问题/背景：模板生成链路页已经按 9 步产品流程展示，但 `/api/agent/template-plans` 只写入 6 步，且存在 `memory_apply` 这种不在页面定义里的旧 key。
- 诱因/根因：只从页面信息架构出发补 UI，没有同时检查 Agent Run 的真实写入路径，导致链路卡能显示，但真实时间线会缺步骤。
- 当时思路：把 API 写入事件同步成 `Intent -> Template Load -> Module Composer -> Rule Engine -> Prompt Compiler -> Plan Generator -> Validator -> Seedance Execution -> Memory Record`，页面只负责读取同一组 key；导出报告和页面展示统一走脱敏函数。
- 改动位置：`src/app/api/agent/template-plans/route.ts`、`src/app/admin/agent-runs/[id]/page.tsx`、`src/components/agent/AgentRunTraceActions.tsx`。
- 怎么改：创建 Agent Run 时落库 9 个步骤；尚未提交 Seedance 的步骤明确标记为 `pending_submit`；执行链路详情页增加 Trace 复制、报告导出、自动刷新、错误摘要，并对 token、cookie、密钥和 URL 字段脱敏。
- 验证结果：`git diff --check`、`npx tsc --noEmit --pretty false`、`npm run lint`、`npm run build`、`npx impeccable detect` 和本地 `/template-generate` HTTP smoke 通过；线上部署验证待执行。
- 可复用经验：调试链路页不是静态流程图。每一个 UI 步骤都必须能追溯到真实写入事件；如果产品流程调整，先改写入 key，再改页面展示和导出，否则排查时会看到“漂亮但不可信”的链路。

## 2026-06-15 - 生产构建前隔离源码时要同时避开旧类型目录

- 问题/背景：资产页图片批量动作上线前，需要临时隔离当前运行目录里的非本轮 tracked 改动和未跟踪源码目录，避免无关页面进入生产构建。
- 诱因/根因：未跟踪源码被隔离后，旧 `.next/types` 或 `.next-prod/types` 仍可能保留这些页面的类型入口，导致 `youdoo-sites build sd2` 在 TypeScript 校验阶段找不到对应源码。
- 当时思路：不直接删除 live `.next-prod`；构建时临时让 `tsconfig.json` 只扫描源码和 `.next-prod-candidate/types`，构建完成后立即恢复原 include。
- 改动位置：`src/app/assets/page.tsx`、`src/app/globals.css`、`tasks/todo.md`、临时构建配置 `tsconfig.json`。
- 怎么改：资产页补齐“加入工作区 / 加入图集 / 移动视频”批量动作；部署前 stash 非本轮源码；构建期间临时排除旧 `.next`、`.next-prod`、`.next-dev` 类型目录；部署后恢复 `tsconfig.json` 并复原工作区改动。
- 验证结果：`npx tsc --noEmit --pretty false`、`git diff --check`、`npm run lint`、`youdoo-sites build sd2`、`youdoo-sites restart/status sd2` 通过；公网资产页 chunk 命中新批量动作；跨健康守护周期 `runs` 未增长。
- 可复用经验：生产构建隔离源码时，不只要隔离 `src/**`，还要处理旧构建类型目录。优先用临时 `tsconfig` include 收敛来绕开旧类型引用，构建后必须恢复，避免污染仓库配置。

## 2026-06-15 - 页面功能完成必须包含导航可见性

- 问题/背景：模板生成和 API 设置能力已有页面或路由，但用户在导航栏目里找不到对应入口，导致“做了页面”没有形成可用闭环。
- 诱因/根因：验收只检查了路由或局部页面，没有同时检查左侧导航、后台快捷入口、兼容跳转和公网构建 chunk 是否包含入口文案。
- 当时思路：把“页面存在”升级成“入口可见 + 目标路由可访问 + 生产构建已加载”；模板库和模板生成工作台分别命名，避免“动画模板”和“模板生成”混淆。
- 改动位置：`src/lib/navigation.ts`、`src/app/admin/page.tsx`、`src/app/admin/settings/page.tsx`、`src/app/admin/integrations/AdminIntegrationsClient.tsx`、`src/components/templates/TemplateEditorDrawer.tsx`、`tasks/todo.md`。
- 怎么改：左侧导航新增“模板生成”直达 `/template-generate`；后台入口改成“API 设置”并保留 `/admin/settings` 跳转；模板编辑抽屉新增 LLM 配置模板和 Module Builder 骨架；todo 标注真实 LLM 后端调用仍待继续。
- 验证结果：`./node_modules/.bin/tsc --noEmit --pretty false`、`git diff --check`、`youdoo-sites build/restart sd2` 通过；公网 `/template-generate` 200；公网 layout chunk 命中 `模板生成`、`API 设置`；跨健康守护周期 `runs=58` 未增长。
- 可复用经验：任何用户可见页面或后台设置页，完成标准必须包括导航/快捷入口可见性验证。只验证 URL 可访问不够，必须证明用户能从当前信息架构进入该页面。

## 2026-06-15 - LLM Builder 不能只藏在编辑抽屉

- 问题/背景：模板模块 LLM 生成器已经加到模板编辑抽屉，但用户进入模板生成页看不到对应 UI，以为 LLM 需求没有做。
- 诱因/根因：把“管理员低频编辑入口”当成“功能已上线入口”。抽屉内能力需要先知道编辑按钮和页签路径，不能作为主任务面的可见证据。
- 当时思路：把 LLM Builder 提升到 `/template-generate` 模板工作台内部，在当前模板上下文下直接展示模块类型、对话输入、生成规则、结构化预览和 API 设置入口；抽屉编辑能力保留。
- 改动位置：`src/components/GenerationComposer.tsx`、`src/app/globals.css`、`tasks/todo.md`。
- 怎么改：新增主工作台“LLM 模板配置 / 新增模块”面板；复用 sd2 视频生成 skill 的通用提示词格式作为 `prompt_format` 模块；生成草稿包含 `moduleType`、`promptBlock`、`rules`、`injectionMode`、`priority` 和当前模板上下文。
- 验证结果：`./node_modules/.bin/tsc --noEmit --pretty false`、`git diff --check`、`npm run lint`、`npx impeccable detect`、`youdoo-sites build/restart sd2` 通过；公网 JS/CSS 命中 `template-llm-builder`、`Module Builder`、`draft_requires_admin_review`、`prompt_format`。
- 可复用经验：Agent/LLM 类需求必须在主任务面有可见入口。抽屉、隐藏页签和详情页只能作为高级编辑路径，不能替代用户进入页面后能直接看到的工作区。

## 2026-06-15 - 图形模型配置必须和文字 LLM 配置分离

- 问题/背景：无线画布需要图形生成能力，但现有 Musk API 默认模型是 `gpt-5.4`，只适合 prompt、分镜和结构化草稿，不适合文生图、图生图或首尾帧草图。
- 诱因/根因：如果复用文字 LLM 配置去接图像模型，会混淆 Provider Key、模型能力、计费、失败处理和后台排查口径。
- 当时思路：先新增独立 `image_generation_api_v1` 配置；2026-06-17 已按用户纠偏，Provider 应走 Musk APIs 网关，默认模型走 Musk 可用的 Gemini 图片模型，不应把内部代号 `banana2` 当成后台 provider 或模型名。
- 改动位置：`src/lib/integrations/image-generation.ts`、`src/app/api/admin/integrations/image-generation/route.ts`、`src/app/api/assets/generate/route.ts`、`src/app/admin/integrations/AdminIntegrationsClient.tsx`、`tasks/todo.md`。
- 怎么改：新增图形生成 API 配置读写、管理员设置卡、API Key 不回显、未配置时 `/api/assets/generate` 返回 503；纠偏后默认 provider 为 `musk`，默认地址为 `https://api.muskapis.com/`，默认模型为 `gemini-3.1-flash-image-preview`，旧 `banana2`、Google 直连地址和旧模型保存值只作为兼容迁移输入。
- 验证结果：历史版本曾验证后台配置骨架；2026-06-17 纠偏后已验证当前后台 key 对 Musk API 有效，`/v1/models` 能返回 `gemini-3.1-flash-image-preview`。Musk 的 `/v1/images/generations` 不支持该 Gemini 图片模型，应走 `/v1beta/models/{model}:generateContent`，实测能返回 `inlineData` 图片；`/api/assets/generate` 登录态真实生成已成功入库，返回 `Asset`、`ReferenceImage`、`WorkspaceAsset` 和缩略图。
- 可复用经验：跨模型能力要先拆配置域和安全边界；文字 LLM、图像模型、视频 Provider 不应共用一个 API 设置或一套计费语义。接 Musk APIs 这类聚合网关时，不能拿 Google 官方 base URL 或 Google key 规则判断；要按网关实际模型列表、端点类型和鉴权方式做真实探针。

## 2026-06-15 - 页面类改动不能停在本地验证

- 问题/背景：无限画布版头和底部留白修复已本地验证，但第一次汇报时没有自动 Git 上传和线上部署。
- 诱因/根因：当前开发目录和线上来源目录都有大量未提交改动，且线上 `sd2` 实际来源不是当前目录；遇到这种情况时错误地停在本地闭环，而不是先隔离出干净分支和线上来源补丁。
- 当时思路：用独立 worktree 形成聚焦 Git 版本，再把同一补丁落到线上来源目录，按 `youdoo-sites build/restart/status sd2` 做公网验证。
- 改动位置：`src/components/canvas/full/CanvasWorkspace.tsx`、`src/app/canvas-workspace.css`、`src/app/globals.css`、`tasks/lessons.md`。
- 怎么改：移除画布内部版头，保留通用版头；导出入口移入画布管理区；画布和 topbar-only 内容区高度改为通用版头下方剩余视口。
- 验证结果：`npm run lint`、`npm run build` 通过；后续必须继续完成 Git 远端可见和 `sd2.youdoodesign.com` 线上可见验证后才算结束。
- 可复用经验：页面、样式或交互改动只要目标是线上页面，完成标准必须是“本地实现 + 远端版本 + 线上运行实例加载新构建”。脏工作区不是停止理由，应先用独立 worktree、聚焦提交或补丁隔离。

## 2026-06-15 - 候选构建缺关键文件时先保 live，再重跑闭环

- 问题/背景：导航重组本地实现和普通 `npm run build` 已通过，但第一次执行 `youdoo-sites build sd2` 时，候选目录 `.next-prod-candidate` 未生成 `BUILD_ID` 和 `prerender-manifest.json`。
- 诱因/根因：安全构建脚本会先构建候选包，再校验关键文件并替换 live `.next-prod`；Next 第一次会自动把 `.next-prod-candidate/types/**/*.ts` 写入 `tsconfig.json`，该次候选包不完整，不能发布。
- 当时思路：第一次候选不完整时保留当前健康线上版本，不执行 restart，不替换 `.next-prod`；保留临时类型 include 重跑官方构建，成功后恢复 `tsconfig.json`，再重启和公网验证。
- 改动位置：`src/lib/navigation.ts`、`src/components/ComposerTopbar.tsx`、`src/components/SideNav.tsx`、`src/app/admin/page.tsx`、`src/app/admin/AdminGenerationDashboardClient.tsx`、`src/app/globals.css`、`tasks/todo.md`、`tasks/lessons.md`。
- 怎么改：完成导航分层、顶部快捷收敛、侧边栏分组、管理中心入口归纳和视觉样式整理；部署阶段先让候选构建生成临时类型配置，再重跑 `youdoo-sites build sd2` 生成完整 `.next-prod`，最后恢复 `tsconfig.json`。
- 验证结果：`npx tsc --noEmit --pretty false`、`npm run lint`、`npm run build`、`git diff --check`、`npx impeccable detect ...`、`youdoo-sites build/restart/status sd2` 通过；`.next-prod/BUILD_ID=d02kA_j7kG-kJXP3VUOcY`，公网 `/api/config` 和 `/login` 返回 200，公网 layout chunk 命中新导航文案。
- 可复用经验：`youdoo-sites build` 未完成或候选包缺关键文件时，禁止重启线上服务，也不能汇报“已上线”。但如果 Next 只是先写入候选类型 include，保留该临时 include 重跑官方构建，成功后再恢复 `tsconfig.json`，可以把部署闭环做完。

## 2026-06-16 - 管理对象合并后仍要保留直达入口

- 问题/背景：管理中心把用户和项目合并为“用户与项目”归纳项后，项目管理入口不够明显，用户反馈“管理页的项目没有入口”。
- 诱因/根因：信息架构合并只减少了一级入口数量，但没有保留关键管理对象的直达入口；“用户与项目”对项目管理来说过于隐含。
- 当时思路：不撤回管理中心归纳结构，只把高频、独立对象“项目管理”在管理侧栏和管理中心顶部按钮中显式露出。
- 改动位置：`src/lib/navigation.ts`、`src/app/admin/page.tsx`。
- 怎么改：管理中心侧栏把“用户与项目”拆成“用户管理”和“项目管理”；管理中心页顶部主操作新增“项目管理”直达 `/admin/projects`。
- 验证结果：`git diff --check`、`npx tsc --noEmit --pretty false`、`npx impeccable detect ...`、`youdoo-sites build/restart/status sd2` 通过；公网 layout chunk 命中“项目管理”和“用户管理”。
- 可复用经验：后台导航可以归纳，但不能把关键管理对象藏到抽象分组里。用户、项目、成本、产出这类高频对象至少要在管理中心首屏或侧栏有明确直达入口。

## 2026-06-17 - 生成页项目卡要按对象卡片排版

- 问题/背景：生成页项目选择卡把“当前项目”标签放在项目名上方，视觉上压住项目名和统计信息，用户要求按红框结构改成左头像、右信息。
- 诱因/根因：原实现把项目卡当成表单字段，有标签、图标、项目名、统计、头像多层堆叠；但这个区域实际是当前保存对象的卡片摘要，不需要再写“当前项目”。
- 当时思路：保留项目选择能力和下拉入口，只重排当前项摘要。左侧显示头像，没有项目时才用文件夹兜底；右侧只展示项目名和任务/图集信息。
- 改动位置：`src/app/generate/page.tsx`、`src/app/globals.css`。
- 怎么改：删除项目触发器里的“当前项目”标签；把左侧图标改为项目负责人头像；右侧改为项目名 + meta row；CSS 调整触发器高度、列宽、头像尺寸和文本层级。
- 验证结果：`git diff --check`、`npx tsc --noEmit --pretty false`、`npx impeccable detect ...`、`youdoo-sites build/restart/status sd2` 通过；生产包命中 `composer-project-trigger-avatar`、`composer-project-trigger-meta-row`、`is-avatar`，不再命中项目卡内 `当前项目</span>`。
- 可复用经验：选择器当前值如果代表一个对象，就按对象卡片排版。避免“字段标签 + 对象摘要 + 头像”堆叠，尤其不要让标签和对象名抢同一视觉层级。

## 2026-06-16 - 诊断默认先查后台反馈表

- 问题/背景：用户说“诊断”时，期望查看后台反馈页收集到的真实反馈，而不是先从前端入口或其他链路推断。
- 诱因/根因：排查时把最近改动链路当成诊断入口，忽略了项目已有 `Feedback` 后台表和 `/api/admin/feedback` 管理接口。
- 当时思路：先从生产数据库读取 `Feedback` 汇总、最新 new 反馈、页面分布和已处理状态，再判断哪些已修复应消单、哪些是真新需求。
- 改动位置：`prisma/schema.prisma` 的 `Feedback` 模型、`src/app/api/admin/feedback/route.ts`、生产库 `Feedback` 记录。
- 怎么改：确认总反馈、new/archived 数量和最近反馈；核对版权失败任务已修复并退款后，将对应反馈 `cmqez2vic008312eobd00tncc` 归档并写 admin_note。
- 验证结果：后台查询显示 `Feedback` 总数 28、原 `new=18`；任务 `cmqeygqo7006k12eovtfwjdck` 已为 failed，冻结点数为 0，存在 `task_failed_refund` 流水；对应反馈已更新为 archived。
- 可复用经验：以后本项目用户只说“诊断”时，默认第一步查生产后台反馈数据，输出新反馈、已修复待消单和未做事项；只有反馈指向具体页面或任务后，再进入相应代码/任务链路。

## 2026-06-16 - Seedance 资产上传不能把 AssetType 写死成 Image

- 问题/背景：Seedance 资产面板里图片上传正常，但视频和音频上传失败。
- 诱因/根因：官方完整功能示例已经包含 `reference_video`、`reference_audio`、`video_url`、`audio_url`，资产创建接口也依赖 `AssetType`；项目里的 `/api/assets/upload-and-create` 只允许 `jpg/png/webp`，并且调用官方 `/asset/create` 时固定传 `Image`。
- 当时思路：先查官方文档资源确认视频/音频是受支持素材，再收敛修改资产创建入口，不改底层存储和官方 API client，因为它们已经支持 `Image/Video/Audio`。
- 改动位置：`src/app/api/assets/upload-and-create/route.ts`、`src/app/api/assets/create-from-url/route.ts`、`src/components/SeedanceAssetPanel.tsx`。
- 怎么改：本地上传按 MIME 和扩展名识别 `Image/Video/Audio`；图片保留 10MB 上限，视频/音频使用 50MB 上限；URL 创建按扩展名推断资产类型；前端文件选择框放开 `mp4/mov/webm/mp3/wav/ogg`。
- 验证结果：`git diff --check`、`npm run lint`、`youdoo-sites build sd2`、`youdoo-sites restart/status sd2` 通过；公网 `/api/config`、`/login` 200；生产编译产物命中 `video/mp4`、`audio/mpeg`、`Video`、`Audio`；健康守护周期后 `runs=72` 未增长。
- 可复用经验：遇到“图片可用但视频/音频不可用”的素材问题，优先检查前端 accept、后端白名单和官方 `AssetType` 是否三处一致，不要只看存储层是否支持扩展名。

## 2026-06-17 - 服务器迁移先改名并行灰度，不直接切正式域名

- 问题/背景：需要把 Mac 上的 Seedance2 网站搬到 `server skills` 默认 Ubuntu 服务器，并把历史目录名 `video-api-debugger-v12-full-todo` 改成长期可维护的 `seedance2`。
- 诱因/根因：当前 Mac 生产目录依赖跨目录软链接：`.env` 指向旧项目目录，`prisma/dev.db` 指向旧目录数据库；如果只复制当前文件夹，服务器上会断环境变量和 SQLite 数据库路径。
- 当时思路：先建立服务器并行灰度环境，不切正式 `sd2.youdoodesign.com`；代码、环境、SQLite、uploads、videos、systemd、nginx Host 分层迁移，避免一次性把正式入口切坏。
- 改动位置：服务器 `/home/gouki/services/seedance2`、`/home/gouki/data/seedance2`、`/etc/systemd/system/seedance2.service`、`/etc/nginx/sites-available/sd2-server.youdoodesign.com`、`tasks/todo.md`。
- 怎么改：生成代码快照并排除 `node_modules` 和 `.next*`；用 SQLite `.backup` 生成灰度库；同步 `public/uploads` 和 `public/videos`；在 release 内把 `.env`、`prisma/dev.db`、`public/uploads`、`public/videos` 改成服务器绝对路径软链接；在 Ubuntu 上重新 `npm ci`、`npx prisma generate`、`npm run build`；systemd 监听 `127.0.0.1:3302`，nginx 预配置灰度 Host。
- 验证结果：服务器 BUILD_ID `wUapis7t_x9-DwvlgU4uw`；`seedance2.service` active；`systemctl restart seedance2` 后 `/api/config` 和 `/login` 200；数据库计数与 Mac 一致；uploads/videos 样本 200；公网 IP + Host 头访问 nginx 灰度 Host `/api/config` 和 `/login` 200。
- 可复用经验：搬 Next + SQLite 站点时，先改成清晰的服务器目录名并做并行灰度。正式切换前必须停写后再做最终 SQLite 和文件增量同步；真实公网域名、飞书回调和上传链路未验证前，不切正式域名。

## 2026-06-17 - 模板生成页先保用户主路径，再放管理员能力

- 问题/背景：模板生成页把普通生成、项目归档、Prompt 编辑、参考图、参数栏和 Module Builder 放在同一个工作面里，用户看不到“用模板生成视频”的简单闭环。
- 诱因/根因：实现时沿工程配置视角继续堆能力，导致普通用户主路径被管理员低频配置打断；LLM 能力也缺少 API 状态前置检查和设置页测试闭环。
- 当时思路：按角色拆面。普通用户只看到模板摘要、需求输入、方案选择和提交；管理员能力进入折叠工具区；所有真实 LLM 入口先看 Musk API 是否 ready。
- 改动位置：`src/components/templates/TemplateGenerateClient.tsx`、`src/components/GenerationComposer.tsx`、`src/components/ComposerActionBar.tsx`、`src/app/admin/integrations/AdminIntegrationsClient.tsx`、`src/app/api/admin/integrations/musk/route.ts`、`src/app/globals.css`、`tasks/todo.md`。
- 怎么改：保存位置和视频卡折叠，提交前自动创建视频卡；Prompt、参考图、参数栏默认折叠；Module Builder 仅管理员可见且依赖 Musk 状态；API 设置页新增最小 JSON 连通性测试，并写 OperationLog。
- 验证结果：`git diff --check -- <本轮目标文件>`、`npx tsc --noEmit --pretty false`、`npm run lint`、`npx impeccable detect ...`、`npm run build` 通过；本地 `/template-generate` HTML 命中折叠保存位置、三步流和切换模板。
- 可复用经验：模板类页面的完成标准不是“能力都在页面上”，而是不同角色各自闭环。普通用户主路径不能出现底层术语；管理员 LLM 操作必须先有 API 可用性前置检查和可追踪测试入口。

## 2026-06-17 - 模板模块应是上下文卡片，不是工程字段

- 问题/背景：用户再次指出重做后的模板模块仍然难用，原因是界面仍在暴露 `brand_logo`、模块类型、底层字段和工程结构。
- 诱因/根因：把系统内部的模块/规则模型直接映射到 UI，导致用户像在填代码配置，而不是在编排给 LLM 的上下文。
- 当时思路：把模块统一降维为“上下文卡片”。卡片只负责表达一段最终给 LLM 的上下文内容，可拖拽、可启用、可编辑、可选择强制插入或仅供参考，可选绑定 1 张图片。
- 改动位置：`tasks/todo.md`。
- 怎么改：新增“2026-06-17 最新产品修正：上下文卡片系统”；重写 `Phase 4：模板上下文卡片编排器` 和 `Phase 5：卡片绑定图片与图片选择器复用`；明确图片来源复用参考图集和历史上传图。
- 验证结果：本轮为规划更新，未改业务代码；`tasks/todo.md` 已记录新页面、数据、交互、接口、验收标准和禁止项。
- 可复用经验：模板模块 UI 必须从用户要表达的内容出发。内部可以继续有 `prompt_required/context_only` 等字段，但主界面只能呈现“上下文内容、强制插入/仅供参考、启用、编辑、绑定图片”这些用户能理解的概念。目标版本变更后，旧 todo 章节要明确标成历史记录或兼容层，不能让旧 `Module Builder` 主线和新上下文卡片主线并行冲突。

## 2026-06-17 - 上下文卡片落地优先做兼容层，不急着迁移数据库

- 问题/背景：用户要求“全量落地不要停”，目标是尽快在网页上看到并使用上下文卡片版模板管理，而不是继续停留在规划。
- 诱因/根因：现有模板数据已经有 `module_bindings_json`、`TemplatePromptBlock`、`TemplateAsset`、`TemplateRule` 等旧结构；如果第一步就做数据库迁移，会拖慢入口和 UI 闭环。
- 当时思路：先在序列化层新增 `context_cards`，旧模板读取时自动转换成卡片；保存卡片时再同步回旧 `prompts/assets/module_bindings_json`，让旧生成链路继续工作。
- 改动位置：`src/lib/templates/workbench.ts`、`src/app/api/templates/[id]/context-cards/route.ts`、`src/components/templates/TemplateContextCardsPanel.tsx`、`src/components/templates/TemplateBoundImagePicker.tsx`、`src/components/templates/TemplateEditorDrawer.tsx`、`src/components/templates/AdminTemplatesClient.tsx`、`src/lib/navigation.ts`、`src/app/admin/page.tsx`、`src/app/globals.css`。
- 怎么改：新增 `/admin/templates` 工作台和 `/admin/templates/[id]` 详情页；编辑抽屉默认显示上下文卡片；卡片支持排序、启停、强制/参考、图片绑定、LLM 改写和自动保存；绑定图片从参考图集和历史上传图选择。
- 验证结果：`tsc`、`lint`、`git diff --check`、`npx impeccable detect`、`npm run build` 通过；本地 `/admin/templates` 未登录 307 到登录页，`/api/templates` 未登录 401，构建路由表包含新增页面和接口。
- 可复用经验：当用户要求产品交互快速闭环时，优先做“用户对象 + 兼容映射”。数据库迁移、完整版本化和深层重构可以后置，但主界面必须先摆脱旧字段模型。

## 2026-06-17 - 线上包命中组件不等于真实入口可用

- 问题/背景：参考图缩放预览组件已经在生产包里，但用户在生成页当前参考图和上传历史图片里点击图片没有弹窗。
- 诱因/根因：只验证了线上 chunk 里存在 `ZoomableImagePreview`，没有逐个核对真实入口的点击绑定；上传历史和图集选择使用独立卡片组件，之前只把当前参考图缩略图接到了预览。
- 当时思路：先按入口追代码，再把“图片预览”和“选择加入参考图”拆成两个明确点击区。
- 改动位置：`src/components/ReferenceThumb.tsx`、`src/components/UploadedImagePicker.tsx`、`src/components/ReferenceAlbumPicker.tsx`、`src/app/globals.css`。
- 怎么改：当前参考图继续点击图片放大；上传历史图片和图集图片的图片区点击放大，状态按钮负责选择；复用 `ZoomableImagePreview` 的滚轮缩放、拖动、放大、缩小和还原能力。
- 验证结果：`npx tsc --noEmit --pretty false`、`npm run lint`、`npm run build`、`npx impeccable detect ...`、`youdoo-sites build/restart/status sd2` 通过；公网 JS 命中 `uploaded-picker-preview-button`、`album-picker-image-preview`、`放大查看`，公网全局 CSS 命中对应样式；健康守护周期后 `runs` 未增长。
- 可复用经验：页面交互类修复不能只证明组件存在或资源已发；必须按用户实际入口逐个验证事件绑定、弹窗层级和线上资源命中。

## 2026-06-17 - 全屏预览不能挂在会裁剪的父弹窗里

- 问题/背景：上传历史图片里点击放大后，预览层被限制在上传历史图片弹窗内部；生成页当前参考图单击也没有稳定响应。
- 诱因/根因：预览组件虽然使用 `position: fixed`，但它被渲染在带 `transform` 和 `overflow: hidden` 的父弹窗里，浏览器会按父弹窗裁剪；参考图缩略图外层在 `pointerdown` 就捕获指针并进入拖拽链路，单击和拖动没有真正分开。
- 当时思路：预览层改为 React Portal 挂到 `document.body`，让它真正覆盖整个视口；拖拽只有移动超过阈值后才捕获指针和触发排序，未移动时保留正常单击。
- 改动位置：`src/components/ZoomableImagePreview.tsx`、`src/components/ZoomableImagePreview.module.css`、`src/components/ReferenceStrip.tsx`。
- 怎么改：`ZoomableImagePreview` 使用 `createPortal` 输出到 `document.body`，预览层 `z-index` 提升到 4000；`ReferenceStrip` 去掉 `pointerdown` 立即捕获，改为超过 4px 移动后才设置拖拽态和 `setPointerCapture`。
- 验证结果：`npx tsc --noEmit --pretty false`、`git diff --check`、`npm run lint`、`npm run build`、`npx impeccable detect ...`、`youdoo-sites build/restart/status sd2` 通过；公网 JS 命中 `createPortal`、`setPointerCapture`、`hasPointerCapture`，公网 CSS 命中 `z-index:4000`。
- 可复用经验：任何全屏预览、全局菜单、tooltip、弹窗上弹窗，都不要挂在可能 `transform/overflow` 的局部容器里；排序拖拽必须先区分“点击”和“移动超过阈值”，不能在 `pointerdown` 就抢走点击。

## 2026-06-17 - 删除旧模板入口要清到路由表和前端包

- 问题/背景：用户指出新版上下文卡片方向已经确认，但网页结构里仍残留旧模块库、旧设置跳转和旧抽屉高级结构，页面看起来像多套系统并存。
- 诱因/根因：之前只把新 `/admin/templates` 加进导航，没有把旧 `/admin/modules`、`/admin/settings` 和 `TemplateEditorDrawer` 里的旧 Module Builder 表单从页面结构里彻底移除。
- 当时思路：以最新目标为唯一主线，删除旧页面，导航只保留模板工作台和必要诊断入口；抽屉只保留上下文卡片，不再渲染或打包旧工程字段 UI。
- 改动位置：`src/app/admin/modules/page.tsx`、`src/app/admin/settings/page.tsx`、`src/lib/navigation.ts`、`src/app/admin/page.tsx`、`src/components/templates/TemplateEditorDrawer.tsx`、`src/app/globals.css`、`tasks/todo.md`。
- 怎么改：删除旧模块库页和旧设置跳转页；从 shell route、后台导航和管理中心快捷入口移除旧入口；重写模板编辑抽屉为纯卡片版；清理 `.next` 和 `.next-prod` 中旧路由类型缓存。
- 验证结果：`tsc`、`git diff --check`、`npx impeccable detect`、`npm run lint`、`npm run build` 通过；构建路由表不再包含 `/admin/modules`、`/admin/settings`；前端可见生产包旧路由、`模块库` 和 `高级结构` 命中数为 0；线上 BUILD_ID `7Rwo7XAkwrIUNPHra8_bH` 已加载。
- 可复用经验：界面重构不是“新入口能用”就结束。旧入口、旧文案、旧路由、旧构建类型和前端包里的旧 UI 字符串都要一起清，否则用户看到的是几套产品逻辑混在一起。

## 2026-06-17 - 编辑面板不能藏在窄抽屉下方

- 问题/背景：用户反馈上下文卡片点击编辑没有反应，并指出编辑模板页面结构崩坏、太窄。
- 诱因/根因：模板编辑层仍沿用旧 `66.666vw` 抽屉；上下文卡片面板内部再分两栏，点击“编辑”后编辑面板被渲染在整个工作区下方，首屏几乎没有变化；同时整张卡片设置 `draggable`，按钮点击容易被拖拽行为干扰。
- 当时思路：先修结构根因，不做局部补丁。把编辑模板改成全屏工作台，桌面三栏展示卡片、最终提示词影响和编辑面板；拖拽只允许从手柄开始。
- 改动位置：`src/components/templates/TemplateContextCardsPanel.tsx`、`src/app/globals.css`。
- 怎么改：给工作区增加 `is-editing` 状态类；编辑时 CSS 使用 `minmax(520px, 1fr) 300px minmax(380px, 460px)` 三栏；中等屏幕回退单列；父级 `.template-drawer` 改为 `calc(100vw - 24px)` 宽和 `calc(100dvh - 24px)` 高；从 `article` 移除 `draggable`，改由 `.template-context-drag` 手柄触发。
- 验证结果：`tsc`、`git diff --check`、`npx impeccable detect`、`npm run lint`、`npm run build` 通过；线上 BUILD_ID `1iTUAlgQKwqQ7Qs9d_WaP` 已加载，生产包命中 `is-editing`、全屏宽度和拖拽手柄文案。
- 可复用经验：点击没反应不一定是事件没绑定，也可能是反馈出现在看不见或被挤压的位置。编辑类主任务不要塞进窄抽屉；涉及按钮和拖拽时，拖拽行为必须只挂在明确手柄上。

## 2026-06-17 - 模板编辑不能用全屏弹层冒充独立工作台

- 问题/背景：用户再次指出“现在这个页面怎么用”，要求先看清问题再重新规划。
- 诱因/根因：上一轮把窄抽屉撑成全屏后，仍然没有改变页面本质：`/admin/templates/[id]` 只是复用列表页组件，真正编辑仍藏在 `TemplateEditorDrawer` 弹层里；卡片列表、编辑器、图片绑定、LLM 对话、提示词预览全挤在一个组件中。
- 当时思路：先停止继续加宽旧抽屉，重新定义页面核心任务。模板编辑页应该是独立工作台，不是弹窗；桌面端第一屏就应看到可编辑上下文卡片、当前卡片编辑器和最终提示词影响预览。
- 改动位置：`tasks/todo.md`。
- 怎么改：新增“2026-06-17 纠偏：当前模板编辑页为什么仍然难用”，把 `/admin/templates/[id]` 独立详情页、空卡片保存闭环、卡片编辑器、图片绑定确认、最终提示词常显、真实登录验收重新列成 P0/P1/P2 任务；同时把误判完成的详情页和主工作区落点改回未完成。
- 验证结果：`git diff --check -- tasks/todo.md` 通过；独立浏览器和现有 Chrome 都只能看到登录页，无法作为管理员真实点击验收，已把登录态截图/录屏列入后续验收闭环。
- 可复用经验：页面重构不能只改尺寸。若用户说“怎么用”，先判断页面主任务、入口、信息层级、状态反馈和保存闭环；没有真实登录点击证据时，不能把线上包命中当成可用性完成。
- 后续修正：模板编辑桌面端应保持左右工作结构，侧边栏可以放当前卡片编辑栏；最终提示词影响是全局核对信息，放页面底部横向区域。不要把桌面工作台改成上中下三段式表单。

## 2026-06-17 - sd2 部署前必须确认真实线上源目录

- 问题/背景：图集共享功能先在 `/Volumes/Data/Projects/video-api-debugger` 落地并验证，但 `youdoo-sites status sd2` 显示线上实际运行目录是 `/Volumes/Data/Projects/video-api-debugger-v12-full-todo`。
- 诱因/根因：本机存在开发副本和线上源目录两个相似项目名；只在当前目录构建通过，不代表 `sd2.youdoodesign.com` 会加载这份代码。
- 当时思路：先通过 `youdoo-sites status sd2`、`sites.json` 和 LaunchAgent 确认真实部署目录，再把本轮精确改动同步到线上源目录，避免覆盖线上已有头像展示、模板系统等未提交改动。
- 改动位置：`src/components/ShareAlbumDialog.tsx`、`src/app/collections/[id]/ReferenceAlbumDetailClient.tsx`、`src/app/api/reference-images/[id]/share-album/route.ts`、`src/app/globals.css`、`tasks/todo.md`。
- 怎么改：共享弹窗复用现有项目、公共文件夹和公共投稿接口；单图共享先创建私有单图图集；部署目录只做精确增量补丁，不整文件覆盖。
- 验证结果：两个目录均通过 `npx tsc --noEmit --pretty false`；部署目录通过 `npm run lint`、`youdoo-sites build sd2`、`youdoo-sites restart sd2`、公网 `/api/config`、`/login`、新增 API 未登录 401、公共静态 chunk 新文案命中；70 秒后 `sd2` health 仍 OK 且 `runs` 未增加。
- 可复用经验：任何要上线到 `sd2.youdoodesign.com` 的 UI/API 改动，先确认 `youdoo-sites` 真实项目路径。当前编辑目录和线上源目录不一致时，只同步本轮精确改动，并用公网 API、静态 chunk 和跨健康周期 status 证明线上实例已加载新构建。

## 2026-06-18 - 无线画布输入框必须闭环到真实后端

- 问题/背景：用户反馈无线画布文本节点能输入，但点击生成并没有真正接上 LLM。
- 诱因/根因：静态画布已有输入框、按钮和 `CanvasGenerationAPI`，但没有配置真实 endpoint，默认退回 `mockGenerate` 占位；文本返回也没有写回节点内容。
- 当时思路：先用第一性原理拆分“能输入、能提交、真实调用、结果可见、线上可用”五层，再只补文本/脚本 LLM 链路，避免把未接点数和轮询的图片/视频生成伪装成已完成。
- 改动位置：`src/app/api/tools/ultimate-canvas/generate/route.ts`、`public/tools/ultimate-canvas/app.js`、`public/tools/ultimate-canvas/generation-api.js`、`public/tools/ultimate-canvas/canvas-engine.js`、`public/tools/ultimate-canvas/styles.css`。
- 怎么改：新增登录态保护的无线画布 LLM 接口，复用后台 Musk API 配置；前端把文本/脚本节点 endpoint 指到新接口；LLM 返回后写回节点正文；错误提示展示后端真实错误；模型标签从假模型名改为 `Musk LLM`。
- 验证结果：`tsc`、`lint`、`youdoo-sites build/restart/status sd2` 通过；本地和公网 POST `/api/tools/ultimate-canvas/generate` 均返回 `provider=musk`、`model=gpt-5.4` 和文本内容；线上静态资源命中新 endpoint、结果写回逻辑和 `Musk LLM` 标签；健康周期后 `runs` 未增长。
- 可复用经验：UI 上有输入框和按钮不代表功能闭环。生成类入口必须逐项验收：前端事件、真实后端 endpoint、鉴权、后台配置、上游返回、结果落点、错误提示、线上资源命中和跨健康周期稳定性。

## 2026-06-18 - 全量落地不能只按第一批闭环收口

- 问题/背景：用户要求无线画布正式版全量落地，但前一轮按批次完成后，只把第一批阶段闭环当成了可汇报节点，导致用户追问“为什么只落地了一部分”。
- 诱因/根因：把工程执行批次当成用户目标边界；同时 todo 中部分“已完成”项没有逐项反查代码，例如 bootstrap 文档写了账户点数但接口未返回点数、历史入口已接真实面板但菜单仍标待接入、首尾帧视频只自动取首帧没有取第二张尾帧。
- 当时思路：重新按第一性原理核对正式版成功标准：同一套后台、同一套项目/视频卡、同一套点数、同一套任务状态、同一套资产历史。只要其中一条链路有字段或入口断点，就不能用“批次完成”代替“全量完成”。
- 改动位置：`src/app/api/tools/ultimate-canvas/bootstrap/route.ts`、`src/app/api/tasks/create/route.ts`、`public/tools/ultimate-canvas/app.js`、`public/tools/ultimate-canvas/canvas-engine.js`、`public/tools/ultimate-canvas/index.html`、`public/tools/ultimate-canvas/styles.css`、`tasks/todo.md`。
- 怎么改：bootstrap 增加真实点数摘要；画布前端统一传无线画布 workspace key；首尾帧后端用第二张准备好的参考图作为尾帧；历史入口打开真实历史面板；默认模型文案改成 `gpt5.4`、`gmini 图形生成`、`默认视频 API`。
- 验证结果：本条为纠偏记录；最终验证以本轮 `tsc`、构建、部署、公网资源命中和健康周期复查为准。
- 可复用经验：用户说“全量落地”时，批次只是内部执行顺序，不是完成标准。最终汇报前要逐项反查 todo 的每个已完成项是否真的有代码字段、真实入口、线上验证和不能付费测试的明确边界。

## 2026-06-19 - 生成接入闭环要查到终态流水和真实引用图

- 问题/背景：用户再次要求把无线画布未做完的生成接入一次性全量落地，但不做真实视频生成调试。
- 诱因/根因：上一轮主要补了创建任务和前端入口，但生成接入的完整闭环还包括素材库引用图是否真正传进生成工作区、成功/失败终态流水是否继承来源、后台能否按来源筛选，而不只是任务创建时有 metadata。
- 当时思路：把“可提交”拆成“来源可识别、引用图可用、结果可追踪、流水可筛、UI 模式可选、线上可见”六个检查点，不跑付费生成也要把非付费接入层补完整。
- 改动位置：`src/app/api/tasks/create/route.ts`、`src/lib/video/task-finalizer.ts`、`src/app/api/admin/credits/ledger/route.ts`、`src/app/admin/points/AdminPointsClient.tsx`、`src/app/admin/points/page.tsx`、`public/tools/ultimate-canvas/app.js`、`public/tools/ultimate-canvas/canvas-engine.js`、`public/tools/ultimate-canvas/styles.css`、`tasks/todo.md`。
- 怎么改：无线画布来源统一写成 `source=ultimate_canvas` / `source_label=无线画布`；素材库参考图由后端校验权限后自动补挂 workspace；成功扣除、失败返还、创建失败返还流水继承任务来源；点数流水页支持来源筛选；图片节点补文生图/图生图/高清修复/首帧草图/尾帧草图模式按钮。
- 验证结果：本轮不执行真实付费视频生成；验收以 JS 语法、TypeScript、lint、build、API 未登录保护、公网页面资源命中和 sd2 健康周期复查为准。
- 可复用经验：生成接入不能只验“点了会创建任务”。正式闭环必须覆盖输入引用能不能真正进入后端、状态终态能不能追踪、点数冻结/实扣/返还能不能按来源查、后台列表能不能定位到来源；若用户禁止付费测试，要把未跑的真实生成验收单独标出来。

## 2026-06-19 - 模板卡片编辑不能让 LLM 暗箱覆盖最终内容

- 问题/背景：用户指出模板卡片编辑功能里不能有隐藏或不显示的内容；规则必须集中展示在折叠规则栏，不能出现不可控的生成内容。
- 诱因/根因：原卡片编辑页里，LLM 对话发送后会直接覆盖“最终输入给 LLM 的上下文内容”，管理员只能看到覆盖后的结果，看不到“生成草稿”和“应用确认”之间的边界；模板规则也没有在卡片编辑页集中展示。
- 当时思路：把 LLM 生成结果从“直接写入最终内容”改成“可见草稿”，管理员确认后才应用；把模板规则和本卡片规则统一放进规则栏，展开后完整显示。
- 改动位置：`src/components/templates/TemplateContextCardsPanel.tsx`、`src/components/templates/TemplateEditorDrawer.tsx`、`src/app/globals.css`。
- 怎么改：卡片面板接收模板规则并在规则栏逐条展示；LLM 改写只生成“LLM 生成草稿（未应用）”，提供“应用到上方内容”和“清空草稿”；切换卡片时清空未应用草稿，避免组件状态里残留当前页面不可见的生成内容。
- 验证结果：`git diff --check`、`./node_modules/.bin/tsc --noEmit --pretty false`、`npx impeccable detect ...`、`npm run lint`、`npm run build` 通过。
- 可复用经验：所有会进入最终提示词或影响 LLM 改写的内容都必须有明确可见位置。LLM 生成不能直接覆盖正式字段，必须先作为草稿展示，再由管理员确认应用。

## 2026-06-19 - 卡片编辑应作为模板页上的三级弹窗

- 问题/背景：用户明确指出卡片编辑页应该是独立的三级弹窗，而不是把模板详情页替换成另一个整页编辑界面。
- 诱因/根因：上一轮为了修复二级页位置，把 `/admin/templates/[id]/cards/[cardId]` 渲染成独立页面；这会让管理员离开模板卡片列表上下文，不符合“在模板页上弹出编辑当前卡片”的工作流。
- 当时思路：保留卡片编辑路由可达，但页面主体仍显示模板卡片工作台；当前卡片编辑器作为固定遮罩弹窗浮在上层，关闭后返回模板卡片列表。
- 改动位置：`src/components/templates/AdminTemplatesClient.tsx`、`src/components/templates/TemplateEditorDrawer.tsx`、`src/components/templates/TemplateContextCardsPanel.tsx`、`src/app/globals.css`。
- 怎么改：移除卡片路由的整页早返回；模板详情页始终渲染卡片列表；当 URL 带 `cardId` 时额外渲染 `template-card-modal-shell` 三级弹窗；关闭按钮和遮罩返回 `/admin/templates/[id]`；删除旧二级整页头部样式。
- 验证结果：`git diff --check`、`./node_modules/.bin/tsc --noEmit --pretty false`、`npx impeccable detect ...`、`npm run lint`、`npm run build` 通过。
- 可复用经验：工作流里的“编辑当前项”不一定应该独立成新页面。若用户需要保留父页面上下文，深层编辑应该用独立弹窗或抽屉覆盖，关闭后回到原列表位置。

## 2026-06-20 - 模板卡片编辑必须公开所有最终输入来源

- 问题/背景：用户澄清“规则全部显示”不是只把 rules 数组列出来，而是所有会影响最终输入给 LLM 的上下文内容都必须在卡片编辑里可见，包括标题、插入方式、启用状态、排序、绑定图片，以及旧模块名这类历史字段。
- 诱因/根因：上一轮只解决了 LLM 草稿和模板规则可见，但真实生成方案仍会读取旧 `module_bindings`；卡片标题也会进入管理页最终提示词影响预览，却没有明确标注“会写入最终输入”。
- 当时思路：先追真实生成链路，区分“直接进入最终提示词”“影响 Agent 方案”“只影响 LLM 改写”“仅用于保存归档”的字段，再把这些来源放回卡片编辑弹窗。
- 改动位置：`src/components/templates/TemplateContextCardsPanel.tsx`、`src/lib/agent-plans/template-plans.ts`、`src/app/globals.css`、`scripts/template-card-final-context-smoke.ts`。
- 怎么改：卡片编辑页新增“实际进入最终输入”预览；标题、启用、强制/参考、读取顺序、绑定图片都在编辑弹窗中可见；规则折叠栏新增影响来源说明；生成方案有上下文卡片时改用卡片内容，不再追加旧模块名。
- 验证结果：以本轮 `template-card-final-context-smoke`、TypeScript、lint、build、部署和公网资源命中为准。
- 可复用经验：凡是会影响 LLM 的内容，不能只在代码、旧字段、保存逻辑或生成逻辑里存在。编辑界面必须让管理员看到它、理解它会怎么生效，并能明确判断它是否直接进入最终提示词。

## 2026-06-20 - 模板卡片列表只做编排摘要，不能承载完整编辑内容

- 问题/背景：用户截图反馈模板上下文卡片列表再次崩版，正文、标题、强制/参考按钮、删除/启用/编辑按钮互相重叠。
- 诱因/根因：卡片列表同时展示完整正文、绑定图片长状态、模式按钮和右侧操作，且右侧操作列宽度过窄；列表承担了编辑页职责，内容长度稍变就会挤爆布局。
- 当时思路：从第一性原理拆分列表和编辑页职责。列表用于排序、选择、启用和查看摘要；完整内容、规则、LLM 改写和最终输入说明都进入三级弹窗。
- 改动位置：`src/app/globals.css`、`scripts/template-card-layout-smoke.ts`、`tasks/todo.md`。
- 怎么改：卡片行改为固定四区布局，拖拽、图片、内容摘要、操作区互不抢宽；正文在列表里只显示两行摘要；右侧操作区固定宽度；窄屏下操作按钮变为三列。
- 验证结果：以本轮布局 smoke、TypeScript、lint、build、部署和公网资源命中为准。
- 可复用经验：任何可拖拽列表都不能同时塞完整正文和完整编辑控件。列表必须有固定列、固定摘要高度、操作区固定宽度和窄屏断点，否则新增一个长字段就会复发崩版。

## 2026-06-20 - 模板规则必须变成可编辑正文，不要做第二规则面板

- 问题/背景：用户指出“规则全部显示”不是继续放在折叠区里展示，而是所有最终会影响 LLM 的规则都必须变成可编辑文本，直接写进“最终输入给 LLM 的上下文内容”输入框。
- 诱因/根因：之前把规则做成“规则与非最终输入来源”折叠区，虽然能看到，但它仍然是正文之外的第二来源；`template.rules` 也仍可能在生成链路里额外拼接，形成管理员编辑不到的隐藏影响。
- 当时思路：把规则来源收敛成一个模型：规则也是上下文卡片正文。旧结构化规则只允许用于首次生成“生成规则”卡片，之后不再作为最终提示词的独立输入。
- 改动位置：`src/components/templates/TemplateContextCardsPanel.tsx`、`src/components/templates/TemplateEditorDrawer.tsx`、`src/lib/templates/workbench.ts`、`src/lib/agent-plans/template-plans.ts`、`src/app/globals.css`、`scripts/template-rules-editable-text-smoke.ts`。
- 怎么改：删除规则折叠区和隐藏 LLM 参考入口；旧 active rules 序列化为“生成规则”卡片正文；有上下文卡片时生成方案不再读取 `template.rules`；LLM 改写只接收卡片标题、当前正文和管理员输入。
- 验证结果：以本轮 smoke、TypeScript、lint、build、部署和公网验收为准。
- 可复用经验：模板卡片编辑页只能有一个最终输入来源：可编辑正文。标题、图片、强制/参考和启停可以作为明确 UI 开关存在；规则内容不能再放在独立折叠区、旧数组、隐藏参考字段或任何管理员改不到的地方。

## 2026-06-20 - 画布节点的 LLM 上下文规则要同时有 UI 和后端权限

- 问题/背景：用户指出无线画布文本节点只有 LLM 生成入口，缺少能影响最终上下文的规则编辑能力，并要求暂时只给管理员开放。
- 诱因/根因：无线画布节点只有 `prompt` 和来源节点会进入生成 payload，缺少节点级规则字段；如果只在前端隐藏按钮，普通用户仍可能伪造请求字段。
- 当时思路：把规则作为文本节点数据的一部分保存到 `node.data.contextRules`，入口放在 LLM 模型旁边，保持画布流轻量；后端只在 `user.role === 'admin'` 时把规则写入 LLM 上下文。
- 改动位置：`public/tools/ultimate-canvas/canvas-engine.js`、`public/tools/ultimate-canvas/app.js`、`public/tools/ultimate-canvas/styles.css`、`src/app/api/tools/ultimate-canvas/generate/route.ts`、`scripts/ultimate-canvas-context-rules-smoke.ts`。
- 怎么改：文本节点底部新增管理员可见“规则”按钮；弹窗编辑规则文本并触发画布自动保存；生成 payload 带 `contextRules`；后端将管理员规则作为高优先级上下文写入 LLM 请求，非管理员伪造字段会被忽略并记录。
- 验证结果：以本轮 smoke、JS 语法检查、TypeScript、lint、build、部署和公网资源验收为准。
- 可复用经验：任何“只给管理员开放”的上下文、规则、提示词能力都不能只靠前端隐藏。前端负责入口和体验，后端负责是否真正应用，日志要能区分已应用和被忽略。

## 2026-06-20 - 图集上传不能被个人素材归属拦截

- 问题/背景：参考图集详情页上传别人已经传过的同一张图片时，页面提示“联系管理员开放共享”，但用户真实目标是先把图片贴进当前图集。
- 诱因/根因：图集页上传走的是“先上传到个人历史素材，再绑定到图集”的两步流；个人素材层按 `Asset.hash` 去重并阻止跨用户复用，导致图集绑定步骤根本没有执行。
- 当时思路：拆开两种业务语义。个人历史素材仍保持归属限制；图集上传是用户本地选择同一二进制文件后创建图集图片，允许只复用已有后台内容链接。
- 改动位置：`src/app/collections/[id]/ReferenceAlbumDetailClient.tsx`、`src/app/api/reference-albums/[id]/images/route.ts`、`scripts/reference-album-duplicate-upload-smoke.ts`。
- 怎么改：图集页直接 multipart 提交到当前图集图片接口；后端先算文件 hash，命中已有图片资产则创建新的 `ReferenceImage` 并复用旧 `asset_id/original_url/thumbnail_url`，未命中才走 `uploadSiteAsset`。
- 验证结果：`reference-album-duplicate-upload-smoke`、`reference-album-duplicate-upload-integration`、`git diff --check`、`tsc`、`lint`、`build` 通过；已部署 BUILD_ID `QxmU9C1GexK7-UVnz4RvH`，公网 `/api/config`、`/login` 和生产包关键字符串命中，健康周期后 `runs=36` 未增长。
- 可复用经验：同一个文件去重规则不能替代业务动作。图集、工作台、个人历史素材是不同使用场景；跨用户 hash 命中时，应在具体入口决定是阻止、复制引用，还是复用内容链接。

## 2026-06-20 - 无线画布管理员规则入口不能藏在选中态面板里

- 问题/背景：用户刷新登录后的无线画布页后，在文本节点底部看不到预期的“规则”按钮。
- 诱因/根因：规则按钮已经写进文本节点，但被放在 `.node-input-bar` 里；这个输入栏默认只有节点被选中时才显示，所以刷新后管理员很容易看不到入口。另外入口 HTML 没有给静态脚本加版本号，线上刷新时也容易受旧资源缓存影响。
- 当时思路：把“管理员需要一眼看到的规则入口”和“选中后展开的 LLM 输入栏”分开。规则入口应该在文本卡片本体底部可见，输入栏里可以保留同一能力作为补充入口。
- 改动位置：`public/tools/ultimate-canvas/canvas-engine.js`、`public/tools/ultimate-canvas/app.js`、`public/tools/ultimate-canvas/styles.css`、`public/tools/ultimate-canvas/index.html`、`scripts/ultimate-canvas-context-rules-smoke.ts`。
- 怎么改：文本节点卡片底部新增管理员可见的 `规则` 按钮；刷新按钮状态时同步更新同一节点里的所有规则按钮；入口 HTML 给 `styles.css`、`canvas-engine.js`、`app.js` 加版本号；smoke 检查覆盖卡片底部入口和版本号。
- 验证结果：JS 语法、规则 smoke、TypeScript、lint、Next build、`youdoo-sites build/restart`、本地/公网 `/api/config` 与 `/login` 均通过；lint 仅保留项目既有 img/hook 警告。
- 可复用经验：用户说“刷新后应该看到某按钮”，不要只检查 DOM 是否存在，还要检查父级是否在默认态隐藏。管理员常用入口不能依赖 hover、selected、折叠面板或旧静态资源缓存才能出现。

## 2026-06-21 - 绑定图片选择窗口必须能直接上传并完成绑定

- 问题/背景：用户在模板卡片编辑页指出，选择绑定图片的窗口需要有上传图片功能按键。
- 诱因/根因：绑定图片弹窗只提供“参考图集”和“历史上传图”两种已有素材来源；如果当前图片还没上传，管理员必须离开当前编辑流去别处上传，再返回绑定，链路不闭环。
- 当时思路：这个窗口的目标不是素材管理，而是给当前卡片绑定 1 张图片，所以上传动作应直接完成绑定，按钮文案明确为“上传并绑定图片”。
- 改动位置：`src/components/templates/TemplateBoundImagePicker.tsx`、`src/app/globals.css`、`scripts/template-bound-image-upload-smoke.ts`。
- 怎么改：弹窗内加入隐藏 file input 和 footer 上传按钮；调用既有 `/api/assets/upload`，上传成功后用返回的 `asset.id/originalUrl/thumbnailUrl/fileName` 写入卡片 `bound_image`，来源标记为 `upload_history`，并切到历史上传图语义。
- 验证结果：以本轮上传入口 smoke、TypeScript、lint、build、部署和公网资源验收为准。
- 可复用经验：选择窗口如果承担“绑定/引用”决策，就不能只展示已有项。遇到素材缺失时，应在同一窗口提供最短上传路径，并让上传结果直接进入当前业务对象。

## 2026-06-21 - 模板卡片最终提示词只读可编辑正文

- 问题/背景：用户重新澄清模板模块卡片关系：模块需求写进需求框，管理员调整“最终输入给 LLM 的上下文内容”，最后由这两个明示输入推导 LLM 生成草稿。
- 诱因/根因：上一轮为了“公开所有来源”，把卡片标题、绑定图片标签、模板旧 rules、旧 prompt blocks、模板素材统计等都放进了生成链路或预览；虽然界面能看到一部分，但它们不是用户期望的上下文正文，仍会造成“没写进上下文框却影响结果”的感觉。
- 当时思路：把文本来源收敛成一个硬规则：最终影响 LLM 的正文只来自卡片 `content` 和管理员需求 `intent`。标题、绑定图片、模板名、旧 rules/prompts/assets 只能做管理、排序、素材绑定或首次迁移，不得直接拼入最终提示词或模块草稿输入。
- 改动位置：`src/components/templates/TemplateContextCardsPanel.tsx`、`src/components/templates/TemplateEditorDrawer.tsx`、`src/lib/templates/module-builder.ts`、`src/app/api/templates/module-builder/generate/route.ts`、`src/lib/agent-plans/template-plans.ts`、`src/app/api/templates/[id]/context-cards/route.ts`。
- 怎么改：卡片最终输入预览只显示模式和正文；卡片名称改成管理字段；卡片 LLM 改写只传管理员需求和当前正文；Module Builder 用户消息移除隐藏模板 rules/assets/prompts；真实生成方案只拼卡片正文；保存卡片时清空旧 rules 且不保留无对应卡片的旧 prompt blocks。
- 验证结果：以本轮可见输入 smoke、卡片最终上下文 smoke、规则文本 smoke、TypeScript、lint、build、部署和公网验收为准。
- 可复用经验：当用户要求“所有影响最终提示词的内容都在输入框里”，不要把“界面某处可见”理解成合格。最终文本来源必须能从同一个可编辑正文框逐字追溯；管理标题、素材标签、历史结构化字段都不能偷跑进 LLM prompt。

## 2026-06-26 - 视频播放卡顿先查分发链路

- 问题/背景：用户反馈生成完成后任务页、视频预览、单个下载和二次批量下载都很卡。
- 诱因/根因：视频虽然已经缓存到本机 `public/videos`，但公网仍经 `sd2.youdoodesign.com`/Cloudflare Tunnel 从本机发给用户；缩略图浏览还可能触发完整 mp4 缓存；批量 ZIP 对 mp4 使用高压缩等级。
- 当时思路：不要先做 HLS、播放器替换或转码。第一性原理是“视频字节从哪里发给用户”，先把 mp4 从本机隧道分发改为对象存储/R2 优先分发。
- 改动位置：`prisma/schema.prisma`、`src/lib/video/public-delivery.ts`、`src/lib/video/task-finalizer.ts`、`src/app/api/video/play/[id]/route.ts`、`src/app/api/video/thumbnail/[id]/route.ts`、`src/app/tasks/[id]/page.tsx`、`src/lib/video/bulk-download.ts`。
- 怎么改：`VideoTask` 增加 public video 字段；成功任务本地缓存后转存 R2/TOS；播放 API 优先 302 到 `public_video_url`；任务详情/资源页优先使用 public URL；缩略图浏览不再下载完整 mp4；批量 ZIP 对 mp4 改为不压缩。
- 验证结果：规则脚本、backfill dry-run、TypeScript、lint、build 通过；R2 已小批量补偿 5 个任务且公网 `/api/video/play/:id` 已 302 到 R2。R2 dev 域名 Range 速度仍波动偏慢，需要后续评估 R2 自定义域/CDN 或 TOS 国内可访问域名。
- 可复用经验：视频“卡”大多不是 UI 播放器问题，而是分发路径问题。先测本机、站点 API、静态路径、对象存储 URL 的同一 Range 片段，再决定是改代码、换存储域名，还是做转码/HLS。
