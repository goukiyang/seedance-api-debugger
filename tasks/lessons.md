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

## 2026-06-13 - 1080p 项目生成审批必须前后端双闸

- 问题/背景：非个人项目的 1080p 生成会直接影响团队成本，需要在生成前显式确认审批，且复用/重试不能绕过该确认。
- 诱因/根因：如果只在前端展示提示，API 直调仍可能创建 1080p 项目任务；如果只在后端拦截，用户不知道为什么无法提交。
- 当时思路：前端在非个人项目 + 1080p 时显示确认复选框并禁用提交；后端 `/api/tasks/create` 再按项目类型和分辨率硬拦截；复用/重试草稿保留确认状态，避免参数丢失。
- 改动位置：`src/components/GenerationComposer.tsx`、`src/app/generate/page.tsx`、`src/app/api/tasks/create/route.ts`、`src/app/api/tasks/[id]/reuse/route.ts`、`src/app/api/video/retry/[id]/route.ts`、`src/app/globals.css`。
- 怎么改：提交参数新增 `resolution_approval_confirmed`；非个人项目 1080p 未确认时前端阻断并禁用按钮；后端创建任务前返回 403；任务 params 快照记录 `resolutionApprovalConfirmed`，复用/重试草稿带回该字段。
- 验证结果：`git diff --check`、`npx tsc --noEmit --pretty false`、`npm run lint`、`npm run build` 通过；本地 3100 浏览器验收团队项目切到 1080p 时确认框出现且未勾选禁用提交，勾选后提交按钮恢复，切到 720p 后确认框消失；未触发真实生成。
- 可复用经验：涉及成本或权限的生成限制必须“UI 可解释 + API 强制”，并把复用、重试、草稿恢复一起纳入同一条参数链路。

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
