# 资产管理失败项、缩略图与用户归属彻查修复

## 1. 大白话目标复述

资产管理页现在把失败任务、没有可用截图的视频素材、缺 owner 展示的上传素材混在一起，用户扫列表时会误以为资产坏了或不知道是谁的内容。本轮要先用只读数据确认根因，再把主视图改成默认看可用资产，视频素材没有截图时不再用 mp4 冒充图片，上传素材也要能显示所属用户。完成标准是 `/assets` 刷新后默认不再铺满失败卡片，视频素材没有截图时显示稳定占位，管理员按用户查看不会把正常 Asset 全部归到“未知用户”。

## 2. 具体可执行任务

- [x] T1. 根因取证
  - 检查对象：`prisma/dev.db` 只读查询、`src/app/api/assets/library/route.ts`、`src/app/assets/page.tsx`、`src/app/api/video/thumbnail/[id]/route.ts`。
  - 完成标准：分别确认失败项、截图不可用、未知用户来自哪条数据链路，不凭页面感觉下结论。

- [x] T2. 资产页默认只看可用结果
  - 修改文件：`src/app/assets/page.tsx`、`src/app/api/assets/library/route.ts`。
  - 做法：普通资产视图默认 `succeeded`，`all` 保留为显式筛选；上传成功刷新后也回到可用资产视图。
  - 完成标准：默认请求不会返回失败和取消任务，用户仍可手动选择“全部状态”或“失败”排查问题。

- [x] T3. 修复视频素材截图误用
  - 修改文件：`src/app/api/assets/library/route.ts`。
  - 做法：图片 Asset 才用 `original_url` 兜底缩略图；视频/音频 Asset 没有 `thumbnail_url` 时返回空缩略图，由前端显示稳定状态占位。
  - 完成标准：上传视频素材不会再把 mp4 URL 放进 `<img>` 导致坏图。

- [x] T4. 修复 Asset 用户归属
  - 修改文件：`src/app/api/assets/library/route.ts`。
  - 做法：`loadAssetItems` 批量按 `owner_id` 查询 User 并传入序列化；找不到用户行的旧 `default-user` 显示为“历史默认用户”，其他缺失用户显示“用户资料缺失”。
  - 完成标准：管理员按用户分组时，正常上传素材按真实用户归类，历史遗留素材不再显示“未知用户”。

- [x] T5. 补回归检查
  - 修改文件：`scripts/assets-library-performance-smoke.ts` 或新增同类轻量脚本。
  - 完成标准：检查默认状态、Asset 视频缩略图兜底、Asset owner 查询规则，防止后续改回。

- [x] T6. 验证与部署
  - 命令：`npm run lint`、相关 smoke、`/Users/gouki-youdoo/.youdoo/bin/youdoo-sites build sd2`、`restart sd2`、公网 `/api/config` 验证。
  - APP 浏览器验收：必须直接在 Codex APP 内置浏览器打开 `https://sd2.youdoodesign.com/assets`，以 APP 浏览器可见页面/DOM 为最终页面证据；Chrome 或脚本只能作为辅助证据。
  - 完成标准：本地测试通过，线上新构建加载，APP 浏览器资产页可见新行为。
  - 验证结果：`npx tsx scripts/assets-library-performance-smoke.ts`、`npx tsx scripts/thumbnail-pipeline-smoke.ts`、`git diff --check`、`npm run lint` 已通过；公网 `/login` 和 `/api/config` 为 200，`/login` 已加载构建 `C_TBr-DfrbupykKAPjkFY`；APP 内置浏览器已打开 `/assets`，页面显示资产管理、默认筛选为“已完成”，首屏卡片无失败项，视频素材显示“视频素材”占位，人物归属可见。

## 3. 验收/审查内容

这些审查项需要创建独立子 agent 做只读审查；审查 agent 不改文件、不提交、不补实现，只判断是否达标、证据是否充分、风险是否遗漏，并输出“通过 / 不通过、证据、缺口、风险、下一步”。

- [x] R1. 数据根因审查
  - 检查对象：只读 SQL 输出、API 序列化逻辑、缩略图接口逻辑。
  - 通过标准：能解释为什么会看到失败卡片、坏截图和未知用户，且每个结论都有代码或数据证据。
  - 证据来源：`sqlite3 -readonly prisma/dev.db ...`、相关源码片段。
  - 审查结果：只读审查确认默认状态、状态筛选隔离、缩略图来源和 owner 兜底均有代码与运行证据支撑。

- [x] R2. 功能回归审查
  - 检查对象：APP 浏览器里的 `/assets` 页面、`/api/assets/library` 默认请求、`status=all` 显式请求、Asset 视频 item、Asset owner item。
  - 通过标准：APP 浏览器默认不混入失败任务；显式 `all/failed` 仍可查；视频素材没有坏图 URL；owner 不丢。
  - 证据来源：测试命令、构建日志、公网 API、APP 内置浏览器页面 DOM/截图。
  - 审查结果：APP 内置浏览器已打开 `/assets` 并读到真实页面 DOM；默认筛选为“已完成”，首屏卡片无失败项，视频素材占位和人物归属符合预期。

- [x] R3. 独立只读审查
  - 检查对象：本轮 diff、测试输出、部署验证输出、APP 浏览器真实页面。
  - 通过标准：审查 agent 不改文件、不提交、不补实现，只输出通过/不通过、证据、缺口、风险和下一步。
  - 替代方式：如果子 agent 工具不可用，由主线程按同一清单只读复查，不能改文件；该结果不是独立审查，可信度低于子 agent。
  - 审查结果：独立只读审查 agent 判定通过；无阻塞缺口，风险仅为 smoke 主要是静态字符串检查，但已由公网 API 和 APP 浏览器真实 DOM 补足运行证据。

## 4. 审查内容是否对齐目标

- [x] A1. 审查项对齐检查
  - 判断：R1 覆盖根因，R2 覆盖用户可见行为，R3 覆盖独立性和遗漏风险；三项合起来能证明“失败项、截图、未知用户”都被闭环，而不是只检查代码是否编译。
  - 结果：已对齐。本轮闭环覆盖根因、代码、回归、部署、APP 浏览器和独立审查。
