# V1.2 剩余模块落地 Todo

更新时间：2026-06-18

来源：`/Volumes/Data/Downloads/Current/AI视频生成项目成本管理系统需求文档_完整细项版V1.2.md`

最新验收结论：整份 V1.2 仍未完整落地。当前代码已经有视频卡 P0 归档入口、公共项目预算底座、审批记录表、审批中心页面、1080p 基础校验、新建项目“默认记账 / 预算记账”选择入口，但这些还没有形成完整业务闭环。后续执行必须以本 todo 为准，不得把“有模型/有页面/有审批记录”误判为“业务已闭环”。

## 2026-06-26 火山 IP API 整合页配置入口

目标：把火山 IP 生成 API Key / Model ID 填写入口放进现有 `/admin/integrations` API 设置页，不放到普通生成页，不触碰现有普通生成和扣点链路。

- [x] 新增火山 IP 生成后台配置读写接口，API Key 不回显明文。
- [x] 在 `/admin/integrations` 增加“火山 IP 生成 API”配置卡片，支持启用、Base URL、Model ID、API Key、清空 Key。
- [x] 补 smoke 验证：配置归一化、Key 不泄露、接口路由存在、页面包含输入入口。
- [x] 通过 TypeScript、lint、build，并部署到 `sd2.youdoodesign.com` 验证页面可见。

Review：已上线到生产 BUILD_ID `J8JDIEkiAV5n3U6MLNE8_`。公网 `/login` 200，新 `/api/admin/integrations/volcengine-ip` 未登录返回 401，生产包包含“火山 IP 生成 API”、`volcengine-api-key` 和 `/api/admin/integrations/volcengine-ip`。本轮只做 API 整合页配置入口，不请求火山、不接生成任务、不改普通生成和扣点链路。

## 2026-06-27 AI MediaKit 视频超分线上落地

目标：把 AI MediaKit 视频超分首版落到 `sd2.youdoodesign.com` 的真实 live 工作树，提供后台 API Key 配置、成功视频的超分入口、专用创建接口、Provider 状态分发、结果转存和点数/预算失败返还。

- [x] 从功能分支按提交 cherry-pick 到 live 分支，没有整段 merge 旧 checkout，避免覆盖 live 中已有火山 IP、通知、模板、画布等能力。
- [x] 创建并推送发布前回滚点：`rollback/2026-06-27-before-mediakit-video-enhance`，指向合入前 live commit `9c9dd677cc02206882cb63f5e3bad475f852dabd`。
- [x] 保留火山 IP Provider 的状态查询和结果链接刷新逻辑，新增 AI MediaKit 后形成 Seedance / 火山 IP / AI MediaKit 三路 Provider 分发。
- [x] `/admin/integrations` 和 `/admin/integrations/aimediakit` 增加 AI MediaKit 视频超分 API Key 保存/清除入口，API Key 不回显。
- [x] `/api/tasks/enhance-video/create` 接入源任务校验、URL 防内网、点数/预算冻结、Provider 提交、失败返还和本地最终化链路。
- [x] 任务详情页和视频卡结果区增加“超分/增强”入口；普通任务仍走原 Seedance 生成链路，超分任务不允许递归超分。
- [x] 已通过 smoke、TypeScript、lint 和 `npm run build`；真实付费调用仍等待 API Key、资源包/余额和用户明确授权。

Review：已上线到生产 BUILD_ID `9dEA89njqrKrwgpurV0vr`。`youdoo-sites build sd2`、`youdoo-sites restart sd2`、`youdoo-sites status sd2` 均通过；本地和公网 `/api/config` 返回 `aimediakit_enhance_video.enabled=false`、`ready=false`、`api_key_configured=false`，说明入口已上线但尚未配置 API Key；公网 `/login` 200，`/api/admin/integrations/aimediakit` 未登录返回 401，`/admin/integrations/aimediakit` 未登录跳转登录页；生产 `_next/static/9dEA89njqrKrwgpurV0vr/_buildManifest.js` 200，生产包包含后台整合页、AI MediaKit 配置页、管理员配置 API 和超分创建 API；跨健康守护周期复查后 launchd `runs=3` 未继续增长。真实付费超分任务未执行，原因是还未录入 AI MediaKit API Key、未确认资源包/余额，也未获得本轮付费调用授权。

## 2026-06-27 AI MediaKit 视频超分闭环测试准备

目标：把线上超分链路从“代码和入口已上线”推进到“真实 Key、真实任务、真实结果、点数结算、页面回看”闭环。

- [x] 确认 live 工作树是 `/Volumes/Data/Projects/video-api-debugger-v12-full-todo`，当前分支 `codex/v12-full-todo` 与 `origin/codex/v12-full-todo` 完全一致。
- [x] 确认线上已包含后台配置入口、AI MediaKit 管理 API、超分创建 API、Provider 状态分发、任务详情/视频卡超分入口。
- [x] 2026-06-28 返修入口：新增 `/generate/enhance` 视频超分直达页，生成页顶部、侧边栏和控制台都能进入；页面直接列出可超分的成功视频，并复用现有超分创建组件。
- [x] 在 `/admin/integrations` 或 `/admin/integrations/aimediakit` 录入真实 AI MediaKit API Key；密钥只走后台输入框，不写入聊天、todo、日志或截图。
- [x] 录入后确认公网 `/api/config` 返回 `aimediakit_enhance_video.ready=true`、`api_key_configured=true`，且响应中不出现 API Key 明文。
- [x] 准备一条已成功生成、可公网访问、时长较短的视频作为源任务；优先用已有成功任务，避免为了测试先额外生成视频。
- [x] 从任务详情页或视频卡结果区点击“超分/增强”，创建一条真实超分任务；记录本地任务 ID、Provider 任务 ID、冻结点数和预算记录。
- [x] 轮询到终态：成功时验证结果视频可播放、已转存到本地/对象存储、缩略图和下载可用；失败时验证错误信息脱敏、冻结点数/预算自动返还。
- [x] 对比源视频和超分视频：确认页面能区分“原视频”和“超分结果”，普通生成链路、火山 IP 链路和 Seedance 链路没有被误改。

Review：2026-07-02 已用真实 Key 在公网创建 4 秒超分任务 `cmr2z696l0002ou0zzp0m0054`，Provider 任务 `amk-tool-enhance-video-466388192002` 成功，结果已本地化并写入对象存储；冻结 40 点已结算为实际扣除 40 点，错误字段残留已修复。仍需补产品展示闭环：用户在资产页如何发现超分、如何区分超分内容、如何对比原视频和超分视频。

停止条件：没有 API Key、资源包/余额不足、Provider 返回模型/能力未开通、任务卡在排队超过供应商正常窗口、或出现签名 URL/密钥泄露风险时，立即停止真实付费测试并先复盘。

## 2026-07-02 AI MediaKit 视频超分资产页轻入口与对比展示

目标：把超分从“独立入口”调整为资产管理里的自然操作。用户在 `/assets?type=video` 看视频资产时，鼠标移到视频封面即可发起超分；超分结果在列表和详情里都能一眼区分，并能和源视频左右同步对比播放。

- [x] `/api/assets/library` 的视频任务资产返回 `provider`、`generation_mode`、`video_card_id`、`isEnhanceTask`、`canEnhanceVideo`、`enhanceSourceTaskId`，用于前端判断普通生成、超分结果和可超分源视频。
- [x] `/assets` 视频卡片封面左上角给超分结果加“超分”标注；普通生成不加标，避免列表噪音。
- [x] `/assets` 普通成功视频 hover 时显示“超分”按钮；点击后展开轻量二级菜单，选择目标分辨率和帧率后直接创建超分任务。
- [x] 超分菜单默认值保持省脑：分辨率默认 `1080p`，帧率默认“不插帧”；菜单里显示预计冻结点数，提交中禁止重复点击。
- [x] 超分创建成功后跳转到新超分任务详情页；失败时在当前卡片附近展示可恢复错误，不吞掉错误也不暴露密钥、签名 URL 或内部路径。
- [x] `/tasks/[id]` 遇到超分任务时，主结果区改为原视频 / 超分视频左右对比；两个视频播放、暂停、拖动进度尽量同步。
- [x] 对比页左侧明确标“原视频”，右侧明确标“超分视频”；超分视频封面和结果区左上角都保留“超分”标注。
- [x] 保留现有 `/generate/enhance` 作为补充筛选页，但主路径以资产卡片 hover 操作为准。
- [x] 补回归检查：资产页源码包含 hover 超分入口、超分标注、分辨率/帧率菜单；任务详情源码包含左右对比和同步播放逻辑。
- [x] 通过 smoke、lint、build；部署后公网验证 `/assets?type=video` 生产包包含“超分”和对比展示逻辑，公网 `/api/config` 返回 AI MediaKit ready。
- [ ] 真实登录态 hover 截图验收：当前前台 Chrome 的 `sd2.youdoodesign.com` 标签停在 `/login?next=/admin/integrations`，没有可复用登录态；登录后需补一次资产页实际 hover 菜单和超分详情对比页截图验收。

体验原则：入口跟着视频走，不让用户先理解“超分功能在哪里”；超分结果必须持续可识别，不能混在普通生成里；对比页只服务一个判断：超分后有没有变好。

Review：2026-07-02 已上线到生产 BUILD_ID `eW9697UV1jcc4VUslEVPw`。本轮把主入口改到资产管理页：普通成功视频封面 hover 后出现“查看 / 超分”，超分二级菜单可选 `720p/1080p/2K/4K` 和“不插帧/30fps/60fps”，并显示预计冻结点数；超分结果卡片和详情预览左上角持续显示“超分”。任务详情页对 AI MediaKit 超分任务改为左右对比播放，左侧“原视频”、右侧“超分视频”，播放、暂停、拖动进度会同步。验证通过：`npx tsx scripts/enhance-video-entry-smoke.ts`、`npx tsx scripts/enhance-video-create-route-smoke.ts`、`npx tsc --noEmit --pretty false`、`npm run lint`、`npm run build`、`youdoo-sites build/restart/status sd2`；公网 `/api/config` 200 且 `aimediakit_enhance_video.ready=true`，公网 assets/task 静态 chunk 命中 `asset-card-hover-enhance`、`asset-card-badge`、`task-result-compare-stage`、`原视频`、`超分视频`。受控无登录浏览器访问 `/assets?type=video&status=succeeded` 被正确跳转到 `/login`；真实登录态 hover 截图未完成，原因是当前 Chrome 没有可复用登录态。

Follow-up：2026-07-02 根据用户反馈，超分操作按钮从视频封面 hover 层移出，封面 hover 只保留“查看”；普通成功视频的“超分”改到卡片标题行右侧，默认隐藏，卡片 hover/focus 后显示，点击后在按钮旁展开分辨率和帧率菜单。上线 BUILD_ID `h1a-TilZA-dFsC6THZVt5`，公网 assets JS/CSS 命中 `asset-card-enhance-trigger`、`asset-card-enhance-shell`、`asset-card-title-row`，不再命中 `asset-card-hover-enhance`。

## 图集和单图共享闭环 Todo

更新时间：2026-06-17

目标：

- 所有可共享图集都保留明显“共享”入口。
- 共享给项目时必须通过项目下拉选择，避免手填 ID 出错。
- 共享到公共库时必须选择共享文件夹，再提交公共共享流程。
- 单张图片也能共享：先自动创建一个只包含该图片的单图图集，再复用同一个共享面板。

### 实现任务

- [x] 复查现有图集、公共文件夹、公共投稿和图集分享接口，不另造一套共享模型。
- [x] 将共享弹窗默认目标改为项目，并加载可用项目下拉。
- [x] 在共享弹窗中增加“共享文件夹”目标，选择公共文件夹后走公共投稿接口。
- [x] 保留指定用户共享能力，作为高级补充入口。
- [x] 新增单张参考图创建单图共享图集的接口。
- [x] 在图集详情页每张图片卡增加“共享”按钮，点击后打开同一共享弹窗。
- [x] 验证 TypeScript、lint、构建和公网页面闭环。

### 验收标准

- [x] 图集卡和图集详情页都能打开共享面板。
- [x] 共享面板可以直接选择项目，不需要用户手填项目 ID。
- [x] 共享面板可以选择共享文件夹，并提交公共共享。
- [x] 单张图片点击“共享”后，会生成一个单图图集并进入共享流程。
- [x] 普通用户提交公共共享为待审核；管理员提交后直接生成公共图集。
- [x] 线上 `sd2.youdoodesign.com` 刷新后能看到新入口。

### Review - 2026-06-17 图集和单图共享闭环

- 共享弹窗复用现有 `AlbumShare`、`ReferenceAlbumFolder`、`PublicAlbumSubmission`，没有新增数据库模型。
- 图集共享默认进入“共享给项目”，项目来源为 `/api/projects` 下拉；指定用户共享保留。
- 新增“提交到共享文件夹”方式，选择共享文件夹后调用 `/api/reference-albums/[id]/public-submissions`，普通用户待审核、管理员直接复制公共图集沿用既有后端规则。
- 新增 `POST /api/reference-images/[id]/share-album`，单张图片会先创建只包含该图片的私有单图图集，再打开同一共享弹窗。
- 已通过 `youdoo-sites build/restart sd2` 上线到 `sd2.youdoodesign.com`。
- 验证通过：`npx tsc --noEmit --pretty false`、`npm run lint`、`youdoo-sites build sd2`、`youdoo-sites restart sd2`、公网 `/api/config`、`/login`、新增 API 未登录 401、公共静态 chunk 包含新文案。
- 真实提交会写入数据库，本轮没有用生产账号制造测试共享记录；功能路径通过构建、路由、静态资源和现有后端规则闭环验证。

## 模板系统 UX 重设计总控 Todo

更新时间：2026-06-17

依据：

- `/Volumes/Data/Projects/video-api-debugger-v12-full-todo/tasks/template-ux-redesign-plan.md`
- `/Volumes/Data/Projects/video-api-debugger-v12-full-todo/tasks/template-full-function-chain.md`
- `/Volumes/Data/Downloads/Current/AI 视频创作经验工作台需求文档 V1.pdf`
- 2026-06-17 多角色 Agent 推演结论

### 总判断

当前模板功能底层方向是对的，但页面仍然像工程后台：

```text
模板 / 模块 / PromptBlock / AgentRun / JSON / 优先级 / 注入方式
```

真实用户要完成的是：

```text
普通用户：选模板 -> 输入需求 -> 生成方案 -> 提交生成
模板管理员：创建模板 -> 编排上下文卡片 -> 绑定图片 -> 预览最终提示词 -> 试生成 -> 发布
质量运营：发现跑偏 -> 复盘归因 -> 写入 Memory -> 推动模板优化
系统管理员：配置 API -> 测试可用 -> 查看失败诊断
```

因此，本轮模板相关后续开发必须从“补字段 / 补抽屉”改为“按用户角色重建工作台”。

### 2026-06-17 最新产品修正：上下文卡片系统

用户已确认新的目标形态：模板里的“模块”不再按工程模块、字段表单或代码 key 展示，而是统一变成**上下文卡片**。

核心定义：

```text
上下文卡片 = 一段最终给 LLM 的上下文内容 + 可选 1 张绑定图片 + 卡片级启用状态 + 卡片级强制/参考模式
```

页面必须围绕这 4 个对象设计：

1. `模板上下文卡片编排页`
   - 卡片可拖拽排序。
   - 卡片可启用 / 停用。
   - 卡片上直接显示二选一按钮：`强制插入` / `仅供参考`。
   - 卡片可绑定 0 或 1 张图片。
   - 卡片只有 `编辑` 一个进入详情的按钮，不暴露底层字段。

2. `编辑上下文卡片抽屉`
   - 顶部第一个框：`最终输入给 LLM 的上下文内容`，这是最终生效内容。
   - 中间第二块：`LLM 参考与设置`，默认折叠，可展开修改，修改后自动保存。
   - 底部第三个框：`让 LLM 帮你改这张卡片`，输入后按 Enter 调用 LLM，并更新顶部内容。
   - 编辑二级页里不再放 `强制插入 / 仅供参考`，因为它已经在卡片上直接选择。

3. `绑定图片模式`
   - 图片只是卡片的附加绑定，不单独变成一套“图片模块”。
   - 一张卡片默认只绑定 1 张图片，可更换、移除。
   - 图片来源复用生成页已有能力：`参考图集` 和 `历史上传图`。
   - 没绑定图片时，卡片显示 `添加图片` 占位。

4. `最终提示词影响预览`
   - 放在模板编辑工作台底部，做成随页面自然滚动的横向全宽核对区，不做固定条、不做内部限高滚动。
   - 不放在右侧边栏；模板详情页不再放卡片内容编辑菜单，卡片内容编辑进入二级页。
   - 影响区内容要完整显示，长文本自然换行，不用省略号截断。
   - 显示强制插入卡片数量、仅供参考卡片数量、绑定图片数量。
   - 显示启用卡片按拖拽顺序如何影响最终提示词。
   - 明确说明：强制插入会写进最终提示词；仅供参考只影响 LLM 理解，不保证原文出现。

禁止项：

- 不再把 `brand_logo`、`moduleType`、`PromptBlock`、`injectionMode`、`priority`、`target`、`JSON` 放在主路径。
- 不再把“模块类型选择器”作为管理员编辑模块的主入口。
- 不再要求用户理解“角色模块 / Logo 模块 / 风格模块”这些底层分类，必要分类只由系统内部推断或作为高级筛选。
- 不再把图片做成单独模块；图片跟随某张上下文卡片。

### 目标版本对齐结论（2026-06-17）

- [x] 当前目标版本以“上下文卡片系统”为准，不再以工程模块表单、模块类型选择器或 JSON 结构预览为主路径。
- [x] 旧 `Module Builder / 新增模块 / 新增规则 / 模块库 / 素材规则库` 只作为历史实现、兼容旧数据或高级维护能力保留，不能继续抢占管理员主流程。
- [x] 目标闭环统一为：模板工作台 -> 上下文卡片编排 -> 卡片编辑 / LLM 修改 -> 可选绑定图片 -> 最终提示词影响预览 -> 试生成 -> 发布检查 -> 普通用户使用 -> 质量复盘。
- [x] 图片绑定必须是卡片能力，不是独立图片模块；图片来源复用参考图集和历史上传图。
- [ ] 代码实现仍需按 Phase 2 到 Phase 8 落地，本节只对齐目标版本和执行优先级。

### 2026-06-17 纠偏：当前模板编辑页为什么仍然难用

结论：上一轮只是把旧抽屉“撑宽”，没有真正把模板编辑变成可用工作台。现在的问题不是某个按钮坏，而是页面任务层级错了。

已确认问题：

- [x] 独立浏览器访问 `https://sd2.youdoodesign.com/admin/templates` 会跳到登录页；当前缺少管理员登录态截图验收，后续必须补真实登录后的点击闭环。
- [x] `/admin/templates/[id]` 不是真正的模板详情工作台，只是复用 `AdminTemplatesClient initialTemplateId`，所以列表页、详情页、新建模板、发布检查和编辑入口仍挤在同一个页面。
- [x] 主编辑仍通过 `TemplateEditorDrawer` 弹层完成；这和“模板详情页主工作区就是上下文卡片编排器”的目标冲突。
- [x] `TemplateContextCardsPanel` 同时承担卡片列表、编辑面板、提示词预览、图片选择入口、LLM 对话、拖拽和保存状态，组件职责过重，后续很难继续稳定扩展。
- [x] 新增空卡片存在丢失风险：`createEmptyCard()` 默认 `content: ''`，但 `src/lib/templates/workbench.ts` 的 `normalizeContextCards()` 会过滤空内容卡片；保存链路走 `buildTemplateWritePayload()` 后，空草稿卡片刷新后可能消失。
- [x] 图片绑定弹窗目前点击图片即选中并关闭，但 todo 里写的是“确认绑定”；实际交互和规划不一致，容易误点。
- [x] 最终提示词正文藏在 `<details>` 里，不是工作台主信息；管理员无法一眼判断强制/参考到底如何影响最终提示词。
- [x] 暗色全屏弹层叠在浅色后台页面上，视觉系统割裂；看起来像临时调试面板，不像稳定工作台。

新的页面核心判断：

```text
模板编辑页不是弹窗。
模板编辑页应该是一个独立工作台。

进入 /admin/templates/[id]
↓
主工作区保持左右结构，不做上中下三段式表单
左侧/中间：上下文卡片画布，可排序、启用、强制/参考、绑定图片
二级页：当前卡片内容编辑、图片绑定、LLM 参考设置和 LLM 对话
底部：最终提示词影响预览，只作为试生成前的横向核对区，随页面自然滚动
↓
保存自动完成，发布前必须试生成并通过检查
```

#### P0：停止继续加宽旧抽屉，改成真正模板工作台

- [x] 将 `/admin/templates` 收敛为模板列表页：只负责查看模板、搜索/筛选、进入详情、LLM 新建模板。
- [ ] 将 `/admin/templates/[id]` 改为真正详情页：不再复用完整 `AdminTemplatesClient` 列表页壳子。
- [x] 在 `/admin/templates/[id]` 直接渲染上下文卡片工作台，默认选中第一张卡片；不再要求用户点“编辑上下文卡片”才进入主编辑。
- [x] `TemplateEditorDrawer` 降级为小屏或兼容旧入口的临时编辑层；桌面端主路径不再使用全屏弹层。
- [x] 删除或隐藏当前详情页里重复的卡片预览区，避免“预览卡片”和“可编辑卡片”两套列表同时存在。

#### P0：修复卡片数据闭环

- [x] 服务端保存链路允许保存空内容草稿卡片，至少保留 `id / title / mode / enabled / sort_order / bound_image / llm_reference`，不要因为 `content` 为空就丢卡片。
- [x] 新增卡片后立即进入选中编辑态，并显示“草稿未写内容”状态；刷新后卡片仍存在。
- [ ] 自动保存状态拆成卡片级状态：`未保存`、`保存中`、`已保存`、`保存失败，可重试`。
- [ ] LLM 改写前保存当前内容快照，LLM 回复后提供 `撤回本次修改`。
- [ ] 添加真实回归脚本或浏览器验收：新增空卡片 -> 刷新 -> 卡片仍在 -> 写内容 -> 刷新 -> 内容仍在。

#### P1：重做模板详情页页面结构

- [ ] 页面顶部只保留模板名称、状态、版本、保存状态、一个主按钮 `试生成`，发布相关动作进入发布检查区。
- [x] 详情页主体不要做成上中下三段式表单；桌面端保持左右工作结构。
- [x] 左侧/中间主舞台显示上下文卡片画布：卡片可拖拽、可启用、可二选一 `强制插入 / 仅供参考`、可直接看到图片缩略图。
- [x] 2026-06-19 纠偏：模板详情页不再保留右侧当前卡片编辑栏；卡片编辑内容菜单改到 `/admin/templates/[id]/cards/[cardId]` 二级页。
- [x] 最底部只放最终提示词影响预览，横向全宽显示强制内容、参考内容、绑定图片、最终拼接顺序，不放侧边，不默认折叠，不做固定条。
- [x] 中等屏幕下模板详情页只保留卡片画布和底部最终提示词影响；编辑内容通过二级页承载。
- [x] 小屏幕下才允许自然纵向堆叠：卡片列表 -> 选中卡片编辑 -> 底部提示词影响预览；桌面端不做上中下三段。
- [x] 桌面端不再常驻编辑栏；保存状态和编辑操作进入卡片二级页，避免主工作台被菜单挤窄。
- [x] 最终提示词影响区必须是模板工作台最后一块，随页面流动，不做固定条，不再被保存操作或其他常驻工具压在下面。
- [x] 上下文卡片列表超高时只让卡片列表自身收缩滚动；单张卡片标题和正文完整换行显示，不再用摘要截断内容。
- [x] 模板旧抽屉入口和模板列表预览也必须同步取消内容裁剪：抽屉容器允许滚动，预览卡片正文完整换行显示。

#### P1：重做卡片编辑器

- [x] 卡片编辑器不是普通表单，而是“当前卡片”的二级编辑页；从卡片 `编辑` 或图片占位进入。
- [ ] 第一块固定为 `最终输入给 LLM 的上下文内容`，高度足够，支持长文本，不被其他控件挤压。
- [ ] 第二块 `LLM 参考与设置` 默认折叠，但折叠态要显示摘要，例如 `已设置 3 行参考`；展开修改后自动保存。
- [ ] 第三块 `让 LLM 帮你改这张卡片` 固定在编辑面板底部，Enter 发送，Shift+Enter 换行。
- [ ] LLM 按钮必须先检查 Musk API 配置；未配置时显示 `去 API 设置`，不能让用户点了才报错。
- [x] `强制插入 / 仅供参考` 只保留在卡片本体上，不进入二级编辑页。

#### P1：重做图片绑定体验

- [ ] 卡片上未绑定图片时显示明确入口 `添加图片`；已绑定时显示缩略图、来源、文件名。
- [ ] 图片选择器改为“先选中，再确认绑定”，避免点击图片就误绑定。
- [ ] 图片选择器支持搜索图片名称、图集名称和历史上传文件名。
- [ ] 图片选择器保留两个来源：`参考图集`、`历史上传图`，并显示权限不可用、空图集、加载失败三种状态。
- [ ] 绑定图片后二级编辑页和卡片画布同步更新，刷新后仍保留。

#### P1：最终提示词影响预览必须变成主信息

- [x] 最终提示词影响预览位于模板详情工作台底部横向区域，不进入右侧编辑器，不做侧边栏，也不做固定条。
- [x] 强制插入区常显：列出会进入最终提示词的卡片标题和内容摘要。
- [x] 仅供参考区常显：列出只影响 LLM 理解的卡片，不保证原文出现。
- [x] 图片区常显：列出进入上下文的绑定图片、来源和所属卡片。
- [x] 提供 `复制最终提示词`，但不暴露底层 JSON。
- [ ] 试生成前必须显示“本次最终会带入哪些卡片和图片”。

#### P2：拆组件，降低后续维护成本

- [ ] 拆出 `AdminTemplateListPage`：只管 `/admin/templates` 列表和 LLM 新建入口。
- [ ] 拆出 `AdminTemplateWorkspacePage`：只管 `/admin/templates/[id]` 的独立详情工作台。
- [ ] 拆出 `TemplateCardCanvas`：卡片排序、启用、强制/参考、图片缩略图。
- [ ] 拆出 `TemplateCardEditPage` / `TemplateCardInspector`：二级页当前卡片编辑器、LLM 参考、LLM 对话。
- [ ] 拆出 `TemplatePromptImpactPanel`：底部横向最终提示词影响预览。
- [ ] 拆出 `TemplateImageBinder`：图片来源、搜索、选中、确认绑定。
- [ ] 保留 `TemplateContextCardsPanel` 作为临时兼容层或删除，不能继续无限堆功能。

#### 验收闭环

- [ ] 管理员真实登录后验证：导航进入 `/admin/templates`，能看懂下一步是选择模板或新建模板。
- [ ] 管理员真实登录后验证：进入 `/admin/templates/[id]` 后不用打开弹窗，第一屏就能编辑上下文卡片。
- [ ] 管理员真实登录后验证：新增空卡片、刷新、卡片仍存在。
- [ ] 管理员真实登录后验证：编辑卡片内容、切换强制/参考、停用/启用、拖拽排序、刷新后全部保留。
- [ ] 管理员真实登录后验证：绑定参考图集图片、绑定历史上传图、刷新后图片仍保留。
- [ ] 管理员真实登录后验证：LLM 对话能改写当前卡片内容，并能撤回本次修改。
- [ ] 管理员真实登录后验证：最终提示词影响预览在页面最底部，不在右侧；试生成入口能清楚展示本次会带入的卡片与图片。
- [ ] 响应式验收：1440、1280、1024、390 宽度下不横向溢出、不遮挡，主模板页不再出现被编辑区挤窄的问题。
- [ ] 线上闭环：`npm run build`、`youdoo-sites build sd2`、`youdoo-sites restart sd2`、公网加载新 BUILD_ID、登录态真实点击截图或录屏证据。

### 总原则

- [x] 普通用户主路径不得出现 `Module Builder`、`PromptBlock`、`AgentRun`、`Memory`、`injectionMode`、`priority`、原始 JSON。
- [x] 模板管理员主路径不得要求手填 JSON、`reference_image_id`、`thumbnail_url`、`target`、`sort_order`。
- [x] 模板管理员主路径必须以“上下文卡片”展示模板模块，不显示 `brand_logo` 这类代码 key。
- [x] `强制插入 / 仅供参考` 必须在卡片上直接二选一，不放进编辑二级页。
- [x] 卡片允许绑定 0 或 1 张图片，图片来源必须复用参考图集和历史上传图。
- [x] 编辑二级页必须是三块：最终上下文内容、默认折叠的 LLM 参考与设置、底部 LLM 对话框。
- [x] 卡片内容、LLM 参考设置、图片绑定、启用状态、强制/参考模式都要自动保存，并显示保存状态。
- [ ] 所有 LLM 生成结果必须先是草稿，必须人工确认后才能保存。
- [ ] 所有 LLM 入口必须先检查 Musk API 状态；未配置时禁用按钮并显示“去 API 设置”。
- [x] 一页只保留一个主任务和一个最强主按钮；低频功能折叠或移到二级页面。
- [ ] 发布模板前必须完成试生成和发布检查。
- [ ] 复盘页面必须能回答“为什么这样生成、哪里跑偏、下一步改什么”，不能只展示日志 JSON。
- [x] `TemplateEditorDrawer` 后续不能再作为管理员创建模板的主路径，只能作为上下文卡片快速编辑入口。

### 新信息架构

- [x] 普通用户入口收敛为：`/templates` 模板库 -> `/template-generate` 模板生成 -> `/tasks/[id]` 结果详情。
- [x] 管理员入口新增：`/admin/templates` 模板工作台。
- [ ] 管理员新增模板入口：`/admin/templates/new` LLM 新建模板向导。
- [ ] 管理员模板详情入口：`/admin/templates/[id]` 必须重做为真正独立详情工作台；当前只是复用列表页组件加初始 ID，不能算完成。
- [ ] 质量运营入口新增：`/admin/quality-runs`，从产出、任务详情、反馈、AgentRun 进入。
- [x] 图片来源入口复用现有参考图集和历史上传图，不先新增一套独立图片模块后台。
- [x] `/admin/modules` 旧模块库页面已删除，不再作为管理员新增模块或高级维护入口；兼容数据只保留在服务端 API / 设置层。
- [ ] 素材规则入口后置为增强能力，不能抢在上下文卡片系统前面。
- [ ] 系统诊断入口新增或整理为：`/admin/diagnostics`、`/admin/operation-logs`、`/admin/agent-runs`、`/admin/integrations`。
- [ ] 导航分组改为“创作管理”和“系统诊断”，不要把模板、模块、API、AgentRun 平铺给所有管理员。

### Phase 0：现状隔离与执行边界

目标：先停止沿旧抽屉方向继续堆功能，明确哪些旧实现保留、迁移或降级为高级入口。

- [x] 梳理当前模板相关页面和组件依赖：`/templates`、`/template-generate`、`TemplateGenerateClient`、`GenerationComposer`、`TemplateEditorDrawer`、`/admin/modules`、`/admin/agent-runs`、`/admin/integrations`。
- [x] 标记旧路径职责：`TemplateEditorDrawer` 只作为高级编辑 / 快速编辑，不再作为创建模板主路径。
- [x] 标记旧路径风险：`/template-generate` 内的 Module Builder 面板不再对普通用户显示，不再作为管理员新增模块主入口。
- [x] 标记旧任务调整：现有“模板编辑抽屉继续补 LLM 配置”的任务全部迁移到“模板工作台 / 新建向导 / 上下文卡片编排器 / 卡片编辑抽屉”。
- [x] 确认当前工作区脏改来源，本轮只触碰模板 UX 重设计、导航清理和任务/版本记录相关文件。

涉及文件：

- `tasks/template-ux-redesign-plan.md`
- `tasks/template-full-function-chain.md`
- `tasks/todo.md`
- `src/lib/navigation.ts`
- `src/components/SideNav.tsx`
- `src/components/ComposerTopbar.tsx`
- `src/components/templates/*`

验收标准：

- [ ] 后续任务能明确区分“用户生成主路径”“管理员模板工作台”“质量复盘”“系统诊断”。
- [ ] 不再出现“把所有模板能力继续塞进一个抽屉”的执行计划。

### Phase 1：普通用户模板生成三步流

目标：普通用户从模板库进入后，3 步内能提交生成。

主路径：

```text
模板摘要
↓
输入一句视频需求
↓
生成 A/B/C/D 方案
↓
选择方案
↓
提交生成
```

任务：

- [x] `/template-generate` 首屏重排为“当前模板摘要 + 视频需求输入 + 生成 4 个方案”。
- [x] 项目选择默认使用个人默认项目或最近项目，折叠为“保存位置”高级项。
- [x] 视频卡默认自动创建或选择最近可生成视频卡，折叠为“视频卡归档”高级项。
- [x] Prompt 编辑默认折叠，只显示“查看 / 编辑最终提示词”。
- [x] 参考图、图集、参数栏、模板规则详情默认折叠，避免打断主路径。
- [x] 普通用户不可见 Module Builder、LLM 生成规则设定、AgentRun 链接、JSON 预览。
- [ ] A/B/C/D 方案卡必须显示：方案名称、核心思路、适合场景、简短分镜、预期效果。
- [x] 方案按钮文案区分：`查看方案`、`使用此方案`，避免“查看 Prompt / 继续修改 / 生成此方案”三个按钮视觉同级。
- [x] 提交后显示任务状态和结果入口，不把最近任务抢到主路径上方。

涉及文件：

- `src/app/template-generate/page.tsx`
- `src/components/templates/TemplateGenerateClient.tsx`
- `src/components/GenerationComposer.tsx`
- `src/components/PromptEditor.tsx`
- `src/components/ComposerActionBar.tsx`

验收标准：

- [x] 普通用户从 `/templates` 点击“使用模板”后，首屏只需要输入需求即可开始。
- [x] 普通用户 3 步内可提交生成：输入需求、选择方案、提交。
- [x] 普通用户全流程不需要理解模板模块、规则、AgentRun、Memory。
- [x] 移动端主路径仍是单列：模板摘要 -> 需求 -> 方案 -> 提交。

### Phase 2：模板工作台

目标：管理员不再靠模板库抽屉维护模板，而是在独立模板工作台里创建、维护、试生成、发布。

新增页面：

- [x] `/admin/templates`：模板工作台首页。
- [x] `/admin/templates/[id]`：模板详情与发布工作台。

`/admin/templates` 任务：

- [x] 左侧或主列表显示模板：名称、状态、上下文卡片完整度、绑定图片状态、最近试生成、最近质量问题。
- [x] 顶部主按钮：`+ 用 LLM 新建模板`。
- [x] 次级入口：复制模板、查看高级模块库（兼容旧数据）、查看质量复盘、查看执行链路。
- [x] 模板状态使用人话：草稿、待补卡片、待绑图片、待试生成、可发布、已发布、已停用。
- [x] 空状态引导管理员用 LLM 创建第一个模板。

`/admin/templates/[id]` 任务：

- [x] 主舞台显示模板用途、上下文卡片列表、绑定图片预览、最终提示词影响预览、试生成结果、A/B/C/D 方案预览。
- [x] 右侧显示下一步建议和缺失项，不显示无关日志。
- [x] 高级结构仅系统管理员或高级维护入口可见，默认不显示 `PromptBlock`、JSON、`injectionMode`、`priority`。
- [x] 保留快速编辑入口，但不把所有字段直接堆成表单。
- [ ] 增加模板质量历史：最近负向 Memory、常见跑偏类型、待处理优化。

涉及文件：

- `src/app/admin/templates/page.tsx`
- `src/app/admin/templates/[id]/page.tsx`
- `src/components/templates/*`
- `src/app/api/templates/*`
- `src/lib/templates/workbench.ts`
- `src/lib/navigation.ts`

验收标准：

- [x] 管理员进入 `/admin/templates` 后 3 秒内知道下一步该点什么。
- [x] 管理员能从模板详情看出该模板是否能发布、缺什么、最近效果如何。
- [x] 原始 JSON 不在主视图默认展示。

### Phase 3：LLM 新建模板向导

目标：管理员用自然语言从 0 创建模板，不要求先选一个已有模板。

页面：`/admin/templates/new`

步骤：

- [x] Step 1：描述模板目标，显示大输入框和少量业务辅助选项。
- [x] Step 2：LLM 追问缺失信息，缺素材、缺用途、缺时长时不硬生成。
- [x] Step 3：生成模板草稿，展示人话预览，不默认展示 JSON。
- [ ] Step 4：生成初始上下文卡片，管理员可调整卡片内容、启用状态和强制 / 参考模式。
- [ ] Step 5：为需要图片的卡片绑定图片，图片来源复用参考图集和历史上传图。
- [ ] Step 6：试生成，使用当前草稿生成 A/B/C/D 方案。
- [ ] Step 7：发布检查，通过后发布。

草稿预览必须显示：

- [ ] 模板名称。
- [ ] 一句话用途。
- [ ] 适用场景。
- [ ] 默认比例 / 时长。
- [ ] 初始上下文卡片列表。
- [ ] 每张卡片的最终上下文内容。
- [ ] 每张卡片的启用状态。
- [ ] 每张卡片的 `强制插入 / 仅供参考` 模式。
- [ ] 每张卡片是否建议绑定图片。
- [ ] 最终提示词影响摘要。
- [ ] 缺失信息。

涉及文件：

- `src/app/admin/templates/new/page.tsx`
- `src/components/templates/TemplateCreateWizard.tsx`
- `src/lib/templates/template-config-builder.ts`
- `src/app/api/templates/config-builder/generate/route.ts`
- `src/app/api/templates/config-builder/save/route.ts`

验收标准：

- [x] 管理员可以不选择旧模板，直接通过自然语言创建模板草稿。
- [x] happy path 不出现 JSON。
- [x] LLM 追问和草稿生成均有明确状态。
- [x] 保存后进入模板详情页继续试生成和发布。

### Phase 4：模板上下文卡片编排器

目标：把旧的模块表单、Module Builder 面板和代码 key，重做成管理员能直接理解的“上下文卡片编排器”。

页面位置：

- [x] 首选落点：`/admin/templates/[id]` 的主工作区；详情页已直接显示上下文卡片工作台。
- [x] 过渡落点：`TemplateEditorDrawer` 已增加 `inline` 工作台模式，同时保留旧抽屉兼容入口。
- [ ] `/template-generate` 只保留普通用户生成主路径，不再承载管理员卡片编辑主任务。

数据模型任务：

- [x] 在模板序列化结构中新增 `context_cards` 数组，旧 `module_bindings / rules / assets` 先兼容读取，不作为新 UI 的主模型。
- [x] 单张卡片字段使用人话概念：
  - `id`
  - `title`
  - `content`：最终输入给 LLM 的上下文内容。
  - `mode`：`force` 或 `reference`，UI 显示为 `强制插入` / `仅供参考`。
  - `enabled`
  - `sort_order`
  - `bound_image`：可为空，最多 1 张。
  - `llm_reference`：LLM 参考与设置，默认折叠。
  - `auto_save_status`
- [x] 底层如果仍需映射到 `prompt_required / context_only`，只在保存或渲染层映射，不暴露给 UI。
- [x] 为旧模板生成默认上下文卡片：角色、Logo、风格、镜头等旧模块文本转成卡片标题和内容，不在卡片标题里显示 `brand_logo` 等 key。

卡片编排页任务：

- [x] 将 `TemplateContextCardsPanel` 的最终提示词影响预览从右侧迁移到页面底部；当前卡片编辑从详情页移到二级页。
- [x] 每张卡片显示拖拽手柄、可选图片缩略图、标题、内容摘要、`强制插入 / 仅供参考` 二选一按钮、启用开关、编辑按钮。
- [x] 支持拖拽排序，排序后自动保存，并立即更新最终提示词影响预览。
- [x] 支持启用 / 停用，切换后自动保存；停用卡片不进入最终提示词，也不带入绑定图片。
- [x] 支持在卡片上直接切换 `强制插入 / 仅供参考`，切换后自动保存。
- [x] 没绑定图片的卡片显示 `添加图片` 占位；已绑定图片显示缩略图和 `已绑定图片` 角标。
- [x] 卡片列表底部提供 `新增上下文卡片` 按钮，新卡片默认 `仅供参考`、启用、无图片。
- [x] 空状态文案：`还没有上下文卡片，先添加一张卡片告诉 LLM 什么必须保持。`

编辑二级页任务：

- [ ] 拆出真正的 `TemplateContextCardDrawer` 或 `TemplateCardInspector`；当前编辑器内嵌在 `TemplateContextCardsPanel`，组件职责过重，不能算完成。
- [x] 顶部第一个框：`最终输入给 LLM 的上下文内容`，大文本框，编辑后自动保存。
- [x] 顶部内容框旁显示保存状态：`正在保存`、`已自动保存`、`保存失败，点击重试`。
- [x] 图片绑定区域显示当前图片缩略图、图片来源、`更换图片`、`移除图片`。
- [x] 中间第二块：`LLM 参考与设置`，默认折叠。
- [x] `LLM 参考与设置` 展开后包含：
  - `给 LLM 的参考背景` 文本框。
  - `修改偏好` 输入框。
  - `自动保存` 状态。
- [x] 底部第三个框：`让 LLM 帮你改这张卡片`。
- [x] LLM 对话框 Enter 发送，调用 Musk API，用对话要求更新顶部 `content`，不直接改变 `mode` 和图片绑定。
- [ ] LLM 回复后显示“已更新上方内容”，并提供 `撤回本次修改`。
- [x] 编辑二级页里不得出现 `强制插入 / 仅供参考`，该二选一只在卡片上。

最终提示词影响预览任务：

- [ ] 底部横向预览显示统计：强制插入数量、仅供参考数量、绑定图片数量、停用数量。（已完成前三项，停用数量仍待补）
- [x] 预览按拖拽顺序列出启用卡片。
- [x] 强制插入卡片用明确标识：`会写进最终提示词`。
- [x] 仅供参考卡片用明确标识：`只给 LLM 参考，不保证原文出现`。
- [x] 绑定图片在预览里显示缩略图和来源。
- [x] 增加 `查看最终提示词` 按钮，打开最终提示词预览，不显示底层 JSON。
- [x] 最终提示词影响区内容完整换行展示，不再被固定高度或省略号截断。

涉及文件：

- `src/lib/templates/workbench.ts`
- `src/components/templates/TemplateContextCardsPanel.tsx`
- `src/components/templates/TemplateContextCard.tsx`
- `src/components/templates/TemplateContextCardDrawer.tsx`
- `src/components/templates/TemplatePromptImpactPreview.tsx`
- `src/components/templates/TemplateEditorDrawer.tsx`
- `src/app/admin/templates/[id]/page.tsx`
- `src/app/api/templates/[id]/context-cards/route.ts`
- `src/app/api/templates/[id]/context-cards/[cardId]/route.ts`
- `src/app/api/templates/[id]/context-cards/reorder/route.ts`
- `src/app/api/templates/[id]/context-cards/[cardId]/revise/route.ts`

验收标准：

- [x] 管理员全流程只看到上下文卡片，不看到 `brand_logo`、`moduleType`、`injectionMode`、`priority`、JSON。
- [x] 卡片能新增、编辑、拖拽排序、启用/停用、切换强制/参考，并自动保存。
- [x] 编辑二级页的 LLM 对话能更新顶部最终上下文内容。
- [x] 最终提示词影响预览能实时反映卡片顺序、强制/参考状态和图片绑定。
- [x] 旧模板仍能被兼容打开，并能显示为上下文卡片。

### Phase 5：卡片绑定图片与图片选择器复用

目标：在上下文卡片上增加“绑定 1 张图片”的能力，图片来源复用生成页已有 `参考图集` 和 `历史上传图`，不要另做图片模块。

图片绑定规则：

- [x] 每张上下文卡片最多绑定 1 张图片。
- [x] 图片跟随卡片启用状态：卡片停用时，图片也不进入本次模板上下文。
- [x] 图片跟随卡片模式：强制插入卡片的图片作为强参考；仅供参考卡片的图片只给 LLM 做上下文。
- [x] 图片可更换、移除，动作都自动保存。
- [x] 图片必须显示来源：参考图集名称 / 历史上传图 / 手动上传。
- [x] 手填图片 URL 不进入主路径，只作为高级入口或暂不做。

选择图片弹窗任务：

- [x] 新增 `TemplateBoundImagePicker`，复用生成页参考图集和历史上传图能力。
- [x] 弹窗标题：`选择绑定图片`。
- [x] 顶部 Tab：`参考图集` / `历史上传图`。
- [x] 参考图集 Tab 左侧显示图集列表：品牌素材、角色 IP、产品图、公共参考图等。
- [ ] 右侧显示图片网格，支持搜索图片名称。
- [x] 历史上传图 Tab 复用 `UploadedImagePicker` 的数据源和网格交互。
- [x] 图片选中后显示蓝色边框和勾选标记。
- [x] 底部按钮：`取消` / `确认绑定`。
- [x] 底部提示：`一次只绑定 1 张图片，可随时更换。`

组件复用任务：

- [ ] 抽取生成页现有图片选择公共能力，避免复制两套列表和搜索逻辑。
- [ ] 复用或拆分 `ReferenceAlbumPicker`：保留原生成页多选能力，同时支持“单选绑定模式”。
- [ ] 复用或拆分 `UploadedImagePicker`：保留原生成页多选能力，同时支持“单选绑定模式”。
- [ ] 统一图片缩略图组件，支持加载失败占位、图片名称、来源、选中态。
- [x] 绑定图片弹窗不触发生成页素材列表变更；它只把图片绑定到当前卡片。

后端 / 数据任务：

- [x] 新增或复用接口读取参考图集图片，返回图片 ID、名称、缩略图、原图、来源图集。
- [x] 新增或复用接口读取历史上传图，返回图片 ID、名称、缩略图、原图、上传时间。
- [x] `PATCH context-card` 支持写入 / 清空 `bound_image`。
- [x] 保存时只存图片引用 ID 和来源信息，不把图片 base64 写进模板 JSON。
- [ ] 删除或归档图片后，卡片显示“图片不可用”，并提示重新绑定。

最终提示词和生成链路任务：

- [x] 渲染最终 Prompt 时，把启用卡片按拖拽顺序传给 LLM。
- [x] 强制插入卡片的 `content` 必须进入最终提示词。
- [x] 仅供参考卡片的 `content` 进入 LLM 上下文，但不强制原文进入最终提示词。
- [x] 绑定图片进入本次生成的参考图列表，并和卡片保持关联。
- [ ] 如果绑定图片超过生成接口参考图数量限制，按卡片顺序和强制优先级选择，并给管理员显示提示。
- [x] 最终提示词预览显示“文字卡片”和“绑定图片”如何被使用。

涉及文件：

- `src/components/templates/TemplateBoundImagePicker.tsx`
- `src/components/templates/TemplateContextCardDrawer.tsx`
- `src/components/ReferenceAlbumPicker.tsx`
- `src/components/UploadedImagePicker.tsx`
- `src/components/ReferenceThumb.tsx`
- `src/lib/hooks/useWorkspace.ts`
- `src/app/api/reference-albums/*`
- `src/app/api/assets/history/route.ts`
- `src/app/api/templates/[id]/context-cards/[cardId]/route.ts`
- `src/lib/templates/workbench.ts`
- `src/app/api/agent/template-plans/route.ts`
- `src/app/api/tasks/create/route.ts`

验收标准：

- [x] 管理员能从参考图集选 1 张图绑定到卡片。
- [x] 管理员能从历史上传图选 1 张图绑定到卡片。
- [x] 更换 / 移除图片后自动保存，刷新页面仍能看到正确状态。
- [x] 绑定图片不会污染生成页当前参考图列表。
- [x] 生成方案和最终提示词预览能识别卡片绑定图片。
- [x] 普通用户不需要知道图片绑定配置，只在模板生成时自然生效。

### Phase 6：试生成与发布检查

目标：发布不是状态下拉，而是带门禁的发布流程。

任务：

- [x] 模板详情增加 `试生成` 主入口，使用当前模板草稿生成 A/B/C/D 方案。
- [ ] 试生成结果记录到模板版本和 AgentRun。
- [ ] 发布前检查 LLM API 状态、模板基本信息、启用上下文卡片、强制插入卡片、绑定图片可用性、最终提示词预览、试生成结果、敏感信息。
- [ ] 未通过检查时禁用“发布模板”，并列出缺失项。
- [ ] 通过检查后允许发布，并提示“模板已发布，普通用户现在可以使用”。
- [ ] 支持停用模板、复制模板、发布新版本、查看发布历史。
- [ ] 版本回滚可先进入 P3，但发布历史必须先可见。

涉及文件：

- `src/app/admin/templates/[id]/page.tsx`
- `src/components/templates/TemplatePublishChecklist.tsx`
- `src/app/api/templates/[id]/route.ts`
- `src/app/api/agent/template-plans/route.ts`
- `src/lib/templates/workbench.ts`

验收标准：

- [ ] 没有试生成结果的模板不能发布。
- [ ] 缺少启用卡片、强制插入卡片、必要绑定图片或试生成结果时不能发布。
- [ ] 发布后普通用户在 `/templates` 可见。
- [ ] 停用后普通用户不可见，但管理员仍可查看和复用。

### Phase 7：质量复盘工作台

目标：从结果出发，快速判断跑偏原因，并推动模板优化。

新增页面：

- [ ] `/admin/quality-runs`
- [ ] `/admin/quality-runs/[id]`

入口：

- [ ] `/admin/outputs` 增加模板、方案、是否用户改 Prompt、AgentRun 链接、质量标注按钮。
- [ ] 任务详情顶部增加“质量复盘”按钮，不藏在账务或排障区域。
- [ ] 用户反馈可一键转质量复盘，带入反馈图片、任务 ID、用户说明。
- [ ] AgentRun 详情可以进入质量复盘模式。

页面布局：

- [ ] 左侧显示视频结果 / 首帧 / 参考素材对比。
- [ ] 中间显示用户需求、Agent Prompt、最终 Prompt、Prompt 差异、命中规则、素材来源。
- [ ] 右侧显示归因面板：问题类型、归因对象、证据、建议动作、处理状态。

结构化字段：

- [ ] 问题类型：角色变形、标志丢失、风格跑偏、镜头不对、分段断裂、Prompt 格式错误、Provider 随机失败。
- [ ] 归因对象：模板、上下文卡片、绑定图片、最终 Prompt、Provider、用户输入。
- [ ] 处理状态：待处理、已转优化、已修复、已回归验证。
- [ ] 复盘可写入 `TemplateMemory`，并能生成模板管理员优化待办。

涉及文件：

- `src/app/admin/quality-runs/page.tsx`
- `src/app/admin/quality-runs/[id]/page.tsx`
- `src/app/admin/outputs/AdminOutputsClient.tsx`
- `src/app/tasks/[id]/page.tsx`
- `src/app/admin/feedback/AdminFeedbackClient.tsx`
- `src/app/admin/agent-runs/[id]/page.tsx`
- `src/lib/templates/workbench.ts`
- `prisma/schema.prisma`，如需新增结构化复盘表需单独迁移规划

验收标准：

- [ ] 运营 30 秒内找到任务模板、方案和 AgentRun。
- [ ] 2 分钟内看清用户需求、最终 Prompt、素材、规则和模板版本。
- [ ] 5 分钟内完成结构化归因。
- [ ] 归因能写入 Memory。
- [ ] 模板管理员能看到待优化项。
- [ ] 改完模板后能用同类需求回归验证。

### Phase 8：系统管理员 API 状态与诊断

目标：API 设置不是“保存配置”，而是“确认 LLM 可用并能诊断失败”。

任务：

- [x] `/admin/integrations` Musk API 区增加“测试连接”按钮。
- [x] 测试连接验证 HTTP 成功、模型可用、JSON 返回、耗时、错误码。
- [ ] 保存后显示：已保存但未测试 / 已测试通过 / 测试失败。
- [ ] 显示最后测试时间、测试模型、测试耗时、最近错误。
- [ ] LLM 未配置时，模板工作台、模板创建向导、上下文卡片 LLM 对话全部禁用生成按钮并显示“去 API 设置”。
- [ ] 新增 `/admin/diagnostics`：显示 LLM API 状态、最近 LLM 失败、最近权限拒绝、最近 OperationLog、最近 AgentRun failed。
- [ ] 新增或补齐 `/admin/operation-logs`，系统管理员可查看谁改了 API、谁清除了 Key、谁改了用户角色。
- [ ] 失败的 LLM 调用也要形成可追踪诊断记录，不能只在前端 toast 失败。

涉及文件：

- `src/app/admin/integrations/AdminIntegrationsClient.tsx`
- `src/app/api/admin/integrations/musk/route.ts`
- `src/lib/integrations/musk.ts`
- `src/app/admin/diagnostics/page.tsx`
- `src/app/admin/operation-logs/page.tsx`
- `src/app/api/templates/module-builder/generate/route.ts`
- `src/app/api/templates/config-builder/generate/route.ts`

验收标准：

- [x] 系统管理员能在 API 设置页确认 Musk API 真实可用。
- [ ] LLM 未配置时用户不会点击后才失败。
- [ ] 失败原因能被后台追踪。
- [x] API Key、token、cookie 不出现在页面、日志、导出报告中。

### Phase 9：权限与角色拆分

目标：不要继续只有 `admin/user` 两档权限。

任务：

- [ ] 明确角色：普通用户、模板管理员、系统管理员、质量运营。
- [ ] 普通用户只能看已发布模板和自己的生成任务。
- [ ] 模板管理员只能维护自己负责的模板和模板级模块。
- [ ] 系统管理员可以配置 API、全局模块、全局规则、用户权限、所有诊断。
- [ ] 质量运营可查看产出、反馈、质量复盘和相关 AgentRun，但不一定能配置 API。
- [ ] 后台导航按角色显示，不把系统设置暴露给模板管理员。
- [ ] 后台 API 统一补权限 helper，避免新增页面漏写角色判断。

涉及文件：

- `src/lib/auth/*`
- `src/middleware.ts`
- `src/lib/navigation.ts`
- `src/components/SideNav.tsx`
- `src/app/api/templates/*`
- `src/app/api/admin/*`
- `prisma/schema.prisma`，如需角色扩展需单独迁移规划

验收标准：

- [ ] 普通用户访问后台 API 返回 403，未登录返回 401。
- [ ] 模板管理员不能编辑不属于自己的模板。
- [ ] 系统管理员能查看所有诊断和配置。
- [ ] 权限失败有明确提示，不泄露资源是否存在。

### Phase 10：验证、上线与回归

本轮是中大型 UI / API / 权限重构，不能只靠构建通过。

验证任务：

- [ ] `git diff --check`
- [ ] `npx tsc --noEmit --pretty false`
- [ ] `npm run lint`
- [ ] `npm run build`
- [ ] `npx impeccable detect` 覆盖模板库、模板生成、模板工作台、新建向导、质量复盘。
- [ ] 普通用户浏览器验收：`/templates` -> `/template-generate` -> 输入需求 -> 方案 -> 提交前检查。
- [ ] 管理员浏览器验收：`/admin/templates` -> 新建模板 -> 草稿 -> 素材 -> 规则 -> 试生成 -> 发布。
- [ ] 系统管理员验收：`/admin/integrations` 保存 Musk API -> 测试连接 -> LLM 入口状态同步。
- [ ] 质量运营验收：从跑偏任务进入质量复盘 -> 归因 -> 写入 Memory -> 生成优化待办。
- [ ] 权限验收：普通用户看不到模块库、AgentRun、Memory、API 设置。
- [ ] 线上闭环：`youdoo-sites build sd2`、`youdoo-sites restart sd2`、`youdoo-sites status sd2`、公网验证 `/templates`、`/template-generate`、`/admin/templates`、`/admin/integrations`。
- [ ] 跨健康守护周期复查 `sd2` 服务稳定。

Git / 发布规划：

- 当前生产目录：`/Volumes/Data/Projects/video-api-debugger-v12-full-todo`。
- 当前分支：`codex/v12-full-todo`。
- 当前工作区已有大量跨任务未提交改动；正式编码前必须先确认目标文件 diff，避免混入无线画布、通知中心、资产接口等无关改动。
- 建议按 Phase 分批提交：普通用户三步流、模板工作台、新建向导、上下文卡片编排器、卡片绑定图片、质量复盘、API 诊断、权限拆分。
- 每个 Phase 验证通过后单独登记 `/Volumes/Data/Projects/project-version-registry.md`。
- 稳定回退点建议：`rollback/2026-06-17-template-ux-redesign`。

停止条件：

- [ ] 如果需要数据库迁移，先停止编码，单独写 schema、迁移、回滚和数据兼容方案。
- [ ] 如果 LLM 测试会消耗付费额度，先做 dry-run 或最小请求，并明确授权边界。
- [ ] 如果真实生成会消耗费用，未获明确授权不得发起付费生成。
- [ ] 如果权限模型无法兼容现有用户，先做角色映射方案，不直接改生产权限。
- [ ] 如果线上部署会覆盖无关脏改，先做分支 / worktree / 聚焦提交隔离。

HARD-GATE：

- [x] 这是跨页面、权限、API、模板数据、LLM 状态和线上部署的中大型重设计。开始编码前，需要用户确认首个执行范围。建议先执行 Phase 1 + Phase 8 的 P0：普通用户三步流 + LLM 未配置前置提示。

## 历史记录：模板模块 LLM 生成器与 API 设置 Todo（已被上下文卡片版替代）

更新时间：2026-06-15

状态说明：

- 本节保留 2026-06-15 的历史实现与验收记录，用于回溯已做过的 Musk API、旧 Module Builder 和审计能力。
- 从 2026-06-17 起，新目标以“上下文卡片系统”为准；本节未完成项不得原样继续执行，必须迁移为上下文卡片、卡片 LLM 对话、卡片绑定图片、最终提示词影响预览等能力。
- 旧 `Module Builder / moduleType / promptBlock / rules / injectionMode / priority` 可以作为服务端兼容层或高级诊断信息，但不能回到管理员主界面。

问题定义：

- 模板生成能力不能藏在无导航入口的页面里；用户必须能从左侧导航直接进入模板生成工作台。
- 模板配置不应继续依赖纯手填字段，而要先落地“LLM 对话 + 结构化预览 + 人工确认”的 Module Builder 交互骨架。
- API 设置页必须有可见入口，并为 Musk API 预置 `https://api.muskapis.com/` 和默认模型 `gpt-5.4`。

已落地：

- [x] 左侧导航新增“模板生成”，直接进入 `/template-generate`。
- [x] 保留“动画模板”入口，用于模板库选择页 `/templates`，避免和模板生成工作台混淆。
- [x] 后台导航和总览快捷入口新增“API 设置”，`/admin/settings` 兼容跳转到 `/admin/integrations`。
- [x] API 设置页新增 Musk API 配置区，默认 Base URL 为 `https://api.muskapis.com/`，默认模型为 `gpt-5.4`。
- [x] 模板编辑抽屉的模块页签新增“LLM 配置模板”区域，可根据管理员描述生成模板配置结构化草稿，并一键应用到模板描述、模块和规则。
- [x] 模板编辑抽屉的模块页签新增“新增模块 / Module Builder”区域，包含模块类型选择、LLM 对话输入、默认折叠的“LLM生成规则设定”、结构化预览、重新生成和应用草稿。
- [x] `/template-generate` 主工作台新增显性“LLM 模板配置 / 新增模块”面板，不再只藏在模板编辑抽屉里。
- [x] 主工作台 Module Builder 面板包含模块类型、管理员和 LLM 对话、LLM生成规则设定、生成结果预览、生成/重新生成、复制 JSON、API 设置和打开模板编辑入口。
- [x] Module Builder 支持角色、Logo、风格、镜头、规则、素材带规则、Temporal 分段和提示词格式模块。
- [x] “提示词格式模块”复用现有视频生成 skills 的分镜提示词结构：总体要求、具体分镜、景别、动作、镜头运动、画面约束和输出格式。
- [x] 生成草稿不会直接入库，必须由管理员点击应用后进入待保存的模板编辑状态。

待继续：

- [x] 真实 LLM 草稿生成 P0 已完成：主工作台 Module Builder 已调用服务端 API，不再只是前端结构化草稿 UI。
- [ ] 正式模块保存、模块库版本化、管理员修改 diff、模板级 LLM Config Agent 仍未完成。

### 待落地：真实 Module Builder Agent

- [x] 新增服务端 LLM 配置读取层：从 `PlatformSetting` 读取 Musk API Base URL、API Key、默认模型 `gpt-5.4`、启用状态和调用超时。
- [x] 新增 Musk/OpenAI 兼容调用客户端：统一处理 `base_url`、`model`、`messages`、JSON schema 输出、超时、错误脱敏和重试边界。
- [x] 新增 Module Builder Agent 服务：输入管理员对话、模块类型、当前模板上下文、当前素材上下文、默认生成规则和本次生成规则。
- [x] Agent 必须强制输出结构化 JSON，至少包含 `moduleType`、`moduleName`、`promptBlock`、`rules`、`injectionMode`、`priority`、`target`、`assetBinding`。
- [x] Agent 必须支持模块类型：角色、Logo、风格、镜头、规则、素材带规则、Temporal 分段、提示词格式模块。
- [x] 提示词格式模块必须复用 sd2 视频生成 skill / 通用视频提示词格式：创意名编号、总述、连续分镜、景别、运镜、内容、`(end)`。
- [x] 缺少关键信息时，Agent 返回 `needsClarification=true` 和追问问题，不允许硬生成不可保存草稿。

### 待落地：API 与权限

- [x] 新增 `POST /api/templates/module-builder/generate`，只允许模板管理员和系统管理员调用。
- [ ] API 入参包含：`template_id`、`module_type`、`intent`、`session_rules`、`context_asset_ids`、`conversation_id`。
- [x] API 出参包含：结构化模块草稿、追问状态、模型调用摘要、脱敏错误、可保存性校验结果。
- [x] 普通用户不能调用生成模块 API，也不能编辑 LLM 生成规则设定。
- [ ] 模板管理员只能为自己负责的模板生成 / 编辑模块；系统管理员可以生成全局模块和编辑默认生成规则。
- [x] Musk API 未配置、未启用、缺少 API Key、模型为空或返回非 JSON 时，必须给出明确错误，不写入模块库。

### 待落地：前端接入真实调用

- [x] `/template-generate` 主工作台的 LLM Builder 面板从本地 mock 生成改为调用真实 `POST /api/templates/module-builder/generate`。
- [ ] 模板编辑抽屉里的 LLM 配置模板 / 新增模块也改为调用同一个服务端 API，不保留两套生成逻辑。
- [x] UI 增加真实状态：等待 LLM、追问信息、生成失败、JSON 校验失败、可保存、管理员已修改。
- [ ] 生成结果预览支持结构化编辑，而不是只展示纯 JSON 文本。
- [ ] “保存模块”必须保存的是管理员确认后的结构，不允许 LLM 结果直接入库。
- [ ] 保存前必须展示差异：LLM 原始草稿 vs 管理员修改后草稿。

### 待落地：模块库 / 素材规则库 / 版本化

- [ ] 设计并落地正式模块保存接口：保存角色模块、Logo 模块、风格模块、镜头模块、规则模块、素材带规则模块、Temporal 模块、提示词格式模块。
- [ ] 模块保存后可被模板引用，模板模块绑定使用正式模块 ID，而不是只写文本字段。
- [ ] 素材带规则模块保存到素材规则库，能绑定素材 ID、用途、规则、注入方式和优先级。
- [ ] 模块版本化：每次保存生成新版本，保留 `draft`、`active`、`archived` 状态。
- [ ] 支持从模板详情查看模块版本记录、回滚和对比。

### 待落地：Memory / 审计 / 复盘

- [ ] 保存模块时写入 Memory / 审计记录：创建人、创建时间、模板 ID、模块类型、生成规则、管理员输入、LLM 原始输出、管理员最终保存结构。
- [ ] 审计记录必须标记是否被管理员修改过，并保存修改 diff 或等价结构化对比。
- [ ] OperationLog 记录 `module_builder_generate`、`module_builder_save`、`module_builder_update_rules`、`module_builder_reject`。
- [x] Agent Run / Trace 页面能查看 Module Builder 的输入、输出、规则命中、错误和保存结果。
- [ ] 审计内容必须脱敏，不记录 API key、token、cookie 或敏感凭据。

### 待落地：验证与上线验收

- [ ] 单元 / 集成测试覆盖：Musk 配置读取、LLM JSON 解析、非 JSON 错误、权限拒绝、追问分支、保存前人工确认。
- [ ] API smoke：未登录 401、普通用户 403、模板管理员 200、Musk 未配置明确失败、模拟 LLM 返回结构化草稿。
- [ ] 前端 smoke：管理员在 `/template-generate` 输入兔子 IP 需求，能看到真实 API 返回的结构化草稿。
- [ ] 保存 smoke：管理员确认后保存模块，模板能引用该模块，重新进入页面仍能看到模块。
- [ ] 审计 smoke：保存后能查到创建人、输入、规则、LLM 输出、最终结构和修改标记。
- [x] 部署验收：`tsc`、`lint`、`build`、`youdoo-sites build/restart/status sd2` 通过，公网验证 `/template-generate` 主工作台真实调用接口。

验收记录：

- [x] `./node_modules/.bin/tsc --noEmit --pretty false` 通过。
- [x] `git diff --check` 通过。
- [x] `youdoo-sites build sd2` 通过，生产构建 `BUILD_ID=7XsQ7H1f8gvdA3ApNPsWo`。
- [x] `youdoo-sites restart sd2` 后公网 `/template-generate` 返回 200。
- [x] 公网 layout chunk 命中 `模板生成`、`/template-generate`、`API 设置`、`/admin/settings`。
- [x] 生产 server bundle 命中 `LLM 配置模板`、`Module Builder`、`LLM生成规则设定`。
- [x] 公网 `/api/admin/integrations/musk` 未登录返回 401，公网 `/admin/settings` 未登录 307 跳转登录。
- [x] 跨健康守护周期后 `status sd2` 仍 OK，LaunchAgent `runs=58` 未增长。
- [x] 2026-06-15 追加验证：公网 `/template-generate` 加载 `page-4516379bf9413f43.js`；公网 JS/CSS 命中 `template-llm-builder`、`Module Builder`、`draft_requires_admin_review`、`prompt_format`。
- [x] 2026-06-15 真实 LLM P0 验证：当前开发目录 `npx tsx scripts/module-builder-agent-smoke.ts`、`./node_modules/.bin/tsc --noEmit --pretty false`、`git diff --check`、`npm run lint`、`npx impeccable detect ...`、`npm run build` 通过；线上运行目录 `youdoo-sites build sd2` 通过，`.next-prod/BUILD_ID=BIS0m47He12PEqUzMiqLZ`，`youdoo-sites restart/status sd2` OK；公网 `POST /api/templates/module-builder/generate` 未登录 401，公网 `/api/admin/integrations/musk` 未登录 401，公网静态 chunk 命中 `/api/templates/module-builder/generate`、`LLM 生成中`、`查看生成链路`、`Module Builder Agent`、`api_key_configured`、`clear_api_key`、`缺少 API Key`、`gpt-5.4`。

## 动画模板选择页 Todo

更新时间：2026-06-14

第一性原理：

- 这不是生成页、模板编辑页或 Agent 调试页，而是模板生成流程的前置决策页。
- 用户进入这个页面时，核心问题是“我该选哪个动画模板开始生成”。
- 页面必须让用户先看到模板画面、适用场景和使用入口，再按需查看结构、规则、素材和管理员配置。
- 普通生成 `/generate` 与模板生成 `/template-generate` 必须保持分离；模板选择页只负责选择模板并把用户送入模板生成工作台。

实现闭环：

- [x] `/templates` 改为动画模板选择页，不再直接跳转模板生成工作台。
- [x] 新增截图优先模板卡、搜索、场景筛选、状态筛选、右侧预览和“使用此模板”主按钮。
- [x] 缺少真实截图时显示稳定 16:9 占位，避免模板列表布局跳动。
- [x] 管理员编辑入口保留在预览区，普通用户主路径不暴露 Prompt、规则和 Trace 等低频配置。
- [x] `/template-generate?templateId=<id>` 已接入模板预选；无效模板会回退默认模板并提示。
- [x] 导航新增“动画模板”，模板生成工作台顶部新增“返回模板库”。

验收标准：

- [x] 用户 3 秒内能判断当前页面是“选择动画模板”。
- [x] 点击模板卡片只更新预览，不直接跳转，便于比较。
- [x] 点击“使用此模板”进入 `/template-generate?templateId=<id>`。
- [x] 普通 `/generate` 不承载模板选择主流程。
- [x] 部署后从 `https://sd2.youdoodesign.com/templates` 公网验证页面和新静态资源已加载。

## Smoke Project 自动合并与项目去重 Todo

更新时间：2026-06-14

问题定义：

- 本地只读统计发现当前 `Project` 表存在 19 个 active/team 的 `Smoke Project ...`。
- 这些项目不是 `scripts/project-ui-smoke.ts` 产生的；该脚本只读检查 `/api/projects`。
- 真实来源是 `scripts/workbench-closure-smoke.ts`，它每次运行都会 `POST /api/projects` 创建随机命名的 `Smoke Project ${randomSuffix()}`，但脚本结束后没有清理，也没有复用固定测试项目。
- 当前 19 个 Smoke Project 下已有 14 条 `VideoTask`、11 张 `VideoCard`、19 个 `CanvasDocument`、50 条 `CostLedger`、36 条 `CostAllocation`。因此不能直接批量删除，只能走“合并迁移 + 审计留痕 + 源项目归档/删除”的闭环。

目标：

- 管理员不再看到一堆测试项目散落在项目列表里。
- 后续 smoke 测试默认复用一个固定项目，不再持续制造 `Smoke Project ...`。
- 历史 Smoke Project 可安全合并到一个目标项目，任务、视频卡、画布、成本归属和成员关系都能闭环迁移。
- 合并前必须提供 dry-run 预览；合并后保留操作日志和迁移审计，支持回查“哪些项目被合并到哪里”。

### 方案选择

- [x] 不推荐“直接删除所有 Smoke Project”：有任务、视频卡、画布和成本账本，删除会破坏历史结果、项目成本和视频卡入口。
- [x] 不推荐“只把项目改名”：列表会少一点，但任务/成本仍散在多个项目，后续项目统计仍被污染。
- [x] 推荐“固定测试项目 + 历史项目合并”：新 smoke 只进固定项目；旧 smoke 通过后台合并工具迁移到目标项目。

### 第一阶段：阻止继续产生垃圾项目

- [x] 修改 `scripts/workbench-closure-smoke.ts`。
- [x] 新增环境变量 `SMOKE_PROJECT_ID`：传入时直接复用该项目，不再创建新项目。
- [x] 新增环境变量 `SMOKE_PROJECT_NAME`：没有 `SMOKE_PROJECT_ID` 时，按固定名称查找或创建，例如 `Smoke Project Archive`。
- [x] 默认行为从“每次随机新建项目”改成“复用固定 smoke 项目”；只有显式设置 `SMOKE_CREATE_UNIQUE_PROJECT=1` 时才允许创建随机项目。
- [x] 脚本输出里标明 `projectMode=reused | created | unique`，方便日志审计。
- [ ] 验证命令：`BASE_URL=http://localhost:3000 npx tsx scripts/workbench-closure-smoke.ts`，预期不会新增随机 `Smoke Project ...`。

### 第二阶段：项目合并后端能力

- [x] 新增项目合并服务：`src/lib/projects/merge.ts`。
- [x] 服务导出 `previewProjectMerge(sourceProjectIds, targetProjectId)`。
- [x] 服务导出 `mergeProjects({ sourceProjectIds, targetProjectId, actorUserId, reason, mode })`。
- [x] preview 返回每个源项目的任务数、视频卡数、画布数、图集数、参考图数、成本账本数、成本分摊数、成员数、预算账户状态和阻断原因。
- [x] merge 必须在单个事务内执行，避免迁移一半失败后账实不一致。
- [x] `VideoTask.project_id` 迁移到目标项目。
- [x] `VideoCard.project_id` 迁移到目标项目。
- [x] `CanvasDocument.project_id` 迁移到目标项目。
- [x] `ReferenceAlbum.project_id` 迁移到目标项目。
- [x] `ReferenceImage.project_id` 迁移到目标项目。
- [x] `ProviderApiRequest.project_id` 迁移到目标项目。
- [x] `ApprovalRecord.project_id` 迁移到目标项目。
- [x] `ContentAuditLog.project_id` 迁移到目标项目。
- [x] `CostLedger.project_id` 和 `CostAllocation.project_id` 迁移时复用 `src/lib/costs/ledger.ts` 的 `recordTaskProjectTransfer` 或等价审计语义，不能静默改账本归属。
- [x] `ProjectMember` 合并时按用户去重：目标已有成员则保留权限更高的角色，源项目成员只作为审计信息记录，不重复插入。
- [x] 源项目合并后状态改为 `archived` 或 `deleted`，推荐第一版用 `archived`，备注写入 `description` 或 `OperationLog`，避免误删。
- [x] 禁止把 `personal`、`system`、目标项目自身、已 deleted 项目作为源项目。
- [x] 禁止合并到 `deleted` 或无权限管理的目标项目。
- [x] 如果源项目存在 `ProjectBudgetAccount` 或 `ProjectBudgetLedger`，第一版先阻断合并，后续单独设计预算合并。

### 第三阶段：管理员项目管理页交互

- [x] 修改 `src/app/admin/projects/AdminProjectsClient.tsx`，增加批量选择列。
- [x] 表格顶部增加搜索框，支持快速搜索 `Smoke Project`。
- [x] 表格顶部增加筛选：全部、活跃、归档、空项目、疑似测试项目。
- [x] 疑似测试项目规则第一版：项目名匹配 `/\\bSmoke Project\\b/i` 或 description 包含 `closure smoke`。
- [x] 勾选多个项目后显示批量操作栏。
- [x] 批量操作栏提供“合并到项目”按钮。
- [x] 点击“合并到项目”后使用右侧抽屉，不使用浏览器 `window.confirm`。
- [x] 抽屉第一步选择目标项目，默认推荐 `Smoke Project Archive`；如果不存在，引导先创建。
- [x] 抽屉第二步展示 dry-run 预览：源项目数量、任务、视频卡、画布、成本账本、成员冲突、预算阻断。
- [x] 抽屉第三步输入合并原因，并二次确认。
- [x] 合并成功后刷新列表，源项目进入归档区，目标项目数据计数增加。
- [x] 空 Smoke Project 可以走快速删除，但仍要二次确认并记录 `project_delete` 操作日志。

### 第四阶段：项目合并 API

- [x] 新增 `POST /api/admin/projects/merge/preview`。
- [x] 入参：`source_project_ids: string[]`、`target_project_id: string`。
- [x] 返回 dry-run 汇总、逐项目明细和阻断原因。
- [x] 新增 `POST /api/admin/projects/merge`。
- [x] 入参：`source_project_ids: string[]`、`target_project_id: string`、`reason: string`、`confirm: true`。
- [x] 仅 admin 可调用；普通项目 owner 第一版不开放跨项目合并。
- [x] API 必须拒绝空 reason、源项目为空、源项目包含目标项目、源项目包含 personal/system/deleted。
- [x] API 成功后写 `OperationLog`：`project_merge_preview`、`project_merge_apply`。

### 第五阶段：历史 Smoke Project 一次性清理脚本

- [x] 新增 `scripts/merge-smoke-projects.ts`。
- [x] 默认 dry-run，只输出候选源项目、目标项目、迁移影响和阻断项。
- [ ] 参数：
  - `--target <projectIdOrName>`
  - `--pattern "Smoke Project"`
  - `--apply`
  - `--reason "合并历史 smoke 测试项目"`
- [x] dry-run 输出必须包含：source project id/name、任务、视频卡、画布、成本账本、成本分摊、是否空项目、是否可快速删除。
- [x] apply 前要求数据库备份路径存在，例如 `BACKUP_CONFIRMED=1`。
- [x] apply 后输出迁移数量和源项目归档数量。

### 数据口径与交互规则

- [x] 合并后的任务仍保留原 `VideoTask.created_at`、`owner_user_id`、`user_id`、`source_request_id`，不能因为项目迁移改变生成者。
- [x] 合并后的成本仍保留原发生时间和 Provider task id。
- [x] 项目详情页按新目标项目展示迁移后的任务、视频卡、画布和成本。
- [x] 源项目归档后只读可查，提示“已合并到 xxx”，不允许继续生成。
- [x] 项目列表默认隐藏已合并归档项目，但管理员可在归档筛选中查看。
- [x] 搜索 `Smoke Project` 时能定位历史源项目和目标归档项目。

### 验收标准

- [ ] 运行 smoke 脚本两次，不再新增两个随机 `Smoke Project ...`。
- [x] 管理员项目页能筛出所有疑似 Smoke Project。
- [x] 合并预览能正确显示当前本地样本：19 个项目、14 条任务、11 张视频卡、19 个画布、50 条成本账本、36 条成本分摊。
- [x] 对带预算账户的项目，第一版明确阻断，不执行半合并。
- [x] 对空 Smoke Project，支持二次确认后快速删除。
- [x] 对有内容的 Smoke Project，合并后任务、视频卡、画布、成本都出现在目标项目。
- [x] 源项目归档，不再出现在默认 active 项目列表。
- [x] `OperationLog` 能查到合并发起人、原因、源项目、目标项目和迁移计数。
- [x] `npm run lint`、`npx tsc --noEmit --pretty false`、`npm run build` 通过。
- [ ] 本地 dry-run 和 apply smoke 通过后，再部署 `sd2` 并用管理员页面刷新验证。

## 资产管理页 Todo：即梦式资产库 + 项目/用户维度 + 框选批量操作

更新时间：2026-06-14

闭环状态：

- [x] 产品规划闭环：已明确页面定位、一级分类、权限边界、排序/分组、卡片展示、框选/多选和批量动作设计。
- [x] 数据复用闭环：确认应复用 `VideoTask`、`Asset`、`ReferenceImage`、`Project`、`User`、`/api/video/thumbnail/[id]`、`/api/video/play/[id]`、`downloadBulkVideoZip`、`getTaskWhereForUser`、`getAdminUser`。
- [ ] 代码实现未闭环：尚未新增 `/assets` 页面、统一资产库 API、框选选择状态、批量移动接口和批量下载入口。
- [ ] 验证未闭环：尚未完成桌面框选、多选、管理员用户筛选、批量动作和移动端长按选择的端到端验证。

目标：新增一个类似即梦资产页观感的统一资产管理页，但分类按本项目业务组织，不照搬“图片 / 视频 / 音频 / 文档”。页面既用于用户查看自己的生产资产，也用于管理员按用户审计和批量处理。

### 页面入口与定位

- [ ] 新增 `/assets` 页面，作为统一资产管理入口。
- [ ] 将现有 `/videos` 从重定向 `/tasks` 改为重定向 `/assets?type=video`。
- [ ] 页面标题使用“资产管理”或“资产库”，避免与任务列表混淆。
- [ ] 普通用户默认进入 `生产历史 / 视频 / 按时间 / 最近生成`。
- [ ] 管理员默认进入同样视图，但额外看到 `按用户查看` 一级分类。

### 一级分类

- [ ] `生产历史`：当前用户可见的生成资产，默认按日期分组。
- [ ] `按项目`：按用户有权限访问的项目筛选资产，可选择“全部项目”或指定项目。
- [ ] `按用户查看`：仅管理员可见，支持用户下拉菜单，默认“全部用户”。

### 类型筛选

- [ ] `全部`：视频产出、上传资产、参考素材的统一视图。
- [ ] `视频`：来自 `VideoTask` 的生成结果。
- [ ] `图片`：来自 `Asset` 的上传图片。
- [ ] `参考素材`：来自 `ReferenceImage` / 图集的素材。
- [ ] `已隐藏/已删除`：仅管理员可见，用于审计 `retention_status`。

### 排序、分组与筛选

- [ ] 排序支持：最近生成、最早生成、最近完成、项目名称、用户名称（管理员）、时长。
- [ ] 分组支持：按时间、按项目、按用户（管理员）。
- [ ] 筛选支持：项目、状态、比例、清晰度、关键词。
- [ ] 关键词搜索至少覆盖：prompt、task id、provider task id、项目名、用户显示名。

### 卡片展示

- [ ] 网格卡片采用参考图的暗色横向卡片风格。
- [ ] 视频卡片固定 16:9 容器，竖版视频居中显示，两侧保留深色留白。
- [ ] 左下角显示时长，例如 `00:06`、`00:15`。
- [ ] hover 显示播放按钮、项目名、创建时间、prompt 摘要。
- [ ] 管理员模式 hover 额外显示用户名称。
- [ ] 点击卡片默认打开右侧详情抽屉。
- [ ] 详情抽屉展示播放器、prompt、模型、比例、时长、清晰度、项目、创建用户、创建/完成时间、下载、复用参数、加入图集、隐藏/恢复等操作。

### 选择与框选交互

- [ ] 每张卡片左上角提供复选框。
- [ ] 点击复选框：选中 / 取消选中。
- [ ] `Cmd/Ctrl + 点击卡片`：多选切换。
- [ ] `Shift + 点击卡片`：从上次锚点到当前卡片做范围选择。
- [ ] 在网格空白区域拖动鼠标：显示框选矩形，框内卡片进入选中预览。
- [ ] 鼠标释放后提交框选结果。
- [ ] 默认框选替换当前选择；按住 `Cmd/Ctrl` 时追加到当前选择。
- [ ] 进入多选状态后，普通点击卡片改为切换选中，不再打开详情。
- [ ] 双击卡片或点击卡片上的“查看”按钮仍可打开详情。
- [ ] 移动端不做鼠标框选；长按卡片进入选择模式，点击切换选中。

### 批量操作栏

- [ ] 当 `selectedIds.size > 0` 时显示顶部批量操作栏。
- [ ] 批量栏显示：已选数量、可下载数量、涉及项目数、涉及用户数（管理员）。
- [ ] 操作按钮第一阶段支持：取消选择、下载视频、移动到项目。
- [ ] 管理员额外支持：隐藏、恢复。
- [ ] 第二阶段支持：加入图集、批量移除、批量改可见性。
- [ ] 下载按钮文案显示真实可下载数量，例如 `下载视频（9/12）`。
- [ ] 对跨项目、跨用户批量移动/隐藏增加二次确认。

### 统一资产 API

- [ ] 新增 `GET /api/assets/library`。
- [ ] 查询参数：
  - `scope=history | project | user`
  - `type=all | video | image | reference`
  - `project_id=`
  - `owner_user_id=`，仅管理员
  - `status=succeeded | running | failed | hidden`
  - `group_by=date | project | user`
  - `sort=created_desc | created_asc | completed_desc | project | user | duration`
  - `cursor=`
  - `limit=`
- [ ] 返回统一 item id，格式为 `video_task:<taskId>`、`asset:<assetId>`、`reference_image:<referenceImageId>`。
- [ ] 返回字段统一为：
  - `id`
  - `kind`
  - `source`
  - `taskId`
  - `assetId`
  - `title`
  - `prompt`
  - `thumbnailUrl`
  - `previewUrl`
  - `downloadUrl`
  - `duration`
  - `ratio`
  - `status`
  - `createdAt`
  - `completedAt`
  - `project`
  - `owner`
- [ ] 权限规则必须复用现有 `getTaskWhereForUser`、项目权限和管理员校验，不得直接暴露全量资产。

### 批量动作 API

- [ ] 新增 `POST /api/assets/library/bulk-download` 或复用现有批量下载客户端能力并补齐统一入参。
- [ ] 新增 `POST /api/assets/library/bulk-move`。
- [ ] 第二阶段新增 `POST /api/assets/library/bulk-add-to-album`。
- [ ] 管理员第二阶段新增 `POST /api/assets/library/bulk-hide`。
- [ ] 管理员第二阶段新增 `POST /api/assets/library/bulk-restore`。
- [ ] 批量接口入参使用统一资产 id：`item_ids: string[]`。
- [ ] 后端按 `video_task`、`asset`、`reference_image` 拆分并逐项做权限校验。

### 前端状态设计

- [ ] 定义统一选择 id 类型：

```ts
type AssetLibraryItemId =
  | `video_task:${string}`
  | `asset:${string}`
  | `reference_image:${string}`;
```

- [ ] 维护选择状态：

```ts
type SelectionState = {
  selectedIds: Set<AssetLibraryItemId>;
  anchorId: AssetLibraryItemId | null;
  mode: 'idle' | 'selecting';
};
```

- [ ] 基于 `selectedIds` 计算 `selectedCount`、`downloadableCount`、`movableCount`、`projectCount`、`ownerCount`。
- [ ] 选择状态和筛选/分页切换的关系要明确：切换一级分类、类型或用户时默认清空选择。

### 第一阶段 MVP 验收

- [ ] 普通用户访问 `/assets` 能看到类似参考图的暗色卡片网格。
- [ ] 生产历史按日期分组展示已完成视频。
- [ ] 按项目能筛选项目资产。
- [ ] 管理员能看到 `按用户查看` 并用下拉菜单筛用户。
- [ ] 单选、多选、`Shift` 范围选择、鼠标框选可用。
- [ ] 批量栏能正确显示已选数量和可下载数量。
- [ ] 批量下载视频可用，并遵守现有 `BULK_VIDEO_DOWNLOAD_CLIENT_LIMIT`。
- [ ] 批量移动到项目可用，并对无权限项目禁用。
- [ ] 页面移动端可浏览，长按进入选择模式。
- [ ] 不触碰 `.env`、密钥、Provider token 或数据库危险写入。

## Seedance 2.0 模板驱动 Agent 视频生成系统总控 Todo

更新时间：2026-06-14

目标：在现有 Seedance 生成能力上，落地“模板驱动 + Agent 辅助 + 规则约束”的智能生成工作台。用户日常只看到“模板 + 输入需求 + 选择方案 + 生成”，系统复杂度隐藏在后台，不把产品做成 Agent 控制台、Prompt 编辑器或后台系统。

### 当前代码定位

- `/generate` 当前由 `src/app/generate/page.tsx` 承载，负责项目/视频卡选择、最近任务、复用草稿和提交状态。
- 生成输入区当前由 `src/components/GenerationComposer.tsx` 承载，已有参考图、图集、Prompt 输入、Seedance 参数、1080p 审批提示和提交入口。
- 本轮已落地：新增独立 `/template-generate` 模板生成页；`/templates` 改跳转到独立模板生成页；普通 `/generate` 默认不显示模板工作台。
- 本轮已落地：模板编辑抽屉按 `模块 / 规则 / 资产` 重构，支持模块预览、素材缩略图、规则逐条新增/编辑/删除/启停/优先级。
- 本轮已落地：Agent 执行链路详情改为 9 步 Trace，支持复制 Trace ID、导出脱敏报告、自动刷新、规则命中、输入输出对比和时间线耗时。
- 本轮已落地：模板生成最近任务保持截图第一视觉入口，并在管理员态提供直达执行链路入口。
- 本轮已闭环：`sd2.youdoodesign.com/template-generate` 线上部署、公网页面和静态资源验证完成；登录态视觉走查可继续在真实账号下复核。
- Prompt 编辑当前由 `src/components/PromptEditor.tsx` 承载，已有 `@图片N` mention 和放大编辑。
- 画布页已有轻量 Agent 卡入口，位置在 `src/components/canvas/full/nodes.tsx`，但它不是本 PRD 的主入口。
- `/templates` 当前在 `src/app/templates/page.tsx` 直接重定向到 `/generate`；模板管理第一版已通过 `/generate` 内管理员右侧抽屉承载。
- Seedance 创建任务链路在 `src/app/api/tasks/create/route.ts`，当前负责 Prompt 引用校验、素材渲染、项目/视频卡校验、计费冻结和 Provider 提交。
- `prisma/schema.prisma` 已新增模板、模块绑定、规则集合、Agent 执行链路和 Memory 的专用简化模型；本地 DB 已备份后手动应用本次新增迁移 SQL。

### 产品边界

- [x] 生成主页面是唯一日常用户入口，不新增复杂工作台作为主路径。
- [x] 模板编辑只做管理员右侧抽屉，不做独立大后台页面。
- [x] 执行链路查看页只给管理员调试，不暴露给普通用户。
- [x] 第一版不引入 AST、复杂规则引擎、复杂 Temporal 编排或多 Agent 控制台。
- [x] 保留现有生成能力、项目/视频卡绑定、参考图、图集、最近任务、审批提示和 Seedance 参数，不因重构删除原功能。

### 成功标准

- [x] 用户能选择模板，看到角色、Logo、规则摘要和固定素材。
- [x] 用户输入本次需求并选择快捷微调后，系统生成 A/B/C/D 4 个方案。
- [x] 用户选择一个方案后，得到可编辑 Prompt 预览。
- [x] 最终生成仍走现有 Seedance 任务创建链路，并记录模板、方案、Prompt 和执行链路。
- [x] 管理员能在生成页右侧抽屉编辑模板基础信息、模块绑定、素材、专属提示词、规则和 Temporal 策略。
- [x] 管理员能查看一次生成从 Intent 到 Memory 的每一步输入/输出、命中规则、使用模块和 Prompt 变化。
- [ ] 所有页面改动上线后，刷新 `sd2.youdoodesign.com/generate` 即可看到新效果。

### PRD 对齐清单

**产品定位：**

- [x] 最终产品定义为“模板驱动的 AI 视频生成工作台”。
- [x] 用户看到的是：模板 + 输入 + 方案 + 生成。
- [x] 系统背后才是：模块 + 规则 + Agent + Temporal + Memory。
- [x] 不把第一版做成 AI 视频后台系统、Prompt 编辑器或 Agent 控制台。

**页面层级：**

- [x] 页面一：生成主页面，是用户唯一日常使用页面，优先级最高。
- [x] 页面二：模板编辑抽屉，是管理员从生成页右侧滑出的编辑器，不做独立主页面。
- [x] 页面三：执行链路查看页，是管理员调试页，普通用户不可见。

**生成主页面必须按以下信息顺序组织：**

- [x] 当前模板区：模板名称、版本、状态、切换和管理员编辑入口。
- [x] 模板自动加载信息：角色、Logo、规则摘要、固定素材。
- [x] 本次需求输入区：用户只描述本次视频需求。
- [x] 快速调节需求：更科技、更快、更品牌等可选 modifier。
- [x] Agent 生成方案区：A/B/C/D 四个方案。
- [x] Prompt 预览区：可编辑，可回退到 Agent 原始 Prompt。
- [x] Seedance 生成参数和生成按钮。
- [x] 最近任务列表。

**最小核心数据结构：**

- [x] `Template` 至少表达 `templateId`、模块绑定 `character/logo/style/camera`、`rules.must/forbid/suggest`、`temporal.enabled`、`temporal.segment=15`。
- [x] 用户输入至少表达 `{ text, modifiers }`，不要求用户直接写完整专业 Prompt。
- [x] Agent 输出至少表达 `{ plans: [A, B, C, D], prompt, selectedPlan }`。
- [x] 任务快照必须能追溯 templateId、selectedPlan、Agent 原始 Prompt、用户最终 Prompt 和 agentRunId。

**核心流程：**

- [x] Template 加载。
- [x] 模块自动绑定。
- [x] 用户输入需求。
- [x] Agent 生成 4 个方案。
- [x] 用户选择方案。
- [x] Prompt 生成并允许编辑。
- [x] Seedance 执行。
- [x] 结果与 Memory 回写。

**权限：**

- [x] 普通用户只能使用模板、输入需求、选择方案和生成视频。
- [x] 管理员才能编辑模板、修改模块绑定、调整规则、编辑提示词和查看执行链路。

**产品原则：**

- [x] 模板优先，不以自由 Prompt 作为主路径。
- [x] Agent 辅助，不替代用户选择。
- [x] 规则控制稳定性。
- [x] 模块控制角色、Logo、风格和镜头一致性。
- [x] Temporal 只解决长视频分段问题，不扩展成复杂时序系统。
- [x] 系统复杂度隐藏在后台，前台保持可理解、可选择、可生成。

### Batch 0：设计收敛、数据口径和 Git 保护

目标：先锁定简单产品结构，避免再次系统过度设计。

**主要文件：**

- `tasks/todo.md`
- `tasks/lessons.md`
- 只读调研：`src/app/generate/page.tsx`
- 只读调研：`src/components/GenerationComposer.tsx`
- 只读调研：`src/app/api/tasks/create/route.ts`
- 只读调研：`prisma/schema.prisma`

**任务：**

- [x] 确认第一版只做 3 层：生成主页面、模板编辑抽屉、执行链路查看页。
- [x] 确认模板字段和 Agent 输出字段只满足 PRD 7.1-7.3，不引入 AST/复杂 DSL。
- [x] 开始实现前再次执行 `git status --short --branch`，保护现有未提交改动。
- [x] 如需数据库变更，先备份 SQLite，再设计最小 Prisma schema。
- [x] 先完成 UI 信息架构草图和交互状态，再写代码。

**验收：**

- [ ] 用户确认 Batch 1-7 的范围和优先级。
- [ ] 明确第一版不做复杂系统能力。

### Batch 1：最小数据模型与 API 底座

目标：给模板、模块、规则、方案、执行链路和记忆建立最小可用结构。

**预计主要文件：**

- `prisma/schema.prisma`
- 新增 `src/lib/templates/*`
- 新增 `src/lib/agent-plans/*`
- 新增 `src/lib/template-memory/*`
- 新增 `src/app/api/templates/*`
- 新增 `src/app/api/agent/template-plans/route.ts`
- 新增 `src/app/api/agent/runs/[id]/route.ts`

**任务：**

- [x] 新增 `GenerationTemplate`：名称、描述、状态、版本、默认 ratio/duration/resolution、Temporal 开关、15s segment 默认值。
- [x] 新增 `TemplateModuleBinding` 或等价 JSON 字段：character、logo、style、camera、rules 模块绑定。
- [x] 新增 `TemplateAsset` 或复用 `ReferenceImage/ReferenceAlbum` 绑定固定素材：角色参考图、Logo、风格参考图。
- [x] 新增 `TemplateRule`：`must/forbid/suggest`、优先级、状态、排序。
- [x] 新增 `TemplatePromptBlock`：Character Prompt、Logo Prompt、Style Prompt、Global Prompt。
- [x] 新增 `AgentRun` 和 `AgentRunStep`：记录 Intent 解析、模板加载、模块组合、规则计算、方案生成、Prompt 输出、Seedance 执行、Memory 记录。
- [x] 新增 `TemplateMemory`：只记录模板维度的轻量反馈、成功/失败摘要、用户选择偏好，不记录敏感内容。
- [x] `VideoTask` 或 `GenerationTaskSnapshot` 关联 templateId、selectedPlan、agentRunId 和 finalPrompt 快照。

**验收：**

- [x] Prisma validate / generate 通过。
- [x] 模板 CRUD API 能创建、读取、更新、停用模板。
- [x] Agent run API 能读到完整执行链路。
- [x] 不读取、不打印 `.env`、token、cookie 或 Provider 密钥。

### Batch 2：生成主页面信息架构重构

目标：把 `/generate` 收敛为“模板驱动的视频生成工作台”。

**预计主要文件：**

- `src/app/generate/page.tsx`
- `src/components/GenerationComposer.tsx`
- `src/components/PromptEditor.tsx`
- 新增 `src/components/templates/TemplateHeader.tsx`
- 新增 `src/components/templates/TemplateLoadedSummary.tsx`
- 新增 `src/components/agent/AgentPlanCards.tsx`
- 新增 `src/components/agent/PromptPreviewPanel.tsx`
- `src/app/globals.css`

**任务：**

- [x] 顶部增加当前模板区：模板名、版本、状态、切换入口、管理员编辑入口。
- [x] 增加模板自动加载信息：角色、Logo、规则摘要、固定素材缩略图。
- [x] 将“本次需求输入”作为主输入，不再让用户先面对复杂 Prompt。
- [x] 增加快捷微调：更科技、更快节奏、更品牌、更产品、更情绪化等可配置选项。
- [x] 增加 Agent 生成方案区：A/B/C/D 四个方案卡，展示方向、结构、适用场景、风险提示。
- [x] 增加 Prompt 预览区：用户选中方案后生成，可编辑，可恢复到 Agent 版本。
- [x] Seedance 参数区保留现有 ratio/duration/resolution/seed/audio/watermark 等能力，但视觉层级降低。
- [x] 最近任务保留，并显示模板、方案、视频卡和缩略图。
- [x] 移动端保持单列流程：模板 -> 需求 -> 方案 -> Prompt -> 参数 -> 生成。

**验收：**

- [x] 普通用户能不写专业 Prompt 完成一次从模板到生成提交前的完整操作。
- [x] 未选择方案时不能误提交空 Prompt。
- [x] 现有项目/视频卡、参考图、图集、最近任务和复用草稿不退化。
- [x] `/generate` 移动端无横向溢出，关键按钮不被遮挡。

### Batch 3：模板编辑抽屉（管理员）

目标：管理员在生成页直接维护模板，不跳转到复杂后台。

**预计主要文件：**

- 新增 `src/components/templates/TemplateEditorDrawer.tsx`
- 新增 `src/components/templates/TemplateModuleBindingEditor.tsx`
- 新增 `src/components/templates/TemplateRuleEditor.tsx`
- 新增 `src/components/templates/TemplateAssetBinder.tsx`
- `src/app/generate/page.tsx`
- `src/app/api/templates/[id]/route.ts`
- `src/app/globals.css`

**任务：**

- [x] 抽屉支持基础信息：名称、描述、状态、版本。
- [x] 抽屉支持模块绑定：Character、Logo、Style、Camera、Rules。
- [x] 抽屉支持固定素材：角色参考图、Logo 资源、风格参考图。
- [x] 抽屉支持专属提示词：Character Prompt、Logo Prompt、Style Prompt、Global Prompt。
- [x] 抽屉支持规则编辑：MUST、FORBID、SUGGEST、优先级、排序、启停。
- [x] 抽屉支持 Temporal 简化策略：分段 ON/OFF、默认 15s、是否启用帧传递。
- [x] 抽屉保存前做字段校验，保存后刷新当前模板摘要。

**验收：**

- [x] 非管理员看不到编辑入口。
- [x] 管理员修改模板后，生成主页面模板摘要立即反映最新配置。
- [x] 关闭抽屉不丢未保存改动，离开前有确认。

### Batch 4：Agent 方案生成与 Prompt 合成

目标：Agent 只辅助生成方案和 Prompt，不替代用户决策。

**预计主要文件：**

- 新增 `src/lib/agent-plans/generate-template-plans.ts`
- 新增 `src/lib/agent-plans/compose-template-prompt.ts`
- 新增 `src/app/api/agent/template-plans/route.ts`
- `src/components/agent/AgentPlanCards.tsx`
- `src/components/agent/PromptPreviewPanel.tsx`
- `src/app/api/tasks/create/route.ts`

**任务：**

- [x] 输入结构采用 `{ text, modifiers }`，绑定当前 templateId。
- [x] Agent 读取模板、模块、规则、固定素材和 Temporal 设置。
- [x] 生成 A/B/C/D 四个方案，每个方案必须有明确差异，不输出四个近似文案。
- [x] 方案生成后产出结构化 Prompt，不直接提交 Seedance。
- [x] 用户选方案后才写入 Prompt 预览。
- [x] 用户编辑 Prompt 后标记为 `user_edited=true`，仍保留 Agent 原始 Prompt 快照。
- [x] 提交 Seedance 时同时传入 templateId、selectedPlan、agentRunId、finalPrompt。
- [x] Agent 失败时允许用户退回手写 Prompt，但页面必须明确提示“模板方案未生成”。

**验收：**

- [x] 每次 Agent 生成固定输出 4 个方案。
- [x] 选择不同方案会生成不同 Prompt。
- [x] Prompt 预览可编辑，编辑后最终提交使用用户编辑版本。
- [x] 不触发真实付费生成的 dry-run/smoke 可验证方案生成链路。

### Batch 5：执行链路查看页（管理员调试）

目标：让管理员能看清 Agent 如何从模板和需求生成最终结果。

**预计主要文件：**

- 新增 `src/app/admin/agent-runs/page.tsx`
- 新增 `src/app/admin/agent-runs/[id]/page.tsx`
- 新增 `src/components/agent/AgentRunTimeline.tsx`
- 新增 `src/components/agent/AgentRunStepInspector.tsx`
- `src/app/api/agent/runs/[id]/route.ts`
- `src/app/globals.css`

**任务：**

- [x] 列表页展示最近 Agent runs：模板、用户、视频卡、状态、选中方案、任务 ID。
- [x] 详情页按流程展示：Intent 解析 -> 模板加载 -> 模块组合 -> 规则计算 -> Prompt 生成 -> 方案生成 -> Prompt 最终输出 -> Seedance 执行 -> Memory 记录。
- [x] 每一步展示输入/输出、命中规则、使用模块、Prompt diff。
- [x] 敏感字段默认脱敏，不展示 token、cookie、Provider 密钥。
- [x] 从最近任务或任务详情能跳到对应执行链路。

**验收：**

- [x] 管理员能追溯一次生成为什么得到这个 Prompt。
- [x] 普通用户无法访问执行链路页和 API。
- [x] 执行链路缺失时页面给出可理解空状态。

### Batch 6：Memory 轻量闭环

目标：只做产品可用记忆，不做复杂长期智能体系统。

**预计主要文件：**

- 新增 `src/lib/template-memory/*`
- 新增 `src/app/api/template-memory/*`
- `src/lib/agent-plans/generate-template-plans.ts`
- `src/lib/video/task-finalizer.ts`

**任务：**

- [x] 记录用户选择了 A/B/C/D 哪个方案。
- [x] 记录用户是否编辑 Prompt，编辑幅度只存摘要或结构化标记。
- [x] 任务成功/失败后记录模板、模块、规则、Prompt 版本和结果状态。
- [x] Memory 只用于下一次方案排序或提示，不自动覆盖模板规则。
- [x] 管理员可在执行链路查看 Memory 命中，但第一版不做复杂 Memory 管理后台。

**验收：**

- [x] 同一模板后续生成能看到历史选择偏好被用于方案提示或排序。
- [x] 失败任务不会被当成正向经验自动强化。
- [x] Memory 不存敏感 URL/token/cookie。

### Batch 7：权限、上线验证和回滚

目标：完成真实页面闭环，不停在本地代码。

**主要文件：**

- `src/lib/auth/*`
- `src/app/api/templates/*`
- `src/app/api/agent/*`
- `src/app/generate/page.tsx`
- `tasks/lessons.md`
- `/Volumes/Data/Projects/project-version-registry.md`

**任务：**

- [x] 普通用户只能使用 active 模板、输入需求、选择方案、生成视频。
- [x] 管理员才能编辑模板、调整规则、查看执行链路。
- [x] 所有新增 API 做服务端权限校验，不能只靠前端隐藏按钮。
- [x] 验证命令：`npx prisma validate`、`npm run db:generate`、`npx tsc --noEmit --pretty false`、`npm run lint`、`npm run build`。
- [ ] UI 验证：桌面和移动端 `/generate`，模板抽屉，方案卡，Prompt 预览，最近任务。
- [ ] 线上闭环：`youdoo-sites build sd2`、`youdoo-sites restart sd2`、`youdoo-sites status sd2`，再从公网验证页面、API 和静态资源。（用户要求先忽略部署。）
- [ ] 形成聚焦提交、rollback tag、推送远端，并登记版本。

**停止条件：**

- [ ] 未获得用户明确授权前，不跑真实付费生成。
- [ ] 数据迁移无法无损执行时停止，不继续写功能代码。
- [ ] 权限边界不清时停止，不把模板编辑或执行链路暴露给普通用户。
- [x] 构建、类型检查、lint 或关键 smoke 失败时不提交、不上线。

**Git Plan：**

- 当前分支：`codex/seedance-template-agent-workbench`，已从 `codex/video-card-p0-closure` 切出作为本轮独立任务分支。
- 提交分组建议：
  - 提交 1：schema、模板/Agent run/Memory 底座和只读 smoke。
  - 提交 2：生成主页面模板信息架构和方案区。
  - 提交 3：模板编辑抽屉和管理员权限。
  - 提交 4：Agent 方案生成、Prompt 合成和任务快照关联。
  - 提交 5：执行链路查看页和 Memory 轻量闭环。
  - 提交 6：验证修复、线上闭环、经验记录和版本登记。
- 回滚点建议：`rollback/2026-06-14-seedance-template-agent-workbench`。

### HARD-GATE

- 当前只完成需求规划到 `tasks/todo.md`，不改业务代码。
- 进入 Batch 1 前需要用户明确确认“开始落地 / 执行 / 开干”。
- 如果用户只想先做前端原型，则改为先执行 Batch 2 的静态 UI，暂不改 Prisma schema 和真实 API。

### Review - 2026-06-14 本地实现与验证

- 已实现 Batch 1：新增 `GenerationTemplate`、`TemplateAsset`、`TemplateRule`、`TemplatePromptBlock`、`AgentRun`、`AgentRunStep`、`TemplateMemory`，并给 `VideoTask` 增加 `template_id`、`agent_run_id`、`selected_agent_plan_key`、Agent Prompt、最终 Prompt 和用户编辑标记。
- 已实现 Batch 1：新增 `/api/templates`、`/api/templates/:id`、`/api/agent/template-plans`、`/api/agent/runs/:id`，并增加默认 active 模板迁移数据。
- 已实现 Batch 2：`/generate` 中新增模板区、模板摘要、本次需求、快捷 modifier、A/B/C/D 方案卡、Prompt 预览和恢复 Agent 版本；原项目/视频卡、参考图、图集、Prompt、Seedance 参数和最近任务保留。
- 已实现 Batch 3：管理员可从生成页打开右侧模板编辑抽屉，编辑基础信息、模块绑定、固定素材、提示词、规则和 Temporal；关闭抽屉前会确认未保存改动。
- 已实现 Batch 4：Agent 方案生成使用确定性本地逻辑，固定输出 4 个差异化方案；选择方案后写入 Prompt，用户编辑会记录 `prompt_user_edited=true`。
- 已实现 Batch 5：新增 `/admin/agent-runs` 和 `/admin/agent-runs/:id`，管理员可查看执行链路列表、步骤输入/输出、Prompt 快照和 Memory；任务详情高级信息可深链到对应 Agent 链路。
- 已实现 Batch 6：方案选择、Seedance 提交、Provider 失败都会写入 `TemplateMemory`；后续同模板无 modifier 生成时，会优先参考当前用户历史正向方案选择。
- 已验证：`npx prisma validate`、`npm run db:generate`、`npx tsc --noEmit --pretty false`、局部 `npm run lint`、`npm run build`、`git diff --check`、`npx impeccable detect` 通过。
- 已验证：本地 DB 先备份为 `prisma/dev.db.backup-20260614112714-template-agent`；`prisma migrate deploy` 被历史迁移状态阻塞，未强行修复；`prisma db push` 提示会删除旧字段 `VideoCard.ratio_locked`，已拒绝；最终仅手动应用本次新增迁移 SQL，不触碰历史字段。
- 已验证：本地 smoke 读取默认模板后生成 A/B/C/D 四方案，默认模板包含 4 条规则、4 个提示词块和 3 个素材占位。
- 已验证：本地 dev server `http://localhost:3001/generate` 可访问；当前 in-app browser 无登录态，被重定向到 `/login?next=/generate`，因此认证后的桌面/移动端 UI 目测仍待登录后复核。
- 未执行：按用户要求暂不部署，不执行 `youdoo-sites build/restart/status`，线上 `sd2.youdoodesign.com` 尚未加载本轮改动。

### Review - 2026-06-14 独立模板生成页本地落地

- 已实现：新增 `/template-generate` 独立页面和 `TemplateGenerateClient`，顶部明确为“模板生成工作台”，包含进入画布模式、查看我的项目、项目/视频卡归属、本次需求、模板方案、Prompt 预览、参数确认和最近任务。
- 已实现：`GenerationComposer` 增加 `templateMode`，普通 `/generate` 默认关闭模板工作台；独立模板页显式启用模板工作台并复用素材、Prompt、参数和任务创建能力。
- 已实现：`/templates` 不再重定向到普通 `/generate`，改为进入 `/template-generate`。
- 已实现：模板编辑抽屉改为 `模块 / 规则 / 资产` 三段，保留未保存确认，底部补 `查看变更记录 / 取消 / 保存为新版本`。
- 已实现：模板编辑抽屉补模块预览卡、资产缩略图、素材来源说明、增加/删除素材入口；规则页改为逐条规则编辑，支持分组计数、新增、编辑、删除、启停和优先级。
- 已实现：Agent Run 详情页补 9 步链路卡、规则命中面板、输入/输出对比面板、复制 Trace ID、导出报告、自动刷新、规则来源模块和 Seedance payload 摘要。
- 已实现：`/api/agent/template-plans` 实际落库 9 步 Trace，执行链路页展示和导出报告统一脱敏 token、cookie、密钥和直链字段。
- 已实现：管理员可从模板生成页顶部、最近任务卡、任务详情页和 Agent Run 列表进入执行链路，并能返回模板生成或任务详情。
- 已实现：模板页最近任务保留截图/缩略图第一视觉入口，无图时稳定显示“暂无截图”占位。
- 已验证：`git diff --check`、`npx tsc --noEmit --pretty false`、`npm run lint`、`npm run build`、`npx impeccable detect src/components/templates/TemplateGenerateClient.tsx src/components/GenerationComposer.tsx src/components/templates/TemplateEditorDrawer.tsx 'src/app/admin/agent-runs/[id]/page.tsx'` 通过。
- 已验证：本地 dev server `http://localhost:3100/template-generate` 返回 200，HTML 包含 `模板生成工作台` 和 `app/template-generate/page.js`；`http://localhost:3100/generate` 仍按普通生成页登录保护跳转 `/login?next=%2Fgenerate`。
- 未验证：Playwright 未安装，未完成自动截图和登录态交互验收；当前验证以构建、HTML smoke 和无登录态路由为准。
- 已部署：`sd2` 已完成 build/restart/status；公网 `/template-generate` 200，HTML 命中“模板生成工作台”和模板页静态 chunk，静态 chunk 200；登录态视觉走查仍可在真实账号下继续复核。

## 已落地基线，后续不要重复做

- [x] `VideoCard` 基础模型、项目下视频卡列表、视频卡详情页、生成页绑定视频卡、再生成归属。
- [x] 新生成任务后端要求 `video_card_id`，并校验视频卡属于当前项目。
- [x] 本地样本库当前 `VideoTask.project_id is null` 为 0、`VideoTask.video_card_id is null` 为 0、任务项目与视频卡项目错配为 0。
- [x] `ProjectBudgetAccount`、`ProjectBudgetLedger` 已存在，公共项目生成路径已有预算预占、成功实扣、失败释放和预算不足拒绝。
- [x] `ApprovalRecord`、`/approvals`、`/api/approvals`、`/api/approvals/:id` 已存在。
- [x] 非个人项目 1080p 生成已接入“有效 `resolution_1080p` 审批记录”后端校验。
- [x] 新建项目页已出现“默认记账 / 预算记账”选择；默认记账创建普通协作项目，预算记账引导发起公共项目审批。
- [x] 视频卡详情页已有候选、当前最佳、最终版和封板入口。

## 总体闭环目标

- [ ] 每一笔生成消耗都有项目、视频卡、用户、点数、人民币成本和状态归属。
- [ ] 公共项目消耗走项目预算池，不再混用个人积分口径。
- [ ] 高成本动作不仅有审批记录，还必须在审批通过后驱动业务状态变化，包括公共项目启用、追加预算入账、1080p 额度消耗、比例变更确认、视频卡重开。
- [ ] 飞书需求入口能生成项目草稿和视频卡草稿。
- [ ] 同一视频卡内可以管理方向分支，避免把探索版本错误拆成平级项目或平级视频卡。
- [ ] 项目结束后生成复盘卡，并能反推下一次预算建议。
- [ ] 线上 `sd2.youdoodesign.com` 每个阶段完成后都有构建、重启、公网验证和回滚点。

## 任务包 A：P0 现有闭环硬化与线上验收

目标：把已经做出来的基础能力校准为可信基线，避免后续继续在“看起来完成”的状态上叠功能。

**主要文件：**

- `src/app/projects/page.tsx`
- `src/app/api/projects/route.ts`
- `src/app/api/tasks/create/route.ts`
- `src/app/api/tasks/[id]/project/route.ts`
- `src/app/api/video-cards/[id]/route.ts`
- `src/lib/video-cards/permissions.ts`
- `scripts/backfill-video-cards.ts`

**任务：**

- [ ] 重新验收新建项目页：用户必须在创建前看到“默认记账 / 预算记账”的差异、扣费对象、审批结果和下一步入口。
- [ ] 验证线上 `sd2.youdoodesign.com/projects` 已加载包含记账选择的新构建，不只看本地代码。
- [x] 修复或禁用会清空 `video_card_id` 的任务移动项目路径；移动任务时必须要求选择目标视频卡，或进入未归档池。
- [ ] 将 `VideoTask.project_id`、`VideoTask.video_card_id` 的全局不变量从“新建接口校验”升级为“所有入口都不能破坏”。
- [x] 已封板视频卡禁止继续修改候选、当前最佳、最终版；如需变更必须走重开或替换审批。
- [ ] 视频卡封板后的重开不能只 PATCH `status`，必须有原因、审批记录和操作日志。
- [x] 增加只读巡检脚本：检查无项目任务、无视频卡任务、项目/视频卡错配、封板后仍变更版本角色。

本轮记录：

- 2026-06-14：`/api/tasks/:id/project` 不再允许移动任务时清空视频卡；移动任务必须传入目标项目下可用视频卡，封板/归档目标卡会被拒绝，移出原当前最佳/最终版任务时会清理原卡指针。
- 2026-06-14：`/api/video-cards/:id` 禁止直接 PATCH `status`；已封板/归档视频卡禁止继续直接修改候选、当前最佳、最终版或其他卡片字段，后续重开必须走审批闭环。
- 2026-06-14：新增只读巡检脚本 `scripts/audit-video-card-invariants.ts`，覆盖无项目任务、无视频卡任务、项目/卡错配、失效当前最佳/最终版指针、封板后版本角色变更日志。

**验收：**

- [ ] 本地和线上新建项目页都能明确选择记账方式。
- [ ] 所有任务归档路径不会产生 `video_card_id is null` 的新任务。
- [x] 封板视频卡不能直接改最终版。
- [x] 巡检脚本返回 0 个基础归档异常。

## 任务包 B：公共项目立项、预算审批与预算入账闭环

目标：公共项目不只是“有预算表”，而是从立项审批、预算启用、追加预算到预算预警都形成闭环。

**主要文件：**

- `prisma/schema.prisma`
- `src/app/projects/page.tsx`
- `src/app/api/projects/route.ts`
- `src/app/api/projects/[id]/budget/route.ts`
- `src/app/api/approvals/route.ts`
- `src/app/api/approvals/[id]/route.ts`
- `src/lib/projects/budget.ts`
- `src/lib/approvals.ts`

**任务：**

- [x] 公共项目申请审批通过后，自动创建或启用 `type='public'` 项目，并初始化项目预算账户。
- [ ] 预算记账申请必须记录预算金额、预算用途、申请原因、项目负责人、审批人和有效期。
- [ ] 追加预算审批通过后必须调用 `adjustProjectBudget`，写入 `ProjectBudgetLedger`，并通知申请人/负责人。
- [ ] 追加预算审批拒绝后，项目预算不变，生成页和项目页显示拒绝原因。
- [ ] 预算账户补齐冻结原因、冻结恢复、异常对账状态；预算异常时阻止继续生成但允许整理视频卡和提交审批。
- [ ] 项目预算支持 50% / 70% / 80% / 90% / 100% 阈值策略；最终阈值以 V1.2 文档和 UI 口径统一。
- [ ] 人民币预算估算不能只用当前汇率展示；关键账务记录必须保留当时换算比例快照或明确记录为“展示时换算”。

本轮记录：

- 2026-06-14：公共项目立项审批通过后会创建 `type='public'` 项目、设置申请人为项目负责人、初始化项目预算账户，并按申请的初始预算写入 `ProjectBudgetLedger`。
- 2026-06-14：追加预算审批通过后调用 `adjustProjectBudget` 写入预算流水；追加预算审批拒绝只更新审批状态，不改变项目预算。
- 2026-06-14：新增 `scripts/approval-effects-smoke.ts`，在事务中验证公共项目立项、初始预算、追加预算通过、追加预算拒绝和操作日志，验证后主动回滚，不污染数据库。

**验收：**

- [x] 预算记账申请通过后，系统内能看到公共项目和项目预算账户。
- [x] 追加预算审批通过后，预算总额真实增加并有流水。
- [x] 追加预算审批拒绝后，预算不变且可追溯。
- [ ] 公共项目预算不足时不能生成，但可以提交追加预算审批。

## 任务包 C：审批中心业务联动与 1080p 额度

目标：审批中心从“记录表”升级为“业务状态变更入口”。

**主要文件：**

- `prisma/schema.prisma`
- `src/lib/approvals.ts`
- `src/app/approvals/page.tsx`
- `src/app/api/approvals/route.ts`
- `src/app/api/approvals/[id]/route.ts`
- `src/app/api/tasks/create/route.ts`
- `src/components/GenerationComposer.tsx`

**任务：**

- [ ] 为不同审批类型定义最小必填字段：公共项目、追加预算、1080p、比例变更、视频卡重开。
- [ ] `decideApproval` 或审批处理 API 根据审批类型执行业务副作用，不允许只更新审批状态。
- [ ] 1080p 审批必须绑定项目、视频卡、基准任务、申请理由、预计用途、额度次数、额度预算和有效期。
- [ ] 1080p 生成时扣减审批额度；额度用尽、过期、跨视频卡或跨项目都必须拒绝。
- [ ] 1080p 必须基于当前最佳、候选版本或已通过草稿，禁止没有通过草稿直接刷 1080p。
- [ ] 比例变更审批通过后更新视频卡交付规格，并保留原始比例和变更原因。
- [ ] 视频卡重开审批通过后恢复到允许生成的目标状态，并保留封板记录。
- [ ] 审批通过、拒绝、失效、业务副作用成功/失败都写入 `OperationLog`。

本轮记录：

- 2026-06-14：`project_create` 和 `budget_increase` 已接入 `decideApproval` 业务副作用；其他审批类型仍未闭环，不能视为审批中心整体完成。

**验收：**

- [ ] 每种审批通过后都有可观察的业务结果。
- [ ] 1080p 审批不能被无限复用。
- [ ] 无基准版本的视频卡不能申请或执行 1080p。
- [ ] 审批失败不会产生半更新状态。

## 任务包 D：比例锁定与分辨率策略

目标：降低错误比例和高规格生成造成的成本浪费。

**主要文件：**

- `prisma/schema.prisma`
- `src/app/generate/page.tsx`
- `src/components/GenerationComposer.tsx`
- `src/components/ComposerActionBar.tsx`
- `src/app/api/tasks/create/route.ts`
- `src/app/api/video-cards/[id]/route.ts`

**任务：**

- [ ] 视频卡保存比例来源、是否锁定、目标分辨率、目标时长、平台和原始需求比例。
- [ ] 从视频卡进入生成页时，默认继承并锁定比例、时长、目标分辨率。
- [ ] 解锁比例必须填写原因，并写入操作日志。
- [ ] 公共项目偏离原始交付比例时，不能直接设为最终版，必须负责人确认或审批。
- [ ] 已有最终版后变更比例需要更高权限或比例变更审批。
- [ ] 480p、720p、1080p 的使用门槛和文案按 V1.2 文档规则落地。
- [ ] 后端校验比例和分辨率策略，不能只靠前端提示。

验收：

- [ ] 视频卡下生成默认使用视频卡比例。
- [ ] 用户不能无提示切换比例。
- [ ] 公共项目比例变更有审批记录。
- [ ] 1080p 高规格生成有可追溯审批。

## 任务包 E：飞书多维表格立项

目标：用飞书表单作为需求入口，生成项目草稿和视频卡草稿。

**主要文件：**

- `prisma/schema.prisma`
- `src/lib/auth/feishu.ts`
- `src/app/api/auth/feishu/*`
- `src/app/api/projects/route.ts`
- `src/app/api/projects/[id]/video-cards/route.ts`
- 新增 `src/lib/feishu/*` 或等价同步模块
- 新增 `src/app/api/feishu/*` 或等价同步 API

**任务：**

- [ ] 配置飞书多维表格字段：需求基础信息、使用场景、技术参数、视频条目信息。
- [ ] 新增需求记录模型，保存飞书 `app_token/table_id/record_id`、原始字段快照、同步状态、错误原因和幂等键。
- [ ] 新增飞书需求同步接口或定时同步任务；第一版可手动触发，但必须幂等。
- [ ] 飞书需求表先生成项目草稿，不直接生成正式项目。
- [ ] 视频条目表生成 `VideoCard` 草稿，状态为待确认。
- [ ] 无视频条目时生成“未拆分视频需求”草稿卡，并要求负责人补充。
- [ ] 项目负责人确认后，项目和视频卡进入可制作状态。
- [ ] 系统状态变化回写飞书：已立项、已生成项目、视频卡数量、待补充原因。
- [ ] 同步失败要记录错误状态，不丢原始飞书记录 ID。

验收：

- [ ] 飞书提交后系统能看到项目草稿。
- [ ] 有视频条目时能生成视频卡草稿。
- [ ] 无视频条目时提示补充。
- [ ] 重复提交不会重复创建项目和视频卡。

## 任务包 F：视频卡去重、合并、拆分、移动归档

目标：让视频卡真正代表一条视频交付目标，避免同一目标被重复建卡或不同目标混在一张卡里。

**主要文件：**

- `prisma/schema.prisma`
- `src/app/api/projects/[id]/video-cards/route.ts`
- `src/app/api/video-cards/[id]/route.ts`
- `src/app/api/video-cards/[id]/tasks/route.ts`
- `src/app/api/tasks/[id]/project/route.ts`
- `src/app/projects/[id]/video-cards/[cardId]/page.tsx`
- 新增视频卡归档/合并/拆分服务模块

**任务：**

- [ ] 新建视频卡时检查同项目下相似卡，提示归入已有卡、仍然新建或稍后整理。
- [ ] 支持同项目内视频卡合并，原卡进入已合并状态并保留跳转关系。
- [ ] 支持视频卡拆分，把部分生成记录或方向分支移动到新视频卡。
- [ ] 支持生成记录移动归档到其他视频卡，展示归属随当前归档变化，但账本原始记录不被篡改。
- [ ] 建立未归档池或异常归档列表，处理历史或异常任务。
- [ ] 合并、拆分、移动都写操作日志，并保留操作者和原因。
- [ ] 视频卡命名按“使用场景 + 内容目标 + 平台/比例”给出默认建议。

验收：

- [ ] 同项目内重复视频卡能被提示或合并。
- [ ] 拆分后新旧视频卡成本统计正确。
- [ ] 移动归档不破坏历史成本账本。
- [ ] 用户能追溯生成记录归属变更历史。

## 任务包 G：方向分支

目标：同一视频卡内管理多条创意探索路线，而不是把每次探索拆成平级视频卡。

**主要文件：**

- `prisma/schema.prisma`
- `src/app/projects/[id]/video-cards/[cardId]/page.tsx`
- `src/app/generate/page.tsx`
- `src/app/api/tasks/create/route.ts`
- `src/lib/video-cards/summary.ts`
- 新增 `src/app/api/video-cards/[id]/branches/*`
- 新增 `src/lib/video-branches/*`

**任务：**

- [ ] 新增 `VideoBranch` 数据结构。
- [ ] `VideoBranch` 关联 `video_card_id`。
- [ ] `VideoTask` 增加 `video_branch_id`。
- [ ] 视频卡详情页展示方向分支列表、分支状态和当前主方向。
- [ ] 从方向分支内生成时，任务归入当前视频卡和当前分支。
- [ ] 支持设置主方向、关闭方向、合并方向。
- [ ] 支持方向升格为独立视频卡，并保留历史生成记录可追溯。
- [ ] 分支成本计入视频卡和项目总消耗，同时支持单分支统计。
- [ ] 限制活跃方向数量；超过阈值要求负责人确认。

验收：

- [ ] 同一视频卡下可以有多个方向分支。
- [ ] 分支能统计生成次数、点数和官方成本。
- [ ] 主方向可标记。
- [ ] 分支升格后历史生成记录仍可追溯。

## 任务包 H：复盘卡与预算反推

目标：项目结束后沉淀预算依据，让下一次同类项目能更准地预估成本。

**主要文件：**

- `prisma/schema.prisma`
- `src/app/api/projects/[id]/route.ts`
- `src/app/projects/[id]/page.tsx`
- `src/lib/video-cards/summary.ts`
- 新增 `src/lib/review-cards/*`
- 新增 `src/app/api/projects/[id]/review-card/*`

**任务：**

- [ ] 新增 `ReviewCard` 数据结构。
- [ ] 项目结算或归档时生成复盘卡。
- [ ] 复盘卡包含总点数、总金额、视频卡数量、最贵视频卡、最终版平均成本、分辨率占比、失败率、下次预算建议。
- [ ] 支持按项目类型、平台、比例、时长、发布场景检索历史项目。
- [ ] 新项目立项时读取历史复盘，给出建议预算和风险提示。
- [ ] 复盘卡允许管理员补充人工结论，但不能改写原始账本。
- [ ] 区分“实时聚合 review_summary”和“已归档复盘卡”，避免把临时统计当成知识库。

验收：

- [ ] 项目结束后能生成复盘卡。
- [ ] 复盘卡能解释钱花在哪里。
- [ ] 新项目能参考历史复盘给预算建议。
- [ ] 复盘数据和原始成本账本可相互追溯。

## 任务包 I：通知与提醒

目标：关键成本节点主动提醒负责人和管理员，但不打断低风险操作。

**主要文件：**

- `prisma/schema.prisma`
- `src/app/api/approvals/[id]/route.ts`
- `src/lib/projects/budget.ts`
- `src/app/api/tasks/create/route.ts`
- 新增 `src/lib/notifications/*`
- 新增 `src/app/api/notifications/*`

**任务：**

- [ ] 建立通知模型或事件表，记录通知类型、目标用户、关联项目/视频卡/审批、状态和发送结果。
- [ ] 预算达到 50% / 70% / 80% / 90% / 100% 中最终确认的阈值时提醒，并统一页面文案。
- [ ] 视频卡生成次数过多或接近建议预算时提醒。
- [ ] 公共项目审批、追加预算审批、1080p 审批通过/拒绝时提醒。
- [ ] 项目预算不足时提醒。
- [ ] 视频卡封板、重开、项目归档、复盘卡生成时提醒。
- [ ] 支持站内通知；飞书消息通知作为独立接入点，不把 token 或密钥写入日志。
- [ ] 通知失败可重试或可追踪，不能吞掉错误。

验收：

- [ ] 提醒不会阻断低风险操作。
- [ ] 高风险成本操作必须明确提示。
- [ ] 通知内容不包含敏感 token、cookie、密钥或 Provider 签名 URL。
- [ ] 通知发送失败可重试或可追踪。

## 任务包 J：权限、状态机与审计加固

目标：把 V1.2 的角色、状态、权限规则从隐式判断整理成可验证规则。

**主要文件：**

- `prisma/schema.prisma`
- `src/lib/projects/permissions.ts`
- `src/lib/video-cards/permissions.ts`
- `src/lib/taskStatus.ts`
- `src/lib/approvals.ts`
- `scripts/task-permission-matrix-smoke.ts`

**任务：**

- [ ] 梳理需求方、项目负责人、视频卡负责人、普通成员、只读观察者、管理员、系统任务的权限矩阵。
- [ ] 显式定义项目状态机：草稿、待负责人确认、待管理员审批、已启用、预算不足、已暂停、结算中、已归档、已取消。
- [ ] 显式定义视频卡状态机：草稿、待确认、未开始、生成中、评审中、1080p 审批中、高规格生成中、已定稿、已封板、已合并、已归档、已废弃。
- [ ] 显式定义方向分支状态机：探索中、候选、主方向、已关闭、已合并、已升格为视频卡。
- [ ] 所有状态变更走统一 helper，避免页面/API 各自写字符串。
- [ ] 所有预算、审批、归档、合并、拆分、重开、比例解锁动作写 `OperationLog`。
- [ ] 为关键权限路径补 smoke test 或脚本验证。

验收：

- [ ] 无权限用户不能查看、生成、审批或修改不属于自己的项目/视频卡。
- [ ] 已归档项目和已封板视频卡默认只读。
- [ ] 状态变更都有操作日志。
- [ ] 权限矩阵脚本覆盖项目、视频卡、审批、预算四类关键动作。

## 任务包 K：数据迁移、部署与回滚闭环

目标：每个阶段上线时不破坏已有任务、视频文件、成本账本和公网访问。

- [ ] 每次涉及 schema 或归档逻辑变更前，备份 SQLite 数据库。
- [ ] 为历史项目和历史任务补齐必要归属，脚本默认 dry-run，`--apply` 才执行。
- [ ] 保留原有 `project_id`、`CreditLedger`、`CostLedger`、视频文件和缩略图路径。
- [ ] 验证旧任务详情页、项目页、任务页、管理员成本页没有 500。
- [ ] 本地通过后执行 `youdoo-sites build sd2`、`youdoo-sites restart sd2`、`youdoo-sites status sd2`。
- [ ] 公网验证新页面、API、静态资源和旧链接跳转。
- [ ] 每个可回退节点创建清晰 commit，必要时创建 rollback tag。
- [ ] 每个阶段更新 `/Volumes/Data/Projects/project-version-registry.md`，记录分支、commit、tag、部署目标和验证结果。
- [ ] 每个线上 UI 变更必须验证公网 DOM/页面行为，不允许只用 `youdoo-sites status sd2` 证明完成。

验收：

- [ ] 历史任务不丢失。
- [ ] 历史成本账本不丢失。
- [ ] 历史视频可继续打开。
- [ ] 新生成任务都有项目和视频卡归属。
- [ ] 线上 `sd2.youdoodesign.com` 加载新构建。
- [ ] 远端分支和必要 rollback tag 可见。

## 推荐执行顺序

- [ ] 1. 任务包 A：先修基础不变量和线上验收，尤其是新建项目记账方式、任务移动清空视频卡、封板后仍可改版本。
- [ ] 2. 任务包 C：先让审批真正驱动业务；否则 B/D/F 的审批都会继续空转。
- [ ] 3. 任务包 B：补公共项目立项和追加预算入账闭环。
- [ ] 4. 任务包 D：比例锁定和 1080p 额度接入审批中心。
- [ ] 5. 任务包 F：视频卡治理，解决重复、合并、拆分、移动归档。
- [ ] 6. 任务包 G：方向分支，建立同卡多方向探索结构。
- [ ] 7. 任务包 E：飞书立项入口；如果业务优先要飞书，可以提前到第 2 步，但必须先明确字段、幂等和状态回写。
- [ ] 8. 任务包 H：复盘卡和预算反推，依赖前面账本、视频卡、分支稳定。
- [ ] 9. 任务包 I：通知提醒，接入审批、预算、封板、复盘事件。
- [ ] 10. 任务包 J、K 贯穿每个阶段，每完成一个业务包都同步补权限、状态机、审计、迁移、部署和回滚。

## 每个任务包的通用完成标准

- [ ] 有明确数据模型、API、页面入口、权限规则和异常处理。
- [ ] 有最小可运行验证命令，至少包含 `git diff --check`、`npm run lint`、必要时 `NEXT_DIST_DIR=.next-prod-dry-run npm run build`。
- [ ] 有对应 smoke 或脚本验证，不能只靠页面目测。
- [ ] 不触发真实付费生成，除非单独获得授权。
- [ ] 不提交 `.env`、token、cookie、Provider 签名 URL、数据库备份或大型构建产物。
- [ ] 完成后更新本 todo 勾选状态，并记录验证结果。
- [ ] 线上变更必须执行 build/restart/status，并验证公网 URL、关键 DOM/文案/行为或静态资源已加载新版本。
- [ ] 形成聚焦 commit、推送远端；需要稳定回退点时创建并推送 rollback tag。

---

# 生成记录列表缩略图统一改造 Todo

更新时间：2026-06-13

目标：落实项目规则“所有生成记录列表最左侧必须是视频截图/缩略图”。所有能让用户扫生成记录、任务记录、产出留存、项目内任务、视频卡任务和成本待办的列表，都要在第一视觉列展示对应视频画面；没有截图时保留稳定占位，不能让提示词、日期、状态或金额顶到最左。

## 第一性原理

生成记录列表的核心不是“读一行文本”，而是“快速识别是哪条视频产出”。用户在后台、项目、视频卡和任务页之间切换时，最可靠的识别锚点是画面，不是任务 ID、提示词或金额。提示词可以很长且相似，金额和状态不能帮用户区分视频内容，所以缩略图必须成为每行的第一入口。

产品 UI 方向：这是后台工具，不做装饰型改造。采用统一、稳定、可扫描的紧凑列表结构；缩略图作为首列，右侧再承载提示词、状态、项目、创建者、成本和操作。

## 当前代码依据

- 后台总览最近生成：`src/app/admin/AdminGenerationDashboardClient.tsx` 的 `recent_tasks` 渲染当前第一列是任务文本，没有截图；`src/lib/admin/generation-dashboard.ts` 已查询 `local_video_path`、`result_video_url`、`result_last_frame_url`，但 `DashboardRecentTask` 没把这些字段返回给客户端。
- 产出留存：`src/app/admin/outputs/AdminOutputsClient.tsx` 已有 `OutputFramePreview`，列表最左侧是预览图，基本符合规则，需要统一占位和尺寸口径。
- 我的任务：`src/app/tasks/page.tsx` 已有 `TaskPreview`，但批量选择 checkbox 在截图前面；需要把选择控件合并进缩略图列或覆盖在缩略图上，让截图仍是第一视觉入口。
- 项目详情历史/调试任务：`src/app/projects/[id]/page.tsx` 的“历史 / 调试任务”表格当前第一列是任务 ID，没有缩略图；同页成本账本表已有视频预览，但使用 `<video>` 且取值顺序是 `result_video_url || local_video_path`，需要统一为截图优先、本地优先。
- 视频卡详情生成记录：`src/app/projects/[id]/video-cards/[cardId]/page.tsx` 已有 `video-card-task-preview`，但使用视频标签而不是统一截图 API；需要对齐“截图首列”口径。
- 生成页最近任务：`src/app/generate/page.tsx` 已有 `RecentTaskPreview`，卡片顶部先展示预览图；需要作为生成记录卡片特例验收，确认桌面/移动端截图仍是第一视觉入口。
- 计费与成本待处理队列：`src/app/admin/costs/page.tsx` 的 `recentIssues` 表格当前第一列是提示词，没有缩略图；它本质是带成本异常的生成任务列表，应纳入本规则。

## 目标范围

- `/admin` 最近生成记录。
- `/admin/outputs` 产出留存。
- `/tasks` 我的任务列表。
- `/projects/[id]` 历史/调试任务、项目成本账本里的任务行。
- `/projects/[id]/video-cards/[cardId]` 生成记录。
- `/generate` 最近任务卡片。
- `/admin/costs` 待处理队列中以 `VideoTask` 为主体的任务行。

不纳入本批：Provider 请求异常列表、纯账本汇总、项目列表、用户列表、图集列表。这些不是“生成记录列表”，除非行内直接代表一个视频任务。

## 推荐实现方案

### 1. 抽公共任务缩略图组件

新增或复用公共组件，建议路径：

- `src/components/TaskVideoThumbnail.tsx`

职责：

- 输入 `taskId`、`localVideoPath`、`resultVideoUrl`、`resultLastFrameUrl`、`status`、`href`、`size`。
- 优先用 `/api/video/thumbnail/:taskId` 展示截图。
- 只有存在 `local_video_path`、`result_video_url` 或 `result_last_frame_url` 时才尝试加载截图。
- 图片加载失败后显示稳定占位：生成中、失败无预览、暂无截图、预览不可用。
- 支持操作叠层：批量选择 checkbox、状态小标、可点击详情链接。
- 固定宽高和 aspect-ratio，避免列表加载时跳动。

### 2. 后端数据补齐

- `src/lib/admin/generation-dashboard.ts`：把 `local_video_path`、`result_video_url`、`result_last_frame_url` 加入 `DashboardRecentTask` 返回结构。
- `src/app/admin/costs/page.tsx`：确认 `recentIssues` 查询包含 `local_video_path`、`result_video_url`、`result_last_frame_url`。
- 如某个列表 API 缺字段，只补对应列表需要的最小字段，不扩大返回敏感数据。

### 3. 各列表接入

- `/admin` 最近生成记录：表头新增“截图”作为第一列；每行最左渲染 `TaskVideoThumbnail`，任务文本移动到第二列。
- `/admin/outputs`：保留现有首列预览，替换或对齐为公共组件；占位文案和尺寸统一。
- `/tasks`：把 checkbox 放到缩略图内部左上角或缩略图旁同一首列内，保证截图仍是第一视觉入口。
- `/projects/[id]` 历史/调试任务：第一列改为缩略图 + 短任务 ID，提示词放第二列。
- `/projects/[id]` 成本账本任务行：改用缩略图组件，本地路径优先；非任务账本保留“无任务/无视频”占位。
- `/projects/[id]/video-cards/[cardId]`：首列改用缩略图组件，保持现有卡片布局。
- `/generate` 最近任务：保留卡片预览，但复用同一预览决策函数或组件，保证错误占位一致。
- `/admin/costs` 待处理队列：第一列新增缩略图，任务提示词作为第二列。

### 4. 样式与交互

- 统一缩略图尺寸：
  - 表格/后台紧凑列表：`88x56` 或 `96x60`。
  - 卡片列表：保持现有卡片比例，但使用同一占位样式。
- 缩略图必须不拉伸：`object-fit: cover`，容器固定 `aspect-ratio: 16 / 9`。
- 占位不使用大段说明文字，只显示短状态：`生成中`、`失败`、`暂无截图`、`不可用`。
- 鼠标 hover 缩略图可以显示“查看详情”，但不新增干扰主操作的复杂动画。
- 移动端列表可以折叠成卡片，但缩略图仍位于卡片顶部或最左，不允许文本先出现。

## 执行任务清单

- [ ] 盘点所有生成记录列表现状截图，记录哪些已满足、哪些缺首列截图。
- [ ] 新增 `TaskVideoThumbnail` 公共组件和必要类型。
- [ ] 为公共组件补齐状态占位、图片错误降级、固定尺寸和可点击详情能力。
- [ ] 补齐 `/admin` 最近生成记录返回字段：`local_video_path`、`result_video_url`、`result_last_frame_url`。
- [ ] 补齐 `/admin/costs` 待处理队列任务字段。
- [ ] 改造 `/admin` 最近生成记录首列截图。
- [ ] 对齐 `/admin/outputs` 产出留存预览为公共缩略图口径。
- [ ] 改造 `/tasks` 任务列表，把选择框并入缩略图首列。
- [ ] 改造 `/projects/[id]` 历史/调试任务表格首列截图。
- [ ] 改造 `/projects/[id]` 成本账本任务行，统一本地优先和截图占位。
- [ ] 改造 `/projects/[id]/video-cards/[cardId]` 生成记录预览。
- [ ] 检查 `/generate` 最近任务卡片，确保桌面/移动端截图是第一视觉入口。
- [ ] 改造 `/admin/costs` 待处理队列首列截图。
- [ ] 做桌面和移动端视觉验收，确认无横向溢出、无文本顶到最左、截图不拉伸。
- [ ] 线上部署到 `sd2` 并验证公网页面已加载新 build。

## 验收标准

- 所有目标列表的第一视觉列都是视频截图/缩略图或稳定占位。
- 有本地视频或远端视频的任务，优先请求 `/api/video/thumbnail/:taskId` 展示截图。
- 没有截图来源、加载失败、生成中、失败任务，都有固定尺寸占位，不引发布局跳动。
- 提示词、日期、状态、项目名、成本、操作都不能在截图之前出现。
- `/admin`、`/admin/outputs`、`/tasks`、`/projects/[id]`、`/projects/[id]/video-cards/[cardId]`、`/generate`、`/admin/costs` 桌面和移动端均通过。
- 不触发真实付费生成任务。
- 不改变点数、成本、权限、隐藏/恢复、批量下载等业务逻辑。

## 验证命令

```bash
git diff --check
npm run lint
NEXT_DIST_DIR=.next-prod-dry-run npm run build
```

线上闭环：

```bash
/Users/gouki-youdoo/.youdoo/bin/youdoo-sites build sd2
/Users/gouki-youdoo/.youdoo/bin/youdoo-sites restart sd2
/Users/gouki-youdoo/.youdoo/bin/youdoo-sites status sd2
```

页面验收：

- 刷新 `https://sd2.youdoodesign.com/admin`，最近生成记录左侧有截图。
- 刷新 `https://sd2.youdoodesign.com/admin/outputs`，产出留存左侧有截图。
- 刷新 `https://sd2.youdoodesign.com/tasks`，任务列表左侧第一视觉是截图，选择框不抢首列。
- 刷新一个项目详情页，历史/调试任务和成本账本任务行左侧有截图。
- 刷新一个视频卡详情页，生成记录左侧有截图。
- 刷新 `https://sd2.youdoodesign.com/generate`，最近任务卡片截图仍然优先出现。
- 刷新 `https://sd2.youdoodesign.com/admin/costs#pending-costs`，待处理队列左侧有截图。

## Git Plan

- 当前工作区已有若干未提交源码改动，执行前必须先确认这些改动归属；本任务不得把无关改动混入提交。
- 推荐直接在当前 `codex/video-card-p0-closure` 分支继续，或如果现有改动不属于本任务，则创建干净 worktree 执行。
- 提交分组：
  - 提交 1：公共 `TaskVideoThumbnail` 组件和样式。
  - 提交 2：后端/API 数据字段补齐。
  - 提交 3：各列表接入缩略图。
  - 提交 4：验收记录、经验记录、版本登记。
- 完成后推送分支，创建 `rollback/YYYY-MM-DD-generation-list-thumbnails` 回退 tag，并验证远端可见。

## 停止条件

- 如果发现某个列表没有任务 ID 或无法安全访问 `/api/video/thumbnail/:taskId`，先停下补数据链路，不做纯前端假缩略图。
- 如果现有未提交改动和本任务改动冲突，先报告冲突文件，不覆盖不属于本任务的内容。
- 如果缩略图接口导致列表加载明显变慢，先补懒加载和失败缓存，不扩大为批量预取接口。
- 如果需要数据库迁移，先单独评估，不在本批默认引入 schema 变更。

---

# SD2 自动本地化生成视频策略 Todo

更新时间：2026-06-09

目标：每次视频生成任务在 Provider 侧成功后，系统自动把结果视频下载到服务器本地，写入 `public/videos/<taskId>.mp4`，数据库持久化 `local_video_path=/videos/<taskId>.mp4`，并尽量生成 `public/videos/thumbnails/<taskId>.jpg`，让任务页、列表页、后台和外部 API 都不依赖会过期的 Provider 签名 URL 做预览和截图。

## 当前现状与依据

- `src/lib/video/local-cache.ts` 的 `cacheTaskVideoToLocal` 已经具备本地保存能力：写入 `public/videos/<taskId>.mp4`，文件非空/大小校验后更新 `VideoTask.local_video_path`；遇到 403 时会尝试用 `getVideoTaskStatus` 刷新 `result_video_url`。
- `src/app/api/video/status/[id]/route.ts` 的 `GET` 在刷新 Provider 状态后，如果 `local_status=succeeded`，会调用 `cacheTaskVideoToLocal`，并同时处理 Provider 官方费用、点数结算、状态持久化。
- `src/app/api/video/download/[id]/route.ts` 的 `POST` 是手动下载入口，已复用 `cacheTaskVideoToLocal`。
- `src/app/api/video/thumbnail/[id]/route.ts` 的 `GET` 会先通过 `ensureLocalVideoForThumbnail` 尝试补齐本地视频，再用 ffmpeg 抽帧生成截图。
- `src/app/api/tasks/create/route.ts` 的 `POST` 在 `createVideoTask(providerInput)` 成功后只保存 `provider_task_id` 并返回 `submitted`，当前没有后台轮询或自动最终化任务。

结论：现有能力是“按需落盘”，不是“每次生成后自动落盘”。如果任务成功后没有人及时访问状态、下载或截图接口，Provider 签名 URL 过期后，本地视频和截图仍可能缺失。

## 成功标准

- 新生成任务不依赖用户打开详情页也能完成状态最终化：`submitted/running -> succeeded|failed|cancelled`。
- 成功任务自动落盘：`VideoTask.local_status='succeeded'` 且 `VideoTask.local_video_path='/videos/<taskId>.mp4'`。
- 本地文件真实可用：`public/videos/<taskId>.mp4` 存在、非空、可通过 `ffprobe` 读取时长和视频流。
- 截图可用：`/api/video/thumbnail/:taskId` 能返回图片；条件允许时主动生成 `public/videos/thumbnails/<taskId>.jpg`。
- 任务页、任务列表、后台输出和外部 API 返回都优先使用 `local_video_path`，Provider `result_video_url` 只作为短期来源，不作为长期预览地址。
- 结算闭环不被破坏：Provider 官方费用记录、点数扣费/退款、`completed_at` 仍只在终态时执行一次。
- 日志和文档不泄露 Provider 签名 URL、API key、cookie、token。

## 推荐策略

### 1. 抽出任务最终化服务

新增共享服务，建议路径：`src/lib/video/task-finalizer.ts`。

职责：

- 输入本地 `taskId`，读取 `VideoTask`。
- 调用 `getVideoTaskStatus(provider_task_id)` 刷新 Provider 状态。
- 统一持久化 `provider_status`、`local_status`、`raw_status_response`、`result_video_url`、`result_last_frame_url`、模型、分辨率、时长、错误信息等字段。
- 终态时统一处理 `completed_at`、Provider 官方费用记录、点数结算。
- 当终态为 `succeeded` 时调用 `cacheTaskVideoToLocal`。
- 本地视频保存成功后，可选择调用共享缩略图 helper 生成截图。

原则：不要把结算逻辑复制到后台 worker。`status` 路由、后台 runner、补偿脚本都应该调用同一个 finalizer，避免一次任务被多处重复扣费或重复结算。

### 2. 创建进程内自动轮询 runner

新增轻量 runner，建议路径：`src/lib/video/task-localization-runner.ts`。

触发点：

- 在 `src/app/api/tasks/create/route.ts` 中，Provider 创建成功并保存 `provider_task_id` 后，异步触发 runner。
- 触发不阻塞创建接口返回，创建接口仍快速返回 `submitted`。

运行策略：

- 每个 `taskId` 只允许一个 runner，使用进程内 `Map` 去重。
- 初始延迟 8-15 秒，之后每 10-20 秒调用 finalizer。
- 单任务最长轮询 15-20 分钟，超过后停止，由补偿任务接管。
- 遇到 `succeeded|failed|cancelled` 立即停止。
- 下载并发限制 2-3 个，避免多个大视频同时占满带宽或文件句柄。
- 日志只记录 `taskId`、阶段、状态、错误码，不记录完整签名 URL。

注意：Next.js/launchd 进程内 runner 是“及时落盘”的第一层保障，但进程重启、构建发布或异常退出会丢失内存状态，所以不能作为唯一保障。

### 3. 增加持久化补偿任务

增加第二层保障，建议二选一：

- 方案 A：内部接口 `/api/internal/video/finalize-pending`，由 launchd/cron 定时调用。
- 方案 B：Node 脚本 `scripts/finalize-pending-videos.ts`，由 launchd/cron 定时执行。

扫描范围：

- `local_status in ('submitted', 'running')` 且有 `provider_task_id` 的任务：继续刷新 Provider 状态。
- `local_status='succeeded'` 且 `local_video_path is null` 且有 `result_video_url` 的任务：补下载本地视频。
- 优先处理最近任务，尤其是 Provider URL 还没过期的任务。

建议频率：

- 每 2-5 分钟执行一次。
- 每轮最多处理 20-50 个任务。
- 每轮总运行时间设置上限，例如 60-120 秒。

补偿失败处理：

- 403 且刷新不到新 URL：记录“Provider 签名 URL 已过期，无法自动恢复”，不要自动重新生成付费任务。
- 网络超时：保留为下轮重试。
- 文件写入失败：记录磁盘路径、错误码、可用空间检查建议，不删除已存在的有效视频。

### 4. 截图生成策略

短期策略：

- 继续保持 `/api/video/thumbnail/:id` 的按需生成能力。
- 本地视频保存成功后，主动复用同一套 ffmpeg 抽帧逻辑生成缩略图。

推荐整理：

- 把 `thumbnail` 路由里的 `generateThumbnail`、路径校验、文件存在检查提取到 `src/lib/video/thumbnail.ts`。
- route 和 finalizer 共用 helper，避免两套 ffmpeg 参数不一致。

验收标准：

- `public/videos/thumbnails/<taskId>.jpg` 存在且非空。
- `/api/video/thumbnail/:taskId` 返回 200 和 `Content-Type: image/jpeg`。
- 如果 ffmpeg 不可用，视频落盘仍应成功，截图失败单独记录，不影响任务成功状态。

### 5. API 和前端展示规则

- `/api/video/status/:id`：返回时优先带 `local_video_path`；如果本地保存还在进行，可以附加内部状态字段，例如 `local_cache_status`，但不要泄露签名 URL。
- `/api/video/list`、任务详情页、后台输出页：预览优先使用 `local_video_path`；没有本地路径时显示“视频正在保存到本地”或“远程链接待保存”。
- `/api/video/download/:id`：继续作为手动补救入口，内部仍复用 `cacheTaskVideoToLocal`。
- 外部 API 文档：明确 `result_video_url` 是生成结果来源，不保证长期可预览；长期可用地址以 `local_video_path` 或网站返回的本地视频 URL 为准。

### 6. 数据与文件安全

- 不新增公开目录规则前，继续使用 `public/videos/<taskId>.mp4` 和 `public/videos/thumbnails/<taskId>.jpg`。
- `taskId` 必须做安全校验，只允许字母、数字、下划线、短横线。
- 下载使用临时文件，完整写入和校验后再 rename，避免半截 MP4 被页面读取。
- 不在日志、数据库额外字段、todo、文档中记录完整签名 URL。
- 后续如果视频量变大，再评估从 `public/videos` 迁到对象存储或独立 media volume；当前目标先闭环“生成后立即本地保存”。

## 执行计划

- [x] 梳理当前状态刷新、下载和截图入口，确认现状是按需落盘而非自动落盘。
- [x] 设计 `src/lib/video/task-finalizer.ts`：抽出 Provider 状态刷新、终态持久化、费用记录、点数结算、本地视频保存的统一函数。
- [x] 改造 `src/app/api/video/status/[id]/route.ts`：用 finalizer 替代内联刷新和结算逻辑，保持接口响应兼容。
- [x] 设计 `src/lib/video/task-localization-runner.ts`：提供 `startTaskLocalization(taskId)`，支持去重、轮询、超时、并发限制和脱敏日志。
- [x] 改造 `src/app/api/tasks/create/route.ts`：Provider 接受任务后异步启动 runner，不阻塞创建响应。
- [x] 增加补偿机制：实现内部定时接口或脚本，扫描 pending/running/succeeded-but-local-missing 任务并调用 finalizer。
- [x] 抽出 `src/lib/video/thumbnail.ts`：让 thumbnail route 和自动 finalizer 共用截图生成逻辑。
- [x] 更新列表、任务页、后台输出页的数据使用规则：已核对现有接口和页面会返回/优先使用 `local_video_path`，本轮未额外扩大修改。
- [x] 为历史成功但缺本地文件的任务写一次性 backfill 流程，只尝试恢复，不自动重新付费生成。
- [x] 补充外部 API 说明：生成成功后外部应轮询到终态，并优先使用网站本地视频地址；Provider 签名 URL 只作短期来源。
- [x] 验证构建和关键链路。
- [ ] 部署后跑一条真实或授权测试任务，确认无人打开详情页时也会自动落盘和生成截图。

## Git Plan

- 修改前检查 `git status`，确认现有用户改动，不混入无关文件。
- 建议在独立分支完成，例如 `codex/auto-localize-generated-videos`。
- 提交分组建议：
  - 提交 1：finalizer 抽取和 status route 复用。
  - 提交 2：runner 和 create route 触发。
  - 提交 3：补偿脚本/内部接口和 thumbnail helper。
  - 提交 4：前端/外部文档状态展示与验证记录。
- 若本地已有大量未提交改动，优先使用干净 worktree 或只提交本任务相关文件。

## 验证清单

- 构建验证：

```bash
npm run build
```

- 数据库验证：

```bash
sqlite3 prisma/dev.db "select id,source_type,local_status,result_video_url is not null as has_result,local_video_path from VideoTask order by created_at desc limit 20;"
```

- 本地视频文件验证：

```bash
test -f "public/videos/<taskId>.mp4" && ls -lh "public/videos/<taskId>.mp4"
ffprobe -v error -show_entries format=duration -show_streams "public/videos/<taskId>.mp4"
```

- 截图验证：

```bash
test -f "public/videos/thumbnails/<taskId>.jpg" && file "public/videos/thumbnails/<taskId>.jpg"
curl -I "https://sd2.youdoodesign.com/api/video/thumbnail/<taskId>"
```

- 公网视频验证：

```bash
curl -I "https://sd2.youdoodesign.com/videos/<taskId>.mp4"
```

- 行为验证：

```text
1. 创建任务后不打开任务详情页。
2. 等待 runner 或补偿任务自动刷新到 succeeded。
3. 检查 DB 已写入 local_video_path。
4. 检查 public/videos/<taskId>.mp4 存在且 ffprobe 可读。
5. 检查 thumbnail 可访问。
6. 打开任务页、列表页、后台输出页，确认预览使用本地视频。
```

## 停止条件

- 没有用户明确授权，不跑会消耗点数的真实生成任务。
- 如果发现结算逻辑无法安全抽出，先停下重新规划，不复制粘贴结算代码。
- 如果需要 Prisma schema 迁移，先单独评估迁移风险和现有数据兼容性。
- 如果 Provider 签名 URL 已过期且刷新不到新 URL，只记录不可恢复，不自动重新生成。
- 如果磁盘空间不足或 `public/videos` 不适合作为长期存储，先给出存储迁移方案再继续。

## 待确认问题

- 自动本地化是否覆盖所有生成来源，还是只覆盖 `source_type='codex_api'` 的外部 API 任务？推荐覆盖所有视频任务。
- 补偿任务采用内部接口还是独立脚本？推荐独立脚本加 launchd，更不依赖 HTTP 会话。
- 截图是只生成首帧缩略图，还是额外生成 contact sheet？推荐先首帧缩略图，contact sheet 留给验收工具。
- 视频本地保留多久？当前先永久保留，后续再设计 retention/清理策略。

## Review - 2026-06-09

- 已实现统一 finalizer：状态刷新、终态持久化、点数结算、Provider 官方扣费、本地视频保存和缩略图生成集中到 `src/lib/video/task-finalizer.ts`。
- 已实现创建后自动 runner：`src/app/api/tasks/create/route.ts` 在 Provider 接受任务后调用 `startTaskLocalization(taskId)`，不阻塞创建响应。
- 已实现补偿脚本：`scripts/finalize-pending-videos.ts` 可扫描 `submitted/running` 和 `succeeded` 但缺少 `local_video_path` 的任务；支持 `--dry-run`、`--limit`、`--max-seconds`。
- 已抽出截图 helper：`src/lib/video/thumbnail.ts` 供自动 finalizer 和 `/api/video/thumbnail/:id` 共用；截图失败不会影响视频任务成功状态。
- 已补 Provider 响应日志脱敏：`src/lib/provider/jimeng.ts` 不再直接打印完整签名 URL。
- 已验证：`npx tsc --noEmit --pretty false` 通过；`npx tsx scripts/finalize-pending-videos.ts --dry-run --limit 3 --max-seconds 10` 通过；`npm run build` 通过，仅有既有 `<img>` 和 React hook lint warning。
- 未执行：未跑真实付费生成任务，未部署生产，未配置 launchd/cron 定时执行补偿脚本。

---

# 任务详情页功能与交互重构 Todo

更新时间：2026-06-09

目标页面：`/tasks/[id]`，当前代表页面为 `https://sd2.youdoodesign.com/tasks/cmq1qrmem0028ycido2agm4nv`。

## 当前代码依据

- 页面主入口：`src/app/tasks/[id]/page.tsx` 的 `TaskDetailPage`。
- 结果区与操作：`TaskDetailPage` 内 `resultStateTitle`、`resultDecisionBody`、`handleDownloadToLocal`、`handleOpenVideo`、`handleCopyUrl`、`queryStatus`、`handleRetry`。
- 输入摘要与素材：`TaskDetailPage` 内 `parameterItems`、`advancedParameterItems`、`referenceImages`、`referenceAssets`。
- 排障与账务：`TaskDetailPage` 内 `extractProviderBilling`、`extractEmbeddedOfficialCharges`、`fetchOfficialCharges`、`handleMoveProject`、`ReferenceImageDebug`。
- 状态和样式：`getStatusText`、`getStatusClass`、`getRetentionText`、`costStatusLabel`，以及 `src/app/globals.css` 的 `task-result-*`、`task-detail-*`、`task-ops-*` 相关样式。

## 第一性原理

这个页面不是“任务详情档案页”，而是“生成结果决策页”。用户进来最想完成三件事：

1. 看结果是否成功、能不能播放。
2. 知道这次实际花了多少钱和多少点数。
3. 立刻执行下一步：保存、打开、复制链接、复用输入继续调整，或失败后重试。

运维、账务、项目归属、原始响应都必须保留，但它们不应抢第一屏主任务。

有没有更优雅的方式：把页面重构成“主舞台 + 决策侧栏 + 折叠审计区”，而不是继续向当前单页里堆卡片。这样既保留所有功能，又让普通用户只看最需要的内容，管理员按需展开高级功能。

## 页面核心任务

- 核心任务：围绕一个生成任务做结果确认和下一步处理。
- 3 秒内应看见：
  - 任务当前状态。
  - 视频结果或明确的空状态。
  - 实际扣费金额。
  - 最推荐的下一步按钮。
- 最高频动作：
  - 成功：保存视频、本地打开、复制本地链接、复用输入。
  - 生成中：刷新状态、开启自动刷新。
  - 失败：查看失败原因、复用输入、重新生成。

## 信息层级

### 一级信息，首屏必须可见

- 状态：生成中、已完成、失败、取消。
- 视频预览或空状态。
- 实际扣费：USD 金额，必要时同时展示点数。
- 本地保存状态：本地已保存、远程链接待保存、没有视频链接。
- 主操作按钮。

### 二级信息，首屏可见但弱化

- 输入摘要：模式、比例、时长、分辨率、参考图数量。
- 项目归属名称。
- 完成时间。
- Provider 状态简写。

### 三级信息，默认折叠或移到侧栏

- 完整提示词。
- 完整参数。
- 参考图片、首尾帧、参考视频、参考音频。
- official_charge 账本。
- Provider 返回扣费。
- billing_status、billing_time、usage tokens。
- Provider ID、clientRequestId。

### 四级信息，只给管理员或排障场景

- 项目归属调整。
- 参考图调试信息。
- raw_create_response。
- raw_status_response。

## 功能保留清单

必须保留，不允许在 UI 重构中删除：

- 返回任务列表。
- 新建任务。
- 状态 badge。
- retention 状态提示。
- 刷新结果。
- 自动轮询。
- 失败后重新生成。
- 视频预览。
- 视频预览失败提示。
- 保存视频到本地。
- 打开本地视频。
- 保存并复制或复制本地链接。
- 下载状态、进度、错误和重试保存。
- 复用输入。
- 失败原因。
- 输入摘要。
- 完整提示词。
- 完整参数。
- 参考图片、首尾帧、多帧图片、参考视频、参考音频。
- Workspace 参考图资产展示。
- 运维信息摘要。
- 官方成本状态。
- 官方真实成本。
- Provider 返回扣费。
- official_charge 账本记录。
- 项目归属调整和原因。
- 技术调试与原始响应。

## 推荐页面结构

### 顶部导航

保留弱导航，不抢主任务：

- 左侧：返回任务。
- 中间：任务短 ID、创建时间、状态。
- 右侧：新任务。
- 不在顶部放太多操作，避免和结果区主按钮竞争。

### 主舞台：生成结果

第一屏最大区域，承载视频和结果决策。

显示内容：

- 标题按状态变化：
  - 成功：生成结果。
  - 生成中：正在生成。
  - 失败：生成失败。
  - 无结果：暂无结果。
- 副文案只回答“现在该做什么”，不重复标题。
- 视频区域保持稳定比例，避免空状态、错误提示、视频加载时跳动。
- 视频右上角显示实际扣费，但不能遮挡播放器控制条。
- 视频下方显示本地保存状态。

主按钮规则：

- 成功且未本地保存：主按钮为“保存视频”。
- 成功且已本地保存：主按钮为“打开视频”。
- 生成中：主按钮为“刷新结果”。
- 失败：主按钮为“复用输入”。
- 无结果但有 provider task：主按钮为“刷新结果”。

次级按钮：

- 复制本地链接。
- 复用输入。
- 重新生成，只有失败时出现。
- 重试保存，只有保存失败时出现。

### 决策侧栏：本次任务概要

桌面端放右侧，移动端放在结果区下方。

必须包含：

- 实际扣费：USD。
- 点数扣除或冻结状态。
- 本地保存状态。
- 项目归属。
- 模式、比例、时长、分辨率。
- 完成时间。

交互规则：

- 侧栏只放决策需要的信息，不放原始 JSON。
- 每一项都用短标签和可复制值。
- Provider ID、clientRequestId 默认隐藏到“技术信息”。

### 输入复盘区

目标：让用户判断是否要复用输入继续调整。

默认展示：

- 提示词前 3 到 5 行。
- 输入参数 chips。
- 参考图缩略图前 4 张。

默认折叠：

- 完整提示词。
- 全部参数。
- 全量参考素材。
- Provider payload 的 resolved mode。

按钮：

- 复用输入。
- 复制提示词，可作为次级或 overflow。

### 参考素材区

合并当前重复展示的“参考素材”和“参考图资产”：

- 一个统一模块展示所有输入素材。
- 按类型分组：参考图、首尾帧、多帧图片、参考视频、参考音频。
- Workspace 资产显示资产名和 providerAssetId，但默认只展示资产名，ID 在 hover 或详情中显示。
- 超过 6 个素材默认折叠，提供“查看全部”。

### 排障与账务区

默认折叠，标题建议为“账务与排障”，不要让普通用户误以为必须处理。

首层可见：

- 官方成本状态。
- 官方真实成本。
- Provider 返回扣费。
- official_charge 是否存在。

二层折叠：

- official_charge 账本行。
- billing_status。
- billing_time。
- usage tokens。
- provider_task_id。
- clientRequestId。

管理员功能：

- 项目归属调整放在独立子面板。
- 必须展示当前项目、目标项目、原因、结果反馈。
- 如果目标项目等于当前项目，按钮禁用并说明原因。

技术调试：

- 单独折叠为“技术调试”。
- raw_create_response、raw_status_response、参考图解析信息默认关闭。
- JSON 区域必须支持复制和横向滚动，避免撑破页面。

## 状态设计

### Loading

- 不显示孤立的“加载中...”卡片。
- 使用骨架：
  - 顶部状态骨架。
  - 视频舞台骨架。
  - 侧栏摘要骨架。

### Succeeded

- 视频是主视觉。
- 主按钮根据本地保存状态变化。
- 实际扣费常驻展示。
- 如果未保存到本地，给出弱提示：远程链接可能过期，建议保存。

### Submitted / Running

- 主舞台显示进度感，不要只给空框。
- 主按钮为刷新结果。
- 自动轮询作为开关放在刷新旁。
- 如果轮询开启，显示下一次刷新倒计时或最近刷新时间。

### Failed

- 主舞台直接展示失败原因摘要。
- 主按钮为复用输入。
- 次按钮为重新生成。
- 排障信息折叠保留。

### Video Preview Failed

- 不只显示“视频预览失败”。
- 明确给出操作顺序：
  - 保存到本地。
  - 打开视频。
  - 复制本地链接。
  - 仍失败则刷新状态或复用输入。

### Local Save Failed

- 保存失败要显示错误原因、重试按钮、是否可能 Provider 链接过期。
- 如果已无远程链接，隐藏“保存视频”，主操作变为“刷新结果”或“复用输入”。

### No Permission / Not Found

- 保留返回列表。
- 不暴露敏感任务信息。
- 如果是留存状态导致不可见，给出普通用户可理解的提示。

## 交互细节

### 按钮层级

- 每个状态只允许一个最强主按钮。
- 保存、打开、刷新、复用、重新生成不能同一视觉权重。
- 危险或付费相关动作要有确认或明确提示。

### 复制行为

- 复制本地链接前，如果本地未保存，允许自动保存。
- 自动保存过程必须有进度和可取消或可重试反馈。
- 复制成功状态保留 2 秒。

### 保存行为

- 保存视频按钮应解释保存到哪里：本地长期链接。
- 已保存后按钮变为只读状态，主按钮切换为打开视频。
- 进度条只在真实保存中出现；完成后可折叠为状态行。

### 复用输入

- 复用输入在成功和失败状态都重要，但失败时应升为主操作。
- 复用前不需要确认，因为不消耗点数，只进入生成页。
- 复用入口旁边显示会带走哪些内容：提示词、比例、时长、参考素材。

### 项目归属调整

- 默认折叠。
- 管理员或可管理项目用户才显示。
- 修改前显示影响：成本归属将追加转移记录，不覆盖旧账。
- 原因必填。

## 移动端规划

- 顶部动作合并为一行：返回、状态、新任务。
- 视频舞台占满宽度。
- 决策侧栏下移为“任务摘要”折叠区，但实际扣费仍在视频下方常驻。
- 主按钮固定在结果区下，不做全局 sticky，避免遮挡视频 controls。
- 素材网格每行 2 到 3 个。
- JSON 和长 URL 必须横向滚动，不允许撑出视口。

## 视觉方向

产品型工具界面，走克制信息工作台，不做营销页面。

- 背景保持浅灰工作区。
- 结果舞台使用白色或轻蓝 tint，强调当前任务。
- 状态色只服务状态，不做装饰。
- 实际扣费使用中性高对比胶囊，不使用夸张红色，避免误读为错误。
- 操作按钮统一尺寸和图标规则。
- 不使用嵌套卡片。主舞台、侧栏、折叠区是并列区域。

## 实施计划

### P0：信息架构和首屏

- [ ] 把页面改为“主舞台 + 决策侧栏 + 下方详情”的结构。
- [ ] 定义 `TaskPrimaryAction`，按任务状态只输出一个主按钮。
- [ ] 把实际扣费、点数状态、本地保存状态放入首屏摘要。
- [ ] 把视频空状态、生成中状态、失败状态统一成稳定的结果舞台。
- [ ] 把视频预览失败提示改为操作步骤提示。
- [ ] 保留当前所有功能入口，不删除任何操作。

### P1：输入复盘和素材整理

- [ ] 合并“输入摘要”和“参考图资产”重复区域。
- [ ] 默认展示短提示词和关键参数，完整内容放到展开区。
- [ ] 参考素材按类型分组，超过 6 个折叠。
- [ ] 为提示词增加复制按钮。
- [ ] 复用输入旁展示将复用的内容范围。

### P1：账务与排障下沉

- [ ] 将“排障与账务”改为默认折叠的高级区。
- [ ] 首层只展示官方成本状态、官方真实成本、Provider 返回扣费、账本是否存在。
- [ ] official_charge 账本行放入二层折叠。
- [ ] Provider ID、clientRequestId、usage tokens 放入技术信息。
- [ ] raw_create_response、raw_status_response 支持复制和横向滚动。

### P1：项目归属调整

- [ ] 项目归属调整从账务信息中独立成“管理操作”子区。
- [ ] 展示当前项目、目标项目、原因和影响说明。
- [ ] 原因为空时禁用按钮并提示。
- [ ] 移动成功后刷新项目归属和成本归属状态。

### P2：状态反馈和细节 polish

- [ ] Loading 改为骨架屏。
- [ ] 自动轮询显示最近刷新时间或倒计时。
- [ ] 保存进度完成后折叠成状态行。
- [ ] 移动端检查视频 controls、扣费角标、主按钮不重叠。
- [ ] 所有按钮补齐 hover、focus、disabled、loading 状态。

## 建议拆分组件

- `TaskDetailPageShell`
- `TaskResultStage`
- `TaskDecisionPanel`
- `TaskPrimaryActions`
- `TaskInputReview`
- `TaskReferenceAssets`
- `TaskBillingSummary`
- `TaskProjectMovePanel`
- `TaskTechnicalDebugPanel`
- `TaskStateMessage`

## 验收清单

- [ ] 用户 3 秒内能判断任务状态、是否有视频、实际扣费、下一步点击什么。
- [ ] 成功、生成中、失败、无结果、预览失败、保存失败都有明确状态文案和操作路径。
- [ ] 每个状态只有一个最强主按钮。
- [ ] 保存、打开、复制、复用、刷新、重试、重新生成都仍可达。
- [ ] 输入参数和参考素材仍完整可查。
- [ ] official_charge 和 Provider 账务信息仍完整可查。
- [ ] 项目归属调整仍可用，并保留原因和日志语义。
- [ ] raw response 和参考图调试仍可用，但默认不干扰普通用户。
- [ ] 桌面和移动端无文字溢出、按钮重叠、视频控件遮挡。
- [ ] `npx impeccable detect 'src/app/tasks/[id]/page.tsx'` 通过。
- [ ] `npm run lint` 和 `npx tsc --noEmit` 通过。

## 停止条件

- 如果发现某个现有功能入口无法在新结构中保留，先停止并重新规划，不直接删除。
- 如果项目归属调整涉及权限规则变化，先读 API 约束再改 UI。
- 如果扣费字段含义不确定，不新增换算规则，只展示后端已确认字段。
- 如果需要新接口支持任务摘要，先做兼容方案，不破坏现有 `/api/video/status/[id]` 响应。

---

# 用户与点数管理后台重构 Todo

更新时间：2026-06-10

目标页面：`/admin/users`。当前 `/admin/points` 只做管理员鉴权后重定向到 `/admin/users`，所以“用户管理”和“点数管理”实际集中在同一个页面。

## 当前代码依据

- 页面入口：`src/app/admin/users/page.tsx` 的 `AdminUsersPage`，只允许管理员访问。
- 点数入口：`src/app/admin/points/page.tsx` 的 `AdminPointsPage`，管理员访问后直接 `redirect('/admin/users')`。
- 前端主组件：`src/app/admin/users/AdminUsersClient.tsx` 的 `AdminUsersClient`。
- 用户列表与创建：`src/app/api/admin/users/route.ts` 的 `GET`、`POST`。
- 用户详情、编辑、软删除：`src/app/api/admin/users/[id]/route.ts` 的 `GET`、`PATCH`、`DELETE`。
- 启用/禁用：`src/app/api/admin/users/[id]/enable/route.ts`、`src/app/api/admin/users/[id]/disable/route.ts`。
- 批量用户类型：`src/app/api/admin/users/bulk-profile/route.ts`。
- 账号合并：`src/app/api/admin/users/merge/route.ts`。
- 单人点数操作：`src/app/api/admin/credits/adjust/route.ts`。
- 批量发放点数：`src/app/api/admin/credits/bulk-grant/route.ts`。
- 点数流水：`src/app/api/admin/credits/ledger/route.ts`。
- 点数策略：`src/app/api/admin/credits/policy/route.ts`、`src/lib/credits/policy.ts`。
- 用户类型和能力档案：`src/lib/users/profiles.ts`。

## 当前功能盘点

### 1. 访问与路由

- `/admin/users`：管理员后台页面，非登录用户跳转 `/login`，非管理员跳转 `/generate`。
- `/admin/points`：没有独立界面，只重定向到 `/admin/users`。
- 页面标题是“用户与点数管理”，当前同时承担账号、权限、点数、策略、合并、流水等多个工作流。

### 2. 用户列表

- 加载所有非 `deleted` 用户。
- 展示姓名、账号、邮箱、账号来源、系统身份、飞书绑定状态、用户类型、能力档案、点数、状态、最近登录。
- 点数展示包含长期余额、长期冻结、每日额度剩余、每日额度冻结、总可用点数。
- 支持搜索姓名 / 账号 / 邮箱。
- 支持筛选账号来源、用户类型、能力档案、状态。
- 前端分页，每页 20 人。
- 支持勾选单个用户、全选当前筛选结果、清空选择。
- 支持“只选”某个用户，并自动把单人点数操作指向该用户。

### 3. 单个用户操作

- 编辑账户属性：姓名、账号、邮箱、账号来源、管理员/普通用户、用户类型、能力档案、状态、过期时间。
- 编辑必须填写原因。
- 编辑前会对敏感变化做确认，包括系统身份、状态、账号来源。
- 外部账号只能作为普通用户，能力档案强制为 `external_limited`。
- 管理员必须是内部账号；飞书绑定账号设为管理员时后端会按内部账号兜底。
- 不能让当前登录管理员失去后台访问权限。
- 不能移除最后一个可用管理员。
- 启用账号要求账号未删除、未过期。
- 禁用账号不能禁用当前登录账号，也不能禁用最后一个可用管理员。
- 删除是软删除：状态改为 `deleted`，历史任务和点数流水保留。
- 不能删除当前登录管理员，也不能删除最后一个可用管理员。

### 4. 创建用户

- 创建字段：姓名、账号、邮箱、初始密码、角色、账号来源、用户类型、能力档案、初始点数、原因。
- 用户名或邮箱不能重复。
- 管理员必须是内部账号。
- 外部账号强制普通用户、`other` 用户类型和 `external_limited` 能力档案。
- 可一键套用当前点数策略建议的初始点数。
- 创建后会自动创建 `CreditAccount`。
- 创建后会按策略或输入点数发放初始点数。
- 创建后会自动创建个人默认项目，并把用户加入为 `project_owner`。
- 创建、初始点数、默认项目都会写操作日志。

### 5. 点数策略

- 管理新用户初始点数。
- 初始点数区分内部新用户、外部新用户。
- 可控制是否应用到自注册、飞书首次登录自动创建、管理员创建用户。
- 管理每日固定额度。
- 每日额度区分内部默认、外部默认、各用户类型 override。
- 每日额度有效期限制为 1-168 小时。
- 每日额度按上海时间懒发放。
- 任务消费优先使用每日额度，再使用长期余额。
- 过期未使用每日额度可清零；已冻结额度等待任务结算后关闭或返还。

### 6. 单人点数操作

- 支持发放、扣减、修正为指定长期余额。
- 必须选择用户、输入点数、填写原因。
- 发放和扣减金额必须大于 0；修正允许为 0。
- 扣减只扣长期可用余额，不扣每日额度。
- 扣减不能超过长期可用余额。
- 修正后的长期余额不能低于已冻结点数。
- 操作需要浏览器二次确认。
- 操作会更新 `CreditAccount`，写 `CreditLedger`，写 `operationLog`。

### 7. 批量点数发放

- 对已选用户每人发放同样点数。
- 单次最多 200 个用户。
- 必须填写发放原因。
- 操作前会提示前三个用户名、总人数和总点数。
- 禁用用户也可入账，但启用前不能登录使用。
- 每个用户都会写 `admin_grant` 流水和操作日志。
- 批次本身也会写一条批量操作日志。

### 8. 批量修改用户类型

- 对已选用户批量修改用户类型和能力档案。
- 单次最多 200 个用户。
- 支持自动建议能力档案。
- 外部账号会强制使用 `other` 用户类型和 `external_limited` 档案。
- 必须填写修改原因。
- 每个用户写单条操作日志，并额外写批次日志。

### 9. 重复账号合并

- 先勾选源账号，再选择最终保留账号。
- 保留账号必须是启用状态。
- 源账号至少 1 个，单次最多 20 个。
- 管理员账号不能作为源账号，只能作为保留账号。
- 源账号会软删除并无法登录。
- 合并会转移或合并长期余额、冻结点数、月使用量、总使用量。
- 合并会写 `account_merge_in` 和 `account_merge_out` 点数流水。
- 合并会迁移视频任务、任务 owner、项目 owner、画布、参考图集、参考图、Provider 请求、成本账本、成本分摊、反馈、工作区、资产和资产集合。
- 合并会处理项目成员：保留更高角色、更活跃状态、更早加入记录。
- 合并会处理图集分享权限：合并权限 JSON，保留 active 状态。
- 合并会挑选并迁移最佳飞书身份，清空源账号飞书身份。
- 合并会写详细操作日志，包含迁移计数、点数转移和飞书身份转移。

### 10. 点数流水

- 展示最近点数流水，默认每页 50 条。
- 字段包含时间、用户、类型、变动、余额变化、冻结变化、原因。
- 后端支持按 `user_id` 和 `type` 过滤，但当前页面没有暴露这两个筛选入口。
- 流水按创建时间倒序展示。

## 当前易用性问题

- 一个页面同时展示用户列表、点数策略、账户编辑、批量类型、账号合并、批量发放、创建用户、单人点数操作和点数流水，第一屏焦点过多。
- `/admin/points` 是重定向，导航名称和页面实际结构不一致，用户会以为有独立点数页面但看不到。
- 所有高风险操作都平铺在右侧，创建、合并、批量发放、策略保存的视觉权重接近，容易误操作。
- 用户列表是主工作区，但右侧表单过多，普通查询、管理员操作和危险操作没有分层。
- 选择用户后的下一步不明确：勾选用户既可批量发放、批量修改、合并，也可单人点数操作。
- 点数策略是低频配置，却放在右侧最上方，压过高频的用户查看和单人处理。
- 点数流水和当前选中用户没有联动，排查某个用户点数问题需要手动找。
- 单人点数操作没有展示操作后的余额预览，只依赖 confirm 文案。
- 账号合并已经有强后端能力，但前端只是单个表单，缺少分步骤影响预览和迁移范围确认。
- 用户编辑、创建用户和策略配置使用大量 inline style，后续重构难以保持一致性。
- 表格列偏多，行内按钮过多；删除、禁用这类危险操作和普通编辑并列显示。

## 重构原则

- 不删除原功能。只能做入口归位、显隐分层、流程拆分和信息架构优化。
- 页面定位从“功能堆叠后台”改为“用户运营工作台”。
- 主任务是定位用户、理解账户/点数状态、执行最合适的下一步。
- 高频查看和单人处理优先；低频策略、批量、合并、危险操作下沉。
- 每个状态只给一个最强主按钮，其余动作进入次级按钮或更多菜单。
- 所有会改变权限、登录状态、点数、账号归属的操作必须保留原因、预览、二次确认和日志语义。

## 推荐页面结构

### 顶部：范围和关键状态

- 标题：用户与点数工作台。
- 保留当前管理员身份提示。
- 增加全局搜索框。
- 增加快速视图：
  - 全部用户
  - 可登录用户
  - 管理员
  - 飞书绑定
  - 点数异常
  - 今日额度不足
  - 待开通 / 已禁用 / 已过期
- 增加轻量统计：
  - 总用户数
  - 可登录用户数
  - 管理员数
  - 总长期余额
  - 总冻结点数
  - 今日额度剩余

### 主区：用户表格

- 第一屏只保留用户表格和右侧用户详情/动作面板。
- 表格建议列：
  - 用户：姓名、账号、邮箱、飞书标识。
  - 权限：管理员/普通、内部/外部、状态。
  - 类型：用户类型、能力档案。
  - 点数：长期可用、冻结、今日剩余。
  - 活跃：最近登录、创建时间。
  - 风险：过期、禁用、点数不足、无飞书绑定。
  - 操作：更多菜单。
- 行点击选中用户；行内只保留一个“详情/处理”入口。
- 禁用、删除、合并这类危险动作移入更多菜单或详情面板危险区。

### 右侧：选中用户决策面板

- 未选中时展示筛选结果摘要和常用入口。
- 选中用户后展示：
  - 账户状态：是否可登录、是否管理员、是否飞书绑定、是否过期。
  - 点数钱包：长期余额、长期冻结、今日额度、今日冻结、总可用。
  - 推荐动作：例如发放点数、启用账号、编辑属性、查看流水。
  - 最近 5 条点数流水。
  - 最近任务/消费摘要，后续可接入。
- 主按钮随状态变化：
  - active 普通用户：发放点数。
  - disabled/pending/expired：处理登录状态。
  - 管理员：编辑管理员身份。
  - 点数异常：查看流水。

### 批量操作条

- 只有勾选用户后才出现。
- 展示已选人数、管理员数量、外部账号数量、总可用点数、总冻结点数。
- 主要批量动作：
  - 批量发放点数。
  - 批量修改用户类型。
  - 发起账号合并。
- 危险或复杂批量动作进入分步弹窗，不在右侧常驻。

### 点数操作

- 单人点数操作从常驻表单改为“钱包抽屉”。
- 操作模式：发放、扣减、修正为。
- 展示当前长期余额、冻结、可扣余额、操作后余额。
- 扣减时实时提示最大可扣值。
- 修正时实时校验不能低于冻结点数。
- 必须填写原因。
- 确认弹窗展示 before / delta / after。

### 创建用户

- 从常驻表单改为“创建用户”抽屉或分步弹窗。
- 步骤建议：
  1. 身份信息：姓名、账号、邮箱、初始密码。
  2. 权限与类型：普通/管理员、内部/外部、用户类型、能力档案。
  3. 点数与项目：初始点数、每日额度预览、默认项目说明。
  4. 确认：展示将创建的账号、点数、项目和原因。
- 创建管理员时明确提示“管理员必须是内部账号”。
- 外部账号时隐藏无效选项，只说明会使用外部受限档案。

### 账号合并

- 从常驻表单改为独立向导。
- 步骤建议：
  1. 选择保留账号：只能选 active 账号。
  2. 选择源账号：排除管理员源账号，最多 20 个。
  3. 影响预览：点数转移、冻结转移、任务、项目、图集、成本、反馈、资产、飞书身份。
  4. 最终确认：输入原因并二次确认。
- 如果已选源账号包含管理员，直接阻断并解释“管理员只能作为保留账号”。
- 合并完成后展示迁移计数摘要。

### 点数策略

- 从主屏右侧常驻区移动到“策略”标签页或设置抽屉。
- 分成两个配置块：
  - 新用户初始点数。
  - 每日固定额度。
- 保存前展示变更 diff。
- 保存后提示影响范围：自注册、飞书自动创建、管理员创建、每日额度。
- 增加策略试算器：选择角色、账号来源、用户类型后预览初始点数和每日额度。

### 点数流水

- 从页面底部长表格升级为“流水”标签页或选中用户面板内嵌。
- 全局流水表增加筛选：
  - 用户
  - 类型
  - 时间范围
  - 操作人
  - 正向 / 负向 / 修正 / 冻结相关
- 选中用户时默认展示该用户流水。
- 流水行支持展开 metadata 和操作日志关联。

## 实施计划

### P0：信息架构和功能保全

- [x] 盘点 `/admin/users` 和 `/admin/points` 的当前功能与 API 约束。
- [x] 确认 `/admin/points` 是否保留重定向，还是改为点数管理标签直达链接。
- [x] 建立重构后的一级结构：顶部状态区、用户主表、右侧详情面板、批量操作条、低频配置区。
- [x] 列出所有现有功能入口在新结构中的位置，确保没有功能被删除。
- [x] 定义危险操作分层：禁用、删除、合并、管理员身份变更、点数扣减、点数修正。

### P1：用户表格和选中用户面板

- [x] 重构用户表格列，控制在 6-7 个扫描关键列。
- [x] 行点击选中用户，右侧展示账户、飞书、点数、额度、最近流水。
- [ ] 行内只保留详情入口和更多菜单，删除/禁用下沉。
- [x] 快速筛选改为视图 chip，保留高级筛选。
- [x] 用户分页保持每页 20，后续如数据量增加再改服务端筛选分页。

### P1：单人编辑和点数操作

- [ ] 把账户属性编辑改为抽屉，保留所有字段和影响预览。
- [ ] 账户属性保存前展示变更 diff 和原因。
- [ ] 把单人点数操作改为钱包抽屉，实时展示 before / delta / after。
- [ ] 扣减和修正操作保留后端约束提示。
- [ ] 保存成功后局部刷新用户和该用户流水。

### P1：批量操作

- [x] 勾选用户后显示批量操作条。
- [ ] 批量发放点数改为弹窗，展示人数、总点数、禁用用户提示。
- [ ] 批量修改用户类型改为弹窗，展示外部账号强制档案规则。
- [ ] 批量操作确认页保留原因和二次确认。
- [x] 批量完成后清空选择并刷新列表。

### P1：账号合并向导

- [ ] 把合并重复账号改为 4 步向导。
- [x] 保留账号只允许 active 用户。
- [x] 源账号阻止管理员，单次最多 20 个。
- [x] 影响预览展示点数、冻结、任务、项目、图集、成本、资产、飞书身份迁移范围。
- [x] 完成后展示后端返回的迁移计数。

### P2：策略和流水

- [x] 点数策略移到策略标签页或设置抽屉。
- [ ] 保存策略前展示变更 diff。
- [ ] 增加策略试算器，帮助管理员理解初始点数和每日额度。
- [ ] 点数流水增加用户、类型、时间范围、操作人筛选。
- [x] 选中用户后流水默认按该用户过滤。
- [ ] 流水行支持展开原因、metadata 和关联操作日志。

### P2：视觉与交互 polish

- [x] 移除 `AdminUsersClient` 中大面积 inline style，沉淀为 CSS class 或组件。
- [x] 页面使用安静的后台工作台风格，避免所有模块同等强度。
- [x] 主按钮、次按钮、危险按钮、文本按钮统一层级。
- [x] 表格、抽屉、弹窗、确认页补齐 loading、empty、error、disabled、focus 状态。
- [x] 移动端至少保证用户表可横向滚动，详情面板改为底部抽屉。

## 验收清单

- [ ] 管理员 3 秒内能看懂：当前筛选用户、选中用户状态、点数状态、下一步建议。
- [ ] `/admin/users` 当前所有功能在新结构里都有入口。
- [ ] `/admin/points` 的导航语义明确，不再让用户误以为页面丢失。
- [ ] 创建用户、编辑账户、启用、禁用、软删除、批量类型、批量发放、单人点数、账号合并、点数策略、点数流水全部可达。
- [ ] 管理员保护规则不被破坏：不能失去当前管理员权限、不能删除/禁用最后一个可用管理员。
- [ ] 外部账号规则不被破坏：外部账号只能普通用户，能力档案强制外部受限。
- [ ] 点数约束不被破坏：扣减只扣长期可用余额，修正不能低于冻结点数。
- [ ] 合并约束不被破坏：保留账号 active，源账号非管理员，源账号最多 20 个。
- [ ] 批量约束不被破坏：批量发放和批量类型单次最多 200 人。
- [ ] 所有高风险操作仍有原因、预览和二次确认。
- [ ] `npm run lint` 和 `npx tsc --noEmit --pretty false` 通过。

## 停止条件

- 如果新结构无法保留某个现有功能入口，先停止并重新规划，不直接删除。
- 如果需要改变点数、登录、管理员权限、账号合并后端规则，先单独评估并得到确认。
- 如果发现 `/admin/users` 当前线上行为和源码不一致，先用浏览器和接口确认真实状态，再继续设计。
- 如果需要新增数据库字段或 Prisma 迁移，先拆成独立任务。

## Review - 2026-06-10

- 已落地首屏信息架构：`src/app/admin/users/AdminUsersClient.tsx` 改为顶部统计、快速视图、用户主表、右侧用户决策面板、批量操作条和工具面板。
- 已保留原有业务功能入口：创建用户、编辑账户、启用、禁用、软删除、单人点数、批量发放、批量类型、账号合并、点数策略和全局点数流水仍在同页可达。
- 已把低频功能从首屏常驻区下沉到工具切换区：策略、创建、批量、合并、单人点数不再和用户列表同等抢焦点。
- 已加入选中用户决策面板：展示可登录状态、系统身份、总可用、总冻结、长期余额、今日额度、风险标签和最近 5 条点数流水。
- 已加入快速视图：全部用户、可登录、管理员、飞书绑定、点数异常、今日额度不足、待处理状态。
- 已加入批量操作条：勾选用户后展示人数、管理员数、外部账号数、总可用和总冻结，并提供批量发放、批量类型和账号合并入口。
- 已补样式：`src/app/globals.css` 新增后台工作台、表格、决策面板、工具面板、移动端响应式样式。
- 已验证：`npx tsc --noEmit --pretty false` 通过；`npm run lint` 通过但仍有既有 warning；`npx impeccable detect 'src/app/admin/users/AdminUsersClient.tsx'` 通过。
- 未完成：批量发放/批量类型还不是独立弹窗；账号合并还不是完整 4 步向导；全局流水还没有用户、类型、时间范围、操作人筛选；行内删除/禁用仍作为弱文本按钮保留，未做更多菜单。

---

# 后台反馈优化落地 Todo

更新时间：2026-06-10

目标：把后台反馈中的权限、连续生成、偏好保存、返回来源、图集管理、产出归属、账号展示和状态颜色问题分批落地。项目代付涉及计费主体变化，必须先独立 Spec，不混入普通 UI 修复。

## Batch 1：权限矩阵与隔离验证

- [x] 新增 `scripts/task-permission-matrix-smoke.ts`。
- [x] 复用当前 session cookie 签名方式，不打印 cookie、token 或签名 URL。
- [x] 自动选择本地 active 管理员、普通用户、项目成员作为样本。
- [x] 校验 `/api/video/list` 和 `/api/video/list?include_all=true` 不向普通用户/项目成员泄露非授权任务。
- [x] 校验非授权 `/api/video/status/:id` 返回 403/404。
- [x] 校验非授权 `/api/video/thumbnail/:id` 返回 403/404。
- [x] 校验非管理员访问 `/api/admin/outputs` 返回 401/403。
- [x] 校验项目成员只能访问自己有权限的项目任务列表。
- [x] 运行 `BASE_URL=http://localhost:3000 npx tsx scripts/task-permission-matrix-smoke.ts`，16 个 HTTP 检查通过。
- [x] 运行 `npx tsc --noEmit --pretty false`，通过。
- [x] 运行 `npm run build`，通过；仅有既有 `<img>` 和 React hooks lint warning。

结论：本批次没有发现越权，不需要修改权限业务逻辑。当前闭环是“权限验证闭环”，不是全反馈功能闭环。

## Batch 2：返回来源页和状态颜色语义

- [x] 新增 `src/lib/navigation/return-to.ts`，集中生成任务详情来源链接。
- [x] 任务详情页读取并净化 `return_to`，非法外链 fallback 到 `/tasks`。
- [x] `/tasks`、`/generate`、`/admin/outputs`、`/projects/:id`、`/admin`、`/admin/costs` 的任务详情入口已补 `return_to`。
- [x] 任务详情返回文案会按来源显示：返回任务、返回生成页、返回项目、返回产出留存、返回成本后台、返回后台。
- [x] `GenerationComposer` 增加 `hasAttemptedSubmit`，首次空 prompt 是蓝色 hint，点击提交后仍为空才是红色 error。
- [x] `ComposerStatusLine` 支持 `hint | progress | ok | error` 四种状态语义。
- [x] `提交中...` 使用 progress 语义，不再走 error 样式。
- [x] `status-running` 和生成页最近任务 running badge 改为绿色进行态；失败/危险仍保留红色。
- [x] 运行 `npx tsx -e "import { sanitizeReturnTo, taskReturnLabel, taskDetailHref } from './src/lib/navigation/return-to.ts'; ..."`，通过。
- [x] 运行 `npx tsc --noEmit --pretty false`，通过。
- [x] 运行 `npm run build`，通过；仅有既有 `<img>` 和 React hooks lint warning。
- [x] 运行 `BASE_URL=http://localhost:3000 npx tsx scripts/project-ui-smoke.ts`，通过。

说明：ClickOps CLI 健康检查、能力列表和可调用工具列表通过；本次启动 debug session 后，后续 CLI 调用未能保留该 session，未获得浏览器 snapshot，因此用构建和本地 UI smoke 作为本批次验证证据。

## Batch 3：连续生成和用户最后一次生成设置

- [x] 创建成功后，生成表单不再被长期结果卡阻塞。
- [x] 创建成功后，新任务立即进入最近任务顶部。
- [x] 支持多个已提交任务继续后台轮询，不因为继续创建下一段而停止旧任务刷新。
- [x] 成功提示改为轻量队列提示，支持查看详情和自动收起。
- [x] 新增 `UserPreference` 模型和迁移，保存用户生成偏好。
- [x] 新增 `/api/me/preferences/generation` GET/PATCH。
- [x] 新增生成偏好归一化 helper，避免保存签名 URL、素材 URL、本地路径或一次性上传地址。
- [x] 生成页登录后读取偏好，提交成功后异步保存偏好。
- [x] 本地 localStorage 作为偏好接口不可用时的 fallback。
- [x] 本地数据库未应用迁移时，偏好接口返回 `user_preference_table_missing`，不影响生成页使用。
- [x] 运行 `npm run db:generate`，通过。
- [x] 运行生成偏好归一化 smoke，通过。
- [x] 运行 `npx tsc --noEmit --pretty false`，通过。
- [x] 运行 `npm run build`，通过；仅有既有 `<img>` lint warning。
- [x] 运行 `BASE_URL=http://localhost:3002 npx tsx scripts/project-ui-smoke.ts`，通过。

注意：跨设备服务端偏好持久化依赖 `20260610083000_add_user_preferences` 迁移上线；本地未执行数据库写入迁移前会自动降级到 localStorage。

## Batch 4：图集封面、重命名、删除/归档入口

- [x] 列表 API 返回 `cover_image_url`，优先封面图，否则第一张 active 图片。
- [x] 封面 URL 走 `/api/reference-images/:imageId/content?variant=thumbnail`，继续复用参考图权限。
- [x] 图集卡片显示封面图，失败或空图集 fallback 到数量/空状态。
- [x] 图集卡片动作区增加“重命名 / 删除”，仅 `permissions.edit` 可见。
- [x] 图集详情页增加“重命名图集 / 删除图集”。
- [x] 删除确认文案说明：从列表隐藏，历史任务引用参考图仍保留。
- [x] DELETE 后端从 `deleted` 改为 `archived`，不再批量删除 `ReferenceImage`。
- [x] 列表 API 只返回 `status='active'`，归档图集不再出现在 `/collections`。
- [x] 运行 `npx tsc --noEmit --pretty false`，通过。
- [x] 运行 `npm run build`，通过；仅有既有 `<img>` lint warning。
- [x] 运行图集只读 smoke，通过：列表和详情都返回 `cover_image_url`，页面路由返回 200。
- [x] 运行 `BASE_URL=http://localhost:3002 npx tsx scripts/project-ui-smoke.ts`，通过。

注意：本批次没有执行真实 PATCH/DELETE，避免修改当前本地真实图集数据；写路径已通过类型检查和构建覆盖。

## Batch 5：产出留存和任务详情显示生成者头像、项目、来源

- [x] 新增 `src/lib/users/display.ts`，统一过滤技术用户名和合成飞书邮箱。
- [x] 新增 `src/components/UserIdentityBadge.tsx`，支持头像、姓名、fallback 首字母。
- [x] 后台产出 API owner/submitted/操作人摘要返回 `avatar_url` 和 `account_type`。
- [x] 产出留存列表用头像 badge 展示生成者。
- [x] 任务状态 API 返回 `owner` 和 `submitted_user`。
- [x] 任务详情页视频上方展示生成者、项目、来源和来源请求短 ID。
- [x] Codex API 来源显示 `source_label || Codex API`。
- [x] 运行用户显示格式化 smoke，通过。
- [x] 运行 `npx tsc --noEmit --pretty false`，通过。
- [x] 运行 `npm run build`，通过；仅有既有 `<img>` lint warning。
- [x] 运行 Batch 5 只读 smoke，通过。
- [x] 运行 `BASE_URL=http://localhost:3002 npx tsx scripts/project-ui-smoke.ts`，通过。

注意：本批次没有执行隐藏/恢复/生成等写动作；`impeccable` 未找到项目级 PRODUCT/DESIGN，本次按 product register 和现有后台视觉体系执行。

## Batch 6：账号展示名格式化，隐藏过长技术后缀

- [x] 顶部账号菜单使用统一 `displayUserName`。
- [x] 个人页主名称使用统一显示；合成飞书邮箱显示为“未绑定真实邮箱”。
- [x] 项目 owner、图集 owner、生成页项目选择、画布项目选择等用户可见标签使用统一显示。
- [x] 后台首页、成本页、项目详情、反馈页、集成页、生成驾驶舱和导出中的 owner/member 主显示使用统一格式化。
- [x] 后台用户页列表、批量操作预览、合并账号下拉和确认文案使用统一格式化。
- [x] 保留后台搜索、表单、审计日志里的原始 username/email，不改真实账号数据。
- [x] 运行用户显示格式化 smoke，通过。
- [x] 运行 `npx tsc --noEmit --pretty false`，通过。
- [x] 运行 `npm run build`，通过；仅有既有 `<img>` lint warning。
- [x] 运行 Batch 6 只读页面 smoke，通过。
- [x] 运行 `BASE_URL=http://localhost:3002 npx tsx scripts/project-ui-smoke.ts`，通过。
- [x] 运行 `npx impeccable detect src/components/AccountMenu.tsx`，通过。
- [x] 运行 `npx impeccable detect src/app/admin/users/AdminUsersClient.tsx`，通过。

注意：本批次没有修改 Feishu 绑定字段、登录逻辑、合并逻辑或数据库数据。

## 后续批次

- [x] 用户本质反馈对齐审计；已把反馈归纳为连续创作、状态理解、素材引用、权限归属、账务透明和导航上下文六类本质需求，见 `tasks/feedback-optimization-plan.md` 第 18 节。
- [x] 闭环检查更新；已区分需求理解闭环、规划闭环、本地实现闭环和生产回归闭环；最新闭环状态以本节后续批次和 `tasks/feedback-optimization-plan.md` 第 20 节为准。
- [x] Batch 7：项目代付独立 Spec 阶段 1；已完成现状分析和代码依据，见 `tasks/project-billing-scope-spec.md`。
- [x] Batch 7：管理页二级流水入口先行落地；`/admin/points` 已承载完整点数与额度流水，`/admin/users` 底部全局流水改为二级页入口，后台总览和成本页已补入口。
- [ ] Batch 7：项目代付独立 Spec 阶段 2；确认额度来源、代付开关、配置权限、扣费优先级、外部 API `project_id` 行为、历史任务口径和管理页二级流水页信息架构，推荐将完整点数与额度流水承载在现有 `/admin/points`。
- [ ] Batch 7：项目代付独立 Spec 阶段 3；确认风险决策、数据模型、迁移策略、服务拆分、验证脚本和回滚条件。
- [ ] Batch 7：项目代付实现；完整 Spec 三段确认后再修改 Prisma、账本、创建接口、finalizer、后台 UI 和外部 API 文档。
- [x] Batch 8：任务详情相对时间；已在实际扣费附近显示“生成于/更新于 刚刚、N 分钟前、N 小时前、N 天前”，并保留绝对时间用于审计。
- [x] Batch 9：提示词输入框放大/全屏编辑；已支持大面板编辑、完成写回、取消确认和 Esc 退出。
- [x] Batch 10A：`@图片` 当前素材插入；已按即梦官方 `@图片N` 主格式从当前 workspace 素材生成插入按钮，`PromptChecker` 兼容 `@图片N/@图片 N/@图N/图N`，继续复用现有 `reference_image_ids`。
- [x] Batch 10B：`@图片` 图集选择；已实现从参考图集选择图片后，先加入 workspace，再插入对应 `@图片N`；生产/Payload 抓包仍按下方验收项保留。

### Batch 10 官方 `@图片N` 规则闭环 Todo

- [x] 规则研究：已确认即梦官方主格式是 `@图片N` / `@图片 N`，不是裸 `@图N`；旧格式只能作为历史 prompt 兼容。
- [x] UI 插入一致：`PromptEditor` 当前素材按钮输出 `@图片1`、`@图片2`，不再输出 `@图1`。
- [x] 校验一致：`PromptChecker` 识别 `@图片N`、`@图片 N`，并兼容 `@图N`、`图N`。
- [x] 用户可见文案一致：`PromptEditor`、`PromptChecker`、`ModeSelector`、`ReferenceAlbumPicker` 均使用官方 `@图片N` 口径。
- [x] 提交口径一致：`@图片N` 仍只是 prompt 自然语言引用，真实参考图继续由 `reference_image_ids` 按 workspace 顺序提交，不新增后端字段。
- [ ] 生产回归：用真实登录态打开 `/generate`，上传或选择 2 张参考图，插入 `@图片1/@图片2`，确认页面校验不报缺图。
- [ ] Payload 验收：抓一次创建请求，确认 prompt 包含 `@图片1/@图片2`，同时 `reference_image_ids` 顺序与当前 workspace 第 1、2 张参考图一致。
- [ ] 非付费优先：Payload 验收优先用拦截、dry-run 或测试环境完成；如必须真实提交生成，先取得明确授权。
- [ ] 删除/重排验收：删除或重排第 1 张参考图后，确认 `PromptChecker` 能提示引用越界或顺序变化风险，不能让 `@图片1` 静默指向错误素材。
- [x] 外部 API 说明补充：如果外部 prompt 使用 `@图片N`，文档已说明调用方要按同一顺序传 `reference_image_ids` / `reference_image_urls`，否则 `@图片N` 只是无效文本。
- [x] Batch 10B 实现：从图集选择图片时，先加入 workspace，再按加入后的真实顺序插入 `@图片N`；失败时不得插入 prompt。
- [x] Batch 10B 去重：如果图集图片已在 workspace 中，直接插入已有序号，不重复加入 `reference_image_ids`；前端也允许在 9 张已满时选择已存在图片用于插入。
- [ ] Batch 10B 验收：从图集选择图片后，确认 workspace 缩略图、prompt `@图片N`、提交 payload 三者顺序一致。

## 2026-06-13 未闭环反馈补充 Todo

来源：反馈表复查 + 代码现状复核。已确认完成的反馈不再重复列入；以下只保留未完成或部分完成项。执行前仍需重新读取对应文件，避免覆盖本段之后的新改动。

### F1：生成页最近任务时间与提示词展示

反馈 ID：`cmqc3c1fi00285k2igmj4q9oj`、`cmqc3aha100265k2iiikbhhwg`

当前判断：最近任务卡片里时间和提示词已接近同一信息区，但样式仍可能换行/两行截断；相对时间只覆盖 1 天内，超过 1 天仍回落为日期，未完全符合“几天前 / 几周前 / 几个月前”的反馈。

- [x] 修改 `src/app/generate/page.tsx` 最近任务渲染：时间和提示词摘要放在同一行信息结构中，提示词不另起一整块抢占首屏。
- [x] 修改 `src/app/globals.css` 对应最近任务样式：桌面端一行可扫描，移动端允许合理换行但不能让时间和提示词断成两个独立区块。
- [x] 抽出或补齐相对时间 helper，覆盖 `刚刚`、`N 分钟前`、`N 小时前`、`N 天前`、`N 周前`、`N 个月前`。
- [x] 保留绝对时间可追溯性，建议通过 `title` 或详情页保留，不把审计信息完全丢掉。

验收：

- [x] `/generate` 最近任务在桌面端能一眼看到“相对时间 + 提示词摘要”同一行。
- [x] 创建时间分别为 2 天、10 天、45 天前的任务显示为相对时间，不直接显示日期。
- [x] 移动端无横向溢出，提示词不会遮挡状态、缩略图或操作入口。

### F2：空提示词状态颜色语义

反馈 ID：`cmq6tkq6b00mte4yelpccoh7y`

当前判断：默认“请描述你想生成的视频画面”已是蓝色 hint；点击提交后空 prompt 会切成红色 error。反馈期望偏向“输入提示”而不是“错误警告”，因此仍按部分完成处理。

- [x] 复核 `src/components/GenerationComposer.tsx` 的 `hasAttemptedSubmit` 与空 prompt 校验链路，区分“引导输入”和“提交失败”。
- [x] 复核 `src/components/ComposerStatusLine.tsx` 与 `src/app/globals.css` 的 `hint | progress | ok | error` 样式，空 prompt 优先保持 hint/中性提示。
- [x] 只有服务端拒绝、素材映射错误、余额不足、Provider 创建失败等真实阻断问题才使用 error 红色。

验收：

- [x] 初次进入 `/generate` 时空提示词为蓝色或中性引导。
- [x] 用户点提交但仍未输入 prompt 时，不出现强错误态红色，除非还有其他真实错误。
- [x] 真实提交失败仍有明确红色错误反馈。

### F3：生成页图集入口语义收口

反馈 ID：`cmq6t7ah500fse4yewbmly2bj`

当前判断：图集列表和图集详情已支持重命名/删除；但生成页素材工具栏仍存在“新建图集”语义，未确认是否已调整为“保存当前素材为图集 / 管理已有图集”的清晰入口。

- [x] 复核 `src/components/ImageSetToolbar.tsx` 及生成页引用入口，确认“新建图集”是否和“保存当前素材为图集”语义重复。
- [x] 将生成页主入口调整为面向当前任务的动作，例如“保存当前素材为图集”；已有图集的重命名/删除继续放在图集列表或详情页。
- [x] 如果生成页需要管理已有图集，只提供明确跳转或轻量管理入口，不在生成工具栏里重复完整图集后台。

验收：

- [x] 用户在 `/generate` 能明确区分“把当前素材保存成图集”和“管理已有图集”。
- [x] 图集重命名、删除入口仍可达。
- [x] 不删除原有创建图集能力，只调整入口语义和层级。

### F4：生成者头像展示一致性

反馈 ID：`cmq6pkpu8007fe4yeu5xytq1r`

当前判断：任务详情顶部已经使用 `UserIdentityBadge` 展示生成者；产出留存部分链路已有头像，但视频卡生成记录、项目内记录或其他留存列表仍可能只显示纯文本姓名。

- [x] 复核 `src/app/projects/[id]/video-cards/[cardId]/page.tsx` 的生成记录列表，生成者展示统一改为 `UserIdentityBadge`。
- [x] 复核 `src/app/projects/[id]/page.tsx` 的项目内任务/历史记录，涉及生成者时统一使用头像 + 显示名。
- [x] 如 API 缺少 `avatar_url` 或 `account_type`，只补当前列表需要的最小字段，不扩大敏感数据返回。

验收：

- [x] 任务详情、产出留存、视频卡生成记录、项目内任务记录的生成者展示口径一致。
- [x] 无头像用户有稳定 fallback 首字母或默认头像，不造成布局跳动。
- [x] 技术邮箱和合成飞书账号仍按 `src/lib/users/display.ts` 过滤显示。

本轮记录：

- 2026-06-13：F1-F4 已实现并通过 `git diff --check`、`npx tsc --noEmit --pretty false`、`npm run lint`、`npm run build`；对应 5 条反馈已归档。
- 2026-06-13：F5 通知中心和 F6 项目代付仍未落地。通知中心缺少通知模型；项目代付缺少完整预算冻结/实扣/返还模型，且当前任务创建和 finalizer 仍按个人积分结算。根据本文件停止条件，未完成 Spec 前不改账本、Prisma schema 或扣费逻辑。

### F5：通知中心、版本更新与点数通知

反馈 ID：`cmqau8wyb0014js78wotf6ckz`

当前判断：项目 V1.2 任务包 I 已规划通知与提醒，但反馈里提到的站内通知中心、版本更新通知和点数相关通知还没有独立落地入口。

- [ ] 先写轻量 Spec，明确通知范围：站内通知、版本更新、点数变动、预算不足、审批结果是否同一模型承载。
- [ ] 设计通知数据模型或事件表，字段至少包含通知类型、目标用户、关联资源、状态、已读时间、创建时间。
- [ ] 新增用户侧通知入口：未读数量、通知列表、标记已读。
- [ ] 管理员侧支持发布版本更新通知，点数变动由点数/额度流水触发站内通知。
- [ ] 通知内容不得包含 token、cookie、Provider 签名 URL 或其他敏感内容。

验收：

- [ ] 用户能看到自己的未读通知数量和通知列表。
- [ ] 点数发放、扣除或额度不足时能产生可追踪通知。
- [ ] 管理员能发布版本更新类通知。
- [ ] 通知失败或重复触发有幂等保护。

### F6：项目代付 / 项目额度

反馈 ID：`cmq6pcntk004ne4ye571sm9b5`

当前判断：当前创建任务仍按个人扣费口径；现有 todo 中的 Batch 7 和任务包 B 已把项目代付列为独立 Spec/预算闭环，但尚未实现。该项触及账本、Prisma、扣费、退款和外部 API，禁止作为普通 UI 修复直接改。

- [ ] 完成 Batch 7 项目代付 Spec 阶段 2：确认额度来源、代付开关、配置权限、扣费优先级、外部 API `project_id` 行为、历史任务口径和管理页流水信息架构。
- [ ] 完成 Batch 7 项目代付 Spec 阶段 3：确认风险决策、数据模型、迁移策略、服务拆分、验证脚本和回滚条件。
- [ ] 和任务包 B 合并实现：公共项目扣项目预算，个人项目扣个人积分，系统项目按既有规则单独处理。
- [ ] 创建任务、任务终态结算、失败退款、重复提交幂等、后台流水和成本页全部按同一 billing scope 口径改造。

验收：

- [ ] 公共项目生成不再扣个人积分，而是预占/实扣项目额度。
- [ ] 个人项目仍只扣个人积分。
- [ ] 技术失败、Provider 创建失败、取消任务能释放预占或返还。
- [ ] 所有项目代付账务都有可追溯流水和回滚策略。

## 停止条件

- 项目代付未完成 Spec 前，不修改账本、Prisma schema 或扣费逻辑。
- 图集删除如果从“归档集合”升级为“删除素材文件”，先确认历史任务引用保护策略。
- 外部 API 生成内容的自动下载、截图、归属链路需要和本地视频留存策略统一，不单独做一套。
- `@图片` 不能只插入文本，必须保证 prompt 引用和实际参考图参数一致；做不到映射时先停在轻量当前素材插入版。
- 即梦官方 `@图片N` 规则不得退回 `@图N` 作为主 UI 文案；`@图N` / `图N` 只能保留为历史 prompt 兼容。
- 没有验证 `reference_image_ids` 顺序前，不得把生产闭环标记为完成。

## 视频生成管理页规划需求：成本与产能驾驶舱

页面定位：将视频生成管理页收口为「视频生成成本与产能驾驶舱」，优先服务管理者判断生成规模、成本消耗、项目结构、成员效率和异常风险。

核心展示维度：

1. 视频生成量
2. 成本消耗
3. 项目占比
4. 清晰度消耗占比：480P / 720P / 1080P
5. 成员效率排行
6. 异常预警
7. 最近生成记录
8. 数据口径与交互规则

关键页面原则：

- 不要把「模型」和「清晰度」混在一起。
- 首页优先展示 480P / 720P / 1080P，因为这是管理者最容易理解、也最直接影响成本的维度。
- 模型维度可以作为二级筛选、详情下钻或辅助分析项，不作为首页主视角。
- 成本相关指标必须明确口径，区分实际扣费、估算成本、官方账单导入金额和平台点数消耗。
- 异常预警需要优先暴露会影响成本、额度、任务成功率或产能判断的问题。

待规划交互：

- [ ] 首页顶部展示生成量、总成本、平均单条成本、失败/异常任务数。
- [ ] 首页首屏展示生成趋势，至少包含生成次数、生成秒数和官方额度，并支持按日 / 按周 / 按月查看。
- [ ] 使用清晰度作为第一成本拆分维度，展示 480P / 720P / 1080P 占比和金额。
- [ ] 项目占比支持按生成量、官方成本和点数消耗切换排序，不展示失败维度。
- [ ] 成员效率排行支持按生成量、有效产出、平均成本和点数消耗查看，不展示失败维度。
- [ ] 最近生成记录保留任务、用户、项目、清晰度、实际扣费、状态和时间。
- [ ] 异常预警聚合额度不足、扣费异常、Provider 失败、下载失败、无归属项目等问题。
- [ ] 数据口径区域说明统计周期、币种、成本来源和延迟刷新规则。

### 项目现状对照

- 已有任务数据底座：`prisma/schema.prisma` 的 `VideoTask` 已保存 `resolution`、`duration`、`model`、`actual_cost`、`provider_official_amount_minor`、`provider_official_amount_micros`、`provider_cost_currency`、`project_id`、`user_id`、`owner_user_id`、`local_status`、`provider_cost_status`、`cost_allocation_status`，足够支撑生成量、清晰度、项目、成员、成本和异常统计。
- 已有成本总账底座：`prisma/schema.prisma` 的 `CostLedger` / `CostAllocation` 已保存任务、用户、项目、Provider、官方账单、金额、币种、置信度和分摊关系，适合作为官方成本和对账口径。
- 已有产出列表接口：`src/app/api/admin/outputs/route.ts` 的 `GET` 已返回任务、清晰度、模型、项目、用户、点数扣费、官方扣费、留存状态和分页；但 `summary` 目前只按 `retention_status` 和 `local_status` 汇总，没有按清晰度、项目、成员或成本聚合。
- 已有产出留存页面：`src/app/admin/outputs/AdminOutputsClient.tsx` 的 `AdminOutputsClient` 当前定位是“产出留存”，按预览核对、隐藏/恢复、归属追溯；它展示单条实际扣费，但不是管理驾驶舱。
- 已有后台总览：`src/app/admin/page.tsx` 的 `AdminPage` 已展示本月官方金额、待确认成本、账本自检、接口失败、新反馈、活跃账号、最近任务；但首页主视角仍是供应商余额和计费链路，没有视频生成量、清晰度消耗占比、项目占比和成员效率。
- 已有成本复盘页：`src/app/admin/costs/page.tsx` 的 `AdminCostsPage` 已覆盖官方成本、供应商余额、待确认成本、异常待办、账本自检、待处理队列、Provider 请求异常和最近总账；但缺少管理者第一眼需要的产能结构和清晰度结构。
- 已有导出口径：`src/app/api/admin/costs/export/route.ts` 的 `GET` 导出 CSV 时已包含 `task_resolution`、`task_model`、`task_duration`、`project_id`、`project_name`、`user_id`、金额和币种；说明当前数据已能导出，但还没有聚合 API 给页面直接消费。
- 已有价格规则：`src/lib/pricing.ts` 的 `calculateEstimatedCost` 和 `src/lib/pricing-client.ts` 的 `calculateEstimatedCostClient` 已按 `480p / 720p / 1080p` 计算点数，证明清晰度是稳定的一等参数，不应在驾驶舱首页被模型维度稀释。

### 需要闭环调整的地方

- [ ] 明确落地点：将 `/admin` 首屏升级为「视频生成成本与产能驾驶舱」，保留供应商余额和计费链路作为风险区；`/admin/outputs` 继续做产出明细与留存操作，`/admin/costs` 继续做成本复盘与对账。
- [ ] 新增聚合口径：在后台服务端聚合或新增 `/api/admin/generation-dashboard`，返回时间范围内的生成量、成功数、失败数、总点数、官方成本、平均单条成本、清晰度占比、项目占比、成员排行、异常列表和最近生成记录。
- [ ] 清晰度优先：驾驶舱第一层图表和指标按 `resolution` 聚合，只展示 `480p / 720p / 1080p / 未记录`；`model` 只放到二级筛选或明细列，不和清晰度并列成首页主维度。
- [ ] 成本口径分层：页面必须同时但分层显示 `actual_cost`（平台点数扣除）、`provider_official_amount_micros/minor`（官方美金成本）、`estimated_cost`（预估点数）、`frozen_cost/refund_amount`（冻结/退款），默认主成本用官方成本；官方缺失时显示“待官方确认”，不能用点数冒充美金成本。
- [ ] 项目占比闭环：项目占比按 `VideoTask.project_id` 聚合，缺失项目归入“未归属项目”，并把未归属项目计入异常预警，入口跳到 `/admin/costs` 待处理队列或 `/admin/outputs?project_id=...`。
- [ ] 成员效率闭环：成员排行按 `owner_user_id` 优先、回退 `user_id` 聚合，展示生成量、成功量、点数消耗、官方成本和平均成本；点击成员跳到 `/admin/outputs?owner_user_id=...`。
- [ ] 异常预警闭环：复用 `src/lib/costs/audit.ts` 的账本自检，并补充驾驶舱级异常：失败可能收费、待官方确认、未归属项目、成本未分摊、Provider 请求失败、长时间 pending、重复 `provider_task_id`、任务已完成但缺少本地视频/缩略图。
- [ ] 最近生成记录闭环：最近记录保留任务 ID、提示词摘要、用户、项目、清晰度、时长、状态、点数扣除、官方成本、成本状态；详情跳转使用 `taskDetailHref(task.id, '/admin')`，不要复制一套详情页。
- [ ] 数据口径说明：在驾驶舱底部或帮助抽屉写明统计周期、刷新方式、币种换算、官方成本优先级、点数和美金区别、清晰度归一化规则、未记录数据如何处理。
- [ ] 导出闭环：复用 `/api/admin/costs/export` 的字段，新增与当前筛选一致的驾驶舱导出入口，避免页面看的是聚合口径、导出却是全量总账口径。

### 推荐实施顺序

- [x] P0：新增驾驶舱聚合查询，先支持默认“本月”数据和 `7d / 30d / 本月 / 自定义` 时间筛选。
- [x] P0：改造 `/admin` 首屏模块顺序：顶部 KPI -> 清晰度成本占比 -> 项目占比 + 成员排行 -> 异常预警 -> 最近生成记录 -> 数据口径。
- [x] P0：把 `model` 降为筛选项或明细列，首页不做模型大卡片。
- [x] P1：为项目、成员、异常和最近记录补跳转参数，保证从聚合指标能回到明细列表。
- [x] P1：补充空状态、加载态、成本缺失态和官方金额待确认态，避免管理者误读。
- [ ] P2：增加导出当前驾驶舱数据、保存常用时间范围、按项目/成员展开二级明细。

### 验收标准

- [ ] 首页第一屏能回答：本周期生成了多少视频、花了多少官方成本、主要成本花在哪个清晰度、哪个项目/成员消耗最高、有哪些异常需要处理。
- [ ] 清晰度图表只按 `480p / 720p / 1080p / 未记录` 展示，不把模型作为同级主维度。
- [ ] 任一聚合数字都能追溯到明细任务或成本记录。
- [ ] 官方成本缺失时明确显示“待官方确认”，不把平台点数展示成美元。
- [ ] 异常预警每一类都有可点击处理入口或明确说明为什么无法处理。
- [ ] `/admin/outputs` 和 `/admin/costs` 的原有功能入口保留，不因驾驶舱改造被删除。

### 具体细节任务规划

> 执行前约束：这是中等以上 UI + 数据口径改造。先确认本规划，再进入代码实现；实现中发现数据口径偏差，先回写本规划，再改代码。

#### 任务目标对齐

**总目标**：把 `/admin` 从普通后台总览升级为「视频生成成本与产能驾驶舱」，让管理者在第一屏判断本周期视频产能、官方成本、清晰度消耗结构、项目/成员消耗和异常待办，并且每个数字都能追溯到明细。

| 目标 ID | 目标 | 对应任务 | 成功信号 | 不做什么 |
| --- | --- | --- | --- | --- |
| G1 | 第一屏回答经营问题：生成了多少、花了多少、哪里花得最多、哪里异常 | P0-1、P0-2、P0-3、P0-4 | `/admin` 首屏有 KPI、清晰度主舞台、项目/成员、异常预警、最近记录 | 不做一堆等权重小卡片，不让供应商余额继续压过生成驾驶舱 |
| G2 | 清晰度成为首页主成本维度 | P0-1、P0-3、P0-4、P1-1 | 首页图表只按 `480p / 720p / 1080p / 未记录` 展示，点击能进明细 | 不把 `model` 和 `resolution` 混成同级主维度 |
| G3 | 成本口径不混淆 | P0-1、P0-2、P0-3、P1-4、P1-3 | 官方美元成本、平台点数、预估点数、冻结/退款分层显示；官方缺失显示“待官方确认” | 不把 `actual_cost` 点数显示成 USD，不用预估点数冒充真实扣费 |
| G4 | 聚合数字可追溯 | P1-1、P1-2、P1-3 | 清晰度、项目、成员、异常、最近记录都有明细跳转或导出 | 不新增孤立 dashboard 数据，不复制一套任务详情页 |
| G5 | 异常预警可处理 | P0-1、P1-2、P1-4 | 每个异常都有数量、原因、处理入口和口径说明 | 不只展示红色数字，不把异常做成不可点击提示 |
| G6 | 保留原后台功能 | P0-0、P0-3、P1-1 | `/admin/outputs` 隐藏/恢复、`/admin/costs` 对账、`/admin/users` 用户点数入口仍可达 | 不为了驾驶舱改造删除原有功能入口 |
| G7 | 可验证、可上线 | P0-0、详细验证计划 | 类型检查、lint、build、smoke、上线健康检查都有明确命令 | 不在 build 失败或口径未确认时重启生产服务 |

**目标依赖顺序**

- [ ] 先闭环 G3 成本口径：如果金额口径不清，后续图表都可能误导。
- [ ] 再闭环 G2 清晰度维度：确认历史数据归一化后，再做首页主舞台。
- [ ] 再闭环 G1 首屏信息结构：用聚合数据喂给 `/admin`。
- [ ] 再闭环 G4/G5 追溯和异常处理：所有数字必须可回到 `/admin/outputs` 或 `/admin/costs`。
- [ ] 最后闭环 G6/G7：确认原功能保留、验证命令通过、上线链路健康。

**执行判定**

- [ ] P0 完成的定义：G1、G2、G3 的默认本月视图可用，且不影响原后台入口。
- [ ] P1 完成的定义：G4、G5 可追溯和可处理，导出与页面筛选口径一致。
- [ ] P2 完成的定义：不改变核心口径，只改善使用效率和空/加载/记忆状态。
- [ ] 如果某个任务不能服务上表任何目标，默认不做或降级到 P2。

#### P0-0：执行前基线和保护

- [ ] 运行 `git status --short`，确认当前已有改动归属，不把无关文件混入本次实现。
- [ ] 不改 `prisma/schema.prisma`，除非实现时证明现有字段无法表达驾驶舱口径；当前判断是不需要新增表。
- [ ] 不删除 `/admin/outputs`、`/admin/costs`、`/admin/users`、`/admin/projects` 的现有入口。
- [ ] 不改变真实扣费、点数冻结、退款、Provider 请求和官方账单写入逻辑；本期只做读侧聚合和展示。
- [ ] 实现前先跑一次 `npx tsc --noEmit --pretty false`，记录当前基线是否通过。

#### P0-1：新增驾驶舱聚合服务层

**目标**：把统计口径集中到一个服务文件，页面和 API 不各算一套。

**文件**

- [ ] Create: `src/lib/admin/generation-dashboard.ts`

**实现要点**

- [ ] 定义 `DashboardRangeKey = '7d' | '30d' | 'month' | 'custom'`。
- [ ] 定义 `GenerationDashboardQuery`：`range`、`dateFrom`、`dateTo`、`projectId`、`ownerUserId`、`resolution`。
- [ ] 定义 `GenerationDashboardData`，至少包含：
  - `range`
  - `kpis`
  - `resolution_breakdown`
  - `project_breakdown`
  - `member_ranking`
  - `warnings`
  - `recent_tasks`
  - `data_notes`
- [ ] 实现 `parseDashboardRange(searchParams, now)`：默认本月；自定义范围最大先限制为 180 天，避免一次性扫全库。
- [ ] 实现 `normalizeDashboardResolution(value)`：只允许 `480p / 720p / 1080p`，其他归为 `unknown`。
- [ ] 实现 `officialCostMicros(task)`：优先 `provider_official_amount_micros`，否则 `provider_official_amount_minor * 10000`，没有官方成本返回 `null`。
- [ ] 实现 `taskActorId(task)`：优先 `owner_user_id`，回退 `user_id`。
- [ ] 实现 `getGenerationDashboardData(query)`：
  - 从 `VideoTask.created_at` 做时间过滤。
  - 只 select 驾驶舱需要字段，避免读取 raw response 和大 JSON。
  - 聚合生成量、成功量、失败量、总点数、官方成本、平均单条官方成本。
  - 按清晰度聚合数量、成功量、失败量、点数、官方成本。
  - 按项目聚合数量、成功量、点数、官方成本；`project_id = null` 归为“未归属项目”。
  - 按成员聚合数量、成功量、点数、官方成本、平均成本。
  - 生成最近 10 条任务记录。
  - 生成异常预警：待官方确认、失败可能收费、未归属项目、成本未分摊、Provider 请求失败、长时间 pending、重复 `provider_task_id`、终态任务缺成本账本。
- [ ] 复用 `src/lib/costs/audit.ts` 的 `getCostLedgerAuditSummary()`，不要复制账本自检逻辑。

**验证**

- [ ] 新增或临时运行 helper smoke：`npx tsx -e "import { getGenerationDashboardData } from './src/lib/admin/generation-dashboard.ts'; ..."`。
- [ ] 期望：能返回 `resolution_breakdown` 且键只包含 `480p / 720p / 1080p / unknown`。

#### P0-2：新增驾驶舱 API

**目标**：给页面交互和后续导出提供稳定 JSON 边界。

**文件**

- [ ] Create: `src/app/api/admin/generation-dashboard/route.ts`

**实现要点**

- [ ] `GET` 使用 `getAdminUser(request)` 校验管理员。
- [ ] 从 query 读取：`range`、`date_from`、`date_to`、`project_id`、`owner_user_id`、`resolution`。
- [ ] 调用 `getGenerationDashboardData`。
- [ ] 返回 `{ dashboard, generated_at }`。
- [ ] 错误时沿用后台 API 风格：401/403 透出鉴权错误，其他返回 500 + `加载驾驶舱失败`。

**验证**

- [ ] `npx tsc --noEmit --pretty false`
- [ ] 本地登录态可用时访问 `/api/admin/generation-dashboard?range=month`，确认 JSON 包含 `kpis`、`resolution_breakdown`、`warnings`。

#### P0-3：改造 `/admin` 首屏为驾驶舱

**目标**：让后台首页第一屏回答“生成量、官方成本、清晰度消耗、项目/成员消耗、异常待办”。

**文件**

- [ ] Modify: `src/app/admin/page.tsx`
- [ ] Create: `src/app/admin/AdminGenerationDashboardClient.tsx`

**页面结构**

- [ ] 顶部 `PageBanner` 标题改为“视频生成成本与产能驾驶舱”。
- [ ] 第一行 KPI：
  - 本周期视频生成量
  - 官方成本
  - 平均单条官方成本
  - 异常待办
- [ ] 第二块主舞台：清晰度成本占比，只展示 `480p / 720p / 1080p / 未记录`。
- [ ] 第三块：项目占比和成员效率排行并列展示。
- [ ] 第四块：异常预警，按可处理优先级排序。
- [ ] 第五块：最近生成记录。
- [ ] 底部：数据口径与交互规则。

**交互规则**

- [ ] 时间范围用分段控件：`本月 / 7天 / 30天 / 自定义`。
- [ ] 切换范围后通过 API 刷新，不整页跳转。
- [ ] 项目、成员、异常、最近任务都必须能跳到明细。
- [ ] 供应商余额和账本自检保留，但移动到风险辅助区，不抢第一视角。
- [ ] 原后台总览的“计费与成本、用户与点数、项目管理、产出留存、接口配置、反馈管理”入口保留在快捷入口区。

**禁止**

- [ ] 不做模型大卡片。
- [ ] 不把 `actual_cost` 点数显示成美元。
- [ ] 不让状态 chip 抢过清晰度和成本主视角。

#### P0-4：补驾驶舱样式

**文件**

- [ ] Modify: `src/app/globals.css`

**样式模块**

- [ ] `.admin-generation-dashboard`
- [ ] `.admin-dashboard-toolbar`
- [ ] `.admin-dashboard-kpi-grid`
- [ ] `.admin-dashboard-resolution-stage`
- [ ] `.admin-dashboard-breakdown-row`
- [ ] `.admin-dashboard-ranking`
- [ ] `.admin-dashboard-warning-list`
- [ ] `.admin-dashboard-recent-table`
- [ ] `.admin-dashboard-data-notes`

**设计约束**

- [ ] 产品后台风格：克制、信息密度高、少装饰。
- [ ] 第一屏不超过三个强焦点：KPI、清晰度主舞台、异常提示。
- [ ] 移动端顺序：KPI -> 清晰度 -> 异常 -> 项目 -> 成员 -> 最近记录 -> 口径。
- [ ] 不新增大面积渐变、装饰图形或营销式 hero。

#### P1-1：补 `/admin/outputs` 明细追溯参数

**目标**：所有驾驶舱聚合数字都能回到明细任务。

**文件**

- [ ] Modify: `src/app/api/admin/outputs/route.ts`
- [ ] Modify: `src/app/admin/outputs/AdminOutputsClient.tsx`

**实现要点**

- [ ] API `buildWhere` 增加 `resolution` 校验：`480p / 720p / 1080p / unknown`。
- [ ] API 支持 `date_from` / `date_to` 已有，继续复用。
- [ ] 页面高级筛选增加清晰度筛选。
- [ ] 从 URL 初始化 `resolution`、`date_from`、`date_to`、`owner_user_id`、`project_id`，让驾驶舱跳转后筛选状态可见。
- [ ] 输出卡片继续保留隐藏/恢复功能，不因追溯改造删除。

**跳转规则**

- [ ] 清晰度卡片：`/admin/outputs?resolution=480p&date_from=...&date_to=...`
- [ ] 项目卡片：`/admin/outputs?project_id=...&date_from=...&date_to=...`
- [ ] 成员卡片：`/admin/outputs?owner_user_id=...&date_from=...&date_to=...`
- [ ] 最近任务：`taskDetailHref(task.id, '/admin')`

#### P1-2：异常预警处理入口

**目标**：异常不是只展示数字，每一类都能进入处理位置。

**文件**

- [ ] Modify: `src/lib/admin/generation-dashboard.ts`
- [ ] Modify: `src/app/admin/AdminGenerationDashboardClient.tsx`
- [ ] Optional Modify: `src/app/admin/costs/page.tsx`

**预警类型和入口**

- [ ] `pending_official_cost`：跳 `/admin/costs`，锚定或过滤待确认成本。
- [ ] `failed_possible_charge`：跳 `/admin/costs`，查看失败但可能收费任务。
- [ ] `unallocated_project`：跳 `/admin/outputs?project_id=unassigned` 或 `/admin/costs` 待处理队列。
- [ ] `provider_request_failed`：跳 `/admin/costs` Provider 请求异常区。
- [ ] `stale_pending_provider_request`：跳 `/admin/costs` 账本自检区。
- [ ] `duplicate_provider_task_id`：跳 `/admin/costs` 账本自检区。
- [ ] `missing_local_video`：跳 `/admin/outputs?status=succeeded&has_local_video=false`，如果本期不做该筛选，则先跳 `/admin/outputs?status=succeeded` 并在说明里标注。

#### P1-3：导出当前驾驶舱数据

**目标**：页面看到什么，导出就是什么口径。

**文件**

- [ ] Create: `src/app/api/admin/generation-dashboard/export/route.ts`
- [ ] Modify: `src/app/admin/AdminGenerationDashboardClient.tsx`

**实现要点**

- [ ] 复用 `getGenerationDashboardData` 的时间和筛选口径。
- [ ] CSV 至少包含两段：
  - `summary`：KPI、清晰度、项目、成员、异常。
  - `recent_tasks`：任务 ID、时间、用户、项目、清晰度、时长、状态、点数、官方成本、成本状态。
- [ ] 导出文件名：`generation-dashboard-YYYY-MM-DD.csv`。
- [ ] 页面导出按钮拼接当前筛选 query。

#### P1-4：补数据口径说明

**文件**

- [ ] Modify: `src/app/admin/AdminGenerationDashboardClient.tsx`

**必须写清楚**

- [ ] 统计周期以 `VideoTask.created_at` 为准。
- [ ] 官方成本优先读 `provider_official_amount_micros`，回退 `provider_official_amount_minor`。
- [ ] `actual_cost` 是平台点数，不是美元。
- [ ] `estimated_cost` 是预估点数，不能代表真实扣费。
- [ ] 清晰度只归一为 `480p / 720p / 1080p / 未记录`。
- [ ] 任务无项目时归入“未归属项目”。
- [ ] Provider 官方金额未返回时展示“待官方确认”。

#### P2：体验补强

- [ ] 支持保存上次选择的时间范围到 localStorage，仅影响本机显示，不写用户偏好表。
- [ ] 支持项目/成员榜单展开查看更多。
- [ ] 支持按项目或成员筛选后保持全页联动。
- [ ] 增加骨架屏和空状态。
- [ ] 为金额字段统一两位小数展示，微单位金额不得被四舍五入到 0。

### 详细验证计划

- [ ] `git diff --check -- src/lib/admin/generation-dashboard.ts src/app/api/admin/generation-dashboard/route.ts src/app/admin/page.tsx src/app/admin/AdminGenerationDashboardClient.tsx src/app/admin/outputs/AdminOutputsClient.tsx src/app/api/admin/outputs/route.ts src/app/globals.css`
- [ ] `npx tsc --noEmit --pretty false`
- [ ] `npm run lint`
- [ ] `npm run build`
- [ ] `npx tsx scripts/generation-dashboard-smoke.ts`
- [ ] 本地浏览器检查 `/admin`：
  - 看得到“视频生成成本与产能驾驶舱”。
  - 第一屏主维度是清晰度，不是模型。
  - 点击 `480p / 720p / 1080p` 能进入对应 `/admin/outputs` 明细。
  - 官方成本缺失显示“待官方确认”。
  - 点数不会显示成美元。
- [ ] 上线后执行：
  - `/Users/gouki-youdoo/.youdoo/bin/youdoo-sites build sd2`
  - `/Users/gouki-youdoo/.youdoo/bin/youdoo-sites restart sd2`
  - `/Users/gouki-youdoo/.youdoo/bin/youdoo-sites status`
  - `curl -sS -D - https://sd2.youdoodesign.com/api/health | head -c 1000`

### 停止条件和回滚点

- [ ] 如果发现清晰度字段历史数据混有 `480P / 720P / 1080P` 大写或其他枚举，先补归一化规则，不直接丢弃数据。
- [ ] 如果官方成本字段缺失比例过高，页面仍可上线，但必须强化“待官方确认”状态，不能用点数顶替美元。
- [ ] 如果 `/admin/outputs` 当前筛选参数改造影响隐藏/恢复功能，立即停止并先修明细页回归。
- [ ] 如果 `npm run build` 失败，不执行 `youdoo-sites restart sd2`。
- [ ] 如果实现需要改 `prisma/schema.prisma`、扣费逻辑或 Provider 写入逻辑，先暂停并重新确认方案。

### 落地记录 - 2026-06-10

- [x] 新增 `src/lib/admin/generation-dashboard.ts`，集中处理时间范围、清晰度归一化、官方成本微单位、项目占比、成员排行、异常预警和最近生成记录。
- [x] 新增 `/api/admin/generation-dashboard`，管理员鉴权后返回驾驶舱 JSON。
- [x] 新增 `/api/admin/generation-dashboard/export`，按当前筛选导出驾驶舱聚合和最近任务 CSV。
- [x] 新增 `src/app/admin/AdminGenerationDashboardClient.tsx`，支持本月、7 天、30 天、自定义时间范围、刷新和导出。
- [x] 改造 `/admin` 为「视频生成成本与产能驾驶舱」，保留供应商余额、计费成本、产出留存、用户点数、项目管理等入口。
- [x] `/admin/outputs` 支持从 URL 初始化 `resolution`、`date_from`、`date_to`、`owner_user_id`、`project_id`，并在高级筛选中展示清晰度和日期筛选。
- [x] `/api/admin/outputs` 支持 `resolution=480p/720p/1080p/unknown` 和 `project_id=unassigned` 追溯查询。
- [x] `/admin/costs` 补 `audit-checks`、`pending-costs`、`provider-errors` 锚点，异常预警可以跳转到处理区域。
- [x] 新增 `scripts/generation-dashboard-smoke.ts`，验证本月范围、清晰度聚合键和点数/美元口径说明。
- [x] 根据参考图调整驾驶舱分析区：项目占比和清晰度占比改为圆环图，圆环使用 `aspect-ratio: 1 / 1` 保证正圆。
- [x] 页面成员排行、项目占比和驾驶舱 CSV 导出移除失败相关比率字段，后续规划也不再把失败维度作为展示或排序维度。
- [x] 按参考图补“每日生成量与成本”趋势模块：支持按日 / 按周 / 按月切换，展示生成次数、生成秒数和官方额度；驾驶舱导出同步增加 `trend_day / trend_week / trend_month`。
- [x] 本地验证：`git diff --check`、`npx tsc --noEmit --pretty false`、`npx tsx scripts/generation-dashboard-smoke.ts`、`npm run lint`、`npm run build`、`npx impeccable detect` 通过。
- [x] 上线验证：`youdoo-sites build sd2`、`youdoo-sites restart sd2`、`youdoo-sites status`、`/api/health` 通过；`.next-prod` 可检索到新标题、新清晰度模块和新 API。
- [ ] 浏览器视觉自动化验收未闭环：Codex in-app browser 能列出 `sd2.youdoodesign.com/admin/users` 标签，但导航 `/admin` 超时；本次以构建产物、生产健康和 smoke/API 鉴权作为验收证据。
- [ ] P2 未做：保存时间范围、项目/成员展开更多、全页联动筛选增强。

---

## 2026-06-10 金额展示双币种统一计划

### 问题定义

- 当前项目里金额展示口径不完全统一：
  - `formatAmountMinorWithCny`、`formatAmountMicrosWithCny` 已经能显示美元和人民币换算。
  - `formatAmountMinorWithFixedCny`、`formatAmountMicrosWithFixedCny` 已用于部分列表和后台页，能固定两位人民币。
  - `formatProviderUsdCharge` 仍只返回 `$xx USD`，会让任务详情、生成页等位置只看到美金。
  - 趋势图金额标签为了空间只显示 `$xx.xx`，但 title 和汇总应继续显示完整双币种。
- 管理和审计场景里，隐藏币种信息会增加误读风险；点击切换虽然省空间，但会让同一金额在不同用户/不同状态下看起来不一致。

### 推荐方案

- [x] 采用“默认同时显示美金 + 人民币换算”作为全项目统一规则。
- [x] 不把点击切换作为默认交互；只在极窄卡片或图表点位上允许短金额，完整金额必须放在 title、详情、表格或侧栏里。
- [x] 美元展示：`$0.35 USD`。
- [x] 人民币展示：`约 ¥2.55`。
- [x] 组合展示：`$0.35 USD（约 ¥2.55）`。
- [x] CNY 原币展示：`¥2.55 CNY` 或 `¥2.55`，不再额外重复换算。
- [x] 未确认金额继续显示：`待官方确认`。

### 影响范围

- [x] `src/lib/costs/currency.ts`
  - 收敛金额 helper。
  - `formatProviderUsdCharge` 改为返回双币种固定两位文案。
  - 增加必要的测试样例或轻量 smoke。
- [x] `src/app/tasks/[id]/page.tsx`
  - 任务详情“实际扣费”、侧栏成本、成本流水统一使用双币种。
- [x] `src/app/tasks/page.tsx`
  - 我的任务列表金额统一双币种，保留两位小数。
- [x] `src/app/generate/page.tsx`
  - 最近任务卡片金额不覆盖截图，不写进视频/图像，只在卡片文字区显示双币种。
- [x] `src/app/admin/outputs/AdminOutputsClient.tsx`
  - 产出留存列表金额统一双币种。
- [x] `src/app/admin/costs/page.tsx`
  - 成本管理页 KPI、任务表、流水表统一双币种。
- [x] `src/app/admin/AdminGenerationDashboardClient.tsx`
  - 驾驶舱 KPI、汇总、明细列表统一双币种；趋势图点位保持短标签，但 title 用完整双币种。
- [x] `src/app/projects/[id]/page.tsx`
  - 项目详情成本总览和成本表统一双币种。
- [x] `src/app/admin/page.tsx`
  - 供应商余额如果是 USD，也显示人民币换算。
- [x] `src/app/admin/costs/ProviderBalancePanel.tsx`
  - 供应商余额快照统一显示双币种固定两位。
- [x] `src/app/admin/costs/OfficialChargeImportForm.tsx`
  - 官方扣费导入预览统一显示双币种固定两位。
- [x] CSV 导出：
  - 保留原始币种/原始金额字段。
  - 增加人民币换算字段，避免导出后丢口径。

### 验收标准

- [x] 全项目用户可见的官方金额默认可同时看到原币种和人民币换算。
- [x] 不再出现只显示 `$xx USD` 但没有人民币换算的任务/产出/成本金额。
- [x] 金额不显示在视频画面或截图缩略图上，只显示在文本区域。
- [x] 小数点后保留两位，微单位金额不得显示成 `$0.00 USD（约 ¥0.00）` 误导用户；小于 0.01 的金额要按既有微金额规则或显示 `< $0.01`。
- [x] `actual_cost` 点数不伪装成美元；点数、官方扣费、人民币换算三者继续分层。

### 验证计划

- [x] `git diff --check -- src/lib/costs/currency.ts src/app/tasks/[id]/page.tsx src/app/tasks/page.tsx src/app/generate/page.tsx src/app/admin/outputs/AdminOutputsClient.tsx src/app/admin/costs/page.tsx src/app/admin/costs/ProviderBalancePanel.tsx src/app/admin/costs/OfficialChargeImportForm.tsx src/app/admin/AdminGenerationDashboardClient.tsx src/app/projects/[id]/page.tsx src/app/admin/page.tsx src/app/api/admin/generation-dashboard/export/route.ts src/app/api/projects/[id]/costs/export/route.ts scripts/currency-format-smoke.ts`
- [x] `npx tsc --noEmit --pretty false`
- [x] `npm run lint`
- [x] `npm run build`
- [x] 针对金额 helper 增加或执行 smoke，覆盖 USD、CNY、null、微单位金额。
- [x] 构建产物只读检查 `.next-prod/server`、`.next-prod/static`，确认双币种 helper、CSV 人民币列和金额换行 CSS 已进入生产包。
- [x] 上线后执行 `youdoo-sites build sd2`、`youdoo-sites restart sd2`、`youdoo-sites status`、公网 `/api/health`。

### 待确认

- [x] 方案 A：默认同时显示美金和人民币换算。已采用。
- [ ] 方案 B：金额可点击，在美金和人民币之间切换。不采用默认方案，审计页面会隐藏一半信息。

### 落地记录 - 2026-06-10

- [x] `formatProviderUsdCharge` 从只显示 `$xx USD` 改为 `$xx.xx USD（约 ¥xx.xx）`。
- [x] 微单位金额小于 0.01 时显示 `< $0.01 USD`，避免误读为 0。
- [x] 任务详情、生成页最近任务、任务列表、后台产出、后台成本、供应商余额、项目复盘、后台首页统一使用固定双币种 helper。
- [x] 导出补人民币估算列：驾驶舱导出增加 `official_costs_cny_estimate`，项目导出补 `official_cost_micros/final_cost_micros` 及对应人民币估算。
- [x] 最近任务和任务详情金额胶囊允许换行，不再把长金额挤出文本区或压到缩略图上。
- [x] 新增 `scripts/currency-format-smoke.ts` 覆盖 USD、CNY、空值和微金额边界。
- [x] 上线 `sd2` 后公网 `/api/health` 返回 200；`youdoo-sites status` 显示 `sd2` 为 OK。

---

## 2026-06-11 生成页最近任务无限下拉计划

### 需求本质

- 用户表面需求：生成页的“最近任务”不要固定 6 条，可以一直往下延伸。
- 本质目标：连续生成时，用户不离开 `/generate` 就能回看更早任务、复用历史任务、确认任务状态和成本，不被固定卡片数量打断。
- 不可变约束：
  - 生成页主目标仍是创建任务，最近任务不能抢占表单主流程。
  - 不一次性加载全部历史任务，避免慢查询、首屏慢、缩略图请求过多。
  - 不触发真实生成，不改变任务创建、扣费、轮询结算逻辑。
  - 不绕过现有权限，继续复用 `/api/video/list` 的用户可见任务过滤。

### 代码依据

- `src/app/generate/page.tsx` 的 `GeneratePage` 当前只有 `recentTasks` 数组状态，初始加载调用 `fetch('/api/video/list')` 后 `(d.tasks || []).slice(0, 6)`。
- `src/app/generate/page.tsx` 的轮询 `refreshRecentTasks` 也会重新取 `/api/video/list` 并 `slice(0, 6)`，导致更早任务永远不可见。
- `src/app/generate/page.tsx` 的 `handleSubmit` 成功后把新任务插入最近任务顶部，并继续 `.slice(0, 6)`。
- `src/app/generate/page.tsx` 的最近任务渲染区只在 `recentTasks.length > 0` 时显示，没有分页、加载中、加载失败、到底状态。
- `src/app/api/video/list/route.ts` 已支持 `page`、`limit`、`pagination.total`、`pagination.total_pages`，并通过 `getTaskWhereForUser` 做权限过滤。
- `src/app/tasks/page.tsx` 已经用 `/api/video/list?page=${page}&limit=20` 驱动分页任务列表，可作为分页字段口径参考。

### 推荐方案

- 采用“滚动到哨兵元素再加载下一页”的无限下拉。
- 首屏加载第 1 页，建议 `limit=12`。原因：6 条太短，20 条对生成页首屏缩略图请求偏重，12 条在桌面网格和移动端列表之间更均衡。
- 使用 `IntersectionObserver` 监听最近任务列表底部 sentinel，接近视口时加载下一页。
- 保留一个“加载更多”按钮作为兜底，IntersectionObserver 不可用或失败时仍可手动加载。
- 数据合并按 `task.id` 去重，新任务提交成功后只插入顶部，不重置已加载页。
- 轮询更新只更新已加载列表里的任务；任务进入终态时可以刷新第一页并与当前列表合并，但不能把已加载的第 2 页以后清空。
- 不把最近任务做成固定高度内部滚动区域，页面自然向下延伸。这样用户在生成页继续浏览历史时，浏览器滚动条就是时间线。

### 有没有更优雅的方式

- 更优雅方案不是“加一个无限滚动库”，而是把最近任务收敛成一个小型时间线状态机：`items`、`page`、`hasMore`、`loadingInitial`、`loadingMore`、`error`、`loadedIds`。
- 这样不用引入依赖，也不会把固定 6 条的旧逻辑散在初始加载、轮询和提交成功三个地方。

### 任务拆解

- [x] Batch 11A：抽出最近任务分页状态。
  - 修改 `src/app/generate/page.tsx`。
  - 新增常量 `RECENT_TASK_PAGE_SIZE = 12`。
  - 新增状态：
    - `recentTasks`
    - `recentTasksPage`
    - `recentTasksHasMore`
    - `recentTasksLoadingInitial`
    - `recentTasksLoadingMore`
    - `recentTasksError`
  - 新增 helper：
    - `mergeTasksById(current, incoming)`：按 `id` 去重，保留服务端排序，避免重复卡片。
    - `normalizeRecentTaskListResponse(data)`：读取 `tasks` 和 `pagination`，统一容错。

- [x] Batch 11B：改初始加载。
  - 把当前 `useEffect(() => fetch('/api/video/list')...)` 改为 `loadRecentTasksPage(1, { replace: true })`。
  - 请求 `/api/video/list?page=1&limit=12`。
  - 成功后设置第一页任务、页码、`hasMore = page < total_pages`。
  - 失败后显示可恢复错误，不影响生成表单使用。

- [x] Batch 11C：实现滚动触发。
  - 在最近任务列表底部添加 sentinel `div`，使用 `useRef<HTMLDivElement | null>`。
  - `IntersectionObserver` 的 `rootMargin` 建议 `360px 0px`，让用户接近底部前预加载。
  - 条件：`hasMore && !loadingInitial && !loadingMore` 才请求下一页。
  - 组件卸载或依赖变化时 disconnect observer。
  - 如果浏览器不支持 `IntersectionObserver`，展示“加载更多”按钮。

- [x] Batch 11D：保留手动加载兜底。
  - 在最近任务底部增加 footer：
    - 加载中：`正在加载更多任务...`
    - 可继续：按钮 `加载更多`
    - 到底：`已加载全部最近任务`
    - 错误：`加载失败` + `重试`
  - UI 使用现有 product 风格，不做大卡片嵌套，不引入装饰性动效。

- [x] Batch 11E：处理提交成功和轮询合并。
  - `handleSubmit` 成功后，新任务插入 `recentTasks` 顶部，去重，不再 `.slice(0, 6)`。
  - `activePollingTaskIds` 不再因为最近任务数量限制 `.slice(0, 6)`；可保留合理上限，例如 12 个活跃轮询 ID，防止异常批量提交造成轮询风暴。
  - `refreshRecentTasks` 改成刷新第一页并 merge，不覆盖已加载更早任务。
  - 单任务状态轮询继续按 `task.id` 更新已加载卡片。

- [x] Batch 11F：视觉和响应式整理。
  - 修改 `src/app/globals.css` 的 `.composer-recent`、`.composer-recent-grid` 附近样式。
  - 增加 `.composer-recent-footer`、`.composer-recent-load-more`、`.composer-recent-sentinel`、`.composer-recent-error`。
  - 移动端保持单列自然下滑，按钮不溢出，状态文字不遮挡缩略图。
  - 不使用固定高度内滚动，不做 nested cards。

- [ ] Batch 11G：验证和回归。
  - 构造或使用已有任务超过 12 条的本地数据，确认首屏只加载第 1 页。
  - 滚动到底部前触发第 2 页加载，任务卡片追加而不是替换。
  - 继续滚动直到 `hasMore=false`，展示到底状态。
  - 新建任务后，新任务出现在顶部，已加载的旧任务不丢。
  - 运行中任务状态更新后，卡片状态、截图、金额仍更新。
  - 当前代码、类型、lint、构建已通过；生产隔离构建、服务重启、公开静态资源验证已通过；登录态真实滚动验收待补。

### 验收标准

- [x] 构建产物层面确认生成页最近任务不再固定 6 条：生产 `.next-prod` 已包含 `limit=12`、`composer-recent-footer`、`加载更多`。
- [x] 页面自然向下延伸，不出现固定高度内部滚动容器。
- [x] 接近底部自动加载下一页，不是一次性拉取全部历史。
- [x] 加载中、加载失败、重试、到底四种状态已在组件状态中覆盖且不挡住生成表单。
- [x] 新任务提交后能立即进入顶部，旧任务分页结果不被清空。
- [x] 后台轮询不会把已经加载的更早任务覆盖掉。
- [x] 用户权限仍由 `/api/video/list` 控制，不新增越权数据面。
- [ ] 登录态真实页面滚动验收：需要在已登录浏览器中确认首屏、滚动触发和按钮兜底的实际交互。

### 验证命令

- [x] `git diff --check -- src/app/generate/page.tsx src/app/globals.css tasks/todo.md`
- [x] `npx tsc --noEmit --pretty false`
- [x] `npm run lint`
- [x] `npm run build`
- [x] `npx impeccable detect src/app/generate/page.tsx`
- [x] 隔离 worktree 验证：`npx tsc --noEmit --pretty false`
- [x] 隔离 worktree 生产构建：`NEXT_DIST_DIR=.next-prod npm run build`
- [x] 生产包验证：`.next-prod/BUILD_ID = V_IEwr1fh0mpmlS6VngzK`，生成页服务端包包含 `/api/video/list?page=${page}&limit=12`。
- [x] 公开资源验证：`https://sd2.youdoodesign.com/_next/static/chunks/app/generate/page-beb93a5cfdf807fb.js` 包含 `composer-recent-footer` 和 `加载更多`。
- [x] 服务验证：`/Users/gouki-youdoo/.youdoo/bin/youdoo-sites restart sd2 --wait 5` 后 `sd2 running ok ok 200`。
- [ ] 浏览器验证 `/generate`：
  - 登录态下首屏显示最近任务。
  - 滚动接近底部自动加载下一页。
  - 手动按钮兜底可用。
  - 移动端无横向溢出。
  - 当前本地未登录访问 `/generate` 返回 `307 /login?next=%2Fgenerate`，`/api/video/list?page=1&limit=12` 返回 `401 Unauthorized`，说明路由和 API 正常受登录态保护；需要登录态补完整交互验收。

### 风险与停止条件

- 如果 `/api/video/list` 的分页在生产数据量下响应慢，先查 SQL 和索引，不在前端扩大 limit 硬扛。
- 如果滚动触发导致重复请求，先修状态锁和 observer 生命周期，不靠防抖时间乱补。
- 如果提交成功后刷新第一页会清空更早页，停止实现，先修 merge 逻辑。
- 如果需要真实生成来验证新任务插入，只做用户明确授权后的付费操作；默认用已有任务或请求拦截验证。

### Git Plan

- 当前分支：`codex/minimal-feedback-loop`。
- 当前工作区已有多处未提交修改，执行前必须再次 `git status`，只触碰本计划范围。
- 预计修改文件：
  - `src/app/generate/page.tsx`
  - `src/app/globals.css`
  - `tasks/todo.md`
- 不修改：
  - `src/app/api/video/list/route.ts`，除非实测发现分页响应或字段不足。
  - `prisma/**`、扣费、Provider、任务创建接口。
- 提交策略：本任务实现和样式可作为一个聚焦提交；如果发现 API 需要优化，另拆提交。

### HARD-GATE

- 本节是规划，不是实现。
- 开始编码前需要确认：采用 `limit=12`、自然页面下滑、IntersectionObserver + 手动按钮兜底、提交成功只插顶部不清空已加载页。

### 落地记录 - 2026-06-11

- [x] `src/app/generate/page.tsx` 新增最近任务分页状态机，首屏请求 `/api/video/list?page=1&limit=12`。
- [x] 最近任务底部新增 `IntersectionObserver` sentinel，接近底部自动请求下一页。
- [x] 保留手动“加载更多”按钮，加载失败可重试，加载完成显示到底状态。
- [x] 提交成功后新任务插入顶部，不再裁剪成 6 条；活跃轮询 ID 上限调整为 12。
- [x] 轮询终态刷新第一页时使用 merge，不覆盖已加载的更早任务。
- [x] `src/app/globals.css` 增加最近任务 footer、加载、错误、到底、移动端样式，不使用固定高度内部滚动容器。
- [x] 本地验证：`git diff --check`、`npx tsc --noEmit --pretty false`、`npm run lint`、`npm run build`、`npx impeccable detect src/app/generate/page.tsx` 通过。
- [x] 生产安排：在 `/Volumes/Data/Projects/worktrees/video-api-debugger/recent-tasks-infinite-scroll-deploy` 创建隔离 worktree，只应用 `src/app/generate/page.tsx` 和 `src/app/globals.css` 的本次差异。
- [x] 生产构建：隔离 worktree 执行 `NEXT_DIST_DIR=.next-prod npm run build` 通过；仅有项目既有 `<img>` LCP lint warnings。
- [x] 生产替换：新包同步为 `/Volumes/Data/Projects/video-api-debugger/.next-prod`；曾短暂被主工作区构建覆盖为 `v5AQDBjd5J9c7LhDxD0lN`，已重新覆盖为隔离 worktree 构建 `V_IEwr1fh0mpmlS6VngzK`。
- [x] 回滚备份：主工作区构建包已备份到 `/Volumes/Data/Projects/video-api-debugger-deploy-backups/.next-prod.current-v5AQDBjd5J9c7LhDxD0lN-20260611225629`；该备份不是固定 6 的旧包，而是当前主工作区构建包。
- [x] 生产重启：最终使用 `launchctl kickstart -k gui/$(id -u)/com.youdoo.site.sd2` 直接重启，避免再次触发任何构建同步；`sd2.youdoodesign.com` 公开 health 为 200。
- [x] 公开资源验证：新 chunk `/_next/static/chunks/app/generate/page-beb93a5cfdf807fb.js` 已包含 `composer-recent-footer` 和 `加载更多`，说明刷新页面后会加载新前端包。
- [x] 风险复核：主工作区构建 `v5AQDBjd5J9c7LhDxD0lN` 短暂生效时，`/tmp/youdoo-site-sd2.err.log` 出现 `/api/reference-albums` 的 Prisma `P2022 public_folder_id` 报错；最终隔离包中已搜不到 `public_folder_id`、公共图集新 API 路由和未跟踪新路由，判断该日志为短暂主工作区构建留下的历史记录。
- [ ] 登录态浏览器验收：待用真实登录态打开 `/generate`，验证首屏 12 条、滚动加载下一页、手动按钮兜底和移动端无横向溢出。

---

## 2026-06-11 上传历史图片库与参考图选择弹窗计划

### 需求本质

- 用户表面需求：只要上传过的图片，都要出现在一个地方；可以增减、删除；后续点参考图时弹出小弹窗，里面展示曾经上传过的图片，底部有上传和取消按键。
- 真实目标：把“曾经上传过的图片”变成可复用的个人图片池，减少重复上传，让生成页添加参考图更快。
- 关键边界：
  - 这是个人上传历史，不是公共图集，不进入公共审核。
  - 公共图集用于共享和审核；上传历史用于个人复用，两者后续可以互通，但不能混成一个概念。
  - 删除历史图片默认做软删除或隐藏，不物理删除已被任务、图集、工作台引用的文件。
  - 不改变生成扣费、Provider 调用、任务创建参数口径。

### 当前代码依据

- `src/lib/hooks/useWorkspace.ts` 的 `uploadAsset`：生成页当前上传图片后，会调用 `/api/assets/upload`，再把返回的 `asset.id` 加到当前 workspace。
- `src/components/ReferenceStrip.tsx` 的 `handleAddClick`：当前点击添加参考图会直接触发隐藏文件选择器，不会先展示历史图片库。
- `src/components/ReferenceAlbumPicker.tsx` 的 `ReferenceAlbumPicker`：当前“选择参考图”只按图集读取 `ReferenceImage`，不是按上传过的 `Asset` 读取。
- `src/app/api/workspace/assets/route.ts` 的 `POST`：已经支持通过 `assetId` 把资产加入 workspace，也支持通过 `referenceImageIds` 加入图集图片。
- `src/app/api/assets/upload/route.ts`：上传入口已保存 `Asset`，并返回 `asset.id/originalUrl/thumbnailUrl`。
- `prisma/schema.prisma` 的 `Asset`：已有 `owner_id/type/original_url/thumbnail_url/file_name/mime_type/width/height/file_size/hash/created_at`，可以作为历史上传图片库的数据基础。

### 推荐产品方案

采用“上传历史图片库”独立弹窗，而不是把历史图片塞进公共图集。

- 生成页参考图区域的“添加”入口点击后，打开 `UploadedImagePicker` 弹窗。
- 弹窗默认展示当前用户上传过的图片，按最近上传倒序。
- 图片卡片支持：
  - 缩略图预览。
  - 文件名、尺寸、上传时间。
  - 已在当前工作台的状态提示。
  - 选中/取消选中。
  - hover/focus 后出现删除历史图片按钮。
- 底部操作建议：
  - 左侧：`上传新图片`
  - 右侧：`取消`、`加入参考图`
- 用户原话“下方是一个上传和取消按键”可落地为首版简化：
  - 未选图时：主按钮显示 `上传`
  - 选中历史图后：主按钮显示 `加入参考图`
  - 为避免歧义，推荐最终使用三按钮布局：`上传新图片 / 取消 / 加入参考图`。

### 交互闭环

1. 用户点击生成页参考图区域的添加卡片。
2. 系统打开历史图片弹窗。
3. 弹窗加载 `/api/assets/history?type=image&page=1&limit=40`。
4. 用户可直接选择历史图片，也可点击上传新图片。
5. 上传新图片成功后：
   - 写入 `Asset`。
   - 自动刷新历史列表。
   - 默认选中新上传图片。
6. 点击 `加入参考图`：
   - 调用 `/api/workspace/assets`，传入选中的 `assetId` 列表。
   - workspace 顺序追加，继续对应 `图1/图2/...` 和 `@图片N`。
   - 弹窗关闭，参考图条刷新。
7. 用户在弹窗里删除历史图片：
   - 二次确认。
   - 如果图片仍在当前 workspace，仅从历史库隐藏，不强制移出当前参考图。
   - 已被任务、图集或历史记录引用的资产不物理删除。

### 数据与 API 设计

- 新增 `Asset.status`，建议默认 `active`，支持 `active | hidden | deleted`。
- 新增迁移：
  - `ALTER TABLE Asset ADD COLUMN status TEXT NOT NULL DEFAULT 'active';`
  - 增加索引：`owner_id,type,status,created_at`。
- 新增 API：`GET /api/assets/history`
  - 只返回当前登录用户 `owner_id=user.id` 的图片资产。
  - 默认过滤 `type='image'` 和 `status='active'`。
  - 支持分页：`page/limit`。
  - 返回字段：`id, thumbnailUrl, originalUrl, fileName, width, height, fileSize, mimeType, createdAt`。
- 新增 API：`DELETE /api/assets/history/[id]`
  - 校验 owner。
  - 默认把 `Asset.status` 改为 `hidden`。
  - 不删除物理文件，不删除任务引用。
- 可选增强：`POST /api/assets/history/add-to-workspace`
  - 也可以不新增，首版直接复用现有 `/api/workspace/assets` 的 `assetId` 能力。

### 前端组件规划

- 新增 `src/components/UploadedImagePicker.tsx`
  - props：
    - `open`
    - `currentCount`
    - `currentAssetIds`
    - `onClose`
    - `onUploadFiles(files)`
    - `onConfirm(assetIds)`
  - 状态：
    - `items`
    - `selectedAssetIds`
    - `loading`
    - `uploading`
    - `deletingAssetId`
    - `error`
    - `page/hasMore`
- 修改 `src/components/ReferenceStrip.tsx`
  - `handleAddClick` 从直接 `fileInputRef.current?.click()` 改为打开历史图片弹窗。
  - 保留拖拽上传和替换逻辑，不删除现有入口。
  - 仍允许拖拽文件直接上传到参考图条，这是快速路径。
- 修改 `src/components/GenerationComposer.tsx`
  - 接入 `UploadedImagePicker`。
  - 给 `ReferenceStrip` 传入打开弹窗的回调，或直接在 `ReferenceStrip` 内部渲染弹窗。
  - 推荐弹窗状态放在 `GenerationComposer`，避免 `ReferenceStrip` 继续变胖。
- 修改 `src/lib/hooks/useWorkspace.ts`
  - 新增 `addAssets(assetIds: string[])` 或复用现有单个 `assetId` 添加逻辑扩展成批量。
  - 保持 `uploadAsset(file)` 的现有行为：上传后仍加入当前工作台。
  - 给弹窗上传新图时可增加 `uploadAssetToHistory(file, { addToWorkspace?: false })`，避免“上传只是进历史库”时自动加入工作台。

### 任务拆解

- [x] Batch 12A：数据模型与迁移规划。
  - 给 `Asset` 增加 `status` 字段和索引。
  - 确认老数据默认 `active`，不影响当前 workspace 和历史任务。
  - 生成迁移文件，但不自动应用生产库。

- [x] Batch 12B：历史图片 API。
  - 新增 `GET /api/assets/history`。
  - 新增 `DELETE /api/assets/history/[id]`。
  - 接口统一使用 `getSession()`，按当前用户隔离数据。
  - 不返回视频、音频，不返回隐藏资产。

- [x] Batch 12C：workspace 批量加入能力。
  - 扩展 `/api/workspace/assets` 支持 `assetIds` 数组。
  - 保留现有 `assetId` 和 `referenceImageIds` 入参兼容。
  - 继续限制最多 9 张参考图。
  - 重复 asset 只更新排序，不重复插入。

- [x] Batch 12D：新增 `UploadedImagePicker` 弹窗。
  - 首屏加载最近 40 张图片。
  - 图片网格支持选中、已在工作台、删除。
  - 支持上传新图片，上传成功后刷新列表并默认选中。
  - 底部操作固定：上传新图片、取消、加入参考图。
  - 空状态提示用户可以上传第一张图片。

- [x] Batch 12E：接入生成页参考图添加入口。
  - 点击添加参考图打开历史图片弹窗。
  - 拖拽上传、替换单张、删除当前参考图、排序保持原功能。
  - 加入历史图片后，参考图条立即刷新。
  - `@图片N` 顺序继续以 workspace 当前顺序为准。

- [x] Batch 12F：样式与响应式。
  - 在 `src/app/globals.css` 增加历史图片弹窗样式。
  - 桌面端弹窗宽度建议 840-960px，图片网格稳定列宽。
  - 移动端单列或双列，底部按钮不溢出。
  - 删除按钮只在 hover/focus 后显现，移动端长按不可靠，移动端始终显示一个小删除入口。

- [ ] Batch 12G：验证和验收。
  - 用已有上传图片验证历史库可读。
  - 上传新图片后确认出现在历史库。
  - 从历史库选择图片加入 workspace，生成页参考图条增加。
  - 删除历史图片后不再出现在弹窗，但当前任务/图集引用不坏。
  - 已在当前工作台的图片不能重复占用 9 张上限。

### 验收标准

- [ ] 所有通过生成页上传过的图片，默认会进入历史图片库。
- [ ] 点“添加参考图”先出现历史图片弹窗，而不是只打开系统文件选择器。
- [ ] 弹窗内可以选择历史图片加入当前参考图条。
- [ ] 弹窗内可以上传新图片，并在上传后立即出现在历史库。
- [ ] 弹窗内可以删除历史图片，且必须二次确认。
- [ ] 删除历史图片不破坏已生成任务、已有图集和当前工作台引用。
- [ ] 仍然最多 9 张参考图，重复选择不会重复插入。
- [ ] 原有拖拽上传、替换单张、删除当前参考图、排序能力保留。

### 验证命令

- [x] `git diff --check -- prisma/schema.prisma src/app/api/assets/history/route.ts src/app/api/assets/history/[id]/route.ts src/app/api/workspace/assets/route.ts src/lib/hooks/useWorkspace.ts src/components/GenerationComposer.tsx src/components/ReferenceStrip.tsx src/components/UploadedImagePicker.tsx src/app/globals.css tasks/todo.md`
- [x] `npm run db:generate`
- [x] `npx tsc --noEmit --pretty false`
- [x] `npm run lint`
- [x] `npm run build`
- [x] `npx impeccable detect src/components/UploadedImagePicker.tsx`
- [ ] 浏览器验证 `/generate`：
  - 添加参考图打开历史图片弹窗。
  - 上传新图片后自动刷新并可加入参考图。
  - 删除历史图片需要二次确认。
  - 移动端无横向溢出。

### 风险与停止条件

- 如果 `Asset` 当前被多个用户通过 hash 去重共用，必须先确认 owner 语义；不能因为一个用户隐藏历史图片影响另一个用户可见性。
- 如果物理删除会影响任务结果、图集或 workspace，禁止物理删除，改为 `hidden`。
- 如果 `/api/workspace/assets` 批量添加和现有 `referenceImageIds` 逻辑冲突，先保留单个添加循环，不改 reference image 逻辑。
- 如果上传历史图片库和公共图集 UI 概念混淆，先停下调整文案和入口，不继续编码。
- 如果需要真实生成验证，不执行付费生成，只验证上传、选择、workspace 参数。

### 回滚策略

- 前端回滚：恢复 `ReferenceStrip` 添加按钮为直接打开文件选择器。
- API 回滚：保留 `Asset.status` 字段不使用，历史 API 下线不影响现有上传和 workspace。
- 数据回滚：`hidden` 状态可批量恢复为 `active`；不做物理删除所以可恢复。

### Git Plan

- 当前工作区已有多处未提交修改，执行前必须再次 `git status`，只触碰本计划范围。
- 预计修改文件：
  - `prisma/schema.prisma`
  - `prisma/migrations/<timestamp>_add_asset_history_status/migration.sql`
  - `src/app/api/assets/history/route.ts`
  - `src/app/api/assets/history/[id]/route.ts`
  - `src/app/api/workspace/assets/route.ts`
  - `src/lib/hooks/useWorkspace.ts`
  - `src/components/UploadedImagePicker.tsx`
  - `src/components/GenerationComposer.tsx`
  - `src/components/ReferenceStrip.tsx`
  - `src/app/globals.css`
  - `tasks/todo.md`
- 不修改：
  - Provider 创建、扣费、任务结算逻辑。
  - 公共图集审核流，除非后续明确要求“历史图片保存到图集/提交公共”。
- 提交策略：
  - 提交 1：数据模型和历史图片 API。
  - 提交 2：workspace 批量加入与上传 hook。
  - 提交 3：弹窗 UI 和生成页接入。

### HARD-GATE

- 本节是规划，不是实现。
- 开始编码前需要确认：
  - 历史图片库是个人私有，不进入公共图集。
  - 删除使用软删除/隐藏，不物理删除文件。
  - 添加参考图入口改为先弹历史图片库，但保留拖拽上传快速路径。
  - 弹窗底部最终按钮采用 `上传新图片 / 取消 / 加入参考图`。

### Review - 2026-06-11

- [x] 已落地 `Asset.status` 和迁移文件 `20260611103000_add_asset_history_status`，用于历史图片隐藏，不物理删除文件。
- [x] 已新增 `/api/assets/history` 和 `/api/assets/history/[id]`，支持当前用户图片历史列表和软删除隐藏。
- [x] 已扩展 `/api/workspace/assets` 支持 `assetIds` 批量加入，保留 `assetId` 和 `referenceImageIds` 兼容。
- [x] 已新增 `UploadedImagePicker`，支持历史图片选择、上传新图片、删除历史图片、加载更多和加入参考图。
- [x] 已改造 `ReferenceStrip` 添加入口：点击添加参考图打开历史图片弹窗；拖拽上传、替换、删除、排序保留。
- [x] 已在 `GenerationComposer` 接入历史图片弹窗和 `useWorkspace.addAssets/uploadAssetToHistory`。
- [x] 已补历史图片弹窗样式和移动端响应式。
- [x] 已验证：`npm run db:generate`、`npx tsc --noEmit --pretty false`、`npm run lint`、`npm run build`、`npx impeccable detect src/components/UploadedImagePicker.tsx` 通过。
- [ ] 未执行浏览器真实点击验收：本轮未应用数据库迁移，运行库缺少 `Asset.status` 时历史图片 API 会失败；需在目标环境应用迁移后再验收。

---

## 2026-06-11 图集转为共享图集功能计划

### 需求本质

- 用户表面需求：把已有图集转为共享图集。
- 真实目标：让个人图集或项目图集可以授权给指定用户或项目使用，减少复制图集、重复上传和手动传图。
- 关键边界：
  - 共享图集不是公共图集。共享图集是定向授权；公共图集是管理员审核后进入公共文件夹。
  - 共享图集不复制图片、不复制图集，只修改访问授权。
  - 取消共享不能删除图集、图片、历史任务引用。
  - 项目图集原有项目成员权限必须保留，额外共享只是增加授权对象。

### 当前代码依据

- `prisma/schema.prisma` 已有 `AlbumShare`，包含 `album_id/grantee_type/grantee_id/permissions_json/expires_at/status`。
- `src/app/api/reference-albums/[id]/shares/route.ts` 已支持：
  - `GET` 列出当前图集共享记录。
  - `POST` 创建或更新共享记录。
  - 创建共享后，如果图集 `visibility='private'`，会更新为 `visibility='shared'`。
- `src/app/api/album-shares/[id]/route.ts` 已支持取消共享，并在没有 active share 时把 `visibility` 恢复为 `private` 或 `project`。
- `src/lib/reference-albums/permissions.ts` 已按 `AlbumShare` 计算用户/项目共享权限。
- `src/app/collections/[id]/ReferenceAlbumDetailClient.tsx` 已有“共享图集”区域，但当前要手填用户 ID / 项目 ID，缺少产品化“转为共享”流程。
- `src/app/collections/ReferenceAlbumsClient.tsx` 当前卡片能展示 `shared` scope，但缺少图集卡片上的“共享设置”入口。

### 推荐方案

基于现有 `AlbumShare` 做“共享设置”弹窗，不新增共享表。

- 图集列表卡片：
  - 有 `can_share` 或 `permissions.edit` 时显示 `共享设置`。
  - 私有图集第一次点击时文案可显示 `转为共享`。
  - 已共享图集显示 `已共享` 状态和共享数量。
- 图集详情页：
  - 顶部操作区新增 `共享设置`。
  - 替换当前手填 ID 的简陋分享区，保留共享列表能力。
- 弹窗分区：
  - 当前状态：私有 / 项目可见 / 已共享给 N 个对象 / 公共图集不可在此转共享。
  - 添加共享对象：用户 / 项目。
  - 权限预设：仅查看、可生成、可协作编辑。
  - 已共享对象列表：展示对象类型、对象名或 ID、权限、过期时间、移除按钮。
- 权限默认：
  - 推荐默认 `可生成`：view + use + copy。
  - 外部用户自动降权：不允许 download/viewSource/edit，沿用现有 API 逻辑。

### 交互闭环

1. 用户在图集列表或详情页点击 `转为共享` / `共享设置`。
2. 系统打开共享设置弹窗，加载图集详情和 active shares。
3. 用户选择共享对象类型：
   - 用户：搜索或输入用户。
   - 项目：搜索或选择项目。
4. 用户选择权限预设，必要时展开高级权限。
5. 点击 `保存共享`：
   - 调用 `POST /api/reference-albums/:id/shares`。
   - 图集 visibility 自动变为 `shared`。
   - 刷新共享对象列表和图集卡片状态。
6. 被授权用户进入“共享给我的”能看到图集，并按权限使用参考图。
7. 用户移除共享对象：
   - 调用 `DELETE /api/album-shares/:id`。
   - 如果无 active shares，图集恢复为 private 或 project。
8. 用户点击 `关闭全部共享`：
   - 二次确认。
   - 批量 revoke active shares。
   - 图集状态恢复私有或项目可见。

### 数据与 API 设计

- 复用现有 `AlbumShare`，不新增表。
- 建议增强 API：
  - `PATCH /api/album-shares/[id]`
    - 修改权限、过期时间、状态。
  - `POST /api/reference-albums/[id]/shares/revoke-all`
    - 一键关闭全部共享。
  - `GET /api/reference-albums/[id]/shares`
    - 返回时补充 grantee 展示信息：
      - user：name/email/account_type/status。
      - project：name/type/status。
- 可选增强：
  - `GET /api/users/search?q=...`
  - `GET /api/projects?can_share_album=true`
  - 如果现有搜索接口不足，首版可继续输入 ID，但 UI 必须解释清楚。

### 前端组件规划

- 新增 `src/components/ShareAlbumDialog.tsx`
  - props：
    - `open`
    - `album`
    - `shares`
    - `onClose`
    - `onRefresh`
  - 状态：
    - `targetType`
    - `targetId`
    - `permissionPreset`
    - `customPermissions`
    - `expiresAt`
    - `saving`
    - `error`
- 修改 `src/app/collections/[id]/ReferenceAlbumDetailClient.tsx`
  - 用 `ShareAlbumDialog` 替换现有手填共享区。
  - 顶部操作区增加 `共享设置`。
  - 保留上传、重命名、删除、作为参考图生成等原功能。
- 修改 `src/app/collections/ReferenceAlbumsClient.tsx`
  - 卡片展示 `已共享` 状态。
  - 卡片操作区新增 `共享设置`。
  - 分享后刷新当前列表和共享数量。
- 修改 `src/app/globals.css`
  - 新增共享弹窗、权限预设、共享对象列表、危险操作按钮样式。
  - 保持 8px 圆角、白底、蓝色主按钮、灰色次按钮，和现有图集页一致。

### 权限预设

- 仅查看：
  - `view=true`
  - `use=false`
  - `copy=false`
  - `download=false`
  - `viewSource=false`
  - `edit=false`
- 可生成（推荐默认）：
  - `view=true`
  - `use=true`
  - `copy=true`
  - `download=false`
  - `viewSource=false`
  - `edit=false`
- 可协作编辑：
  - `view=true`
  - `use=true`
  - `copy=true`
  - `download=false`
  - `viewSource=false`
  - `edit=true`
  - 仅 owner/admin 或项目资产管理员可授权。

### 任务拆解

- [x] Batch 13A：补共享 API 展示信息。
  - 增强 `GET /api/reference-albums/[id]/shares`，返回 grantee display 信息。
  - 保留旧字段，兼容当前详情页。
  - 验证外部用户权限降级不变。

- [x] Batch 13B：补共享记录更新和关闭全部共享。
  - 新增 `PATCH /api/album-shares/[id]`。
  - 新增 `POST /api/reference-albums/[id]/shares/revoke-all`。
  - 关闭全部共享后恢复 `visibility`。
  - 写 operation log。

- [x] Batch 13C：新增 `ShareAlbumDialog`。
  - 支持用户/项目目标。
  - 支持权限预设和高级权限展开。
  - 支持过期时间可选。
  - 支持共享对象列表、修改权限、移除对象、关闭全部共享。

- [x] Batch 13D：接入图集详情页。
  - 顶部操作区增加 `共享设置`。
  - 替换当前“共享图集”手填 ID 区域。
  - 成功共享后刷新 album 和 shares。
  - 详情摘要显示共享状态和共享数量。

- [x] Batch 13E：接入图集列表页。
  - 卡片展示 `已共享` 标签。
  - 操作区增加 `共享设置`。
  - 列表接口如需共享数量，补 `_count.shares` 或 active share count。
  - 保持原有提交公共、重命名、删除入口。

- [x] Batch 13F：样式与响应式。
  - 新增共享弹窗样式。
  - 移动端按钮不溢出。
  - 权限开关和共享对象列表在小屏可读。

- [ ] Batch 13G：浏览器和多账号行为验收。
  - 创建共享。
  - 被共享用户可见。
  - 按权限使用。
  - 修改权限。
  - 移除单个共享。
  - 关闭全部共享。
  - 确认公共图集和项目图集不被破坏。

### 验收标准

- [ ] 私有图集可以一键进入共享设置。
- [ ] 可以共享给指定用户。
- [ ] 可以共享给指定项目。
- [ ] 被共享对象能在“共享给我的”看到图集。
- [ ] 被共享对象能按权限查看、生成、复制。
- [ ] 外部用户不会获得下载、查看源图、编辑权限。
- [ ] 可以修改某个共享对象权限。
- [ ] 可以移除某个共享对象。
- [ ] 可以关闭全部共享并恢复图集原 visibility。
- [ ] 共享操作不复制图集、不复制图片、不影响历史任务。
- [ ] 公共图集仍走公共文件夹和审核流程，不被“共享设置”替代。

### 验证命令

- [x] `git diff --check`
- [x] `npx tsc --noEmit --pretty false`
- [x] `npm run lint`
- [x] `npm run build`
- [x] `npx impeccable detect src/components/ShareAlbumDialog.tsx`
- [ ] 浏览器验证 `/collections` 和 `/collections/:id`：
  - 打开共享设置。
  - 添加用户/项目共享。
  - 修改权限。
  - 移除共享。
  - 关闭全部共享。

### 风险与停止条件

- 如果用户/项目搜索能力不足，不要临时做不可靠模糊匹配；首版可输入 ID，但必须给清楚提示。
- 如果共享图集与公共图集在文案上混淆，先停下调整文案。
- 如果关闭全部共享会影响项目图集原项目权限，必须先修 visibility 恢复规则。
- 如果权限预设和底层 `permissions_json` 不一致，先修权限序列化，不继续做 UI。
- 如果需要用另一个真实账号验收，需用户提供已登录态或手动切换，不索取密码、token、cookie。

### 回滚策略

- 前端回滚：隐藏 `共享设置` 新入口，恢复旧的详情页共享区域。
- API 回滚：保留现有 `POST/GET shares`，下线新增 `PATCH/revoke-all` 不影响旧共享。
- 数据回滚：新增共享都是 `AlbumShare` 记录，可逐条 revoke；不涉及图片和任务数据删除。

### Git Plan

- 当前工作区已有多处未提交修改，落地前必须再次 `git status`，只触碰本计划范围。
- 预计修改文件：
  - `src/app/api/reference-albums/[id]/shares/route.ts`
  - `src/app/api/album-shares/[id]/route.ts`
  - `src/app/api/reference-albums/[id]/shares/revoke-all/route.ts`
  - `src/components/ShareAlbumDialog.tsx`
  - `src/app/collections/[id]/ReferenceAlbumDetailClient.tsx`
  - `src/app/collections/ReferenceAlbumsClient.tsx`
  - `src/app/globals.css`
  - `tasks/todo.md`
- 不修改：
  - 公共图集审核流。
  - 历史图片库。
  - Provider、扣费、生成任务逻辑。
- 提交策略：
  - 提交 1：共享 API 增强。
  - 提交 2：共享设置弹窗。
  - 提交 3：图集列表/详情页接入和样式。

### HARD-GATE

- 本节是规划，不是实现。
- 开始编码前需要确认：
  - 共享图集复用 `AlbumShare`，不新建共享表。
  - “转为共享”是授权访问同一个图集，不复制图集。
  - 默认权限采用 `可生成`。
  - 公共图集继续走公共文件夹和审核流程，不并入共享设置。

### Review - 2026-06-11

- 已实现共享 API 增强：`GET /api/reference-albums/[id]/shares` 返回 grantee 展示信息和解析后的权限；`POST` 保留外部用户降权并返回统一结构。
- 已新增共享管理能力：`PATCH /api/album-shares/[id]` 支持权限、过期时间、状态更新；`POST /api/reference-albums/[id]/shares/revoke-all` 支持关闭全部共享并恢复图集 visibility。
- 已新增 `ShareAlbumDialog`：支持用户/项目 ID、权限预设、高级权限、过期时间、共享对象列表、修改权限、移除单个对象和关闭全部共享。
- 已接入图集详情页和图集列表页：可管理图集显示 `转为共享` / `共享设置`，卡片和摘要显示 active share 数量；公共图集仍走公共文件夹和审核流程。
- 已验证：`git diff --check`、`npx tsc --noEmit --pretty false`、`npm run lint`、`npm run build`、`npx impeccable detect src/components/ShareAlbumDialog.tsx` 通过；lint/build 仍输出项目既有 `<img>` 与 hook dependency warning。
- 未执行浏览器和多账号行为验收：本轮未执行数据库写入或迁移命令；当前工作区已有前序图集/历史图片迁移未应用到运行库时，`/collections` 相关 API 可能先被缺表或缺列挡住。需在目标环境应用既有迁移后，再验证添加共享、共享给我的、权限修改、单个移除和关闭全部共享。

---

## 2026-06-12 生成提示词输入框自适应高度规划

### 需求本质

- 用户表面需求：生成页提示词输入框可以根据需要调整高度大小，或者自动适配。
- 本质目标：用户写短提示词时不要被大输入框占空间；写长提示词、分镜、镜头运动、参考图说明时，不要被固定 4 行高度打断，也不要频繁打开“放大编辑”。
- 不可变约束：
  - 生成页主任务仍是快速提交生成，输入框不能把参考图、状态行、参数栏和提交按钮挤到难以触达。
  - 不能破坏现有 `@图片1` 插入、字数限制、放大编辑弹层、焦点恢复和提交校验。
  - 不改 Provider、扣费、任务创建、prompt 渲染和参考图解析逻辑。
  - 移动端不能产生横向溢出，不能让 textarea 盖住 footer 工具条。

### 当前代码依据

- `src/components/PromptEditor.tsx` 的 `PromptEditor` 维护主输入框 `textareaRef` 和放大输入框 `expandedTextareaRef`，当前主输入框在 `handleChange` 中只做 2000 字限制，没有高度逻辑。
- `src/components/PromptEditor.tsx` 第 177-187 行渲染主 textarea，固定 `rows={4}`，class 为 `.composer-prompt-textarea`。
- `src/components/PromptEditor.tsx` 第 189-211 行渲染 footer，里面有规则提示、参考图按钮、“放大编辑”和字数计数；高度调整必须不遮挡这一排工具。
- `src/components/PromptEditor.tsx` 第 214-248 行已有“放大编辑”弹层，适合承载长文案深度编辑，不需要再新增第二套大编辑器。
- `src/app/globals.css` 第 6108-6120 行 `.composer-prompt-textarea` 当前 `min-height: 96px`、`resize: none`，导致用户既不能拖动，也不能自动长高。
- `src/app/globals.css` 第 6583-6585 行移动端把 `.composer-prompt-textarea` 的 `min-height` 提到 `120px`，移动端规划需保留更舒适的初始高度。
- `src/components/canvas/full/nodes.tsx` 第 298-306 行已有 textarea 自动增高参考实现：先设 `height=auto`，再取 `scrollHeight` 和 `maxHeight` 的较小值，超过上限后启用内部滚动。

### 设计方向

- 推荐方案：自动适配为主，手动 resize 作为兜底，放大编辑保留为深度编辑。
- 主输入框初始高度：
  - 桌面：约 4 行，保持当前 96px 左右。
  - 移动端：约 5 行，保持当前 120px 左右。
- 自动增长上限：
  - 桌面：`min(320px, 42vh)`，足够写完整分镜，但不会吞掉生成参数和按钮。
  - 移动端：`min(280px, 38vh)`，避免软键盘出现后页面被 textarea 占满。
- 超过上限后：
  - textarea 内部出现纵向滚动。
  - footer 继续固定在输入框下方，不被内容覆盖。
  - “放大编辑”仍然可用，作为长提示词整理模式。
- 手动调整：
  - 允许 `resize: vertical`，但配合 `min-height`/`max-height` 限制。
  - 用户手动拖动后，本轮编辑优先尊重用户手动高度；后续清空或复用任务时可重新回到自动高度。

### 有没有更优雅的方式

- 更优雅方案不是简单把 CSS 改成 `resize: vertical`，那会让 footer、移动端和长 prompt 溢出不可控。
- 更优雅方案是把 PromptEditor 变成“两级编辑”：
  - 主态：自动高度，适合 1-12 行提示词，跟随用户输入自然扩展。
  - 深度态：沿用现有放大编辑，适合长分镜、复杂运镜、逐秒说明。
- 这样不用新增依赖，也不引入新的页面结构；只是补齐主输入框的高度状态机。

### 交互细节

- 输入时自动扩展：
  - 每次 `value` 变化后，用 `requestAnimationFrame` 调整主 textarea 高度。
  - 逻辑：`height='auto'` -> `nextHeight=Math.min(scrollHeight,maxHeight)` -> 设置 `height` -> 根据是否超过上限切换 `overflowY`。
- 插入 `@图片N` 后自动扩展：
  - `insertMainReference` 调用 `onChange(next)` 后，下一轮 `value` 变化触发 resize。
  - 光标恢复逻辑保持不变。
- 复用历史任务后自动扩展：
  - `GenerationComposer` 通过 `setPrompt(reuseDraft.prompt)` 更新值，`PromptEditor` 根据 `value` 变化自动调整。
- 清空提示词后回缩：
  - 当 `value.trim()` 为空时，回到最小高度。
- 放大编辑：
  - 维持当前弹层，不强制自动增长。
  - 可选增强：给 `.composer-prompt-expanded-textarea` 改为 `resize: vertical` 或让它占满 panel 剩余高度，但不作为第一批必须项。

### 任务拆解

- [x] Batch 14A：抽出高度配置和 resize helper。
  - 修改 `src/components/PromptEditor.tsx`。
  - 新增主输入框高度常量，例如 `PROMPT_TEXTAREA_MAX_HEIGHT = 320`。
  - 新增 `resizeMainTextarea()`，复用画布节点里成熟的 `scrollHeight` 方案。
  - 使用 `useCallback` 保持依赖稳定。

- [x] Batch 14B：接入自动高度。
  - 在 `handleChange` 后不直接读 DOM，改为依赖 `value` 的 `useEffect`/`useLayoutEffect` 调整高度。
  - 初始挂载、复用任务、插入参考图、清空提示词都走同一条 resize 路径。
  - 避免 SSR 问题：只在 client component 的 effect 内访问 DOM。

- [x] Batch 14C：补手动调整兜底。
  - 修改 `src/app/globals.css`。
  - `.composer-prompt-textarea` 从 `resize: none` 改为 `resize: vertical`。
  - 增加 `max-height`、`overflow-y`、`scrollbar-gutter: stable`。
  - 保持 footer 和工具按钮不被 textarea 内容覆盖。

- [x] Batch 14D：响应式和视觉打磨。
  - 桌面保持 96px 初始高度。
  - 移动端保持 120px 初始高度，上限比桌面略小。
  - 校验按钮、参考图按钮、字数计数在输入框增高后仍贴合当前布局。
  - 不新增解释性大段文案；只保留当前规则提示和放大编辑入口。

- [ ] Batch 14E：可选深度编辑增强。
  - 评估 `.composer-prompt-expanded-textarea` 是否允许 `resize: vertical`。
  - 如果改，必须限制在弹层内部，不影响主页面滚动。
  - 如果移动端体验不好，保持现状，不做额外改动。

### 验收标准

- [x] 短提示词时，主输入框保持约 4 行，不显得过大。
- [x] 长提示词输入到 10-12 行时，主输入框自然增高，不需要立即点“放大编辑”。
- [x] 超过最大高度后，textarea 内部滚动，生成页参数栏和提交按钮仍可触达。
- [x] 用户可以手动纵向拖动调整高度，但不能横向拖动造成布局溢出。
- [x] 清空提示词后高度正确刷新；插入 `@图片1`、复用历史任务通过同一 `value` resize effect 覆盖，待真实素材页面回归补测。
- [x] 放大编辑、取消、完成、Escape 关闭、字数上限仍保持原行为。
- [x] 移动端无横向溢出，软键盘场景下不遮挡关键操作。

### 验证命令

- [x] `git diff --check -- src/components/PromptEditor.tsx src/app/globals.css tasks/todo.md`
- [x] `npx tsc --noEmit --pretty false`
- [x] `npm run lint`
- [x] `npm run build`
- [x] `npx impeccable detect src/components/PromptEditor.tsx`
- [x] 浏览器验证 `/generate`：
  - 输入 1 行、5 行、12 行、超长提示词。
  - 插入 `@图片1`（本轮未创建真实参考图数据，待真实素材页面回归补测）。
  - 点击“放大编辑”，取消和完成都正常。
  - 复用最近任务后高度自动适配。
  - 桌面和移动端都无横向溢出。

### 风险与停止条件

- 如果自动高度造成页面频繁跳动，先降低自动增长上限或只在输入后下一帧调整，不用动画强行掩盖。
- 如果手动 resize 和自动 resize 互相抢高度，优先保留自动高度，手动 resize 作为后续项。
- 如果移动端软键盘导致提交按钮不可达，降低移动端最大高度。
- 如果改动影响 `@图片` 插入光标位置、放大编辑草稿或提交校验，立即停止并先修 PromptEditor 状态流。

### Git Plan

- 当前分支：`codex/minimal-feedback-loop`。
- 当前工作区已有多处未提交改动，落地前必须再次 `git status`，只触碰本计划范围。
- 预计修改文件：
  - `src/components/PromptEditor.tsx`
  - `src/app/globals.css`
  - `tasks/todo.md`
- 不修改：
  - `src/components/GenerationComposer.tsx`，除非 PromptEditor 需要新增明确 props。
  - Provider、扣费、任务创建、prompt 解析、参考图上传和图集逻辑。
- 上线策略：
  - 如需同步 `sd2` 线上，继续使用隔离 worktree 构建，避免夹带当前工作区其它未提交改动。

### HARD-GATE

- 本节是规划，不是实现。
- 开始编码前需要确认：采用“主输入框自动高度 + 纵向手动 resize 兜底 + 保留放大编辑”的方案。

### Review - 2026-06-12

- 已实现：`src/components/PromptEditor.tsx` 增加主输入框自适应高度，桌面最大 320px，移动端最大 280px，超过上限后内部滚动；`src/app/globals.css` 放开纵向 resize，并设置桌面/移动端 CSS 上限。
- 已验证：`git diff --check`、`npx tsc --noEmit --pretty false`、`npm run lint`、`npm run build`、`npx impeccable detect src/components/PromptEditor.tsx` 均通过；lint 只有项目既有 `<img>` 与 hook dependency warning。
- 浏览器验证：在本地 `http://127.0.0.1:3100/generate` 使用只读 session cookie 验证，短文本高度 123px，长文本桌面封顶 320px，移动端封顶 280px，清空回缩，无横向溢出；放大编辑打开、完成、Escape 关闭保持正常。
- 生产同步：`youdoo-sites build sd2` 与 `youdoo-sites restart sd2 --wait 5` 通过；`sd2.youdoodesign.com` 当前 `launchd/port/build/local/public` 均为 OK，公网 CSS chunk 已确认包含 `resize:vertical`、`scrollbar-gutter:stable`、桌面 `max-height:min(320px,42vh)` 和移动端 `max-height:min(280px,38vh)`。
- 注意：本轮未提交生成任务，未执行 Provider、扣费、上传和真实参考图插入链路；`@图片` 插入和复用任务的高度刷新依赖 `value` 变化路径，已由同一 textarea resize effect 覆盖。

---

## 2026-06-12 批量下载视频闭环规划

### 需求本质

- 用户表面需求：在现有网站里批量下载视频。
- 用户真实目标：在任务列表、生成结果或后台产出里选中一批视频，一次拿到可交付文件，不要逐条点开、保存、复制链接。
- 最优体验目标：默认下载一个 ZIP 文件；小批量立即打包，大批量转后台任务，用户仍然只需要一次确认和一个下载结果。
- 不可变约束：
  - 必须复用现有单个视频缓存链路：`src/lib/video/local-cache.ts` 的 `cacheTaskVideoToLocal()`。
  - 必须复用现有任务权限语义：普通用户只能下载自己可见任务，管理员可在后台产出留存范围内批量下载。
  - 不改变 Provider 生成、扣费、任务创建和视频状态刷新逻辑。
  - 不把已过期 Provider 外链直接交给用户；下载前优先缓存为同源本地文件。
  - 大文件不能拖死 Next.js 请求或阻塞其它操作。

### 当前代码依据

- 单个保存接口：`src/app/api/video/download/[id]/route.ts`，已做登录、任务查询、`assertCanViewTask()` 权限校验、任务成功状态校验，并调用 `cacheTaskVideoToLocal()`。
- 本地缓存实现：`src/lib/video/local-cache.ts`，固定保存到 `public/videos/{taskId}.mp4`，已有同任务并发去重 `activeCacheTasks`，可刷新过期外链。
- 同源播放/下载接口：`src/app/api/video/play/[id]/route.ts`，支持本地文件 range 播放；本轮批量下载不能只依赖该接口，因为它当前只按 task id 取文件或重定向 provider URL。
- 我的任务页：`src/app/tasks/page.tsx`，已有分页任务列表、任务状态、实际扣费、本地视频字段和单条“查看详情 / 重新生成 / 从列表移除”操作，适合做普通用户批量入口。
- 项目列表页：`src/app/projects/page.tsx`，项目卡已有项目名、描述、负责人、成员数、任务数、图集数和 `管理 / 归档为只读 / 恢复` 操作；适合增加项目级 `下载视频包` 入口。
- 任务详情页：`src/app/tasks/[id]/page.tsx`，已有保存视频、打开视频、复制本地链接、下载视频按钮，适合复用文案和状态语义。
- 后台产出接口：`src/app/api/admin/outputs/route.ts`，已有管理员筛选、任务状态、项目、用户、成本、留存状态字段，适合做管理员批量导出入口。

### 目标对齐

| 用户目标 | 页面入口 | 第一批交付 | 后续增强 | 验收口径 |
|---|---|---|---|---|
| 下载某个项目的全部可交付视频 | `/projects` 项目卡 `下载视频包` | 项目卡按钮打开确认弹窗，按项目范围生成 ZIP | 项目全部历史视频超过阈值时自动创建后台任务 | 用户不需要进入项目详情或任务列表，也能拿到该项目视频包 |
| 从多个任务里挑一部分下载 | `/tasks` 任务列表多选 | 勾选任务后即时 ZIP 下载 | 支持跨页选择、保存选择状态 | 用户能精确控制下载范围 |
| 管理员按筛选条件导出产出 | `/admin/outputs` | 暂不放第一批，先保留规划 | 后台任务打包、按筛选结果全量导出 | 不阻塞普通用户侧闭环 |
| 下载后可交付、可复盘 | ZIP 文件 + `manifest.csv` | 视频文件名可读，manifest 包含任务与成本字段 | 增加封面图、项目说明、失败明细页 | ZIP 解压后直接可用于交付和归档 |
| 避免误点和系统卡死 | 确认弹窗 + 阈值策略 | 点击项目卡按钮后先确认；超过阈值不给同步打包 | 后台任务进度、完成通知、失败重试 | 大批量不会让页面长时间无响应 |

### 第一批任务目标

- P0：项目卡入口必须成立。用户在 `/projects` 看到项目卡时，可以直接点 `下载视频包`，不用先进入项目详情。
- P0：下载结果必须是一个 ZIP，不是连续弹出多个 mp4 下载。
- P0：ZIP 内必须有 `manifest.csv`，否则批量下载只是拿文件，不方便项目交付和追溯。
- P0：服务端必须逐条任务做权限校验，项目卡入口不能绕过任务可见性。
- P1：`/tasks` 多选入口同步做，满足“跨项目挑选几个结果下载”的场景。
- P1：大批量第一批先明确提示超过阈值，不做同步打包；后台任务作为第二批闭环。
- P2：管理员 `/admin/outputs` 复用，等用户侧体验稳定后再做。

### 方案选择

推荐组合：B 即时 ZIP 下载为默认，C 后台任务式打包作为大批量兜底。

- 方案 A：前端逐个触发下载。
  - 优点：最小改动。
  - 缺点：浏览器多文件下载限制明显，用户会收到多个下载弹窗，文件组织差。
  - 结论：不作为最终体验，只可作为开发期 fallback。
- 方案 B：即时 ZIP 下载。
  - 优点：用户只下载一个文件，符合“批量下载”的心智；可以附带 `manifest.csv`。
  - 缺点：需要 ZIP 依赖或 Node 流式打包；超大批量可能请求超时。
  - 结论：普通用户默认方案。
- 方案 C：后台任务式打包。
  - 优点：适合大批量、大文件、管理员导出，有进度和失败明细。
  - 缺点：需要新增批量任务模型和清理策略。
  - 结论：超过阈值自动切换，作为稳定兜底。
- 方案 D：管理员导出到服务器目录。
  - 优点：适合内部归档和 PPT 演示素材落盘。
  - 缺点：不是普通用户自助体验。
  - 结论：作为管理员后续增强，不进入第一批用户侧闭环。

### 有没有更优雅的方式

- 更优雅方案不是简单在任务列表里加很多“下载”按钮，而是把下载理解成“交付包生成”。
- 用户侧看到的是一个轻量动作：选中视频 -> 批量下载 -> 获得 ZIP。
- 系统侧用同一套 `bulk download job` 抽象承接即时打包和后台打包：小批量同步返回 ZIP，大批量创建 job，再复用相同的缓存、命名、manifest 和错误汇总逻辑。
- 这样后续后台产出、项目页、生成页最近任务都可以复用同一个批量下载能力，而不是每个页面各写一套。

### 交互设计

- 普通用户入口：
  - `/tasks` 任务列表增加批量选择模式。
  - 每张任务卡左上或操作区出现 checkbox。
  - 顶部 sticky 批量工具条显示：已选数量、可下载数量、不可下载数量、预计打包方式。
  - 主按钮：`批量下载 ZIP`。
  - 次按钮：`清空选择`。
- 项目卡入口：
  - `/projects` 项目卡增加 `下载` 或 `下载视频包` 按钮，和 `管理`、`归档为只读` 同层，但视觉上不抢主入口。
  - 按钮语义不是下载项目卡，而是下载该项目下可见的已完成视频。
  - 点击后打开项目级批量下载确认弹窗，展示项目名、可下载视频数、不可下载数、预计打包方式。
  - 如果项目没有可下载视频，按钮 disabled，文案为 `暂无可下载视频` 或 hover 说明原因。
  - 归档项目仍允许下载历史视频；归档只影响继续生成和新增素材，不影响历史交付包。
- 选择规则：
  - 默认只允许选择 `local_status === 'succeeded'` 且有 `local_video_path` 或 `result_video_url` 的任务。
  - 不满足条件的任务 checkbox disabled，并在 tooltip 或状态文案里说明“生成未完成 / 无视频链接 / 已移除”。
- 确认弹窗：
  - 展示数量、任务范围、预计行为。
  - 小批量：`将打包为 ZIP，可能需要几秒到几分钟。`
  - 大批量：`将创建后台打包任务，完成后可回来下载。`
  - 展示失败预警：外链可能过期、缓存失败会进入失败明细。
- 下载结果：
  - 即时 ZIP：浏览器下载一个 `seedance-videos-YYYYMMDD-HHmm.zip`。
  - ZIP 内文件名：`001_任务短ID_项目名_分辨率_秒数.mp4`，避免只看到随机 ID。
  - 附带 `manifest.csv`：任务 ID、项目、生成者、创建时间、完成时间、分辨率、秒数、比例、实际扣费、提示词摘要、文件名、状态。
- 大批量后台任务：
  - 弹窗切换为进度视图：待缓存、缓存中、已打包、失败数量。
  - 完成后展示 `下载 ZIP`、`复制下载链接`、`查看失败明细`。
- 管理员入口：
  - 第一批做用户侧 `/projects` 项目卡和 `/tasks` 多选闭环。
  - 第二批在 `/admin/outputs` 复用同样选择器和批量下载弹窗。
  - 管理员可按当前筛选结果“下载当前页选中项”，后续再做“下载全部筛选结果”。

### 数据与接口设计

- 第一批即时接口：
  - `POST /api/video/bulk-download`
  - 入参：`{ taskIds?: string[], projectId?: string }`
  - 行为：校验登录 -> 按 `taskIds` 或 `projectId` 查询任务 -> 逐条权限校验 -> 过滤可下载 -> 调用 `cacheTaskVideoToLocal()` -> 流式打包 ZIP -> 返回文件。
  - 约束：`taskIds` 和 `projectId` 第一批二选一；项目卡入口传 `projectId`，任务列表入口传 `taskIds`。
  - 限制：普通用户单次最多 20 个；管理员第一批最多 50 个；超过阈值返回 `requires_background_job: true`。
- 第二批后台任务接口：
  - `POST /api/video/download-batches`
  - `GET /api/video/download-batches/[id]`
  - `GET /api/video/download-batches/[id]/file`
  - `POST /api/video/download-batches/[id]/retry-failed`
- 建议新增模型：
  - `VideoDownloadBatch`：`id/user_id/status/source/scope_json/zip_path/file_size/total_count/success_count/failed_count/error_message/expires_at/created_at/updated_at/completed_at`
  - `VideoDownloadBatchItem`：`id/batch_id/task_id/status/local_video_path/file_name/file_size/error_message/created_at/updated_at`
- 文件存放：
  - 临时 ZIP：`storage/download-batches/{batchId}.zip` 或 `public/downloads/video-batches/{batchId}.zip`。
  - 如果走 public 目录，必须用不可猜测 batch id，并在下载接口里校验权限后读取文件，不直接暴露目录列表。
- 依赖选择：
  - 已选 `yazl` 做 Node 流式 ZIP；`archiver` 当前版本在本项目 Next 构建中触发导出条件错误，不作为第一批依赖。
  - 如果不想新增依赖，必须评估 Node 原生没有 ZIP 打包能力，手写 ZIP 不值得。

### 执行任务拆解

- [x] Batch 15A：补 ZIP 与批量下载基础设施 Spec。
  - 明确依赖：使用 `yazl`。
  - 明确阈值：普通用户 20 个或 1GB 内即时；超过转后台任务。
  - 明确文件命名、CSV 字段、失败项结构。
  - 明确 API 入参同时支持 `projectId` 和 `taskIds`，但第一批一次请求只能使用一种范围。
  - 输出最终接口契约后再编码。

- [x] Batch 15B：抽批量下载服务层。
  - 新增 `src/lib/video/bulk-download.ts`。
  - 封装项目范围任务查询、指定任务查询、权限校验、可下载状态判断、缓存调用、文件名生成、manifest 生成。
  - 普通用户权限复用 `assertCanViewTask()`。
  - 管理员路径后续复用，但第一批不开放全部筛选结果下载。

- [x] Batch 15C：实现即时 ZIP API。
  - 新增 `src/app/api/video/bulk-download/route.ts`。
  - 接收 `taskIds` 或 `projectId`，拒绝空数组、重复 ID、范围冲突、超过阈值。
  - `projectId` 模式按当前用户可见任务查询该项目下已完成视频，不信任前端传入数量。
  - 对每个任务调用 `cacheTaskVideoToLocal()`，失败项写入 manifest，不让单个失败中断整包。
  - 成功视频加入 ZIP；如果没有任何成功视频，返回 400 和失败明细。
  - 响应 header 设置 `Content-Type: application/zip`、`Content-Disposition`。

- [x] Batch 15D：任务列表批量选择 UI。
  - 修改 `src/app/tasks/page.tsx`。
  - 增加选择状态、可下载判断、批量工具条、确认弹窗、下载中状态、失败提示。
  - 下载时用 `fetch` 获取 blob，再触发一个 ZIP 文件下载。
  - 保留原有查看详情、重新生成、从列表移除功能，不改变现有单条操作。

- [x] Batch 15E：项目卡下载入口。
  - 修改 `src/app/projects/page.tsx`。
  - 在项目卡操作区增加 `下载视频包` 入口；所有可见项目成员可见，空项目或没有已完成视频时 disabled。
  - 点击后复用批量下载确认弹窗，下载范围固定为该项目下当前用户可见的已完成视频。
  - 第一批下载该项目最近 N 个可下载视频并明确显示数量；如果用户要项目全部历史视频，必须走后台任务或服务端分页查询。
  - 保留原有 `管理`、`恢复`、`归档为只读` 链路，不改变项目权限和归档语义。

- [x] Batch 15F：体验与状态闭环。
  - 下载中展示阶段：准备任务、缓存视频、打包 ZIP、开始下载。
  - 成功后提示：已打包 X 个，失败 Y 个，失败明细可在 ZIP 的 manifest 中查看。
  - 禁止重复点击；下载取消先不做，后续由后台任务承接。
  - 移动端批量工具条不遮挡任务卡操作。

- [ ] Batch 15G：大批量后台任务兜底。
  - 新增 Prisma 模型和迁移。
  - 新增 batch API。
  - 新增后台进度页或弹窗轮询。
  - 新增过期清理策略，避免 ZIP 无限占用磁盘。
  - 该批次在即时 ZIP 稳定后再做。

- [ ] Batch 15H：管理员产出留存复用。
  - 修改 `src/app/admin/outputs/AdminOutputsClient.tsx`。
  - 增加当前页多选批量下载。
  - 后续评估“下载全部筛选结果”是否必须走后台任务，不能同步请求。

### 验收标准

- [x] 普通用户在 `/tasks` 可多选已完成、有视频链接的任务。
- [x] 普通用户在 `/projects` 项目卡可直接发起该项目视频包下载。
- [x] 未完成、失败、无视频链接的任务不能被选中，并有明确原因。
- [x] 选中 1-20 个任务后，点击一次即可下载一个 ZIP。
- [x] 项目卡下载会先展示确认弹窗，不会误点后立即开始大批量下载。
- [x] ZIP 内视频文件名可读，不只有 task id。
- [x] ZIP 内包含 `manifest.csv`，字段覆盖任务 ID、项目、生成者、时间、参数、扣费、提示词摘要和失败原因。
- [x] 有本地视频的任务不重复拉取 Provider；无本地视频但外链有效时会先缓存。
- [x] Provider 外链过期时，调用现有刷新逻辑；刷新失败不影响其它视频入包。
- [x] 普通用户不能通过传入其它用户 taskId 下载无权限视频，manifest 也不能泄露无权任务的项目、生成者、提示词或扣费元数据。
- [ ] 管理员入口上线前，后台 API 也必须做管理员鉴权，不能复用普通用户接口绕过权限。
- [ ] 大批量超过阈值时不会让请求挂死，返回后台任务兜底提示或创建后台任务。
- [x] 移动端无横向溢出，批量工具条和弹窗可关闭、可恢复。

### 验证计划

- 静态验证：
  - `git diff --check`
  - `npx tsc --noEmit --pretty false`
  - `npm run lint`
  - `npm run build`
  - `npx impeccable detect src/app/tasks/page.tsx`
- API 验证：
  - 未登录请求 `POST /api/video/bulk-download` 返回 401。
  - 空数组、重复 ID、超过阈值返回明确错误。
  - 同时传 `taskIds` 和 `projectId` 返回范围冲突错误。
  - `projectId` 模式只打包当前用户可见项目内任务。
  - 普通用户传入无权 taskId 返回跳过或 403，不泄露视频。
  - 混合成功/失败任务时，ZIP 仍生成，并在 manifest 里记录失败项。
- 文件验证：
  - 解压 ZIP，确认视频可播放。
  - `manifest.csv` 编码可被 Excel/Numbers 打开。
  - 文件名不包含 `/`、空字符、过长 prompt 或不可用字符。
- 浏览器验证：
  - `/tasks` 桌面多选、取消、确认下载、失败提示。
  - 移动端宽度 390px 无横向溢出。
  - 单条原有按钮仍正常。
- 权限验证：
  - 普通用户 A 不能下载用户 B 的私有任务。
  - 项目成员权限按 `assertCanViewTask()` 保持一致。
  - 管理员后台入口必须使用 admin API。

### 风险与回滚

- 风险：ZIP 依赖引入后构建体积或 Edge runtime 不兼容。
  - 控制：API route 明确使用 Node runtime；依赖只在服务端 import。
- 风险：大文件同步打包超时。
  - 控制：设置数量和大小阈值；超过阈值走后台任务。
- 风险：Provider 外链过期导致批量失败。
  - 控制：复用 `cacheTaskVideoToLocal()` 的刷新逻辑；单个失败不影响整包。
- 风险：磁盘占用增长。
  - 控制：即时 ZIP 不落盘或短期临时文件；后台 ZIP 设置 `expires_at` 和清理脚本。
- 风险：权限扩大。
  - 控制：服务端逐条校验任务权限；ZIP 文件下载也校验 batch owner/admin。
- 回滚：
  - 前端隐藏批量下载入口。
  - 保留现有单个下载接口不变。
  - 若后台任务表已上线，只停止创建新 batch，不删除已有数据。

### Git Plan

- 当前分支：`codex/minimal-feedback-loop`。
- 当前工作区：规划前干净。
- 规划提交只修改 `tasks/todo.md`。
- 实现前必须重新 `git status`，避免混入其它改动。
- 第一批预计修改文件：
  - `src/lib/video/bulk-download.ts`
  - `src/app/api/video/bulk-download/route.ts`
  - `src/app/tasks/page.tsx`
  - `src/app/projects/page.tsx`
  - `src/app/globals.css`
  - `tasks/todo.md`
  - `tasks/lessons.md`
- 如果需要 ZIP 依赖，预计修改：
  - `package.json`
  - `package-lock.json`
- 第二批后台任务预计修改：
  - `prisma/schema.prisma`
  - `prisma/migrations/*`
  - `src/app/api/video/download-batches/*`
  - `scripts/*` 清理脚本（如需要）
- 完成实现和验证后，做聚焦提交并推送当前分支；如果 GitHub 网络仍失败，保留本地 commit 并明确报告。

### HARD-GATE

- 已确认并进入实现。
- ZIP 依赖落地为 `yazl`，不是 `archiver`。
- 第一批范围：用户侧 `/projects` 项目卡下载视频包 + `/tasks` 多选即时 ZIP；超过阈值先提示不支持大批量，后台任务放第二批。

### Review - 2026-06-12

- 已实现：新增 `POST /api/video/bulk-download`，支持 `taskIds` 和 `projectId` 二选一；新增批量下载服务层，复用 `cacheTaskVideoToLocal()`，打包 ZIP 和 `manifest.csv`。
- 已实现：`/projects` 项目卡新增 `下载视频包` 入口，先展示项目级确认弹窗；`/tasks` 增加本页可下载任务多选、批量工具条和确认弹窗。
- 已调整：ZIP 依赖从规划推荐的 `archiver` 改为 `yazl`，因为 `archiver` 当前 ESM 导出条件会导致 Next build 失败。
- 已验证：`git diff --check`、`npx tsc --noEmit --pretty false`、`npm run lint`、`npm run build`、`npx impeccable detect src/app/projects/page.tsx`、`npx impeccable detect src/app/tasks/page.tsx` 通过。
- 已验证：本地 `http://127.0.0.1:3100` API smoke 通过，未登录返回 401，范围冲突返回 400，`taskIds` 和 `projectId` 模式都能生成 ZIP；ZIP 内含 mp4 和 `manifest.csv`，文件名经 Python `zipfile` 验证正常。
- 已验证：Playwright 检查 `/projects` 有项目下载按钮和确认弹窗，`/tasks` 有批量工具条和任务选择框，桌面与 390px 移动端无横向溢出。
- 未完成：大批量后台任务、管理员 `/admin/outputs` 复用、跨页选择和后台 ZIP 清理策略仍保留为后续批次。

---

# Batch 16：生成页 `@` 自动弹窗与主体引用 Todo

更新时间：2026-06-13

目标页面：`/generate` 普通生成页，兼顾 `/generate/canvas` 画布生成卡。

## 需求目标

把即梦截图里的 `@` 交互还原到本站生成输入框：

1. 用户在提示词输入框里输入 `@` 后自动弹出候选面板，不需要点按钮。
2. 弹窗标题为“可能@的内容”，第一项是“+ 创建主体”。
3. 第一批候选覆盖当前参考图、历史上传图片、图集图片，并全部闭环到真实 `referenceImageIds`。
4. `+ 创建主体` 和已有主体候选保留为目标形态，但主体创建、主体管理和 `album_type=subject` 放第二批，不阻塞基础 `@` 弹窗上线。
5. 选中候选后，必须替换当前光标前的 `@query`，不能粗暴追加到提示词末尾。
6. 后端仍以 `referenceImageIds` 顺序绑定真实图片，prompt 里的 `@图片N` 只作为用户可读标记，不能误以为 provider 会自动解析主体名。
7. 画布页已有的 `@` 自动弹窗不能退化，后续应复用共享解析逻辑，减少两套实现分叉。

## 当前代码依据

- `src/components/PromptEditor.tsx` 的 `PromptEditor`：
  - 当前只有参考图按钮插入，`insertMainReference()` / `insertDraftReference()` 会把 `@图片N` 插到光标位置。
  - 输入 `@` 不会自动弹窗。
  - 主输入框和放大编辑框各维护一套插入逻辑，后续要统一。
- `src/components/GenerationComposer.tsx` 的 `GenerationComposer`：
  - `referenceLabels` 由 `workspace.assets` 顺序生成 `图片1`、`图片2`。
  - `handleAddReferenceImages()` 会把图集图片加入工作台，并自动 append `@图片N` 到 prompt 末尾。
  - `handleAddUploadedAssets()` 只把历史图片加入工作台，不会自动插入 `@图片N`。
  - `handleSubmit()` 会把 `workspace.assets[*].referenceImageId` 按顺序传给 `referenceImageIds`。
- `src/components/canvas/full/nodes.tsx` 的 `GenerationCard`：
  - 画布页已有 `updateMentionState()`，用 `/(^|\s)@([^\s@]*)$/` 在输入 `@` 时打开候选。
  - `insertMention()` 会替换当前 `@query`，支持方向键、Enter、Tab、Escape 和点击选择。
  - 当前候选只来自已连线图片 `connectedImageAssets`。
- `src/components/ReferenceAlbumPicker.tsx` 的 `ReferenceAlbumPicker`：
  - 已支持我的图集、项目图集、共享给我的、公共图集。
  - 确认按钮文案为“加入并插入 @图片”，但插入方式由 `GenerationComposer.handleAddReferenceImages()` 追加到末尾。
- `src/components/UploadedImagePicker.tsx` 的 `UploadedImagePicker`：
  - 已支持历史图片列表、上传新图片、选择、删除和加入参考图。
  - 确认按钮当前是“加入参考图”，没有自动插入 `@图片N`。
- `src/lib/hooks/useWorkspace.ts` 的 `useWorkspace`：
  - `addAssets()` / `addReferenceImages()` 会调用 `/api/workspace/assets` 后刷新 workspace。
  - 当前返回值是 `Promise<void>`，调用方需要用现有资产顺序推导新增后的 `图片N`。
- `src/app/api/workspace/assets/route.ts` 的 `POST`：
  - 支持 `assetIds` 和 `referenceImageIds` 两种加入方式。
  - 历史上传图片加入 workspace 时会通过 `attachAssetToSiteReferenceImage()` 补齐站内参考图记录，并返回 `referenceImageIds`。
- `src/components/PromptChecker.tsx` 的 `checkPrompt()`：
  - 识别 `@图片1`、`@图片 1`，兼容 `@图1` / `图1`。
  - 会检测 prompt 引用的图号是否超过当前素材数量。
- `docs/sd2-external-api-integration.md`：
  - 已明确 `@图片N` 本身只是 prompt 文本，真实绑定必须依赖 `reference_image_ids` / `referenceImageIds` 数组顺序。

## 第一性原理

`@` 不是装饰性输入提示，而是“把语义描述绑定到真实参考素材”的命令入口。

用户真正需要的是：在写提示词的当下，用最短路径选择“我要引用哪个对象或图片”，系统自动把它转成当前 provider 能理解的 `@图片N + referenceImageIds 顺序绑定`。因此第一版必须优先闭环真实图片绑定，主体名只是更友好的展示与分组入口，不能在 provider 不支持时只插入 `@主体名`。

有没有更优雅的方式：把普通生成页和画布页的 `@` 检测、替换、键盘交互抽成共享 mention 能力；页面只负责提供候选和处理“候选选中后如何加入 workspace”。这样既还原即梦体验，也避免继续维护两套 `@` 逻辑。

## 页面逻辑与交互层级

- 页面核心任务：在提示词编辑过程中快速选择并绑定参考素材。
- 第一眼内容：
  - 输入 `@` 后，光标附近出现“可能@的内容”弹窗。
  - 第一项固定是“+ 创建主体”。第一批可作为入口占位或打开现有图集保存流程，不新增主体数据模型。
  - 其后优先展示当前工作台参考图，带缩略图、`@图片N`、文件名或图集来源。
  - 再展示“从历史图片选择”“从图集选择”这类来源动作，让不在 workspace 的图片也能通过同一入口加入并插入。
  - 空状态明确提示“先上传或从历史图片选择”。
- 最高频动作：
  - 输入 `@`。
  - 方向键选择候选。
  - Enter/Tab 或点击插入。
  - 继续输入文字。
- 一级可见功能：
  - 当前参考图候选。
  - 创建主体入口（第一批展示入口，第二批完成主体库）。
  - 最近/历史图片入口。
- 二级功能：
  - 图集选择、公共图集、共享图集、批量选择。
  - 主体管理、主体重命名、主体删除。
- 隐藏或延后功能：
  - 主体创建、已有主体列表、主体重命名、主体删除。
  - 复杂主体训练、跨项目主体权限、主体版本管理。
  - provider 级主体语法，除非后续确认后端支持。
- 主路径：
  - 用户输入 `@` -> 弹窗打开 -> 选择当前参考图 -> prompt 当前 `@query` 被替换成 `@图片N` -> `PromptChecker` 显示引用正常 -> 提交时 `referenceImageIds` 顺序与 `@图片N` 对齐。
- 复杂路径：
  - 用户输入 `@` -> 选择历史图片或图集图片 -> 图片加入 workspace -> 系统计算新增后的 `图片N` -> 替换当前 `@query` -> 提交。
- 状态要求：
  - 无参考图：显示创建主体入口、上传图片、从历史图片选择、从图集选择。
  - 正常：显示当前素材、历史图片入口、图集入口；主体候选第二批补齐。
  - 达到 9 张上限：禁用会新增素材的候选，说明“最多 9 张”。
  - 加载失败：弹窗内展示失败文案，但输入框仍可继续编辑。

## 分期边界

### 第一批：基础 `@ mention` 闭环

第一批只解决“输入 `@` 自动弹窗 + 真实图片绑定”：

- 抽公共 mention 解析/替换能力。
- 普通 `/generate` 输入 `@` 自动弹出“可能@的内容”。
- 当前工作台图片作为候选，选中后直接插入当前 `@图片N`。
- 历史上传图片和图集图片可以从 `@` 弹窗进入选择，选中后先加入 workspace，再插入真实 `@图片N`。
- 重复选择同一张图片时复用已有 `@图片N`，不重复加入 workspace。
- 9 张上限、失败提示、键盘操作、移动端展示一次闭环。
- 画布 `/generate/canvas` 复用共享 mention 解析/替换逻辑，但候选仍保持“已连线图片”。

### 第二批：主体能力

第二批再做“主体”：

- 创建主体。
- 已有主体候选，如 `export (1)`。
- 主体图集或 `album_type=subject`。
- 主体管理：重命名、删除、共享、权限、图片增减。
- 选择主体后把主体图片加入 workspace，并插入对应 `@图片N`，而不是提交 `@主体名` 给 provider。

## 推荐架构

### 共享 mention 解析层

新增 `src/lib/prompt/mention.ts`：

- `detectMentionAtCursor(value, cursor)`：
  - 返回当前光标前是否处于 `@query` 状态。
  - 兼容行首、空格后、中文标点后输入 `@`。
  - 不在邮箱、URL、已有完整 `@图片1` 中误触发。
- `replaceMentionAtCursor(value, mention, insertText)`：
  - 用候选文本替换当前 `@query`。
  - 自动补一个尾随空格，避免和后文粘连。
  - 返回 next value 和 next cursor。
- `parseImageMentions(value)`：
  - 从 `PromptChecker` 抽出或复用现有 `@图片N` 解析，避免两套正则。

### 共享弹窗组件

新增 `src/components/PromptMentionPopover.tsx`：

- 接收候选列表、activeIndex、loading、empty、onSelect、onActiveChange。
- 视觉上接近即梦：
  - 标题“可能@的内容”。
  - 第一行“+ 创建主体”。
  - 候选行：缩略图、主标题、辅助信息。
  - 紧凑深色浮层或跟随当前生成页主题的深色面板。
- 交互：
  - ArrowUp / ArrowDown 切换。
  - Enter / Tab 选中。
  - Escape 关闭。
  - 鼠标按下选择时不要让 textarea 失焦导致 range 丢失。
- 样式加入 `src/app/globals.css`，避免和画布页 `.mention-popover` 命名冲突。

### 第一批候选模型

第一批不实现完整主体库，先统一候选协议：

```ts
type MentionCandidate =
  | { type: 'action'; action: 'create_subject'; label: '创建主体'; disabled?: boolean; description?: string }
  | { type: 'image'; token: '@图片1'; label: '图片1'; title: string; thumbnailUrl?: string; referenceImageId?: string; assetId?: string }
  | { type: 'source'; source: 'history' | 'album'; label: string; description?: string };
```

第一批候选顺序：

1. `+ 创建主体`：先展示入口；如果主体功能未落地，点击后打开二期提示或复用“保存当前参考图为图集”的低风险入口。
2. 当前 workspace 图片：`@图片1`、`@图片2`。
3. 来源动作：`从历史图片选择`、`从图集选择`。

第二批再扩展：

```ts
type SubjectMentionCandidate = {
  type: 'subject';
  token?: string;
  subjectId: string;
  label: string;
  thumbnailUrl?: string;
  count: number;
};
```

### 普通生成页接入

修改 `src/components/PromptEditor.tsx`：

- 新增 props：
  - `mentionCandidates`
  - `onMentionSelect`
  - `onCreateSubject`
  - `onOpenMentionSource`
- 主输入框和放大编辑框都支持输入 `@` 自动触发。
- 保留现有 `@图片N` 按钮，不删除旧功能。
- 选择候选时按当前 textarea 的 mention range 替换，不再只 append 到末尾。
- 选择需要异步加入 workspace 的候选时，显示小 loading 状态，失败后保留原 prompt 和错误提示。

修改 `src/components/GenerationComposer.tsx`：

- 将 `referenceLabels` 扩展为 `mentionCandidates`：
  - 当前 workspace 图片：直接插入 `@图片N`。
  - 创建主体：第一批只做入口展示或低风险占位；完整创建流程第二批。
  - 历史图片入口：打开 `UploadedImagePicker`，选择后插入到 pending mention range。
  - 图集入口：打开 `ReferenceAlbumPicker`，选择后插入到 pending mention range。
- 抽出“加入或复用图片并返回 label” helper：
  - 传入 `assetIds` 或 `referenceImageIds`。
  - 已在 workspace 的返回已有 `图片N`。
  - 新增的根据当前 `workspace.assets.length` 和新增顺序返回 `图片N`。
  - 加入失败时抛出明确错误。
- 改造 `handleAddUploadedAssets()`：
  - 普通从历史图片入口打开时，加入后也能插入 `@图片N`。
  - 如果没有 pending mention range，则沿用当前行为或 append markers。
- 改造 `handleAddReferenceImages()`：
  - 支持 pending mention range 替换。
  - 图集批量选择时插入多个 `@图片N`，顺序与 workspace 保持一致。

### 主体功能第二批

第二批不新增 provider 级主体语法，只把主体作为“可复用的一组参考图”来实现：

- 候选展示可以显示主体名，例如 `export (1)`。
- 选中主体后，把主体内图片加入 workspace，并插入对应 `@图片N`。
- 如果主体只有 1 张，插入一个 `@图片N`。
- 如果主体有多张，按主体内排序插入多个 `@图片N`。
- “+ 创建主体”第二批可复用当前图集能力：
  - 有当前参考图时：提示输入主体名，把当前参考图保存为主体图集。
  - 没有参考图时：打开历史图片弹窗，选择图片后再输入主体名。
- 数据模型优先复用 `ReferenceAlbum.album_type`：
  - 如果已有 `subject` 或类似类型，沿用。
  - 如果没有，第二批单独规划 Prisma schema 迁移，不在基础 `@` 弹窗批次偷改数据库。

### 画布页合并

修改 `src/components/canvas/full/nodes.tsx`：

- 用 `src/lib/prompt/mention.ts` 替换本地 `updateMentionState()` 和 `insertMention()` 中的正则/替换逻辑。
- 保持现有已连线图片候选、键盘操作和空状态文案。
- 不在第一批强行把图集/历史图片入口塞进画布生成卡，避免破坏画布的“先连线再引用”模型。

## 执行任务拆解

- [x] Batch 16A：确认 `@` 交互 Spec 与验收口径。
  - 明确第一批只实现公共 mention、自动弹窗、当前图片/历史图片/图集图片真实绑定。
  - 明确主体创建、主体候选、`album_type=subject` 和主体管理全部放第二批。
  - 明确普通生成页必须输入 `@` 自动触发。
  - 明确不删除现有参考图按钮、历史图片弹窗、图集弹窗。
  - 明确画布页只抽共享 mention 逻辑，不扩大图集能力。

- [x] Batch 16B：抽共享 prompt mention 工具。
  - 新增 `src/lib/prompt/mention.ts`。
  - 覆盖检测、替换、解析 `@图片N`。
  - 把 `PromptChecker.checkPrompt()` 里的图片引用解析改为复用共享函数。
  - 用 `npx tsx -e` 或轻量测试文件验证边界：行首 `@`、空格后 `@`、中文后 `@`、替换 `@图`、不误伤邮箱。

- [x] Batch 16C：新增通用候选弹窗组件。
  - 新增 `src/components/PromptMentionPopover.tsx`。
  - 支持标题、创建主体行、当前图片候选、历史/图集来源动作、空状态、loading、禁用态。
  - 增加 `src/app/globals.css` 样式，尺寸稳定，移动端不溢出。
  - 使用 lucide `Plus`、`Image` 或现有图标，不拉伸图标。

- [x] Batch 16D：普通生成页 `PromptEditor` 自动触发。
  - 修改 `src/components/PromptEditor.tsx`。
  - 输入 `@` 自动打开弹窗。
  - 输入 `@图` / `@图片` 可过滤候选。
  - ArrowUp / ArrowDown / Enter / Tab / Escape 可用。
  - 主输入框和放大编辑框行为一致。
  - 保留现有 `@图片N` 按钮。

- [x] Batch 16E：`GenerationComposer` 候选与 workspace 绑定闭环。
  - 修改 `src/components/GenerationComposer.tsx`。
  - 当前参考图候选展示缩略图、`@图片N`、文件名、图集来源。
  - 历史图片和图集选择后，按 pending mention range 插入，不再只追加末尾。
  - `UploadedImagePicker` 加入后也能自动插入 `@图片N`。
  - 重复选择同一张图时复用已有 `@图片N`，不重复加入 workspace。
  - 达到 9 张上限时禁用新增候选，并给出明确提示。
  - 提交前仍用 `workspace.assets` 顺序生成 `referenceImageIds`。

- [x] Batch 16F：第一批收口验证。
  - 验证普通生成页当前图片、历史图片、图集图片三条链路。
  - 验证重复选择、9 张上限、pending mention range 替换。
  - 验证 payload `referenceImageIds` 顺序与 prompt `@图片N` 对齐。
  - 验证不执行付费真实生成，除非用户明确授权。

- [x] Batch 16G：画布页复用共享 mention 逻辑。
  - 修改 `src/components/canvas/full/nodes.tsx`。
  - 保持现有已连线图片候选。
  - 只替换检测和插入函数，避免改变画布连线模型。
  - 回归 `src/components/canvas/full/seedanceApi.ts` 的 prompt mention 引用逻辑。

- [x] Batch 16H：样式与易用性打磨。
  - 修改 `src/app/globals.css`。
  - 弹窗跟随输入区，层级高于输入面板但不遮挡主要操作条。
  - 候选图片保持正方形缩略图，不拉伸。
  - 文案保持短句：`可能@的内容`、`创建主体`、`上传或选择图片`。
  - 移动端宽度使用 `min(视口宽度 - 安全边距, 固定最大宽度)`。

- [ ] Batch 16I：第二批主体能力规划。
  - 先查 `ReferenceAlbum.album_type` 的现有取值和接口支持。
  - 如果可复用图集类型，新增“创建主体”入口并保存为主体图集。
  - 如果当前 schema 不支持主体类型且需要迁移，先停下单独规划 Prisma 变更，不在本批次偷改数据库。
  - 主体候选选中后必须加入真实图片并插入 `@图片N`，不能只插 `@主体名`。

- [x] Batch 16J：最终验证与闭环。
  - 静态检查和构建通过。
  - 浏览器验证 `/generate` 输入 `@` 自动弹窗。
  - 选择当前参考图后，prompt 原位置变成 `@图片1`。
  - 选择历史图片后，图片进入参考图条，prompt 原位置变成对应 `@图片N`。
  - 选择图集多图后，prompt 插入多个 `@图片N`，顺序与参考图条一致。
  - 达到 9 张时不能新增，并显示限制。
  - `/generate/canvas` 原有 `@` 功能不回退。

## 验收标准

第一批必须通过：

- [ ] `/generate` 输入框只要输入 `@` 就自动出现候选弹窗。
- [ ] 弹窗标题显示“可能@的内容”。
- [ ] 弹窗第一项是“+ 创建主体”，但第一批不要求完成主体库、主体管理和数据库迁移。
- [ ] 当前参考图候选带缩略图，不把文字盖在图片上。
- [ ] 点击或键盘选中当前参考图，会替换当前 `@query`，不是 append 到末尾。
- [ ] 历史图片选择后，会自动加入参考图条并插入正确 `@图片N`。
- [ ] 图集图片选择后，会自动加入参考图条并插入正确 `@图片N`。
- [ ] 重复选择同一张图，不重复加入 workspace，复用原 `@图片N`。
- [ ] `PromptChecker` 对插入后的 `@图片N` 显示引用正常。
- [ ] 提交 payload 的 `referenceImageIds` 顺序与参考图条一致。
- [ ] 达到 9 张上限时，新增候选禁用且文案明确。
- [ ] 放大编辑框也支持输入 `@` 弹窗。
- [ ] Escape 能关闭弹窗，不清空用户输入。
- [ ] 方向键、Enter、Tab 可用。
- [ ] `/generate/canvas` 已有 `@` 弹窗仍可用。
- [ ] 桌面和 390px 移动端无横向溢出。

第二批再验收：

- [ ] `+ 创建主体` 能创建主体图集或主体记录。
- [ ] `@` 弹窗展示已有主体，如 `export (1)`。
- [ ] 选择主体后，把主体图片加入 workspace，并插入真实 `@图片N`。
- [ ] 主体管理权限、共享、删除和重命名有明确规则。

## 验证计划

静态验证：

```bash
git diff --check
npx tsc --noEmit --pretty false
npm run lint
npm run build
npx impeccable detect src/components/PromptEditor.tsx
npx impeccable detect src/components/PromptMentionPopover.tsx
npx impeccable detect src/components/GenerationComposer.tsx
```

共享 mention 工具验证：

```bash
npx tsx -e "import { detectMentionAtCursor, replaceMentionAtCursor } from './src/lib/prompt/mention'; console.log(detectMentionAtCursor('abc @图', 6)); console.log(replaceMentionAtCursor('abc @图 后文', 6, '@图片1'))"
```

浏览器验证：

```text
1. 打开 /generate。
2. 上传或从历史图片加入一张参考图。
3. 在 prompt 中间输入 @，确认自动弹窗出现。
4. 选择 @图片1，确认替换发生在光标位置。
5. 删除 prompt 中的 @图片1，再输入 @，选择历史图片入口，确认新图进入参考图条且 prompt 插入对应 @图片N。
6. 打开放大编辑框，重复 @ 选择。
7. 打开 /generate/canvas，连线图片卡和生成卡，输入 @，确认画布弹窗和键盘选择仍正常。
```

接口与数据验证：

```text
1. 创建普通生成任务前，在浏览器 Network 中确认 POST /api/tasks/create 的 referenceImageIds 顺序。
2. 确认 prompt 中 @图片1 对应 referenceImageIds[0]。
3. 历史图片加入 workspace 后，确认 /api/workspace/assets 返回 referenceImageIds，工作台刷新后可提交。
4. 不执行付费真实生成，除非用户明确授权。
```

## 风险与回滚

- 风险：主体功能需要 schema 支持。
  - 控制：第一批只预留或展示创建主体入口，不做主体 schema；如果需要 Prisma 迁移，第二批单独规划。
- 风险：异步加入历史图片后 workspace state 滞后，导致 `图片N` 计算错位。
  - 控制：选中前用当前资产顺序预计算，加入后刷新 workspace，并用去重规则避免重复插入。
- 风险：输入框失焦导致 selection range 丢失。
  - 控制：弹窗点击使用 pointer down 阻止默认失焦，并缓存 pending mention range。
- 风险：画布页逻辑被普通页改动影响。
  - 控制：共享工具只抽无状态解析/替换，画布候选来源和连线模型保持原样。
- 风险：`@主体名` 与 provider 实际绑定不一致。
  - 控制：第一批不提交 `@主体名` 给 provider，只插入可绑定的 `@图片N`。
- 回滚：
  - 隐藏自动弹窗入口，保留原有 `@图片N` 按钮。
  - 回退 `PromptEditor` 到按钮插入。
  - 画布页若受影响，可临时恢复本地 `updateMentionState()` / `insertMention()`。

## Git Plan

- 当前分支：`codex/minimal-feedback-loop`。
- 当前状态：规划前分支领先远端 2 个本地提交，工作区需在实现前再次确认。
- 本轮对齐规划只修改 `tasks/todo.md`。
- 第一批实现预计文件：
  - 新增 `src/lib/prompt/mention.ts`
  - 新增 `src/components/PromptMentionPopover.tsx`
  - 修改 `src/components/PromptEditor.tsx`
  - 修改 `src/components/GenerationComposer.tsx`
  - 修改 `src/components/PromptChecker.tsx`
  - 修改 `src/components/UploadedImagePicker.tsx`
  - 修改 `src/components/ReferenceAlbumPicker.tsx`
  - 修改 `src/components/canvas/full/nodes.tsx`
  - 修改 `src/app/globals.css`
  - 必要时修改 `tasks/lessons.md`
- 第二批主体能力预计另行规划，可能涉及：
  - `prisma/schema.prisma`
  - `src/app/api/reference-albums/*`
  - `src/lib/reference-albums/*`
  - 主体管理相关组件
- 提交分组建议：
  - 提交 1：共享 mention 工具和 PromptChecker 复用。
  - 提交 2：普通生成页自动弹窗和候选 UI。
  - 提交 3：历史图片/图集图片加入 workspace 并替换 pending mention。
  - 提交 4：画布页复用和验证修正。
  - 主体能力单独开第二批提交，不混入第一批。
- 完成实现和验证后，做聚焦提交；如果 GitHub 网络仍失败，保留本地 commit 并明确报告。

## HARD-GATE

- 当前只完成规划对齐，不编码。
- 第一批进入实现前需要用户明确确认“开干 / 落地 / 执行”。
- 第一批执行范围：公共 `@ mention`、普通生成页自动弹窗、当前图片/历史图片/图集图片真实绑定、画布页不退化。
- 主体创建和主体库是第二批；如果执行中发现必须改 Prisma schema，立即停止并单独规划数据库变更。

## Review - 2026-06-13

- 已实现第一批：新增公共 `src/lib/prompt/mention.ts`，统一检测 `@query`、替换当前 mention range、解析 `@图片N`。
- 已实现第一批：`src/components/PromptChecker.tsx` 复用共享 `parseImageMentions()`，避免图片引用正则分叉。
- 已实现第一批：新增 `src/components/PromptMentionPopover.tsx`，支持“可能@的内容”、`+ 创建主体`、当前图片候选、历史/图集来源动作、loading、空状态、鼠标选择和高亮态。
- 已实现第一批：`src/components/PromptEditor.tsx` 主输入框和放大编辑框输入 `@` 自动弹窗，支持过滤、Escape、方向键、Enter/Tab；修复快速 `ArrowDown` 后立刻 `Enter` 时 activeIndex 滞后的快捷键问题。
- 已实现第一批：`src/components/GenerationComposer.tsx` 提供当前 workspace 图片候选；历史图片/图集来源选择后先加入或复用 workspace，再把真实 `@图片N` 插回 pending mention range；重复选择已在 workspace 的图复用原序号。
- 已实现第一批：`src/components/canvas/full/nodes.tsx` 复用公共 mention 检测/替换，保持画布候选来源仍为已连线图片。
- 已实现第一批：`src/app/globals.css` 增加弹窗样式，缩略图固定正方形，不遮盖图片，不产生移动端横向溢出。
- 未实现第二批：主体创建、已有主体候选、`album_type=subject`、主体管理和 Prisma schema 变更仍保留为 Batch 16I。
- 已验证：`git diff --check`、共享 mention 工具 smoke、`npx tsc --noEmit --pretty false`、`npm run lint`、`npm run build`、`npx impeccable detect src/components/PromptEditor.tsx`、`npx impeccable detect src/components/PromptMentionPopover.tsx`、`npx impeccable detect src/components/GenerationComposer.tsx` 通过。
- 已验证：本地 3100 dev server 覆盖开发 session secret 后，`/generate` 输入 `@` 自动弹窗；第一项为“创建主体”；当前 5 张素材显示缩略图候选；键盘选择插入 `@图片1` 到原光标位置；图集来源选择已在工作台图片后插入 `@图片1`；历史图片入口可打开；放大编辑框支持 `@`；390px 移动端无横向溢出。
- 已验证：`/generate/canvas` 新建生成卡后输入 `@` 仍显示原有“先把图片卡连到这张生成卡，才能 @ 选择。”空状态，画布 prompt 编辑未退化。
- 未执行：未做真实付费生成；未为了验收新增历史图片到 workspace；未读取 `.env`。

---

# V1.2 P0 视频卡闭环总控 Todo

更新时间：2026-06-13

目标：按 `/Volumes/Data/Downloads/Current/AI视频生成项目成本管理系统需求文档_完整细项版V1.2.md` 第 44、45、47 节，先落地第一批 P0：项目下不再直接平铺生成结果，所有新生成必须归属到视频卡，项目页以视频卡为主视图，视频卡详情可管理该卡下的生成记录、再抽一次和成本聚合。

## 当前总控判断

- 第一批执行范围只覆盖 P0 视频卡闭环，不把飞书同步、方向分支、完整审批中心、复盘知识库和复杂预算预测混进本批。
- 当前代码已有 `Project`、`ProjectMember`、`VideoTask.project_id`、个人点数冻结/结算、官方成本账本和项目详情页基础能力。
- 当前代码缺少 `VideoCard`、`VideoTask.video_card_id`、视频卡 API、视频卡详情页、生成页视频卡选择和历史任务兜底归档。
- 用户已明确授权总控 Agent 自动拆包、派发子 Agent、合并结果并最终验证，本轮不再等待逐条派任务。

## 子 Agent 分工

- [x] 后端数据/API 调研：Agent `019ebf42-f9fd-7d02-b57c-c58b487656c9`，负责 schema、权限、API、账本统计建议。
- [x] 项目页/视频卡页 UI 调研：Agent `019ebf43-2447-7631-aa1b-1232dbb11def`，负责项目详情页、视频卡详情页和 UI 状态建议。
- [x] 生成页/再抽一次链路调研：Agent `019ebf43-4ee0-7c62-8c92-1f6894646795`，负责生成提交字段、URL query、最近任务和复用链路建议。
- [x] 迁移/验证/上线闭环调研：Agent `019ebf43-7cfa-7781-8ffc-7cc1c2f93200`，负责 SQLite 备份、Prisma Client、构建和 sd2 线上验证顺序。

## 任务包与依赖

- [x] Batch 0：总控调研与计划落地
  - 读取需求文档第 44、45、47 节。
  - 检查 `git status` 并创建隔离分支 `codex/video-card-p0-closure`。
  - 派发 4 个并行只读调研子 Agent。
  - 追加本总控计划到 `tasks/todo.md`。
- [x] Batch 1：数据结构与权限 helper
  - 修改 `prisma/schema.prisma`：新增 `VideoCard`，给 `VideoTask` 增加 `video_card_id`、版本角色字段和关系。
  - 新增或扩展视频卡权限 helper，复用项目权限，不允许跨项目绑定。
  - 新增视频卡聚合 helper，统一任务数、成功数、失败数、点数和官方成本统计。
- [x] Batch 2：视频卡 API
  - 新增 `GET/POST /api/projects/[id]/video-cards`。
  - 新增 `GET/PATCH /api/video-cards/[id]`。
  - 新增 `GET /api/video-cards/[id]/tasks`。
  - API 返回视频卡聚合、当前最佳和最终版摘要。
- [x] Batch 3：历史数据兜底归档
  - 编写可重复执行的 backfill 脚本，为已有项目任务创建兜底视频卡并绑定 `video_card_id`。
  - 默认先 dry-run，再在本地备份 SQLite 后执行。
  - 保持 `project_id`、`CreditLedger`、`CostLedger` 原始账务不变。
- [x] Batch 4：项目详情页改造
  - `src/app/api/projects/[id]/route.ts` 返回视频卡列表和聚合。
  - `src/app/projects/[id]/page.tsx` 默认展示视频卡列表，原“生成任务”降级为二级调试区。
  - 新增“创建视频卡”和“在此卡生成”入口。
- [x] Batch 5：视频卡详情页 / 工作台
  - 新增 `/video-cards/[id]` 页面。
  - 展示视频卡基础信息、生成记录、当前最佳、最终版、成本摘要。
  - 提供“再抽一次”“标记候选”“标记当前最佳”“标记最终版”“封板”操作。
- [x] Batch 6：生成页绑定视频卡
  - `src/app/generate/page.tsx` 在选择项目后必须选择视频卡；项目没有视频卡时允许快速创建。
  - 支持 `?project_id=` 和 `?video_card_id=` 进入生成页。
  - `src/app/api/tasks/create/route.ts` 校验 `video_card_id` 属于当前项目并写入任务。
  - 最近任务、任务详情和列表接口返回视频卡归属。
- [x] Batch 7：复用 / 再抽一次归属
  - `src/app/api/tasks/[id]/reuse/route.ts` 返回原任务 `video_card_id`。
  - 从视频卡详情页或最近任务复用时默认归入当前视频卡。
  - 封板视频卡默认阻止继续生成。
- [x] Batch 8：验证、提交、上线闭环
  - 本地验证：Prisma Client、类型检查、lint、build、关键 API smoke。
  - 数据验证：历史任务均有 `video_card_id`，新生成接口无卡拒绝，有卡通过到创建前校验阶段。
  - Git：聚焦提交、推送分支、创建 rollback tag、验证远端可见。
  - 线上：执行 `youdoo-sites build sd2`、`youdoo-sites restart sd2`、`youdoo-sites status sd2`，并公网验证页面/API/静态资源。

## 文件冲突控制

- `prisma/schema.prisma` 只由主线程修改，避免 schema 冲突。
- `src/app/api/tasks/create/route.ts` 和 `src/app/generate/page.tsx` 涉及真实付费生成链路，主线程合并子 Agent 建议后集中修改。
- 项目页和视频卡详情页可在 schema/API 稳定后再并行或连续修改。
- 迁移脚本不直接改生产数据；先 dry-run 和备份，再执行本地/线上所需步骤。

## 停止条件

- 不自动跑真实付费生成任务，除非用户后续明确授权。
- 如果 Prisma 迁移或 backfill 发现无法无损处理历史数据，停止并先输出数据风险。
- 如果构建、类型检查或关键 API smoke 失败，不提交、不推送、不上线。
- 如果线上 `sd2` build/restart/status 或公网验证失败，不汇报完成，先修复或明确阻塞。

## Git Plan

- 当前开发分支：`codex/video-card-p0-closure`。
- base：`codex/minimal-feedback-loop` 当前远端同步状态。
- 提交分组建议：
  - 提交 1：schema、权限 helper、聚合 helper、backfill 脚本。
  - 提交 2：视频卡 API。
  - 提交 3：项目页和视频卡详情页。
  - 提交 4：生成页绑定、任务创建校验、复用链路。
  - 提交 5：验证修复、经验记录和版本登记。
- 稳定回退点：完成验证后创建 `rollback/2026-06-13-video-card-p0` 并推送。

## Review - 2026-06-13 本地实现与验证

- 已实现 Batch 1：新增 `VideoCard` schema、`VideoTask.video_card_id`、版本角色字段、迁移 SQL、视频卡权限 helper 和视频卡聚合 helper。
- 已实现 Batch 2：新增项目视频卡列表/创建 API、视频卡详情/PATCH API、视频卡任务列表 API。
- 已实现 Batch 3：新增 `scripts/backfill-video-cards.ts`，默认 dry-run；本地 SQLite 已先备份到 `/Volumes/Data/Backups/video-api-debugger/dev-before-video-cards-20260613-130750.db`，再执行迁移和 `--apply`。
- 已验证 Batch 3：本地创建 22 张兜底视频卡，迁移 124 个历史任务；`missing_card=0`、`cross_project=0`，`CreditLedger` 和 `CostLedger` 计数/汇总保持不变。
- 已实现 Batch 4：项目详情 API 返回 `video_cards` 聚合；项目详情页主视图展示视频卡，原生成任务表降级为“历史 / 调试任务”。
- 已实现 Batch 5：新增 `/video-cards/[id]` 工作台，展示基础信息、成本摘要、生成记录，并支持标记当前最佳、最终版和封板。
- 已实现 Batch 6：标准生成页支持选择/快速创建视频卡；提交 `/api/tasks/create` 必须校验并写入 `video_card_id`；最近任务显示视频卡归属。
- 已实现 Batch 6 补充：画布生成页也加载并传递 `video_card_id`，无视频卡时不发起正式生成。
- 已实现 Batch 7：复用接口返回原任务 `video_card_id`；任务详情复用链接带 `project_id/video_card_id`；失败重试继承原视频卡，历史未归档任务会被明确拒绝。
- 已验证：`npx prisma validate` 通过；`npm run db:generate` 通过；`npx tsc --noEmit --pretty false` 通过；`npm run lint` 通过，剩余为既有 `<img>` 和 hook warning；`npm run build` 通过，并生成 `/video-cards/[id]` 与新增 API routes。
- 已完成 Batch 8：形成代码提交 `0960217 feat: 落地视频卡归属闭环`，推送分支 `codex/video-card-p0-closure`，创建并推送 rollback tag `rollback/2026-06-13-video-card-p0`；rollback tag 指向代码提交 `09602174d2daa7fd235e01707fbcd5e1018a652a`，远端分支 head 为收尾记录提交 `2d1643f3a8d0022790d5bc321388185eba0f2b97`。
- 已完成线上闭环：执行 `youdoo-sites build sd2` 生成 `.next-prod/BUILD_ID=MsQxqmA1MWOaeLuRk2VVy`，执行 `youdoo-sites restart sd2` 后 `youdoo-sites status sd2` 显示本地和公网健康检查正常。
- 已完成公网验证：`https://sd2.youdoodesign.com/api/health` 返回 200，`/video-cards/test-nonexistent` 返回 200 页面，`/api/video-cards/test-nonexistent` 返回 401 鉴权响应而非 500，`/_next/static/MsQxqmA1MWOaeLuRk2VVy/_buildManifest.js` 返回 200。
- 已登记版本：`/Volumes/Data/Projects/project-version-registry.md` 新增 `v0.4.0：视频卡归属闭环版`，记录分支、提交、rollback tag、部署目标、验证结果和数据库备份路径。
- 未执行：未跑真实付费生成任务。

## Review - 2026-06-14 资产管理页第一版落地

- [x] 新增 `/assets` 资产管理页，支持“生产历史 / 按项目 / 按用户查看”三类视图；“按用户查看”仅管理员可见。
- [x] 页面支持视频、图片、参考素材类型筛选，支持状态、项目、用户、时间/项目/用户分组和最近生成、最近完成、项目、用户、时长排序。
- [x] 内容展示采用缩略图优先的深色资产网格，按时间默认分组，视频卡片显示时长、项目、创建时间和管理员用户信息。
- [x] 新增多选能力：复选框单点、已进入选择态后的单点多选、Shift 范围选择、移动端长按选择、鼠标拖拽框选。
- [x] 新增批量动作：已完成视频可复用既有 ZIP 批量下载能力；视频任务可批量移动到目标项目和目标视频卡。
- [x] 新增 `GET /api/assets/library`，统一返回视频任务、上传素材和参考素材的资产列表，复用现有任务可见权限和管理员范围。
- [x] 新增 `POST /api/assets/library/bulk-move`，复用现有项目移动权限语义，非管理员必须具备源/目标项目管理权限；移动视频任务必须指定目标视频卡。
- [x] 导航已接入：侧边栏和顶部栏新增“资产管理”；旧 `/videos` 改为跳转 `/assets?type=video`。
- [x] 线上目录已确认：当前 `sd2` 服务实际指向 `/Volumes/Data/Projects/video-api-debugger-v12-full-todo`，本次最终代码已落在该目录并构建上线。
- [x] 验证通过：`./node_modules/.bin/tsc --noEmit`、`git diff --check`、`npm run lint`、`youdoo-sites build sd2`、`youdoo-sites restart sd2`。
- [x] 公网验证通过：`https://sd2.youdoodesign.com/assets` 返回 200，资产页 bundle 返回 200，浏览器登录态加载出 61 张资产卡片，管理员“按用户查看”可见，单点选择和拖拽框选后批量栏可见，console 无前端错误。
- [x] 后续增强：把图片/参考素材批量加入生成工作区或参考图集；当前批量移动继续保留视频任务移动到项目/视频卡，图片动作不删除原资产。

## Review - 2026-06-14 模板设置交互与模块用途重构

- [x] 模板设置面板已从靠右窄抽屉调整为居中大面板，桌面宽度为全画幅约 2/3，移动端仍保持全屏可用。
- [x] 模板模块结构新增 `module_usage`，支持把角色、标志、风格、镜头分别标记为“强制插入”或“仅参考”；旧模板默认按“强制插入”兼容。
- [x] Agent Prompt 组装已区分“强制插入模块”和“参考模块”：强制项明确要求进入最终画面描述，参考项只作为风格、构图或一致性参考。
- [x] 模板设置抽屉移除状态、素材类型、规则启停的下拉菜单，改为按钮式点击选择；模块绑定区也加入“强制插入 / 仅参考”按钮。
- [x] 模板生成工作台移除模板下拉菜单，改为可点击模板列表；模板生成页的视频卡选择移除下拉菜单，改为可点击卡片列表。
- [x] 模板、视频卡、快捷调节、模板编辑页签和模块用途设置已保存最后一次选择，下次进入自动恢复。
- [x] 前端模板相关英文显示已收敛为中文：`Logo` 改为“标志”，`Template Generate` 改为“模板生成”，规则类型改为“必须 / 禁止 / 建议”，素材类型改为“角色 / 标志 / 风格 / 其他”。
- [x] 补充中文化收口：`Prompt 预览` 改为“提示词预览”，`Temporal 策略` 改为“分段策略”；旧模板数据中的 `Logo` 在模板 API 序列化层统一显示为“标志”。
- [x] 验证通过：`npx tsc --noEmit --pretty false`、`git diff --check`、`npm run lint`、`npm run build`、`youdoo-sites build sd2`、`youdoo-sites restart sd2`、`youdoo-sites status sd2`。
- [x] 公网验证通过：`https://sd2.youdoodesign.com/template-generate` 页面 HTML 命中中文模板选择和视频卡选择结构；公网 CSS 命中 `template-selector-list`、`template-video-card-list`、`template-choice-row` 和 `width:66.666vw`；公网 JS 命中“强制插入”“仅参考”“模块用途”“分段策略”“提示词预览”，且未命中 `Prompt 预览`、`Temporal 策略`、`Logo 应`、`品牌 Logo`；最新 BUILD_ID 为 `nFjBGa98YRgWFd8iqdvPz`。
- [ ] 未执行：未跑真实付费视频生成；未修改 Prisma schema。

## Review - 2026-06-15 资产页图片批量动作补齐

- [x] 资产页选择图片或参考素材后，批量栏新增“加入工作区”和“加入图集”。
- [x] “加入工作区”复用现有 `/api/workspace/assets`，支持 `assetIds` 和 `referenceImageIds`，沿用同一浏览器会话的 `workspace_tab_id`。
- [x] “加入图集”复用现有 `/api/reference-albums/[id]/images`，只展示当前用户可编辑的图集，并用按钮列表点击选择目标图集。
- [x] 视频任务原有“移动视频”继续走目标项目 + 视频卡逻辑，未改变扣费、项目成本归属和视频卡规则。
- [x] 批量目标模式和最后选择的目标图集会写入本地 `localStorage`，下次进入资产页自动恢复。
- [x] 本地验证通过：`npx tsc --noEmit --pretty false`、`git diff --check`、`npm run lint`、`npm run build`。
- [x] 线上部署与公网验证通过：已临时隔离非本轮源码改动后执行 `youdoo-sites build sd2`、`youdoo-sites restart sd2`、`youdoo-sites status sd2`；公网 `/assets` 加载最终 chunk `page-b7626efc122ca236.js`，命中“加入工作区 / 加入图集 / 移动视频”，最终 BUILD_ID 为 `OV3wqHcgmo8pbghL_T-LB`，健康守护周期后 `runs` 保持 54。

## 2026-06-15 纠偏：LLM 入口归位到“新增模块 / 新增规则”

背景：已有 Module Builder / Template Config Agent 能力，但管理员自然操作点里找不到 LLM 生成入口。入口必须放回“新增模块”和“新增规则”，并且生成、预览、应用、保存、追溯都要闭环。

- [x] 模块页“模块绑定”区新增 `+ 新增模块（LLM）`，位置靠近 Character / Logo / Style / Camera / Rules / Asset Rule / Temporal / Prompt Format。
- [x] 每个模块行新增 `LLM 生成`，点击后自动带入对应模块类型。
- [x] `+ 新增模块（LLM）` 在当前区块展开 Module Builder 内联面板，不再依赖抽屉顶部入口。
- [x] 模块生成面板保留模块类型、模块用途输入、LLM生成规则设定、结构化预览、重新生成、应用到模板、保存模块、拒绝草稿、API 设置和生成链路。
- [x] 规则页顶部新增 `+ 新增规则（LLM）`。
- [x] 每个规则分组头部新增 `LLM 生成本类规则`，点击后自动带入对应规则类型。
- [x] 规则生成复用 Module Builder API 的 `module_type=rule`，UI 展示为 Rule Builder。
- [x] 应用规则草稿时只追加到当前规则列表，不自动保存模板。
- [x] 规则草稿保存为正式规则模块时，写入模块库、Memory 和 AgentRun。
- [x] 抽屉顶部 `LLM 配置模板` 保留为整套模板配置入口，不再承担“新增模块 / 新增规则”的主入口。
- [x] 入口文案统一为 `新增模块（LLM）`、`新增规则（LLM）`、`Module Builder`、`Rule Builder`。

闭环要求：

- [x] 模块闭环：输入需求 -> LLM 生成结构化草稿 -> 管理员预览 -> 应用到模板 -> 保存模块 -> 模块库 / Memory / AgentRun 可追溯。
- [x] 规则闭环：输入规则目标 -> LLM 生成规则草稿 -> 管理员预览 -> 应用到规则列表 -> 保存模板版本后生效。
- [x] 失败闭环：API 未配置、LLM 追问、校验失败、保存失败、权限不足，都在当前入口附近展示状态，并提供 API 设置或重试入口。
- [x] 回退闭环：拒绝草稿不污染模板；未保存关闭有提示；保存失败不清空草稿。
- [ ] 浏览器确认：点击保存模板版本后，模板列表 / 当前模板摘要能看到新增模块或新增规则变化。
- [ ] 权限确认：普通用户看不到这些管理员入口。

## Review - 2026-06-15 LLM 新增模块 / 新增规则入口归位上线

- [x] 模板编辑抽屉“模块”页已在模块绑定区加入 `+ 新增模块（LLM）`，每行模块旁加入 `LLM 生成`。
- [x] 模板编辑抽屉“规则”页已加入 `+ 新增规则（LLM）`，每个规则分组加入 `LLM 生成本类规则`。
- [x] Module Builder / Rule Builder 已接真实 `/api/templates/module-builder/*` 接口，支持生成、规则设定、保存模块、拒绝草稿、查看链路。
- [x] Template Config Agent 已接 `/api/templates/config-builder/*`，顶部保留为整套模板配置生成入口。
- [x] 管理导航已加入“模块库”，后台总览已加入模块库和执行链路入口；API 设置页保留 Musk API 地址 `https://api.muskapis.com/` 和默认模型 `gpt-5.4`。
- [x] 本地验证通过：`npx tsx scripts/template-builder-entrypoints-smoke.ts`、`npx tsx scripts/template-llm-contract-smoke.ts`、`npx tsc --noEmit --pretty false`、`git diff --check`、`npm run lint`、`npx impeccable detect src/components/templates/TemplateEditorDrawer.tsx`、`npm run build`。
- [x] 线上部署通过：`youdoo-sites build sd2` 生成 `BUILD_ID=ia_RbEzZ6Nkpl_LbV6hkh`，`youdoo-sites restart sd2` 后服务运行正常。
- [x] 公网验证通过：`/api/config`、`/api/health`、`/login`、`/templates` 返回 200；公网静态 chunk `6349-f96c1a130ed4d936.js` 命中 `新增模块（LLM）`、`新增规则（LLM）`、`LLM 生成本类规则`。
- [x] 健康守护周期后复查通过：`youdoo-sites status sd2` 为 OK，LaunchAgent `runs=64` 未增加。
- [ ] 未执行真实登录态浏览器操作：未实际点击保存模板版本验证列表摘要刷新；未切普通用户验证入口隐藏。

## 2026-06-15 图形生成 API 独立设置与 Gemini 图像模型接入

目标：

- 图形生成是给视频生成准备图片素材，不是视频任务本身。
- 文字 LLM 继续走 Musk API / `gpt-5.4`；文生图、图生图、首尾帧草图必须走独立图形生成配置。
- 图形生成 Provider 使用 Musk APIs 网关，不使用 `banana2` 作为 provider 或默认模型；默认模型使用 `gemini-3.1-flash-image-preview`。

2026-06-18 口径修正：

- 上面是 2026-06-15 当时的实现记录；无线画布正式版的产品/业务口径已改为“图片用后端 `banana2`”。
- 开始无线画布图片正式接入前，必须先确认 `banana2` 到当前 `image_generation_api_v1` 的映射关系：它是新的 provider、后台配置名称、模型别名，还是业务侧对图形生成能力的统称。
- 未确认映射前，不允许在无线画布静态前端直接写死 `banana2`、Gemini 模型或 Musk 网关地址；必须由后台配置统一下发。

已落地：

- [x] 新增 `src/lib/integrations/image-generation.ts`，使用独立配置键 `image_generation_api_v1`。
- [x] Provider 固定为 `musk`，默认地址为 `https://api.muskapis.com/`，默认模型为 `gemini-3.1-flash-image-preview`；旧 `banana2`、Google 直连地址和旧模型保存值读取时自动归一到 Musk APIs 默认配置。
- [x] 新增 `GET/PUT/POST /api/admin/integrations/image-generation`，仅管理员可读写。
- [x] 后台 API 设置页新增“图形生成 API”配置区，和 Musk API、Codex 视频接口并列。
- [x] API Key 只支持写入、留空不变和清除，不在页面或接口里回显明文。
- [x] 启用图形生成 API 前必须有 `base_url`、`default_model`、`api_key`。
- [x] 新增 `POST /api/assets/generate`，作为普通生成页和无线画布后续共用入口。
- [x] 图形生成入口校验登录态、项目、视频卡、画布和参考图权限。
- [x] 图形生成入口只读取后台配置，忽略前端伪造的 `api_key`、`base_url` 或 Provider endpoint。
- [x] 图形生成 API 未配置时返回 503；配置就绪后通过 Musk APIs 的 Gemini 兼容 `generateContent` 调用并解析 `inlineData` 图片。
- [x] Gemini 文生图 REST 请求体按官方最小 `contents[].parts[].text` 发送，不再传当前接口拒绝的 `generationConfig.responseModalities`。
- [x] 配置保存和生成尝试写入 `OperationLog`，不记录密钥。

待继续：

- [x] 对齐 Musk APIs 网关：`/v1/images/generations` 只支持 imagen 模型；当前 key 可用的 Gemini 图片模型应走 `/v1beta/models/{model}:generateContent`。
- [ ] 新增图形生成服务层，例如 `src/lib/assets/generation.ts`，集中处理 Provider 适配、下载、缩略图和资产落库。
- [ ] 多参考图 / 图生图需要把站内参考图转成 Gemini `inlineData` parts；当前文本到图像已先接通。
- [ ] 生成成功后写入 `Asset`，生成缩略图，并在需要时补齐 `ReferenceImage`。
- [ ] 无线画布调用时，把 `asset_id`、`reference_image_id`、`public_url`、`thumbnail_url`、`target_usage` 回写到节点。
- [ ] 前端提供“应用到当前节点 / 加入参考图 / 设为首帧 / 设为尾帧”确认动作，不自动覆盖用户已有素材。
- [ ] 如果图形生成收费，先设计价格策略、点数冻结/扣费/失败退款和后台流水；没有这套规则前不启用真实付费生成。
- [ ] 资产管理页能看到图形生成图片，并可追溯项目、视频卡、画布和节点。

验证结果：

- [x] `GET /api/admin/integrations/image-generation` 的返回 DTO 不包含 `api_key` 明文字段；公网未登录访问返回 401，不是 404/500。
- [x] 启用 Gemini 图形生成时缺少 `base_url`、`default_model` 或 `api_key` 的拒绝逻辑已在管理员接口中实现并通过类型/构建校验。
- [x] `POST /api/assets/generate` 公网未登录访问返回 401；路由只开放 POST，GET 返回 405，不是 404/500。
- [x] `POST /api/assets/generate` 源码路径只读取 `image_generation_api_v1`，不读取前端传入的 `api_key`、`base_url` 或 Provider endpoint。
- [x] 本地验证通过：`git diff --check`、`npx tsc --noEmit --pretty false`、`npm run lint`、`npm run build`、`npx impeccable detect src/app/admin/integrations/AdminIntegrationsClient.tsx`。
- [x] 线上部署通过：`youdoo-sites build sd2` 生成 `BUILD_ID=WDj7WsiqYleSuuYT2iKx3`，`youdoo-sites restart/status sd2` 正常。
- [x] 公网验证通过：`/api/config` 200、`/login` 200、`/api/admin/integrations/image-generation` 未登录 401、`/api/assets/generate` POST 未登录 401。2026-06-17 已纠偏为 Musk APIs，重新部署后应命中 `Musk APIs / Gemini Image / gemini-3.1-flash-image-preview`。
- [x] 健康守护周期后复查通过：`youdoo-sites status sd2` 仍 OK，LaunchAgent `runs=65` 未增长。
- [x] 2026-06-17 实测 Musk API 模型列表：当前后台 key 可用，`/v1/models` 返回 `gemini-3.1-flash-image-preview` 和 `gpt-image-2` 等模型。
- [x] 2026-06-17 实测 Musk API 图像接口：`/v1/images/generations` 使用 `gemini-3.1-flash-image-preview` 会返回 `not supported model for image generation, only imagen models are supported`；因此该模型必须走 Gemini 兼容 `generateContent`。
- [x] 2026-06-17 实测 Musk API Gemini 兼容链路：`/v1beta/models/gemini-3.1-flash-image-preview:generateContent` 可返回 `inlineData` 图片，`Authorization: Bearer`、`x-goog-api-key` 和 `?key=` 三种方式均可通。
- [x] 2026-06-17 重跑 `/api/assets/generate` 登录态真实生成成功：返回 `provider=musk`、`model=gemini-3.1-flash-image-preview`，生成 1 张 JPEG，已写入 `Asset`、`ReferenceImage`、`WorkspaceAsset`，并返回缩略图，图片尺寸 1408x768。
- [ ] 登录态下触发“Provider 未配置返回 503”和“伪造 api_key/base_url 被忽略”的接口测试待补；需要准备可用用户、项目和视频卡 fixture。

停止条件：

- 如果 Gemini 图生图、多参考图或计费策略没有确认，不扩展到真实付费多图生成。
- 如果要新增计费、任务表或资产生成记录表，先单独规划数据库变更和回滚。
- 如果生成图片不能进入 `Asset` / `ReferenceImage`，不能只把临时 URL 返回给前端。
- 如果真实生成会消耗费用，没有明确授权时只做非付费验证。

## 2026-06-15 导航重组与管理中心归纳设计规划

第一性目标：

- 降低找入口成本。用户进来应该能按任务自然找到入口，而不是在顶部和左侧两套重复菜单里判断。
- 保留高频快捷。顶部仍保留少量快捷入口，但只做快速跳转和状态承载，不再承担完整目录。
- 明确从属关系。左侧是一级目录，管理中心页是管理员二级目录，页面内部才是具体操作。
- 同时服务普通用户和管理员。管理员也是创作者，不能把管理员导航做成只剩后台；普通用户不能看到管理入口。
- 入口合并，不删除功能。能合并的管理页面先做导航归纳和管理中心卡片入口，旧页面功能、路由和可达链路必须保留。

导航命名原则：

- [x] 不使用“生产”作为前台分组名，改为更自然的“创作”。
- [x] 不使用“素材”作为一级分组名，参考图集和资产管理归入“项目”。
- [x] 管理入口不平铺十几个页面，统一收口到“管理中心”和少量归纳项。
- [x] 顶部快捷入口最多保留 5 个，避免再次变成第二套完整导航。

顶部快捷栏规划：

- [x] 保留顶部快捷入口：`生成`、`模板`、`项目`、`工具`。
- [x] 管理员额外显示 `管理中心`。
- [x] 顶部不再展示完整“资产管理 / 参考图集 / 我的任务”等细项。
- [x] 顶部点数从长文本压缩为短状态，例如 `可用 123`，详细信息进入账号或账户页。
- [x] 顶部右侧保留账号菜单；当前页主操作可按页面显示，例如 `新建生成`。

左侧普通用户导航规划：

- [x] 分组一：`创作`
  - [x] `生成视频` -> `/generate`
  - [x] `模板生成` -> `/template-generate`
  - [x] `动画模板` -> `/templates`
  - [x] `画布模式` -> `/generate/canvas`
- [x] 分组二：`项目`
  - [x] `我的项目` -> `/projects`
  - [x] `我的任务` -> `/tasks`
  - [x] `资产管理` -> `/assets`
  - [x] `参考图集` -> `/collections`
- [x] 分组三：`工具`
  - [x] `AI 抠图` -> `/cutout`
- [x] 普通用户不得看到任何管理中心入口。

管理员导航规划：

- [x] 管理员保留完整普通用户导航。
- [x] 管理员额外显示 `管理中心` 分组。
- [x] 管理中心分组只保留归纳后的入口：
  - [x] `管理中心` -> `/admin`
  - [x] `用户与项目` -> 管理用户、项目、权限、成员。
  - [x] `产出与反馈` -> 管理产出留存、反馈。
  - [x] `成本与接口` -> 管理计费成本、API 设置、Provider 状态。
  - [x] `模板与链路` -> 管理模板、模块库、执行链路。
- [ ] 管理员进入 `/admin/*` 时管理中心分组展开并高亮；进入普通创作页面时管理分组可以保持收起或低优先级。

管理页面合并规划：

- [x] `/admin` 改为“管理中心”首页，不只是普通后台总览。
- [x] 管理中心首页提供归纳卡片或分区：
  - [x] `用户与项目`：用户管理、项目管理、权限、成员。
  - [x] `产出与反馈`：产出留存、隐藏/恢复、任务追踪、反馈管理。
  - [x] `成本与接口`：计费成本、API 设置、Provider 配置。
  - [x] `模板与链路`：模板管理、模块库、Agent 执行链路。
- [x] 旧管理页面路由继续保留，不能删除现有功能。
- [x] 如果先不做真实页面合并，也要先从导航层面合并入口，并在管理中心页提供二级入口。

实现拆分：

- [x] `src/lib/navigation.ts`：把导航从扁平数组改为分组模型，支持顶部快捷、左侧普通导航、左侧管理员导航。
- [x] `src/components/ComposerTopbar.tsx`：顶部改为少量快捷入口 + 点数短状态 + 账号菜单。
- [x] `src/components/SideNav.tsx`：支持分组渲染、管理员分组和当前路径高亮；折叠策略暂不启用。
- [x] `src/components/AppShell.tsx`：当前无需改动，顶部快捷和左侧目录已从 `navigation.ts` 分层，避免重复维护两套目录。
- [x] `src/app/admin/page.tsx` 或现有 Admin Dashboard：改为管理中心首页结构，归纳管理入口。
- [x] `src/app/globals.css`：重做顶部和侧边栏的信息层级、间距、active/hover/focus 状态和移动端表现。

验收标准：

- [ ] 普通用户登录后只看到 `创作 / 项目 / 工具`，没有管理入口。
- [ ] 管理员登录后能看到普通工作台和管理中心，但管理入口不铺满左侧。
- [x] 顶部快捷入口不超过 5 个，并且不再和左侧完整重复。
- [x] 资产管理和参考图集在左侧归入 `项目`。
- [x] AI 抠图在左侧归入 `工具`。
- [x] 管理页入口减少，旧功能仍然可从管理中心二级入口到达。
- [x] `/admin/users`、`/admin/projects`、`/admin/outputs`、`/admin/feedback`、`/admin/costs`、`/admin/integrations`、`/admin/modules`、`/admin/agent-runs` 的原路由仍可访问。
- [ ] 桌面端左侧导航和顶部快捷栏不抢层级；移动端不横向溢出。
- [x] 线上 `sd2.youdoodesign.com` 已加载新导航构建；公网 layout chunk 命中 `管理中心 / 用户与项目 / 产出与反馈 / 成本与接口 / 模板与链路 / 资产管理 / 参考图集 / AI 抠图`。

本轮落地记录：

- 已完成：导航配置分层、顶部快捷栏收敛、左侧分组、管理中心入口归纳、管理中心首页分区卡片、相关样式整理。
- 已验证：`npx tsc --noEmit --pretty false`、`npm run lint`、`npm run build`、`git diff --check`、`npx impeccable detect ...` 均通过；lint 仍有项目既有 `<img>` 与 Hook 依赖警告。
- 部署状态：第一次候选构建让 Next 自动追加 `.next-prod-candidate/types/**/*.ts` 后缺少 `BUILD_ID`，保留该临时配置重跑后完成生产构建；已恢复 `tsconfig.json`。
- 线上健康：`youdoo-sites build sd2`、`youdoo-sites restart sd2` 已完成；`.next-prod/BUILD_ID=d02kA_j7kG-kJXP3VUOcY`；`http://127.0.0.1:3000/api/config`、`https://sd2.youdoodesign.com/api/config`、`https://sd2.youdoodesign.com/login` 均返回 200。
- 未闭环：登录态真实视觉验收、移动端视觉验收。

停止条件：

- [ ] 如果需要真正合并后台页面数据流，先单独规划每个合并页的 API、权限和回滚。
- [ ] 如果某个旧页面有未完成任务或线上依赖，不能直接删除入口，只能降级为二级入口。
- [ ] 如果普通用户和管理员权限判断不确定，先保守隐藏管理入口并验证 `/api/auth/me` 角色返回。
- [ ] 如果导航改动导致当前页面无法从任一路径到达，停止发布并恢复旧入口。

## 2026-06-17 自建通知与消息中心规划

第一性目标：

- 用户在任意工作台页面都能看到“有没有新通知”，不需要进后台或猜入口。
- “消息”第一版定义为系统通知中心，不做聊天、私信或客服会话，避免新建一套和 `Notification` 表重复的数据模型。
- 通知必须能读、能标记已读、能全部已读、能按关联对象跳转，失败通知能保留重试入口。
- 不接 Novu、Knock、SuprSend、Engagespot 这类外部通知平台；本项目已经有通知表和 API，优先把现有能力做可见。

现状证据：

- `prisma/schema.prisma` 的 `model Notification` 已有 `target_user_id`、`actor_user_id`、`project_id`、`video_card_id`、`approval_id`、`status`、`read_at`、`metadata_json` 等字段，能支撑站内通知。
- `src/app/api/notifications/route.ts` 的 `GET` 已能返回当前用户通知列表和 `unread_count`，`PATCH` 已支持 `mark_all_read`。
- `src/app/api/notifications/[id]/route.ts` 的 `GET` 已支持通知详情，`PATCH` 已支持 `mark_read` 和 `retry_failed`。
- `src/lib/notifications/index.ts` 的 `createInAppNotification` 和 `notifyProjectOwner` 已能写入站内通知。
- `src/components/AppShell.tsx` 当前只获取用户和点数，没有获取通知未读数。
- `src/components/ComposerTopbar.tsx` 当前右侧只有点数和账号，没有通知铃铛或消息入口。
- `src/lib/navigation.ts` 当前未把 `/notifications` 放进 shell 路由，新增页面后需要纳入应用壳层。
- `src/app/globals.css` 已有 `.composer-topbar-icon-btn` 和顶部导航样式，可复用，不需要引入 UI 大包。
- CodeGraph 在当前生产目录未初始化，本轮规划证据来自 `rg` 和定点文件读取；正式开发前不依赖未初始化索引。

实现任务：

- [x] 新增 `src/components/NotificationBell.tsx`：顶部通知铃铛，登录后调用 `GET /api/notifications?limit=8`，展示未读角标、加载态、空状态、错误态和最近通知下拉。
- [x] `NotificationBell` 支持点击外部关闭、`Escape` 关闭、键盘可达、移动端不溢出，交互状态跟现有顶部按钮保持一致。
- [x] `NotificationBell` 支持单条 `mark_read`，支持“全部已读”，操作成功后同步刷新未读数和列表状态。
- [x] 新增 `src/lib/notifications/display.ts`：集中把通知类型、关联项目、视频卡、审批记录和 `metadata_json` 转成前端展示文案、状态标签和跳转链接。
- [x] 新增 `src/app/notifications/page.tsx` 和 `src/app/notifications/NotificationsPageClient.tsx`：完整通知中心页面，包含全部、未读、失败三个视图。
- [x] 通知中心页面支持单条已读、全部已读、失败通知重试、打开关联项目或视频卡；未知类型只展示详情，不做错误跳转。
- [x] 更新 `src/components/ComposerTopbar.tsx`：在点数和账号之间接入 `NotificationBell`，未登录或用户加载中不请求通知。
- [x] 更新 `src/lib/navigation.ts`：把 `/notifications` 加入 `shellRoutes` 或前缀规则，保证通知中心页面使用现有顶部和左侧布局。
- [x] 更新 `src/app/globals.css`：补齐通知铃铛、角标、下拉列表、通知中心页面、移动端布局、focus/hover/disabled/loading 状态。
- [x] 必要时微调 `src/app/api/notifications/route.ts`：本轮无需改动，现有接口字段已满足前端使用，未改数据库 schema。
- [x] 不安装外部通知中心包；如果后续只需要轻提示，再单独评估 `sonner`，本轮先不改 `package.json`。

验收标准：

- [ ] 登录用户刷新任意 shell 页面，顶部能看到通知入口；未登录页面不发通知请求。
- [ ] 有未读通知时显示稳定角标；没有通知时显示明确空状态。
- [ ] 点击一条未读通知后，该条变为已读，未读数减少，并能跳转到关联项目、视频卡或通知详情。
- [ ] 点击“全部已读”后，未读角标清零，刷新页面后状态仍保持。
- [ ] `/notifications` 页面在桌面和移动端都不横向溢出，列表文字、按钮和角标不互相遮挡。
- [ ] 失败通知只在状态为 `failed` 时显示重试入口，避免误导普通通知。
- [x] 不新建 Message 表，不引入外部通知 SaaS，不泄露 `metadata_json` 中可能存在的敏感调试内容。

验证计划：

- [x] `git diff --check`
- [x] `npx tsc --noEmit --pretty false`
- [x] `npm run lint`
- [x] `npm run build`
- [x] `npx impeccable detect src/components/NotificationBell.tsx`
- [x] 本地未登录接口验证：`curl http://127.0.0.1:3000/api/notifications` 应返回 401。
- [ ] 登录态浏览器验证：通知铃铛、下拉、全部已读、通知中心页、移动端宽度。
- [x] 线上闭环：`youdoo-sites build sd2`、`youdoo-sites restart sd2`、`youdoo-sites status sd2`，再从公网验证 `/notifications`、`/api/config`、`/login` 和相关静态资源已加载新构建。

Git Plan：

- 当前分支：`codex/v12-full-todo`，跟踪 `origin/codex/v12-full-todo`。
- 当前工作区已有大量非本轮改动；正式开发前先复查 `git status` 和目标文件 diff。
- 本轮只 stage 通知中心相关新增文件和必要 shared 文件的相关 hunk，不能把无关导航、模板、画布、后台改动混入提交。
- 若 `ComposerTopbar.tsx`、`navigation.ts`、`globals.css` 已有未提交改动和本轮改动难以拆分，优先手动分 hunk 暂存；无法安全拆分时停止汇报，不强行提交。
- 验证通过后创建聚焦提交并推送到远端；稳定发布点创建并推送 `rollback/2026-06-17-notifications-center`。
- 完成发布后按全局规则登记 `/Volumes/Data/Projects/project-version-registry.md`。

HARD-GATE：

- [x] 这是中等以上 UI 功能，按当前项目规则需要用户确认本计划后再开始编码。

Review - 2026-06-17 自建通知中心落地：

- [x] 已新增通知展示层、顶部通知铃铛、通知中心页面、通知中心样式，并接入 `/notifications` 应用壳层。
- [x] 已保留现有后端通知表和接口，不新增 Message 表，不引入外部通知 SaaS，不改 Prisma schema。
- [x] 本地验证通过：`git diff --check`、`npx tsc --noEmit --pretty false`、`npm run lint`、`npm run build`、`npx impeccable detect src/components/NotificationBell.tsx`。
- [x] 线上部署通过：`youdoo-sites build sd2` 生成 `.next-prod/BUILD_ID=8fEB-vvAjFr2i-lek4OOk`，`youdoo-sites restart sd2` 后 `youdoo-sites status sd2` 正常。
- [x] 公网验证通过：`/api/config` 200、`/login` 200、`/api/notifications` 未登录 401、`/notifications` 未登录 307 到 `/login`；公网通知页面 chunk 命中 `/api/notifications / 全部已读 / notifications-row`，公网 CSS 命中 `notification-bell / notification-dropdown / notifications-page`。
- [ ] 未执行真实登录态点击验收：当前未拿到可复用登录会话，ClickOps CLI session 不能跨进程复用，项目也未安装 Playwright；不能把未登录态验证冒充为登录态验收。

## 2026-06-17 无线画布功能缺口应对方式与落地任务规划

来源文档：`tasks/ultimate-canvas-feature-gap-audit.md`

问题定义：

- 新无线画布当前是“可交互前端工具 Demo”，不是已经完整接入 sd2 后台体系的正式生成工具。
- 用户的真实目标不是多一个静态工具页面，而是让无线画布成为现有后台体系里的一个新生成工具入口。
- 所以应对方式不能只补 UI，也不能只接一个生成接口；必须把项目、保存、生成、点数、素材、历史、下载、反馈这些链路串起来。
- 正确顺序是先保证“不会误导用户”，再保证“能真实生成”，最后补“长期创作体验”。

### 2026-06-18 正式版口径补充：不做预览版

用户最新确认：

- 无线画布要做正式版，不是预览版。
- 图片生成走后端 `banana2` 图形生成能力。
- 文字 / 脚本 / 文案改写走 `gpt5.4`。
- 视频生成走普通生成页面同一套默认视频 API，不另起视频后端。
- 点数、项目、视频卡、任务、资产、历史、下载、截图都必须复用现有后台体系。

闭环判断：

- 当前规划方向基本齐全，但还没有闭环到“正式版可上线”。
- 最大缺口不是 UI，而是三条生成链路和现有后台体系还没有全部打通。
- 只要 image/video 仍可能返回 mock，或任务没有项目/视频卡/点数/资产归属，就不能叫正式版。
- 只要视频成功后不能自动保存本地并生成截图，就不能叫结果闭环。
- 只要画布刷新会丢节点、连线、任务和资产引用，就不能叫创作闭环。

正式版能力边界：

- 文本正式链路：画布文本节点、脚本节点、提示词改写统一调用后台 `gpt5.4` 配置；前端不得写死 key、base_url 或模型，只从后台配置读取。
- 图片正式链路：画布图片节点、图生图、高清修复、首尾帧草图统一调用后端 `banana2` 图形生成能力；如果底层实现实际通过 Musk/Gemini 网关转发，也必须在后台配置层统一抽象为图形生成能力，画布侧只认后台给出的 endpoint 和能力开关。
- 视频正式链路：文生视频、图生视频、首尾帧视频统一复用 `/api/tasks/create`，和普通生成页面一致，不能新建一套只给画布用的扣点/任务/Provider 流程。
- 状态正式链路：视频任务统一轮询 `/api/video/status/:taskId?refresh=true`，直到 `succeeded`、`failed` 或 `cancelled`，不能只看创建返回。
- 资产正式链路：生成图片、上传图片、生成视频、视频截图都必须进入资产/参考图/任务体系，不能只留浏览器 blob 或临时节点。
- 点数正式链路：生成前估价和余额校验；生成中冻结或预扣；成功实扣；失败释放；后台点数流水能看出来源 `ultimate_canvas`。

正式版 MVP 必做清单：

- [ ] 去掉 `/tools/ultimate-canvas` 的“预览版，不扣点”表达，改成正式工具状态；未接通能力先禁用，不得伪装可用。
- [ ] `CanvasGenerationAPI` 无 endpoint 时不得返回 mock 成功；必须返回结构化错误或让按钮禁用。
- [ ] 外层页面给 iframe 注入项目、视频卡、用户、点数、后台模型配置和 endpoint。
- [ ] 文本/脚本节点接 `gpt5.4`，生成结果写回节点并记录 OperationLog。
- [ ] 图片节点接后端 `banana2`，成功后写回 `asset_id`、`reference_image_id`、`thumbnail_url`。
- [ ] 视频节点接普通生成页面默认视频 API，即 `/api/tasks/create`。
- [ ] 视频状态轮询接 `/api/video/status/:taskId?refresh=true`，成功后显示本地视频、截图、下载和任务详情。
- [ ] 本地上传先上传服务器并入库，不能把本地文件路径直接当生成参考。
- [ ] 画布文档保存/恢复节点、连线、提示词、参数、任务 ID、资产 ID、参考图 ID。
- [ ] 生成历史和素材面板读取真实任务/资产，不再显示假历史或只提示待接入。
- [x] 后台点数流水、项目页、视频卡详情、资产库都能查到无线画布产生的内容；2026-06-19 已补齐无线画布来源标签、点数流水来源筛选、素材库参考图自动补挂工作区和图片首尾帧草图模式。

特别注意：

- [ ] `banana2` 是正式版图片能力口径；实现时必须确认后台真实配置名称、provider、模型和 API 地址，不允许在静态前端硬编码。
- [ ] `gpt5.4` 是文字能力口径；如果后台 Musk API 未配置，所有 LLM 按钮要前置禁用并提示去 API 设置。
- [ ] 视频必须走普通生成页同一套 `/api/tasks/create`，不要再写 `/api/video/create` 这种不存在或不完整的旁路接口。
- [ ] 首尾帧生成必须先确保首帧/尾帧是 provider 可访问的公开 URL 或站内资产，不接受本地路径。
- [ ] 生成成功不等于闭环；必须等状态终态、本地视频保存成功、截图生成成功、资产/任务/流水可查。
- [ ] 付费真实生成必须得到明确授权；开发阶段先用非付费 mock/fixture 验证状态机。
- [ ] iframe 静态页面要注意登录保护、CSRF/同源请求、跨窗口消息校验，不能让全屏静态页绕过权限。
- [ ] 数据库迁移、点数扣减、Provider 调用属于高风险改动，必须单独提交、单独验证、可回滚。

### 2026-06-18 正式版总 Todo：目标对齐与执行拆解

总目标：

- 把无线画布从“可交互 Demo / 预览版”升级为 sd2 现有后台体系里的正式生成工具。
- 正式版不另起后台，不另起计费，不另起资产库，不另起任务状态体系。
- 三条生成链路必须明确：文字走 `gpt5.4`，图片走后端 `banana2`，视频走普通生成页默认视频 API。
- 任何生成结果都必须能在项目、视频卡、资产库、任务记录、点数流水里追溯。

目标对齐表：

| 目标 | 必须做到 | 当前缺口 | 闭环标准 |
|---|---|---|---|
| 普通生成工具入口 | `/tools/ultimate-canvas` 和 `/generate` 共用项目、视频卡、点数、任务、资产 | 当前仍有预览状态和 mock 结果 | 画布生成后项目页、视频卡详情、后台流水都能查到 |
| 文字生成 | 文字、脚本、文案改写走后台 `gpt5.4` | 只有 text/script 已接，缺少统一配置状态和正式版验收 | 后台配置可测，前端未配置时禁用，成功写回节点并记日志 |
| 图片生成 | 图片节点走后端 `banana2` 能力 | `banana2` 和当前 `image_generation_api_v1` 映射未确认 | 成功返回 `asset_id/reference_image_id/thumbnail_url` 并进入资产库 |
| 视频生成 | 视频节点走 `/api/tasks/create` | 画布视频仍可能 mock，没有任务/轮询/点数闭环 | 返回真实 `task_id`，轮询到终态，保存本地视频和截图 |
| 点数结算 | 估价、余额校验、冻结/实扣/失败释放 | 画布没有正式估价和流水来源 | 后台点数流水能筛出 `ultimate_canvas` 来源 |
| 保存恢复 | 刷新不丢节点、连线、参数、任务、资产引用 | 当前画布状态主要在浏览器内存 | 退出再进能恢复完整画布和生成结果 |
| 素材历史 | 上传、历史任务、生成结果都进站内资产体系 | 上传只创建本地节点，历史面板未接真实任务 | 本地上传可作为首尾帧/图生视频参考，历史可拖回画布 |
| 线上闭环 | 本地实现、Git、线上构建、公网验证分开完成 | 当前只是文档规划 | `youdoo-sites build/restart/status` 和公网资源验证通过 |

#### Batch 0：正式版入口收口

目标：先消除“预览版但像正式功能”的误导。

- [x] 修改 `src/app/tools/ultimate-canvas/page.tsx`，去掉“预览版，不扣点”。
- [x] 页面状态改成正式工具文案；未完成能力用“未接入/不可用”状态，不展示成已可生成。
- [x] 修改 `public/tools/ultimate-canvas/generation-api.js`，无 endpoint 时返回结构化错误，不再 `mockGenerate` 成功。
- [x] 修改 `public/tools/ultimate-canvas/app.js`，image/video 未配置 endpoint 时禁用提交或显示明确错误。
- [x] 取消 mock/fixture 成功态：未接入正式链路时只提示阻断原因，不创建假结果、不展示“已提交”。
- [x] 验证：点击未接入能力不会创建假节点结果，不会显示“生成成功”。本地已通过 JS 语法检查、TypeScript 检查和生产构建；前端无 endpoint 已改为结构化错误，image/video 提交前被 readiness 拦截。

#### Batch 1：后台能力配置确认

目标：先确认三类模型能力，不在前端硬编码。

- [x] 在后台 API 设置里核对文字能力：`gpt5.4` 仍由 Musk API 配置承载，画布文字接口只读后台配置。
- [x] 在后台 API 设置里核对图片能力：当前正式图形能力由 `image_generation_api_v1` 承载，provider 为 `musk`，默认模型为 `gemini-3.1-flash-image-preview`，前端显示为 gmini 图形生成，不在静态前端写死密钥或网关地址。
- [x] 如果 `banana2` 只是业务别名，写清它和 `image_generation_api_v1` 当前实现的映射：业务侧可继续称图形生成能力，技术实现以后台配置返回的 provider/model 为准。
- [x] 在后台 API 设置里核对视频能力：普通生成页默认视频 API 仍走 `/api/tasks/create` 和 Seedance Provider 配置。
- [x] 新增或复用一个 capability/bootstrap 接口，返回 `text/image/video` 三组可用状态、模型名、endpoint、费用估算开关。
- [x] 验证：未登录 401；普通用户只能读必要状态；管理员能看到配置测试结果；接口不回显 API Key。本地生产服务验证 `/api/tools/ultimate-canvas/bootstrap` 未登录返回 401，接口响应设计只包含 enabled/model/endpoint/message/context，不包含 API Key/base_url。

### 2026-06-18 当前推进任务：从已上传检查点继续落地

执行基准：

- 当前生产源码目录必须使用 `/Volumes/Data/Projects/video-api-debugger-v12-full-todo`，不要误用旧目录 `/Volumes/Data/Projects/video-api-debugger`。
- 当前远端最新检查点为 `codex/v12-full-todo` 的 `ff5e429`，对应回退标签 `rollback/2026-06-18-sd2-codex-auto-deploy`；`e20a562` 只是未闭环扫描报告基准，对应回退标签 `rollback/2026-06-18-unclosed-feature-scan-updated`。
- 无线画布文本 / 脚本 LLM 已形成远端版本；下一步只处理图片、视频、归属、保存、点数和真实验收这些未闭环项。
- 每个批次完成后都要形成聚焦提交、推送远端、创建清晰 rollback tag，并登记 `/Volumes/Data/Projects/project-version-registry.md`。

上传原则落地：

- [x] 开始编码前执行 `git status --short --branch`，确认没有混入无关改动。
- [x] 只提交当前批次文件；如果出现跨任务脏文件，先拆分暂存或停止说明风险。
- [x] 任何用户可见页面改动都必须走 `youdoo-sites build sd2`、`youdoo-sites restart sd2` 和公网验证，不能只停在本地构建或 Git。
- [x] 真实付费生成、扣点、数据库迁移和 Provider 调用必须单独标记风险；没有明确授权时只做非付费状态机和接口权限验证。

第一推进批次：Batch 2 项目 / 视频卡 / 点数上下文注入

- [x] iframe 通过 `bootstrap` 读取当前用户、可用项目、默认项目、可用视频卡、账户点数和能力配置。
- [x] `bootstrap` 接口只输出 iframe 必要上下文，不回显 key、base_url、token 或其他敏感配置。
- [x] iframe 初始化后显示真实项目名、视频卡名、余额和可用能力状态。
- [x] 没有项目或视频卡时，图片 / 视频生成按钮禁用，并提示先选择归属。
- [x] 验证所有正式生成 payload 都带 `project_id` 和 `video_card_id`。

第二推进批次：Batch 4 图片真实生成链路

- [x] 确认 `banana2` 与当前后端图形生成能力的真实映射只能由后台配置下发，静态前端不写死 provider、模型或网关地址。
- [x] 画布图片节点统一调用 `/api/assets/generate`，不直接调用外部 provider。
- [x] 支持文生图、图生图、高清修复、首帧草图、尾帧草图的最小正式链路。
- [x] 成功后把 `asset_id`、`reference_image_id`、`workspace_asset_id`、`thumbnailUrl` 写回节点。
- [ ] 真实付费图片生成后的资产库、参考图和项目详情追溯验收待用户授权后执行。

第三推进批次：Batch 5 视频真实生成链路

- [x] 画布视频节点统一调用 `/api/tasks/create`，复用普通生成页同一套视频任务、价格和状态逻辑。
- [x] 文生视频、图生视频、首尾帧视频都创建真实任务请求并写入 `task_id`。
- [x] 前端轮询 `/api/video/status/:taskId?refresh=true` 直到终态。
- [x] 成功后节点展示视频预览、缩略图、下载入口、本地链接和任务详情入口。
- [x] 失败后展示错误原因、重试入口和复制错误信息；扣点/失败释放复用普通生成页逻辑。

第四推进批次：Batch 6 保存恢复

- [x] 明确复用旧 `CanvasDocument`，新增 Ultimate Canvas 文档 API，避免重复造表。
- [x] 保存 `nodes`、`connections`、`viewport`、`project_id`、`video_card_id`、资产引用和任务引用。
- [x] 节点新增、删除、移动、连线、提示词、参数变化后节流自动保存。
- [x] 页面显示保存状态：保存中、已保存、保存失败、可重试。
- [x] 代码路径支持刷新后文本节点、图片节点、视频任务节点及其关联结果恢复；真实登录态页面验收待后续人工或浏览器登录态执行。

第五推进批次：Batch 8 点数 / 成本 / 后台流水

- [x] 视频生成复用 `/api/tasks/create` 的冻结、实扣和失败释放，不另写画布扣点逻辑。
- [x] 图片和文字如需扣点，先明确价格表、失败退款规则和后台展示位置；未明确前只记录 OperationLog。
- [x] VideoTask、OperationLog、CreditLedger freeze 元数据记录来源 `ultimate_canvas`、`canvas_document_id` 和 `canvas_node_id`。
- [x] CostLedger 仍按任务成本维度记录，但后台成本页已能通过关联 `VideoTask.source_metadata_json/source_label` 直接筛选 `ultimate_canvas` 成本总账；不新增重复账本结构。

第六推进批次：本地化补偿和正式验收

- [x] 将 `scripts/finalize-pending-videos.ts` 纳入 Codex cron 自动化 `sd2-finalize-pending-videos`，避免服务重启后任务本地保存丢失。
- [x] 增加只读健康信息：待本地化任务数、最近失败原因和补偿命令。
- [x] 本地验证：`git diff --check`、`npx tsc --noEmit --pretty false`、`npm run lint`、`npm run build`。
- [ ] 登录态页面验证：`/tools/ultimate-canvas` 能看到项目注入、能力状态、文字、图片、视频状态机和保存恢复；本轮未读取 `.env` 或伪造 cookie，所以不做自动登录态验收。
- [x] 公网验证：`/api/config`、`/login`、`/tools/ultimate-canvas` 登录保护、新接口未登录 401、生产 BUILD_ID、跨健康守护周期。
- [ ] 若用户明确授权付费测试，再执行真实图片 / 视频生成，确认任务、资产、点数、项目、视频卡、后台流水全部可追溯。

停止条件：

- 如果当前源码目录和 `youdoo-sites` 注册的 sd2 来源不一致，停止编码并先校准来源。
- 如果项目 / 视频卡上下文拿不到，停止在真实生成前，不允许用假 ID 或隐藏默认值绕过。
- 如果 `banana2`、`gpt5.4` 或视频 provider 的后台配置不明确，不允许在静态前端硬编码。
- 如果验证失败，不提交、不推送、不部署，先修复或明确阻塞原因。

#### Batch 2：项目、视频卡、点数上下文注入

目标：画布进入现有项目体系，不再是独立孤岛。

- [x] iframe 通过 `src/app/api/tools/ultimate-canvas/bootstrap/route.ts` 读取当前用户、默认项目、可用项目、默认视频卡、账户点数。
- [x] 新增或复用 `src/app/api/tools/ultimate-canvas/bootstrap/route.ts`，输出 iframe 所需上下文。
- [x] iframe 初始化时接收 `user/project/videoCard/credits/settings/endpoints`。
- [x] 静态画布显示真实项目名、视频卡名、余额和可用模型。
- [x] 未选择项目或视频卡时禁用图片/视频生成，并提示先选择归属。
- [x] 验证：所有正式生成 payload 都带 `project_id` 和 `video_card_id`。

#### Batch 3：文字链路接 `gpt5.4`

目标：文本节点和脚本节点正式可用。

- [x] 复查 `src/app/api/tools/ultimate-canvas/generate/route.ts`，确认只负责 text/script，不处理 image/video。
- [x] 请求前检查后台 `gpt5.4` 配置状态；未配置返回明确错误。
- [x] 前端文字/脚本节点提交时带 `node_id`、`canvas_document_id`、`project_id`、`video_card_id`。
- [x] 成功后写回节点文本、标题、摘要、模型、耗时、状态。
- [x] 后端写 OperationLog，记录 `ultimate_canvas_llm_generate`，不记录密钥。
- [ ] 登录态真实 LLM 改写和刷新恢复验收待浏览器登录态执行。

#### Batch 4：图片链路接后端 `banana2`

目标：图片节点正式生成并进入资产体系。

- [x] 明确 `banana2` 在后台配置层由 `image_generation_api_v1` 能力配置下发，静态前端不写死。
- [x] 画布图片节点调用 `/api/assets/generate`，不直接调用外部 provider。
- [x] payload 带 `action`、`input.prompt`、`project_id`、`video_card_id`、`canvas_document_id`、`canvas_node_id`。
- [x] 支持文生图、图生图、高清修复、首帧草图、尾帧草图这些 action。
- [x] 成功后把返回的 `asset_id`、`reference_image_id`、`workspace_asset_id`、`thumbnailUrl` 写回节点。
- [x] 图片节点支持“作为参考图继续生成视频”，首/尾帧通过节点引用进入视频 payload。
- [ ] 真实付费图片生成后资产库、参考图、项目详情追溯验收待用户授权。

#### Batch 5：视频链路接普通生成 API

目标：视频节点正式创建 sd2 视频任务。

- [x] 画布视频节点统一调用 `/api/tasks/create`。
- [x] 文生视频传普通 prompt、ratio、duration、resolution、model 等参数。
- [x] 图生视频先把图片节点转换成 `reference_image_ids` 或 provider 可访问 URL。
- [x] 首尾帧视频必须使用可公开访问的首帧/尾帧资产，不接受本地路径或 blob URL。
- [x] 创建成功后节点保存 `task_id`、`provider_task_id`、`frozen_cost`、`status=submitted`。
- [x] 前端轮询 `/api/video/status/:taskId?refresh=true`，直到终态。
- [x] 成功后展示视频预览、缩略图、下载、本地链接、任务详情。
- [x] 失败后展示错误原因、复制错误信息，并复用普通生成页失败释放逻辑。
- [ ] 验证：至少跑通文生视频、图生视频、首尾帧状态机；真实付费生成需要用户单独授权。

#### Batch 6：画布文档保存恢复

目标：创作过程可持续，不因刷新丢失。

- [x] 设计画布文档数据结构：`nodes`、`connections`、`viewport`、`project_id`、`video_card_id`、`assets`、`tasks`。
- [x] 优先复用现有 `CanvasDocument` 模型；本轮不新增数据库模型。
- [x] 新增/恢复画布文档 API：创建、读取、更新。
- [x] 前端节点新增、删除、移动、连线、提示词、参数变化后节流自动保存。
- [x] 页面显示保存状态：保存中、已保存、保存失败、重试。
- [ ] 登录态刷新恢复真实页面验收待浏览器登录态执行。

#### Batch 7：素材库、上传、历史复用

目标：画布能复用站内资产，产出也回到站内资产。

- [x] 本地上传走服务器上传接口，创建 `Asset` 和必要的 `ReferenceImage`。
- [x] 上传完成后节点保存资产 ID、公开 URL、缩略图、文件名、mime type。
- [x] 素材面板读取真实资产库，支持点击拖入画布。
- [x] 历史面板读取项目任务和资产，支持点击拖入画布复用。
- [x] 生成成功的视频自动进入历史和资产视图。
- [x] 生成成功的图片自动进入图片资产和参考图体系。
- [ ] 上传图片 -> 首尾帧视频节点真实提交验收待登录态和付费测试授权。

#### Batch 8：点数、成本、后台流水

目标：无线画布和普通生成页面账本一致。

- [x] 复用普通生成页价格和估价逻辑，不单独维护画布价格表。
- [x] 生成前展示当前余额和项目归属；预计点数由 `/api/tasks/create` 返回冻结成本。
- [x] 余额不足或预算不足时复用 `/api/tasks/create` 的错误提示。
- [x] 视频生成复用 `/api/tasks/create` 的冻结、实扣、失败释放。
- [x] 图片和文字如果要扣点，先明确价格表和失败退款规则；未明确前只记录 OperationLog，不伪造扣点。
- [x] VideoTask、OperationLog、CreditLedger freeze 元数据记录 `source=ultimate_canvas`、`canvas_document_id`、`canvas_node_id`。
- [x] CostLedger 直接按 `ultimate_canvas` 筛选：`/admin/costs?source=ultimate_canvas` 通过关联任务来源过滤待处理队列和最近总账，并显示来源列。
- [ ] 一次无线画布视频真实生成后在后台点数流水追到同一个 task_id，待用户授权付费测试；2026-06-19 本轮按要求不做真实视频生成调试，只完成非付费接入层验证。

#### Batch 9：正式版验收和上线

目标：完成从代码到线上可见的闭环。

- [x] 本地验证：`git diff --check`。
- [x] 类型验证：`npx tsc --noEmit --pretty false`。
- [x] 构建验证：`npm run build`。
- [x] 如 lint 当前可用，执行 `npm run lint`；本轮通过，仅保留既有 warning。
- [ ] 登录态页面验证 `/tools/ultimate-canvas`：项目注入、能力状态、文字、图片、视频状态机、保存恢复。
- [x] 未登录接口验证：bootstrap、文字、图片、文档、上传、本地化健康接口均返回 401 或跳登录。
- [ ] 登录态验证：项目选择、视频卡归属、资产入库、点数流水、历史复用，待浏览器登录态和付费测试授权。
- [x] 线上部署：`youdoo-sites build sd2`、`youdoo-sites restart sd2`、`youdoo-sites status sd2`。
- [x] 公网验证：`/api/config`、`/login`、`/tools/ultimate-canvas` 登录保护、生产 BUILD_ID 和接口权限。
- [x] 跨健康守护周期复查 sd2 LaunchAgent `runs` 不增长。
- [ ] Git 提交、push、rollback tag、远端可见性复核、版本登记。

正式版 Definition of Done：

- [x] 用户能从无线画布提交文字、图片、视频三类正式后台请求；真实付费结果验收待授权。
- [x] 图片来自后端图形生成能力配置，文字来自 `gpt5.4`/Musk 配置，视频来自普通生成页默认视频 API。
- [x] 所有真实生成 payload 都带项目、视频卡、用户、节点来源。
- [x] 视频任务前端轮询到终态，成功后展示本地视频、截图、下载链接和任务详情入口。
- [ ] 所有生成结果在项目、视频卡、资产库、后台流水中的真实端到端追踪待付费生成授权后验收。
- [x] 画布刷新、退出、重新进入后按 `CanvasDocument` 保存恢复创作内容和结果引用。
- [x] 未接入或配置缺失的能力不会显示成已成功。
- [ ] 线上公网验证通过；远端 Git 回退点待本轮提交、push 和 tag 后补齐。

Review - 2026-06-18 无线画布全量落地：

- 本轮完成：无线画布项目/视频卡上下文、图片生成桥接、视频任务桥接、文档保存恢复、上传入库、素材/历史面板、视频状态轮询、本地化健康接口、视频任务来源追踪和 Codex cron 补偿自动化。
- 主要改动：`public/tools/ultimate-canvas/app.js`、`canvas-engine.js`、`index.html`、`styles.css`、`src/app/api/tools/ultimate-canvas/*`、`src/app/api/tasks/create/route.ts`。
- 验证通过：`node --check`、`git diff --check`、`npx tsc --noEmit --pretty false`、`npm run lint`、`npm run build`、`youdoo-sites build/restart/status sd2`。
- 线上结果：生产 BUILD_ID `Fhs5jsyrLsLgX3WQqy0sp`；公网 `/api/config` 200、`/login` 200、`/tools/ultimate-canvas` 未登录 307、新无线画布 API 未登录 401；跨健康守护周期后 `com.youdoo.site.sd2` 的 `runs=16` 未增长。
- 特别记录：Mac LaunchAgent 读取外置盘项目脚本会触发 `Operation not permitted`，已下线失败 plist，改用 Codex cron 自动化 `sd2-finalize-pending-videos` 每小时执行补偿。
- 未做：未读取 `.env`、未伪造 cookie、未执行真实付费图片/视频生成；登录态页面点击验收和付费端到端验收需用户授权后补。

纠偏补丁 - 2026-06-18：

- [x] 修正“全量落地只完成第一批”的执行偏差：批次只是内部顺序，不能替代全链路完成标准。
- [x] `bootstrap` 补真实账户点数摘要：`available`、`frozen_credits`、每日额度和长期点数，前端顶栏显示可用/冻结点数。
- [x] 画布生成请求统一带无线画布 workspace key：`ultimate-canvas:<project_id>:<video_card_id>`，避免上传、图片生成、视频参考图后续因 workspace 口径变化而断链。
- [x] 首尾帧视频后端补尾帧映射：未显式传 `last_frame_url` 时，自动使用第二张准备好的参考图作为尾帧。
- [x] 清理旧模型文案：默认节点文案改成 `gpt5.4`、`gmini 图形生成`、`默认视频 API`，避免加载前仍显示旧 Demo 模型。
- [x] “从生成历史选择”不再标待接入，点击打开真实生成历史面板并刷新数据。
- [ ] 仍需付费授权后做真实端到端验收：文字 LLM、图片生成、首尾帧视频、点数流水、资产库、项目页、视频卡详情逐项截图留证。

### 应对方式

#### 方案 A：先做正式工具 MVP，推荐

- 核心思路：保留现有无线画布前端，把它接进 sd2 现有后台体系，先跑通最小正式闭环。
- 覆盖范围：项目上下文、画布保存、真实视频生成、状态轮询、结果预览、点数扣减、资产入库。
- 优点：最快让无线画布从 Demo 变成正式工具；不会另起一套后台。
- 缺点：第一版先收敛功能，协作、分享、复杂导演台自动化暂不做深。
- 适合当前目标：符合“无线画布只是现有后台体系里的新工具入口”。

#### 方案 B：先做占位治理和体验补丁

- 核心思路：不接真实生成，先把所有无响应按钮隐藏、置灰、加说明，减少用户误点。
- 覆盖范围：协作、分享、通知、帮助、反馈、从历史选择、AI 识图、几何模型、全屏入口。
- 优点：风险低，短期能减少“点了没反应”的反馈。
- 缺点：工具仍然不能真实生成，不能解决本质目标。
- 适合场景：如果真实 API、点数、资产链路暂时排期不足，可以作为过渡。

#### 方案 C：先重写成 React 原生工具

- 核心思路：把 `public/tools/ultimate-canvas/*.js` 的静态工具迁移成 React/Next 组件。
- 覆盖范围：组件化、状态管理、权限、API hooks、测试和样式统一。
- 优点：长期维护性最好，能自然接入现有 app shell。
- 缺点：工作量最大，短期会拖慢真实生成闭环。
- 适合场景：等 MVP 证明确实要长期重投后再做，不建议第一阶段就重写。

#### 方案 D：把静态工具继续作为 iframe，但加桥接层

- 核心思路：保留 iframe 和静态 JS，通过 `postMessage` / bootstrap JSON 注入用户、项目、API endpoint、点数和资产能力。
- 优点：最小改动利用现有工具，能较快上线。
- 缺点：iframe 和主站状态同步复杂，类型安全、测试和错误处理更难。
- 推荐用法：作为 MVP 的第一步；后续稳定后再考虑 React 化。

推荐决策：

- 第一阶段采用“方案 A + 方案 D”：保留现有静态画布，用桥接层接入 sd2 后台，先完成正式工具 MVP。
- 第二阶段采用“方案 B”：把未实现的按钮治理干净，避免用户误解。
- 第三阶段再评估“方案 C”：如果无线画布使用频率高，再迁移成 React 原生工具。

### 分阶段任务

#### Phase 0：风险收口和入口治理

目标：先让用户不会被未实现功能误导。

- [x] 审查 `public/tools/ultimate-canvas/index.html` 的所有按钮，列出无事件或只改状态的入口。
- [x] 对协作、分享、通知、头像、帮助、反馈、从历史选择先做明确策略：隐藏、置灰、接真实功能三选一。
- [x] 对导演台里的 `AI 识图导入`、`几何模型`、`接入首尾帧视频` 加状态区分：真实可用、仅创建节点、暂未接入。
- [x] 检查 `/tools/ultimate-canvas/index.html` 全屏直达路径是否始终受登录保护；如果不能保证，改成受保护 route。
- [x] 验收：页面上没有“点击后完全无反馈”的按钮；未实现功能不会伪装成已完成。

Phase 0 落地记录：

- 入口策略：协作、分享、通知、头像、反馈、从生成历史选择、小地图先保留入口但标记为待接入，点击统一提示，不创建假数据。
- 帮助策略：帮助按钮先提供当前可用边界说明，不跳到未完成页面。
- 导演台策略：`AI 识图导入`、`几何模型` 明确显示待接入；`接入首尾帧视频` 只创建视频节点，并说明真实 `first_last_frame` 生成还没有提交到 sd2 后台。
- 生成策略：当前没有真实 endpoint 时，mock 结果显示为“生成占位”，不再伪装成接口已成功。
- 登录保护：`src/middleware.ts` 已覆盖 `/tools/:path*`，所以 `/tools/ultimate-canvas/index.html` 直达也会先过登录检查；本阶段不新增 route。
- 后续边界：Phase 0 没有接入保存、扣点、任务轮询、资产库和真实生成，这些继续进入 Phase 1 到 Phase 6。

涉及文件：

- `src/app/tools/ultimate-canvas/page.tsx`
- `public/tools/ultimate-canvas/index.html`
- `public/tools/ultimate-canvas/app.js`
- `public/tools/ultimate-canvas/styles.css`

#### Phase 1：启动上下文和项目归属

目标：无线画布进入现有项目体系，不再是孤立页面。

- [ ] 外层 `src/app/tools/ultimate-canvas/page.tsx` 读取当前用户、项目列表、默认项目、账户点数和可用生成配置。
- [ ] 设计 iframe bootstrap 数据结构：`user`、`project`、`videoCard`、`credits`、`settings`、`endpoints`。
- [ ] iframe 加载后用 `postMessage` 或同源 JSON 注入 bootstrap 数据。
- [ ] 静态画布接收 bootstrap 后显示真实项目名，不再只显示本地 `未命名`。
- [ ] 未选择项目时禁用真实生成按钮，并提示先选择项目。
- [ ] 验收：生成 payload 必须包含 `project_id`，可选包含 `video_card_id`。

涉及文件：

- `src/app/tools/ultimate-canvas/page.tsx`
- `public/tools/ultimate-canvas/app.js`
- `public/tools/ultimate-canvas/generation-api.js`
- 可能新增：`src/app/api/tools/ultimate-canvas/bootstrap/route.ts`

#### Phase 2：画布保存与恢复

目标：刷新不丢节点、连线、提示词和参数。

- [ ] 明确复用 `CanvasDocument` 还是新增无线画布专用文档模型；优先复用现有 `CanvasDocument`，避免新建重复表。
- [ ] 新增或恢复受保护的画布文档 API：创建、读取、更新、归档。
- [ ] 保存内容包含：`nodes`、`connections`、`viewport`、`project_id`、`video_card_id`、节点资产引用、节点任务引用。
- [ ] 前端实现自动保存：节点新增、删除、移动、连线、提示词、参数变化后节流保存。
- [ ] 页面显示保存状态：正在保存、已保存、保存失败、重试。
- [ ] 验收：刷新、退出再进入，画布内容完整恢复。

涉及文件：

- `prisma/schema.prisma`
- `src/app/api/canvases/*` 或新 `src/app/api/tools/ultimate-canvas/documents/*`
- `src/lib/canvas/*` 或新 `src/lib/ultimate-canvas/*`
- `public/tools/ultimate-canvas/app.js`
- `public/tools/ultimate-canvas/canvas-engine.js`

停止条件：

- 如果需要数据库迁移，先单独规划迁移和回滚。
- 如果旧画布 zip 中的代码要恢复，必须只恢复需要的 API/权限逻辑，不能把旧 `/generate/canvas` 页面重新暴露。

#### Phase 3：真实视频生成链路

目标：画布里点视频生成，必须创建真实 sd2 任务。

- [ ] 把 `generation-api.js` 的 mock 默认路径改成“无 endpoint 时明确提示未配置”，不能静默返回 mock 成功。
- [ ] 文生视频映射到普通生成页同一套 `/api/tasks/create`。
- [ ] 图生视频映射到 `/api/tasks/create` 并带参考图资产。
- [ ] 首尾帧映射到 `/api/tasks/create` 的 `first_last_frame` 模式。
- [ ] 节点进入任务状态：queued、running、succeeded、failed、cancelled。
- [ ] 轮询 `/api/video/status/:taskId?refresh=true`，直到终态。
- [ ] 成功后展示视频预览、缩略图、下载入口、任务详情入口。
- [ ] 失败后展示错误原因、重试入口、复制错误信息入口。
- [ ] 验收：非付费环境可用 mock endpoint 验证状态机；付费真实生成必须得到明确授权后再跑。

涉及文件：

- `public/tools/ultimate-canvas/generation-api.js`
- `public/tools/ultimate-canvas/app.js`
- `src/app/api/tasks/create/route.ts`
- `src/app/api/video/status/[id]/route.ts`
- `src/components/GenerationComposer.tsx` 可作为现有 payload 参考

#### Phase 4：图形生成和 banana2 后端接入

目标：图片节点能真实生成图片，并进入资产库。

- [ ] 文生图、图生图、高清修复先接现有 `/api/assets/generate`，由后端图形生成配置指向正式 `banana2` 能力。
- [ ] 后台确认 `banana2` 的 provider/model/base_url/api_key 配置项和测试入口；画布只读后台配置，不写死参数。
- [ ] 如果当前底层仍通过 Musk/Gemini 网关承载图片能力，必须在后台配置层做清晰命名和能力抽象，避免前端把 `banana2`、Gemini 模型和 Musk 文字 LLM 混在一起。
- [ ] 图片生成结果写入 `Asset`、`ReferenceImage`、工作区资产。
- [ ] 图片节点展示真实图片预览、下载、设为首帧、设为尾帧、作为参考图。
- [ ] 验收：图片节点生成结果能在资产管理和参考图集中查到。

涉及文件：

- `src/app/api/assets/generate/route.ts`
- `src/lib/integrations/image-generation/*`
- `src/app/admin/integrations/*`
- `public/tools/ultimate-canvas/app.js`
- `public/tools/ultimate-canvas/generation-api.js`

#### Phase 5：点数、估价和流水

目标：无线画布生成和普通生成共用点数体系。

- [ ] 节点参数变化时按模式、时长、清晰度、参考资源数量估价。
- [ ] 生成按钮旁展示预计点数和账户余额。
- [ ] 生成前校验余额，不足时禁用或引导充值/联系管理员。
- [ ] 创建任务时走现有冻结、扣减、失败退款逻辑。
- [ ] 点数流水里标明来源：`ultimate_canvas`、画布文档、节点 ID、项目、任务 ID。
- [x] 后台点数流水支持筛选并能看出无线画布来源：`/admin/points?source=ultimate_canvas` 接入后端筛选，表格和详情显示来源标签。
- [ ] 验收：一次无线画布真实生成后，管理页点数流水能查到对应记录；2026-06-19 不执行真实付费视频生成调试，保留为授权后付费验收项。

## Review - 2026-06-19 无线画布生成接入全量补齐

- 本轮目标：把“看起来能选/能生成但接入链路不完整”的无线画布剩余项一次性补齐；不做真实付费视频生成调试。
- [x] 视频创建接口识别 `client_name=ultimate_canvas` / `source_metadata.source=ultimate_canvas`，统一写入任务 `source_label=无线画布`、任务参数、Provider 请求记录、操作日志和返回值。
- [x] 无线画布视频生成不再只收“已在 workspace 绑定”的参考图；前端会提交所有选中参考图 ID，后端按权限校验后自动补挂到当前画布 workspace，再进入统一视频生成链路。
- [x] 图片节点主面板补齐正式模式选择：文生图、图生图、高清修复、首帧草图、尾帧草图；展开提示词弹窗和主面板按钮保持同步。
- [x] 点数流水接口支持 `source=ultimate_canvas|web|codex_api` 筛选，关键词也能查 metadata。
- [x] 点数流水页面增加“来源”筛选、表格来源列和详情来源字段，后台能直接看到无线画布流水。
- [x] 成功扣除、失败返还、创建失败返还流水继承任务 `source_metadata_json`，避免只冻结流水可筛、终态流水不可筛。
- [x] 非付费验证范围：JS 语法检查、TypeScript/lint/build、API 未登录保护、页面资源加载、生产构建和公网健康验证。
- [ ] 未执行项：真实视频生成、Provider 任务轮询到终态、真实扣点/返还截图；原因是本轮用户明确要求“过程不会要做生成视频调试”。
- 2026-06-22 补充推进：后台成本页新增来源筛选，支持 `/admin/costs?source=ultimate_canvas|web|codex_api`，待处理队列和最近总账能直接看无线画布成本来源；真实付费图片/视频生成验收仍需用户单独授权。

涉及文件：

- `src/lib/credits/*`
- `src/lib/costs/*`
- `src/app/api/tasks/estimate/route.ts`
- `src/app/api/tasks/create/route.ts`
- `src/app/admin/points/AdminPointsClient.tsx`
- `public/tools/ultimate-canvas/app.js`

#### Phase 6：素材库、上传和历史

目标：画布能复用站内资产，生成结果也能回到站内资产。

- [ ] 本地上传走 `/api/assets/upload`，不只创建本地空节点。
- [ ] 上传成功后节点保存 `asset_id`、`public_url`、`thumbnail_url`、`mime_type`。
- [ ] 素材面板接 `/api/assets/list`，支持搜索、分类、拖入画布。
- [ ] 历史面板接任务和资产列表，支持从历史选择并创建节点。
- [ ] 成功视频支持播放、下载、复制链接、打开任务详情。
- [ ] 成功图片支持预览、下载、设为参考图、拖给视频节点。
- [ ] 验收：从素材库拖一张图到画布，再生成图生视频，结果进入项目资产。

涉及文件：

- `src/app/api/assets/upload/route.ts`
- `src/app/api/assets/list/route.ts`
- `src/app/api/video/list/route.ts`
- `src/app/api/video/download/[id]/route.ts`
- `public/tools/ultimate-canvas/app.js`
- `public/tools/ultimate-canvas/styles.css`

#### Phase 7：导演台业务闭环

目标：导演台不只是本地 3D 摆拍，而能输出可生成资产。

- [ ] 3D GLB 资源改成进入导演台后懒加载，首屏不加载 16MB 素体资源。
- [ ] 摄像机截图输出进入资产库，而不只是前端图片节点。
- [ ] “生成分镜参考图”调用图形生成 API。
- [ ] “接入首尾帧视频”创建真实 `first_last_frame` 视频任务。
- [ ] `AI 识图导入` 接图形理解或先置灰，不能只显示“入口已就绪”。
- [ ] `几何模型` 做真实插入或先置灰。
- [ ] 验收：导演台输出的分镜图和视频任务能在项目资产/任务记录里查到。

涉及文件：

- `public/tools/ultimate-canvas/app.js`
- `public/tools/ultimate-canvas/director-3d.js`
- `public/tools/ultimate-canvas/assets/director/liblib/*`
- `src/app/api/assets/generate/route.ts`
- `src/app/api/tasks/create/route.ts`

#### Phase 8：长期创作体验

目标：从“能生成”提升到“能长期创作”。

- [ ] 增加撤销/重做栈，覆盖节点增删、移动、连线、提示词和参数。
- [ ] 修复多选：用数组记录多选节点，支持批量移动、删除、复制。
- [ ] 完善右键菜单：复制节点、删除节点、断开连线、整理选中节点。
- [ ] 增加快捷键帮助面板。
- [ ] 替换浏览器原生 `confirm` 为站内确认弹窗。
- [ ] 明确移动端策略：支持横屏使用，或小屏提示请用桌面端。
- [ ] icon-only 按钮补 `aria-label`、focus 样式、键盘顺序。
- [ ] 验收：误操作可撤销，键盘可用，小屏不横向错乱。

涉及文件：

- `public/tools/ultimate-canvas/canvas-engine.js`
- `public/tools/ultimate-canvas/app.js`
- `public/tools/ultimate-canvas/styles.css`
- 可能新增：`public/tools/ultimate-canvas/state-history.js`

### 总体验收标准

- [ ] 用户从 `/tools/ultimate-canvas` 进入后能选择项目并恢复上次画布。
- [ ] 页面不再出现“预览版，不扣点”；未接入能力必须禁用或明确显示不可用。
- [ ] 文本/脚本节点真实调用 `gpt5.4`，并在后台日志能查到。
- [ ] 图片节点真实调用后端 `banana2`，并在资产库能查到图片和参考图。
- [ ] 任一视频节点点击生成后会创建真实 sd2 任务。
- [ ] 任务状态能从 queued/running 到 succeeded/failed/cancelled。
- [ ] 成功任务能预览、下载、进入项目资产。
- [ ] 点数扣减和后台流水一致。
- [ ] 上传素材能保存到服务器，并能作为生成参考。
- [ ] 历史面板显示真实生成记录。
- [ ] 没有无响应或误导性的按钮。
- [ ] 刷新页面不丢节点、连线、提示词、参数。
- [ ] 新无线画布仍然只是现有后台体系里的新工具入口，不另起一套后台。

### 验证计划

- [ ] `git diff --check`
- [ ] `npx tsc --noEmit --pretty false`
- [ ] `npm run lint`
- [ ] `npm run build`
- [ ] 本地打开 `/tools/ultimate-canvas`，验证入口、项目注入、保存恢复、无响应按钮治理。
- [ ] 非付费 API mock 验证：生成状态机、失败态、重试、资产入库模拟。
- [ ] 登录态真实验证：项目选择、素材上传、历史复用、点数余额展示。
- [ ] 后台配置验证：`gpt5.4`、`banana2`、默认视频 API 三组配置都能独立测试成功，且前端不会泄露 key。
- [ ] 付费真实生成只在用户明确授权后执行。
- [ ] 线上闭环：`youdoo-sites build sd2`、`youdoo-sites restart sd2`、`youdoo-sites status sd2`，公网验证 `/tools/ultimate-canvas`、`/api/config`、`/login` 和构建资源。
- [ ] 跨健康守护周期复查 LaunchAgent `runs` 不增长。

### Git Plan

- 当前生产目录：`/Volumes/Data/Projects/video-api-debugger-v12-full-todo`。
- 当前分支：`codex/v12-full-todo`。
- 当前工作区已有大量跨任务未提交改动；正式开发前必须先复查 `git status` 和目标文件 diff。
- 每个 Phase 尽量单独提交，避免把无线画布、通知中心、模板模块等无关任务混入一个提交。
- 如果要改 `src/app/api/tasks/create/route.ts`、点数、资产、Prisma schema，优先单独分支或 worktree，验证通过后再同步部署。
- 稳定回退点建议：`rollback/2026-06-17-ultimate-canvas-mvp`。
- 发布后登记 `/Volumes/Data/Projects/project-version-registry.md`。

### 停止条件

- 如果真实生成会消耗费用，未获明确授权时不得发起付费生成。
- 如果数据库 schema 需要迁移，先停止编码，单独写迁移和回滚方案。
- 如果恢复旧画布 API，会重新暴露旧 `/generate/canvas` 或旧 `/api/canvases` 风险，必须先调整路由边界。
- 如果点数扣减无法和现有流水闭环，不允许只在前端显示“已扣点”。
- 如果素材上传不能进入服务器和资产库，不允许只用本地 blob URL 当正式结果。
- 如果 iframe 直达路径不能保证登录保护，先停止发布并修正入口保护。

HARD-GATE：

- [ ] 这是跨前端、API、点数、资产、任务状态和线上部署的中大型功能；开始编码前需要用户确认执行 Phase 0/1/2/3 的顺序和首个 MVP 范围。

## Review：2026-06-17 模板 UX P0 与 Musk API 测试入口

- 本轮完成：`/template-generate` 普通用户主路径收敛为模板摘要、需求输入、方案选择和提交；保存位置、视频卡、参考图、Prompt 编辑、参数栏改为默认折叠；普通用户不再看到 Module Builder、LLM 规则、JSON 预览和 AgentRun 入口。
- 本轮完成：视频卡未选择时，提交前自动创建“模板生成”视频卡并继续归档，避免用户先理解视频卡才能生成。
- 本轮完成：管理员工具折叠到“管理员工具”，Module Builder 先读取 Musk API 状态，未配置时禁用生成并引导去 API 设置。
- 本轮完成：`/admin/integrations` Musk API 增加“测试连接”按钮，后端 `POST /api/admin/integrations/musk` 用最小 JSON 请求验证 HTTP、模型、JSON 返回和耗时，成功/失败都写 OperationLog，且不回显 API Key。
- 验证通过：`git diff --check -- <本轮目标文件>`、`npx tsc --noEmit --pretty false`、`npm run lint`、`npx impeccable detect src/components/GenerationComposer.tsx src/components/templates/TemplateGenerateClient.tsx src/app/globals.css`、`npm run build`。
- 页面验证：本地 `http://127.0.0.1:3107/template-generate` 返回页面 HTML，命中“保存位置”折叠、“输入需求 / 选择方案 / 提交生成”三步、“切换模板”折叠；`/admin/integrations` 未登录跳转登录页，符合后台权限保护。
- 未完成（截至该 P0 当时）：独立 `/admin/templates` 模板工作台、`/admin/templates/new` LLM 新建模板向导、上下文卡片编排器、卡片编辑抽屉、持久化最后测试结果、`/admin/diagnostics`、完整权限拆分和线上部署闭环；其中模板工作台和上下文卡片能力已在后续 Review 落地。

## Review：2026-06-17 上下文卡片系统重新规划

- 本轮规划修正：旧的 `Module Builder / 模块类型 / brand_logo / injectionMode / priority` 方向不再作为主路径，后续要改为“上下文卡片系统”。
- 新核心对象：上下文卡片 = 最终给 LLM 的上下文内容 + 可选 1 张绑定图片 + 启用状态 + `强制插入 / 仅供参考` 二选一。
- 新页面规划：模板上下文卡片编排页、编辑上下文卡片抽屉、绑定图片选择弹窗、最终提示词影响预览。
- 新交互规划：卡片可拖拽排序；卡片上直接切换 `强制插入 / 仅供参考`；编辑抽屉三块为最终上下文内容、默认折叠的 LLM 参考与设置、底部 LLM 对话框；所有修改自动保存。
- 新图片规划：图片不是独立模块，而是绑定在某张上下文卡片上；图片来源复用生成页的参考图集和历史上传图；一张卡片默认只绑定 1 张图，可更换/移除。
- 已重写：`Phase 4：模板上下文卡片编排器`、`Phase 5：卡片绑定图片与图片选择器复用`。
- 规划阶段遗留已推进到代码落地，最新状态见下一节。

## Review：2026-06-17 上下文卡片系统代码落地

- 本轮完成：`SerializedGenerationTemplate.module_bindings.context_cards` 序列化层已落地；旧模板会由 `module_bindings / prompts / rules / assets` 自动转换为上下文卡片，不需要数据库迁移。
- 本轮完成：新增 `/admin/templates` 和 `/admin/templates/[id]` 模板工作台；后台导航和管理中心入口指向模板工作台，不再把 `/templates` 当管理员主入口。
- 历史实现：新增 `TemplateContextCardsPanel`，支持卡片新增、拖拽排序、启用 / 停用、`强制插入 / 仅供参考` 直接切换、绑定图片；当时把最终提示词影响放在右侧，已被 2026-06-17 最新纠偏覆盖，后续必须迁移到页面底部横向核对区。
- 本轮完成：新增卡片编辑抽屉，包含顶部最终上下文内容、中间默认折叠的 LLM 参考与设置、底部 LLM 对话框；Enter 可调用现有 Musk Module Builder API 改写顶部内容。
- 本轮完成：新增 `TemplateBoundImagePicker`，图片来源走参考图集和历史上传图；绑定图片保存到卡片，并同步成旧模板资产引用，避免污染生成页当前参考图列表。
- 本轮完成：新增 `PATCH /api/templates/[id]/context-cards`，自动保存卡片，同时同步旧 `prompts/assets/module_bindings_json`，保证旧生成链路能读取新卡片结果。
- 本轮完成：`/admin/templates` 支持从 0 描述模板目标，调用现有 `config-builder/generate` 生成草稿，再用 `config-builder/save` 保存并进入卡片编辑。
- 未完成：独立 `/admin/templates/new` 页面未拆出，当前 LLM 新建模板在 `/admin/templates` 内联完成。
- 未完成：LLM 改写后“撤回本次修改”未做；当前已能改写并自动保存。
- 未完成：绑定图片弹窗的图片名称搜索未做；当前可按图集 / 历史上传图选择。
- 未完成：真正发布门禁、发布历史、质量复盘工作台、权限角色拆分仍未全量落地。
- 验证通过：`./node_modules/.bin/tsc --noEmit --pretty false`、`npm run lint`、`git diff --check -- <本轮相关文件>`、`npx impeccable detect ...`、`npm run build`。
- 本地页面验证：`curl -I http://127.0.0.1:3117/admin/templates` 未登录返回 307 到登录页；`curl -I http://127.0.0.1:3117/api/templates` 未登录返回 401；生产构建路由表已包含 `/admin/templates`、`/admin/templates/[id]`、`/api/templates/[id]/context-cards`。
- 线上验证通过：`youdoo-sites build sd2` 生成 BUILD_ID `G9FZEZPu9K4LxaVCovvrS`；`youdoo-sites restart sd2` 成功；公网 `/admin/templates` 未登录返回 307 到登录页，公网 `/api/templates` 未登录返回 401，公网 `/login` HTML 已加载同一个 BUILD_ID；生产包命中 `选择绑定图片`、`上下文卡片`、`context_cards`、`template_context_cards_update`、`用 LLM 新建模板`；跨约 70 秒健康守护周期后 `youdoo-sites status sd2` 仍为 running/OK/public 200。

## Review：2026-06-17 模板旧入口删除与结构收敛

- 本轮完成：删除旧 `/admin/modules` 页面，后台导航、管理中心快捷入口和 shell route 不再引用模块库。
- 本轮完成：删除旧 `/admin/settings` 兼容跳转页，API 设置统一进入 `/admin/integrations`。
- 本轮完成：`TemplateEditorDrawer` 重写为纯上下文卡片抽屉，只保留卡片列表、强制/参考、绑定图片、卡片 LLM 改写、自动保存和保存模板版本；旧 `高级结构 / 规则 / 资产 / Module Builder / PromptBlock / JSON` 表单 UI 已从组件中移除。
- 本轮完成：清理旧路由生成类型缓存，避免 `.next` / `.next-prod` 继续引用已删除页面。
- 验证通过：`./node_modules/.bin/tsc --noEmit --pretty false`、`git diff --check -- <本轮相关文件>`、`npx impeccable detect ...`、`npm run lint`、`npm run build`。
- 本地构建验证：路由表已不包含 `/admin/modules` 和 `/admin/settings`，仍包含 `/admin/templates`、`/admin/templates/[id]`、`/admin/integrations`、`/admin/agent-runs`。
- 线上验证通过：`youdoo-sites build sd2` 生成 BUILD_ID `7Rwo7XAkwrIUNPHra8_bH`；`youdoo-sites restart sd2` 成功；公网 `/admin/templates` 未登录返回 307 到登录页，公网 `/login` HTML 命中同一 BUILD_ID；前端可见生产包旧 `/admin/modules`、旧 `/admin/settings`、`模块库`、`高级结构` 命中数均为 0，新 `卡片正在自动保存` 命中 1；`youdoo-sites status sd2` 为 running/OK/public 200。

## Review：2026-06-17 模板编辑工作台过窄修复

- 本轮修复：模板编辑层从 66.666vw 窄抽屉改为接近全屏工作台，宽度 `calc(100vw - 24px)`，高度 `calc(100dvh - 24px)`。
- 历史修复：上下文卡片工作区曾从“卡片 + 预览 + 编辑面板在下方”改为桌面三栏；最新纠偏要求不再把最终提示词影响夹在侧边，桌面端应保持卡片画布 + 右侧编辑栏，最终提示词影响放页面底部。
- 本轮修复：中等宽度自动回退单列，不再硬挤三栏；窄屏下卡片本身也改成单列。
- 本轮修复：拖拽能力只挂在拖拽手柄上，不再把整张卡片设为 draggable，避免按钮点击被拖拽行为干扰。
- 验证通过：`./node_modules/.bin/tsc --noEmit --pretty false`、`git diff --check -- src/components/templates/TemplateContextCardsPanel.tsx src/app/globals.css`、`npx impeccable detect ...`、`npm run lint`、`npm run build`。
- 线上验证通过：`youdoo-sites build sd2` 生成 BUILD_ID `1iTUAlgQKwqQ7Qs9d_WaP`；`youdoo-sites restart sd2` 成功；公网 `/login` HTML 命中同一 BUILD_ID；生产包命中三栏 `is-editing`、全屏宽度、拖拽手柄文案和新 CSS。

## Review：2026-06-17 模板详情工作台与底部提示词影响区

- 本轮完成：`/admin/templates/[id]` 不再要求先点“编辑上下文卡片”，进入详情后直接渲染上下文卡片工作台，默认选中第一张卡片。
- 本轮完成：桌面端结构改为“上方编辑行 + 底部影响区”：上方编辑行只放左侧/中间卡片画布和右侧当前卡片编辑栏；最终提示词影响区独立成为工作台最后一块，不再依赖 `grid-area`。
- 本轮完成：右侧编辑栏作为主要操作菜单保持 sticky；保存状态和保存模板版本按钮移入右侧编辑栏，底部最终提示词影响区成为工作台最后一块。
- 本轮完成：上下文卡片列表超高时自动收缩成卡片区滚动，单张卡片标题和正文完整换行显示，不再用摘要或省略号截断；旧抽屉容器不再 `overflow:hidden` 裁剪内容，模板列表预览卡片也取消 2 行截断。
- 本轮完成：底部最终提示词影响区常显强制写入、仅供参考、绑定图片三列，支持复制最终提示词，并保留完整最终提示词展开查看；长内容完整换行显示，不再被限高或省略号截断。
- 本轮完成：`TemplateEditorDrawer` 增加 `inline` 工作台模式，旧抽屉只作为兼容入口；模板列表页的“编辑上下文卡片”改为进入详情页。
- 本轮完成：空内容草稿卡片不再被 `normalizeContextCards()` 过滤；新增空卡片后选中编辑，保存链路保留 `id / title / mode / enabled / sort_order / bound_image / llm_reference`。
- 验证通过：`./node_modules/.bin/tsc --noEmit --pretty false`、`npm run lint`、`git diff --check -- <本轮相关文件>`、`npx impeccable detect ...`、`npm run build`、空卡片序列化 smoke。
- 线上验证通过：`youdoo-sites build sd2` 生成 BUILD_ID `i_2uMbxw7CP8Qq3jjEprq`；`youdoo-sites restart sd2` 成功；公网 `/api/config` 200、公网 `/login` 200；公网 CSS 命中 `template-context-edit-row`、`template-context-workspace{display:flex;flex-direction:column}`、`grid-template-columns:minmax(520px,1fr) minmax(420px,480px)`、卡片主区和卡片列表的 `clamp(...)` 收缩高度、`template-context-card-body p{display:block...overflow:visible...white-space:pre-wrap}`、`template-context-card-title strong{overflow-wrap:anywhere}`、`template-context-card-actions{align-content:start}`；公网 CSS 中旧 `grid-area:impact`、`grid-area:drawer` 和 `grid-template-areas` 命中数均为 0；跨健康守护周期复查最终为 `sd2 running / port ok / build ok / local 200 / public 200`。
- 未完成：真实管理员登录态点击验收和截图/录屏证据未补；停用卡片数量统计、LLM 改写撤回、卡片级保存状态、发布门禁、质量复盘、权限角色拆分仍待后续落地。

## 2026-06-17 - Seedance2 服务器迁移计划

目标：把当前 Mac 上的 `sd2.youdoodesign.com` 网站迁移到 `server skills` 默认 Ubuntu 服务器 `42.193.221.253`，同时把目录命名从 `video-api-debugger-v12-full-todo` 改成可长期维护的 `seedance2`。

### 迁移原则

- [x] 先搭服务器并行灰度版，不直接切正式 `sd2.youdoodesign.com`。
- [ ] Mac 旧服务保留为回滚源，正式切换后至少保留 24 小时。
- [x] 服务器目录统一命名为 `seedance2`，不继续沿用 `video-api-debugger-v12-full-todo`。
- [x] 代码、环境变量、SQLite、上传文件、视频产物、域名入口、进程管理分开处理。
- [x] 不打印、不提交、不登记任何 API Key、飞书密钥、Session Secret、R2 密钥。
- [x] 不复制 Mac 的 `node_modules`、`.next-prod`；服务器必须重新安装依赖、重新 Prisma generate、重新构建。

### 目标目录

- [x] 代码发布目录：`/home/gouki/services/seedance2/releases/<timestamp>`
- [x] 当前版本软链接：`/home/gouki/services/seedance2/current`
- [x] 数据目录：`/home/gouki/data/seedance2`
- [x] SQLite 数据库：`/home/gouki/data/seedance2/dev.db`
- [x] 上传素材目录：`/home/gouki/data/seedance2/uploads`
- [x] 视频产物目录：`/home/gouki/data/seedance2/videos`
- [x] 备份目录：`/home/gouki/backups/seedance2`
- [x] 灰度端口：`127.0.0.1:3302`，避免占用服务器现有 `3000`。

### 当前 Mac 数据源

- [x] 生产代码目录：`/Volumes/Data/Projects/video-api-debugger-v12-full-todo`
- [x] 共享环境文件：`/Volumes/Data/Projects/video-api-debugger/.env`
- [x] 真实 SQLite：`/Volumes/Data/Projects/video-api-debugger/prisma/dev.db`
- [x] 当前生产目录里的 `prisma/dev.db` 是软链接，迁移后必须改成服务器路径。
- [x] 当前生产目录里的 `.env` 是软链接，迁移后必须改成服务器本地 `.env`。
- [x] `public/uploads` 需要同步到服务器数据目录。
- [x] `public/videos` 需要同步到服务器数据目录。
- [x] `public/tools` 如仍作为页面入口，需要同步或保留在 release 中。

### 执行步骤

- [x] 服务器预检：确认 Ubuntu、Node、npm、nginx、磁盘、端口、systemd 状态。
- [x] 创建服务器目录结构和权限。
- [x] 制作本地代码快照，排除 `node_modules`、`.next*`、构建缓存和无关临时文件。
- [x] 生成 SQLite 一致性备份，先作为灰度测试数据上传。
- [x] 同步 `public/uploads`、`public/videos`、必要的 `public/tools`。
- [x] 在服务器创建 `.env`，只迁移变量，不输出密钥值。
- [x] 在服务器 release 中创建软链接：`prisma/dev.db`、`public/uploads`、`public/videos` 指向 `/home/gouki/data/seedance2`。
- [x] 执行 `npm ci`、`npx prisma generate`、`npm run build`。
- [x] 创建 `systemd` 服务 `seedance2.service`，监听 `127.0.0.1:3302`。
- [x] 验证服务器本地 `http://127.0.0.1:3302/api/config` 和 `/login`。
- [x] 配置临时灰度公网入口，优先使用 Cloudflare Tunnel，不直接改正式域名。（已完成服务器专用 Cloudflare Tunnel：`https://sd2-server.youdoodesign.com` -> `127.0.0.1:3302`）
- [ ] 灰度验证登录、飞书回调、资产页、视频播放、图片/视频/音频上传。（已验证飞书 OAuth 起跳 `redirect_uri` 指向灰度 callback；完整登录回调仍待真实账号/飞书后台白名单验收）
- [ ] 最终切换前停 Mac 写入，再做 SQLite 和文件增量同步。
- [ ] 切换正式 `sd2.youdoodesign.com` 后验证公网 `/api/config`、`/login`、核心页面和上传链路。

### 验收标准

- [x] 服务器本地 `/api/config` 返回 Seedance 配置 JSON。
- [x] 服务器本地 `/login` 返回 200。
- [x] 灰度公网 `/api/config` 返回 200。
- [x] 灰度公网 `/login` 返回 200。
- [x] 现有用户、项目、任务、资产数量和 Mac 源数据一致。
- [x] 已有 `public/videos` 中的视频可以通过服务器 3302 和 nginx Host 访问。
- [x] 已有 `public/uploads` 中的图片/缩略图可以通过服务器 3302 和 nginx Host 访问。
- [ ] 飞书登录回调可用；如使用临时域名，需要先配置飞书回调白名单。
- [ ] 图片、视频、音频上传链路可用。
- [x] `systemctl restart seedance2` 后服务自动恢复。
- [x] 服务日志没有密钥输出。
- [ ] 正式域名切换前有明确回滚路径。

### 停止条件

- [ ] 如果服务器 3302 端口被占用，停止并重新选端口，不抢现有 3000。
- [ ] 如果 `.env` 无法安全迁移，停止，不用明文打印密钥。
- [ ] 如果 SQLite 最终同步无法在停写窗口完成，停止正式切换。
- [ ] 如果灰度公网无法稳定访问，不切正式 `sd2.youdoodesign.com`。
- [ ] 如果飞书回调未验证，不切正式域名。
- [ ] 如果上传或视频播放失败，不切正式域名。

### Git / 版本计划

- 当前生产目录已有大量未提交改动，本次迁移先形成服务器灰度环境，不混合提交无关源码。
- 迁移脚本、服务配置和经验记录如需要落库，后续单独整理成聚焦提交。
- 正式切换成功后，登记 `/Volumes/Data/Projects/project-version-registry.md` 和 `/Volumes/Data/Projects/public-link-registry.md`。
- 稳定回退点建议命名：`rollback/2026-06-17-seedance2-server-migration`。

### Review

- [x] 已完成服务器并行灰度基础环境：`/home/gouki/services/seedance2/current` -> release `20260617153020`，`seedance2.service` active，监听 `127.0.0.1:3302`。
- [x] 已完成数据灰度同步：SQLite 备份、`public/uploads`、`public/videos` 和 release 内软链接。
- [x] 已完成服务器本地验证：`/api/config` 200、`/login` 200、`/assets` 200、上传图片样本 200、视频样本 200。
- [x] 已完成 nginx Host 预配置：`sd2-server.youdoodesign.com` -> `127.0.0.1:3302`，用公网 IP + Host 头访问 `/api/config` 和 `/login` 返回 200。
- [x] 已完成真实公网灰度域名：`https://sd2-server.youdoodesign.com` 通过服务器专用 Cloudflare Tunnel `seedance2-server` 进入 Ubuntu `127.0.0.1:3302`，公网 `/login`、`/assets`、`/api/config`、新构建静态资源、uploads 缩略图和 videos 样本均返回 200。
- [x] 已完成飞书 OAuth 起跳灰度验证：`/api/auth/feishu/authorize` 返回 303，`redirect_uri` 为 `https://sd2-server.youdoodesign.com/api/auth/feishu/callback`。
- [ ] 未完成飞书登录完整回调验收：需要真实账号点击登录，并确认飞书开放平台已允许灰度 callback。
- [ ] 未执行正式 `sd2.youdoodesign.com` 切换；Mac 旧服务仍是正式入口。

## 2026-06-18 sd2 自动部署

### 目标

- 当前正式 `sd2.youdoodesign.com` 仍运行在 Mac 的 `/Volumes/Data/Projects/video-api-debugger-v12-full-todo`。
- 以后 `origin/codex/v12-full-todo` 出现新 commit 后，Mac 自动拉取、构建、重启并验证，减少人工漏部署。
- 不绕过现有 `youdoo-sites` 安全构建流程，不直接改 `.next-prod`。

### 闭环策略

- [x] 已创建 Codex cron 自动化 `sd2`，每小时检查 `/Volumes/Data/Projects/video-api-debugger-v12-full-todo`。
- [x] 没有新 commit 时只记录简短状态，不构建、不重启。
- [x] 有新 commit 时要求工作区干净、当前分支为 `codex/v12-full-todo`、远端可 fast-forward。
- [x] 满足条件后执行 `git merge --ff-only origin/codex/v12-full-todo`，再走 `tsc`、`youdoo-sites build sd2`、`youdoo-sites restart sd2`。
- [x] 部署后验证本地 `/api/config`、公网 `/api/config`、公网 `/login`、新 BUILD_ID 的 `_buildManifest.js`。
- [x] 跨健康守护周期后再次执行 `youdoo-sites status sd2`。

### 安全边界

- [x] 工作区有未提交改动时自动跳过，避免部署半成品。
- [x] 远端不是 fast-forward 时自动跳过，避免自动合并冲突。
- [x] 不读取、不输出 `.env`、API Key、cookie、token。
- [x] 当前只绑定 Mac 正式服务；如果未来正式域名切到 Ubuntu 灰度服务，要另做服务器端 systemd/Git 自动部署，不复用 Mac launchd。
- [x] launchd 本地守护路线已验证受阻：后台任务可读写项目普通文件，但读取外置盘 worktree 的 `.git` 元数据会被 macOS 拒绝；已卸载并删除失败的 LaunchAgent，避免假自动化。

### 验收

- [x] Codex 自动化创建成功：automation id `sd2`，状态 `ACTIVE`。
- [x] launchd 失败路线已清理：`launchctl print gui/$(id -u)/com.youdoo.sd2-auto-deploy` 返回未找到服务。
- [ ] 等下一次整点自动化运行后，复核自动化执行记录是否按预期 noop。

## 2026-06-20 参考图集管理员视图和头像归属

### 目标

- 参考图集页的“项目图集”默认显示所有可访问项目图集，不再被新建表单里的项目选择误过滤。
- 管理员单独看到“其他人的项目图集”分栏，可以按项目筛选其他人创建的项目图集。
- 图集名展示前统一增加创建者头像，方便判断谁创建、谁共享。

### 落地

- [x] `/api/reference-albums` 增加 `scope=other_project`，仅管理员可用。
- [x] `/collections` 分离列表项目筛选和新建图集项目选择，项目图集默认查全部项目。
- [x] `/collections` 图集卡片标题改为“头像 + 图集名”。
- [x] 生成页顶部图集下拉展示“创建者头像 + 图集名 + 数量”。
- [x] 生成页“从图集选择参考图”弹窗展示“创建者头像 + 图集名”。

### 验收

- [x] `git diff --check` 通过。
- [x] `npx tsc --noEmit --pretty false` 通过。
- [x] `npm run lint` 通过，只有既有 warning。
- [x] `npm run build` 通过。
- [x] `youdoo-sites build sd2`、`youdoo-sites restart sd2`、`youdoo-sites status sd2` 通过。
- [x] 公网 `/api/config` 200、`/login` 200、`/collections` 未登录 307、`/generate` 未登录 307、`/api/reference-albums?scope=other_project` 未登录 401。
- [x] 生产 BUILD_ID `tzaGyxOD8guvSsGdamHwJ`，生产静态资源命中新文案和样式标记：`其他人的项目图集`、`album-project-filter`、`composer-toolbar-dropdown-item-main`、`album-card-title-row`。
- [x] 跨健康守护周期复查后 `youdoo-sites status sd2` OK，`com.youdoo.site.sd2` 的 `runs=28` 未增长。

## 2026-06-20 模板卡片列表布局根治

### 问题判断

- 截图显示上下文卡片列表在模板三级弹窗里重叠：正文、标题、强制/参考按钮、删除/启用/编辑按钮挤在同一水平行。
- 根因不是单个间距错误，而是列表卡片承担了太多内容：完整标题、完整正文、绑定图片状态、模式切换、启用、编辑、删除都在一行里争宽度。
- 右侧操作列宽度过窄且贴近内部滚动条，内容列没有固定“摘要区”和“控制区”边界，长文本会把按钮挤乱。
- 根治原则：列表是“编排视图”，只显示短摘要和关键状态；完整内容、规则、LLM 改写都在三级弹窗编辑页展示。

### 根治方案

- [x] 将 `.template-context-card` 改为稳定四区布局：拖拽区、图片区、内容摘要区、操作区。
- [x] 内容摘要区限制标题和正文行数，长文本截断为摘要，完整内容只在三级弹窗看。
- [x] 模式切换按钮固定在摘要区底部，不与正文同一行重叠。
- [x] 操作区固定宽度并远离滚动条，启用/编辑/删除三个按钮垂直排列，按钮宽度一致。
- [x] 绑定图片状态改为短徽标，不把长图名铺满整行。
- [x] 移动或窄宽度下卡片自动变为上下结构，操作按钮改为三列，不再横向挤压。
- [x] 补 smoke 或静态检查，确认关键 CSS 类和截断策略存在。

### 验收标准

- [x] 截图中的三类重叠消失：正文不压按钮，按钮不压标题，操作区不贴滚动条。
- [x] 卡片行高度稳定，长标题/长正文不会撑爆列表。
- [x] 启用、编辑、删除仍完整可达。
- [x] 强制插入/仅供参考仍可在卡片上直接二选一。
- [x] `tsc`、`lint`、`build`、线上部署、公网静态资源命中和健康周期验证通过。

### Review

- [x] 已把卡片列表改成编排摘要视图，完整内容回到三级弹窗。
- [x] 已新增 `scripts/template-card-layout-smoke.ts`，防止四区布局、两行摘要和移动端操作区规则被后续改丢。
- [x] 本地验证已通过：`npx tsx scripts/template-card-layout-smoke.ts`、`git diff --check`、`npx impeccable detect ...`、`./node_modules/.bin/tsc --noEmit --pretty false`、`npm run lint`、`npm run build`。
- [x] 已完成线上部署，生产 BUILD_ID `sBmW_xsIQ1G8W1uDWCCXk`；公网 CSS 命中 `scrollbar-gutter:stable`、`20px 76px minmax(260px,1fr) 92px`、`-webkit-line-clamp:2` 和移动端三列操作按钮规则。

## 2026-06-20 公司级项目类型规划

### 目标

- 创建项目时，除了个人默认项目和普通协作项目，还要支持“公司级项目”。
- 公司级项目用于公司内部共享工作，不等同现有 `public` 公共预算项目。
- 公司级项目默认仍走个人积分记账：谁发起生成，扣谁的个人积分；不进入公共项目预算池。

### 设计口径

- [ ] 新增项目类型 `company`，语义为“公司级项目”。
- [ ] 保留 `personal` 作为个人默认空间，不允许手动新建多个个人空间。
- [ ] 保留 `team` 作为成员制协作项目。
- [ ] 保留 `public` 作为公共预算项目，只通过现有审批/预算流程创建或启用。
- [ ] 保留 `system` 作为系统项目，不进入普通创建入口。
- [ ] 公司级项目默认 `visibility='internal_public'`，表示公司内部可见。
- [ ] 公司级项目的创建者自动成为 `project_owner`。
- [ ] 公司级项目对登录用户默认可查看、可生成；只有管理员、项目负责人和被授权编辑者能管理资产。
- [ ] 公司级项目仍支持邀请和成员管理，成员角色用于提升管理/编辑权限。
- [ ] 公司级项目不触发 `ProjectBudgetAccount` 初始化，不走公共预算冻结、实扣或追加预算审批。

### 需要修改的文件

- [ ] `src/app/api/projects/route.ts`：`POST` 支持 `type='company'`；`GET` 把公司级项目纳入普通用户可见项目；返回 `can_manage_members` 时把 `company` 作为可管理成员项目。
- [ ] `src/lib/projects/permissions.ts`：把可共享/可邀请项目类型从 `team | public` 扩展为 `team | company | public`；补公司级默认可见、可生成、但非负责人不可管理的权限规则。
- [ ] `src/app/api/tools/ultimate-canvas/bootstrap/route.ts`：无线画布启动项目列表包含公司级项目。
- [ ] `src/app/api/project-invites/[token]/join/route.ts`：邀请加入允许 `company` 类型。
- [ ] `src/app/projects/page.tsx`：创建项目表单增加“协作项目 / 公司级项目 / 预算记账项目”选择；普通创建根据选择传 `team` 或 `company`。
- [ ] `src/app/generate/page.tsx`：生成页项目下拉里的新建项目表单增加“协作 / 公司级”切换；项目 meta 显示“公司级项目”。
- [ ] `src/components/templates/TemplateGenerateClient.tsx`：模板生成页项目下拉同步支持公司级项目创建和显示。
- [ ] `src/components/ShareAlbumDialog.tsx`：共享图集项目下拉类型文案增加“公司级项目”。
- [ ] `src/app/admin/projects/AdminProjectsClient.tsx`：后台项目列表显示“公司级项目”；公司级空项目允许删除，有内容项目允许归档。
- [ ] `src/app/projects/[id]/page.tsx`：项目详情页删除/归档判断和类型文案支持公司级项目。
- [ ] `prisma/schema.prisma`：只更新 `Project.type` 注释为 `personal | team | company | public | system`；不需要数据库迁移，因为当前字段是字符串。

### 实施步骤

- [ ] 增加项目类型 helper，统一输出项目类型标签，避免各页面散落 `team/public/personal` 判断。
- [ ] 后端先改权限和创建接口，确保 `company` 不会被 API 强制落成 `team`。
- [ ] 前端再改三个创建入口：项目页、生成页、模板生成页。
- [ ] 改所有项目类型显示文案，避免公司级项目仍显示为“团队项目”。
- [ ] 检查共享图集、项目邀请、任务移动、资产移动、无线画布 bootstrap 是否能识别公司级项目。
- [ ] 补 smoke 脚本或轻量测试，覆盖 `company` 创建、列表可见、权限判断和 `public` 预算逻辑未被误触发。
- [ ] 本地验证通过后，按 sd2 流程部署到线上。

### 验收标准

- [ ] `/projects` 创建项目时能选择“公司级项目”。
- [ ] 创建后的公司级项目在项目列表显示为“公司级项目”，不是“团队项目”。
- [ ] `/generate` 新建项目时能选择公司级，创建后自动选中。
- [ ] `/template-generate` 新建项目时能选择公司级，创建后自动选中。
- [ ] 普通登录用户能看到 active 的公司级项目，并能在其中生成。
- [ ] 非负责人不能归档、删除或管理公司级项目成员。
- [ ] 项目负责人和管理员能管理公司级项目成员、图集和资产。
- [ ] 公司级项目生成仍扣发起人的个人积分，不创建或使用项目预算池。
- [ ] 公共预算项目 `public` 的原有审批、预算冻结、实扣、预算不足逻辑不回归。
- [ ] 分享图集到项目时，公司级项目可被选择，并显示“公司级项目”。

### 验证命令

- [ ] `git diff --check`
- [ ] `npx tsc --noEmit --pretty false`
- [ ] `npm run lint`
- [ ] `npx impeccable detect src/app/projects/page.tsx src/app/generate/page.tsx src/components/templates/TemplateGenerateClient.tsx src/app/globals.css`
- [ ] `npm run build`
- [ ] `youdoo-sites build sd2`
- [ ] `youdoo-sites restart sd2`
- [ ] `youdoo-sites status sd2`
- [ ] `curl http://127.0.0.1:3000/api/config`
- [ ] `curl https://sd2.youdoodesign.com/api/config`
- [ ] `curl https://sd2.youdoodesign.com/login`
- [ ] 跨健康守护周期后复查 `youdoo-sites status sd2` 和 `launchctl print gui/$(id -u)/com.youdoo.site.sd2` 的 `runs` 不增长。

### 停止条件

- [ ] 如果发现现有 `public` 公共预算项目已经被业务用作“公司级”，先停下重新确认命名，不直接改。
- [ ] 如果公司级项目会绕过权限导致外部账号可见，先停下补账号类型边界。
- [ ] 如果 `company` 影响公共项目预算扣费路径，先停下拆分记账判断。
- [ ] 如果测试或构建失败，不提交、不推送、不部署。
- [ ] 如果工作区出现非本轮改动，先隔离或报告，不混入提交。

### Git / 部署计划

- [ ] 本轮落地时使用当前生产工作区 `/Volumes/Data/Projects/video-api-debugger-v12-full-todo`。
- [ ] 完成后创建聚焦 commit，建议信息：`新增公司级项目类型`。
- [ ] 创建 rollback tag，建议：`rollback/2026-06-20-company-project-type`。
- [ ] 推送 `origin/codex/v12-full-todo` 和 rollback tag，并用 `git ls-remote` 复核。
- [ ] 部署成功后登记 `/Volumes/Data/Projects/project-version-registry.md`。

## 2026-06-20 模板规则文本化闭环

### 目标

- [x] 删除卡片编辑页里的“规则与非最终输入来源”折叠区，不再保留看不见但会影响 LLM 的规则通道。
- [x] 旧 `template.rules` 自动合并成一张“生成规则”上下文卡片，规则正文直接写在“最终输入给 LLM 的上下文内容”输入框里。
- [x] 有上下文卡片时，最终生成提示词只读取卡片正文、启用状态、插入方式、排序和绑定图片，不再额外读取旧 `template.rules`。
- [x] LLM 改写卡片时不再读取隐藏 `llm_reference`，只读取卡片标题、当前正文和管理员本次输入。
- [x] 补 `template-rules-editable-text-smoke`，锁定规则文本化和废弃 UI 不回归。

### 验收标准

- [x] 线上卡片编辑弹窗不再出现“规则与非最终输入来源”区域。
- [x] “生成规则”以普通卡片出现，可启用/停用、强制插入/仅供参考、编辑正文和排序。
- [x] 生成提示词里出现的规则内容，必须来自可见卡片正文。
- [x] 旧 `rules` 数组不能在卡片之外偷偷追加到最终提示词。

## 2026-06-20 无线画布 LLM 节点上下文规则编辑

### 目标

- [x] 在无线画布文本节点的 LLM 输入栏增加“规则”编辑按钮。
- [x] “规则”按钮暂时只对管理员显示，普通用户不可见。
- [x] 规则内容保存到节点 `contextRules`，随画布文档自动保存和恢复。
- [x] 文本节点生成时把 `contextRules` 带入生成 payload。
- [x] 后端只允许管理员传入的 `contextRules` 进入 LLM 上下文，普通用户伪造字段时忽略。
- [x] 补 `ultimate-canvas-context-rules-smoke`，锁定按钮、payload、样式和后端权限校验。

### 验收标准

- [x] 管理员进入 `/tools/ultimate-canvas` 时，文本节点 LLM 输入栏能看到“规则”按钮。
- [x] 点击“规则”打开轻量编辑弹窗，能填写、清空、保存规则。
- [x] 保存后按钮显示已设置状态，画布自动保存。
- [x] 文本生成请求会把规则写入 LLM 上下文。
- [x] 非管理员看不到规则编辑入口，后端也不会应用非管理员伪造的规则字段。

## 2026-06-20 参考图集重复图片上传复用闭环

### 问题判断

- [x] 现在线上图集页上传同文件时，先调用 `/api/assets/upload` 创建个人历史素材，再调用 `/api/reference-albums/[id]/images` 绑定到图集。
- [x] `/api/assets/upload` 底层按 `Asset.hash` 去重；如果同 hash 文件已由其他用户上传，会在素材层直接抛错，图集绑定步骤不会执行。
- [x] 这不是用户需要“找管理员开放共享”的场景；用户已经本地选择了同一张图片，系统应先把图片贴到当前图集，只复用旧后台内容链接。

### 根治方案

- [x] 图集页上传图片时，直接把文件提交到 `/api/reference-albums/[id]/images`，不要先走个人历史素材上传。
- [x] 图集图片接口同时支持 JSON 绑定已有素材、multipart 上传新文件两种请求。
- [x] multipart 上传时先计算文件 hash，若已有同 hash 图片资产，直接新建当前图集 `ReferenceImage`，复用旧 `asset_id`、`original_url`、`thumbnail_url`。
- [x] hash 未命中时，仍按原有 `uploadSiteAsset` 创建新资产，再绑定到当前图集。
- [x] 操作日志记录本次新增的图集图片、资产 id，以及哪些资产是复用已有内容。
- [x] 补 smoke，锁定图集上传不再走 `/api/assets/upload` 两步流，并确认后端存在 hash 复用绑定路径。
- [x] 补接口级 integration，临时创建跨用户同 hash 图片，POST 到图集接口后确认复用旧资产链接并清理数据。

### 验收标准

- [x] 在参考图集详情页上传别人已上传过的同一文件，不再显示“联系管理员开放共享”。
- [x] 当前图集新增图片卡片，图片内容接口 `/api/reference-images/[id]/content` 可读取。
- [x] 新增图集图片的后台内容链接与旧资产保持一致，不重复上传二进制文件。
- [x] 普通个人历史素材上传仍保持原来的跨用户限制，不扩大素材库权限。
- [x] `tsc`、`lint`、`build`、部署、公网资源命中和健康周期验证通过。

## 2026-06-24 火山 IP 生成页正式版接口闭环规划更新

### 官方文档依据

- [创建视频生成任务 API](https://www.volcengine.com/docs/82379/1520757?lang=zh)
- [查询视频生成任务 API](https://www.volcengine.com/docs/82379/1521309?lang=zh)
- [查询视频生成任务列表](https://www.volcengine.com/docs/82379/1521675?lang=zh)
- [取消或删除视频生成任务](https://www.volcengine.com/docs/82379/1521720?lang=zh)
- [Doubao Seedance 2.0 系列教程](https://www.volcengine.com/docs/82379/2291680?lang=zh)
- [Doubao Seedance 2.0 系列提示词指南](https://www.volcengine.com/docs/82379/2222480?lang=zh)
- [模型列表](https://www.volcengine.com/docs/82379/1330310?lang=zh)
- [模型价格](https://www.volcengine.com/docs/82379/1544106?lang=zh)
- [Seedance 2.0 系列模型资源包使用规则](https://www.volcengine.com/docs/82379/2191775?lang=zh)
- [获取 API Key 并配置](https://www.volcengine.com/docs/82379/1541594?lang=zh)
- [管理 API Key](https://www.volcengine.com/docs/82379/1361424?lang=zh)
- [虚拟人像库](https://www.volcengine.com/docs/82379/2223965?lang=zh)
- [录入真人形象素材](https://www.volcengine.com/docs/82379/2315856?lang=zh)
- [版权和人像素材使用规则](https://www.volcengine.com/docs/82379/2525200?lang=zh)

### 当前判断

- [x] `/generate/ip` 已经是独立入口，复用普通生成页完整 UI。
- [x] `/generate/ip` 目前已锁定提交，不会误走旧 `/api/tasks/create`，不会误扣点。
- [ ] 火山官方创建、查询、列表、取消/删除四个接口尚未接入。
- [ ] 火山官方文档里的鉴权、模型开通、素材输入限制、真人/虚拟人像、结果链接 24 小时有效、7 天查询窗口、token 计费和回调要求尚未落地。
- [ ] 普通生成页 `/generate` 不属于本计划修改范围；后续实现不得改变普通生成页已有提交、查询、列表、删除行为。

### 需要新增关注并调整的官方约束

- [ ] 鉴权：火山视频生成接口只用 API Key 鉴权，服务端环境变量建议新增 `VOLCENGINE_ARK_API_KEY`，不得暴露到前端。
- [ ] API Key 权限：火山 API Key 可限制 Model ID、自定义接入点和调用 IP，配置页需要支持“已配置但权限不足”的错误文案。
- [ ] 模型开通：Seedance 2.0 系列需要账户余额大于 200 元，或购买对应资源包且有余量；配置检查不能只判断 API Key 存在。
- [ ] 模型 ID：正式模型必须从配置读取，例如 `VOLCENGINE_ARK_VIDEO_MODEL`，不要写死；Seedance 2.0 mini 文档写明预计北京时间 6 月 25 日支持 API 调用，落地时需再次确认。
- [ ] Endpoint ID：官方允许用 Endpoint ID 调用模型以获得限流、计费类型、监控和安全能力；第一版先支持 Model ID，Endpoint ID 作为同一字段配置，不另起复杂抽象。
- [ ] 输入组合：支持文本、图片、视频、音频、样片任务 ID；但图生视频首帧、首尾帧、多模态参考是互斥场景，不能在 payload 中混用。
- [ ] 素材数量：Seedance 2.0 多模态参考支持图片 0-9 张、视频 0-3 个、音频 0-3 段；音频不能单独输入，必须至少有 1 个图片或视频。
- [ ] 素材大小：单张图片小于 30 MB；单个视频不超过 200 MB；单个音频不超过 15 MB；请求体总大小不超过 64 MB，大文件不要走 Base64。
- [ ] 素材时长：单个视频 2-15 秒，多个视频总时长不超过 15 秒；单个音频 2-15 秒，多个音频总时长不超过 15 秒。
- [ ] 公网可访问：普通 URL 素材必须公网可访问，建议走 TOS/R2；不能把本地路径、内网地址、localhost 传给火山。
- [ ] 火山素材 URI：虚拟人像和已授权真人素材使用 `asset://<ASSET_ID>`，不能当普通图片 URL 处理。
- [ ] 真人脸限制：Seedance 2.0 不支持直接上传含真人人脸的普通参考图/视频；真人必须走授权人像素材或受信模型原始产物。
- [ ] 受信素材：本账号下近 30 天内由指定 Seedance 2.0 系列模型生成的含人脸原始产物，可作为再次生成输入；压缩、转发可能导致信任失效。
- [ ] 虚拟人像：可在体验中心复制资产 ID/URI 后用于 API；第一版只支持用户手工粘贴 `asset://...`，不接火山人像库浏览。
- [ ] 已授权真人：录入/认证/接收授权在火山控制台完成；本系统第一版只消费已有 `asset://...`，不做真人认证 H5、邀约二维码和素材入库流程。
- [ ] 参数传法：`resolution`、`ratio`、`duration`、`frames`、`seed`、`camera_fixed`、`watermark` 用 request body 强校验方式，不再塞进 prompt 后缀。
- [ ] 分辨率：Seedance 2.0 默认 720p；Seedance 2.0 支持 4k，Fast/Mini 不支持 1080p；4k 是 H.265/10bit，浏览器播放和本地转存要额外兼容。
- [ ] 比例：Seedance 2.0 默认 `adaptive`，并支持 `16:9`、`4:3`、`1:1`、`3:4`、`9:16`、`21:9`；实际比例要以查询返回值为准。
- [ ] 时长：`duration` 和 `frames` 二选一，`frames` 优先；第一版只保留整数秒 `duration`，不做小数秒 `frames`。
- [ ] 智能时长：`duration=-1` 会影响计费且不可预估；第一版不开放。
- [ ] 音频：`generate_audio` 默认 true，有声视频为单声道；提示词里的台词建议使用中文引号包裹。
- [ ] 尾帧：`return_last_frame=true` 才返回 `last_frame_url`；尾帧 URL 也是 24 小时有效，需要转存。
- [ ] 回调：`callback_url` 状态变化时 POST，内容与查询任务返回一致；发送失败 5 秒内未成功会重试 3 次。
- [ ] 过期：`execution_expires_after` 默认 172800 秒，范围 3600-259200 秒；超过后状态为 `expired`。
- [ ] 服务层级：`service_tier=default` 是在线推理；`flex` 是离线推理，价格约为在线 50%，但时延更高且不支持优先级；第一版默认 `default`，后台可配置。
- [ ] 样片模式：`draft` 仅 Seedance 1.5 Pro 支持，且 480p、不支持尾帧、不支持离线推理；IP 生成第一版不做样片模式。
- [ ] 联网搜索：`tools.type=web_search` 会增加时延，查询结果里用 `usage.tool_usage.web_search` 对账；第一版默认关闭，后续按开关接入。
- [ ] 查询窗口：官方只支持查最近 7 天任务；我们必须把 provider 返回结果及时落库。
- [ ] 结果链接：`video_url` 和 `last_frame_url` 有效期 24 小时；任务成功后必须尽快转存到本地/R2/TOS，并生成缩略图。
- [ ] 状态映射：火山状态为 `queued`、`running`、`cancelled`、`succeeded`、`failed`、`expired`；本地需要把 `expired` 明确当终态失败/超时处理，不能按 running 继续轮询。
- [ ] 删除语义：只有 `queued` 任务可取消为 `cancelled`；`cancelled` 24 小时自动删除；`running/succeeded/failed/expired` 调 DELETE 的效果需按官方状态表和实测确认。
- [ ] 计费：官方只对成功生成计费，失败不计费；准确 token 用量以查询返回 `usage.completion_tokens` 为准。
- [ ] 最低用量：Seedance 2.0 系列存在最低 token 用量，预估扣点必须保守，最终以官方 `usage` 对账。
- [ ] 资源包：资源包按模型和场景抵扣，超出后自动转按量后付费；本系统不直接管理火山资源包，只记录官方用量和配置提示。
- [ ] 版权 IP：模型价格页写明“版权视频生成”当前仅支持在体验中心基于特定版权 IP 使用 Seedance 2.0；如我们做“授权 IP 动画”，需等拿到官方 API 可用模型/资产 URI/授权范围后再开放付费提交。

### 复用现有能力

- [ ] 复用 `/generate/ip` 现有页面壳、项目、视频卡、模板、提示词、图集、最近任务布局。
- [ ] 复用登录态、用户权限、项目权限、视频卡权限。
- [ ] 复用现有 `VideoTask` 表里的 `provider`、`provider_task_id`、`raw_create_response`、`raw_status_response`、`provider_payload_json`、成本字段。
- [ ] 复用点数冻结、成功扣除、失败退回、项目预算、成本 ledger，但要新增火山 `usage` 对账写入。
- [ ] 复用现有素材公网化能力 `uploadSiteAsset` / R2 / TOS 检查。
- [ ] 复用成功后本地缓存视频、生成缩略图、任务详情展示。

### 必须新做或重写

- [ ] 新建 `src/lib/provider/volcengine-ark-video.ts`，只封装火山 Ark 官方接口，不改 `src/lib/provider/jimeng.ts`。
- [ ] 新增火山类型文件或同文件内类型：创建请求、任务详情、列表响应、错误结构、usage、content。
- [ ] 新增 IP 专用创建接口 `src/app/api/ip/tasks/create/route.ts`，不要让 `/generate/ip` 走 `/api/tasks/create`。
- [ ] 新增 IP 专用状态接口 `src/app/api/ip/video/status/[id]/route.ts`，内部只处理 `provider='volcengine_ark'` 的任务。
- [ ] 新增 IP 专用列表接口 `src/app/api/ip/video/list/route.ts`，默认读取本地任务，并按 `provider='volcengine_ark'` 过滤。
- [ ] 新增可选的远端任务同步接口 `src/app/api/ip/provider/tasks/route.ts`，仅管理员/诊断使用，用火山 List API 补最近 7 天状态。
- [ ] 新增 IP 专用取消接口 `src/app/api/ip/tasks/[id]/cancel/route.ts`，调用火山 DELETE，只对可取消状态开放。
- [ ] 保留现有 `src/app/api/tasks/[id]/route.ts` 作为本地移除，不让它假装取消火山任务。
- [ ] 新增火山状态 finalizer，例如 `src/lib/video/volcengine-task-finalizer.ts`，不直接改普通 `task-finalizer.ts` 的旧 provider 行为。
- [ ] 新增火山 content builder：区分首帧、首尾帧、多模态参考、`asset://` 素材、普通公网 URL、Base64。
- [ ] 新增 IP 输入校验：素材数量、大小、时长、音频不能单独输入、普通真人脸素材提示禁用、`asset://` 格式校验。
- [ ] 新增配置检查接口或扩展现有配置展示：API Key、模型 ID、base URL、service tier、callback 开关、转存开关。
- [ ] 新增结果转存闭环：成功查询后立即下载 `video_url` 和 `last_frame_url`，写入本地/R2/TOS 地址，再生成缩略图。
- [ ] 新增官方 `usage.completion_tokens` / `total_tokens` / `tool_usage.web_search` 入库和后台成本展示字段映射。
- [ ] 前端 `/generate/ip` 提交、轮询、列表、取消全部改到 `/api/ip/...`，但普通 `/generate` 保持旧接口。
- [ ] 前端显示火山专属状态：排队、运行、成功、失败、已取消、已超时。
- [ ] 前端素材区增加 `asset://` 输入/粘贴入口，用于虚拟人像和已授权真人素材。
- [ ] 前端对 4k、Fast/Mini 不支持 1080p、`adaptive` 比例等模型差异做动态限制。

### 暂不做

- [ ] 不在第一版做火山控制台 API Key 管理、模型开通、资源包购买或余额查询。
- [ ] 不在第一版做人脸认证 H5、真人素材邀约二维码、真人素材入库和接收授权流程。
- [ ] 不在第一版做火山虚拟人像库浏览器；只支持粘贴官方 `asset://<ASSET_ID>`。
- [ ] 不在第一版开放 `duration=-1`、`frames` 小数秒、`draft` 样片模式、`web_search` 联网搜索、`service_tier=flex` 用户开关。
- [ ] 不在第一版改普通生成页 `/generate` 的接口、轮询、列表和删除逻辑。
- [ ] 不在未拿到 API Key 和明确付费授权前发起真实火山生成。

### 实施步骤

- [ ] Task 1：补火山 provider 类型和接口客户端，mock fetch 覆盖创建、查询、列表、删除和错误解析。
- [ ] Task 2：补火山状态映射和 finalizer，覆盖 `queued/running/cancelled/succeeded/failed/expired`。
- [ ] Task 3：补火山 content builder，覆盖文本、首帧、首尾帧、多模态参考、`asset://`、公网 URL、Base64 的 payload。
- [ ] Task 4：补 IP 创建 route，复用权限、视频卡、点数冻结、预算、快照、ledger，但 provider 改为火山。
- [ ] Task 5：补 IP 查询 route，成功时转存视频/尾帧、写官方 usage、结算点数、生成缩略图。
- [ ] Task 6：补 IP 本地列表 route，并让 `/generate/ip` 最近任务只看火山任务。
- [ ] Task 7：补 IP 取消 route，区分“取消火山任务”和“本地移除记录”。
- [ ] Task 8：改 `/generate/ip` 前端提交、轮询、列表、取消按钮到 `/api/ip/...`；普通 `/generate` 不改。
- [ ] Task 9：给 IP 页素材输入补 `asset://` 能力和火山限制提示，禁止普通真人脸参考图作为付费提交入口。
- [ ] Task 10：补配置页/后台提示，显示火山 API Key、模型、service tier、回调、转存是否就绪。
- [ ] Task 11：补测试和 smoke，验证 IP 链路不会访问旧 `/api/tasks/create`，普通生成页仍访问旧链路。
- [ ] Task 12：拿到 API Key 后，先只跑配置检查和 mock；真实生成必须再次获得用户明确付费授权。

### 验收标准

- [ ] `/generate` 普通生成页提交、轮询、列表、删除行为不变。
- [ ] `/generate/ip` 提交时只请求 `/api/ip/tasks/create`。
- [ ] IP 任务创建成功后，本地 `VideoTask.provider='volcengine_ark'`，并保存火山 `provider_task_id`。
- [ ] IP 任务查询只调用火山 `GET /api/v3/contents/generations/tasks/{id}`。
- [ ] IP 最近任务列表只显示火山任务，不混入普通生成任务。
- [ ] `succeeded` 后 24 小时内完成 `video_url` 和 `last_frame_url` 转存，任务卡使用转存后的稳定地址。
- [ ] `expired` 会结算为失败/超时并退回冻结点数，不会无限轮询。
- [ ] `cancelled` 会正确退回冻结点数，并在 UI 上显示已取消。
- [ ] 火山 `usage.completion_tokens`、`total_tokens`、`tool_usage.web_search` 写入成本/用量快照。
- [ ] 未配置 API Key、模型未开通、素材不公网可达、普通真人脸素材、素材数量/大小/时长超限，都有明确中文错误。
- [ ] 无用户明确授权时，不跑真实付费火山生成。

### 验证命令

- [ ] `git diff --check`
- [ ] `npx tsc --noEmit --pretty false`
- [ ] `npm run lint`
- [ ] `npm run build`
- [ ] 新增 smoke：`node scripts/smoke/volcengine-ip-provider-smoke.mjs`
- [ ] 新增 smoke：`node scripts/smoke/ip-generate-routing-smoke.mjs`
- [ ] 部署时：`/Users/gouki-youdoo/.youdoo/bin/youdoo-sites build sd2`
- [ ] 部署时：`/Users/gouki-youdoo/.youdoo/bin/youdoo-sites restart sd2`
- [ ] 部署时：`/Users/gouki-youdoo/.youdoo/bin/youdoo-sites status sd2`
- [ ] 公网验证：`curl https://sd2.youdoodesign.com/api/config`
- [ ] 浏览器验证：`/generate` 和 `/generate/ip` 分别抓请求，确认两页走各自接口。

### 停止条件

- [ ] 如果火山 API Key 未拿到或模型未开通，只能做到 mock 和配置检查，不跑真实生成。
- [ ] 如果真实生成会消耗火山费用或站内点数，必须等用户明确授权。
- [ ] 如果发现必须改普通生成页接口才能接 IP 页，先停下重新拆路由，不直接改。
- [ ] 如果火山版权 IP 只能体验中心使用、API 暂未开放，IP 生成付费提交继续锁定，只保留配置和素材准备。
- [ ] 如果结果转存失败，不标记任务为最终完成；保留官方临时 URL 并提示 24 小时有效。
- [ ] 如果测试、构建或部署失败，不提交、不推送、不上线。

## 2026-06-24 无线画布项目 / 视频卡选择器治理规划

### 现象和根因

- 现象：无线画布顶部项目下拉里出现很多同名“我的默认项目”，用户无法判断这些项目分别是谁的、属于什么类型，也无法在当前位置新增或删减项目 / 视频卡。
- 根因 1：`src/app/api/tools/ultimate-canvas/bootstrap/route.ts` 当前对管理员返回所有 `active` 且非 `system` 的项目，`PROJECT_TAKE=20`，且按 `type + updated_at` 排序；管理员看到的是全站可生成项目，不只是自己的项目。
- 根因 2：多个用户或历史迁移可能都有同名默认项目；当前 `public/tools/ultimate-canvas/app.js` 用原生 `<select>` 只显示 `project.name`，没有 owner、头像、项目类型、任务数、图集数和权限动作，所以看起来像重复数据。
- 根因 3：普通生成页 `src/components/generate/GeneratePageClient.tsx` 已有更完整的项目选择器：项目名前有头像、重复名显示 owner、新建项目、归档 / 删除空项目、项目管理入口；无线画布没有复用这个交互口径。
- 根因 4：视频卡在普通生成页已支持选择和新建，但无线画布只是原生 `<select>`；同时后端目前只有 `POST /api/projects/:id/video-cards` 创建和 `PATCH /api/video-cards/:id` 更新状态，没有直接删除视频卡接口，所以“删减视频卡”必须优先设计为归档 / 废弃，而不是硬删历史记录。

### 目标

- 无线画布不是独立后台，项目和视频卡选择必须和普通生成页保持同一套规则、同一套权限、同一套视觉识别。
- 所有项目项目前面都挂头像：真实头像优先，没有头像时用稳定首字母 / 颜色头像占位。
- 同名项目必须能区分 owner、项目类型和历史内容；不要只显示一串相同名称。
- 下拉菜单内支持新增项目、删除空项目、归档有内容项目。
- 视频卡下拉内支持新增视频卡、查看视频卡、归档 / 废弃不再使用的视频卡；有生成记录的视频卡不得硬删。
- 切换项目 / 视频卡后，画布保存、生成 payload、素材 workspace、历史面板和点数归属都必须同步到新上下文。

### 推荐方案

- 不继续扩展原生 `<select>`；改成无线画布自己的轻量下拉面板，视觉和交互对齐普通生成页 `composer-project-picker`。
- 第一阶段保留无线画布静态 JS 架构，不迁移 React；先在 `public/tools/ultimate-canvas/app.js` 和 `styles.css` 内实现项目 / 视频卡菜单组件。
- 数据仍通过 `bootstrap` 拉取，但 `bootstrap` 要补齐普通生成页已经依赖的字段：项目 owner、`_count.tasks`、`_count.reference_albums`、`can_manage_project`、视频卡 owner、summary、状态。
- 项目新增 / 删除 / 归档直接复用现有接口：`POST /api/projects`、`DELETE /api/projects/:id`、`PATCH /api/projects/:id`。
- 视频卡新增复用 `POST /api/projects/:id/video-cards`；视频卡删减先复用 `PATCH /api/video-cards/:id` 把状态改为 `archived` 或 `discarded`，必要时再补专门的“空视频卡删除”接口。

### Phase 1：补齐 bootstrap 数据口径

- [ ] 修改 `src/app/api/tools/ultimate-canvas/bootstrap/route.ts`：项目列表 include `owner` 和 `_count.tasks/reference_albums`，返回字段对齐 `GeneratePageClient` 的 `ProjectOption`。
- [ ] 修改 `bootstrap` 项目权限字段：返回 `can_generate`、`can_manage_project`、`can_manage_assets`，管理员也必须明确 owner，而不是只返回 `my_role=admin`。
- [ ] 修改 `bootstrap` 项目显示逻辑：个人默认项目前端统一显示为“个人空间”，原始 `project.name` 保留为调试字段，避免一堆“我的默认项目”直接暴露。
- [ ] 修改 `bootstrap` 项目排序：优先当前用户自己的 personal/team/company，再显示参与项目；管理员需要查看全站项目时放入“其他项目”分组，不混在自己的默认项目前面。
- [ ] 修改 `bootstrap` 视频卡列表：include `owner`、summary task count、状态、规格字段，返回是否可生成、是否可归档 / 废弃。
- [ ] 验证：未登录 `/api/tools/ultimate-canvas/bootstrap` 仍为 401；登录态管理员返回项目必须能区分 owner；普通用户只能看到自己有权限生成的项目。

### Phase 2：项目下拉改为头像 + 动作面板

- [ ] 修改 `public/tools/ultimate-canvas/app.js`：把 `renderContextControls()` 内的项目原生 `<select>` 替换成自定义 `canvas-context-menu`。
- [ ] 项目触发器显示：头像 + 项目显示名 + 项目类型 / 任务数 / 图集数；没有项目时显示“选择项目”。
- [ ] 项目列表每一项显示：头像、项目显示名、owner 名、项目类型、任务数、图集数、当前选中勾选。
- [ ] 同名项目必须显示 owner；即使不同名，也保留头像，满足“项目前面都挂头像”的统一规则。
- [ ] 项目菜单顶部加入“新建项目”按钮；展开内联表单，调用 `POST /api/projects`，成功后重新 `loadCanvasBootstrap(newProject.id, null)` 并自动选中新项目。
- [ ] 项目菜单项右侧加入“删除 / 归档”动作：空项目调用 `DELETE /api/projects/:id`；有任务或图集的项目调用 `PATCH /api/projects/:id` 归档；默认项目和无权限项目不显示危险动作。
- [ ] 删除 / 归档必须二次确认；确认弹窗说明“有历史内容只能归档，不能硬删”。
- [ ] 项目切换后清空当前 `selectedVideoCardId`，重新拉取视频卡；如果当前画布文档属于旧项目，提示用户“切换项目会加载该项目最近画布 / 或创建新画布”，不能静默把旧画布保存到新项目。
- [ ] 修改 `public/tools/ultimate-canvas/styles.css`：新增项目菜单、头像、动作按钮、确认态样式；移动端不横向溢出。

### Phase 3：视频卡下拉支持新增和删减

- [ ] 修改 `public/tools/ultimate-canvas/app.js`：把视频卡原生 `<select>` 替换成和项目菜单一致的面板。
- [ ] 视频卡触发器显示：视频卡标题、规格摘要、状态；没有视频卡时显示“选择 / 新建视频卡”。
- [ ] 视频卡列表每一项显示：标题、目标、状态、比例、时长、分辨率、生成次数、owner 头像。
- [ ] 视频卡菜单顶部加入“新建视频卡”按钮；内联表单字段至少包含标题、视频目标，可选规格后续再补；调用 `POST /api/projects/:projectId/video-cards`。
- [ ] 新建视频卡成功后自动选中，更新 `canvasRuntime.selectedVideoCardId`，重新 `loadCanvasBootstrap(projectId, newCard.id)`，并触发 `scheduleCanvasSave('video_card_create')`。
- [ ] 视频卡菜单项加入“查看视频卡”入口，跳到 `/projects/:projectId/video-cards/:cardId`。
- [ ] 视频卡菜单项加入“归档 / 废弃”动作：有任务记录的卡走 `PATCH /api/video-cards/:id` 改 `archived`；无任务卡可先走 `discarded`，是否补 DELETE 接口需单独评估数据库关系。
- [ ] 如果后端当前不允许把 active/draft 改成 `archived/discarded`，先补最小 `PATCH` 支持和权限校验，不新增破坏性 DELETE。
- [ ] 已封存 `sealed`、已归档 `archived`、已合并 `merged` 的视频卡默认不允许生成，只能查看。
- [ ] 删除 / 归档当前选中的视频卡后，自动选择同项目下一张可生成卡；没有可用卡时禁用图片 / 视频生成并提示创建视频卡。

### Phase 4：普通生成页口径抽象复用

- [ ] 抽出项目显示纯函数，避免普通生成页和无线画布各写一套：`projectDisplayName`、`projectMetaLabel`、`projectOwnerUser`、`projectRemovalAction`。
- [ ] 建议新增 `src/lib/projects/display.ts` 或同等 helper；普通生成页和无线画布 bootstrap / 前端展示都复用。
- [ ] 抽出视频卡显示纯函数：状态文案、规格摘要、是否可生成、是否可归档。
- [ ] 如果无线画布继续保持静态 JS，后端可以在 bootstrap 里直接返回 `display_name`、`meta_label`、`removal_action`、`owner`，避免静态 JS 重写过多业务判断。
- [ ] 保持普通生成页现有行为不回归；无线画布只是对齐，不改变 `/generate` 的主流程。

### Phase 5：验证和闭环

- [ ] 本地验证：`git diff --check`。
- [ ] 类型验证：`npx tsc --noEmit --pretty false`。
- [ ] Lint：`npm run lint`。
- [ ] 构建：`npm run build`。
- [ ] 静态 JS 语法：`node --check public/tools/ultimate-canvas/app.js`。
- [ ] 登录态页面验证：管理员进入 `/tools/ultimate-canvas`，项目菜单中每个项目都有头像、owner、类型和动作；同名“个人空间”能区分 owner。
- [ ] 普通用户验证：只能看到自己可生成项目；无权限项目不出现危险动作。
- [ ] 新建项目验证：无线画布菜单内新建项目后自动选中，并能继续新建视频卡。
- [ ] 项目删除 / 归档验证：空项目可删除；有任务或图集项目只能归档；默认项目不可删除。
- [ ] 新建视频卡验证：菜单内创建后自动选中；生成按钮解除“缺少归属”。
- [ ] 视频卡归档 / 废弃验证：归档当前卡后不能继续生成，自动切换到下一张可用卡或提示新建。
- [ ] 线上闭环：`youdoo-sites build sd2`、`youdoo-sites restart sd2`、公网 `/api/config`、`/login`、`/tools/ultimate-canvas` 登录保护、跨健康守护周期。
- [ ] Git 闭环：聚焦提交、推送 `codex/v12-full-todo`、创建并推送 rollback tag、登记 `/Volumes/Data/Projects/project-version-registry.md`。

### 风险和停止条件

- 如果发现“我的默认项目”实际是历史重复 personal 项目数据，而不是多用户默认项目，只规划 UI 区分还不够，必须另开数据清理任务；清理前要备份数据库并确认任务 / 图集归属。
- 如果删除项目会影响任务、图集、成本账本或资产归属，不允许硬删，只能归档。
- 如果视频卡存在任务、成本、最终版或分支，不允许硬删，只能归档 / 废弃。
- 如果无线画布切换项目会把旧画布文档保存到新项目，必须先修保存隔离，不能继续做生成接入。
- 如果普通生成页和无线画布在项目权限、点数归属、视频卡可生成状态上出现差异，以普通生成页现有后端权限为准，不在无线画布里绕过。

### 当前结论

- 截图里的“很多我的默认项目”不是用户应该直接承受的 UI；短期要先用头像、owner、分组和项目类型消除歧义。
- 中期要把无线画布项目 / 视频卡选择器提升到普通生成页同等级能力：新增、删除 / 归档、查看、自动选中、权限提示。
- 不建议为了“看起来少一点”简单限制数量或隐藏项目；这会掩盖管理员全站视角和历史同名项目问题，后续生成归属仍会混乱。

## 2026-06-26 IP 生成页火山官方 API 正式接入执行

### 范围

- [x] 保持普通生成页 `/generate` 原提交、查询、列表、软删除链路不变。
- [x] `/generate/ip` 作为独立新页面，复用普通生成页项目、视频卡、模板、提示词、参考图、点数冻结和失败返还能力。
- [x] 火山 API Key、Model ID、Base URL 从 `/admin/integrations` 的 API 整合页读取，前端不接触密钥。

### 已落地

- [x] 新增 `src/lib/provider/volcengine-ip.ts`：按官方 Ark `POST/GET/DELETE /contents/generations/tasks` 封装创建、查询、列表、删除。
- [x] 新增 IP 专用创建接口 `src/app/api/ip/tasks/create/route.ts`，复制普通生成创建链路后只替换 provider 调用。
- [x] 新增 IP 专用状态接口 `src/app/api/ip/video/status/[id]/route.ts`，只允许查询 `provider='volcengine_ark'` 的任务。
- [x] 新增 IP 专用列表接口 `src/app/api/ip/video/list/route.ts`，最近任务只显示火山 IP 任务。
- [x] 新增 IP 专用取消接口 `src/app/api/ip/tasks/[id]/cancel/route.ts`，调用火山 DELETE 后走本地点数返还。
- [x] `src/lib/video/task-finalizer.ts` 和 `src/lib/video/local-cache.ts` 增加 provider 分派：普通任务走旧 Seedance，IP 任务走火山查询和 URL 转存。
- [x] `/generate/ip` 前端提交、轮询、最近任务切到 `/api/ip/...`，普通页面仍走 `/api/tasks/create`、`/api/video/...`。
- [x] 新增 `scripts/volcengine-ip-provider-smoke.ts`，mock 验证 480p、4 秒、参考图、创建/查询/列表/删除四个官方接口路径。
- [x] 普通 `/api/video/list` 排除 IP 任务，避免普通生成页最近任务混入火山 IP 记录。
- [x] 普通 `/api/video/status/[id]` 和 `/api/video/retry/[id]` 拒绝 IP 任务，避免详情页误走普通生成重试。
- [x] IP 状态接口改为白名单响应，不直接返回 raw provider response、params 或 source metadata。
- [x] IP 创建接口幂等命中时校验 provider，避免同一幂等键跨普通生成和 IP 生成复用。
- [x] IP provider 按火山官方示例调整 `content` 顺序：文本项在前，参考图片/视频/音频在后。
- [x] 火山 200 响应里的错误体会按失败处理；创建失败记录火山错误码，模型/权限/素材类失败返回 JSON 4xx，避免公网 502 纯文本导致前端拿不到错误。

### 真实测试护栏

- [x] 真实测试最多创建 3 个火山视频任务；本轮只做 2 次提交尝试，未继续发第 3 个。
- [x] 每个真实任务必须是 `resolution=480p`、`duration=4`、至少 1 张参考图；两次提交均符合。
- [x] 第 1/2 个真实任务因模型权限失败后停止，不继续消耗第 3 个名额。
- [x] 同一个用例重试必须复用原幂等键或只查状态，不能新增第 4 个任务；`ip-real-acceptance-20260626-02` 幂等复查返回已有任务。
- [ ] 真实任务完成后必须确认本地任务状态、火山 `provider_task_id`、结果 URL/本地转存、缩略图和点数结算；当前阻断在火山 `ModelNotOpen`，没有生成 `provider_task_id`。

### 验证

- [x] `npx tsx scripts/volcengine-ip-provider-smoke.ts`
- [x] `npx tsc --noEmit --pretty false`
- [x] `git diff --check`
- [x] `npm run lint`
- [x] `npm run build`
- [x] `youdoo-sites build sd2`
- [x] `youdoo-sites restart sd2`
- [x] 公网 `/generate/ip` 未登录跳转登录，生产包包含 IP 页面和 `/api/ip/...` 路由。
- [x] 公网 `/api/ip/video/list` 未登录保护正常；登录态只返回 `provider='volcengine_ark'` 任务。
- [x] 火山配置接口登录态显示 ready，Model ID 已校正为 `doubao-seedance-2-0-260128`，API Key 已配置且不回显。
- [x] 火山 List API 200，说明 API Key、Base URL 和 Bearer 鉴权可用。
- [x] 最多 3 个真实火山任务验收：提交 2 次，均未获得火山 `provider_task_id`；第二次火山返回 `ModelNotOpen`，账号未开通当前模型，冻结点数已自动退回。
- [ ] 模型在火山 Ark Console 开通后，再跑第 3 个也是最后一个真实任务，继续保持 480p、4 秒、带参考图、幂等键。

## 2026-06-26 视频播放卡顿与下载慢修复落地

### 根因

- [x] 已确认卡顿主因是视频分发仍走本机 `public/videos` + `sd2.youdoodesign.com` 隧道；本机 1MB Range 很快，公网同片段明显变慢。
- [x] 已确认缩略图路由会在浏览时触发完整 mp4 缓存，是任务页/资源页加载慢的放大因素。
- [x] 已确认批量 ZIP 对 mp4 使用高压缩等级，收益极低但会增加等待。

### 已落地

- [x] `VideoTask` 增加 `public_video_url/public_video_storage_*` 等字段，并同步 SQLite schema。
- [x] 新增 `src/lib/video/public-delivery.ts`，生成成功后优先转存 R2/TOS；未配置对象存储时标记慢速备用，不把本地公网目录误判为快速播放源。
- [x] `src/lib/video/task-finalizer.ts` 成功任务本地缓存后自动触发 public video delivery。
- [x] `/api/video/play/:id` 优先 302 到 `public_video_url`，旧本地 Range 和 Provider URL 保留兜底。
- [x] `/api/assets/library`、任务列表、任务详情、IP 状态接口补齐 public video 字段。
- [x] 任务详情页优先播放/下载对象存储 URL；转存中显示“视频准备中”；对象存储未配置时显示“慢速备用播放”。
- [x] 资源管理页视频预览增加 `preload="metadata"`。
- [x] 缩略图路由不再在浏览请求里调用 `cacheTaskVideoToLocal()` 下载完整 mp4；无本地视频时只允许尾帧图片兜底。
- [x] 批量下载 mp4 ZIP 改为 `compressionLevel: 0`。
- [x] 新增 `scripts/backfill-public-video-delivery.ts`，默认 dry-run，`--apply` 才处理历史任务。
- [x] 新增 `scripts/check-video-public-delivery-rules.ts`，防止 `local-public` 默认被误当成快速视频分发。

### 验证/部署

- [x] `npx tsx scripts/check-video-public-delivery-rules.ts`
- [x] `npx tsx scripts/backfill-public-video-delivery.ts --limit 5`
- [x] `npx tsc --noEmit --pretty false`
- [x] `npm run lint`
- [x] `npm run build`
- [x] R2 已配置，已跑 `npx tsx scripts/backfill-public-video-delivery.ts --limit 5 --apply`，5/5 成功写入 `public_video_url`。
- [x] `youdoo-sites build sd2 && youdoo-sites restart sd2` 已完成，公网 `/api/video/play/:id` 已 302 到 R2 URL。
- [ ] R2 dev 域名 Range 测速仍波动偏慢，需评估 R2 自定义域/CDN 或 TOS 国内可访问域名。

## 2026-07-01 跨用户重复图片上传不显示修复

### 根因

- [x] 已确认 `/api/assets/upload` 会按文件 hash 复用其他用户已有 Asset，但后续 `/api/workspace/assets` 在归档参考图时仍按 `Asset.owner_id` 拦截，返回 `reference_asset_forbidden`。
- [x] 已确认上传历史 `/api/assets/history` 只查当前用户自己的 Asset；如果继续返回其他用户的 Asset id，历史列表也不会显示刚上传的图。

### 已落地

- [x] `Asset.hash` 从全站唯一改为 `owner_id + hash` 唯一，并保留 hash 普通索引。
- [x] 跨用户重复上传时不重复上传文件，只给当前用户创建自己的 Asset 记录，复用同一个 `original_url/thumbnail_url`。
- [x] `/api/assets/upload` 返回 `reused`，便于前端和调试判断是否复用。
- [x] 参考图集上传统一走 `uploadSiteAsset`，避免图集和工作台重复实现不同的 hash 复用规则。
- [x] 新增工作区重复上传 smoke，覆盖“别人已有同图 -> 当前用户上传 -> 历史可见 -> 加入工作区/参考图成功”。

### 验证/部署

- [x] `npx prisma generate`
- [x] `npx prisma db push --accept-data-loss`
- [x] `npx tsx scripts/site-upload-dedupe-smoke.ts`
- [x] `npx tsx scripts/workspace-duplicate-upload-smoke.ts`
- [x] `npx tsx scripts/reference-album-duplicate-upload-smoke.ts`
- [x] `npx tsx scripts/reference-album-duplicate-upload-integration.ts`
- [x] `npx tsc --noEmit --pretty false`
- [x] `npm run lint`
- [x] `npm run build`
- [x] `youdoo-sites build sd2 && youdoo-sites restart sd2` 已完成，BUILD_ID `b55InuVW1hopeSQRgTb-s`。
- [x] 公网真实复现通过：跨用户重复上传返回当前用户 Asset，上传历史可见，加入工作区成功。

## 2026-07-01 15s/720p 生成中卡单后台收尾修复规划

### 已确认现象

- [x] 用户反馈的 15s / 720p 任务最吻合 `cmr1o6u8s0038f05laf0wpqic`，Provider 任务为 `cgt-20260701140354-2lvln`。
- [x] Provider 只读查询已返回 `succeeded` 和视频地址，但本地 `VideoTask.local_status` 仍是 `running`，`provider_status` 仍是 `unknown`。
- [x] 后台日志显示 `VideoLocalizationRunner` 在 20 分钟后停止：`Max runtime reached`，本地最后更新时间停在 `2026-07-01 14:23:51`。
- [x] 当前真实自动化目录没有看到 `sd2-finalize-pending-videos`，和旧 todo 里“已纳入 Codex cron 自动化”的记录不一致，需要重新核对和恢复真实定时执行。

### 目标

- 新生成任务不依赖用户打开生成页或任务详情页，也能最终从 `submitted/running` 自动变成 `succeeded/failed/cancelled`。
- Provider 已成功时，本地必须自动写回视频地址、完成本地/公开分发、生成缩略图并结算冻结点数。
- Provider 明确失败时，本地必须自动失败收尾、释放冻结点数并写退款流水。
- 同一个任务被详情页、补偿脚本或定时任务重复触发时，点数结算只能执行一次。
- 超过合理时间仍没有明确结果的任务，不再无限安静显示“生成中”，后台要能看到异常数量和待处理任务。

### P0：先补当前卡单

- [x] 只读列出所有 `local_status in ('submitted','running')` 且有 `provider_task_id` 的任务，按创建时间、更新时间、冻结点数和 Provider 当前状态分组。
- [x] 对 `cmr1o6u8s0038f05laf0wpqic` 执行一次受控收尾：复用 `src/lib/video/task-finalizer.ts`，不要手写状态和点数。
- [x] 验证该任务变为 `succeeded`，`result_video_url` 已写入，`completed_at` 有值，冻结点数已结算，`CreditLedger` 没有重复扣费或重复退款。
- [x] 对仍返回 `{}` 的新任务保留 `running`，但记录为“Provider 仍未给明确结果”，不提前退款。

### P0：恢复不会下班的后台查单

- [x] 核对现有 `scripts/finalize-pending-videos.ts` 是否覆盖 `running/submitted`、`succeeded 但缺本地视频` 两类任务；不足处只补最小逻辑。
- [x] 给项目增加一个明确可运行命令：`npm run video:finalize-pending`，内部调用现有脚本，不新增依赖。
- [x] 恢复真实定时执行：LaunchAgent `com.youdoo.sd2.finalize-pending-videos` 每 300 秒执行一次，调用 `/Users/gouki-youdoo/.youdoo/runtime/sd2-finalize-pending-videos.sh`。
- [x] 频率定为每 5 分钟一轮，每轮限制处理数量、总运行时间和单个缓存下载超时，避免多个大视频同时下载拖垮站点。
- [x] 每轮日志只记录任务 ID、状态、计数和错误类型；Seedance API Key 和签名 URL 已脱敏。

### P0：保证点数和状态不会算乱

- [x] 为 `finalizeVideoTaskStatus()` 增加或补齐幂等验证：同一个成功任务重复 finalize，成功扣点流水只能出现一次。
- [x] 为失败/取消路径补齐幂等验证：同一个失败任务重复 finalize，冻结点数只能释放一次。
- [x] 覆盖 Provider 返回 `{}` 的路径：不改成失败、不结算点数，只更新可观察状态或保留下轮继续查。
- [x] 覆盖 Provider 返回 `succeeded` 但本地缓存/缩略图失败的路径：任务状态成功和点数结算不能被缓存失败卡住，缓存失败进入后续补偿。

### P1：异常可见和用户提示

- [ ] 在现有健康接口或后台增加“长时间生成中”统计：超过 30/60/90 分钟的 running 任务数量、冻结点数总额、最老任务时间。
- [ ] 任务详情页对超过阈值的任务显示明确文案：`生成时间较长，后台仍在自动检查`；不要只让用户看到普通“生成中”。
- [ ] 后台列表能筛选“长时间生成中 / Provider 空返回 / 本地待收尾”三类任务，方便管理员处理。

### 验证方式

- [x] 运行只读 dry-run：列出将被收尾的任务，不修改数据库。
- [x] 对当前已成功但本地 running 的任务执行真实补偿，并验证数据库、视频地址、点数流水和页面状态。
- [x] 跑最小回归：`npx tsc --noEmit --pretty false`、`npm run lint`、`npm run build`。
- [x] 部署后验证：`youdoo-sites build sd2`、`youdoo-sites restart sd2`、公网 `/api/config` 和 `/login` 正常。
- [x] 用真实或受控任务验证：LaunchAgent 重新加载后 `runs=1`，`last exit code=0`，可继续自动查单。

### 2026-07-01 落地结果

- `cmr1o6u8s0038f05laf0wpqic` 已从 `running` 收尾为 `succeeded`，`frozen_cost=0`，`actual_cost=45`，本地视频和 R2 公开视频均已写入。
- 发现并补偿旧孤儿任务 `cmpkxpuqx003xd14k1ct7m4vg`：提交后没有 Provider 任务号，已标记 `failed`，返还冻结 84 点，并写入 `task_failed_refund` 流水。
- 火山 IP provider 的非重试错误会落为失败并释放冻结点数，避免 provider 错误一直把任务留在 `running`。
- 后台收尾脚本现在优先处理 `submitted/running`，再处理最近 7 天成功但缺本地缓存的视频；旧过期签名 URL 不再每轮反复拖慢批处理。
- 定时执行载体已恢复为 LaunchAgent：`com.youdoo.sd2.finalize-pending-videos`，每 300 秒执行一次；已重新加载并验证退出码为 0。
- 仍保留的 P1：后台健康统计、任务详情长时间等待提示、后台筛选能力尚未做，本轮不扩大到 UI 可视化。

### 停止条件

- Provider 返回内容包含不应打印的签名 URL、密钥或 token 时，先脱敏再继续。
- 发现点数流水已重复扣费或重复退款时，停止自动补偿，先做账务核对。
- 发现真实定时任务没有稳定运行位置时，不伪装成已修复；先确认自动化载体再部署。
- 构建、回归或线上健康检查失败时，不提交、不部署、不标记完成。
