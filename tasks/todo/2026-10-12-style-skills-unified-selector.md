# 视频生成页：PG-UI03/04与PG-IP01前置安全摘录

本文件仅含本次§13可实施前置节；完整历史与用户原件沿正式项目根同路径的本地私有原单保留，不随本次推送。当前仅文档交付，应用未实施未部署。

## 13. PG-UI03/04 视频生成页四图布局前置工单（2026-10-30，R01）

**阶段切换：本轮仅前置，前置完成不等于已实施。** 用户最新要求“先整理成前置工单”优先；PG-UI03仍为“视频生成页四处布局调整”，本轮完成标准改为四项设计、源码落点与手验标准齐备；PG-UI04仍为“提交与发布”，本轮只提交推送文档，应用实施/构建/发布不在范围内。此前PG-UX01/02的v0.118.4交付保留历史，不能用它冒本四项已上线，也不沿用此前自动部署授权。

| 编号 | 原任务名称 | 本轮完成标准 | 状态 |
|---|---|---|---|
| PG-UI03 | 视频生成页四处布局调整 | 四项设计、源码落点与手验标准齐备 | 前置已完成；应用未实施 |
| PG-UI04 | 提交与发布 | 本轮仅文档聚焦提交推送；应用实施/发布范围外 | 文档已提交推送；应用未实施未部署 |
| PG-IP01 | 同一模型下拉整合IP生成线路（U5追加） | 真实线路目录、当前输入换线、草稿/素材恢复、权限费用和具体接线设计齐备 | 前置已完成；应用未实施 |

### 13.1 当前证据与四原图

本轮匿名release及服务器非敏感源标识鲜核：v0.118.4、ed76434ee1f18c2df27a57cf0972eddcaf63cb78；源码工作树`/Volumes/Data/Projects/.worktrees/video-api-debugger-mv-gen02-20261029`为89dcce39，应用源码与该运行提交无差异且无受跟踪源码脏改。正式根`/Volumes/Data/Projects/video-api-debugger`仍是旧源码/既有资料工作区，不用它替代当前实现。已对上述真实工作树准备CodeGraph并执行context/explore/callers；JSX调用关系有漏报，已回实际import及渲染条件核定。ARCH03另一对话可能继续实施/发布；本单不碰其改动，后续执行必须从当时最新正式源保留其成果，不能冻结本次历史提交或拿未提交内容冒线上事实。

四张用户原图已读取并留存正式根原单的本地私有附件，公开摘录不含图片、提示词片段、原图路径清单或历史私有正文。接手执行时读取正式根同路径原单§13.1即可；本次设计要求和落点在下文完整保留。

### 13.2 选定设计与真实修改落点

| 项 | 已核现状 / 文件函数行号 | 选定实现 |
|---|---|---|
| U1 输入框底部工具条 | `src/components/PromptEditor.tsx:395–445`已含textarea后面的footer、引用按钮、放大入口和计数；`src/app/globals.css:12504/12646/12713`定义共有边界和纵向actions。普通视频在`src/components/GenerationComposer.tsx:2480`传compactVideo，局部`src/components/generate/generate-redesign.css:24`去掉编辑器边框。 | 只在`.generation-composer--video`作用域恢复同一输入边界，textarea与footer同底色、同外框；footer保持正常文档流，左侧图片引用可换行，右侧“放大编辑＋计数”横排。足够内边距，不绝对定位、不遮文本、不固定到页面底部。窄屏允许工具条内部换为两行，计数与放大不被挤掉。沿现有DOM及放大/草稿/引用插入逻辑，不改通用弹窗或其它页面。 |
| U2 素材排序显隐 | `src/components/ReferenceStrip.tsx:420–473`的`.ref-thumb-wrap`包含缩略图及底部`.ref-order-actions`；已有PointerEvents拖排及排除操作按钮的保护，箭头调用同一onReorder。`src/components/generate/generate-redesign.css:18–20`目前常显。 | 只改普通视频CSS：精细鼠标默认opacity 0、pointer-events none，悬停该素材或focus-within时显示；保24px行位避免跳动，不display:none以免键盘入口丢失。触摸/无hover设备常显原左右箭头并保可点区域。首尾disabled、上传/loading、取消拖动和原排序请求完全保留；×/替换/箭头不触发拖排。 |
| U3 已选组紧凑chip | `src/components/generate/PromptGroupPicker.tsx:402–444`的PromptGroupSelection含change/undo和两个30px前后按钮；CSS `src/components/generate/PromptGroupSelection.module.css:1–10`有40×36缩略图、176px主按钮及40px添加键；ResizeObserver仍按280px估算折叠两行。原图3外框约316×65是截图像素，不冒已测CSS/DPR。 | 桌面视觉约158–160×32，名称12–13px，图标18–20px，长名ellipsis且原详情可看完整名；不靠字号减半。去掉chip左右按钮；右上圆形×只在hover/focus-within显示，触摸常显，明确“移除本次引用”，不调用删除API、不确认永久删除。新增、撤销收至同栏32px；触摸可40px高并保32×40命中，这是适配例外，整体面积仍比316×65减少超过一半，不声称40也是高度减半。旧版/失效状态保可识别；“使用最新版本”移入已有详情的显式动作，仍走change/undo，不自动升级。 |
| U4 标题留白 | `src/components/generate/GeneratePageClient.tsx:3413/3458/3466`为普通video根/main/hero；`src/components/generate/generate-redesign.css:1/62`有hero顶8px及手机main顶16px。固定栏由`src/components/ComposerTopbar.tsx:74–83`测量`--composer-topbar-height`，`src/app/globals.css:5117–5122`的shell-root已有占位。 | 只在页面局部样式把`.composer-page--video .composer-hero`上内边距设为24px，保其它间距与标题字号；不再次叠加导航高度、不更改全站shell、固定导航或新建测量器。手验以导航下沿到标题可见顶部至少24px、不遮挡为准，覆盖导航换行与窄屏。原截图证明贴栏感，不由裁剪图冒认唯一运行根因。 |

### 13.3 排序采用已有底座，保完整有序引用

已选定复用`src/app/image-studio/sortable-studio-list.tsx:15–66`，不新建拖排体系、不安装依赖。它已有独立手柄、鼠标4px阈值、触摸350ms长按/8px容差、键盘空格/方向键/Esc、取消不提交和结束恢复焦点。`src/app/multiview/page.tsx:1197–1207`已有同一dnd-kit的rectSortingStrategy及方向键做法。给SortableStudioList增加可选strategy和可选键盘说明：默认仍verticalListSortingStrategy、原纵向说明不变；只有新chip传rectSortingStrategy及四方向说明，不影响`src/app/image-studio/studio.tsx:1328/1345/1406/1410`的四个原调用。

chip用可访问的非button容器，名称/详情按钮、排序手柄和移除按钮各独立，禁止button嵌button。图标槽保持现有底座hover选择器所需的层级（SortableRow→chip→首图标槽→handle），或明确给新chip限定选择器；不靠误缩全局.icon/.thumb。原底座CSS的触摸手柄min32×40继续有效，18–20px只是图形；×不会启动拖排，拖动不会打开详情，触屏先可滚动，长按手柄才排序。至少2项时才显示/启用手柄；单组不多一个无用操作。

一次排序完成才调用现有`change(nextRefs)`，一次撤销恢复完整原数组；Esc、无目标、位置未变或disabled均不改引用。数据以当前`{groupId,versionId}[]`为准，不从summary生成新版本。折叠只拖排可见前缀，按返回groupId重排该前缀后拼回原隐藏后缀，不能丢隐藏refs；需要跨全部排序先点已有“全部N个”。ID集合不完整或被外部替换时取消，不覆盖当前新输入。展开最多原12项，上限、冻结历史及未选项不变。

复用现有ResizeObserver，按新chip宽160、gap8和添加/撤销/全部的实际占位同步计算两行；可将组列表与操作区分成同栏两个非button容器，测组列表可用宽后计算`columns=max(1,floor((width+8)/(160+8)))`、折叠上限`min(total,columns*2)`，窄屏操作区自然换下一行。计算只控制可见数，不改完整refs。保持名称详情、编辑当前原组、显式更新本次版本、添加及撤销；API/私密正文/共享权限不变。

共享影响：Selection的实际唯一渲染入口为`src/components/GenerationComposer.tsx:2491`且仅videoRedesign=true；`src/components/generate/GeneratePageClient.tsx:3269`排除IP和handoff场景。PromptEditor、ReferenceStrip、ComposerTopbar及CSS中的.icon/.plain/.thumb有其它消费者，前三项均以普通video作用域限制；不压缩选择器网格、详情、历史或其它工作台。素材箭头仅改显隐，仍经`src/components/GenerationComposer.tsx:1853`→`src/lib/hooks/useWorkspace.ts:364`→原`/api/workspace/assets/reorder`，不改素材ID、sortOrder、首尾帧角色或提示词引用解释。组顺序也参与服务端组合，`src/lib/video/prompt-groups.server.ts:127–140`沿有序refs拼接，因此不能删除顺序能力或静默排序。

轻量参考已读[React Aria TagGroup实际源码](https://raw.githubusercontent.com/adobe/react-spectrum/main/packages/react-aria-components/src/TagGroup.tsx)：借用标签名称/操作/移除分离、focus-visible与可访问完整名，不接入库；该源码本身不提供这里需要的拖排。项目现有dnd-kit更贴近本次重排，沿已安装版本复用，接入成本为底座两个可选参数与本chip接线，无第三方运行依赖新增。

### 13.4 执行顺序、保护与最小验证计划（本轮不执行）

1. 获后续明确实施授权后，鲜核当时正式源/ARCH03改动/工作树，保护并整合已发布成果；保持v0.118.4的可信OAuth主会话、legacy proof原到期、相容reader及身份policy，不修改auth/security/server权限文件，不回旧parser。
2. 一批完成：局部输入footer、素材hover、chip/可选网格底座及折叠计数、标题留白。主要文件为`src/components/generate/generate-redesign.css`、`src/components/generate/PromptGroupPicker.tsx`、`src/components/generate/PromptGroupSelection.module.css`、`src/app/image-studio/sortable-studio-list.tsx`；PromptEditor/ReferenceStrip/GenerationComposer仅作已有接线核对，非必要不改行为。既有详情可选“使用最新版”只恢复原显式入口，不新增弹层。
3. 工程仅核类型/构建及实际受影响边界：底座旧默认纵向；拖排输出完整同ID/同version集合、隐藏后缀不丢；取消/同位不change、撤销恢复原数组。无必要不新增照抄样式的测试。当前前置不构建、不运行回归。
4. 用户手验最小6组：①工具条在输入边界内、最后一行/长文滚动与中英文输入不遮挡，引用仍插入正确位置，原放大应用/取消保真；②素材hover/focus/触摸显隐、首尾disabled和原实际排序/编号/角色不变；③单组/长名/旧版/失效及多组chip，×只移除本次且可撤销，原组目录和版本不变；④鼠标拖排/触屏长按/键盘四方向、Esc/无目标/disabled、完整顺序与撤销；⑤折叠/展开及窄屏换行，隐藏引用和12项上限保持；⑥固定导航换行、手机与200%缩放下标题不遮挡，普通IP/模板页面保持原布局。静态视觉少量截图即可，连续拖排手验，不新生成、不扣费、不真实保存或永久删除组。
5. 后续若获本批实施/部署授权，复用项目必要候选构建、版本/产物一致性、服务健康、公网及原可恢复保护；只回程序，不回数据库/媒体/账本/原请求。后继ARCH03可能改变恢复对象，届时取最新相容点，不能盲回ed764旧源。当前不预占发布窗口，不升应用版本、不重启。

### 13.5 前置完成核对与Git计划

| 必要前置 | 结果 |
|---|---|
| 四原图、原要求与私有归档 | 已完成：逐图读取、原名复制/尺寸/字节核同，图1不外传 |
| 当前有效来源、真实组件与共享消费者 | 已完成：运行源/工作树核同、CodeGraph与源码交叉核对；ARCH03仅作为后继鲜核约束 |
| 四项设计、触摸/键盘/长名/窄屏/撤销与排序 | 已完成：本节已选定单一复用方案，无下游待选设计 |
| 开源/本项目现成能力 | 已完成：React Aria实际代码及现有dnd-kit底座/网格代码；不装依赖 |
| 构建、浏览器、实际保存删除/收费与部署 | 本轮不适用：用户只要前置，功能用户手验；未冒测试或上线完成 |
| 接手调查或缺失业务决定 | 无必须由下游补做的前置；执行者只需鲜核此后源码变化 |

Git仅聚焦本次脱敏前置文档及固定todo/索引增量，保护正式根旧dirty与ARCH03工作；四图、private附件清单、历史私人工单不上传公共remote。可用当前干净源码工作树承载本次前置节的安全摘录并沿相同原单路径提交，不复制旧私有历史，不建立独立规划目录；文档提交不抬应用版本或部署。唯一误差边界：截图未提供DPR/缩放且本轮无浏览器测量，316×65是原图近似；指定desktop160×32及实际手验准则已明确，不阻塞本轮局部方案。

可复制交接（仅供后续另获实施授权后使用）：

```text
视频生成页四处布局调整
项目：video-api-debugger；正式根/Volumes/Data/Projects/video-api-debugger。
工单：tasks/todo/2026-10-12-style-skills-unified-selector.md §13（PG-UI03/04，当前仅前置完成）。
核心：普通视频输入边界内底部工具条；素材箭头按hover/focus/触摸显示；160×32紧凑组chip复用现有dnd-kit网格拖排，×仅移除本次；标题局部增加留白。
顺序：获实施授权并鲜核最新正式源/ARCH03成果→一批实现本节四项→必要工程构建/复核→依后续授权完成发布，功能由用户手验。
保护：0.118.4主会话来源/legacy及相容reader；完整有序groupId/versionId、隐藏refs、素材ID/role/编号、草稿/撤销/未知原请求；不改权限/收费，不重发。
停止：同文件并发冲突、来源/恢复对象不明、将丢版本/隐藏引用或越权；只暂停受影响动作，保留其它安全成果。
回执：原PG-UI03/04表、实际文件与必要证据、Git/部署真实状态；不能把本轮前置写成已实施。
```


### 13.6 PG-IP01 / U5追加：同一模型下拉整合IP线路（2026-10-30，R02）

用户追加要求“把ip生成的线路也整合进来，在红框这里显示IP sd2.0 等”。本项排在原U1–U4后，继续**仅前置**；PG-UI03/04名称、四图设计及已推送`7bd9ea87`保留，新增PG-IP01，不将追加需求冒成已实施。第5图已读取并按原名保正式根同主题私有目录；含个人提示词和素材，不推公共remote、不外链。正式根同路径原单保完整附件入口。

2026-10-30T15:39:47Z最小鲜核：运行源仍`ed76434ee1f18c2df27a57cf0972eddcaf63cb78`，公网release仍v0.118.4；只读`PlatformSetting`的`volcengine_ip_api_v1`，enabled、ready、API Key已配置、默认型号已配置均为true，默认真实ID为`doubao-seedance-2-0-260128`。只输出布尔和型号，无密钥/凭据/账号列表，无供应商调用。该证据证明站内配置就绪，**不证明每个型号实际出片或所有账号可用**。本工作树7bd9ea87的应用源码与该运行源一致；3份原handoff未跟踪文件保持。

真实现状：`src/app/generate/ip/page.tsx:4`与普通`src/app/generate/page.tsx`复用`GeneratePageClient`，前者传`surface="ip"`。`GeneratePageClient.tsx:361/552/1154/2879/3697`按surface决定旧URL、型号目录、创建端点和报价provider。IP目录由`src/lib/integrations/volcengine-ip-models.ts:14`提供2.0、2.0 Fast、2.0 Mini、2.5；无IP H3。创建走`/api/ip/tasks/create`、`volcengine_ip`报价与`volcengine_ark`任务归属；普通仍走`/api/tasks/create`及原Seedance/H3合同。`src/app/api/config/route.ts`当前`ip_video`只有静态能力目录，尚无enabled/ready；`src/lib/integrations/volcengine-ip.ts:148–169`已有真实就绪判定和安全DTO，可复用并仅返回布尔，不公开完整DTO中的地址或内部配置。

IP create在`src/app/api/ip/tasks/create/route.ts:461`明确拒绝非空提示词组（426），357起拒绝Draft/升级/edit/extend；客户端2881起不发提示词组和飞书选项。IP未接H3/LoRA或普通发飞书开关；本项不新开这些能力。`tasks/todo/2026-10-26-ip-external-api-plan.md`中的独立ip-create服务属历史规划，运行源仍为现有Next API，不能当成可复用成品。

### 13.7 已选交互：用当前输入直接换线

- 原底部模型按钮是唯一新选择入口，仍用`ComposerActionBar`现有锚定短选择层，不再新增线路按钮或“带入刚才输入”。普通Seedance 2.0/2.5、原H3及`IP SD2.0`、`IP SD2.0 Fast`、`IP SD2.0 Mini`、`IP SD2.5`放同一列表；这四项显示名已定，选中后按钮常显对应线路和型号。实际model ID不改名、不别名转发；仍按真实目录、权限和配置决定展示与可选性，配置默认值不取代用户显式型号。
- 内部用户可选既有普通与IP范围；外部用户仅沿原IP权限和入口，不借整合开放普通/H3。当前选择不可用仍可识别并就地说明，不能悄悄回首项或自动切到别的供应商。配置读取中/失败只显示“正在确认/暂时无法确认”，保原线路和输入；已知停用说明暂不可用。创建端点继续重核账号、项目/视频卡、原素材、真实型号、审批、报价和配置，前端ready不是授权。
- **显式选IP代表同一份当前输入换线。** 保当前个人正文、合法素材及其顺序/首尾角色、兼容时长/比例/分辨率/seed/audio等；不先自动恢复目标线路旧草稿。先可靠保存来源完整快照和将被覆盖的目标旧稿，再准备携带当前输入的目标稿；成功后直接换线，不加泛确认。用户要旧稿，从已有“输入恢复”主动恢复该线路的换线前输入。
- 同一线路内换型号保当前正文/素材；目标不支持的规格保持原值并明确待调整，阻止新提交，不静默降清晰度、删素材或改时长。当前素材若目标不支持，继续在参考区可见、完整保来源快照，标出“不适用于当前线路”并阻止新提交；不得借“仅携合法素材”静默筛掉。换线本身不调用素材清空、替换或重传，用户后续主动调整才沿原接口生效。普通提示词组、Draft、H3/LoRA、飞书开关等不兼容选项保在来源快照中，IP不显示为已应用，也不拼正文、不暗发；只在本次确有此类选择时就地简述“本线路未应用……，原线路输入已保留”。纯组无个人正文时，换IP后提示补正文，不以未发送的组满足可生成条件。返回普通时本次当前正文/合法素材仍优先；来源未应用选项可恢复，用户在途中明确改过的字段不被旧稿覆盖。
- 原`/generate`和`/generate/ip`继续兼容直接进入、任务复用和返回链接；保surface接口、偏好键、creation entry及原请求key隔离。菜单跨线路采用现有两route之间的受保护输入交接，两处共享同一紧凑composer外观；独立从旧IP直达入口打开且没有有效换线交接时，仍恢复原mode稿，不把其它页遗留标记当新换线。带模板/image-result handoff的专用上下文保旧路径和能力，不将其混为普通换线草稿。
- 创建发送/报价确认中、原生成/复用/上传关联结果未知、素材变更未确认或恢复未完成时，换线入口就地说明当前等待对象并暂不能切；核原请求，不换身份、不清锁、不重发。仅有已明确受理的运行任务不阻止另起输入换线：其任务/费用/输出沿原线路和原ID继续，离开只停止该页读取，不取消或迁移任务。返回或打开任务详情按原provider/task ID查询，不能按当前下拉重解释旧结果。两线路历史沿原12条分页、权限与对应列表端点，不混总数、不重发。

选择层仍锚定当前模型按钮，非模态、短列表、视口内限高滚动，窄屏向可用方向避让，关闭不换线；键盘可开/上下选/Enter选择/Esc关闭，触摸可用，显示选中和disabled原因，关闭回按钮合理焦点。复用现有层与关闭逻辑，按需补当前模型层的disabled与焦点接线，不更换全站UI库。普通成功只更新选中，无成功确认弹窗；可恢复失败贴近按钮用普通状态文案。

### 13.8 恢复接口核对与最小扩展

`src/lib/hooks/useWorkspace.ts:228–257`已实读：captureRecovery只在账号、工作区、素材/上传/关联都已确认时返回`ownerId/epoch/tabId/workspaceId + assetId/referenceImageId/role/sortOrder[]`（最多80）；restoreRecovery限制同owner/epoch/tab/workspace，复用原关联requestId、replace与逐项role补回，随后核同顺序/角色，失败区分关联是否确认。它是素材恢复接口，**不是可直接用的完整跨线路草稿仓库**；跨route时workspace和tab继续原有身份，不新建/迁移后端workspace，不重传原文件。

`src/components/GenerationComposer.tsx:743–889`已有makeInputRecovery、两份输入保留、真实恢复成功才套参数及原“输入恢复”UI；但ordinary v2草稿（803–836）仅存正文/参数/组，没有素材快照。`src/lib/navigation/task-reuse-client.ts:4–74`的持久备份绑定真实task-reuse操作/回执，不能给换线造sourceTaskId或伪造已复用记录。选定在**同一输入恢复底座**增加有界的`mode-switch`来源类型，与原`task-reuse`回执分开解析，复用既有快照字段、状态与UI，不建新表或新的工作区系统。

具体事务：按账号、tab、creation context、source/target surface隔离保存来源完整快照、目标被替换前快照和仅本次待应用交接（真实来源、目标、选定model、nonce、编辑修订及workspace身份）；写入后读回核同，才能导航/改变选中线路。这是浏览器输入交接编号，不是生成请求号。目标初始化先验证交接身份/上下文/修订，在旧偏好和ordinaryDraft自动恢复之前套用携带稿，防目标旧稿及迟到偏好覆盖；确认套用并持久保存目标当前稿后才清该交接，重复读取幂等、不触发创建。失败保两稿和原线路输入；在导航后发现初始化失效则回原route/源稿并就地报错，不能留下已切成功外观。账号/目标已变化的迟到结果只保快照、不覆盖新输入。

活动素材在换线时本来相同，不调用replace/clear；每个mode的材料快照与对应正文一起保存在现有本地草稿/输入恢复中。用户主动恢复旧稿时才调用workspace.restoreRecovery，按原权限重新关联和核完整顺序/角色。持久快照重新打开后沿既有做法鲜核同owner/tab/workspace，再绑定当前session epoch，不盲改owner或借旧epoch绕切号。没有完整合法素材时不冒恢复完成，保当前现场、原快照及原操作重试入口。

**历史限制**：旧ordinary v2稿未存原素材，没有证据可反推。首次换线仍先保该旧正文/参数，标注“此旧稿未记录素材”，主动恢复该稿仅恢复可核字段并保当前素材，不把空列表冒原素材、不补写/追溯历史；此限制不阻止当前有完整快照的显式换线。来源的现有task-reuse备份和未知回执原样保留，mode-switch不得覆盖或冒充上次任务撤销。

### 13.9 U5实施落点、顺序及受影响验证（本轮不执行）

| 落点 | 必须改什么 / 保什么 |
|---|---|
| `src/components/generate/GeneratePageClient.tsx:539/1154/1240/2879/3269/3645` | 合并展示目录，精确将选择映射surface+原model；接跨旧route输入事务和ready状态。surface仍决定原端点、偏好、creation entry、报价与历史。识别旧URL/外部用户/handoff；已受理结果不重绑。 |
| `src/components/ComposerActionBar.tsx:12/156/218–249` | 沿可选Props向后兼容增加仅UI的线路/型号选择标识，普通使用方仍可用原model ID；模型行落实已有disabled/reason及锚定键盘/焦点。ID映射后传后端原型号，不把UI复合ID写任务。 |
| `src/components/GenerationComposer.tsx:395/743–889/1066–1210/1549–1557/2480–2493/2530/2606` | 输入交接初始化优先、同步可靠保存而不只等200ms计时；复用恢复UI。把共同紧凑布局与提示词组/Draft能力判定分开：IP可用共同外观，但组缺省判定、组合报价、submit payload及样片UI均受明确能力门，未应用内容保来源快照。其它模板消费者默认行为不变。 |
| `src/lib/navigation/task-reuse-client.ts` | 原真实task-reuse读写/undo保持；增量解析mode-switch恢复来源、隔离本地存储及交接读回，补完整参数字段（含draftMode及未应用项）。不伪造taskID、旧回执或改变其schema含义。 |
| `src/lib/hooks/useWorkspace.ts:228–257`、现有`/api/workspace/assets` | 复用capture/restore与原requestId/权限/空恢复CAS，保持接口和归属。换线本身不发素材替换；仅补持久快照结构校验所需最小接线，不造通用workspace平台。 |
| `src/app/api/config/route.ts`、`src/lib/integrations/volcengine-ip.ts` | 既有ip_video投影最小增加enabled/ready；读取故障返回明确unavailable/unknown，不借旧ready放新提交。模型能力仍原目录，创建时继续原server校验；不改账号权限或公开Key/地址。 |
| `src/app/generate/page.tsx`、`src/app/generate/ip/page.tsx`、`src/lib/hooks/use-creation-context.ts`及现有IP API | 路由和上下游合同核对对象；非必要不改。继续旧外部用户拦截、原项目/视频卡/1080p审批、预算与原请求/未知保护。 |

在后续明确实施授权后，从当时最新正式源增量合入ARCH03等成果；先完成恢复来源与换线交接，再接目录/能力和共同外观，U1–U4一批落完后统一工程验证。复用现有React/Next路由、浏览器存储及恢复接口；新增成本是有界快照和接线，不接状态库或新供应商。原§13.3已核React Aria实际源码只用于名称/操作分离；选择层继续已有ComposerActionBar，现成能力满足目标，不新增第三方依赖。

工程验证仅围绕组合身份/真实后端型号、来源和目标稿写入失败、目标旧稿/迟到偏好不覆盖、账号/tab/目标/编辑版本隔离、真实task-reuse与mode-switch共存、字段与素材/role/order完整性、IP组/Draft/LoRA/飞书不出站、原报价/创建同有效参数、未知不重发、旧URL和外部入口。候选构建和部署保护按届时明确实施范围；本轮不构建或跑功能回归。

用户手验新增4组：①红框同一列表选普通/IP 2.0/2.5等及H3现有项，显示真实选择；停用/读取失败不暗切，外部用户仍只见原授权范围；②已有正文+合法素材跨线仍当前输入，旧目标稿仅“输入恢复”主动取回，刷新/旧直达/返回保对应现场，失败不丢两稿；③普通组/Draft/H3参数/飞书选项跨IP未应用有清楚提示、源稿保留，IP可独立输入，返回普通不覆盖途中新编辑；④已受理任务回看仍原线路/费用/输出，提交/上传关联未知只核原请求，兼容规格不变、不兼容值不被暗改，手机键盘和下拉仍可达。真实生成/收费不默认加入手验，本项前置没有出片证明。仅回程序，不回DB/媒体/账本/回执；浏览器本地快照按来源类型向后兼容保留，程序回退不批量清草稿。

### 13.10 增量前置完成与交接

| 必要前置 | 状态 / 证据 |
|---|---|
| U5第5图与原要求 | 已完成：原名私有归档、读取、1499×962与复制一致核对；不上传 |
| 真实运行源、IP配置来源和目录 | 已完成：15:39:47Z服务源/只读最小配置，公网v0.118.4；四候选型号为代码目录、未逐个实测 |
| 同一输入换线及恢复可实施性 | 已完成：现有接口逐段核对、mode-switch最小扩展、旧稿缺素材限制、失败/未知/权限/费用与手验标准已定 |
| 落点与依赖 | 已完成：13.9给具体文件/函数和顺序，不把调查/设计交下游 |
| 业务改动、构建/浏览器/收费/发布 | 本轮不适用：用户仅前置；全部未执行 |

本批可执行前置已齐，仍须后续明确实施授权。正式根同路径保完整原单、五原图、attachments/source证据；工作树同路径仅安全摘录及固定todo/索引，聚焦文档提交推送。原三handoff、正式根旧dirty、线上运行与用户资料保持。此前§13.4“IP保原布局”的手验边界由本U5增量替代：IP可复用同一紧凑外观，能力不因外观开启。守门员按前置/文档范围收口，分级误判无。

```text
视频生成页四处布局与IP线路整合
项目：video-api-debugger；正式根 /Volumes/Data/Projects/video-api-debugger。
工单：tasks/todo/2026-10-12-style-skills-unified-selector.md §13（PG-UI03/04、PG-IP01，当前仅前置完成）。
附件：正式根同路径原单§13.1、13.6所列五原图及本地ui03-preflight目录，含私有内容不上传公共remote。
核心：U1–U4保留；U5在同一下拉选择真实线路+型号，显式跨线保当前输入、旧目标稿进已有输入恢复；原URL/surface/API/权限/费用和未知请求合同保留。
顺序：另获实施授权→鲜核最新正式源及并行已发布成果→按13.9实现恢复交接/目录能力/共同外观及U1–U4→一批必要工程检查→按后续授权发布，功能由用户手验。
保护：无新workspace/新表、无新IP提示词组/Draft/H3/飞书能力、无伪造task-reuse回执、无自动重发或历史回填；旧稿缺素材按已知限制表达。
停止：同文件并发冲突、原输入/关联未知、真实权限/费用/保存恢复失败或最新运行来源不明，仅停受影响动作并保两稿；不把普通工具故障转成用户待办。
回执：保原三编号表、实际文件/证据与未验项、Git/远端/部署真实状态；前置不写成应用已实现或已上线。
```
