# 主图与导航反馈优化

| 字段 | 内容 |
|---|---|
| 项目 | video-api-debugger |
| 工单版本 | v1.0.0 |
| 正式版本来源 | package.json、src/lib/release.ts、生产/api/release；开工v0.36.2，发布前重新锁定 |
| 正式资料目录 | /Volumes/Data/Projects/video-api-debugger |
| 实施/部署源 | /Users/gouki-youdoo/.codex/worktrees/canvas-liblib-layout/video-api-debugger；codex/canvas-liblib-layout；开工HEAD77e450138d06823ff92369c28bdc64ea9d09949e，干净 |
| 目标 | https://sd2.youdooart.com/template-studio?type=image；I4确切入口https://sd2.youdooart.com/generate |
| 状态 | 工单先完成，直接实施I1-I4后整批发布，功能由用户手动验收 |
| 风险/验证等级 | 真实debug+UI守门员L3，生产切换按L4保护；旧general/L0不采纳；禁止主动浏览器/业务验收与独立审核线程 |
| 创建/最后更新 | 2026-10-03，北京时间；文件名保留2026-10-02反馈日期 |

## 目标与完整原文

用户先要求“写工单”，后明确“写完直接开改”。主图更容易看清，满额后不显示无效添加位，手机和平板能找组、模块和全部封面。追加视频比例、秒数、分辨率三个灰色控件，恢复合法选择，不改变模型限制。

来源：正式SD2后台Feedback只读快照，2026-10-02 23:07北京时间读取，两条均new；不改状态、不写DB。raw仅私有本地保存，姓名不上传Git。

| ID | 北京时间 | 页面 | 完整原文 | 附件 |
|---|---|---|---|---|
| cmuqyowne0027vg4vr3xyks6m | 2026-10-02 20:51:09 | /template-studio?type=image | 主图的。缩略图大小稍微大个30%左右。一旦锁定了。张数后面就不要再出现添加主图的这个图标。 | 无 |
| cmuqyq5xo002fvg4vjhbp6aar | 2026-10-02 20:52:08 | /template-studio?type=image | 考虑一下手机平板的用户。这个导航条根本没法用。 | 1张原图 |

2026-10-03对话追加：“等下，还有一个，为什么我现在改变不了视频生成页面的时间秒数和比例了？”随后：“灰色，点不开，”，及“左右加这个，这三个都用不了”。

第三条用户截图/标注事实（由主控传递，不是本lead浏览器操作）：/generate，1068x873；Seedance2.0、首尾帧，提示词为空且无参考图；1:1、15s、480p三chip灰色，15s为button.composer-chip.composer-chip-disabled；精确selector为div.composer-action-bar:nth-of-type(5) > div.composer-chips:nth-of-type(1) > div.composer-chip-wrap:nth-of-type(4) > button.composer-chip.composer-chip-disabled。45点生成按钮也disabled、图集控件正常。用户未提供视频卡状态。原截图当前仅父会话可见，无path/attachmentHandle，主控尝试导出；尚未归档，不以新截图替代，不因缺原件阻塞修复。

## 现状与根因判断

- 主图四列materialGrid；达到currentReferenceCap后添加按钮仅disabled，仍可见。没有独立主图业务锁，按已设置有效数量上限解释；满额隐藏、删图后合法余量恢复，不新增业务锁。
- 历史依据：[主图规则原文](2026-10-01-feedback-template-assets-dialogs.md)：独立编号、最少/最多、零主图兼容、总10张；辅助不能替代主图，视频首尾帧保持专用角色。
- 小屏flex侧栏仍嵌套全部子模块竖列且按钮width100%，存在缩窄和高度占用风险；原截图是问题参考，非本轮复现验收。
- I4已读源码：ComposerActionBar三chip分别disabled={ratioLocked/lockedDuration/lockedResolution}，不共用canSubmit、提示词或参考图gate。GeneratePageClient把所选视频卡ratio/duration/resolution全部交给lockedSettings，再由GenerationComposer按存在值禁用。Seedance2.0不是2.5跟随首帧比例规则；核对自动选中的fallback卡、ratio_locked及历史限制，先确认错误锁来源，不能随意解除真实交付锁。
- 诊断入口：GenerationComposer.tsx、ComposerActionBar.tsx、ParamChip.tsx、generate/GeneratePageClient.tsx、VideoTemplateWorkbench.tsx、handoff及近期diff。最终原因和证据补在实施记录。

### I4阶段结论（2026-10-03）

已确定代码原因：GeneratePageClient.tsx:2031-2036把视频卡存在的比例、时长、分辨率直接作为lockedSettings；GenerationComposer.tsx:2217-2219再按Boolean判锁；ComposerActionBar.tsx:309、337、365分别禁用三chip。loadVideoCards:983-991会自动选中一张可用视频卡。因此用户无需主动选卡，也可能被规格禁用。三chip不使用canSubmit/空提示词/无参考图作为disabled条件，Seedance2.0也不触发仅2.5首尾帧的比例跟随规则。

权限边界证据：src/app/api/tasks/create/route.ts:966只在videoCard.ratio_locked为真且比例不一致时拒绝；当前UI却只要ratio有值就锁，未看ratio_locked。时长与分辨率的三chip锁没有对应的同类卡规格校验。修复方向：普通参数与真正交付锁分开，比例遵循ratio_locked、保留合法模型限制与1080p审批，时长/分辨率不因存在推荐规格误禁用；不改服务器规则。当前具体选中卡/ratio_locked未读生产数据，不宣称已复现或已恢复三个控件。

阶段原因已向主控回报，用户随后明确恢复I1-I4完整实施与统一发布；已开始源码整批修改，发布尚未启动。工单正文/固定todo/索引已落盘；W1尚待聚焦Git，第三用户原截图由主控待归档。

## 范围与禁区

图片三项限定templateWorkbench/image Surface；保留独立/image-studio、video及桌面。I4只修视频参数UI控制/同步/状态误锁，不改Provider、计费、模型能力、登录、权限、DB、上传归属或后台。不装依赖、不付费生成、不浏览器控制/截图、不功能自动回归、不独立审核线程。生成按钮仍受合法输入检查。

复用既有组件、lucide、原生select、CSS、ProductDialog/useDialogDismiss与工作现场持久化。必要popup保留外部/Esc关闭、未保存保护，主操作明确；没有新增时间戳界面，不巡改近时。复用ReleaseNotice的严格SemVer、稍后去重、手动检测及刷新保护，不建平行更新系统。

## 任务对账

| 编号 | 任务 | 完成标准 | 状态 |
|---|---|---|---|
| W1 | 编写反馈优化工单 | 正式归档、附件齐全、范围清楚、提交推送 | 进行中：正文/索引落盘，第三条截图原件待归档，待Git |
| I1 | 主图缩略图放大 | 约增大30%，不影响其他图 | 未开始 |
| I2 | 锁定后的添加入口 | 按既有数量规则隐藏，不改变限制 | 未开始 |
| I3 | 手机和平板导航 | 组、模块可触达，桌面保留 | 未开始 |
| I4 | 视频秒数与比例不可改排查修复 | 原因明确，合法选项可选，不改模型限制 | 进行中：扩充包括分辨率，定位disabled |
| D1 | 发布更新 | 构建、版本、公网检查通过，待手动验收 | 未开始 |

### 整批实现记录（2026-10-03，v0.36.3待发布）

I1-I4源码实现已完成，以上状态待统一发布检查后更新；未做功能验收。改动文件与内容：

| 文件（相对唯一源码） | 内容 |
|---|---|
| src/app/image-studio/studio.tsx | templateWorkbench主图区限定样式、满额不渲染添加位；小屏两级原生select及全部封面；桌面与小屏共用导航动作、当前模块高亮；既有会话状态增加封面视图，显式moduleId仍优先 |
| src/app/image-studio/studio.module.css | 主图三列单格calc(32.5% - 7.8px)，相对原四列(100% - 24px)/4恰为1.3倍；800px下保持原360px网格上限；1200px以下仅模板图片工作台使用两行44px触控导航，避免嵌套列表撑高 |
| src/components/template-studio/template-studio.module.css | 图片顶部栏1200px断点与小屏导航一致，视频样式不变 |
| src/components/generate/GeneratePageClient.tsx | videoCardDefaults与lockedSettings分开，后者只有ratio_locked=true且合法比例时传入；duration/resolution不再冒充锁 |
| src/components/GenerationComposer.tsx | 每个选中卡ID只带入一次推荐值，晚到推荐不覆盖已编辑参数，历史复用/工作台交接优先；真实锁仍单独同步，参数及默认偏好后续变化不会解除真实比例锁；可见原因说明；模型能力与1080p审批不改 |
| package.json、package-lock.json | 只同步根版本元数据PATCH0.36.3，无依赖变动 |
| src/lib/release.ts | 与唯一package版本一致，更新用户可感知摘要，复用ReleaseNotice |

ReleaseNotice已读源码：同channel严格数字SemVer、更高版本才弹、稍后按origin/project版本去重、前台/5分钟检测、/account手动检测重新打开、刷新前ProductDialog确认、外部/Esc关闭、标题“发现新版本”6字加粗20px均已有；不新建平行机制，真实升级交互待用户手动确认。

已读Radix NavigationMenu源文件NavigationMenuProvider value/onItemSelect、Primitive.nav aria-label及分组/焦点模式，已读React useEffect依赖与清理示例。实际方案用已有状态+原生select而非接入Radix复杂菜单（MIT公开项目只借鉴模式，不复制或装依赖）；MDN flex-shrink解释小屏flex挤压，但两级选择直接避免全部嵌套列表。源码阅读不是功能验证。导航长期返回模块由既有TemplateStudioShell账号隔离localStorage位置负责，组/当前模块/封面同标签恢复仍复用既有sessionStorage，不另建重复状态系统。

- [ ] I1：只在主图区约+30%、比例稳定、响应式换列；辅助/风格/固定图不放大。
- [ ] I2：沿用有效上限隐藏满额添加位；保留删除、预览、排序、已有重新选图行为；合法余量恢复。
- [ ] I3：小屏分组/模块分层选择，当前高亮/计数和全部封面可达；不挤中文竖排或所有子模块占满高度，复用工作现场。
- [ ] I4：定位三参数锁定原因，恢复合法选项；有效交付约束与模型限制保留，空提示词/参考图不得禁参数。
- [ ] D1：整批后统一build内置lint/type、diff/源码边界、自行Review；聚焦commit/push/rollback、候选构建切换、公网检查及记录。

## 资料与附件

| 原文件名 | 来源/用途 | 正式绝对路径 | 版本/校验 |
|---|---|---|---|
| feedback.json | 后台只读快照；两条完整原文/ID/时间 | /Volumes/Data/Projects/video-api-debugger/docs/materials/2026-10-02-feedback-template-workbench/feedback.json | v1.0.0，完整JSON已读；私有本地 |
| 48c4aa41c3bae255821ef8a6f972e91b9422054cd2744fdc16f0250a4d0b56b4.jpg | 第二条反馈原导航截图 | /Volumes/Data/Projects/video-api-debugger/docs/materials/2026-10-02-feedback-template-workbench/48c4aa41c3bae255821ef8a6f972e91b9422054cd2744fdc16f0250a4d0b56b4.jpg | 2584x1828、415273字节，已看且本地/服务器SHA与文件名相同，无变化复用校验；不公开 |
| 2026-10-01-feedback-template-assets-dialogs.md | 主图/辅助/视频已确认历史边界 | /Volumes/Data/Projects/video-api-debugger/tasks/todo/2026-10-01-feedback-template-assets-dialogs.md | 已按需读原文，历史v0.32.0/三分区记录，不巡查旧附件 |
| 视频三参数标注截图（原名未知） | 2026-10-03用户会话，/generate三chip灰色；1068x873 | 待归档到/Volumes/Data/Projects/video-api-debugger/docs/materials/2026-10-03-feedback-video-parameters/；目前无可访问原件路径 | 原件未归档/未校验；父负责导出；文字事实已登记，不用其他图替代 |

无音视频附件；第一条无图不伪造。[唯一资料索引](../../docs/materials/index.md)。raw、姓名与图片不公开Git。

## 方案依据与适配

优先原生select/CSS，无依赖。已查官方[MDN flex-shrink](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/flex-shrink)、[React useEffect](https://react.dev/reference/react/useEffect)及[Radix NavigationMenu源码](https://github.com/radix-ui/primitives/blob/main/packages/react/navigation-menu/src/navigation-menu.tsx)，实际读用片段补在实施记录。只借鉴可访问性/状态同步，不移植库，不引入体积/安装/许可证接入。已读代码不等于功能验收。

## 发布检查与用户验收

仅发布build内置lint/type、git diff --check、脚本语法、后端等价、版本来源一致及更新提醒源码检查。预计PATCH0.36.3，真实生产与并发锁复核后确定，同批不重复抬号。整体自行Verify→Review，非独立审查；项目手动边界优先。

服务器42.193.221.253 gouki；sd2-gray.service3302；/srv/video-api-debugger/app；archive commit到releases。排env/node_modules/.next*/storage/uploads/videos/DB/运行期。候选.next-prod-candidate，禁止原地构建live.next-prod，保留旧source/build回退。复用已有部署锁/登记；后端等价则图片worker不重启。版本/服务/公网失败停止或恢复旧版。

用户手动检查：主图约+30%且其余图未变；满额添加位消失、删图后合法余量恢复；手机平板可选组/模块/全部封面、刷新保留现场；/generate三参数在模型支持及无真实交付锁时可选，空输入只禁生成按钮。已有更换/删除/预览/排序及更新提醒仍可用。工程发布检查不表示功能通过；反馈仍new。

## Git Plan与停止条件

正式ROOT codex/mediakit-video-enhance开工419154173797a5d569708f40f8994af541bc2044，只归档工单/索引/todo自有hunk；旧August todo脏改和untracked保留。应用从77e450138d06823ff92369c28bdc64ea9d09949e聚焦实现，push已有origin，不force。正式正文不可只存worktree，可留应用副本。提交前复核remote/status，raw/原图/私人姓名不上传。

生产漂移、并发锁冲突、构建失败、运行数据/权限风险、付费/DB/Provider等超授权时停相关动作，其他独立安全项继续。未知业务状态不授权解除真实锁；原件缺口不阻塞UI发布。无内部派工工具，不建侧栏任务绕过，由唯一lead统一处理共享文件。

## 可复制交接正文

```text
主图导航与视频参数修复
项目video-api-debugger，目标https://sd2.youdooart.com/template-studio?type=image，I4确切目标https://sd2.youdooart.com/generate。
正式工单：/Volumes/Data/Projects/video-api-debugger/tasks/todo/2026-10-02-feedback-primary-navigation.md。
唯一源码：/Users/gouki-youdoo/.codex/worktrees/canvas-liblib-layout/video-api-debugger，不用正式ROOT旧应用或v12。
附件feedback.json（完整原文）及48c4aa41c3bae255821ef8a6f972e91b9422054cd2744fdc16f0250a4d0b56b4.jpg（导航参考）在/Volumes/Data/Projects/video-api-debugger/docs/materials/2026-10-02-feedback-template-workbench/，仅本机不公开。10月3日视频原截图仅父会话可见、原件待归档，不伪造路径。
先工单/索引，再整批I1主图约+30%、I2有效上限隐藏添加位、I3手机平板导航、I4比例/时长/分辨率错误禁用修复，不改模型限制。
整批后统一发布build内置检查、自行Review，聚焦commit/push/rollback、候选服务器切换、公网版本/BUILD/静态可达。用户手动验收；不浏览器/截图/功能回归/付费生成/DB写/登录点数Provider权限变更/装依赖。
构建/服务异常、漂移/锁冲突、数据权限风险即停或回退；回执含正式工单、逐文件内容/diff、原因、命令结果、版本commit/tag/BUILD、公网证据及未验收项。
```
