# 后台趋势图展示重做

## 1. 大白话目标复述

后台趋势图现在很丑，关键数值互相盖住，用户看不清每周/每日到底生成了多少、花了多少、哪些周期待确认。
这次要用成熟开源图表展示方式替换手写挤压图：页面打开后先看到清晰摘要，再看趋势，再看每个周期明细；数值不能遮挡，内容不能显示不全，刷新线上页面必须能看到新效果。

## 2. 具体可执行任务

- [x] T1. 开源方案确认与接入边界
  - 检查对象：Recharts / shadcn charts / Tremor 的许可证、依赖和展示模式。
  - 完成标准：选择能接入当前 Next.js + React 项目的方案，避免整套 UI 框架迁移。
- [x] T2. 替换后台趋势图结构
  - 修改文件：`src/app/admin/AdminGenerationDashboardClient.tsx`、`src/app/globals.css`。
  - 完成标准：移除会互相遮挡的大号 SVG 标签；趋势图改为清晰图表 + hover 明细 + 周期明细列表。
- [x] T3. 保留完整信息
  - 完成标准：生成次数、生成秒数、官方额度、待官方确认和零值周期都可见；信息放在摘要、tooltip 和明细里，不再只藏在图形里。
- [x] T4. 补回归检查
  - 修改文件：`scripts/generation-dashboard-trend-layout-smoke.ts` 或同类 smoke 脚本。
  - 完成标准：能检查新图表入口、依赖、无旧遮挡标签、明细仍保留完整口径。
- [x] T5. 构建、部署、线上验证
  - 完成标准：本地类型/ lint / build 通过；`youdoo-sites build sd2` 和 restart 通过；公网 `/admin` 对应新构建可见。
- [x] T6. 按用户反馈改为双柱状图
  - 修改文件：`src/app/admin/AdminGenerationDashboardClient.tsx`、`src/app/globals.css`、`scripts/generation-dashboard-trend-layout-smoke.ts`。
  - 完成标准：趋势图不再使用金额折线；每个周期并排显示金额柱和视频条数柱；两种柱子顶部都直接显示具体数值。

## 3. 验收/审查内容

这些审查项需要创建独立子 agent 做只读审查；审查 agent 不改文件、不提交、不补实现，只判断是否达标、证据是否充分、风险是否遗漏，并输出“通过 / 不通过、证据、缺口、风险、下一步”。

- [ ] R1. 只读 UI 审查
  - 检查对象：`/admin` 趋势区截图/DOM、`AdminGenerationDashboardClient.tsx`、`globals.css`。
  - 通过标准：图表数值不重叠；明细内容可完整查看；移动端和窄屏不把信息挤丢。
  - 证据来源：真实页面截图或 DOM 检查、相关源码；环境支持时交给固定审核线程 `审核001 - sd2 固定只读审查`。
- [x] R2. 只读数据口径审查
  - 检查对象：趋势 bucket 渲染逻辑、summary、tooltip、周期明细。
  - 通过标准：生成次数、生成秒数、官方额度、待官方确认、零值都没有被删除或伪造；双柱状图顶部能直接看到金额和视频条数。
  - 证据来源：smoke 脚本、源码检查、页面实际文本。已通过 `npx tsx scripts/generation-dashboard-trend-layout-smoke.ts`、`npx tsc --noEmit --pretty false`、`npm run lint -- --file src/app/admin/AdminGenerationDashboardClient.tsx`、`npm run build`；双柱图二次调整后再次通过 smoke。
- [x] R3. 只读上线审查
  - 检查对象：生产构建 ID、公网资源、`/api/config`、`/login`、`sd2` 服务状态。
  - 通过标准：线上加载的是本次新构建，健康守护周期后服务没有反复重启。
  - 证据来源：`youdoo-sites`、`curl`、生产静态资源检查。已验证 BUILD_ID `gxk2sMFwwiQfEWZcpdKcV`，公网 CSS 含新趋势图类名，健康周期后 `runs=3` 未增长。

## 4. 审查内容是否对齐目标

- [x] A1. 审查项对齐检查
  - 判断：R1/R2/R3 覆盖“好看、直观、显示完整、真实上线”四个目标，不把代码通过误报成页面已好用。
  - 结论：R1 仍需真实登录态视觉截图补强；本轮不把源码检查冒充最终视觉验收。
