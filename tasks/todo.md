# V1.2 剩余模块落地 Todo

## 当前入口

- [ ] P1 / 2026-09-28 Seedance 2.5普通生成4–30秒：当前用户在三国全动作试验明确授权同步修改共享平台。线上97d48e8/v0.16.0为起点，独立工作树`worktrees/seedance25-duration30-20260928`、分支`codex/seedance25-duration30-20260928`，保留其他工作树脏改；v0.17.0已被未发布动画工作台候选占用，本次候选v0.18.0，不合入工作台功能。核对线上未变化后聚焦推送、回退点、候选构建、发布及真实页面验证；失败不切换线上。
  - 范围：模型感知时长单一规则，类型/普通创建/provider/估价/配置/下拉/偏好/复用/文档及Draft防少计时；2.0/IP/H3维持15，费率不变。Codex估价复用真实认证，普通web权限不扩大。参考输入逐条15及edit试点均不放宽；无线画布保留默认2.0入口，能力表按模型另列，不宣称画布可选2.5。无DB迁移、依赖变更或管理员生成。
  - 依据：[官方2.5模型页](https://seed.bytedance.com/zh/seedance2_5)30秒能力；既有`seedance-models.ts`注册表、`pricing.ts`/`pricing-client.ts`3×1.5/秒、mock provider脚本，复用已有实现不引新包。实际上游30秒/两段参考总30接受与否必须由授权真实试验另证，非本地mock证明。
  - 统一验证：修改整批完成后跑duration/model/edit/reference/draft/preference关联smoke、tsc/lint/build；严格检查3/4/15/16/30/31、小数/字符串、模型/provider隔离、135积分一致与cap134拒绝、两参考顺序。UI检查选2.5→30→切回2.0保留值但禁止提交、偏好/复用不丢模型；复用ReleaseNotice更新通知，不另造机制。
  - 固定审核为`019f44c6-64d3-7753-acd0-f31fc16763fb`，当前工具缺任务消息入口；未提交，不能用内部执行回执冒充。三国媒体审核另归其审核01。
  - 2026-09-28统一本地检查：新增duration及model/edit/draft/upload/provider-error共6项通过，TypeScript未报错，构建完成。reference-media-resolution-guard在`fillMissingAssetDimensions`源码断言失败、IP模型smoke在旧`VolcengineIpModelOption`类型名断言失败，两者已在未改的97d48e8工作树复现；不删断言假装全绿，不在本任务重写上传或IP模型。嵌套worktree导致ESLint读入父仓配置冲突，补本仓`.eslintrc.json`的`root:true`隔离；无规则关闭、依赖升级。待复测lint/tsc、服务器候选构建及页面确认。
  - F1素材任务、原件与批准身份图、全216条/1340ticks统计、费用授权及产物入口见`/Volumes/Data/Projects/三国/tasks/work-order-guanyu-replacement.md#f1-全动作长片识别与复刻试验2026-09-28`。本地代码/线上能力/真实生成/视觉复刻四层分别验收，不因时长入口完成即关闭F1。

- [ ] 2026-09-22：Seedance 2.5 Draft 到 1080p 直出，正文见 `tasks/todo/2026-09-22-seedance-draft-1080p.md`。

## 最近状态

- 2026-07-28：原主 todo 完整迁移到 `tasks/todo/archive-2026-07-28-main.md`；备份见 `tasks/todo/backups/todo-20260728-232548.md`。
- 迁移前大小：7667 行，546944 字节。未直接删除原文内容。

## 历史归档索引

- `tasks/todo/archive-2026-07-28-main.md`：主 todo 瘦身前完整原文，7667 行，546944 字节。

## Todo 子文档索引

- `tasks/todo/2026-07-29-audio-upload.md`：音频素材上传统一链路
- `tasks/todo/2026-07-29-share-button-fix.md`：分享按钮失效修复
- `tasks/todo/2026-08-03-admin-dashboard-trend-redesign.md`：后台趋势图展示重做
- `tasks/todo/2026-08-05-upload-root-cure.md`：上传链路根治收口
- `tasks/todo/2026-08-07-reference-media-resolution-guard.md`：参考素材分辨率提交前拦截
- `tasks/todo/2026-08-07-stuck-video-polling-status.md`：长任务状态卡住修复
- `tasks/todo/2026-08-07-upload-provider-rules.md`：上传限制分层与生成准入收口
- `tasks/todo/2026-08-08-asset-library-integrity.md`：资产管理失败项、缩略图与用户归属彻查修复
- `tasks/todo/2026-08-11-sd2-video-download-delivery.md`：提交生成到稳定下载就绪优化
- `tasks/todo/2026-08-12-admin-cost-audit-p2029.md`：后台成本审计 P2029 崩溃修复
- `tasks/todo/2026-08-12-sd2-server-migration.md`：sd2 从 Mac 迁移到服务器闭环计划
- `tasks/todo/2026-08-13-assets-interaction-performance.md`：2026-08-13 资产管理页面切换与点击卡顿优化
- `tasks/todo/2026-08-13-seedance-25-video-model.md`：Seedance 2.5 视频模型线上接入规划
- `tasks/todo/2026-08-15-h3-api-integration.md`：H3 API 接入现有视频生成链路
- `tasks/todo/2026-08-15-stable-video-thumbnails.md`：视频截图稳定固化与历史补偿
- `tasks/todo/2026-08-16-h3-lora-selector.md`：H3 LoRA 下拉选择闭环
- `tasks/todo/2026-08-16-reliable-task-thumbnails.md`：任务卡片缩略图可靠显示修复
- `tasks/todo/2026-08-16-seedance-25-pricing-multiplier.md`：Seedance 2.5 按 2.0 的 1.5 倍扣费
- `tasks/todo/2026-08-22-external-access-guard.md`：外部用户权限收口与风险闭环
- `tasks/todo/2026-09-15-credit-applications.md`：积分申请与飞书审批
- `tasks/todo/2026-09-16-reference-picker-selection.md`：参考素材选择入口修复
- `tasks/todo/2026-09-19-assets-bulk-download.md`：资产管理批量下载无反馈
- `tasks/todo/2026-09-20-gpt-image-studio.md`：GPT Image 独立生图页与固定上下文
- `tasks/todo/2026-09-22-canvas-toolflow.md`：画布工具流基础能力
- `tasks/todo/2026-09-22-seedance-draft-1080p.md`：Seedance 2.5 Draft 到 1080p 直出
- `tasks/todo/wallverse-audio-20260715.md`：WallVerse 第一组「世界迁移」声音闭环
