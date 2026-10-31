# 飞书原图发送体验与附件后缀修复前置工单

- 版本：v1.0.0 / R01
- 日期：2026-10-31（America/Los_Angeles）
- 状态：**两个问题的必要前置已完成，待后续实施指令；未修改业务代码、未部署。**
- 项目：video-api-debugger
- 正式根：`/Volumes/Data/Projects/video-api-debugger`
- 当前工作区：`/Volumes/Data/HomeRelocated/gouki-youdoo/.codex/worktrees/result-card-layout/video-api-debugger`
- 前置记录分支：`codex/image-feishu-send-ux-preflight-20261031`

## 1. 目标、范围与基线

用户想把结果卡里的完整原图发到本人飞书，点击后知道是否送达，并能正常识别、打开附件。此次只处理两项：

1. **FS-UX01**：点击发送自动展开大块说明、旧通知和多组核对按钮，白底又与暗色工作台不一致。
2. **FS-EXT01**：14MB原图以没有后缀的“原图”文件发送，飞书显示未知类型。

用户最新要求为“两个问题，把前置处理完”。本轮交付调查、已定方案、修改地图、兼容与验收计划；不进入实施、生产写入或消息发送。

实查运行源为`6a0d74f2b5782a52b797cdf99434bb48e15e7bf4` / v0.121.5，BUILD `KKbtPluYPhxXmeN8BjQKp`，代码记录HEAD为`07a5e6f6ebbdd5a7a4c3d4ec3343c909162f34f6`。实施时重新核对实际运行源和工作区差异，不将本次历史commit硬编码为未来起点。

保留普通/批次本人结果共用入口、现有五个35px图标键和44px触摸目标、原件字节及下载、权限、原飞书绑定、费用、旧消息与原操作防重复。中画质4K返2048的供应商待核问题沿原IMG-COMP01记录保留，不混入本次两项。

## 2. 已确认的根因与证据

### FS-UX01

- `ImageFeishuStatus.tsx`的触发器每次点击先`setOpen(!open)`，随后执行本次发送、再必读`runAutomatic()`。因此一次发图操作必然带出完整管理弹层，与单次发送的任务不匹配。
- 弹层默认同时显示原字节/转码/30MB说明、当前发送取消与核对、旧通知状态、旧链接说明和旧通知核对。用户需要替系统判断两套发送记录。
- `.module.css`使用`var(--panel-bg, #fff)`；实际根主题只定义`--bg-panel`，全src未发现`--panel-bg`定义。portal中的背景回退为白色，文字仍用暗色主题的`--text-primary`。这是可定位的主题变量错误。
- 当前完成图片的父列表通常15秒刷新，发送组件没有针对刚发起发送的短时观察，正常用户仍会看到“待发送/核对状态”。HTTP创建回执不等于消息已送达。
- 普通和批次均共用该组件，因此在组件层修复；不复制两套交互。
- 截图中的蓝色选中/底部扩展工具条不能证明页面主动全选。组件无全选逻辑，本轮不以禁用文字选择掩盖问题。

### FS-EXT01

- `uploadImageFeishuFile()`把`file_name`和multipart文件名都写成固定“原图”，没有使用已经校验过的图片格式。原文件内容未丢失，丢的是文件名后缀。
- 已对**现有真实函数**做隔离FormData诊断：声明`image/png`的合成字节最终得到`file_name=原图`、`multipartFileName=原图`，字节相同；fetch完全替换为本机桩，外部请求0、生产写0。该诊断只证明上传元数据，未冒充真实PNG解码或飞书验收。
- 飞书官方Go SDK `CreateFileReqBody.FileName`注释明确为“带后缀的文件名”。固定commit：`db9f52d0a88e3f5e4ed81bb34d71a28e3f5608fa`，[官方源码](https://raw.githubusercontent.com/larksuite/oapi-sdk-go/db9f52d0a88e3f5e4ed81bb34d71a28e3f5608fa/service/im/v1/model.go)。官方网页无可读正文，未以第三方镜像替代主证。
- 当前原图事件metadata严格要求`version=1`、`fileName='原图'`。不能只替换transport字符串而让持久记录与实际上传名称不一致；现运行回退程序也不识别新增版本。

## 3. 已选定的交互方案

主路径为：**点飞书图标 → 原图发送中 → 已发送到飞书**。不增加确认框。

| 实际状态 | 用户看到什么 | 点击/后续行为 |
|---|---|---|
| 尚未发送 | 纸飞机图标，title/可访问名“发送原图到飞书” | 先鲜读本人原操作；确实可发送才同一固定ID提交 |
| 创建/上传/发送中 | 按钮转等待图标，短提示“发送中… · 详情” | 自动观察原状态；连点不另建事件，关闭提示不取消发送 |
| 真正确认送达 | 对勾和“已发送到飞书”短提示 | 确认消息回执后才显示成功；约3秒收起短提示，已发送状态保留；提示可点“详情” |
| 已经送达后再次点击 | “这张原图已发送 · 详情”短反馈 | 不再上传、不再发一条 |
| 明确未完成 | “发送未完成 · 查看” | 用户主动点“查看”才展开简短原因；仅服务器`canRetry`为真才提供“重试发送” |
| 未确认是否送达 | “暂未确认是否送达 · 查看状态” | 仅查询原操作；不把它写成失败或给危险重发按钮 |
| 原图>30MB/账号或权限不满足 | 当前真实限制与可行下一步 | 不提交发送；原图下载及现有登录恢复路径保留 |

### 状态观察与信息层级

- 只有本次点击涉及且服务器确认已受理的pending操作做短时只读观察：建议每2秒、最多60秒，页面隐藏/组件卸载/切账号停止。窗口到期仍显示真实pending，不将观察超时当失败。原父列表15秒刷新保留；轮询不重复提交或轮番读取所有旧通知。
- 默认只显示当前动作的短反馈；其中轻量“详情”入口可主动展开本次状态、取消能力和折叠的通知记录，因此pending/已发送也有可达的管理入口。成功不自动打开dialog、不抢焦点；悬停或键盘焦点在成功提示中时暂停3秒收起，收起后再次点图标可再查看。大图继续按已确认选择发完整附件，必要时一句“正在发送原图附件”。
- 成功短提示只响应本轮用户交互发起/查看的操作，不在列表首次加载或旧记录刷新时重播。图标、title和aria状态只表达当前原图；独立旧失败留在通知记录，只有它实际阻止原图发送时才通过当前原图状态提示。
- 错误详情仅保留人话原因和本次可执行动作。旧通知放在明确的“通知记录”折叠入口内，按需读取；取消/安全继续/核对入口仍依真实能力保留。旧通知失败不覆盖本次原图成功，不在主路径重复出现“仅发送查看链接”“请保留原记录”等内部说明。
- 不把“原字节、不转码、站内保持、回执、原key”等当默认产品文案。30MB仅在实际超限或用户查看发送详情时出现。
- 保留选择/复制错误文字的能力；不新增全局user-select禁令。

### 选型与表现

已读现有`ImageResultOperationFeedback.tsx`、Radix Popper和`useDialogDismiss`：前者能提供busy/success/error短反馈样式，但没有原图未知状态及历史操作组合。**选择沿当前组件复用已装Radix Popper、既有关闭机制和短反馈模式，不扩全站toast API、不加新库。**不把其他复制/下载反馈组件一起改造。

正常反馈为跟随飞书键的一行非模态提示；例外详情约240–280px，空间不足时受视口约束，沿已有12px避让、Esc/点外部关闭、同dialog portal归属。只有用户主动打开详情才管理其焦点。使用实际`--bg-panel`、`--text-primary`、`--text-secondary`和既有tone变量，不再回退白底。原五键尺寸/换行、键盘访问和触摸目标保持。

## 4. 已选定的附件命名与历史合同

### 4.1 格式依据

复用`prepareImageFeishuSource()`已有的源权限、原路径、SHA、完整解码与MIME一致性检查。文件名来自**实际已验证格式**，不取用户原始文件名、不按模型或UI选择猜格式。

| 真实MIME | 通用附件名 |
|---|---|
| image/png | 原图.png |
| image/jpeg | 原图.jpg |
| image/webp | 原图.webp |
| image/avif | 原图.avif |
| image/tiff | 原图.tiff |

沿现有支持范围，其他格式不在此次扩展。图片通道合规且≤10,000,000字节继续发原字节图片；超限或格式需文件通道时，≤30,000,000字节用`file_type=stream`完整附件。两个multipart名称必须一致；不把所有文件硬改为png，不转码、不放大、不生成、不换更贵通道。后缀正确不等于承诺飞书对所有格式都能在聊天中直接预览。

### 4.2 事件版本与兼容（实施时已定，不留给接手者选方案）

- 保持Notification type `image_feishu_original_v1`、原每输出eventID/message UUID计算、owner/identity/source指纹和API路由。metadata增加**version 2**：准备前`fileName=null`；源准备完成时，file模式冻结为上表名称，image模式保持null。冻结后再进入首次外部上传。
- reader支持原v1和新v2；v1原字段校验不放宽，v2名称必须与原source的MIME/extension一致。`uploadImageFeishuFile()`接收已经冻结的名称；`file_name`与multipart的filename使用同一值。原图字节与SHA完全保持。
- 新事件由v2 producer创建。API响应继续现有`version:2`的状态结构；metadata版本与HTTP状态响应版本不是同一概念。无需数据库表/DDL/接口新路径。
- 旧v1若为file，且**尚未开始任何外部动作**（pending，upload pending/attempts0/startedAt与key均null、externalStartedAt和message.firstSendAt/receipt均null、无ambiguous），可在原lease与完整metadata CAS下、源已验证后原子接续成v2，再首次上传正确后缀；保createdAt、原ID/UUID、owner、来源及其他原操作字段，不重置预算/计数。
- 旧v1已上传、已送达、取消、失败、未知或有任何外部起点时，不自动改名称、清状态、重传/补发。现有已上传key/已冻结payload继续原合同，不能为改名制造二次上传。截图中已经送达的无后缀附件不冒称能就地改名；站内正确格式原图下载仍可用，用户另行明确要求补发时再处理该具体动作。
- 租约、原号去重、上传未知不重传、消息未知不再发、原绑定鲜核及取消/安全继续条件保持。改后缀不成为重开历史事件的理由。

## 5. 精确修改地图与依赖

路径均相对项目根；实施时以实际新鲜Git基线查以下函数，不把整文件重写列为任务。

| 文件/入口 | 必要变化 |
|---|---|
| src/components/image-studio/ImageFeishuStatus.tsx / ImageFeishuStatus | 分离发送命令与详情打开；只读观察本次pending；短发送/成功/未知反馈；通知记录按需读取；保本次与旧通知隔离 |
| src/components/image-studio/ImageFeishuStatus.module.css | 用--bg-panel等真实主题变量；反馈/详情分层；图标尺寸、focus/触摸、边缘避让保持 |
| src/lib/image-studio/feishu-original-contract.ts / OriginalImageFeishuEvent、new/parse/status | v1/v2 reader、v2冻结名称校验、稳定原ID/UUID；HTTP状态形状保持 |
| src/lib/image-studio/feishu-original-delivery.ts / deliverOriginalImageFeishuNotification | 源验证后冻结名称；仅全无外部起点旧v1在同lease/CAS内接续v2；后续始终用冻结名称 |
| src/lib/video/feishu-transport.ts / uploadImageFeishuFile | 接收冻结名称；两个form字段一致并按MIME校验；现有视频上传不动 |
| scripts/feishu-image-original-engineering.ts、generated-image-result-layout-engineering.ts | 补格式/合同兼容与默认反馈状态工程；原套件只补有变化项 |

已核普通调用为`src/app/image-studio/studio.tsx`，批次调用为`batch-results.tsx`，均用同组件；无需分别复制逻辑。`feishu-notification.ts`的read/request/change及API route沿现有接口复用，状态类型如需适配联合类型只作必要编译调整。`feishu-delivery.ts`按现有type分派，保持v1/v2同消费者；不能因为metadata版本新建第二个相同输出任务。

实施顺序：**文件合同/兼容reader与正确上传 → 交互与只读观察 → 统一工程/构建 → 主与相容回退保护发布 → 用户手验**。文件合同是consumer前置；两前端文件可独立推进，统一集成后复核，不派接手者重新调查或选型。

## 6. 验证、发布与停止条件

风险分级：本轮文档前置L0；后续交互调整L2，持久发送合同/真实外发主流程L3，按入口、请求、结果与相容回退取得证据。权限和费用不扩，项目用户手验/不自动独审安排保持，不因“发布”字样升级成全站审查。

前置诊断已完成：source/截图指纹、隔离当前FormData复现、官方SDK字段核对、默认主题及两调用方核对。没有真实飞书试发、生成请求、生产写、浏览器验收或源码修复；这些不能被文档“完成”冒充。

实施工程只补实际改变的行为：

1. 默认点击不打开管理弹层；创建pending不冒成功；sent真实回执才短反馈；失败/unknown不暴露重发；旧auto异常不盖原图状态。
2. 账号/对象切换取消观察，迟到响应不覆盖另一卡；60秒/隐藏仅停观察，不改服务器状态或另起发送。
3. 实际PNG/JPEG/WebP/AVIF/TIFF源到两个multipart字段的规范后缀一致；完整原字节SHA相同；错MIME/后缀组合拒绝。大文件上限、图片/文件分流不变。
4. v1历史可读；v2准备前/源冻结后/未知/成功正确round-trip；唯一可接续旧pending仍原eventID/UUID；有任意外部起点/取消/未知者不迁移、不重传；原五键及主题变量无白底fallback。
5. 项目手动验收保持：普通/批次、小图/大图、重复点击与送达、未知只查、手机和键盘/错误详情，由用户在实施部署后实际确认。本轮不自动进行收费生图、真实消息试发或浏览器验收。

上线必须先有能读/消费v1和v2的主/相容guard完整产物，沿既有能力开关仅关guard的新手动受理。**原v0.121.5不能在已经写入v2后独立作程序回退**，其严格reader会拒绝新记录。自然排尽旧writer后才启用v2 producer，保一致数据备份及可执行相容程序回退，不回业务DB/媒体/费用/旧消息。没有新表迁移，不为此增加发布平台或全站检查。

若MIME/源指纹冲突、原操作状态不明、出现重复ID/状态重置、只有旧不相容回退，停止受影响写入并保原记录；不通过改后缀/重建事件绕过。正常未变41/17/4组等可在产物字节匹配的前提下复用，不为固定数量重跑；最终完整构建/类型/lint和必要服务/公网检查仍按项目发布流程执行。

## 7. 前置完成检查

| 必要前置 | 结论 |
|---|---|
| 用户两问题、阶段和主路径 | 已完成：原两截图与当前明确“前置”要求 |
| 当前代码/运行源/调用与根因 | 已完成：v0.121.5、现源码、普通/批次同入口、真实FormData复现 |
| 现有能力与选型 | 已完成：复用Radix/hook/主题/短反馈模式，不新增库或全站改造 |
| 正常/等待/成功/失败/未知/历史设计 | 已完成：§3、§4明确实际文案、动作和数据边界 |
| 权限/费用/原图/防重复 | 已完成：沿原owner/绑定/原ID/原SHA，未知只读 |
| 兼容/旧记录/相容回退 | 已完成：§4.2与§6；不把旧严格reader当新回退 |
| 附件归档与可读 | 已完成：两原PNG已复制并逐字节一致，原名称与来源保留 |
| 付费生成、外发、真实客户端验收 | 本轮不适用：仅前置且项目默认用户手验；不声称实际效果通过 |
| 数据库schema或数据迁移 | 不适用：沿Notification JSON版本，不改表、不批量历史重写 |

设计收口已按“意图→入口→操作→预期→结果→恢复”核对：正常路径只发图与短反馈，旧通知和管理按需，未知不重发，原文件可识别，限制只在相关时出现。必要前置无未决业务选型；这不是实现完成或用户体验已经实测达标。

## 8. 附件与证据

- [发送弹层原截图](/Volumes/Data/Projects/video-api-debugger/docs/materials/2026-10-31-image-feishu-send-ux-preflight/codex-clipboard-6c470715-dac5-41ec-a8dc-dbbcc2f88f6f.png)：弹层布局、文字与主题现象。
- [无后缀附件原截图](/Volumes/Data/Projects/video-api-debugger/docs/materials/2026-10-31-image-feishu-send-ux-preflight/codex-clipboard-99681853-087d-4e4d-835c-a80399986d90.png)：14MB“原图”文件现象。
- 私有证据根：`/Volumes/Data/Projects/video-api-debugger/docs/materials/2026-10-31-image-feishu-send-ux-preflight/`。
- `source-and-attachments.json`：原来源、两截图SHA/宽高/相同字节、源码基线与逐文件hash。
- `multipart-current-diagnostic.mjs`及`multipart-current-result.json`：现有函数的隔离元数据复现，外部请求0。
- `official-sdk-reference.md`：固定commit的飞书官方源码与字段依据；不将无正文官方网页记作已读合同。

截图/私有诊断保正式根，不随公共Git上传；此工单和固定索引可提交。正式根索引已有其他会话修改，本次只插入本主题链接，保留原改动；文档Git在当前独立工作区聚焦提交。

## 9. 可复制实施交接（待后续实施指令）

```text
飞书发送体验与附件后缀修复
项目：video-api-debugger
正式路径：/Volumes/Data/Projects/video-api-debugger
工单：/Volumes/Data/Projects/video-api-debugger/tasks/todo/2026-10-31-image-feishu-send-ux-and-filename-preflight.md
前置已完成；重新核对当前运行源/脏改后按§5修改地图实施，不重做调查或擅自改方案。
顺序：v1/v2 reader与冻结带后缀上传合同→轻量发送反馈→统一必要工程/完整构建→相容主guard保护发布→用户手验。
保留：原图字节、五键尺寸、本人权限/飞书绑定、费用、原操作ID；未知只查；旧已外发不自动重传。
停止：源/MIME不符、原请求未知、重复事件风险或无v2相容回退；保原记录，不绕过。
回执：实际改动、匹配工程/构建证据、提交推送、实际部署源与回退、待手验项。
附件：正式根docs/materials/2026-10-31-image-feishu-send-ux-preflight/内两原PNG及三份前置证据；用途见工单§8。
当前仅获前置阶段授权；接到后续实施指令后执行。
```
