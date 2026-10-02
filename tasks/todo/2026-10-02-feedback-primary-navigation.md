# 主图与导航反馈优化

| 字段 | 内容 |
|---|---|
| 项目 | video-api-debugger |
| 工单版本 | v1.0.0 |
| 正式版本来源 | package.json、src/lib/release.ts、生产/api/release；开工v0.36.2，发布前重新锁定 |
| 正式资料目录 | /Volumes/Data/Projects/video-api-debugger |
| 实施/部署源 | /Users/gouki-youdoo/.codex/worktrees/canvas-liblib-layout/video-api-debugger；codex/canvas-liblib-layout；开工HEAD77e450138d06823ff92369c28bdc64ea9d09949e，干净 |
| 目标 | https://sd2.youdooart.com/template-studio?type=image；I4确切入口https://sd2.youdooart.com/generate |
| 状态 | I1-I5代码整批已写，已恢复统一检查及发布；I6故障阶段已明确、底层原因留待查，功能由用户手动验收 |
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
- I4已读源码：ComposerActionBar三chip分别disabled={ratioLocked/lockedDuration/lockedResolution}，不共用canSubmit、提示词或参考图gate。GeneratePageClient把所选视频卡ratio/duration/resolution全部交给lockedSettings，再由GenerationComposer按存在值禁用。Seedance2.0不是2.5跟随首帧比例规则；核对自动选中的fallback卡、ratio_locked及历史限制，原判断已被10月3日最新取消业务锁要求替代，实际模型能力限制保留。
- 诊断入口：GenerationComposer.tsx、ComposerActionBar.tsx、ParamChip.tsx、generate/GeneratePageClient.tsx、VideoTemplateWorkbench.tsx、handoff及近期diff。最终原因和证据补在实施记录。

### I4阶段结论（2026-10-03）

已确定代码原因：GeneratePageClient.tsx:2031-2036把视频卡存在的比例、时长、分辨率直接作为lockedSettings；GenerationComposer.tsx:2217-2219再按Boolean判锁；ComposerActionBar.tsx:309、337、365分别禁用三chip。loadVideoCards:983-991会自动选中一张可用视频卡。因此用户无需主动选卡，也可能被规格禁用。三chip不使用canSubmit/空提示词/无参考图作为disabled条件，Seedance2.0也不触发仅2.5首尾帧的比例跟随规则。

权限边界证据：src/app/api/tasks/create/route.ts:966只在videoCard.ratio_locked为真且比例不一致时拒绝；当前UI却只要ratio有值就锁，未看ratio_locked。时长与分辨率的三chip锁没有对应的同类卡规格校验。历史修复方向曾保留ratio_locked，现已被最新明确要求替代：三个参数均在模型合法范围自由选择；撤销UI业务锁及tasks/create对应比例业务锁拒绝，保留模型限制、1080p审批和历史存储字段，无迁移或DB写。当前具体选中卡/ratio_locked未读生产数据，不宣称已复现或已恢复三个控件。

阶段原因已向主控回报，用户随后明确恢复I1-I4完整实施与统一发布；已开始源码整批修改，发布尚未启动。工单正文/固定todo/索引已落盘；W1尚待聚焦Git，第三用户原截图由主控待归档。

## 范围与禁区

图片三项限定templateWorkbench/image Surface；保留独立/image-studio、video及桌面。I4修视频参数UI控制/同步并撤销生成接口相应比例业务锁校验；I5只查相关模板上下文/参数的有效内容dirty和共享关闭路径；I6仅日志、回执、SQLite mode=ro/query_only读，不改Provider、计费、模型能力、登录、权限、DB、上传归属或后台。不装依赖、不付费生成、不浏览器控制/截图、不功能自动回归、不独立审核线程。生成按钮仍受合法输入检查。

复用既有组件、lucide、原生select、CSS、ProductDialog/useDialogDismiss与工作现场持久化。必要popup保留外部/Esc关闭、未保存保护，主操作明确；没有新增时间戳界面，不巡改近时。复用ReleaseNotice的严格SemVer、稍后去重、手动检测及刷新保护，不建平行更新系统。

## 任务对账

| 编号 | 任务 | 完成标准 | 状态 |
|---|---|---|---|
| W1 | 编写反馈优化工单 | 正式归档、附件齐全、范围清楚、提交推送 | 进行中：正文/索引已提交推送bc2ac3a，新增范围同步中；第三截图原件待归档 |
| I1 | 主图缩略图放大 | 约增大30%，不影响其他图 | 进行中：源码已写，待统一发布检查及手动验收 |
| I2 | 锁定后的添加入口 | 按既有数量规则隐藏，不改变限制 | 进行中：源码已写，待统一发布检查及手动验收 |
| I3 | 手机和平板导航 | 组、模块可触达，桌面保留 | 进行中：源码已写，待统一发布检查及手动验收 |
| I4 | 视频秒数与比例不可改排查修复 | 比例/秒数/分辨率合法选项自由选择，不加业务锁，不改模型限制 | 进行中：UI与生成接口业务锁均已撤销，推荐只初次/切卡带入，待统一检查及发布 |
| I5 | 模板上下文未修改关闭及同类误提醒 | 未改或改回原内容直接关闭，真正未保存修改保护保留 | 进行中：已统一主图规则字段/有效默认值，关闭按打开时有效配置比较，待统一检查及发布 |
| I6 | 线上多任务待确认根因排查 | 明确线上产物及故障阶段，证据与未知分开，不重试/改数据 | 进行中：两条请求阶段网络/超时已确认，回执无响应，底层原因未确证 |
| D1 | 发布更新 | 构建、版本、公网检查通过，待手动验收 | 进行中：I1-I5整批已写，执行最终统一build/selfReview；尚未上线 |

### 整批实现记录（2026-10-03，v0.36.3待发布）

I1-I5源码已写；I6故障阶段与日志缺口已记录，主控授权恢复本批UI发布，不改Provider等待/重试/积分或DB。未做功能验收。首轮统一build成功，自行Review发现首次自动选卡推荐值可能覆盖已保存偏好、全部封面触控选中态不明显，已集中补齐；第二轮本地build已结束成功，新增范围已整批补齐，执行最终统一构建。改动文件与内容：

| 文件（相对唯一源码） | 内容 |
|---|---|
| src/app/image-studio/studio.tsx | templateWorkbench主图区限定样式、满额不渲染添加位；小屏两级原生select及全部封面；桌面与小屏共用导航动作、当前模块高亮；既有会话状态增加封面视图，显式moduleId仍优先 |
| src/app/image-studio/studio.module.css | 主图三列单格calc(32.5% - 7.8px)，相对原四列(100% - 24px)/4恰为1.3倍；800px下保持原360px网格上限；1200px以下仅模板图片工作台使用两行44px触控导航，避免嵌套列表撑高 |
| src/components/template-studio/template-studio.module.css | 图片顶部栏1200px断点与小屏导航一致，视频样式不变 |
| src/components/generate/GeneratePageClient.tsx | 推荐默认值与锁已分离；ratio_locked控制分支已移除，三参数不再按卡规格禁用 |
| src/components/GenerationComposer.tsx | 每个选中卡ID只带入一次推荐值，首次恢复已保存偏好/晚到推荐不覆盖已编辑参数，历史复用/工作台交接优先；业务锁同步/模板冲突gate/锁定说明/控件disabled已移除；默认值仅初次或切卡带入，不持续覆盖用户编辑；模型能力与1080p审批保持 |
| src/app/api/tasks/create/route.ts | 仅删除videoCard.ratio_locked拒绝不同比例的4行；1080p审批、权限、模型校验、点数/Provider保持 |
| src/app/image-studio/studio.tsx（I5） | 主图规则显式固定字段顺序/补缺默认，基准与当前分辨率质量统一正规化、初始图片按主图/辅助一致排序；弹窗按打开时有效配置比较，不把外部提示词/张数草稿混入关闭保护；真正修改仍产品确认，X/外部/Esc共享路径；草稿hydration完成后允许打开 |
| package.json、package-lock.json | 只同步根版本元数据PATCH0.36.3，无依赖变动 |
| src/lib/release.ts | 与唯一package版本一致，更新用户可感知摘要，复用ReleaseNotice |

ReleaseNotice已读源码：同channel严格数字SemVer、更高版本才弹、稍后按origin/project版本去重、前台/5分钟检测、/account手动检测重新打开、刷新前ProductDialog确认、外部/Esc关闭、标题“发现新版本”6字加粗20px均已有；不新建平行机制，真实升级交互待用户手动确认。

已读Radix NavigationMenu源文件NavigationMenuProvider value/onItemSelect、Primitive.nav aria-label及分组/焦点模式，已读React useEffect依赖与清理示例。实际方案用已有状态+原生select而非接入Radix复杂菜单（MIT公开项目只借鉴模式，不复制或装依赖）；MDN flex-shrink解释小屏flex挤压，但两级选择直接避免全部嵌套列表。源码阅读不是功能验证。导航长期返回模块由既有TemplateStudioShell账号隔离localStorage位置负责，组/当前模块/封面同标签恢复仍复用既有sessionStorage，不另建重复状态系统。

- [ ] I1：只在主图区约+30%、比例稳定、响应式换列；辅助/风格/固定图不放大。
- [ ] I2：沿用有效上限隐藏满额添加位；保留删除、预览、排序、已有重新选图行为；合法余量恢复。
- [ ] I3：小屏分组/模块分层选择，当前高亮/计数和全部封面可达；不挤中文竖排或所有子模块占满高度，复用工作现场。
- [ ] I4：定位三参数锁定原因，恢复合法选项；取消比例/时长/分辨率业务锁，模型限制保留，空提示词/参考图不得禁参数。
- [ ] I5：打开未修改、修改后改回直接关闭；真正修改仍确认；字段顺序/默认初始化/对象实例不是dirty，相关全局设置与视频上下文按值比较无同类根因，未扩站巡改。
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

仅发布build内置lint/type、git diff --check、脚本语法、接口窄改审查及图片worker依赖不变、版本来源一致及更新提醒源码检查。预计PATCH0.36.3，真实生产与并发锁复核后确定，同批不重复抬号。整体自行Verify→Review，非独立审查；项目手动边界优先。

服务器42.193.221.253 gouki；sd2-gray.service3302；/srv/video-api-debugger/app；archive commit到releases。排env/node_modules/.next*/storage/uploads/videos/DB/运行期。候选.next-prod-candidate，禁止原地构建live.next-prod，保留旧source/build回退。复用已有部署锁/登记；后端等价则图片worker不重启。版本/服务/公网失败停止或恢复旧版。

用户手动检查：主图约+30%且其余图未变；满额添加位消失、删图后合法余量恢复；手机平板可选组/模块/全部封面、刷新保留现场；/generate三参数在模型支持范围均可选，视频卡业务锁不生效，空输入只禁生成按钮。已有更换/删除/预览/排序及更新提醒仍可用。工程发布检查不表示功能通过；反馈仍new。

I5同类源码检查：settings-controller.ts的samePrices按键和值比较，不依赖对象顺序；VideoContextEditor.tsx按context字符串比较并在加载后设基准，无该误提醒根因，未修改这些文件。I6建议未来仅在明确授权后保留脱敏的fetch底层错误码用于下一次协查；现有记录无法追溯，不为补证新生成。

## Git Plan与停止条件

正式ROOT codex/mediakit-video-enhance开工419154173797a5d569708f40f8994af541bc2044，只归档工单/索引/todo自有hunk；旧August todo脏改和untracked保留。应用从77e450138d06823ff92369c28bdc64ea9d09949e聚焦实现，push已有origin，不force。正式正文不可只存worktree，可留应用副本。提交前复核remote/status，raw/原图/私人姓名不上传。

生产漂移、并发锁冲突、构建失败、运行数据/权限风险、付费/DB/Provider等超授权时停相关动作，其他独立安全项继续。最新明确取消视频三参数业务锁，不扩大到主图容量或真实模型限制；原件缺口不阻塞UI发布。无内部派工工具，不建侧栏任务绕过，由唯一lead统一处理共享文件。


## 最新纠偏与I6事故证据（2026-10-03北京时间00:49核对）

用户完整原文：“不要设置锁定；模版生成图片部分，点开模版上下文后没有修改关闭，又会反复提醒没有保存是否确认，这是不合理的，直接关闭就行了，同类问题排查;”。此指令替代旧ratio_locked保留结论；I2主图数量容量规则不取消。I5按打开时加载并正规化后的有效值判断变化，初始化、对象实例/键顺序、打开关闭、改后改回不算未保存；X/外部/Esc共享关闭，真实修改保留产品内保护。

事故追加原文：“是不是我们今天改错了什么，导致生成失败，多个生成都这样”。截图为图片模板，主图1/1、其他0、总1/10，img2.5-S/最高/4K，“生成结果待确认”“冻结积分已释放”并不自动重复请求。截图仅问题证据，不能据此判定Provider失败。

- 线上从本地和公网核对均v0.36.2，commit f6478176fb34cefa432318f38ac521693bbdd2f6，BUILD OlWyIuDDh1fBfDOaID4Tt；生产从未切到本轮v0.36.3。sd2-gray和图片worker active，worker于10月2日19:26:26启动，异常时未见重启。
- 实际DB /data/video-api-debugger/var-lib/dev.db，以SQLite URI mode=ro加PRAGMA query_only=ON查询，无写入。两条gpt-image-2.5-sunburst/quality=max/2752x2960任务：ee2dca05…提交00:25:52，00:30:54待确认，日志request/network/301929ms；451f3ab2…排队创建00:26:16，实际提交00:30:56，00:35:56待确认，日志request/timeout/300046ms。省略任务ID只用于文字展示，完整ID在服务器原记录。
- 两条request.json只保留提交标记，无returnedAt、HTTP status或upstreamRequestId；没有source.json或image.part，因此证据位于等待HTTP响应阶段，不是已知的响应schema解析、原图下载/校验/保存故障。请求已尝试，但不能证明上游未执行或生成失败，禁止自动重发。
- 同日截至00:49相同模型7条：2待确认、4成功、1运行；异常之后4条已成功，其中3条同quality=max/2752x2960，不宣称全体失败或用户具体截图与某一ID一一匹配（截图未给ID）。
- 服务器worker/provider/delivery/limits四个源码SHA与f647提交逐一一致；该路径最后修改为05756192245111821ae7560b3aaf5041d119c693（10月2日17:55，v0.36.0）。父提交已存在300000ms上游响应等待及480000ms执行上限，v0.36.0未缩短它；后续v0.36.1/0.36.2未更改四文件。本轮未发布修改不是此次事故原因的证据，不等于证明历史改动绝无相关性。
- 确定结论：HTTP响应返回前的网络中断/等待超时；现有分类隐藏底层fetch异常，不能进一步断定网络链路、代理超时或上游慢响应。没有上游回执，不能宣称Provider故障。暂不改Provider、等待时长、账务、任务状态；若需进一步取底层错误/上游协查，须明确窄方案及风险交主控判断。事故排查阶段曾暂停所有生产切换；当前已按主控最新授权恢复I1-I5统一发布。

I6原件：/Volumes/Data/Projects/video-api-debugger/docs/materials/2026-10-03-feedback-generation-results/codex-clipboard-4f833484-e649-4fac-9224-20a130ea6102.png；来源用户本轮剪贴板图，父于10月3日归档，895x725 PNG sips可读，原件/复制SHA256均2fc4dcf6bbe59df8e36f836a1d1da658cd66c6f56f028ee50aee57769a5ccd02。复用父关键校验，不重复读取原图URL，不上传私人图片Git。此附件与未归档15s标注图不同。

## 可复制交接正文

```text
主图导航与视频参数修复
项目video-api-debugger，目标https://sd2.youdooart.com/template-studio?type=image，I4确切目标https://sd2.youdooart.com/generate。
正式工单：/Volumes/Data/Projects/video-api-debugger/tasks/todo/2026-10-02-feedback-primary-navigation.md。
唯一源码：/Users/gouki-youdoo/.codex/worktrees/canvas-liblib-layout/video-api-debugger，不用正式ROOT旧应用或v12。
附件feedback.json（完整原文）及48c4aa41c3bae255821ef8a6f972e91b9422054cd2744fdc16f0250a4d0b56b4.jpg（导航参考）在/Volumes/Data/Projects/video-api-debugger/docs/materials/2026-10-02-feedback-template-workbench/，仅本机不公开。10月3日视频原截图仅父会话可见、原件待归档，不伪造路径。
先工单/索引，再整批I1主图约+30%、I2有效上限隐藏添加位、I3手机平板导航、I4三个参数取消业务锁、I5未修改上下文直接关闭；I6线上事故优先只读排查，不改模型限制。I6阶段结论后主控明确恢复实现与统一发布。
整批后统一发布build内置检查、自行Review，聚焦commit/push/rollback、候选服务器切换、公网版本/BUILD/静态可达。用户手动验收；不浏览器/截图/功能回归/付费生成/DB写/登录点数Provider权限变更/装依赖。
构建/服务异常、漂移/锁冲突、数据权限风险即停或回退；回执含正式工单、逐文件内容/diff、原因、命令结果、版本commit/tag/BUILD、公网证据及未验收项。
```
