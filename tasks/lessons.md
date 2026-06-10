# Lessons

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
- 可复用经验：素材引用类需求不能只做 UI 文案；必须保证 prompt 标记、workspace 素材顺序和提交参数一致。官方主格式使用 `@图片N` / `@图片 N`，旧的 `@图N` / `图N` 只能作为兼容输入，不应作为主 UI 文案。跨图集选择属于下一阶段能力，不应混入当前素材轻量版。
