# 视频提示词组与普通视频页：PG-UI03/04前置安全摘录

本文件仅含本次§13可实施前置节；完整历史与用户原件沿正式项目根同路径的本地私有原单保留，不随本次推送。当前仅文档交付，应用未实施未部署。

## 13. PG-UI03/04 视频生成页四图布局前置工单（2026-10-30，R01）

**阶段切换：本轮仅前置，前置完成不等于已实施。** 用户最新要求“先整理成前置工单”优先；PG-UI03仍为“视频生成页四处布局调整”，本轮完成标准改为四项设计、源码落点与手验标准齐备；PG-UI04仍为“提交与发布”，本轮只提交推送文档，应用实施/构建/发布不在范围内。此前PG-UX01/02的v0.118.4交付保留历史，不能用它冒本四项已上线，也不沿用此前自动部署授权。

| 编号 | 原任务名称 | 本轮完成标准 | 状态 |
|---|---|---|---|
| PG-UI03 | 视频生成页四处布局调整 | 四项设计、源码落点与手验标准齐备 | 前置已完成；应用未实施 |
| PG-UI04 | 提交与发布 | 本轮仅文档聚焦提交推送；应用实施/发布范围外 | 文档已提交推送；应用未实施未部署 |

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
