# 项目资料索引

## 主图导航与视频参数反馈工单（2026-10-03）

项目video-api-debugger；2026-10-02后台两条原文见下节。2026-10-03追加/generate三参数灰色，随后明确取消三参数业务锁（模型合法范围保留），新增I5模板上下文未修改关闭及同类误提醒，I6多任务待确认只读排查。I1-I5已部署v0.36.3，最新运行源码8315f02776290cda1c0f1e7286856d193f95dfca、BUILD TIe6lesNJcjyQirM3FMpx；I3模板导航状态按surface/user本地持久化、迁移旧session记录；[发布证据](../../tasks/todo/2026-10-02-feedback-primary-navigation.evidence.json)/[统一diff](../../tasks/todo/2026-10-02-feedback-primary-navigation.diff)正式归档；最新候选内置检查及4服务/20相关静态/2变更源码一致通过，首次27静态/20源码证据为历史，功能待用户手动验收。I6故障阶段已明确、底层原因无法追溯待查；视频标注原件仍待归档，不称W1附件齐全，反馈new不改。

| 资料/原名 | 来源/日期/版本 | 主题与用途 | 正式入口、关系与校验 |
|---|---|---|---|
| 主图与导航反馈优化；2026-10-02-feedback-primary-navigation.md | 后台原文/用户追加；2026-10-03创建；v1.0.0 | 主图约+30%、满额添加位、小屏导航、视频三参数误锁；边界/手动验收/附件/交接正文 | [正式工单](../../tasks/todo/2026-10-02-feedback-primary-navigation.md)；可读；历史规则见10月1日原文；工作树非唯一资料位置 |
| feedback.json及48c4aa41c3bae255821ef8a6f972e91b9422054cd2744fdc16f0250a4d0b56b4.jpg | 2026-10-02；快照v1.0.0/原图 | 两条原文与导航参考，不作验收图；无音视频 | 下节原路径/校验保留；工单有绝对路径；raw/原图不公开Git |
| 视频三参数用户截图（原名未知） | 2026-10-03用户会话；原版本未知 | /generate三chip灰色；DOM/模型/输入事实完整记工单；非自动浏览器证据 | 仅父会话可见，无path/attachmentHandle；待主控导出到docs/materials/2026-10-03-feedback-video-parameters/；原件未归档/未校验，不伪造已保存 |
| codex-clipboard-4f833484-e649-4fac-9224-20a130ea6102.png | 2026-10-03用户剪贴板截图，原件/原名保留；父归档 | 图片模板img2.5-S最高4K多次待确认；用于I6故障阶段核对，不据图定Provider失败，与上条缺原件截图不同 | [原件](2026-10-03-feedback-generation-results/codex-clipboard-4f833484-e649-4fac-9224-20a130ea6102.png)；895x725 PNG，父sips可读/复制SHA256一致2fc4dcf6bbe59df8e36f836a1d1da658cd66c6f56f028ee50aee57769a5ccd02，复用校验；私有不上传Git |
| I4取消锁/I5未修改关闭/I6事故对话原文及只读结论 | 2026-10-03当前用户；工单v1.0.0补充 | 最新指令替代旧ratio_locked保留结论；两异常为request/network与request/timeout约300秒，无返回回执，异常后同模型有成功记录；底层网络/上游原因未确证 | [正式工单最新段](../../tasks/todo/2026-10-02-feedback-primary-navigation.md#最新纠偏与i6事故证据2026-10-03北京时间0049核对)；原文、线上commit/BUILD及缺口已登记，无生产数据写入 |

## 当日后台反馈（2026-10-02）

项目video-api-debugger；2026-10-02 23:07北京时间从正式SD2生产Feedback表只读拉取，覆盖北京时间当天00:00至次日00:00全部状态，截至读取时共2条，均为new。仅整理资料，不实施、归档反馈或修改生产数据；本地记录v1.0.0，原文JSON和截图仅本机保留，不公开Git。无音视频附件。

| 资料与原文件名 | 来源/日期/版本 | 主题、摘要及用途 | 正式入口、关系与校验 |
|---|---|---|---|
| 反馈原文汇总；feedback.json | 正式SD2后台Feedback，2026-10-02接收；v1.0.0首次快照 | 两条图片模板工作台意见；保留反馈ID、原文、准确时间、页面、状态及附件地址，供后续需求核对，不代表问题已复现 | [原文](2026-10-02-feedback-template-workbench/feedback.json)；JSON可读；不替代历史工单或自动授权实施 |
| cmuqyowne0027vg4vr3xyks6m；无附件 | 2026-10-02 20:51:09北京时间；new | 主图缩略图增大约30%；锁定张数后不再显示添加主图图标。来源/template-studio?type=image | 完整原文见上述JSON；需求已收到，尚未实施；关联历史主图规则需另行核对 |
| cmuqyq5xo002fvg4vjhbp6aar；48c4aa41c3bae255821ef8a6f972e91b9422054cd2744fdc16f0250a4d0b56b4.jpg | 2026-10-02 20:52:08北京时间；new；原名/原件保留 | 手机与平板导航条难以使用，截图为问题参考，供后续核对小屏导航，不作修复验收证据 | [截图](2026-10-02-feedback-template-workbench/48c4aa41c3bae255821ef8a6f972e91b9422054cd2744fdc16f0250a4d0b56b4.jpg)；来源https://sd2.youdooart.com/uploads/assets/48c4aa41c3bae255821ef8a6f972e91b9422054cd2744fdc16f0250a4d0b56b4.jpg；本地与服务器SHA256一致且等于文件名，415273字节、2584×1828 JPEG已打开核对；未复现或验收生产页面 |

## 模板工作台体验优化（2026-10-02）

项目video-api-debugger；历史工单v1.0.0已被2026-10-02用户明确WS1-WS7实施授权更新。源码、统一发布检查及安全部署已完成，v0.36.2；源码f647817、BUILD OlWyIuDDh1fBfDOaID4Tt，4服务/21公网静态/15源码一致，worker未重启，功能待人工验收；只调整/template-studio图片与视频工作台，独立图片页由默认门控保留，不改后台/权限/费用或Provider。

| 资料 | 来源与版本 | 内容及用途 | 正式入口与校验 |
|---|---|---|---|
| 模板工作台体验优化工单；2026-10-02-template-workbench-ux.md | 用户先要求工单、后明确实施；v1.0.0 | WS1-WS7、逐文件实现、状态/目录缺口、当前进度与人工边界 | [完整正文](../../tasks/todo/2026-10-02-template-workbench-ux.md)、[发布证据](../../tasks/todo/2026-10-02-template-workbench-ux.evidence.json)；UTF-8/JSON可读，正式正文与开发树同步，已部署待人工 |
| 加载样例与desktop/dark/mobile.png、interaction.webm | 既有认可样例，非新附件 | 刷光参考；0–7.8秒全部195帧父侧观察复用，不作生产验收 | [样例](2026-10-02-loading-study/index.html)、[已有媒体](/Volumes/Data/Projects/video-api-debugger/docs/materials/2026-10-02-loading-study/evidence/)；关键入口可读，媒体沿用既有校验，不公开Git |
| 加载、模板弹窗与图片恢复历史工单 | 已交付历史，不替代当前范围 | 保留既有状态、关闭/未保存保护及后台恢复边界 | 原文及已有附件路径完整列于本工单；已按需读用，不冒充旧附件全部补齐 |

## SD2加载与体验优化实施（2026-10-02）

项目video-api-debugger；2026-10-02用户明确执行U1-U6，替代历史仅文档状态。源码实现、统一发布必需检查与安全部署已完成，v0.36.1；源码8acaf46、BUILD Ec6Hfe91C-vrdLDtYaCKN，4服务/40公网静态/24源码一致、worker正常排空。功能待用户手动验收。唯一工单v1.0.0内容按授权更新，不新建平行方案。

| 资料 | 来源与版本 | 主题/用途 | 正式入口与校验 |
|---|---|---|---|
| SD2加载与体验优化工单；2026-10-02-loading-ux.md | 用户盘点后明确执行；v1.0.0实施记录，应用v0.36.1 | U1-U6状态、局部刷光、产品弹窗、近时、逐文件实现与发布/人工边界 | [完整正文](../../tasks/todo/2026-10-02-loading-ux.md)、[发布证据](../../tasks/todo/2026-10-02-loading-ux.evidence.json)；UTF-8/JSON可读，正式根目录同步，人工待验收 |
| 已认可加载样例 index.html及desktop/dark/mobile.png、interaction.webm、report.json/check.cjs | 既有样例v1.0.0，原件复用 | 动效与布局参考；完整短片0–7.8秒/195帧25fps、无音轨，不作生产证据；脚本不执行 | [正式本地资料](/Volumes/Data/Projects/video-api-debugger/docs/materials/2026-10-02-loading-study/)；关键入口沿用已核验原件，图/视频不公开Git |
| 既有用户画布原图及关联图片恢复/模板工单 | 来源与替代关系见原条目；无新附件 | 原始参考、避免重做已closed恢复后台实现 | 完整原件路径列在工单附件表，本地保存，不公开或外发 |

## 图片生成与原图恢复补充（2026-10-02）

项目：video-api-debugger。主题：GPT图片、生成幂等、Base64、原图续传、完整校验、透明输出、任务交付。2026-10-02用户由仅工单改为明确执行；有效v1.1.0 ID1-ID4已实现并部署v0.36.0，待人工。最终源码afc4489、BUILD vNT0S5yAGwiHTBok0KVLe，4服务/25公网静态/14源码一致，原请求查询已从新生成条件解耦、worker正常排空；无付费生成、功能/离线/浏览器验收、生产库写入。原图仍未救回，透明请求无确证不开放、已退款终态不自动领图。

| 资料 | 来源与版本 | 内容及用途 | 正式入口与校验 |
|---|---|---|---|
| 原图恢复补充工单 | 既有下载超时工单顶部更新；2026-10-02补充v1.1.0，用户确认执行 | ID1-ID4逐文件实现、未知受理/同图恢复/校验/状态、发布回退与人工验收；旧记录保留 | [有效正文](../../tasks/todo/2026-10-01-image-download-timeout.md)、[发布证据](../../tasks/todo/2026-10-01-image-download-timeout.evidence.json)；UTF-8/JSON可读，完整正文与开发树一致 |
| 用户参考脚本 | Untitled-1(1).md；来源/Volumes/Data/Downloads/Current/Untitled-1(1).md；2026-10-02接收，版本未知 | 一次生图、Base64优先、URL GET恢复、校验后交付；脚本有已注明局限，未执行，不公开Git | [原件](2026-10-02-image-delivery/Untitled-1(1).md)；复制后cmp核对、文本可读 |
| 历史官方协查回执 | 2026-10-01-image-download-api-receipt.md；v1.0.0；2026-10-02从canvas-liblib-layout工作树归档 | 两次上游请求、消费匹配、下载超时证据及协查事项；只作历史参考，不公开Git，不重复外发 | [原件](2026-10-02-image-delivery/2026-10-01-image-download-api-receipt.md)；复制cmp一致、正文可读 |

历史问题截图原件仍无可访问入口，不用其他截图替代；协查回执原件已归档并修正工单链接，不把它说成全部历史附件齐备。已核对本轮服务/版本/静态发布，未恢复旧图、未回写账本；源码与发布检查不等于真实交付功能验收。

## 模板主操作与产品弹窗（2026-10-02）

项目：video-api-debugger。来源：用户“同时修改并部署模板相关页面”、已确认暗色青绿色设计与现有源码。主题：主按钮、模板、保存、生成、产品弹窗、未保存保护、发布；本轮无新附件。

| 资料 | 来源与版本 | 内容及用途 | 正式入口与校验 |
|---|---|---|---|
| 模板主操作与产品弹窗 | 2026-10-02 用户授权；实施记录，已部署 v0.34.2 | G1–G4任务、入口覆盖、取消/草稿保护、构建、远端回退及32项公网静态证据；已有原图及历史反馈入口包含在正文中 | [完整正文](../../tasks/todo/2026-10-02-template-primary-actions.md)、[发布证据](../../tasks/todo/2026-10-02-template-primary-actions.evidence.json)；UTF-8/JSON可读，应用工作树副本同步；待用户手动验收 |

## 加载刷光独立样例（2026-10-02）

项目：video-api-debugger。来源：用户要求统一 loading/生成中动效并独立测试。主题：刷光、骨架屏、按钮等待、阶段状态、减少动画。样例版本 v1.0.0，不接生产接口，不代表正式网站已经采用。

| 资料 | 来源与版本 | 内容及用途 | 正式入口与校验 |
|---|---|---|---|
| 独立交互样页 | 本轮打样；index.html；v1.0.0 | 首次加载、刷新保留原内容、提交、模拟上传和生成阶段；周期/亮度/主题可调，设置保存，真实系统减少动画偏好优先 | [样例](2026-10-02-loading-study/index.html)；Playwright 本地独立检查 PASS，桌面/390px截图已查看 |
| 样例检查脚本 | check.cjs；2026-10-02 | 仅本地文件：动效、状态切换、防连点、恢复、390px 布局与减少动画；无真实生成或生产验收 | [脚本](2026-10-02-loading-study/check.cjs)；检查结果见同目录 evidence/report.json |
| 参考原图 | 既有用户画布原图，未修改 | 作为列表及完成态样图，不冒充生成视频；沿用画布方案拆分资料归档 | [原件](2026-10-02-canvas-plan-split/codex-clipboard-1f20d528-af7d-4e00-b5b5-e1d90892de90.png)；复用已核验原件 |

设计借鉴 MUI Skeleton wave 的变换刷光与减少动画处理；已阅读官方文档及 Skeleton.js 实现，未引入 MUI 依赖或复制其组件。来源：https://mui.com/material-ui/react-skeleton/ 与 https://github.com/mui/material-ui/blob/master/packages/mui-material/src/Skeleton/Skeleton.js 。样例仅本地打开，未公开发布用户原图。

L1：加载动效独立打样，已完成。完成标准：可交互比较各状态，桌面/手机布局及减少动画模式检查通过。证据：同目录 evidence/report.json、desktop.png、dark.png、mobile.png 与 interaction.webm；仅本地保留。发现并修复完成态预览图越界遮挡，整批复测通过；无真实任务请求、无 JavaScript 错误、无外部网络请求。风险分级 L1：隔离样例，没有业务接口、权限或数据变化；未做线上功能验收或部署。

2026-10-02 用户认可上述loading样例，并要求处理既有技能和触发条件。已更新全局 /Users/gouki-youdoo/.codex/skills/loading-state-design/SKILL.md 为v1.1.0，统一局部刷光参考、异步等待自然触发、真实阶段和授权边界；配套可复用CSS及结构/链接/独立CSS检查通过。S1“更新加载状态技能”已完成：触发条件、刷光规范、真实状态和授权边界清楚，结构校验通过。认可样例及技能更新不代表本项目正式页面已接入，也不授权全站批量替换；样例自身仍为v1.0.0。技能完整规范留在技能内，此处只登记来源与项目认可事实。

## 画布视频方案拆分（2026-10-02）

项目：video-api-debugger。来源：用户原工单、画布截图、本侧聊提示词格式及简化讨论。主题：方案拆分、提示词、视频节点、参数继承、任务恢复、结果选用。v0.35.0 已部署；SP1–SP5 已实现并部署待人工，SP6 发布检查与正式归档完成；assetId 如实 null，不创建 Asset。完整发布与回退记录见[原工单](../../tasks/todo/2026-10-01-canvas-plan-split.md)，逐文件 SHA 和检查见[发布证据](../../tasks/todo/2026-10-01-canvas-plan-split.evidence.json)。

| 资料 | 来源与版本 | 内容及用途 | 正式入口与校验 |
|---|---|---|---|
| 当前简化工单 | 2026-10-02 用户“补”后明确“落地”；v1.1.0 | 固定格式、单方案单视频节点、预览调整、保存、防重复、任务结果与人工验收；替代旧复杂首版；实际实施进度留原工单 | [有效正文](../../tasks/todo/2026-10-01-canvas-plan-split.md)；UTF-8 可读，关键原图复用已核验原件 |
| 历史原方案 | 2026-10-01 侧聊文件；原文件名 2026-10-01-canvas-plan-split.md；v1.0.0 | 原始结构化/AI/方案组设计，保留来源，已被 v1.1.0 替代，不作为当前实施规格 | [历史原件](2026-10-02-canvas-plan-split/2026-10-01-canvas-plan-split.md)；复制后 cmp 核对 |
| 用户画布原图 | 原文件名 codex-clipboard-1f20d528-af7d-4e00-b5b5-e1d90892de90.png；2026-10-02 归档 | 原节点及上下游场景参考；保留原名、未修改；本地资料，不公开 Git | [图片原件](2026-10-02-canvas-plan-split/codex-clipboard-1f20d528-af7d-4e00-b5b5-e1d90892de90.png)；复制后 cmp 核对，PNG 可读 |

原始来源目录：/Users/gouki-youdoo/.codex/visualizations/2026/10/01/01a0f7f9-21b0-79c2-abe7-9c479680591d/canvas-plan-split/。历史原件与当前工单分别保存，归档不授权实施或部署。

## 统一创作资源库（2026-10-02）

项目：video-api-debugger。来源：用户本轮风格广场截图、本站源码及既有工单。主题：素材库、图集、图片/视频模板、风格、生成交接、用户体验。

| 资料 | 来源与版本 | 内容及用途 | 正式入口与校验 |
|---|---|---|---|
| 功能盘点、审查及落地清单 | 用户要求；本轮侧聊更新；审查d08e9df，发布81de84c/v0.34.1 | I1–I3盘点、A1–A4审查及B1–B3/U1–U6实现与发布证据；待用户手动验收，统一目录未合并；含发布预约流程缺口 | [完整正文](../../tasks/todo/2026-10-02-unified-resource-library.md)；与侧聊副本cmp一致、可读 |
| 风格广场原图 | 用户截图；原文件名codex-clipboard-c227fe09-9c94-47d3-9259-224ace6380d7.png；2026-10-02接收 | 分类、收藏/最近、商业授权与选用流程参考；PNG原件，未修改；不公开Git | [原图](2026-10-02-unified-resource-library/codex-clipboard-c227fe09-9c94-47d3-9259-224ace6380d7.png)；与已核验来源cmp一致、PNG可读 |
| 同图新增素材库入口设计反馈 | 2026-10-03用户剪贴板；本次原文件名codex-clipboard-fdeeedfb-713b-4667-8d6d-e6b73cca8e4e.png，原件v1；与上方原图完全相同，复用、不建重复副本 | 项目video-api-debugger；关键词直接开库、库内上传、分类、收藏、最近、搜索；新需求不替代旧参考图。入口直接库及库内上传为用户明确要求，其余为设计建议；[完整设计v1.1.0](../../tasks/todo/2026-10-02-unified-resource-library.md#9-统一添加入口与素材库设计2026-10-03) | [复用原图](2026-10-02-unified-resource-library/codex-clipboard-c227fe09-9c94-47d3-9259-224ace6380d7.png)；两份来源SHA256一致60f976ac3aafc8e52dd4e24f590f4cc0f89fe37c5fa6eb9705c4479cc4e349b4，PNG可读，仅本地保留；本轮未改应用 |
| 本站原有分类评估与重设计 | 2026-10-03用户追加要求；设计v1.2.0修订v1.1.0的分类建议，旧草图保留，不代表分类迁移已批准 | 项目video-api-debugger；关键词类型、来源、项目、图集、模板分组、内容/用途标签。保留真实旧分组、分层展示，不照搬截图分类；默认组与接口源码已核对，生产自建组/使用频率未采集，新标签未实现 | [分类完整方案](../../tasks/todo/2026-10-02-unified-resource-library.md#99-原有分类评估与重新设计2026-10-03)，文档可读；仅设计及记录，未改应用/数据或重新生成图片 |
| 素材库整合设计预览 | 2026-10-03用户要求生成图片；内置image_gen产出，原文件名exec-d74cc97f-9304-4981-aa45-96465ee424fb.png，保留原始生成文件；预览v1，不替代上方用户参考原图 | 项目video-api-debugger；关键词库内上传、搜索、收藏、最近、来源、已选区。虚构示例素材与数量，不是实机截图、功能验收或用户认可结果；[预览记录](../../tasks/todo/2026-10-02-unified-resource-library.md#97-界面图片预览2026-10-03) | [设计预览](2026-10-03-unified-resource-library/asset-library-design-v1.png)，1448x1086 PNG可读；原始产物与归档SHA256一致22156f36940da0d3d4109da7550cab0844224a7592162084410140106cb008f1；仅本地归档，不公开Git或部署 |
| 视频参考素材库整合预览 | 2026-10-03用户要求生成一张；内置image_gen产出，原文件名exec-2be5dbf4-25da-4b0c-870f-75a269447e4c.png，保留原始生成文件；视频版预览v1，与图片版配套，不替代用户原图 | 项目video-api-debugger；关键词图片/视频/音频、搜索、收藏、最近、库内上传、有序已选。示例素材/时长/数量，非实机截图或模型规则验证；[预览记录](../../tasks/todo/2026-10-02-unified-resource-library.md#98-视频参考素材窗口预览2026-10-03) | [视频版预览](2026-10-03-unified-resource-library/video-reference-library-design-v1.png)，1448x1086 PNG可读；原件与归档SHA256一致91f14a64b77e74fd150982739763db3c072777b58a82ea60f239f5d8deedf724；仅本地归档，不公开Git或部署 |
| 新分类视频参考素材库预览 | 2026-10-03用户要求重新生成；内置image_gen产出，原文件名exec-7c52b3b7-463f-4bd6-9fe9-541358411200.png，原件保留；视频版v2对应设计v1.2.0，旧v1保留对照 | 项目video-api-debugger；关键词图集/项目导航、类型/来源分离、库内上传、收藏/最近、已选。名称、目录、素材及数量为示例，未改线上分类；[预览记录](../../tasks/todo/2026-10-02-unified-resource-library.md#910-新分类布局预览2026-10-03) | [新版预览](2026-10-03-unified-resource-library/video-reference-library-design-v2.png)，1448x1086 PNG可读；原件与归档SHA256一致a4765abe61c2639916511d57ad42b9dec6dea5e34cd788b7c81d6edb8e647aca；仅本地保存，不公开Git或部署 |
| 模板素材与弹窗反馈 | 2026-10-01历史工单，来自同一侧聊工作树 | 固定素材权限和三分区边界；不是本次新bug | [历史原文](../../tasks/todo/2026-10-01-feedback-template-assets-dialogs.md)；副本一致，关联旧附件未逐项复核 |
| 图片下载超时 | 2026-10-01历史工单 | 原图失效、慢速源站与恢复缺口 | [历史原文](../../tasks/todo/2026-10-01-image-download-timeout.md)；副本一致 |
| 复制分享及离开提醒 | 2026-10-02历史工单，v0.34.0 | 已部署能力及待用户验收边界 | [历史原文](../../tasks/todo/2026-10-02-media-copy-share.md)；副本一致 |

本索引只覆盖本次归档，不冒充全项目资料已收齐。完整正文从侧聊工作树复制到正式根目录；历史原文保留版本，不替代当前应用源码。旧工单关联附件中已有5个缺失入口仍未恢复，不能将历史文档归档理解为全部旧附件已校验。

## 模板保存与最新生成异常（2026-10-03）

项目：video-api-debugger。来源：用户本轮剪贴板截图及明确确认。主题：保存按钮、主图最多1张、待确认、HTTP 502。原件仅本地保存，不公开Git或部署；完整要求及实施进度见[既有工单](../../tasks/todo/2026-10-02-feedback-primary-navigation.md#图片模块保存位置主图默认与g1诊断2026-10-03)。

| 原文件名 | 摘要、用途与版本 | 正式入口与校验 |
|---|---|---|
| codex-clipboard-03172503-81ea-4c23-a3cd-35b17c7ad922.png | 2026-10-03用户截图；保存按钮在表单底部紧贴选项；N1位置参考。N2已确认默认主图最多1张，不是结果张数；原件v1，无替代关系 | [原件](2026-10-03-feedback-template-save-default/codex-clipboard-03172503-81ea-4c23-a3cd-35b17c7ad922.png)；737x936 PNG可读；原件/副本SHA256一致a7ab662013168aa6958ff9ed67dcf66eb65190210a76f417510e19e0c3b985d4 |
| codex-clipboard-9f700e16-f9d4-4e3c-a789-503a78fa5a19.png | 2026-10-03用户最新截图；两条img2.5-S最高4K结果待确认；G1只读诊断参考，更新事故时段、不替代凌晨原图；原件v1 | [原件](2026-10-03-feedback-generation-results/codex-clipboard-9f700e16-f9d4-4e3c-a789-503a78fa5a19.png)；572x470 PNG可读；原件/副本SHA256一致b91dcb90d0b60b33cc8fa287050a2d8b01c1f356d08e8290a35886c7b13789b0 |

10:04-10:06北京时间只读核对：本批3条请求10-12秒后收到生成接口HTTP 502、无原图；队列未重启，配置9月22日后未更新。本轮未重发、不修改任务/账务/Provider；502内部原因未知。截图不含任务ID，不将截图与某条任务强行一一对应。

### 图片生成重复确认反馈

2026-10-03用户明确不需要截图中的重复提醒。来源：用户剪贴板；主题：确认生成、旧待确认记录、误触发、恢复设置。属于R1修复，不是此前I5未保存关闭提醒；[完整原文和进度](../../tasks/todo/2026-10-02-feedback-primary-navigation.md#r1图片生成重复确认2026-10-03)。原件v1，无替代关系，仅本地保存。

[codex-clipboard-f5514b6f-ae53-432d-bb56-8ddb68123c16.png](2026-10-03-feedback-generation-confirm/codex-clipboard-f5514b6f-ae53-432d-bb56-8ddb68123c16.png)：生成图片时“确认生成/新建生成任务”弹窗，说明可能再次产生上游费用。795x751 PNG可读；原件及副本SHA256一致29f2362016356ef7c8b548065296dc564b02188e19982bf5cb6164065465eb3f。不能从截图推断用户改了任何设置。

### 弹窗位置反馈

2026-10-03用户明确要求“弹窗不要弹角落，要弹就弹在触发按键范围附近”，归属video-api-debugger；关键词：P1、角落、按钮附近、确认框、命名框、小屏、键盘。复用上方R1原件v1，来源和原文件名不变、无替代版本；截图左上角弹窗为定位参考。文件未变，复用可读性/完整性校验。[既有工单P1](../../tasks/todo/2026-10-02-feedback-primary-navigation.md#p1统一弹窗定位2026-10-03)记录范围与进度；原图仅本地不公开。

### 文案GPT模型真实连通测试

2026-10-03用户纠正测试范围为“文案类gpt模型测通”，在费用说明后明确要求直接执行。北京时间13:34:51-13:35:18以正式服务器现有适配器逐项真实请求，6/6成功；主题/关键词：T1、GPT-5.5、GPT-5.6 Luna/Sol、GPT-6 Luna/Sol/Astra、json_object、1265 tokens、零重试。来源是本轮实际API诊断，不是用户截图或静态推断；[完整记录](../../tasks/todo/2026-10-02-feedback-primary-navigation.md#t1静态核对与真实测试结果)及[结构化证据textConnectivity](../../tasks/todo/2026-10-02-feedback-primary-navigation.evidence.json)。v0.36.6运行源码不变，生成证据可解析并已核对6项返回模型名/格式，不含凭据或用户私有内容；替代此前T1未执行状态，不替代P1手动页面验收。实际费用未知，不含长文案、队列或浏览器全流程测试。

### 模板上下文复制粘贴

2026-10-03用户文字要求在模板上下文输入框上方加复制和粘贴按钮，归属video-api-debugger；关键词：C1、复制全文、粘贴文本、光标/选区、输入框上方、上下文权限、字数上限。没有新附件，复用[模块上下文原图](2026-10-03-feedback-template-save-default/codex-clipboard-03172503-81ea-4c23-a3cd-35b17c7ad922.png)，原件v1和既有来源/校验不变，无替代关系、不重复校验或公开原图。[固定工单C1](../../tasks/todo/2026-10-02-feedback-primary-navigation.md#c1上下文复制粘贴2026-10-03)记录实现及发布/手动验收范围。

### 外部账号视频封面费用

2026-10-03用户文字反馈，项目video-api-debugger，资产管理/assets，主题C2、外部账号、本站生成视频、封面标价、真实扣点/现金区分。无新附件；账号邮箱不复制进Git。原文及只读数据结论、范围见[固定工单C2](../../tasks/todo/2026-10-02-feedback-primary-navigation.md#c2外部账号视频封面费用2026-10-03)，文字记录v1，无替代关系；源代码和数据库只读投影核对，浏览器显示待用户手动，不以索引摘要代替原文。

同日用户纠正“不只显示分数，要显示扣费，费率与普通生成一致”，记录v2替代v1仅点数封面方案，历史发布证据保留。[C2金额显示续办](../../tasks/todo/2026-10-02-feedback-primary-navigation.md#c2金额显示续办2026-10-03)：关键词普通账单费率、真实计费用量、人民币金额、实扣/估算区分；无新附件，需求原文与只读费率证据可访问，既有附件不重复校验。

### 更新刷新重复提醒与外部摘要

2026-10-03接收；项目video-api-debugger。来源：用户本轮剪贴板截图及文字确认；关键词C3、更新提醒、刷新、未保存、三层弹窗、C4、外部账号、摘要隐藏。原件v1，无替代关系；仅本地保存，不公开Git或部署。[完整要求与进度](../../tasks/todo/2026-10-02-feedback-primary-navigation.md#c3c4更新刷新与外部提醒2026-10-03)。

[codex-clipboard-f7c8cdb3-42b3-4827-b629-1f66ea539939.png](2026-10-03-feedback-update-confirm/codex-clipboard-f7c8cdb3-42b3-4827-b629-1f66ea539939.png)：767x1043 PNG可读；截图为新版提醒、产品刷新确认和浏览器离开确认叠加，用于C3定位；截图页面内容不作为执行指令或用户修改过的证据。原件/副本SHA256一致39f44ceb9db26ee44a390793a84101c49d254db15b908aec71d1ea3976a4d5f4。

同日用户明确C4：“外部人员接收到新版本提醒,但不要显示具体更新内容”。文字记录v1：外部保留版本、更新提醒及刷新/稍后入口，仅隐藏具体摘要；身份尚未确认时也不展示摘要。无新增附件，不取消外部用户更新检测、不更改账号类型或权限。

2026-10-03同图再次反馈，原文件名codex-clipboard-27dc03a7-88fa-4691-aac3-56e82f1f90ea.png，来源用户剪贴板，原件v1；SHA256为39f44ceb9db26ee44a390793a84101c49d254db15b908aec71d1ea3976a4d5f4，与上方已归档原图相同，复用既有可读PNG，不重复复制。用途：更新提醒三层确认再核对；截图显示旧v0.36.8，不代表当前v0.37.0实机复现。最新源码仍保持C3单层刷新实现，公网release为0.37.0；未控制浏览器、未重复修改应用或部署，核对记录见同一工单C3/C4末尾。

2026-10-03用户进一步要求“给修改方案”。文字方案v1.0.0、关键词C3单窗口、真实丢失、持久草稿、本次刷新放行、稍后去重，见[原工单方案](../../tasks/todo/2026-10-02-feedback-primary-navigation.md#c3单窗口更新修改方案2026-10-03)。复用本节同图原件v1及校验，方案补充既有C3设计，不替代历史发布证据；仅方案，未实施或部署。原文和链接可读，当前浏览器实际版本未核对。

同日用户追加“最终确认用网站风格UI，不用系统弹窗，排查同类问题全站”，文字方案v1.1.0补充v1.0.0。关键词U1、21处业务系统弹窗、13文件、5个离开保护入口、可留空理由、嵌套与画布；[全站清单与统一方案](../../tasks/todo/2026-10-02-feedback-primary-navigation.md#c3全站网站风格确认方案2026-10-03)。源码字面搜索及定向读取已完成，无新附件，原图/来源/校验不变；未实施应用或上线，未做动态别名穷尽或实机验收，不将源码排查结果标作线上显示通过。

同日用户明确“改”，授权实施v1.1.0及正常提交、推送、正式服务器部署；当前实施与正式证据见[U1全站网站确认实施](../../tasks/todo/2026-10-02-feedback-primary-navigation.md#u1全站网站确认实施2026-10-03)。21处业务弹窗、单窗口更新、共享一次刷新保护、真实丢失/进行中状态和画布草稿已完成代码接入并部署v0.37.1，应用39010f7/BUILD weh6ZSLi1ojK25-2vyXQm；构建与部署检查完成，功能待用户手动验收。正式根本机[统一代码差异](2026-10-03-feedback-update-confirm/implementation-v0.37.1.diff)涵盖本批28份应用文件，[发布检查证据](2026-10-03-feedback-update-confirm/deployment-v0.37.1.json)记录4入口、40静态SHA和28源码一致性；可读、版本与提交对应，辅助证据不重复逐项哈希。用途：本轮交付、恢复及手动验收定位，替代此前“应用未实施”当前状态，不删除历史记录。不新增或复制同图，原件及SHA校验复用；素材和本机证据目录不Git上传或部署。

### 统一素材库批准实施

2026-10-03用户最新明确要求“按照最新的设计落地”，项目video-api-debugger，资料版本v1.2.0设计，应用交付v0.37.0；关键词：L1–L3、统一素材库、库内上传、类型/来源分离、真实项目图集、收藏、最近选用、全范围搜索、有序选中、候选发布。正式根原图[video-reference-library-design-v2.png](2026-10-03-unified-resource-library/video-reference-library-design-v2.png)用于桌面布局，1448x1086 PNG已有可读/一致性证据，本轮已view_image，不重复哈希；原件仍私有，不Git上传或部署，无新附件。v2替代视觉v1，§9.9分类设计v1.2.0有效。[固定工单§10](../../tasks/todo/2026-10-02-unified-resource-library.md#10-最新设计实施与发布2026-10-03)记录源码、授权边界、发布检查及手动验收缺口；正式根只同步记录，不覆盖旧应用或无关dirty todo。

同日已部署v0.37.0，应用6d2f390/BUILD JmPs7-sSzCKO0_LJ_YKrJ，候选内置检查、self Review、远端回退tag、公网版本/新静态/健康与持久数据保护有据；待用户手动验收。L2部分完成：use-only且无原图下载权限的共享/公共图片暂不支持图片工作台，窗口逐项解释并禁选；本人task-only视频已有正常下载GET→上传适配，不启动交付队列。正式根本机[统一代码差异](2026-10-03-unified-resource-library/implementation-v0.37.0.diff)仅含本批14个应用文件，原图不变，差异可读；Git中使用工单所列commit入口，不重复上传私有素材目录。

### 导航与媒体封面交互

2026-10-03本轮用户浏览器评论及文字需求，项目video-api-debugger，文本v1；关键词C5/C6/C7、固定顶栏、单击恢复/双击放大、视频卡内播放、查看靠右、封面左上点赞收藏。原文、1068x871标记及实现/同类分类见[固定工单C5-C7](../../tasks/todo/2026-10-02-feedback-primary-navigation.md#c5-c7导航与媒体封面交互2026-10-03)。浏览器评论截图1/2仅在聊天可见，原文件名/本地路径未提供，待补持久原件；未归档、可读/完整性未核验，不用旧U1截图或自动截图代替。截图v0.37.0不表示当前正式应用回退。北京时间2026-10-04 00:10:42已发布v0.37.2，应用fb630d8/BUILD zCelY_zSjwH6rS-xpfzLN，C5/C6/C7均已部署待用户手动；不因换日再升级，不替代旧U1/C2等历史素材和发布记录。正式根本机[本轮统一diff](2026-10-03-media-cover-interactions/implementation-v0.37.2.diff)及[部署检查证据](2026-10-03-media-cover-interactions/deployment-v0.37.2.json)保持私有，不Git/部署；差异可读，证据对应同一应用提交，原截图仍待补。1000ms单击有界窗口及无法保证任意OS双击设置的边界见工单，不以构建/发布冒充功能验收。

2026-10-04追加C8，文本v2补充不替代C5-C7；关键词版本号半字号、正常字重、品牌不变。原文与已发布后独立PATCH0.37.3路径见[工单C8](../../tasks/todo/2026-10-02-feedback-primary-navigation.md#c8最新补充2026-10-04)。浏览器评论截图3（C8）仅聊天可见，原文件名/磁盘路径未提供，待补持久原件，可读性/完整性未核验；截图v0.37.1不是正式回退证据，不用旧PNG代替。北京时间2026-10-04 00:25:53已发布v0.37.3，应用1c9930c/BUILD J3lGF2j4oXVNQCRQ_lYos；C5-C8完整保留，待用户手动。正式根本机[最终C5-C8统一diff](2026-10-03-media-cover-interactions/implementation-v0.37.3.diff)、[0.37.3发布证据](2026-10-03-media-cover-interactions/deployment-v0.37.3.json)可读、对应同一提交，仍私有；0.37.2证据保留，不重复新建资料/设计说明。

### 深夜配色与周期额度用户列表

2026-10-04，项目video-api-debugger，来源为用户本轮文字要求；原文件名不适用，无附件，文本v3交付补充不替代历史素材。关键词：D1、深夜模式、白页、主题tokens、D2、周期额度、用户列表、候选成员与适用名单分离。原文、源码证据与范围见[固定工单D1-D2](../../tasks/todo/2026-10-02-feedback-primary-navigation.md#d1-d2深夜配色与周期额度列表2026-10-04)，正文可读。已明确D1补齐默认暗工作台，不新建主题开关；共享页面/组件及局部白UI已于北京时间01:50:27发布0.37.4，应用b127209/BUILD ZgKKw-0pLsNEIe24xVMJt，待用户手动视觉验收，媒体/作品/纸面保留。D2普通用户管理无周期额度排除及规则筛选联动，额度候选成员却复用适用名单筛选；具体列表待用户答复，调查已完成未改额度/权限，不冒称D2完成。正式根本机[本轮统一diff](2026-10-04-dark-ui-periodic-list/implementation-v0.37.4.diff)、[部署证据JSON](2026-10-04-dark-ui-periodic-list/deployment-v0.37.4.json)可读，内容对应同一应用提交，私有不Git或部署；检查说明见工单，不以发布证据替代视觉验收。

### 播放时隐藏封面按钮

2026-10-04，项目video-api-debugger，来源为用户文字需求“单击播放后，封面不要出现播放按键”；原文件名不适用，无新附件，文本v2交付补充。关键词：P1、视频封面、播放按钮、悬停、键盘聚焦、等待与错误反馈。原文、根因、共用引用和实现范围见[固定工单P1](../../tasks/todo/2026-10-02-feedback-primary-navigation.md#p1播放时隐藏封面按钮2026-10-04)，正文可读；移除播放期间hover/focus强制显示覆盖，保留透明点击区及等待/重试。北京时间06:53:11已发布0.37.5，应用da4e285/BUILD FkdpYXAklqREmAjtSKyog，待用户手动，不冒称视觉验收。正式根本机[本轮统一diff](2026-10-03-media-cover-interactions/implementation-v0.37.5.diff)、[0.37.5部署证据](2026-10-03-media-cover-interactions/deployment-v0.37.5.json)可读、对应同一应用提交，私有不Git/archive，旧版本证据保留。D1配色与C5-C8/U1保持，D2仍待具体列表确认；本轮无新附件，不冒用历史截图。

### 历史恢复、查看与版本字号

2026-10-04，项目video-api-debugger，来源用户本轮R1/R2文字及R3浏览器评论，文本v2交付补充；关键词R1直接恢复、R2无文字Eye查看、去重复入口、R3版本字号增加50%。原文、范围和实施见[固定工单R1-R3](../../tasks/todo/2026-10-02-feedback-primary-navigation.md#r1-r3历史恢复查看与版本字号2026-10-04)，正文可读；只取消历史恢复专用确认，其他安全/付费/退出保护保留。北京时间08:00:29已发布0.37.6，应用2cb3e9b/BUILD 9OIK8DVopn89g3Quh4LRG，R1-R3均待用户手动验收。当前资料补充不替代C5-C8/P1旧图与旧记录。正式根本机[本轮统一diff](2026-10-03-media-cover-interactions/implementation-v0.37.6.diff)、[0.37.6部署证据JSON](2026-10-03-media-cover-interactions/deployment-v0.37.6.json)可访问、对应本次提交，私有不Git/archive；候选构建及发布检查、一次标记误报守旧与证据复用详见工单。

关键用户原件已查看可读，按原文件名归档在正式根/Volumes/Data/Projects/video-api-debugger/docs/materials/2026-10-03-media-cover-interactions，源路径/var/folders/lt/cl_ckbmn1jl2wwj44t43qm6h0000gn/T/加各原名；均私有、不Git/archive：
- [codex-clipboard-bf8b8e0b-ce42-4ded-9a04-3db19b540822.png](2026-10-03-media-cover-interactions/codex-clipboard-bf8b8e0b-ce42-4ded-9a04-3db19b540822.png)：接收2026-10-04，用户本轮clipboard，R1恢复历史设置弹窗证据，原件v1非替代旧PNG，39476字节，源/归档SHA256 16480b548d9736ec65f9d0c2cbea6361253cf958ef54d6f3bf1d12f4115e4361一致。
- [codex-clipboard-f479bf73-86c9-44cc-9d9c-ff24143aa971.png](2026-10-03-media-cover-interactions/codex-clipboard-f479bf73-86c9-44cc-9d9c-ff24143aa971.png)：接收2026-10-04，用户本轮clipboard，R2恢复按钮及重复查看操作行证据，原件v1非替代旧PNG，22347字节，源/归档SHA256 09c884786253ebb0a1a44683764aa07bbbfa740941c3242b88aa009910a6ef55一致。

R3浏览器标记图仅聊天像素，原文件名/本地路径未提供，待补持久原件，可读/完整性未核验，不拿上述两PNG冒充。历史OS双击1000ms边界仍在，D2具体列表仍待确认。

### 视频比例、风格卡片与数量控件

2026-10-04，项目video-api-debugger，用户文字与浏览器评论，文本v2交付补充，关键词S1视频contain固定外框/竖屏黑边、S2卡片选用/取消与管理事件隔离、S3标题行高/主图风格组参考图数量select。原文、真实源码证据及范围见[固定工单S1-S3](../../tasks/todo/2026-10-02-feedback-primary-navigation.md#s1-s3视频比例风格卡片与数量控件2026-10-04)，正文可读；北京时间14:07:40已发布0.37.7，应用bce7033/BUILD p7KYo9xeDmtuYO7YZCc9y，S1-S3均待用户手动验收，不替代R1-R3和历史资料。用户已确认外框不变，不裁剪拉伸，不改数量/选中/保存业务。正式根本机[本轮统一diff](2026-10-03-media-cover-interactions/implementation-v0.37.7.diff)、[0.37.7部署证据JSON](2026-10-03-media-cover-interactions/deployment-v0.37.7.json)可访问且对应同一应用提交，私有不Git/archive；检查与回退证据见工单。

本轮浏览器标记截图2张仅聊天像素，原文件名及本地路径未提供，待补持久原件，未归档或核验复制完整性：S2风格组dialog target dialog.studio_styleDialog，S3主图select target materialHeading select，页面template-studio/1068x871/v0.37.6，适用本轮卡片与紧凑控件要求，不当作线上回退证据。既有[R1恢复原图](2026-10-03-media-cover-interactions/codex-clipboard-bf8b8e0b-ce42-4ded-9a04-3db19b540822.png)和[R2操作行原图](2026-10-03-media-cover-interactions/codex-clipboard-f479bf73-86c9-44cc-9d9c-ff24143aa971.png)保持私有、可读且前轮hash已核，仅参考保持前修，不冒充本轮原件或自动截图。

收尾追加“每模板12张/3行、超出翻页、宽屏与开源方案”文字为独立设计咨询，2026-10-04，原文件名不适用，无附件；parent另行只读研究，本批未实施分页，也未因此增加应用版本。D2仍待具体列表；OS双击时序和外来预裁素材边界仍登记。
