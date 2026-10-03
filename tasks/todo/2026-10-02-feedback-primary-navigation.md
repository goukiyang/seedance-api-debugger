# 主图与导航反馈优化

| 字段 | 内容 |
|---|---|
| 项目 | video-api-debugger |
| 工单版本 | v1.0.1 |
| 正式版本来源 | package.json、src/lib/release.ts、生产/api/release；开工v0.36.2，发布前重新锁定 |
| 正式资料目录 | /Volumes/Data/Projects/video-api-debugger |
| 实施/部署源 | /Users/gouki-youdoo/.codex/worktrees/canvas-liblib-layout/video-api-debugger；codex/canvas-liblib-layout；开工HEAD77e450138d06823ff92369c28bdc64ea9d09949e，干净 |
| 目标 | https://sd2.youdooart.com/template-studio?type=image；I4确切入口https://sd2.youdooart.com/generate |
| 状态 | I1-I5及N1/N2历史已部署；R1图片生成重复确认已部署v0.36.5、待用户手动验收；G1明确上游HTTP 502、内部原因未知，未修复 |
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

阶段原因已向主控回报，随后恢复并追加I5/I6；I1-I5现已部署，阶段历史不作当前状态。首稿正文/固定todo/索引bc2ac3a已推送；视频标注原图仍由主控待归档。

## 范围与禁区

图片三项限定templateWorkbench/image Surface；保留独立/image-studio、video及桌面。I4修视频参数UI控制/同步并撤销生成接口相应比例业务锁校验；I5只查相关模板上下文/参数的有效内容dirty和共享关闭路径；I6仅日志、回执、SQLite mode=ro/query_only读，不改Provider、计费、模型能力、登录、权限、DB、上传归属或后台。不装依赖、不付费生成、不浏览器控制/截图、不功能自动回归、不独立审核线程。生成按钮仍受合法输入检查。

复用既有组件、lucide、原生select、CSS、ProductDialog/useDialogDismiss与工作现场持久化。必要popup保留外部/Esc关闭、未保存保护，主操作明确；没有新增时间戳界面，不巡改近时。复用ReleaseNotice的严格SemVer、稍后去重、手动检测及刷新保护，不建平行更新系统。

## 任务对账

| 编号 | 任务 | 完成标准 | 状态 |
|---|---|---|---|
| W1 | 编写反馈优化工单 | 正式归档、附件齐全、范围清楚、提交推送 | 进行中：首稿bc2ac3a已推送，本轮正文/索引/证据齐备；视频标注原件仍待归档，不能称附件齐全 |
| I1 | 主图缩略图放大 | 约增大30%，不影响其他图 | 代码/部署已完成，发布检查通过，待用户手动验收 |
| I2 | 锁定后的添加入口 | 按既有数量规则隐藏，不改变限制 | 代码/部署已完成，发布检查通过，待用户手动验收 |
| I3 | 手机和平板导航 | 组、模块可触达，桌面保留；安全工作现场关闭重开恢复 | 导航与独立账号持久化均已部署，候选/最小发布检查通过，待用户手动验收 |
| I4 | 视频秒数与比例不可改排查修复 | 比例/秒数/分辨率合法选项自由选择，不加业务锁，不改模型限制 | 代码/部署已完成：三参数业务锁及接口拒绝已撤销，推荐只初次/切卡带入；待用户手动验收 |
| I5 | 模板上下文未修改关闭及同类误提醒 | 未改或改回原内容直接关闭，真正未保存修改保护保留 | 代码/部署已完成：规则字段/默认值正规化，关闭按打开时有效配置比较，保存后更新基准；待用户手动验收 |
| I6 | 线上多任务待确认根因排查 | 明确线上产物及故障阶段，证据与未知分开，不重试/改数据 | 阶段排查完成：两条请求阶段网络/超时、回执无响应；底层网络/代理/上游原因无法追溯待查 |
| D1 | 发布更新 | 构建、版本、公网检查通过，待手动验收 | 已完成：服务器候选build及内置lint/types、自行Review、Git回退/公网检查完成；已部署待手动 |

### 整批实现记录（2026-10-03，v0.36.3已部署待手动）

I1-I5源码已写；I6故障阶段与日志缺口已记录，主控授权恢复本批UI发布，不改Provider等待/重试/积分或DB。未做功能验收。首轮统一build成功，自行Review发现首次自动选卡推荐值可能覆盖已保存偏好、全部封面触控选中态不明显，已集中补齐；第二轮本地build已结束成功，新增范围补齐后本地编译成功，内置检查进程长期系统等待，安全终止；相同最终提交的服务器候选构建完成全部内置检查，未将本地中止冒充通过。改动文件与内容：

| 文件（相对唯一源码） | 内容 |
|---|---|
| src/app/image-studio/studio.tsx | templateWorkbench主图区限定样式、满额不渲染添加位；小屏两级原生select及全部封面；桌面与小屏共用导航动作、当前模块高亮；既有会话状态增加封面视图，显式moduleId仍优先 |
| src/app/image-studio/studio.module.css | 主图三列单格calc(32.5% - 7.8px)，相对原四列(100% - 24px)/4恰为1.3倍；800px下保持原360px网格上限；1200px以下仅模板图片工作台使用两行44px触控导航，避免嵌套列表撑高 |
| src/components/template-studio/template-studio.module.css | 图片顶部栏1200px断点与小屏导航一致，视频样式不变 |
| src/components/generate/GeneratePageClient.tsx | 推荐默认值与锁已分离；ratio_locked控制分支已移除，三参数不再按卡规格禁用 |
| src/components/GenerationComposer.tsx | 每个选中卡ID只带入一次推荐值，首次恢复已保存偏好/晚到推荐不覆盖已编辑参数，历史复用/工作台交接优先；业务锁同步/模板冲突gate/锁定说明/控件disabled已移除；默认值仅初次或切卡带入，不持续覆盖用户编辑；模型能力与1080p审批保持 |
| src/app/api/tasks/create/route.ts | 仅删除videoCard.ratio_locked拒绝不同比例的4行；1080p审批、权限、模型校验、点数/Provider保持 |
| src/app/image-studio/studio.tsx（I5） | 主图规则显式固定字段顺序/补缺默认，基准与当前分辨率质量统一正规化、初始图片按主图/辅助一致排序；弹窗按打开时有效配置比较，不把外部提示词/张数草稿混入关闭保护；真正修改仍产品确认，X/外部/Esc共享路径；草稿hydration完成后允许打开；保存成功更新打开基准，保存后继续修改仍保护 |
| package.json、package-lock.json | 只同步根版本元数据PATCH0.36.3，无依赖变动 |
| src/lib/release.ts | 与唯一package版本一致，更新用户可感知摘要，复用ReleaseNotice |

ReleaseNotice已读源码：同channel严格数字SemVer、更高版本才弹、稍后按origin/project版本去重、前台/5分钟检测、/account手动检测重新打开、刷新前ProductDialog确认、外部/Esc关闭、标题“发现新版本”6字加粗20px均已有；不新建平行机制，真实升级交互待用户手动确认。

已读Radix NavigationMenu源文件NavigationMenuProvider value/onItemSelect、Primitive.nav aria-label及分组/焦点模式，已读React useEffect依赖与清理示例。实际方案用已有状态+原生select而非接入Radix复杂菜单（MIT公开项目只借鉴模式，不复制或装依赖）；MDN flex-shrink解释小屏flex挤压，但两级选择直接避免全部嵌套列表。源码阅读不是功能验证。导航长期返回模块由既有TemplateStudioShell账号隔离localStorage位置负责，主控随后指出sessionStorage关闭标签页会丢失且独立页共享键会擦除coverView。现有Shell仅保存入口/模块链接，不能弥补；I3最小补齐仅templateWorkbench的localStorage键sd2-template-studio:image-view:v1:userId，首次兼容旧session状态，独立/image-studio仍原session键；恢复账号/surface就绪后才写，显式moduleId仍优先。不扩站改造。

- [ ] I1：只在主图区约+30%、比例稳定、响应式换列；辅助/风格/固定图不放大。
- [ ] I2：沿用有效上限隐藏满额添加位；保留删除、预览、排序、已有重新选图行为；合法余量恢复。
- [ ] I3：小屏分组/模块分层选择，当前高亮/计数和全部封面可达；不挤中文竖排或所有子模块占满高度，复用工作现场。
- [ ] I4：定位三参数锁定原因，恢复合法选项；取消比例/时长/分辨率业务锁，模型限制保留，空提示词/参考图不得禁参数。
- [ ] I5：打开未修改、修改后改回直接关闭；真正修改仍确认；字段顺序/默认初始化/对象实例不是dirty，相关全局设置与视频上下文按值比较无同类根因，未扩站巡改。
- [x] D1：整批后统一build内置lint/type、diff/源码边界、自行Review；聚焦commit/push/rollback、候选构建切换、公网检查及记录。

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

用户手动检查：主图约+30%且其余图未变；满额添加位消失、删图后合法余量恢复；手机平板可选组/模块/全部封面，刷新/关tab重开保留三项现场、独立图片页不擦记录，显式模块链接优先；/generate三参数在模型支持范围均可选，视频卡业务锁不生效，空输入只禁生成按钮。模块上下文未改或改回原值应直接关闭，真实改动仍确认；保存后继续编辑也保留保护，关闭按钮/外部/Esc一致。已有更换/删除/预览/排序及更新提醒仍可用。工程发布检查不表示功能通过；反馈仍new。

I5同类源码检查：settings-controller.ts的samePrices按键和值比较，不依赖对象顺序；VideoContextEditor.tsx按context字符串比较并在加载后设基准，无该误提醒根因，未修改这些文件。I6建议未来仅在明确授权后保留脱敏的fetch底层错误码用于下一次协查；现有记录无法追溯，不为补证新生成。

## Git Plan与停止条件

正式ROOT codex/mediakit-video-enhance开工419154173797a5d569708f40f8994af541bc2044，只归档工单/索引/todo自有hunk；旧August todo脏改和untracked保留。应用从77e450138d06823ff92369c28bdc64ea9d09949e聚焦实现，push已有origin，不force。正式正文不可只存worktree，可留应用副本。提交前复核remote/status，raw/原图/私人姓名不上传。

生产漂移、并发锁冲突、构建失败、运行数据/权限风险、付费/DB/Provider等超授权时停相关动作，其他独立安全项继续。最新明确取消视频三参数业务锁，不扩大到主图容量或真实模型限制；原件缺口不阻塞UI发布。无内部派工工具，不建侧栏任务绕过，由唯一lead统一处理共享文件。


## 最新纠偏与I6事故证据（2026-10-03北京时间00:49核对）

用户完整原文：“不要设置锁定；模版生成图片部分，点开模版上下文后没有修改关闭，又会反复提醒没有保存是否确认，这是不合理的，直接关闭就行了，同类问题排查;”。此指令替代旧ratio_locked保留结论；I2主图数量容量规则不取消。I5按打开时加载并正规化后的有效值判断变化，初始化、对象实例/键顺序、打开关闭、改后改回不算未保存；X/外部/Esc共享关闭，真实修改保留产品内保护。

事故追加原文：“是不是我们今天改错了什么，导致生成失败，多个生成都这样”。截图为图片模板，主图1/1、其他0、总1/10，img2.5-S/最高/4K，“生成结果待确认”“冻结积分已释放”并不自动重复请求。截图仅问题证据，不能据此判定Provider失败。

- 线上从本地和公网核对均v0.36.2，commit f6478176fb34cefa432318f38ac521693bbdd2f6，BUILD OlWyIuDDh1fBfDOaID4Tt；截至该事故核对时尚未切到本轮v0.36.3；后续发布结果见下方01:12回执。sd2-gray和图片worker active，worker于10月2日19:26:26启动，异常时未见重启。
- 实际DB /data/video-api-debugger/var-lib/dev.db，以SQLite URI mode=ro加PRAGMA query_only=ON查询，无写入。两条gpt-image-2.5-sunburst/quality=max/2752x2960任务：ee2dca05…提交00:25:52，00:30:54待确认，日志request/network/301929ms；451f3ab2…排队创建00:26:16，实际提交00:30:56，00:35:56待确认，日志request/timeout/300046ms。省略任务ID只用于文字展示，完整ID在服务器原记录。
- 两条request.json只保留提交标记，无returnedAt、HTTP status或upstreamRequestId；没有source.json或image.part，因此证据位于等待HTTP响应阶段，不是已知的响应schema解析、原图下载/校验/保存故障。请求已尝试，但不能证明上游未执行或生成失败，禁止自动重发。
- 同日截至00:49相同模型7条：2待确认、4成功、1运行；异常之后4条已成功，其中3条同quality=max/2752x2960，不宣称全体失败或用户具体截图与某一ID一一匹配（截图未给ID）。
- 服务器worker/provider/delivery/limits四个源码SHA与f647提交逐一一致；该路径最后修改为05756192245111821ae7560b3aaf5041d119c693（10月2日17:55，v0.36.0）。父提交已存在300000ms上游响应等待及480000ms执行上限，v0.36.0未缩短它；后续v0.36.1/0.36.2未更改四文件。本轮未发布修改不是此次事故原因的证据，不等于证明历史改动绝无相关性。
- 确定结论：HTTP响应返回前的网络中断/等待超时；现有分类隐藏底层fetch异常，不能进一步断定网络链路、代理超时或上游慢响应。没有上游回执，不能宣称Provider故障。暂不改Provider、等待时长、账务、任务状态；若需进一步取底层错误/上游协查，须明确窄方案及风险交主控判断。事故排查阶段曾暂停所有生产切换；当前已按主控最新授权恢复I1-I5统一发布。

I6原件：/Volumes/Data/Projects/video-api-debugger/docs/materials/2026-10-03-feedback-generation-results/codex-clipboard-4f833484-e649-4fac-9224-20a130ea6102.png；来源用户本轮剪贴板图，父于10月3日归档，895x725 PNG sips可读，原件/复制SHA256均2fc4dcf6bbe59df8e36f836a1d1da658cd66c6f56f028ee50aee57769a5ccd02。复用父关键校验，不重复读取原图URL，不上传私人图片Git。此附件与未归档15s标注图不同。


## 最终发布回执（2026-10-03北京时间01:28）

当前实际运行v0.36.3，commit **8315f02776290cda1c0f1e7286856d193f95dfca**，BUILD **TIe6lesNJcjyQirM3FMpx**；下方01:12 fbb8243/ytlm产物仅第一次整批发布历史，不是最新线上结果。

I3持久化补齐只改studio.tsx，版本/依赖/API/src/lib/Prisma/scripts均未改；新独立local键按模板图片surface与user隔离，旧session兼容迁移、恢复键就绪前不写旧账号状态，显式moduleId优先，无有效记录用默认值。单次最终commit服务器候选build及内置lint/types通过，自行Review通过；未重复全套功能/浏览器检查。公网最小核对20份相关静态和2份源码一致，config/release/login200、template-studio匿名307，X-SD2-Origin server-42-193，本机3健康检查200、4服务/定时器active，图片worker PID1241475及启动时间未变。已部署，待用户手动验收。

最新源码/rollback均已推送核对。额外回退标签rollback/2026-10-03-before-view-persistence-v0.36.3指向上一健康fbb8243371398ad753b66d8ff02ff8a0a6b9d84a，旧BUILD ytlmOyOpdCSahZQKCm07Y及/srv/video-api-debugger/app/.next-prod-before-sd2-feedback-v0363-view保留；原f647回退链也保留。归档包29184000字节、SHA256 40d143f85eb5ad39c5384e670896b68714634612d372eddb61543dee60b120a4，敏感资料排除通过；runId sd2-feedback-v0363-view，发布锁/COMPLETE会话均正常结束。完整最终与第一次整批证据合在[发布证据](2026-10-02-feedback-primary-navigation.evidence.json)，[统一diff](2026-10-02-feedback-primary-navigation.diff)刷新至最新累计改动。

W1视频标注原件仍待归档；I6仅故障阶段明确、底层网络/代理/上游无法追溯待查，不重试生成、不改积分或DB。I1-I5均代码/部署完成待用户手动；不以发布检查冒充功能通过。

## 同交付I3持久化补齐（2026-10-03）

主控静态纠偏：只共享session键，关闭标签页不会恢复且独立图片页写入时省略coverView。确认Shell不保存这三项；仅studio.tsx增加模板图片surface/user的local持久键与旧session迁移，账号切换就绪前不写旧状态，无有效记录用默认值、显式模块链接优先。独立页存储行为不扩改；无依赖。保持v0.36.3，01:12健康运行产物作为额外回退，最终候选及最小公网检查已完成，当前运行8315f02776290cda1c0f1e7286856d193f95dfca/BUILD TIe6lesNJcjyQirM3FMpx。

## 发布回执（2026-10-03北京时间01:12，第一次整批发布）

应用v0.36.3已部署，待用户手动验收。运行源码fbb8243371398ad753b66d8ff02ff8a0a6b9d84a；BUILD ytlmOyOpdCSahZQKCm07Y；分支codex/canvas-liblib-layout，远端已核对完整commit。回退标签rollback/2026-10-03-before-feedback-v0.36.3已推送，指向f6478176fb34cefa432318f38ac521693bbdd2f6。旧源码release及旧BUILD OlWyIuDDh1fBfDOaID4Tt保留，旧构建路径/srv/video-api-debugger/app/.next-prod-before-sd2-feedback-v0363，保护记录/srv/video-api-debugger/backups/sd2-feedback-v0363。

[统一diff](2026-10-02-feedback-primary-navigation.diff)、[发布证据JSON](2026-10-02-feedback-primary-navigation.evidence.json)正式根目录与应用树副本同步。证据为发布检查，不是功能验收；W1仍缺视频标注原件，I6底层原因未确认。

| 实际命令/检查 | 结果 |
|---|---|
| npm run build（先前I1-I4两轮本地日志） | 两次exit0；范围随后变更，不冒充最新完整证明 |
| npm run build > /tmp/sd2-feedback-v0363-batch-final-build.log | 新增I5后编译成功，lint/types阶段两个进程系统等待超过7分钟；安全TERM结束自有进程/接回session，无遗留，不称完整通过 |
| git diff --check、git diff --cached --check；package/lock JSON根版本和依赖图对比；bash -n部署脚本、node --check核对脚本 | 通过，依赖图未变；除release元数据和明确取消比例锁API外，图片worker依赖/脚本/Prisma/登录Provider等未改 |
| 自行Review实际11文件整批diff | 已核对I1/2范围、响应式级联、推荐初次/切卡与偏好优先、取消UI锁与API一致；补齐保存后继续编辑的基准刷新，检查全局设置/视频上下文按值比较无同根因；无独立reviewer、无浏览器/功能回归 |
| git commit、git push origin应用分支和rollback标签、git ls-remote | fbb8243371398ad753b66d8ff02ff8a0a6b9d84a及rollback指向f6478176fb34cefa432318f38ac521693bbdd2f6远端可见；首稿正式ROOT bc2ac3a7aa6c4af193152e1f761f5f276d9036f9已推送 |
| git archive最终提交；tar目录/敏感路径排除校验；scp到server /tmp | 首包卫生检查拦下旧资料图片，未上传；一次有界修正排除整个docs/materials后通过：1325项、29030400字节、SHA256 7251116efab10e01418e90f421262971be6ab7e64341232ceaf6dc1163d8c8cb；不含.env/运行目录/DB/私人资料 |
| 现有发布活动登记和服务器flock，核对实际commit/BUILD | 通过；用已有root SSH密钥执行发布管理，不读取密码，gouki运行构建/应用；未改用户权限 |
| release中NEXT_DIST_DIR=.next-prod-candidate npm run build | 完整exit0，内置lint/types通过，候选标记包括小屏导航/推荐默认值/模块设置关闭保护，新BUILD不同于旧版；只在candidate构建，不动live构建 |
| API精确差异守卫及worker依赖核对 | 仅tasks/create旧比例锁4行删除，其他API及scripts/Prisma/src/lib（release.ts除外）与旧release一致；不能称全backend等价；worker PID1241475及启动时间/服务单元前后一致，不重启图片worker |
| rsync排除运行数据、保留旧构建、切换/restart sd2-gray.service | 成功，storage/uploads/videos软链接和关键可写目录保持；本地就绪后才结束发布会话，失败自动恢复旧source/BUILD的trap保留 |
| /tmp/sd2-feedback-v0363-verify.mjs核对本机+公网 | exit0：20源码SHA、27公网静态SHA一致；config/release/login均200、release0.36.3、X-SD2-Origin server-42-193；受保护/image-studio、/template-studio、/generate匿名307到登录，权限未扩大；共享CSS200一致；4服务/定时器active |
| 发布COMPLETE握手/活动登记 | DEPLOY_COMPLETE，server会话exit0，发布锁已释放；停止额外功能验证，待用户手动验收 |

未运行npm test/test:api、Playwright/DOM/浏览器/生成实验/独立审查；未安装依赖、改登录点数权限/Provider、DB写或任务重发；I4仅用户明确取消的接口业务锁4行。发布检查及更新提醒源码核对不能代替真实升级交互和功能验收。守门员真实debug+UI L3/生产保护L4；旧general/L0误分类由主控纠正并记录，本lead未使用低等级放行。

## 可复制交接正文

```text
主图导航与视频参数修复
项目video-api-debugger，目标https://sd2.youdooart.com/template-studio?type=image，I4确切目标https://sd2.youdooart.com/generate。
正式工单：/Volumes/Data/Projects/video-api-debugger/tasks/todo/2026-10-02-feedback-primary-navigation.md。
唯一源码：/Users/gouki-youdoo/.codex/worktrees/canvas-liblib-layout/video-api-debugger，不用正式ROOT旧应用或v12。
附件feedback.json（完整原文）及48c4aa41c3bae255821ef8a6f972e91b9422054cd2744fdc16f0250a4d0b56b4.jpg（导航参考）在/Volumes/Data/Projects/video-api-debugger/docs/materials/2026-10-02-feedback-template-workbench/，仅本机不公开。10月3日视频标注原图仅父会话可见、原件待归档，不伪造路径。事故PNG附件codex-clipboard-4f833484-e649-4fac-9224-20a130ea6102.png（待确认排查证据）正式路径/Volumes/Data/Projects/video-api-debugger/docs/materials/2026-10-03-feedback-generation-results/codex-clipboard-4f833484-e649-4fac-9224-20a130ea6102.png，父已校验，私有不公开。
先工单/索引，再整批I1主图约+30%、I2有效上限隐藏添加位、I3手机平板导航、I4三个参数取消业务锁、I5未修改上下文直接关闭；I6线上事故优先只读排查，不改模型限制。已部署v0.36.3、运行源码8315f02776290cda1c0f1e7286856d193f95dfca、BUILD TIe6lesNJcjyQirM3FMpx，I6底层原因无法追溯待查，视频标注原图仍缺。
整批后统一发布build内置检查、自行Review，聚焦commit/push/rollback、候选服务器切换、公网版本/BUILD/静态可达。用户手动验收；不浏览器/截图/功能回归/付费生成/DB写/登录点数Provider权限变更/装依赖。
构建/服务异常、漂移/锁冲突、数据权限风险即停或回退；回执含正式工单、逐文件内容/diff、原因、命令结果、版本commit/tag/BUILD、公网证据及未验收项。
```

## 图片模块保存位置、主图默认与G1诊断（2026-10-03）

用户确认N2含义为“默认主图最多1张”，不是生成结果张数。N1/N2仅作用于图片模板工作台设置；用户已有明确保存的主图上限与策略不覆盖。G1为主控独立只读调查，本执行包不改生成接口、Provider、积分/账务或数据库，也不重发任务。

| 编号 | 本轮范围 | 完成标准 | 当前记录 |
|---|---|---|---|
| N1 | 模块上下文设置的保存按钮 | 移至主图最少/最多、风格/参考/辅助上限之后的独立操作区，右对齐、与选项留白；仍调用原手动保存，保留真实保存中/错误/重试状态；不遮盖页面 | 代码/发布检查及部署完成，v0.36.4待用户手动验收；无浏览器或功能验收 |
| N2 | 新建/缺省主图最多数量 | 新模块、新模板与确实无有效已存上限时默认1；主图最少仍为0；总上限10、风格/参考/辅助限制不变；已有有效保存值不变 | 代码/发布检查及部署完成，v0.36.4待用户手动验收；无DB写入、迁移或批量回填 |
| G1 | 最新“生成结果待确认”现象 | 分清已确认事实与未知根因，不重发、不改Provider/账务/任务数据 | 主控只读证据已收到，HTTP 502 阶段已明确，内部原因及上游是否执行未知；未修复、未声称由本轮UI引起 |

### N1/N2实现边界

保存按钮位于数量设置区下方，单独成行并靠右；采用模块对话框内正常文档流，不做视口悬浮或遮挡表单。保留已有主按钮样式、Save图标、saveModule提交函数、moduleSaving/错误和重试状态，未改变外部/Esc关闭及未保存保护。新建模块/模板和默认模块不存在有效存储值时主图最多1张；已有模块/模板行中有效reference_limit及已存referencePolicy.primaryMax继续优先，临时草稿仍按已有恢复逻辑处理。未修改primaryMin 0、MAX_REFERENCE_IMAGES 10、风格/参考/辅助默认和已保存值；不操作数据库。

### G1只读诊断（北京时间2026-10-03，最新）

- 10:04-10:06北京时间主控以SQLite mode=ro/query_only=ON及白名单日志只读核对：近3小时3条 gpt-image-2.5-sunburst、quality=max、2752x2960任务创建于09:59:36、09:59:54、10:00:18，随后请求分别耗时11568ms、9902ms、11426ms返回HTTP 502。均为uncertain，无asset、source.json、image.part及upstreamRequestID。worker PID 1241475自2026-10-02 19:26:26持续active、期间未重启。截图无ID，不强行匹配某条任务。
- 过去24小时同模型5条成功、5条uncertain；最新成功记录同为max/2752x2960，00:45:47创建、00:49:32完成。安全只读配置查询仅提取provider=musk、base_url=https://api.muskapis.com/与更新时间；setting.updated_at为9月22日12:14:08；未读取api_key。
- 服务器provider/worker SHA分别为19e6eff0f43270450a0c6f45e00e53fabd0caee522034a3892a7ab4b58d82a29及e29a081f314ede98a4ec720ccb286448697897fe262e36efe47952ae39c63813，与本地一致；这两文件在10月2日17:55之后未改。故障发生时运行v0.36.3；N1/N2尚未发布，后续v0.36.4的limits只增加默认主图常量、不改变生成等待时长。
- 可确认：这3次请求收到HTTP 502且没有原图产物。不可推断502内部原因、上游是否已执行，也不能证明由今天的UI改动引起。旧“生成结果待确认”提示未清楚说明502事实，列为后续文案待办；本轮不改Provider、不查写账务/任务数据、不自动重发或生成。

### 本轮附件

| 原文件名 | 来源、用途 | 正式路径 | 版本/可读性/完整性 |
|---|---|---|---|
| codex-clipboard-03172503-81ea-4c23-a3cd-35b17c7ad922.png | 2026-10-03用户截图；图片模块保存按钮和主图默认设置参考 | /Volumes/Data/Projects/video-api-debugger/docs/materials/2026-10-03-feedback-template-save-default/codex-clipboard-03172503-81ea-4c23-a3cd-35b17c7ad922.png | 原名保留；737x936；父侧sips可读；原件/归档SHA256均a7ab662013168aa6958ff9ed67dcf66eb65190210a76f417510e19e0c3b985d4；复用校验，不公开Git |
| codex-clipboard-9f700e16-f9d4-4e3c-a789-503a78fa5a19.png | 2026-10-03用户最新截图；G1结果待确认诊断参考 | /Volumes/Data/Projects/video-api-debugger/docs/materials/2026-10-03-feedback-generation-results/codex-clipboard-9f700e16-f9d4-4e3c-a789-503a78fa5a19.png | 原名保留；572x470；父侧sips可读；原件/归档SHA256均b91dcb90d0b60b33cc8fa287050a2d8b01c1f356d08e8290a35886c7b13789b0；复用校验，不公开Git |

完整资料入口同步见[项目资料索引](../../docs/materials/index.md)。新截图与诊断不改变之前I6历史结论的时间范围；G1为更新后的事实，根因仍待确认。

### v0.36.4发布回执

N1/N2运行源码0fcea7dd2a91a5de427a1e1c9934c176e146fb9a，BUILD 0I77QmnNWDzJglbNdkjLN。源码分支codex/canvas-liblib-layout已push/ls-remote确认；rollback/2026-10-03-before-template-save-v0.36.4已推送，指向上一健康8315f02776290cda1c0f1e7286856d193f95dfca。既有正式入口https://sd2.youdooart.com/template-studio?type=image，已部署、待用户手动验收。

实际9个应用文件：studio.tsx/CSS移动保存行并留白；limits.ts统一默认1常量，modules.ts/presets.ts/tasks.ts同步新建与缺省入口、保留明确已存上限/历史复现；package.json/package-lock.json仅同步版本、不改依赖；release.ts更新用户摘要。主图最少0、总上限10、生成count及Provider/worker/点数/登录权限不改。Review补齐非法referenceIds先校验，避免策略解析抛出非业务错误。

发布检查：git diff/cached --check通过；依赖未升级；bash -n/node --check发布脚本通过；精确commit归档已排除docs/materials、env、DB、运行资产，SHA256 e4de09674d56ce0295b7137c30dfd66a74c1f40a0872715d4823e19108d1fb13。服务器release内NEXT_DIST_DIR=.next-prod-candidate npm run build完整通过，含lint/types；无需本地重复build或自动回归。候选包含保存布局和发布摘要后才切换。

实际执行发布活动登记及服务器flock，候选源校验API/scripts/Prisma和Provider/worker/鉴权/成本/点数路径未变；rsync保护持久软链接、uploads/storage/videos可写目录。旧构建保留/srv/video-api-debugger/app/.next-prod-before-sd2-feedback-v0364，记录/srv/video-api-debugger/backups/sd2-feedback-v0364。只重启sd2-gray，图片worker PID1241475/启动时间/单元前后一致。

公网及服务器config/release/login均200，公网release0.36.4及X-SD2-Origin server-42-193正确；受保护template-studio匿名307符合现有权限。9个源码SHA及20个相关静态SHA一致；4服务/定时器active。COMPLETE握手exit0、发布锁正常释放。[统一diff](2026-10-02-feedback-primary-navigation.diff)/[发布证据](2026-10-02-feedback-primary-navigation.evidence.json)保留此前交付并加入本轮。既有更新检测、同渠道SemVer、稍后去重、手动检查及刷新确认源码核对，未做更新弹窗实际操作验收。

未做浏览器/截图/功能回归/付费生成/DB写或独立审查。G1是只读故障定位，不是502恢复；内部原因和上游是否执行未知。守门员首general/L0已纠正debug+ui+deploy/L3，生产切换继续回退/数据保护，误判记入全局日志。

## R1图片生成重复确认（2026-10-03）

用户原文：“不要老是反复提醒我！！我不需要这个提醒，因为我根本没有修改过任何！”。截图为“确认生成”，不是未保存关闭提醒。正式原件：/Volumes/Data/Projects/video-api-debugger/docs/materials/2026-10-03-feedback-generation-confirm/codex-clipboard-f5514b6f-ae53-432d-bb56-8ddb68123c16.png；来源用户剪贴板，795x751可读、原件副本SHA256一致29f2362016356ef7c8b548065296dc564b02188e19982bf5cb6164065465eb3f；索引已登记，私有不上传Git或公网。

| 编号 | 任务 | 完成标准 | 状态 |
|---|---|---|---|
| R1 | 去掉图片生成重复确认 | 点击生成直接提交，不再弹出截图中的提醒；原请求未确认时只查询、不重发及防重复提交保护保留 | 代码和发布检查完成，v0.36.5已部署、待用户手动验收；未执行生成或浏览器功能验收 |

根因：ImageStudioBlock.submit只要reproduceSourceTaskId存在，或任意历史任务status=uncertain，就弹“新建生成任务”确认，与用户是否修改无关；历史记录保留导致每次触发。取消该确认，不加“已看过”标记或隐藏费用/状态，也不依赖dirty做另一层误判。保留pendingSubmission查询原请求、submitLock/moduleDeleteLock、请求编号持久化与后端幂等、输入校验；恢复设置本身不生成。真实未保存关闭保护、删除及主动放弃核对确认不改，不批量取消全站弹窗。

本轮唯一UI修改studio.tsx删除7行，其余package.json/lock仅0.36.5版本、release.ts用户更新摘要。无需新组件/开源依赖或DB改动；直接复用现有同步提交锁和同一requestId查询保护。本轮直接完成并自行Review；未修改Provider、点数、后台任务数据或自动重试生成。

### R1发布回执

已部署v0.36.5，运行源码47d3528c3a2b5715e81cfb4a64626c1d39abf938，BUILD jecj9uPdtiWkqyM2f-FR7。应用分支codex/canvas-liblib-layout已push及远端核对；回退标签rollback/2026-10-03-before-generation-confirm-v0.36.5已推送，指向上一健康0fcea7dd2a91a5de427a1e1c9934c176e146fb9a。旧构建/srv/video-api-debugger/app/.next-prod-before-sd2-feedback-v0365、保护记录/srv/video-api-debugger/backups/sd2-feedback-v0365保留。

实际发布检查：git diff/cached --check及完整4文件Review通过；版本与依赖图仅版本变化；发布bash/node语法核对通过。git archive精确提交排除docs/materials、env、DB、运行资产；SHA256 1c8393f3d9f1c82a52667f9e3acbf5bd7fd32666732a20d559060b566a584784。服务器release内NEXT_DIST_DIR=.next-prod-candidate npm run build完整通过，含lint/types；候选static/chunks已不存在“这会新建图片生成任务”字符串，摘要符合本次更新。既有升级检测/弹窗仍用单一版本源、同渠道SemVer、稍后去重及刷新前确认，未做真实更新交互验收。

发布活动登记/flock和旧commit/BUILD守卫实际执行；API/scripts/Prisma、Provider/worker、鉴权/成本/点数未变。源码同步保护持久目录，gouki构建，root仅已有发布管理；只重启sd2-gray，worker PID1241475/启动时间/单元前后不变。SCP及首次只读核对连接被关闭，按既有SSH重新建立非复用连接后上传和核对成功，未改变账号或权限；非代码/构建失败。

本机和公网config/release/login 200，公网v0.36.5及X-SD2-Origin server-42-193正确；template-studio匿名307符合已有权限。4个改动源码SHA、20个相关公网静态SHA一致，4服务/定时器active；COMPLETE握手exit0并释放发布锁。[证据](2026-10-02-feedback-primary-navigation.evidence.json)保留此前交付层，[统一diff](2026-10-02-feedback-primary-navigation.diff)更新本轮累计应用差异。未执行浏览器/截图/生成实验/自动功能回归/独立审核，未写DB/账务；发布检查不等于用户功能验收。守门员L3、本轮无新增误判或越界。

## P1统一弹窗定位（2026-10-03）

用户原文：“而且，弹窗不要弹角落，要弹就弹在触发按键范围附近，这个你排查下，一起统一修改”。复用R1正式PNG作为角落位置证据，原名、来源与可读性校验见上方R1及[索引](../../docs/materials/index.md#弹窗位置反馈)，不重复复制或公开原图。

| 编号 | 任务 | 完成标准 | 状态 |
|---|---|---|---|
| P1 | 统一弹窗定位 | 不落角落，小确认框靠近触发按钮且不超出屏幕 | 代码及发布检查完成，v0.36.6已部署；实际页面待用户手动验收 |
| T1 | 测通文案 GPT 模型 | 6 个模型逐个真实调用并记录结果 | 已完成，6/6返回有效prompt JSON；每个一次、零重试；不是浏览器/队列全流程验收 |

确认范围：统一useProductDialog消费者的短确认框与命名框，包括生成器、图片/视频模板、任务和管理操作使用的共享入口；完整设置、多字段编辑和升级说明保留原有居中窗口。不取消真实修改退出或删除确认，不改生成请求、模型参数、收费、权限或数据库。

根因：globals.css通用margin:0覆盖浏览器dialog默认居中；ProductDialog.module.css未明确margin:auto/inset；useProductDialog的!naming条件排除了确认框，并在640px以下不定位。改为明确固定定位/居中兜底，短确认与命名都按实际点击控件/键盘焦点或显式anchor定位。点击捕获仅用于自身事件，不复用无关旧按钮；无可见触发对象时居中。

放置顺序下方、上方、右侧、左侧；都放不下才居中。按钮间隔8px、视口留白16px，宽高限制跟随visualViewport，响应滚动/缩放、键盘可见区变化及控件/弹窗尺寸变化。复用useDialogDismiss最上层关闭、取消返回值与安全初始焦点，关闭不提交；工作现场存储不改。

已读取[Radix Popper实际源码](https://github.com/radix-ui/primitives/blob/main/packages/react/popper/src/popper.tsx)，其固定定位、offset/flip/shift/size及autoUpdate模式适合本问题。项目无同类直接依赖，本轮借鉴定位原则扩展既有原生dialog，不新增包、不复制库。浏览器验收按项目手动规则，T1新增测试单独确认具体范围。

应用5文件：useProductDialog.tsx定位/触发对象；ProductDialog.module.css居中及可见区尺寸；package.json/package-lock.json仅0.36.6版本；release.ts用户摘要。既有ReleaseNotice同渠道SemVer/稍后去重/手动检查继续源码核对，不冒充更新交互验收。前执行包交接后长时间无进展且未完成发布，本轮共享小包直接实施并自行Review，不派独立审核或用户侧聊。

### P1发布回执

运行v0.36.6，源码f1f6db05347f0713fc1d5186a4b2e1751b3b4fb0，BUILD zLCFc71j3c0EpKfW2zQ7I；应用分支及rollback/2026-10-03-before-dialog-position-v0.36.6已推送，回退指向47d3528c3a2b5715e81cfb4a64626c1d39abf938。归档SHA256 ac92769399da368db75240992dd394426dde3ae54c5fabdc5420b501ba585ac8；排除env、DB、私人附件及运行资产。曾在归档命令仍运行时过早读到半成品，等待exit0后重新列出完整包并重新计算SHA，上传只使用完成包；无构建或生产故障。

git diff/cached --check、bash -n/node --check通过；服务器不可变release内NEXT_DIST_DIR=.next-prod-candidate npm run build及其lint/types通过。候选含共享定位CSS标记和本轮摘要、已删除R1生成确认仍未恢复。发布登记/flock/旧commit及BUILD保护真实执行，只重启sd2-gray；持久资产软链接和目录可写保护通过，worker PID1241475、启动时间及服务单元前后不变。旧构建/srv/video-api-debugger/app/.next-prod-before-sd2-feedback-v0366及/srv/video-api-debugger/backups/sd2-feedback-v0366保护记录保留；COMPLETE握手exit0。

服务器和公网config/release/login均200，公网0.36.6及X-SD2-Origin server-42-193正确；受保护template-studio匿名307仅证明原权限仍生效。5改动源码SHA、20相关公网静态SHA一致，4服务/定时器active。[累计diff](2026-10-02-feedback-primary-navigation.diff)和[证据](2026-10-02-feedback-primary-navigation.evidence.json)保留历史交付。不做浏览器/截图/生成/自动回归或DB写入，不把部署检查说成弹窗位置功能验收；守门员L3、无新增误判及越界。

### T1静态核对与真实测试结果

文案生成模型清单当前为GPT-5.5、GPT-5.6 Luna、GPT-5.6 Sol、GPT-6 Luna、GPT-6 Sol、GPT-6 Astra，共6项。源文件text-models.ts提供列表与合法性判定，VideoTemplateWorkbench提交llmModel，runs.ts校验并冻结请求参数，worker.ts按snapshot.llmModel传到createMuskChatCompletion的model字段，没有发现选择后强制改成同一模型的静态路径。共同要求json_object格式和message.content；静态对应一致不证明上游支持全部模型或能真实生成。

capabilities.ts明确文案不扣本站点数、上游文字费用由平台承担，仍有上游费用。用户随后纠正“是指文案类gpt模型测通”，并在明确费用和各一次短请求说明后要求“直接执行啊，你在搞什么？”。该指令作为本轮六次小请求执行授权，不再重复询问；不扩展为自动重试、图片/视频生成或无限测试。

2026-10-03北京时间13:34:51-13:35:18，在正式服务器使用运行版createMuskChatCompletion和STUDIO_TEXT_MODELS，temperature=0.2、json_object、45秒超时，与文案worker调用参数一致；各模型一次顺序请求，避免测试自身并发导致限流误判。用户已等待且前包交接曾延误，本轮由主控直接完成单个诊断包。固定短测试要求返回单字段prompt JSON，无用户素材或私有模板上下文外发。

| 模型 | 本次结果 | 耗时 | 返回模型名 | 总tokens |
|---|---|---|---|---|
| GPT-5.5 | 成功，有效prompt JSON | 3022ms | gpt-5.5 | 376 |
| GPT-5.6 Luna | 成功，有效prompt JSON | 3451ms | gpt-5.6-luna | 56 |
| GPT-5.6 Sol | 成功，有效prompt JSON | 11806ms | gpt-5.6-sol | 349 |
| GPT-6 Luna | 成功，有效prompt JSON | 2353ms | gpt-6-luna | 79 |
| GPT-6 Sol | 成功，有效prompt JSON | 3040ms | gpt-6-sol | 349 |
| GPT-6 Astra | 成功，有效prompt JSON | 2783ms | gpt-6-astra | 56 |

共6次、全部成功、零重试、上游报告1265 tokens。实际扣费金额接口没有返回，不编造金额；返回模型名仅表示供应商响应声明，不据此核实其内部路由。源码hash与服务器运行文件一致，运行仍v0.36.6、commit f1f6db05347f0713fc1d5186a4b2e1751b3b4fb0、BUILD zLCFc71j3c0EpKfW2zQ7I。

隔离临时诊断进程抑制Prisma启动的可写pragma配置，并先启用query_only；仅调用既有设置读取和生成适配器，密钥在应用进程内正常使用，不输出/复制/导出，不写业务任务、点数、配置或DB。不重启或发布应用，临时执行文件已删除；无新增产品代码/依赖。诊断输出只存模型名、结果、耗时、usage和必要运行坐标，已并入[固定发布证据textConnectivity](2026-10-02-feedback-primary-navigation.evidence.json)。本次证明短请求真实连通和产出格式可被文案流程接受，不证明长文案质量、队列处理或浏览器按钮全流程；这些未做。守门员真实客户端L3范围，已明确授权、无新增误判。

## C1上下文复制粘贴（2026-10-03）

用户原文：“给模版上下文输入框上方增加一个复制和粘贴按键”。本轮没有新附件；复用已有模块上下文截图[资料索引](../../docs/materials/index.md#模板保存与最新生成异常2026-10-03)，不假定ambient任务URL就是上下文编辑器位置。

| 编号 | 任务 | 完成标准 | 状态 |
|---|---|---|---|
| C1 | 上下文复制、粘贴 | 按钮位于输入框上方，可复制全文、粘贴剪贴板内容 | 8文件实现及发布检查完成，v0.36.7已部署，待用户手动验收 |

范围：图片模板模块上下文及同类通用上下文，视频模板模块/通用上下文；不扩展旧版上下文卡片路由、生成提示词、素材剪贴板上传或其他文本框。新增共享ContextClipboardActions及CSS，被3个编辑入口复用。复制读取当前未保存全文，不修改编辑内容；粘贴按原光标/选区插入文字，不默认覆盖全文，并调用与原输入相同的编辑函数。复制/粘贴在输入框上方靠右，Lucide图标加短文字，带可访问名称/焦点/忙碌/错误反馈；视频原有底部复制按钮移到上方，不重复。

只在已有允许编辑上下文的入口显示，复制仍尊重视频canCopy；不更改服务端权限。保留图片20000和视频12000现有限制；超过上限整体拒绝，不静默截断。不读图或触发生成，不自动保存；现有安全临时草稿恢复、手动保存、真实修改退出和历史复现规则不改。粘贴得到完全相同文本不调用修改函数、不退出复现模式；异步读取后如果输入已变、弹窗关闭/卸载或编辑被禁用，不覆盖新内容。空剪贴板与浏览器拒绝读取明确反馈，保留普通手动粘贴入口。

复用项目navigator.clipboard.writeText做法，新增原生readText，不装依赖。已核对[MDN Clipboard.readText](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/readText)的用户触发、HTTPS及权限拒绝/空文本语义；直接采用浏览器接口，无需新增Clipboard库。系统权限仍由浏览器处理，不绕过。单个共享UI包直接实施并自行Review，复用上一包明确交接延误证据；无独立审核或浏览器自动验收。

实际8应用文件：ContextClipboardActions.tsx/CSS实现工具栏与安全异步处理；studio.tsx及global-settings-dialog.tsx接入图片模块/通用上下文；VideoContextEditor.tsx接入视频并移除底部重复按钮；package.json/lock仅同步0.36.7（对既有复制/粘贴能力的兼容UI增强，不新增业务流程），release.ts短摘要。ReleaseNotice及既有SemVer检测/稍后去重/手动检查继续使用单一版本源，未做更新弹窗交互验收。后台API、Provider、积分、worker、数据库和持久资产不改。

### C1发布回执

v0.36.7运行源码8f481400ecfbbcd8b50d021117e77f933221f731，BUILD hdFoauPtV4mwfhsevAtTe；分支codex/canvas-liblib-layout及rollback/2026-10-03-before-context-clipboard-v0.36.7已推送/远端确认，回退指向上一健康f1f6db05347f0713fc1d5186a4b2e1751b3b4fb0。精确归档排除env、DB、私人素材和运行资产，完整包SHA256 9c5ca8a90f86f137416ba9c7b02700155e43d1cdfdfa489e8105a4677023fa94。

发布检查：源码Review、git diff/cached --check、bash -n/node --check通过；服务器不可变release中NEXT_DIST_DIR=.next-prod-candidate npm run build完成，含lint/types。仅既有img性能警告，未扩大到无关整改。候选含复制/粘贴及更新摘要，旧P1定位标记保留，R1重复生成确认未恢复。活动登记/服务器flock、旧commit和BUILD保护、持久资产排除及可写软链接核对实际执行；只重启sd2-gray，worker PID1241475/单元/启动时间不变。

服务器及公网config/release/login均200，公网v0.36.7及X-SD2-Origin server-42-193正确；template-studio匿名307仅证明原鉴权边界，不能当页面效果验收。8个改动源码与20个相关公网静态SHA一致，4服务/定时器active。旧构建/srv/video-api-debugger/app/.next-prod-before-sd2-feedback-v0367和保护记录/srv/video-api-debugger/backups/sd2-feedback-v0367保留，COMPLETE握手exit0。累计[应用diff](2026-10-02-feedback-primary-navigation.diff)及[证据](2026-10-02-feedback-primary-navigation.evidence.json)已更新，T1历史实测保留但本轮不重跑。

既有资料、固定todo与索引同步登记；原图不重复复制、不上传。无新生成、DB写入、费用、依赖、权限/Provider变化；C1浏览器剪贴板权限、按钮位置和实际粘贴未自动验收，待用户手动；守门员L3、无新增误判或越界。未解决的历史生成502问题与C1不混称恢复。

## C2外部账号视频封面费用（2026-10-03）

用户反馈资产管理页外部账号sg_lmy的视频封面没有标价。没有新附件；目标为正式/assets，不切旧入口。只读核对用户提供的邮箱命中唯一external/active账号，其8条近期本站任务均使用volcengine_ark：7成功、1失败，7成功的实际扣点为30、39、36、36、36、36、30，失败为0；现金币种及官方/最终minor、micros字段均null。该账号只有4张上传图片，没有上传视频。证据来自sqlite3 -readonly加PRAGMA query_only，不取提示词、密钥、原始请求或私人媒体，不写DB。

| 编号 | 任务 | 完成标准 | 状态 |
|---|---|---|---|
| C1 | 上下文复制、粘贴 | 按钮位于输入框上方，可复制全文、粘贴剪贴板内容 | 已部署v0.36.7，待手动验收 |
| C2 | 外部视频封面标价 | 有价格的视频正常显示；未知价格不编造 | 6应用文件及发布检查完成，已部署v0.36.8，待用户手动验收 |

根因：assets/page.tsx仅在视频任务有USD官方现金字段时展示费用，assets/library只投影该组字段，忽略已结算实际扣点。actual_cost经现有finalizer/credits结算逻辑确认是站内点数，不能当现金或按当前费率倒推历史现金价格。

修复边界：已有现金标记不变，没有现金时用真实已结算扣点补封面；详情增加实际扣点。read-only library选择actual_cost并仅向管理员或该任务本人/所有者返回chargedCredits，运行中/未记录/非法数值返回null，图片/上传视频/参考图不造费用。0点保留，小于0.01的正数显示小于0.01点；不从estimated/frozen值冒充实际扣费。原资产权限、账務、Provider、生成/重试、Prisma、依赖不变。缓存schema升3避免旧投影缺字段，偏好/滚动/筛选不变。

实际应用文件：src/app/api/assets/library/route.ts（只读投影）、src/app/assets/page.tsx（原封面badge及详情）、src/lib/assets/library-cache.ts（缓存投影版本）、package.json/lock与src/lib/release.ts（0.36.8及真实摘要）。沿用现有卡片/费用组件，不另加收费模块；[Intl.NumberFormat](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/NumberFormat)原生格式化即可，无新增依赖。采用产品/极简/Impeccable轻量检查，不做无关视觉重构；本轮单一紧耦合显示链路直接完成，沿用既有发布流程，不重派曾有发布证据不完整/长等待的执行链。

发布检查仅候选build内置lint/types、源包/新静态/版本/服务/持久资源/回退。用户指定范围的只读价格诊断已做，不自动跑浏览器、业务生成、付费/积分测试或迁移。更新提醒沿用ReleaseNotice数字SemVer与稍后去重、手动再检查的单一入口；真实卡片和更新弹窗待用户手动。未把cash未知说成0元，也不声称历史生成502已恢复。

### C2发布回执

已部署v0.36.8，运行源码98c11b5337741971920a33fddbca68aadaf5d063，BUILD_ID CWKSe5rWo_nZxeVGNUjzV；入口https://sd2.youdooart.com/assets。应用6文件提交/推送及回退tag rollback/2026-10-03-before-asset-cost-v0.36.8已ls-remote确认，回退指向已运行v0.36.7的8f481400ecfbbcd8b50d021117e77f933221f731。最终源包SHA256 f68fb0d9d693cba398854afcc83a1745fb8fcb97956973520156919f17824a64，两端一致、tar完整与敏感/运行文件排除核对；打包尚未完成时的辅助副本不用于发布，最终重新上传完整已校验源包。

服务器flock、发布登记与旧commit/BUILD守卫已执行，候选作为gouki构建，内置lint/type/compile通过，仅保留原img性能警告。API只允许assets/library/route.ts只读投影变化，其余API、scripts、Prisma、Provider/worker、鉴权、成本/积分目录与运行版一致；rsync排除密钥/数据库/媒体/运行构建，持久软链接及上传目录可写检查通过。旧构建保留/srv/video-api-debugger/app/.next-prod-before-sd2-feedback-v0368，部署记录/srv/video-api-debugger/backups/sd2-feedback-v0368。

只重启sd2-gray；图片worker PID1241475、启动时间2026-10-02 19:26:26 CST、状态/单元一致。源站127.0.0.1:3302 config/release/login各200；公网config/release/login/assets各200、X-SD2-Origin server-42-193，release=0.36.8。assets原有匿名公开页面壳为200，真实数据仍走原鉴权API；首次核对脚本错误沿用template-studio的307预期，读取原middleware确认后修正检查预期，未改页面权限。最终19个相关公网静态文件与服务器哈希一致，7个源码（6个本轮应用文件加C1组件）本地/服务器一致，4服务或timer均active。

发布进程COMPLETE握手实际结束0，公网验证完成后登记部署完成。只读费用诊断摘要并入[发布证据](2026-10-02-feedback-primary-navigation.evidence.json)，C1/P1/T1及之前交付保留previousDelivery历史；[统一diff](2026-10-02-feedback-primary-navigation.diff)覆盖原批次至本次运行源码。不运行浏览器/业务回归、付费请求或DB写入，不称用户验收通过。现金账单仍未知而非0元；无扩大任务权限，守门员L3，未把关键词“生成”误当本轮队列改造。

### C2金额显示续办（2026-10-03）

用户明确纠正：“不要只显示分数,要显示扣费,费率跟普通生成一致”。此要求替代v0.36.8封面仅以点数补缺的结果，保留C2编号，不能把旧版已部署当成新目标完成。

| 编号 | 任务 | 完成标准 | 状态 |
|---|---|---|---|
| C2 | 外部视频封面标价 | 按普通生成费率显示扣费金额，区分实际扣费与估算 | 7应用文件及发布检查完成，已部署v0.36.9，待用户手动验收 |

证据：普通生成现金来自Provider返回的actual_cost/currency，不是3点/秒折算；pricing_snapshot只有站内点数规则，PlatformSetting未找到现金费率配置。数据库只读核对普通账单/用量：模型2.0不含参考视频1481条样本为7 USD/百万生成Token，含视频样本约4.3；2.5不含视频约10.7、含视频约6.4。另有历史7.7样本及金额微单位舍入，不把统计数硬编码成永久费率。目标账号成功视频真实completion_tokens已有216900、281700、260100等，现金字段仍null。

实现：新增normal-video-charge.ts，用项目现有Prisma findMany/select/orderBy/take及JSON.parse，最多4组×8条，取同模型/是否使用参考视频的最新已确认普通Provider账单，要求source=provider_get_result、有有效生成Token和正金额，剔除Draft/陌生模型/损坏JSON/不安全数值。金额按目标视频真实生成用量乘普通账单有效费率推算；不按时长/点数猜现金、不用其他供应商价目表、不硬编码7或汇率。币种/汇率展示复用currency.ts，cash公式只用于显示估算，不修改官方金额或账本。

assets/library新增最小normalChargeEstimate投影，仅管理员或任务本人/所有者可见，原始状态/参考URL/普通账单原文不发送客户端；只有成功任务且无现金金额时查费率，故障降级为扣费待确认不抹掉资产。封面已有现金记录优先，否则显示“约 ¥…”并注明按普通费率估算；详情显示美元估算/用量/费率/同一汇率，实际点数移留详情，不再当封面费用。上传视频、未完成任务不造价；缺记录/用量/匹配费率则待确认。缓存投影schema4，偏好和滚动不变。

应用7文件：src/lib/costs/normal-video-charge.ts、src/app/api/assets/library/route.ts、src/app/assets/page.tsx、src/lib/assets/library-cache.ts及package.json/lock、src/lib/release.ts。候选0.36.9；保持既有ReleaseNotice单一来源、数字SemVer/稍后去重/手动更新，更新及卡片浏览器交互留用户手动。保持原生成/冻结/结算/退款/Provider/worker/权限/Prisma结构、依赖不变，不创建现金扣款或回写旧账单。

开源/已有实现取舍：复用当前Prisma 5生成客户端与既有金额格式化；[官方读取指南](https://www.prisma.io/docs/orm/fundamentals/reading-data)现行示例已为新版API，未照搬、不升级依赖，以项目实际类型及候选build核对兼容。产品/极简/Impeccable只调整原费用badge与详情，不新增设置/弹窗。用户纠正后费用目标与实现范围已明确，沿用原连续执行和发布链，不重派前包曾发布证据不足/长等待的执行链。

守门员首次intent的“只读投影”被误归readonly/L0；在编辑前重述真实UI/deploy目标，重新start为L3，仍保留完整发布检查。纠正已记/Users/gouki-youdoo/.codex/classification-misjudgment-log.md。本轮数据库查询用sqlite3 -readonly、PRAGMA query_only；没有付费生成/DB写入/浏览器或自动功能验收。首次只读辅助查询Config表名不正确，按Prisma核对到PlatformSetting后查询其key，不读设置值/凭据。

#### C2金额发布回执

v0.36.9运行源码527d925ae1943557d164858f0a74cc7e1fd62c85，BUILD gbpec82z8F5gOaOcQAm6y；两次聚焦应用提交均已推送，rollback/2026-10-03-before-asset-cash-v0.36.9远端确认，指向98c11b5/v0.36.8。首次候选构建发现ES5目标不支持Map.values直接展开，替换Array.from后同版本重新构建通过；失败候选未同步或切换live。最终归档SHA256 9c1f054a68f7a483606c03707afa607143d239eab4340cb0551d72412de7576c，完整包两端一致且排除运行/私人资料。

候选内置lint/types/build通过；19公网静态与服务器一致、8源码本地/服务器一致，config/release/login/assets均200、X-SD2-Origin server-42-193，源站三入口200。四服务/timer active，只重启sd2-gray；图片worker PID1241475、单元/启动时间不变。回退构建/srv/video-api-debugger/app/.next-prod-before-sd2-feedback-v0369-r2和记录/srv/video-api-debugger/backups/sd2-feedback-v0369-r2保留。原SSH连接超时后，通过仍等待的部署进程stdin接续COMPLETE，不重发/重启部署；进程结束、服务及运行commit再次核对，发布完成登记已写。

只读同模型2.0、无参考视频普通账单216900生成Token/1518300微美元对应7美元/百万Token；目标10秒视频同用量估算$1.5183，人民币仅沿用既有汇率显示，并非新增现金实扣。其余真实用量281700、260100分别估算$1.9719、$1.8207。没有现金账本回写或新生成；真实封面/交互仍待用户手动验收。

## C3/C4更新刷新与外部提醒（2026-10-03）

用户截图指出更新刷新反复跳出不同确认；随后明确外部人员仍接收新版提醒，但不显示具体更新内容。附件[原图](../../docs/materials/2026-10-03-feedback-update-confirm/codex-clipboard-f7c8cdb3-42b3-4827-b629-1f66ea539939.png)，来源、校验及版本见[资料索引](../../docs/materials/index.md#更新刷新重复提醒与外部摘要)。不从截图推断用户修改过，也不控制浏览器执行验收。

| 编号 | 任务 | 完成标准 | 状态 |
|---|---|---|---|
| C2 | 外部视频封面标价 | 按普通生成费率显示扣费金额，区分实际扣费与估算 | 已部署v0.36.9，待用户手动验收 |
| C3 | 更新刷新提醒 | 无修改直接刷新；有真实未保存修改才提醒，不叠重复确认 | 已部署v0.36.10，待用户手动验收 |
| C4 | 外部新版提醒 | 外部仍收到提醒及刷新入口，但不显示具体更新内容 | 已部署v0.36.10，待用户手动验收 |

根因：ReleaseNotice每次更新按钮无条件调用产品确认，reload之后又触发原生beforeunload，造成三层堆叠；模板上下文已安全存入可恢复浏览器草稿，仍以与服务端模板不同为“离开会丢失”，把未正式保存与不能恢复混为一谈。

实现：ReleaseNotice去掉额外确认，先关闭更新层再reload；真正未保存的全局设置、未完成保存/上传和写入浏览器失败的草稿继续原离开保护。已成功持久化的模板上下文/固定图草稿不再额外阻塞离开，手动模板保存、关闭编辑保护与草稿恢复逻辑不改。画布、配额的真实未保存原生保护不删除。采用现有原生平台离开语义，无新增依赖或全局强制取消beforeunload。

C4前端复用AppSession：仅明确internal展示摘要，external/未知不显示；release接口复用getSession，仅internal返回摘要，外部或匿名返回空摘要，Cache-Control private,no-store及Vary Cookie防账号缓存混用。仍返回版本/渠道、保留SemVer检测/稍后去重/手动检查/刷新入口；不改鉴权实现、账号类型、权限或账务。

应用文件：ReleaseNotice.tsx（单层更新及身份展示）、api/release/route.ts（按现有身份筛摘要）、image-studio/studio.tsx（真实丢失与持久草稿区分）、package.json/lock及release.ts（单一0.36.10版本摘要）。范围内API仅release投影；C2现金展示、其他API、费用、Provider、worker、Prisma和依赖保留。按交互模式库复用现有对话框和退出规则；守门员L3，本轮未新增归类误判。发布只做候选构建、源包/静态/版本/健康/持久资产/回退检查，功能由用户手动验收。

### C3/C4发布回执

v0.36.10运行源码b26f9d216949c3601d2cc36d050e6fc922422ab1，BUILD MFC_yPnyTMuIibuxAwjsx；6应用文件聚焦提交及推送完成，rollback/2026-10-03-before-update-notice-v0.36.10已远端确认，指向健康v0.36.9/527d925。源包SHA256 1068a9a163a248ad0efab8aecf8711a142a1b55d98842fe17d30dcf5c7dd36c0，完整打包后校验/上传；不含密钥、私人原图、DB或运行资产。

服务器候选build内置lint/types完成；保留既有img/CSS警告，未扩大整改。候选确认旧重复刷新文本不存在，C1复制粘贴/P1弹窗样式/C2现金估算标记保留。发布登记/flock、旧运行commit/BUILD守卫及rsync排除、持久软链接可写检查均执行。仅重启sd2-gray，图片worker PID1241475、单元/启动时间/状态未变。回退构建/srv/video-api-debugger/app/.next-prod-before-sd2-feedback-v03610和记录/srv/video-api-debugger/backups/sd2-feedback-v03610保留。

公网config/release/login/assets均200，release=0.36.10、X-SD2-Origin server-42-193；匿名release摘要为空，private,no-store与身份相关Vary响应头核对。源站三入口200，4服务/timer active。layout/assets/image-studio/template-studio共23个相关公网静态与服务器哈希一致，8源码（6变更加C1/C2延续）本地/服务器一致。COMPLETE握手实际结束0，发布完成登记已写；首次登记被敏感词检查拒绝，去掉无须记录的响应头名称后只记录发布结果，未输出凭据或绕过账号权限。

正式原图仅本地保留，已加入本仓库私有exclude；资料索引/固定todo/统一diff/结构化证据同步，保留v0.36.9及更早发布和T1真实测试历史。没有自动浏览器操作、截图/功能验收、付费生成、DB写入或新审核线程；外部/内部实际弹窗、取消刷新、草稿恢复及费用封面待用户手动验收。C2官方现金账单依旧缺失，金额估算注明，不冒充实扣；此前生成502未宣称恢复。L3闭环执行，C3/C4无新增误判或越界；C2曾有归类误判已纠正记录。

### C3同图再反馈核对（2026-10-03）

用户再次问“这样跳来跳去的是不是也不太好”，新文件名codex-clipboard-27dc03a7-88fa-4691-aac3-56e82f1f90ea.png与已归档f7c8cdb3截图SHA256完全一致，复用上方原图并登记新来源，画面仍是v0.36.8。最新工作树7a59e0f、运行应用6d2f390/v0.37.0：ReleaseNotice保留先close更新弹窗再reload，不含“已保存，刷新”或额外产品确认；useUnsavedNavigation只在真实pending未保存项存在时挂beforeunload，图片工作台保留真实未保存/上传/不能持久恢复草稿保护。公网/api/release返回production 0.37.0、匿名摘要空。

本次为既有修复的源码和公开版本核对，不是当前浏览器实机复现。不能凭旧图认定最新代码回退，也不能证明用户当前已加载新版或未保存保护真实触发情况。没有应用改动、版本升级、构建或部署，无生成/数据库写入/浏览器操作；C3维持“已部署，待用户手动验收”，不冒称实机通过。

### C3单窗口更新修改方案（2026-10-03）

用户最新要求“给修改方案”。本节方案v1.0.0只补充C3设计，不代表本轮实施或上线；既有C3/C4发布状态保留。参考附件复用上方已归档原图及27dc03a7同图来源，不复制私有截图。当前应用源码6d2f390/v0.37.0；本节以源码核对为依据，不宣称当前浏览器实机复现。

| 编号 | 任务 | 完成标准 | 状态 |
|---|---|---|---|
| C3方案 | 单窗口更新与未保存保护方案 | 明确正常刷新、真实丢失、进行中操作、取消/稍后及实现边界，存入原工单 | 已形成方案；未实施、未部署 |

推荐交互：更新和未保存保护使用同一个窗口，窗口位置稳定，不关闭一个再弹另一个。

1. 没有实际修改、修改后恢复原值，或草稿已可靠保存且能恢复：点击“立即刷新”直接更新，不提示内容丢失。刷新保留原设置和可恢复工作现场；“草稿已保存”不冒充模板已正式保存。
2. 确有无法恢复的未保存修改：在原更新窗口内切换为“未保存内容”，说明会丢失的具体内容，提供“返回编辑”和“放弃修改并刷新”；不另弹产品确认，不使用未经实际保存的“已保存，刷新”。如有可复用的真实保存入口，可增加保存成功后刷新，失败时留在原窗口，不擅自代替用户保存。
3. 保存或上传尚未完成：原窗口显示实际进行中状态，保留“稍后”，不自动终止操作或刷新；完成后重新判断内容是否仍可能丢失。
4. 用户明确确认刷新后，仅对本次刷新放行，避免浏览器再次问相同问题。实施时先清点共享保护及画布等独立beforeunload监听；取消、失败、页面仍停留或产生新修改时恢复保护，不能全局关闭浏览器离开保护。浏览器自身刷新、关闭标签页等非本次批准操作仍按平台规则处理。
5. “稍后”、关闭、Esc及外部空白统一为稍后；按站点、项目、目标版本持久去重，轮询和切回页面不反复打断。版本/账号的安静入口保留重新检查与再次打开。
6. 外部及身份未知用户仍可看到新版、版本号、刷新和稍后，不显示具体更新内容；内部摘要沿用现有规则。使用既有共享样式，桌面与手机位置、尺寸稳定，刷新只触发一次；只有实际加载目标版本后才算更新完成。

拟修改范围：ReleaseNotice.tsx复用原窗口显示上述状态；use-unsaved-navigation.ts在既有共享入口表达取消/继续及本次刷新放行；image-studio/studio.tsx等实际调用点区分无修改、可恢复草稿、真实丢失和操作进行中。只有实际发现参与同一刷新保护的独立监听才纳入，不全站重写，不改费用、鉴权、Provider、上传接口、数据库或依赖。

开源核对：已读[React Router官方导航保护示例](https://reactrouter.com/how-to/navigation-blocking)、[useBlocker实际实现](https://raw.githubusercontent.com/remix-run/react-router/main/packages/react-router/lib/hooks.tsx)和[MIT许可](https://raw.githubusercontent.com/remix-run/react-router/main/LICENSE.md)。借鉴显式阻止、取消、继续状态及自己的产品确认界面；官方明确useBlocker不处理硬刷新，不能直接安装它解决本题。项目为Next.js，推荐少量适配既有共享hook，不增加React Router依赖或迁移路由；此处是设计参考，不是已验证的新实现。

后续验收边界：无修改、恢复原值、可恢复草稿、真实未保存、上传/保存进行中、取消后继续编辑、稍后去重/手动重开、外部摘要隐藏、刷新失败及实际加载版本/现场恢复。实施获授权后按项目发布检查上线，功能由用户手动验收；本次仅文档差异与入口检查、聚焦提交推送，不构建、不发布、不操作浏览器、不升级应用版本。

### C3全站网站风格确认方案（2026-10-03）

用户追加原话：“包含最后弹出的确认画面要用网站风格的ui，不要用系统弹窗，排查同类问题，全站”。沿用上一条“给修改方案”的范围，方案v1.1.0补充v1.0.0，不是已实施应用。开工表格曾误把部署列为完成标准，已在任何应用编辑前向用户澄清，纠正如下；未构建、发布或操作浏览器。既有C3/C4状态不改，截图仍复用本节原件及同图来源。

| 编号 | 任务 | 完成标准 | 状态 |
|---|---|---|---|
| U1 | 全站确认弹窗统一 | 全站同类源码排查、网站风格最终确认及保护边界写入方案；代替本轮误列的部署标准 | 排查及方案已完成；应用未实施，实机未验收 |

本轮使用只读explorer全站搜索src与相关public脚本、定向读取；主线程复核原始命中、共享产品弹窗、更新入口及画布保护，不是独立功能审核。对象为实际生产源码工作树d91df95，运行应用6d2f390/v0.37.0；不以正式资料根旧源码代替生产代码。

#### 全站源码排查清单

发现14处window.confirm、7处window.prompt，合计21处、13个文件；未发现window.alert。以下行号来自本次未改动的源码，仅业务系统弹窗，不把已经使用网站confirm/prompt的同名函数算成系统弹窗。

| 文件（相对实际源码根） | 行号 | 业务确认/输入数量及用途 |
|---|---|---|
| src/components/PromptEditor.tsx | 286 | 1确认，放弃提示词编辑 |
| src/components/SeedanceAssetPanel.tsx | 164 | 1确认，彻底删除官方资产 |
| src/components/ShareAlbumDialog.tsx | 333、353 | 2确认，撤回或关闭共享 |
| src/components/AccountMenu.tsx | 71 | 1确认，清除本地画布草稿后退出 |
| src/components/CreditRequestDialog.tsx | 138、141 | 1确认、1输入，撤回申请及拒绝理由 |
| src/components/generate/GeneratePageClient.tsx | 1396 | 1确认，移除最近生成记录 |
| src/components/content-reactions/ImageShareButton.tsx | 45 | 1确认，公开分享图片 |
| src/app/collections/[id]/ReferenceAlbumDetailClient.tsx | 270、304、327 | 2确认、1输入，删除及重命名 |
| src/app/collections/ReferenceAlbumsClient.tsx | 295、316、335、361、450 | 2确认、3输入，文件夹/图集命名、删除及拒绝理由 |
| src/app/projects/[id]/page.tsx | 603 | 1确认，移除成员 |
| src/app/projects/[id]/video-cards/[cardId]/page.tsx | 243 | 1确认，视频卡封板 |
| src/app/approvals/page.tsx | 205 | 1输入，审批理由 |
| public/tools/ultimate-canvas/toolflow-workflow.js | 333 | 1输入，工作流名称 |

另有5个离开保护入口：use-unsaved-navigation.ts:11/44、image-studio/use-studio-settings.ts:33、admin/users/quotas/QuotaManager.tsx:98、tools/ultimate-canvas/CanvasFrame.tsx:126、public/tools/ultimate-canvas/app.js:2828。画布iframe已有宿主负责、独立打开才由子页提醒的分工，保留，不能取消真实未保存保护。直接整页刷新3处：ReleaseNotice.tsx:61、ErrorTranslator.tsx:789、agent/AgentRunTraceActions.tsx:18。后两处也纳入站内刷新保护接入范围，区别数据刷新与整页刷新，不为了统一增加无风险确认。

#### 统一修改设计与顺序

1. 最终业务确认采用网站自己的背景、字体、按钮、间距及主次层级：复用useProductDialog.tsx、ProductDialog.module.css、useDialogDismiss.ts。普通小输入靠触发入口；关键删除、共享范围改变等在清晰网站对话框中显示对象、影响与取消。安全取消获得初始焦点，关闭/Esc/外部点击等效取消，回到原触发按钮。普通成功和可修复错误留在原页面，不新增确认弹窗。
2. 更新沿用v1.0.0单窗口设计：无真实丢失直接刷新；真实丢失在原更新窗口内出现最终网站风格确认，确认后仅放行本次刷新，不再接浏览器重复确认。统一接入上述独立保护入口，取消或失败恢复保护；未保存内容类别和进行中操作不能用一个无条件dirty替代。外部摘要隐藏及稍后去重保留。
3. 批量替换21处业务系统调用，等待用户明确结果才执行原操作；取消不发送、不保存、不删除、不分享、不审批。后端接口、权限、金额、资产删除语义和审批规则不改变。已用网站弹窗的任务、模板、管理页面复用，不再做另一套。
4. 共享文字输入补充与原业务匹配的可留空、必填、字数及输入类型能力：现有prompt把空白当不可提交，ReferenceAlbumsClient拒绝理由原本允许留空，必须保留空串与取消null的区别；申请拒绝等原本必填仍必填，不机械统一为默认120字，不静默截断。已有弹窗内的撤回/拒绝尽量在原面板切换确认/理由状态，不再叠大窗口；嵌套必需时仅顶层响应Esc与外部点击。
5. 画布是非React脚本，复用其已有网站命名/确认能力或小适配，不直接套React hook，不安装新的UI库。待实施时核对实际可调用入口及iframe边界，避免子页和宿主重复提醒。
6. 整批改完后统一检查原生业务调用清单已清空、取消语义、空值/必填、进行中防重复、焦点与小屏/边缘位置。按项目约定只执行发布必需构建/版本/健康/回退检查后上线，功能显示与操作效果留用户手动验收；本轮不执行上述未来实施和上线步骤。

平台边界：网站不能替换浏览器关闭标签页、地址栏刷新产生的beforeunload对话框的文字或外观；文件选择、剪贴板等权限、人机验证同样归平台。站内按钮流程可以用产品UI先作决定并针对本次放行，不靠全局删除保护伪装已统一。依据[MDN beforeunload说明及实际事件处理示例](https://developer.mozilla.org/en-US/docs/Web/API/Window/beforeunload_event)，推荐只对真实未保存内容挂保护；不引入新依赖。此前已读React Router实际实现及MIT许可只作为取消/继续状态参考，不处理硬刷新。

证据与缺口：上述21处是源码字面搜索和定向读取命中，不宣称动态别名调用穷尽或线上实机全站通过；共享组件已有不等于每个旧入口已迁移。当前方案目标完成，应用版本仍0.37.0，未改高风险业务及生产数据。守门员start按实际语义L0方案/代码只读，关键词命中deploy/chrome不扩展授权；本轮范围误判已纠正并记录classification-misjudgment-log.md。
