# V1.2 剩余模块落地 Todo

## 当前入口

- [ ] 2026-09-29：模板工作台0.20.0已发布。后续0.20.1重做目录遭用户拒绝，已回退0.20.0；该候选与回退记录保留分支`codex/template-studio-20260929`（4bb7398），不得随本轮修复重发。正确目标是保留图片生成原结构，只在侧栏增加视频大类及折叠小类；共享项进入原列表，但不得公开内部上下文。该布局任务暂缓。
- [ ] P1：旧共享模板列表、套用副本和模块DTO仍可能返回内部context，回退不代表保密修复；模板管理的external+admin访问边界也存在既存契约失败。两项不属于P01手势修复，保持待办，不称安全闭环。

## P01 图片拖动误关闭（2026-09-29）

| 编号 | 任务 | 完成标准 | 状态 |
|---|---|---|---|
| P01 | 修复图片拖动误关闭 | 放大后拖动不关闭，正常关闭操作保留，上线验证 | 受阻：修复已上线，本地实测通过；线上真实拖动复验未完成 |

- 从正式a9d913c/0.20.0建立`codex/image-preview-drag-20260929`，不带入撤回目录。候选0.20.2，保留0.20.0回退构建和代码，不改DB、模板字段或模型调用。
- 根因：共享ZoomableImagePreview在stage捕获pointer，松手后的click可能指向stage，原处理仅按target等于currentTarget就关闭，误把拖动判作背景点击；单图和对比面板共用此链路。
- 最小修正：记录手势起点/移动及取消状态，抑制拖动后的关闭，普通背景点击、Esc、关闭按钮继续有效。保持原缩放、对比、导航、布局与内容边界，不替换库。
- 复用现有组件和Pointer Events，不新增依赖；依据[MDN pointer capture](https://developer.mozilla.org/en-US/docs/Web/API/Element/setPointerCapture)与[W3C事件派发](https://www.w3.org/TR/pointerevents3/#event-dispatch)。固定审核检查手势与范围；完整代码/测试写齐后统一验收。隔离真实浏览器拖动覆盖旧版失败、新版不关闭、背景关闭、对比、取消/丢失捕获与键盘退出，随后生产构建及线上相同动作验收。
- 隔离Chrome真实组件测试：`BASELINE_REF=a9d913c`在放大后从图片拖至背景时复现关闭（退出1，`/tmp/sd2-p01-baseline.log`）；相同脚本测试当前组件退出0（`/tmp/sd2-p01-browser.log`），验证移位后仍打开、随后背景轻点能关、图片本体轻点不关、Esc/关闭按钮、横/纵双图拖动均通过。只有合成图片，外网HTTP/Provider调用0。`node --import tsx scripts/image-studio-ui-smoke.ts`通过；此旧静态检查不代表上下文权限已修复。
- 固定审核001静态复核通过，没有阻塞问题或布局越界；pointercancel/lostcapture与其他pointer结束按ID隔离已读代码，未冒充真实触摸/取消事件实测。测试harness复用已安装esbuild和Playwright，不安装依赖；`npx tsc --noEmit`、`npm run lint`通过（lint仅既存img警告）。
- 2026-09-29发布：产品提交`f2f65588875f6672bdbee611489d991b0c53b826`和`rollback/2026-09-29-before-preview-drag`已推送核对；归档SHA256 `f7e9281f2efae1eb684e4632b7bd5c557277b7d67b2dd2f4a1d005a9a2401b27`服务器一致。隔离数据库副本候选构建通过，正式v0.20.2 / BUILD_ID `_9fK7s3pg8k4-7e-q5XCD`；三服务active，源站/public config、release、login 200，登录页13/13静态资源200。图片studio原页面源码与0.20.0逐字节一致，数据库schema未改、媒体未覆盖，保留服务器`backups/image-preview-drag-f2f65588875f6672bdbee611489d991b0c53b826/live-build`回退。
- 更新通知沿用已有ReleaseNotice及唯一package版本来源，未重写提醒；真实旧客户端升级弹窗未在本次重新验证。线上独立登录态页已恢复连接：DOM版本0.20.2，预览dialog打开、图片加载、缩放transform为scale(1.2)，22个静态JS请求200。线上真实拖动复验仍受阻：bsk不支持真实drag，native CUA受用户无关保存窗口阻挡，独立tab重新连接仍超时，未操作或关闭用户窗口。不以本地测试冒充线上鼠标实测；待浏览器可控或用户刷新实测后补齐最后证据。

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
- `tasks/todo/2026-09-29-unified-image-video-template-workbench.md`：图片与视频模板工作台：上下游闭环规划
- `tasks/todo/wallverse-audio-20260715.md`：WallVerse 第一组「世界迁移」声音闭环
