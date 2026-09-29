# V1.2 剩余模块落地 Todo

## 当前入口

- [ ] 2026-09-29：模板工作台0.20.0已发布。后续0.20.1重做目录遭用户拒绝，已回退0.20.0；该候选与回退记录保留分支`codex/template-studio-20260929`（4bb7398），不得随本轮修复重发。正确目标是保留图片生成原结构，只在侧栏增加视频大类及折叠小类；共享项进入原列表，但不得公开内部上下文。该布局任务暂缓。
- [ ] P1：旧共享模板列表、套用副本和模块DTO仍可能返回内部context，回退不代表保密修复；模板管理的external+admin访问边界也存在既存契约失败。两项不属于P01手势修复，保持待办，不称安全闭环。

## M01 图片模型简称与生成者（2026-09-29）

| 编号 | 任务 | 完成标准 | 状态 |
|---|---|---|---|
| M01 | 统一模型简称与头像 | 显示指定简称，生成者头像与资产库一致，上线可见 | 进行中 |
| M02 | 鼠标位置缩放 | 放大缩小围绕鼠标位置，拖动和关闭不受影响 | 进行中 |

- 用户指定结果卡模型简称为 `ba2`、`baPro`、`img2`、`img2.5-F`、`img2.5-S`，仅改显示映射，不改真实模型ID、费用或请求参数；模板图片结果与资产库共用简称字典，悬停模型仍可查看完整名称。
- 图片结果复用资产库 `UserIdentityBadge` 与卡片头像尺寸，显示实际任务生成者头像和姓名，缺失或加载失败沿用首字占位；保持侧栏、预览、下载和生成入口。任务查询依旧按当前获准owner过滤，仅增加该任务owner的安全展示字段，不新增跨用户访问、不返回邮箱或凭据、不改上下文。
- 实现/测试全部完成后统一跑简称与owner隔离测试、既有UI烟测、tsc/lint；随后从0.20.4接续发布0.20.5，保留回退点，核对公网正式页真实头像与模型简称。无新依赖、数据库迁移、付费生成。
- M02用户补充：缩放必须以鼠标为轴心。普通预览原来已有单次滚轮定位公式，但横/纵对比错误使用总stage中心，连续事件分离更新scale/offset还有旧值风险。使用同一view函数式更新，按鼠标所在pane中心换算；缩放按钮/键盘沿用最近画面指针位置，未指向画面才回退中心；移除transform延迟以免移动鼠标时追赶旧位置。保留拖动防误关、Esc/背景关闭、还原和对比联动。参考[anvaka/panzoom实际zoomByRatio实现](https://github.com/anvaka/panzoom/blob/main/index.js)，现有共享组件已具备行为，无需替换或新增依赖。
- 统一本地验证：`node --import tsx scripts/image-studio-result-identity-smoke.ts`通过，真实listStudioTasks配内存Prisma验证五简称/模型ID不变、owner查询隔离、DTO仅id/name/avatar_url、失去owner时null；未连接真实DB。`image-studio-ui-smoke.ts`、`npx tsc --noEmit`、`npm run lint`通过（仅既存警告）。
- 扩展`image-preview-drag-browser-smoke.ts`使用真实组件、CSS和Chrome鼠标wheel，单图及横/纵对比两侧的放大/缩小、键盘/按钮、同批次滚轮、0.5x/6x极限均保持鼠标下像素误差<0.25px；拖动/背景轻点/Esc/按钮关闭回归通过，无外网/生成调用。首轮测试误把小数坐标当成MouseEvent整数坐标，最大倍数时出现3px测试误差，校正测量点后通过，未为此改业务代码。旧884d81a组件相同测试在键盘轴心环节失败，证实回归脚本能识别旧行为。
- 固定审核001发现鼠标捕获拖出stage后会保存区域外坐标（回执将M01/M02编号写反，实际属于M02）；新增命中区域校验，离开预览区域保留最后有效缩放点，并补真实拖出后按钮缩放回归。首个5624a83候选已构建但未上线，待此修正统一复测后用新提交替换；不重复抬版本，不覆盖生产数据。
- 修正后完整缩放/拖动浏览器脚本通过；同一脚本对5624a83在“outside drag must retain last in-stage y anchor”失败，确认新增回归能复现审查问题。固定审核001已静态复核防护通过，M01 owner隔离结论也通过；不把静态审查冒充页面验收。

## S01 分组侧栏整理（2026-09-29）

| 编号 | 任务 | 完成标准 | 状态 |
|---|---|---|---|
| S01 | 整理左侧分组栏 | 不遮挡标题、滚动条弱化，原有上下滚动和导航保持可用 | 已完成 |

- 用户确认保留侧边与页面上下翻动；只整理标注侧栏，不重做模板目录、不修改上下文、分组选择或生成接口。原图与来源见[资料索引](../docs/materials/index.md)。
- 原因：侧栏固定top73px与实际顶部导航48px不一致，模板工作台标题没有为236px侧栏留位，原生白底滚动条未按深色侧栏适配。修正为复用导航高度变量、仅图片模式标题左侧留268px（与原内容起点一致），侧栏细灰滚动条及小幅组间距调整。不添加滚轮拦截、页面滚动锁或新依赖，保留滚动条可拖动。窄屏保留既有横向导航，仅避免粘性导航被顶部栏挡住。
- 复用现有原生overflow滚动，参考[MDN scrollbar-color](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/scrollbar-color)及WebKit兼容样式；不用新滚动库，不隐藏滚动条。
- 0.20.3生产接续候选0.20.4；统一验证原CSS的真实wheel侧栏/页面独立滚动、首尾可达、标题无重叠、手机不被桌面留白挤窄，关联banner/UI回归、类型/lint、候选构建、正式页只读DOM/滚动验收。不付费、不写生产数据，保留0.20.3回退。
- 两份真实CSS Module隔离编译的Chrome测试通过：1617×873侧栏与页面真实wheel互不影响，侧栏末项可达；1294×698标题不重叠、侧栏高度随窗口适配；390×844保留既有横向导航，标题没有桌面缩进残留。banner 9项与旧UI smoke通过；[合成布局图](../docs/materials/2026-09-29-sidebar/sidebar-layout-fixture.png)已查看。不读取私有上下文，不把合成DOM称为生产截图。
- 发布：`npx tsc --noEmit`、`npm run lint`、`git diff --check`通过（lint只有既存警告）。产品提交`884d81af3f7e8430efdc0bd42b8d4a48c64e09e7`与`rollback/2026-09-29-before-sidebar-scroll`→`ca6b417`远端可见；归档SHA256 `153fa5f5903485c8963e8d16959b08a02e938e3c7136c91f681299344b375a73`本地/服务器一致。候选数据库副本构建通过，v0.20.4 / BUILD_ID `Y-OqOk0NnSCyINO2So0Lm`上线；三服务active，源站/公网config、release、login、登录页13资源200；0.20.3回退构建保留于`backups/sidebar-scroll-884d81af3f7e8430efdc0bd42b8d4a48c64e09e7/live-build`，未迁移/覆盖数据库或媒体。
- 正式登录态Chrome 1200×753：顶部栏bottom48，侧栏top48/width236/height705，模板标题x302（侧栏right236），scrollbar-width thin、灰色透明轨道。侧栏PageDown后scrollTop134、window.scrollY0且末项可见；右侧PageDown后window.scrollY713、侧栏仍134/top48；点击第二子模块后对应activeLabel正确、目标标题进入视口，分组仍正确。无输入变更、无生成；临时聚焦标题编辑后已离开且nameEditing=false。自有浏览器会话已停止，用户原标签页未改。
- 旧客户端v0.20.3手动检查更新真实出现v0.20.4、正确摘要和20px/700字重的5字标题；“稍后”关闭后仍为旧版，手动检查可再次打开；新页面DOM显示v0.20.4。复用既有自动检测与刷新前确认代码，无新增机制；周期/自动前台触发本轮未等待重测。此项未读取上下文或整页截图，生产以目标DOM与键盘滚动行为为证，合成截图承担布局视觉核验。

## B01 模块 banner 高度（2026-09-29）

| 编号 | 任务 | 完成标准 | 状态 |
|---|---|---|---|
| B01 | 修复 banner 过大 | 横幅高度受控，不挤走下面内容，验证上线 | 已完成 |

- 用户在`/template-studio?type=image`标记模块banner过大；浏览器标记截图仅在会话中可见，无可访问附件路径，未声称已归档原文件。来源为本轮浏览器标注，主题：横幅过高，后续可按B01检索；证据中的私有内容不复制到公开资料。
- 原因：图片100%宽度、auto高度且无上限，横幅高度随容器宽和图片比例增长。只把已有图片横幅限制为桌面180px、手机120px，使用原有contain完整等比显示（[MDN依据](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/object-fit)）；空态保持96px，图片、模板、上下文、上传/删除逻辑与页面结构不改。不引入新库。
- 从0.20.2生产代码接续，候选0.20.3；统一验证真实CSS下桌面/宽屏/手机的横竖方图、按钮边界和工作区位置，旧UI脚本、类型/lint、候选构建、公网资源及登录态DOM。保留0.20.2回退，不改生产数据库或调用模型。
- 统一测试首轮发现新脚本的TS类型缺失和tsx回调序列化`__name`问题，集中修正脚本后布局9/9通过：桌面1617/2560横幅180px、手机390横幅120px，图片contain、两按钮容器内无重叠、无横向溢出、工作区间距24px；[合成截图](../docs/materials/2026-09-29-banner/banner-layout-fixture.png)已查看。旧UI smoke和lint通过，lint仅既存警告；未改产品行为去迁就测试。
- `npx tsc --noEmit`复测通过；产品提交`ca6b4176e37c87bd3cc8c5bb6103f2cf1a7dd374`及回退标签`rollback/2026-09-29-before-banner-height`→`f2f6558`远端已核对。归档SHA256 `b639b052da1614bae3ad34608773dfe0e5f991cc5dc7be0281415d1b8f50ec2a`两端一致；隔离数据库副本构建成功，v0.20.3 / BUILD_ID `IqD4sIESqRrsbQn9GBDLc`已上线，三服务active，源站与公网config/release/login及登录页13静态资源通过。旧构建保留于服务器`backups/banner-height-ca6b4176e37c87bd3cc8c5bb6103f2cf1a7dd374/live-build`；更新通知复用原ReleaseNotice（代码核对），未新增提醒机制，真实旧客户端弹窗本轮未单独复测。
- 登录态Chrome独立窗口实测用户标记模块`module-default-cmpipakyk001nmt1wx4t7wxzg`：桌面1200×753 banner180px/图片178px，contain，workspace top502px、banner bottom478px；手机390×844 banner120px/图片118px，contain，workspace top730.8px、banner bottom706.8px，均留24px间距。浏览器release API200/0.20.3与真实新尺寸相符；未单独读页面内版本标记。因局部截图工具需要整页语义快照，避免采集私有内容，本轮视觉截图仅用真实CSS合成图，线上以目标DOM尺寸为证，不声称已有生产截图。自有会话已停止，无业务写入或付费调用。

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
