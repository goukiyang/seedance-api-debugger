# Seedance 私域角色资产接入与管理入口

版本：v1.0.0 / R01。日期：2026-11-11（America/New_York）。
状态：v0.144.0已受保护部署；一次4秒真实IP任务生成、原片保存/下载和20点结算已核对，冻结0；界面与成片效果待用户手动验收。
入口：[固定 todo](../todo.md)。本轮按用户“明确需求后查缺补漏、查闭环和风险”“在红框位置补新增、编辑、删除等入口”补充原需求，不把方案写成已实现。

## 1. 目标与已确认范围

在现有视频生成素材区右上角增加「角色资产」入口，管理已在火山方舟入库的原创角色。保存一次角色名称和 Asset ID，以后选择使用或更换 ID，无需修改代码。选入后与普通参考图共用图片编号，进入真实 content 参数，保留用户提示词其它内容。

用户提供：Group ID `group-20261111133644-npdpj`；Asset ID `asset-20261111133644-8q2nk`；URI `asset://asset-20261111133644-8q2nk`。Active 为用户提供的状态，本轮没有调用供应商核实素材类型、状态或 ProjectName。Group ID 不作为图片传进 content，也不能用来推断项目权限。

原图：[红框位置原件](../../docs/materials/2026-11-11-seedance-private-character-assets/codex-clipboard-d499faa9-4bef-40c4-b7ec-dea9668b6960.png)。已从本次附件复制并比对 SHA-256，原件保留；附件仅本地资料归档，未公开上传。截图中的人物和提示词不是新增生成或外传指令。

本批不新增火山素材上传、资产组创建、真人认证、共享发布、上游素材删除、模型购买或充值；普通图片、原首帧/首尾帧、现有任务/点数/转存链保留。

## 2. 实际现状及证据

2026-11-11 07:15–07:23 UTC 只读核对：线上 web 为 v0.143.0，源 `b8e9c6a04102984c5d96c245ca2c5119d59a0340`，BUILD `-ijST2R-fJuDZQZV-9Ccp`；实际服务 cwd 与该 managed-release 对应，公网 health 为 ok。实施时重新确认后继健康版本，不冻结本次历史基线。

生产设置 `volcengine_ip_api_v1` 已存在、enabled=true、API Key 已配置；主机为 `ark.cn-beijing.volces.com`，默认模型 `doubao-seedance-2-0-260128`。仅输出配置布尔值、主机和型号，没有输出密钥；这不证明该 Key 与本次素材属于同一项目。

正式根是旧业务检出且有大量他人脏改。本次实现结论使用上述线上提交的 Git 源码核对，不能用正式根旧实现或 todo 中早期“IP 未闭环”描述覆盖现网事实。曾据旧检出误判 IP 未接通，已经更正：现网已有 `/generate/ip`、官方创建、计费和状态分发。

| 已核对源码（上述提交） | 事实与本次处理 |
|---|---|
| `src/components/generate/GeneratePageClient.tsx`、`GenerationComposer.tsx` | 普通/IP 页共用 composer；红框在素材区顶部、图集入口右侧。素材条、提示词及参数栏已有，直接扩展本组件，不另造生成页。 |
| `src/app/api/ip/tasks/create/route.ts` | 已有权限、workspace、报价、冻结、快照、官方提交及未知受理处理；普通参考准备会处理 URL/文件，不认识新的私域引用类型。必须在入口区分，不能把 asset URI 塞入普通图片下载流程。 |
| `src/lib/provider/volcengine-ip.ts` | mapper 已可把 image URL 原样放入 `image_url.url`，全能参考使用 `reference_image`。这是可复用的 payload 基础，不是端到端 asset 支持。 |
| `src/lib/provider/jimeng.ts` | 普通 Seedance 是另一条网关通道；不可假设它拥有官方 Ark 项目资产。私域引用只走已配置官方通道，不偷偷外发到网关。 |
| `src/lib/assets/reference-import.ts` | 外部图片导入要求公网 HTTPS；asset URI 不应放宽为可下载 URL，也不应伪造已上传文件。 |
| `src/lib/assets/collection.ts`、composer 的 `referenceLabels/mentionCandidates` | 现有图号来自 workspace 图片/素材排序；必须扩展为统一的最终图片列表，不能独立给私域角色再从图片1编号。 |
| `src/lib/creation/{context,intents,contract}.ts`、`src/lib/pricing/video-context.ts` | 意图、请求指纹、报价和受理要看到同一份角色 ID/修订/顺序；记录修改后不得借用旧意图，未知提交只查原号。 |
| `src/lib/navigation/task-reuse-client.ts` | composer 已调用 prepareVideoModeSwitch/readVideoModeSwitch/writeVideoInputDraft；新角色选择必须加入同一份 ModeInputDraft，不能另存一份与切换无关的临时数组。 |
| `src/lib/provider/video-task-status.ts` | 已支持 `volcengine_ark` 状态分发；结果继续复用既有查询/转存/下载，不新建第二套任务系统。 |
| `prisma/schema.prisma` 的 `SeedanceAsset` | 老表无 owner_id、强制 original_url，旧客户端还走网关 asset API，不能直接作为新功能的私有目录。 |

本轮读取 Git 提交快照，没有对另一个工作区的 CodeGraph 索引作结构证明，也未初始化/改写索引。实施工作区确定后，再按该工作区核对索引。

## 3. 红框入口与管理流程

### 3.1 入口和列表

- 红框放一个轻量「角色资产」文字/图标按钮，与左侧图集入口同排；不改变素材和提示词区高度，不抢生成按钮的强调。普通与 IP 视频页保持相同位置；模板、3D 多视图和其它工具不随本批扩展。
- 点击打开跟随入口、右对齐的角色面板：顶部标题、按名称/Asset ID 搜索、「＋新增」；下面是角色缩略图/占位、名称、简短状态、加入本次、编辑和更多菜单。完整 ID、组、项目和状态来源按需展开。
- 管理自己的登记记录；首版默认本人可见和修改，不因已有平台 API Key 而向所有同事公开，不新增共享体系。读取、编辑、删除和生成均服务端核对所属账号。
- 桌面面板锚定实际按钮并避让边缘；小屏改为可滚动 sheet，关闭、保存可达。新增/编辑在同一面板内切换，不叠多层大弹窗。复用项目现有层管理、定位和表单控件。

### 3.2 新增与编辑

| 字段 | 行为 |
|---|---|
| 角色名称 | 必填，供搜索与识别；不自动拼成一段人物创作要求。 |
| Asset ID | 必填，接受裸 `asset-…` 或完整 `asset://asset-…`，去首尾空白后规范化；保留 ID 本身大小写。不硬编码本次 ID 或固定时间戳长度。 |
| 缩略图 | 可选，选择有权访问的站内图片；仅作识别封面，不替换上游引用。无图使用占位，不要求重新上传角色。 |
| 分组/项目 | 高级信息；Group ID 可选。Ark ProjectName 与站内项目是两件事，未知不自动记为 default，不以填入项目名冒充授权。 |
| 备注 | 可选的管理备注；默认不注入生成提示词。 |

保存登记本身不生成、不扣点，也不新建火山素材。校验空值、非法协议、路径/查询串、误填 group ID 及本人目录内重复登记；前端校验不替代服务端入口校验。格式合法只表示可尝试引用，不表示供应商已确认可用。

保存真实成功后更新列表，失败保留输入；关闭/Esc/点外部可返回并保留按账号/记录隔离的表单草稿，关闭不保存、不生成。编辑带 revision 条件更新，冲突保留本次输入并提供重读；Asset ID 改变即形成新修订，不覆盖已提交任务的原引用。

### 3.3 删除、停用与选用

- 「从本次移除」只移出当前生成；「删除记录」只软删除本人登记，提供撤销/恢复；「停用」保留目录记录但停止新选择。三者与火山删除分开，本批没有上游删除入口。
- 删除或编辑已经选入的记录，不静默换角色、清提示词或改旧请求。当前尚未提交的选择显示版本已变化/记录已删除，显式更新或移除后再生成；已有受理、运行中和历史结果不受影响。
- 「加入本次」把角色加入现有素材条，显示名称和“图片N”，可移除、排序、插入引用；已有同一条选择显示“已加入”，不重复插入。选择与真正提交/扣点分开。
- 普通网关页允许打开管理；使用私域角色时提供明确的“切换 IP 线路并使用”，复用现有模型/模式切换及草稿恢复通道。先保留提示词、普通素材、角色选择、项目/视频卡和有效参数，再切换并重新报价。不得静默换型号或新开孤立页面；原请求未知/正在提交时，保持原受理锁，管理不解锁生成。

## 4. 编号、模式、持久化与权限闭环

1. **统一顺序。** 新输入建议用有序 `reference_image_inputs` 判别列表：站内图片 `{kind:'site_image', referenceImageId}`；角色 `{kind:'ark_asset', characterAssetId, revision}`。两者共用一份图片序列。服务器分别授权/准备，再按原序列合成 content；不把两个数组独立排序或截断。未带新字段的旧客户端继续原合同，混用互相矛盾的两套列表明确拒绝。
2. **提示词关联。** 复用现有 `@图片N` 和图片引用入口；加入角色时在原编辑光标处插入对应引用，已经关联的同一项不重复插入。用户已写的图片1/图片2与最终顺序一致，原提示词其它内容不润色、不替换、不附加一段角色描述。移除/排序只处理能明确绑定的引用，纯文本含糊引用不得盲改；有悬空/错位时就地指出，保留原文，修正后再提交。编号针对图片项，不把 text/video/audio 也算进图片序号。
3. **模式。** 私域角色首版作为全能参考的 `reference_image`。原普通图片首帧/首尾帧照常工作；带角色引用时切到首尾帧，保留选择并明确要求切回全能参考或移除，不混传 reference_image 与 first_frame/last_frame，也不丢掉私域角色冒提交成功。首帧/首尾帧的独立 asset 扩展不在本批默增。
4. **模型。** 官方 Seedance 2.0/2.5 均支持该参考结构；沿现有真实模型目录、费率开关和能力上限。普通图片与私域角色合计计数，不把两种类型各算一次额度，也不为本批扩普通网关的上限。
5. **目录与草稿。** 使用一个带 owner_id、provider、asset_id、名称、可选组/项目/封面、local 状态、revision 和删除时间的最小本地角色登记表；官方状态与状态来源分开，未知不写 Active。不改造老无账号的 SeedanceAsset 表，不伪造 Asset 文件/ReferenceImage 上传记录。普通图片仍沿原 Asset → ReferenceImage → WorkspaceAsset 链。
6. **选择恢复。** 本次有序选择沿现有按账号、页面/工作区及目标隔离的恢复草稿保存；刷新/返回后重核目录权限和 revision。草稿恢复不自动生成，不替换用户恢复后继续编辑的内容，不恢复危险确认态。
7. **意图、报价和提交。** 角色记录、规范化 Asset ID、版本、图片顺序、原提示词及实际供应商纳入同一个创建 spec/业务指纹/冻结快照。切换角色或版本后旧准备/报价失效，重新准备；事务受理检查与冻结一致。报价数额不一定变化，但不能借用另一份输入的准备凭据。请求未知保原 request ID、素材和冻结费用，只查原任务，不自动换号重发。
8. **历史及结果。** 保存提交时名称、原 Asset ID、版本、顺序与真实 payload 摘要到现有任务参数/快照；详情、复制参数、复用、取消/查询、后台费用及结果转存继续原入口。有权读历史不代表有权再次生成；复用时重核当前素材使用权限，失效保留说明，不换成预览 URL。公开作品、共享及普通通知不自动展开私域配置。保留视频交付的 2 小时看护和原文件/账务/回执，不回滚业务数据。

结构示例（未实际发送；duration、模型等仍取用户本次选择）：

```json
{
  "model": "doubao-seedance-2-0-260128",
  "content": [
    { "type": "text", "text": "图片1中的角色保持原有设计，进行15秒电影级技能展示。" },
    { "type": "image_url", "image_url": { "url": "asset://asset-20261111133644-8q2nk" }, "role": "reference_image" }
  ],
  "duration": 15
}
```

## 5. 已查出的缺项与真实风险

| 优先级 | 缺项/风险 | 最小处理 |
|---|---|---|
| 高 | 同名 Seedance 可分别走网关或官方 Ark，资产不一定属于同一账号/项目。 | 只走现有官方 IP 配置；服务端绑定通道，普通网关请求带私域引用明确拒绝。配置变更后重新核可用性，不自动换通道试发。 |
| 高 | 只有推理 API Key，不能据此声称已查到资产 Active/所属项目。 | 官方 GetAsset/ListAssets 管理查询需要 AK/SK；缺少既有查询权时保留“未核验/用户提供状态”，不新增权限作为首版硬前提，由推理回执提供实际错误。不得为校验素材先偷偷收费生成。 |
| 高 | 直接放进 reference_image_urls 会遇 HTTPS 导入、文件下载、元数据解析或图片编号分叉。 | 入口按来源分流；普通文件保持安全校验，asset URI 不抓取、不转 base64、不当公网图片 URL。统一图片列表驱动编号及请求。 |
| 高 | 编辑 Asset ID 后，旧意图、旧报价、未知请求或复用可能指向新角色。 | revision/CAS、输入指纹及受理快照一致；历史冻结，当前草稿显式更新，未知只查原号。 |
| 高 | 旧资产目录没有账号字段，直接复用会扩大素材可见或编辑范围。 | 新角色目录服务端按本人授权；同一 Key 不等于所有用户都有登记/读取权限，不开放旧目录代查。 |
| 中 | 本地删除误触发供应商删除、删历史或误报仍可恢复。 | 本地软删除与撤销；不调用 DeleteAsset；已选引用变化在提交前说明，已受理任务继续原链。 |
| 中 | API 失败被猜成“不存在”或“跨项目”，错误重试又产生重复收费。 | 保存真实 code/HTTP/Request ID 的脱敏摘要；能明确分类才分类，否则显示“不可用或无访问权限”及实际原因，不造专用错误码；不自动重发创建。 |

官方依据（2026-11-11读取）：[创建任务 API](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh)明确 asset URI、2.0/2.5 的 reference_image 与模式互斥；[GetAsset](https://docs.volcengine.com/docs/ark/get-asset-api?lang=zh)明确仅 Access Key 鉴权、ProjectName、Processing/Active/Failed，以及 HTTP 200 仍可能为 Failed；[私域虚拟人像指南](https://docs.volcengine.com/docs/ark/private-virtual-avatar-library-guide-preview?lang=zh)由只读助手查得项目隔离约束，主线程本次抓取该指南两次超时，不以该抓取失败判产品问题。公开资料未核到“素材不存在/跨项目”的专用推理错误码，实施不臆造。

## 6. 实施落点与顺序（实施证据见 §9）

- [x] 锁定红框入口、通用可替换需求与原附件；核对实际线上提交、官方通道配置和核心源码。
- [x] 明确增删改选、分层、状态、编号、模式、权限、恢复、费用及历史保护；记录缺证。
- [x] 在最新健康源建立隔离实施分支；新增最小角色登记模型及相容增量迁移、服务端目录服务和受鉴权 CRUD API（拟 `/api/character-assets` 与 `/:id`）。迁移不回填、改写老资产或业务记录。
- [x] 在 `GenerationComposer` / `GeneratePageClient` 的素材头部和 `ReferenceStrip` / `PromptEditor` 接入共用管理面板及有序选择；复用现有层/表单，并扩展 `src/lib/navigation/task-reuse-client.ts` 的 ModeInputDraft 和既有模式切换。拟新增面板文件，名称随现有目录安排，不重写整个 composer。
- [x] 扩展 `src/lib/creation/` 与客户端创建 hook、IP create、引用编译/快照、复用 DTO 和任务详情，使新字段全程保留；官方 provider 只补资产类型校验与错误映射。普通 create 的私域输入不支持时明确拒绝，不转发给网关。
- [x] 完成对应模拟/工程检查，核对实际差异；必要发布沿现有受保护发布流程，新增 schema 的备用 reader 必须可运行，只回程序不回业务数据。
- [x] 有条件执行一次真实测试并观察原任务到终态/交付；未满足条件则只保留该项缺口，继续不依赖它的工程交付。

## 7. 验证与交付边界

本轮文档为 L0，检查原文保留、附件可读、链接、源码/官方依据和差异；未来实现是视频创建主流程 L3，证据针对真实入口和受影响链路，不自动独立审核或全站收费回归。

- 模拟：裸 ID/URI 等价、替换 ID、不合法/group ID 拒绝、普通图片和角色交错顺序、图片1/2/3 对应、2.0/2.5 payload、模式互斥、无 AK 的状态显示、权限隔离、重复保存/版本冲突、保存失败保输入、本地删除不调上游。
- 创建链：角色 ID/版本/顺序实际进入意图、报价业务指纹、任务快照和供应商 body；修改后不借旧准备；重复/未知提交保原号与费用；历史和复用不从最新登记覆盖旧引用。
- 工程：按改动跑对应隔离检查、类型/lint及项目必需构建/内置发布检查；同输入有效旧证据复用。发布保迁移检查、备份、相容 reader、服务/公网同源和数据保护。
- 用户手验：红框可达、搜索/新增/编辑/停用/删除撤销、加入/移除/排序、刷新恢复、手机/键盘/关闭返回、失败和冲突提示、切换线路不丢提示词/素材。源码或构建不冒这些操作通过。
- 真实测试沿用户本次授权：只创建一次、时长不超过 15 秒；使用已配置通道、有权的普通 Codex 服务账号/项目及正常点数链，先核本次费用和权限，不冒用管理员作生成所有者。API Key 已配置不等于全部条件满足；未知不重试创建，原号追查。记录真实请求（隐藏密钥）、task/Request ID、终态、费用与本地结果；没有实际请求时只给“结构示例”，不得称“已发送”。

## 8. 方案阶段收口与仍缺证据（保留历史）

已完成需求与入口方案补充、相关源码/运行配置/官方接口核对和原图归档。未修改业务代码、生产配置或数据，未执行构建、浏览器功能验收、收费生成或部署。

本次 ID 的 Image 类型、Active 当前状态、Ark ProjectName、与已配置 Key 的实际同项目权限尚未独立核实；只有现有推理 Key 配置的布尔证据。缺少管理查询凭据不伪装成已查询，也不新增 AK/SK 权限；不影响手动登记/请求结构的实施准备，但阻止声称该角色已可生成。真实任务与用户效果仍待后续实际证据。

本轮新发现的线索与问题：未新增任务外事项；上述缺项均在本工单范围内。旧工作区/早期记录误判已当场纠正，经验仅登记本项目，不新增全局规则。


<!-- ARK-CHARACTER-ASSET01-IMPLEMENTATION-20261111 -->
## 9. 已授权工程实施与交付（2026-11-11）

用户后续明确要求“落地”，本节接续前期方案，保留上文方案阶段事实。工程工作区为 `/Volumes/Data/Projects/video-api-debugger-worktrees/seedance-private-character-plan-20261111`，实施分支 `codex/seedance-private-character-assets-20261111`，基于线上 b8e9c6a0 的计划提交 971631aa；未在正式根脏改上实现业务，也未操作生产配置或数据。

### 9.1 共享影响与实施结果

- 实施前核对普通/IP 共用 composer、创建意图/报价/受理、原请求回执、素材上传及复用的共享边界。采用可选有序判别输入，不改变未带新字段的旧请求；普通网关入口明确拒绝私域输入，官方 mapper 仅允许合法 `asset://asset-…` 作为 `reference_image`，不下载/探测/转 base64，也不创建假的媒体文件。
- 红框位置已接「角色资产」管理面板，普通与 IP 页同位可达；本人新增、编辑、搜索、复制 ID、停用启用、软删除恢复及可选授权缩略图共用一个面板。状态显示“未核验”，失败和 CAS 冲突保编辑输入。普通页须明确选择 IP 型号并点击“切换 IP 线路并使用”，沿已有模式草稿交接保提示词、项目、素材及参数。
- 普通图片与角色共用有序图片编号、模型总额度、素材条排序/移除及引用入口。自动插入/改序仅处理明确的 `@图片N`，自动插入也保留当前选中的原文字，其余原文保持；模糊文字图号、坏草稿、缺失普通图、版本变化及首尾帧混用保留现场并阻断，要求显式修正，不清输入冒成功。
- `reference_image_inputs` 及服务端冻结的 `character_asset_references` 进入创建 spec、输入/报价业务 hash、IP 请求指纹、事务受理、任务 params 和供应商快照；目录在准备和受理事务重新核 owner/revision。原号去重先于目录的新鲜检查，已受理或未知任务不因目录编辑而换角色、换号、解冻或重发。
- 复用沿原事务/回执重核当前 owner 与修订，并保冻结角色名、Asset ID、顺序及旧版本；无权、删除、停用或过期修订不冒完整恢复。任务所有者可在原详情查看提交时角色引用、复制 Asset ID 和生成设置；`asset://` 不作为图片缩略图。中央任务 DTO 与 IP list/status 对非所有者剥离私域参数/URI，含只选 URI 列的局部 DTO；公开作品与普通通知沿原安全投影，不新增配方外发。
- IP status 与 IP request-status 的原号 GET 最小复用现有 Codex bearer 鉴权，保同账号/provider/原 key 过滤与 `assertCanViewTask`；无效 bearer 不回落 Cookie，返回 private/no-store 与 Cookie/Authorization Vary，空查询仍 `safeToResubmit:false`。原 `volcengine_ark` 状态/结算/转存及两小时视频交付看护未改；没有新增 AK/SK、上游素材上传/删除、资产组/共享平台或账号配置。

### 9.2 增量表与相容 reader

新增单表 [CharacterAsset 迁移](../../prisma/migrations/20261111090000_owner_character_assets/migration.sql)，字段为 owner/provider、Asset ID、名称、可选组/项目/备注/缩略图、enabled、revision、deleted_at 与创建/更新时间；索引为 owner/provider/asset_id 唯一键及 owner/deleted_at/updated_at 查询键。软删除保留原唯一键，撤销恢复原 ID。仅增表、不回填或修改旧 SeedanceAsset/媒体/账本/历史。

目录服务使用参数化 raw SQL，实际旧 Prisma 5.22 reader 无 CharacterAsset delegate 仍可读取新表；缺表明确 `503 CHARACTER_ASSET_SCHEMA_REQUIRED`，不运行时懒建表。发布只执行本次锁定 SQL，不能用全仓 migrate deploy 补历史。`CHARACTER_ASSET_WRITES_ENABLED` 位于 `src/lib/character-assets/build-mode.ts`；相容 guard 从完整新源码构建，保原六个写开关并关闭此第七项。目录写/恢复及私域新创建/prepare/accept 关闭，GET/历史/状态继续可读。未补丁旧 79ab 会在 IP DTO 露 URI，不能作本批回退 reader；程序回退不回目录/任务/账务数据。

### 9.3 工程证据与边界

- `node scripts/character-assets-engineering.mjs`：18 组离线模拟通过。执行真实目录 API/SQLite SQL、旧 Prisma raw reader、Codex linked owner 隔离、软删恢复、DateTime/Boolean、同 revision 并发一次成功一次冲突、模式/总数、2.0/2.5 实际 provider fetch body、prepare/accept/hash/原回执冻结、隐私、草稿交接及写暂停。全局 fetch 拦截证明真实网络/生成/生产写均为 0。
- `node --check scripts/character-assets-engineering.mjs`、`prisma validate --schema prisma/schema.prisma`、`git diff --check` 通过。服务端和任务详情 15 文件窄 lint exit 0，仅原任务详情的三个既有 `<img>` 提醒；目录七文件窄 lint exit 0。客户端最终七文件窄 lint exit 0（11 条既有 Hook 依赖提醒与两条授权缩略图的原生 `<img>` 建议，无错误）。匹配当前 schema 的独立 Prisma client 下，`tsc --project .role-tests/character-assets-types/tsconfig.json --noEmit --incremental false --pretty false` exit 0；后续仅补两处自动插入保选中文字、两条 IP 原号 GET 鉴权，沿对应极窄检查验证，完整最终类型仍由候选构建内置检查覆盖。
- `node scripts/character-assets-ip-auth-engineering.mjs`：23 组额外极窄模拟通过，执行两份完整实际 GET 模块，覆盖 bearer 普通 owner、错误 token 不回落 Cookie、同账号/原号/provider 过滤、原权限拒绝、未知不重提与 private/no-store/Vary；附被测源码 SHA-256。此处鉴权密码学、数据库、供应商/finalizer 为明确 mock，不冒真实线上效果。两文件直接 ESLint exit 0；自动角色插入保选中文字的两路径确定输入断言及两文件直接 ESLint exit 0（5 条既有 Hook 提醒）。
- 两个复用的既有 generated Prisma client 都落后当前源码 schema：第一份缺 Work，第二份缺 WorkRecommendationEvent/Job/Result；不能把这类差异说成业务类型通过。仅在被忽略的 `.role-tests/character-assets-types` 生成独立匹配类型，临时 tsconfig 映射 `@prisma/client`，不修改共享 node_modules 或连接数据库。
- CodeGraph 第一次准备因源文件在实施中变化退出；源码稳定后恢复成功（工程工作区 2063 文件、0 parseErrors/0 hashMismatch），真实 context 查询返回有序编译入口及 IP POST 关系，关键结论回源码核对。提交后的最终增量索引状态随 Git 交付。
- 主控的 `node scripts/pricing-compatible-guard-engineering.mjs` 四个真实临时 Git 场景已通过，覆盖新源七开关与旧源六开关兼容；本批复用有效证据，未重跑。

这些证据属于工程模拟与代码检查；没有加载完整 IP HTTP 成功链、浏览器/手机功能验收或本轮真实生成。正式候选 Next/内置矩阵、迁移备份/停止 writer/保护部署、普通 Codex 本人项目的一次不超过 15 秒真实测试由主控接续，未知只查原号；用户界面效果仍待手动验收。本轮未新增任务外发现。
<!-- /ARK-CHARACTER-ASSET01-IMPLEMENTATION-20261111 -->


<!-- ARK-CHARACTER-ASSET01-RELEASE-20261111 -->
## 10. 保护发布与一次实际任务闭环

### 10.1 已部署的产物

业务提交 `744c9bd9013a5a32a6f384628d1387ce48fdd0b0`、版本/main `428c425739cf63a2cad9f43f092d6b1538c4b023`（v0.144.0），已推送并核远端。主 BUILD `p9rZvxSRRS7FkgPUwJ5X3`；备用 `fb2dbdb050a51e6e0e186787501863c181014184`（0.144.0+points-pricing-guard.1），BUILD `Yxw1jVGLULCDIvK9QgCI7`。两个版本均本次串行完整 Next/type/lint 构建通过，不借旧 guard 的构建证明。主版本原生/关联34项中25项匹配原证、9项按变更刷新通过，admin pure因schema新增另行刷新；备用 native、计价与精确版本 reader 证据全新取得。

工程工作区干净源导出各2501文件，未混入正式根其他脏改、密钥、数据库或用户媒体。CodeGraph 实际同步到版本提交，2064文件、无待同步/hash mismatch/parse error；真实 caller 查询核实七个引用消费者。main→guard 仅七文件、七写开关及版本变化，隐私/历史 reader 相同。

2026-11-11 08:42:09 UTC 完成受保护切换：7服务、4timer、51项实际生成页/任务页静态资源、4项匿名401检查通过，公网 `/api/release` 返回0.144.0，health返回ok。发布窗口已收口；[部署摘要](../../docs/materials/2026-11-11-seedance-private-character-assets/release-summary.json)保留实际身份与证据边界。入口：[视频生成](https://sd2.youdooart.com/generate)、[IP生成](https://sd2.youdooart.com/generate/ip)。已部署，待用户手动验收。

### 10.2 数据及恢复保护

私有发布阶段 `/data/video-api-debugger/release-staging/character-assets-20261111/attempt01`；pair `e32d2e50-4628-4f41-81aa-c1e70049c966`。原11个writer自然退出，无强杀/超时；一致SQLite备份后仅执行本次锁定的3个DDL，08:41:48 UTC新增CharacterAsset表与2显式索引，原schema和旧数据不改。原Works迁移只读核验，不重复执行；不跑全仓migrate deploy，价格保护字段前后一致，2小时视频交付看护鲜核仍为2h。

固定程序恢复入口：`bash /data/video-api-debugger/release-staging/character-assets-20261111/attempt01/program-recovery.sh /data/video-api-debugger/release-staging/character-assets-20261111/attempt01/release-input.json`。恢复只切本次新guard程序和配置指针，保留新表、媒体、点数、账本及回执；不回业务数据、不使用缺隐私reader的旧79ab。源码/构建/启动守卫已核对，本轮未在生产演练回退。

### 10.3 一次真实任务

沿本次用户授权，使用既有普通内部Codex账号本人personal项目，通过真实目录API登记裸ID（HTTP201，服务端仍显示未核验），再经IP Bearer v2入口创建一次4秒/480p/无音频任务。鲜报价及费用上限20点，原请求号 `1237dbdf-1562-4f1e-a421-3c96cb5ba774`；站内任务 `cmwbvf30t0009ulv9d99occnn`，上游任务 `cgt-20261111164225-06ca8`。创建HTTP200并受理，后续只GET原号/原任务，无换号、重复创建或额外飞书发送。

任务终态succeeded，原片本地与公开保存均成功；只读账本核对实际20点、剩余冻结0点、两条正常冻结/结算记录，上游创建记录精确1条。已下载887045字节原片并用ffprobe核对H.264、864×496、24fps、实际4.041667秒（不超过15秒）；没有裁切、转码或重新生成。原片SHA256 `b4a85db2362034f6144e85415b0acd6019a74899e4926b161784c0c92c3b2a77`。

[实际提交结构（隐藏密钥）](../../docs/materials/2026-11-11-seedance-private-character-assets/provider-request.redacted.json)来自该任务冻结快照和持久client_request_id，结合已绑定mapper核对，不冒充网络抓包：content文本后为image_url，URL为本次`asset://asset-20261111133644-8q2nk`，role为reference_image，和提示词`@图片1`一致。2.0已实际生成；2.5及替换不同ID由离线模拟覆盖，未再收费生成。

测试原片：v1.0.0 · R01 · 原片（4秒，效果待用户手验）。本地资料路径 `docs/materials/2026-11-11-seedance-private-character-assets/release/real-test/character-asset-test-v1.0.0-R01-original.mp4`；不把网页版本当原片自身版本。测试目录记录归专用Codex账号，未向其他账号自动公开/预填。实际使用：本人刷新视频生成页，在右上「角色资产」新增姓名与可替换Asset ID，加入本次；普通页沿明确的「切换IP线路并使用」。

### 10.4 手验及余项

仍待用户手验：红框实际位置、手机/键盘、搜索/增改/停用/软删撤销、混排编号、刷新恢复、切线路保输入、视觉角色一致性及成片效果。本次工程和单个真实API任务不冒全部界面验收。

未执行GetAsset/ListAssets管理查询，未申请新AK/SK；供应商管理状态仍显示未核验。真实生成证明本次已配置Key能够引用本次Asset ID，不泛化为所有资产/项目永远可用，不将管理API的Active当前值冒已查询。本轮未新增任务外问题。
<!-- /ARK-CHARACTER-ASSET01-RELEASE-20261111 -->


## 11. 修改文件与功能对应

| 文件/目录 | 本次功能 |
|---|---|
| `src/components/CharacterAssetPanel.tsx`、`character-assets.css`、`GenerationComposer.tsx` | 素材区右上入口、本人目录搜索/新增/编辑/停用/删除恢复与小屏面板。 |
| `src/components/generate/GeneratePageClient.tsx`、`ReferenceStrip.tsx`、`PromptEditor.tsx`、`src/lib/navigation/task-reuse-client.ts` | 普通图片/角色混排及统一图号、保原文插入、显式切IP和草稿恢复。 |
| `prisma/schema.prisma`、本次唯一migration、`src/lib/character-assets/`、`src/app/api/character-assets/` | owner目录、ID规范化、版本冲突、授权缩略图、软删恢复、冻结引用与写暂停。 |
| `src/lib/creation/intents.ts`、`src/lib/pricing/video-context.ts`、`src/app/api/{ip/tasks/create,tasks/create,tasks/estimate}/route.ts`、`src/lib/provider/volcengine-ip.ts` | v2准备/报价/受理同一输入、实际content、2.0/2.5映射、普通网关拒绝私域误传及清楚错误。 |
| `src/lib/video/multiview-task-privacy.ts`、`src/lib/navigation/task-reuse-operation.server.ts`、`src/app/api/tasks/[id]/reuse/route.ts`、`src/app/tasks/[id]/page.tsx`、IP list/status/request-status | 旧快照、详情/复制/复用、跨账号隐私投影及正常Codex Bearer原号读取。 |
| `scripts/character-assets-engineering.mjs`、`character-assets-ip-auth-engineering.mjs`、`create-pricing-compatible-guard.mjs`、`pricing-compatible-guard-engineering.mjs` | 18/23组模拟、七开关guard源生成/相容检查；不收费、不调真实供应商。 |
| `src/app/api/codex/config/route.ts`、`src/lib/release.ts`、`package.json`/lock | 描述新输入合同、真实v0.144.0版本与用户更新摘要。 |

发布专用脚本及完整日志在第10节固定私有stage与本地资料`release/`下；不把生产配置、数据库备份、token或原片整包提交到Git。


<!-- ARK-CHARACTER-ASSET01-THUMBNAIL12-20261111 -->
## 12. 下拉按角色缩略图直接选用（2026-11-11）

用户追加明确要求：以后在下拉中按角色缩略图直接选择。该三文件实现与下拉箭头已保存在不可变提交 `c6c1f41fa7b7005015596304bbfb7b6aa87542d7`，曾按用户优先级从提示词组急修撤出。提示词组 v0.144.1已部署后，本节现已在其线上源 `56ab5da038b38324837119b05e119446b93e9066` 上恢复实施，并已于2026-11-11T10:59:21Z部署v0.144.2；缩略图交互待用户手验。Panel/CSS恢复c6完整字节，Composer仅恢复原授权缩略图 URL 映射，保留全部提示词组修复。未改 API、schema、CAS、计费、生成输入或发布脚本，未新增收费调用、AK/SK 或供应商素材查询。

### 12.1 本次实现与来源

- 默认展开紧凑角色缩略图网格，桌面三列、手机两列；点击原生封面按钮直接调用原 `onJoin`，选中显示勾与“已加入”，容量、停用/删除和在途锁仍拦。普通页仍须显式选 IP 型号，卡片明确显示“切换 IP 线路并使用”，不静默换型号/线路。
- 搜索、新增及刷新保持；每卡的编辑、停用/启用、软删除/恢复、复制 ID 与上游未核验说明保留在次级管理区。无图展示“未设置缩略图”及「设置缩略图」，有图可「更换缩略图」；图片加载失败只回到“缩略图暂不可用”占位，不回退为原图或生成视频帧。
- 新增/编辑表单中的文字缩略图 select 改为站内缩略图按钮网格，支持选择、勾选反馈和“不设置”；只改变表单的 `thumbnailReferenceImageId`，仍由原显式保存和 CAS 生效，失败保输入。当前缩略图不在本次素材中时保留原选项，使用目录 DTO 已授权的 `thumbnailUrl`，无法读取时显示占位。
- 源码核对确认 `GeneratePageClient` 仅挂载共用 composer，实际 `useWorkspace` 位于 `GenerationComposer`。本次复用既有 `referenceLabels` 中已使用的受保护 thumbnail URL，按 `reference_image:<id>` 的真实 contentKey 匹配传给面板，不按图号猜图，不新造 URL。因此不需修改 GeneratePageClient，也没有把 `asset://` 作为图片链接。

仅三个业务文件：`src/components/CharacterAssetPanel.tsx`、`GenerationComposer.tsx`、`character-assets.css`。原定位/关闭层、保存草稿和手机 sheet 保留；DOM 使用原生按钮、fieldset/legend、aria-pressed 与独立的管理 details，没有嵌套按钮或选择即保存。

### 12.2 检查与手验边界

两份改动 TSX 根及其导入类型的窄 `tsc` 检查通过，复用此前匹配 schema 的独立 generated client；首次窄配置漏载 `next-env.d.ts` 引起 CSS 声明缺失，补齐检查配置后通过，未改业务类型或依赖。两个改动 TSX 文件的直接 ESLint exit 0（5 条既有 Hook 依赖提醒及 1 条原生 `<img>` 建议，无错误），PostCSS 解析及 `git diff --check` 通过；没有重跑与本改动无关的 18/23 组模拟、浏览器、截图或收费生成。

源码/DOM语义已自行核对：选角色只沿原 join，选缩略图只改未保存字段，管理按钮独立，失败图片不再试读原图，停用/删除卡仍可管理恢复。待用户手验：下拉卡片大小/手机密度、鼠标与键盘选图、无图/图片失败占位、设置/更换缩略图保存与冲突、普通页明确切 IP、已加入及容量/在途锁反馈。

当前仍未取得火山资产本身的原图；推理 Key 不支持管理 GetAsset 查询，不新增 AK、不抓供应商图，也不把已生成视频帧冒作资产原图。无缩略图的记录可用有权的站内图片设置识别封面，不影响已有私域引用生成。本轮未新增任务外发现。

### 12.3 提示词组上线后的恢复

本次仅恢复已批准的 `428→c6c1f41f` 三UI文件净差量，不重做设计或扩展功能。写入前确认Panel/CSS与428逐字节相同，恢复后与c6逐字节相同；Composer差异仅一处thumbnailUrl映射，所有提示词组能力、选择/草稿保留及请求合同代码均与56线上源一致。缩略图来源仍为已有授权referenceLabels与目录DTO；无图/失败占位、显式切IP、容量/停用/在途锁及次级管理保持。

仅进行恢复差异检查、TSX语法解析与CSS解析，不重跑已匹配原实现的类型/窄lint及无关模拟，不做浏览器、截图或收费调用。恢复工作包交给主控后，主控已接续完成聚焦提交、完整候选构建和v0.144.2部署，实际结果见下节；§12.2手验项仍待用户检查。
### 12.4 实际发布结果

2026-11-11T10:59:21Z **v0.144.2 已部署，待用户手动验收**。主源 `541334e9e2050cdd3cafca3e9489f9c452415efc`／BUILD `ZD2wem-SWZ1sVQdXyUkkt`，已推送并核远端。完整继承已上线的56ab提示词组修复；恢复源继续使用原3633／`H6ik79dYs3XsO_FP-Yeii`及其原构建/reader证据，不冒新构建。服务器阶段 `/data/video-api-debugger/release-staging/character-assets-thumbnail-after-pg-20261111/attempt01`。

- 精确Git导出2502文件，56ab→541净差量只含三UI和package/lock/release.ts共6文件；无后台、schema、计费或传输改动。
- 完整TypeScript、改动lint、Next含内置types/lint通过；17原生记录按未变输入复用，17关联记录中16复用、1项projects检查刷新，fresh计价通过。build与cutover均exit 0；无新的生成/浏览器/截图验收。
- 6启动检查、7服务、4timer、51公网资源及4匿名401通过，实际公网版本0.144.2；PG完整36目标发送策略、价格、原数据链接和2小时video-delivery看护保持，无DDL或业务数据恢复。
- CodeGraph对应实际541源及指纹`9136ffff2594f2b24a1531f0d0df9d9f05f874fb46dcfad3e0b20247f324d3ce`已READY，2065文件、0missing/hashMismatch/parseError；本轮局部调用关系另以源码核对，不把准备成功冒结构查询通过。

详[发布摘要](../../docs/materials/2026-11-11-seedance-private-character-assets/thumbnail-release-summary.json)。实际下拉/手机布局、鼠标键盘选图、封面保存及生成仍按§12.2由用户手验；当前推理配置仍不能读取火山资产原图，识别封面使用有权的站内图片。未新增任务外问题。

<!-- /ARK-CHARACTER-ASSET01-THUMBNAIL12-20261111 -->

<!-- ARK-CHARACTER-ASSET01-PROMPTGROUP13-20261111 -->
## 13. 提示词组固定可用与 2.5 / IP 创建链修复（2026-11-11）

用户指出“2.5模型选项没有提示词组功能，不应该根据模型区分，这个功能固定”，并明确优先将此项修复上线，缩略图交互稍后继续。范围是视频生成页的普通与 IP 线路及其型号切换；账号/组权限保持，模板、画布、3D多视图等其它工具不扩入口。前期提示词组合同见[原提示词组工单 §13.11–13.12](2026-10-12-style-skills-unified-selector.md#1311-pg-ui0304-与-pg-ip01-实施增量2026-10-30)，其中旧 IP 排除由本次明确要求替代，历史记录不改写。

### 13.1 源证、共享影响与修法

实际 gate 是 Composer 的 `videoSurface !== 'ip'`、切线路/草稿恢复主动清空组、客户端只向普通线路传组，以及 IP create 对非空组直接 426；共享 v2 合同也只接受 ordinary。改为沿现有视频生成页能力与账号权限显示固定入口，普通/IP均传不可变组 ID/版本及合同1；切型号/线路保留本人当前选择，不使用旧 unapplied 值覆盖新编辑或显式空选择。仅原仍待接续、可核对同账号/页签/nonce/修订的旧 IP handoff 可恢复旧隐藏选择，不批量回填已应用草稿。

服务器复用 `resolveVideoPromptGroups`、原私有组权限与编译次序，个人输入最后；组本身不向前端下发正文，也不把组内文字当素材下载。ordinary/IP按线路合同接受，未按模型硬编码分叉；普通2.0/2.5/H3及官方IP目录均沿原模型可用性/费率检查。只选组而个人描述为空可正常准备，组合总长度仍沿原上限。原有角色有序引用与站内图片准备保留，`asset://`仅作 typed 上游引用。

共享影响集中在 creation intents：准备及受理事务鲜核组权限并绑定服务器派生 `video_prompt_group_fingerprint`，组顺序、版本或个人描述变化均使 spec/hash/报价业务哈希变化；客户端不能伪造该字段。旧 ordinary prepared spec没有新派生字段时保原 hash 格式并重新核权，已受理/关闭原回执仍先返回，不改旧任务、不重发。IP创建复用原冻结扣费事务与 request fingerprint，task/snapshot按已有私有配方机制加密冻结，provider ledger仅留组引用与普通参数。无新表/迁移、无 Key 或现价修改，无额外费用协议。

### 13.2 私密发送、读取与恢复

官方 IP发送复用 `privatePromptFetch` / `assertPrivateSend`，精确 identity 为 provider `volcengine_ark`、实际配置 endpoint `https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks`、同一现有 Key 版本与实际 payload model。目录为 `doubao-seedance-2-0-260128`、`doubao-seedance-2-0-fast-260128`、`doubao-seedance-2-0-mini-260615`、`doubao-seedance-2-5-260628`；代码不为这些模型添加硬编码放行，不跟随重定向。生产当时该 Ark 目标尚无许可，由主控沿既有 policy/attestation 机制准备精确目标；正式许可未生效时新私有发送会拒绝，既有普通 Seedance 许可不变。

发送前先核目标，再在实际传输前鲜核；未尝试外发的私密拒绝（`deliveryAttempted=false`）保持明确 503，可沿原失败结算释放本次冻结，不误报提交未知。实际已外发/重定向或网络未知继续原号查询、保冻结、不重发不自动退款。供应商创建回显与错误正文不落普通回执；IP status/list/request-status及共享 DTO 使用已有正向投影。本人可读冻结角色引用和有序图片，合法同事不能借含组任务拿到角色 URI或组正文。工程检查曾发现 IP request-status 选择 raw error_message且未选私有标记，现已补标记投影并保原未知状态码/只查原请求约束。

主控独占维护相容 guard：保原开关并增加 `VIDEO_PROMPT_GROUP_WRITES_ENABLED=false`，共8个可选写关闭；新 guard保留本次 reader、历史任务/状态/结算，新增组执行及组维护写入关闭，不依赖无关风格组写开关，也不回数据。正式 reader 检查使用新脚本 `node scripts/video-prompt-groups-ip-engineering.mjs --reader-only`，须在真实关写源码执行，不能以模拟值冒 guard证明。

### 13.3 工程检查与交付边界

- 新 `scripts/video-prompt-groups-ip-engineering.mjs` 18项定向模拟通过：实际组服务/权限/不可变版本、普通/IP合同、服务器编译、真实准备与事务受理哈希、私密目标校验与模拟传输、加密 task/snapshot、IP status/list/reuse/状态路由及账单正向投影；含组+角色 `site/asset/site` 顺序及本人/非本人权限组合。全部使用隔离内存数据、临时合成密钥/许可及模拟 transport，无生产写/真实网络/模型调用。
- 同脚本 `--reader-only --simulate-reader` 5项通过，明确是 fixture模拟，实际源码写开关仍为 true，不能算真实 guard检查；由主控对最终真实 guard运行无模拟参数的 reader命令。原用户功能手验边界不变。
- 客户端16项定向断言与 `node --import tsx scripts/video-mode-switch-engineering.ts` 7项通过；旧通用组脚本只更正“IP不支持”的过期断言，没有重跑无关41组。
- 使用与当前 schema匹配、隔离生成的 Prisma client作改动根定向 TypeScript检查通过；包含后补 request-status投影的最后一次定向检查已返回 exit 0，改动根定向类型检查通过。未 install、未重写共享 generated client或数据库。服务端改动语法解析通过。客户端/服务端窄 ESLint均因本机外置盘长时间 I/O无输出而终止，未记 PASS，最终候选 Next内置 lint/编译由主控接续。源码及 DOM语义自行 Review，未自动浏览器、截图、收费生成或另开审查线程。

### 13.4 实际发布与接续

2026-11-11T10:35:49Z 已部署 **v0.144.1**，待用户手动验收。主源 `56ab5da038b38324837119b05e119446b93e9066`／BUILD `AKcfrbYiND6eQc9UsrHtn`；恢复源 `363368ed192d9a89c6ff8c9659b0b175624e53c9`／BUILD `H6ik79dYs3XsO_FP-Yeii`，版本 `0.144.1+points-pricing-guard.1`，实际两源已推送并核远端。发布阶段 `/data/video-api-debugger/release-staging/video-prompt-groups-ip-20261111/attempt01`，pair `49e56866-4456-4a77-a41c-b9d5688828fe`。

- 主/恢复两源完整 TypeScript、改动 lint、Next含内置类型/lint通过。主PG-IP实际模拟18项、真实8开关恢复源无模拟 reader 5项通过；原生/计价矩阵按实际源依赖复用或刷新，未重跑无关角色素材检查。
- cutover exit 0；6项真实启动检查、7服务、4 timer、51公网资源及4匿名401通过。实际公网 `/api/release` 返回0.144.1；无浏览器/截图或新增收费生成，不能冒用户功能验收。
- 私密发送配置由35目标增为36：只增加同一既有Key版本、精确官方Ark创建地址和当前4个已启用型号，revision `video-prompt-groups-ark-20261111-01`。原身份、来源、作者、Key和读取权限不变；保UID1004/0600。未增加AK/SK、通配目的地或账户权限。两项既有迁移只读核验，无DDL、历史回填或数据恢复。
- 首次检查因补充旧回执误由新candidate读取而 exit 1；修正两处读取作用域后，resume02因上次隔离准备留下的目录所有者状态再次 exit 1。均未切版。保存原helper、日志及回执，只上收候选根和 `.role-tests` 顶层、保留冲突stderr、使用全新隔离run；resume03 exit 0，最终两次完整Next和cutover有独立原证。原失败记录未覆盖，不误记为未部署。
- 程序恢复已修为只依赖完整guard与锁定manifest，不要求故障main物理目录可读；保全部writer自然退出、后发发布/配置漂移保护，不回业务数据。2小时视频交付看护与费用、原请求、素材保护保持。

详[发布摘要](../../docs/materials/2026-11-11-seedance-private-character-assets/prompt-groups-release-summary.json)。普通/IP型号切换、所选组保留、仅选组输入及实际成片仍待用户手验。按用户顺序，此项上线后才接续 §12 缩略图UI，并已另行完成0.144.2发布（§12.4）；0.144.1仍只包含提示词组急修。未新增任务外问题。
<!-- /ARK-CHARACTER-ASSET01-PROMPTGROUP13-20261111 -->


<!-- ARK-CHARACTER-ASSET01-THUMB-UPLOAD14-20261111 -->
## 14. 角色缩略图直接上传（2026-11-11）

用户明确要求：缩略图增加直接上传入口，新增和编辑角色都可上传、更换；显式保存后显示在角色下拉中，Asset ID仍可替换。沿原角色表单和现有站内图选项补入口，不改变已有提示词组、角色生成引用、素材编号或历史。

### 14.1 已核路径与边界

- 实际线上已是v0.145.0／b2a4afa63／uWJv_QJSKrQaWse2KqXTx，已包含本单1441/1442修复。新隔离工作区`character-thumbnail-upload-20261111`从该健康源建立，正式根其它脏改不参与；当前另有UX16占用同一构建/发布窗口，后续必须继承其最终健康145.1及实际guard，不从旧1442切回。当前只做本地代码与工程检查。
- 复用通用`uploadFileToHistory`及其按owner/epoch、原请求/票据与真实字节进度；它只返回Asset ID。角色保存需要ReferenceImage ID，不能直接混用。现有workspace/codex上传引用会添加生成素材，普通图集POST会重复建引用，均不作为本次封面登记路径。
- 在角色模块补一个窄的本人封面登记步骤：同事务鲜核active本人账号、本人active图片和保护素材读取权限，确定性私有个人album/ref、null workspace/project，返回稳定ReferenceImage ID与原授权thumbnail地址。重复核对仍为同一引用，不新建表、不关联WorkspaceAsset，不恢复已删除/失权对象，不借同名共享图集扩范围。沿现有角色写门及保存时权限/CAS检查。
- 新增/编辑表单使用同一上传/更换控件，保原封面与文字输入；区分上传、封面准备和已保存。真实完成并准备好官方缩略图后才更新草稿，显式保存才改角色。上传未知保原File/票据核对，上传已完成而登记失败只重试同一Asset登记；账号/会话/编辑目标变化不套用迟到结果。关闭不自动保存，取消编辑不永久删除本人上传历史或旧图片。

### 14.2 交付检查安排

完成本轮差量的必要隔离工程与完整候选构建/版本/服务/公网检查，复用未变输入的既有原证；不真实上传用户文件、不额外收费生成、不自动浏览器或功能验收。发布只回程序/配置，不回业务数据；保当前融合5表与reader、原私密发送配置、价格、原请求和2小时看护。新增/编辑上传、换图预览、失败恢复及保存后下拉展示仍由用户手验。实施/工程/推送/上线分别补记真实结果。

### 14.3 实施与定向工程结果

业务修改已完成：`CharacterAssetPanel.tsx`、`character-assets.css`、`src/lib/character-assets/service.ts`、新增`src/app/api/character-assets/thumbnail/route.ts`，以及定向工程脚本`character-thumbnail-upload-engineering.mjs`。新增/编辑共用直接上传/更换，原封面保留到受保护缩略图解码完成；登记仅建确定性本人私有ref，保存才关联角色。生成Composer、共享上传器/reference-import、schema及模型/费用链均未修改。有效共享拦截、撤销/过期共享不误拦；原删除/失权ref不复活。

- 12项实际模块/回调隔离工程通过：真实临时SQLite事务核owner/status/type/大小/read权限、私有album/ref/幂等/无workspace写、写暂停、API鉴权输入与原角色CAS；实际Panel回调核新增/编辑、ready关闭重开、同File未知恢复、上传后同Asset登记重试、decode失败/超时、账号epoch和编辑目标/文件对话框迟到结果。原证位于本任务私有`release/thumbnail-upload01/local/engineering.json`，10个源SHA均核同；script SHA `ce15ef20ee7cc0fab9859b4d0228ac90573df6a21fd0010be3f3d01e54b4312c`。
- 使用当前schema独立生成client完成窄TypeScript检查exit0；窄ESLint exit0（两warning）、TSX语法/PostCSS/差异检查通过，未修改共享依赖或generated client。TypeScript5.9.3／Prisma5.22.0。
- 工程隔离为temporarySqlite=true；networkAttempts/realUploads/modelCalls/browserRuns/productionDatabaseAccess/productionWrites均0。没有真实用户文件上传、浏览器功能验收或收费调用。
- 新工作区CodeGraph已同步2085文件，实际结构查询找到新登记函数；实施检查完成不冒已上线。等待UX16实际健康后继与当前发布窗口释放，再在该有效新基线上完成主候选完整构建、版本/健康与保护发布。功能仍由用户手验。

本地已合入对方已推送的UX16候选`90fb0a812790ab3bceb358f5c7cfee91b844e6c4`（1451），本轮准备1452；该合并没有修改本轮10个工程源哈希，原12项证据继续有效，不重跑。正式窗口及实际上线元证仍待对方交回，未启动本轮服务器候选或切版。

### 14.4 实际发布闭环

**v0.145.2 已于2026-11-11 09:36:37（纽约时间，UTC-5）部署，待用户手动验收。** 原证时间14:36:37Z，后验health于14:37:28Z通过。主源`adbc4587b002c7b32379f419729f2dbdfe56dd36`／BUILD`U1Vfw8JndDHcOREZCUOex`，分支`codex/character-thumbnail-upload-20261111`已推并核远端；继承UX16实际健康90fb／1451／l5xDbf3NvkT0mSk4Qt6uE。先获构建窗口，再等待原owner真实调用结束并释放切换窗口后才切版；后继融合任务已收到本轮健康源与恢复合同，并明确将继承本轮健康源。

- 修改四个产品文件（Panel、CSS、character-assets service、新thumbnail API）和一个工程脚本，另三版本文件；精确导出2520文件，净8个运行差量。Composer、共享上传器/referenceImport、schema、生成输入/编号、模型通路均无差量。
- 完整Linux类型、改动lint、12项本源隔离工程与Next内置全量types/lint通过。17原生记录按未变输入复用；17关联记录16复用、1项projects工程刷新；fresh计价通过。主构建及cutover均0，完整成品/原始子进程结果共同绑定，未只凭wrapper 0冒成功。
- 6真实启动检查、7服务、4timer、54公网资源、8匿名401通过，含新接口匿名POST→401；最终内外网health=true、releaseControllers=0。私密36目标策略/价格全字段/持久链接及2h看护保持。Works/CharacterAsset/5个Fusion表只读核既有原迁移，无DDL、数据恢复或未知任务重发。
- 恢复继续复用原`bbbcc1f9b6a311de9ea1fa83d5d8c50525615d68`／1451+points-pricing-guard.1／`wFBPdtkUEn_EQ74oygoGx`的实际九门和已编译成品；guardBase仍90fb，不把本轮新主源当成原九门变换基源。只回程序/配置，保所有新数据；不要求故障main目录可读，未演练生产回退。

服务器原证阶段`/data/video-api-debugger/release-staging/character-thumbnail-upload-20261111/attempt01`，pair`684d8c5e-6b1c-4ac8-bff5-23ff98b95613`；正式根私有`release/thumbnail-upload01/completed/`保存选定原证，未下载环境、DB、凭据或真实媒体。详[上传发布摘要](../../docs/materials/2026-11-11-seedance-private-character-assets/thumbnail-upload-release-summary.json)。新树CodeGraph已对应adbc/2085文件同步，源指纹`09bd2131d6224fbba65d1512de39ce4983374c7c7bb8b6c58e2e84b14a1ac4ee`；记录收口不重复索引/构建。

新增请求结构（隔离工程验证，非真实上传）：通用上传返回本人站内素材编号后，`POST /api/character-assets/thumbnail`发送`{"assetId":"<上传返回的素材编号>"}`，返回同一`assetId`、`referenceImageId`及`/api/reference-images/<id>/content?variant=thumbnail`。角色显式保存才将该ID传入`thumbnailReferenceImageId`。这里的上传素材编号不同于角色的火山Asset ID，不用文本冒素材引用，也不附加生成工作区图片。

实际新增/编辑上传、更换预览、取消/重开草稿、失败/未知恢复、保存后下拉选图及手机操作待用户手验。本轮未真实上传用户文件、未收费生成、未浏览器或截图功能验收；工程/健康与功能效果分开。未新增范围外问题。
<!-- /ARK-CHARACTER-ASSET01-THUMB-UPLOAD14-20261111 -->


<!-- PREVIEW-CROP-ROOTCAUSE15-20261112 -->
## 15. 上传素材看似被切割：历史缩略图根因核对（2026-11-12）

本轮用户请求“上传被切割，你看看什么根因”，附素材选择弹窗大图截图。本节完成该单问题根因排查，不将诊断记录冒作修复/上线。运行鲜核为c47b1adab9c0919159a928e663bbe86e786e2f44／v0.146.4，旧1452工作区只作Git对象/既有归属记录读取，不冒运行源。截图来自普通视频参考素材弹窗，不是角色缩略图上传表单。

### 15.1 已确认的原始证据

通过截图中同一页的3个完整文件名和排序，定向只读确认该页资产及截图主体“正视图.png”，没有批量读取全部素材。已取回该素材原件并确认4000×4000、5,835,897字节；SHA-256与上传时Asset.hash完全一致（`b69ac3fc8bf26f89ae703af4834f4ca7d27213796fc4fb67e51c6041181c4894`），视觉为完整双视图及左右部件。原件未被裁切/覆盖。

该素材保存的历史缩略图为300×450 PNG，直接查看其文件即可重现用户截图的同样左右截断；不是浏览器截图裁切或上传原件破坏。旧storage源码（7870a5977父提交）明确`resize(300,450,{fit:'cover',position:'center'})`，会把正方形图片强制填满2:3并裁掉左右。当前c47源码已改640×640/inside/withoutEnlargement，保持完整比例，但不会自动回填已经保存的历史thumbnail_url；同字节上传复用旧Asset也会继续取原thumbnail_url，并非重新上传就必定更新副本。

### 15.2 为什么大图窗口也像被切了

`ResourceLibraryPicker.tsx:741`把thumbnail与原图/preview地址分别传入共用大图组件。`content-reactions/media/route.ts:29`在thumbnail变体仍优先取`resolved.source.thumbnail`；`authorized-image-response.ts:143`对这个已经被裁的副本再做inside缩放，无法补回丢掉的像素。引用图路由同样在thumbnail分支优先`image.thumbnail_url`，是同类读取残留。

截图状态为“当前：轻量预览／正在读取原图／压缩副本未登记／已读取0 B”。`ZoomableImagePreview.tsx:236–245`正是在原图尚未显示时继续展示已加载thumbnail；`.compareImage`使用contain，单图仅一个pane。已验证的旧thumbnail文件与截图主体一致，现有CSS放大的是旧裁片，不是把4000原图现场剪开。上下两块是原素材本来就有的两视图，真实缺失为两侧内容。

因此根因闭环：**历史2:3居中cover缩略图裁掉两侧 → 新读取链继续信任/再压缩旧thumbnail → 原图尚未到达时把旧裁片放大展示**。原图下载首轮45秒未收完，随后按同URLRange接续并最终完整hash核同；这只说明本次读取较慢，不据此扩判全站网络根因。截图0B等待让裁片停留更显眼，但不是像素被裁的原因。

### 15.3 边界与后续修复落点

正确修复应在授权的图片thumbnail来源选择/按需派生层，针对历史裁切副本从同一合法原件生成保全幅的小图；不能只改CSS、把裁片拉伸、清全部缓存或让用户重传。沿既有owner/原件版本/preview-only读取边界，低权限仍只回缩略变体；不把可看缩略图变成可下载原件。优先按需补齐，不批量覆盖原片/旧缩略图/数据库，不重发生成。

本轮只读业务数据库/生产文件与既有源码，未修改应用、线上配置、上传原件、缓存、角色记录、费用或未知请求，未部署、未新上传、未付费调用。Chrome只盘点到另一角色融合页，没有截图所指generate现场，未新开/刷新/借用该页；未冒称浏览器现场复现。原件和缩略图字节/视觉/历史生产代码及当前读取代码足以确认上述根因；修复实施及用户功能手验尚未执行。

原截图按原名归档在正式根`docs/materials/2026-11-11-seedance-private-character-assets/diagnostics/2026-11-12-preview-crop/`，同目录有完整原片、旧缩略图与`rootcause.json`；原始图片均只保本地私有资料，不推到Git或公开外发。临时下载中间件与完整校验结果分开，未用部分文件冒原件完整。未新增任务外问题。
<!-- /PREVIEW-CROP-ROOTCAUSE15-20261112 -->


<!-- LEGACY-THUMB-REPAIR16-20261112 -->
## 16. 旧缩略图完整显示修复与提交未知排查（2026-11-12）

用户明确要求“直接修复上线，旧缩略图也要完整显示，不要裁切，保留原图，不用重新上传”，追加图1的submission_unknown根因诊断，并强调查风险。沿§15已确认原件/旧裁片证据实施，不重复取回/重传原图；任务未知项仅核原号，禁止新生成/重复扣费/自动退款。

### 16.1 两项范围与已核基线

1. 缩略图：共用图片素材与引用图thumbnail入口不再从300×450旧裁片派生；同一有权原件按需编码保全幅小图。复用既有readStudioThumbnail／inside640、受保护响应、缓存身份/HEAD只读和队列，不改上传、Asset/ReferenceImage、原件字节/URL或批量重建。视频/音频poster及模块自有封面保持。
2. 图1：只读定位“小U漫剧”9秒/720P/9:16/SD2.5的具体原任务、请求回执与日志，分清未发送、已发送未知、已受理但回执不明；核状态英文及“稳定下载生成中”是否误导，不用文案变更冒真实受理修复。原请求/冻结和真实费用保持。

实际起点已从c47/v1464推进为c8a5ae27ccd61f83fc1b17fbdd6a5e229b8423b8/v1470/WYB5qrC9wnawMnSgGmTO3；外部生图相容guard7362bcb093c1822f8c0927e1257c52fce3b44855/yxG4WDcTIgqLgBpRibUIT为10门，不能退回原9门。新隔离树legacy-thumbnail-complete-20261112从c8创建，正式根其它脏改不入包。UX22的355be2dbb61eb78e632df4cf885eb23b7703ab0c/v1480在独立stage构建中，不能重叠启动同机候选或覆盖其有效后继；本轮先本地实现，发布前继承其最终实际健康源。

### 16.2 实施前风险判断与保护

- 权限：viewOnly读取仍只返回640以内的编码小图，不302/回传原件，不放开original/download/HD或内部模板配方。原权限和账号/版本检查继续有效。
- 缓存与原件：按真实原件源/版本形成新派生缓存；不清全量缓存、不覆旧thumb、不写原件/DB。源缺失/失权/读取错误保持可恢复错误，不偷偷回旧裁片或给浏览器大原图。
- 负载与格式：现有两并发、32项队列、96MiB读取、40MP编码、远程SSRF/时限边界保持，按需读取而非批量预热。实际发现BMP上传合法而Sharp原图显示不支持BMP，须在既有队列内补有界私有BMP转小图，否则改源会造成格式回归；这是必要兼容配套，不扩上传平台。
- 原请求/费用：截图9秒任务处于submission_unknown，不由前端等待时间推断未受理或免费；只查原回执/原上游号，未知不重发、不清重试预算、不改冻结、账本或历史。
- 发布：必要窄工程/完整候选/原生按依赖复用/计价/版本资源与健康、十门完整guard和可执行仅程序恢复必须完成。UI/真实媒体功能仍手验，不自动收费或上传用户文件。

图1原截图已按原名本地私有归档diagnostics/2026-11-12-submission-unknown，旧裁切原证沿§15。实施/验证/部署与未完成风险另追加实际结果，不把初始方案冒已修复。

### 16.3 图1的已证因果与旧任务风险

截图未含任务ID，只能按项目、9秒/720P/9:16、4图及可见提示词匹配最近候选，不把匹配当截图ID证明。最新匹配`bd7382b7-1f4d-416a-a34f-7d8c33d0d20b`于07:26:47Z创建，5.122秒后上游HTTP200正文却是InvalidParameter/BadRequest，明确第4张image_url资源不存在；此前`f16162ef-5627-4a6e-9736-89b6af7eb815`于07:04:10Z创建，160.620秒后HTTP200正文仅code=-1/call api error，具体原因仍未知，不能套用后一次缺图结论。

两条均是普通seedance/dreamina-seedance-2-5-260628，并非Ark私域asset引用；4份上传原件物理存在，匿名HEAD/GET同址404。近期uploads权限收口正确地识别绝对站内Asset URL，匿名供应商不能借该地址读私图；普通tasks/create却只在多视图/画布等场景使用既有seedanceLocalReferenceTransport，遗漏普通视频页，造成权限合同与旧URL传输冲突。修法只去掉同一seedance调用的错误场景排除：先经原授权再将同一原件字节传入现有data URI字段，保图片顺序、首尾/多帧模式、每图30MB与请求64MB边界、原快照，不放开uploads，不改其它provider或上游错误/SAFE_RETRY规则。

两条都只发送一次，无provider_task_id，各冻135点。虽然最新正文明确参数错误，现有证据仍不足以证明“未受理且零费用”；因此不自动退款、换号、重发或解冻，不清预算。现有普通status恢复只处理draft，unknown finalizer会跳过，两旧任务仍须后续沿原请求由供应商核对受理与费用，不能冒称本次修复已恢复。此为原任务诊断遗留，不借修复改账务规则。

状态显示另有两处确定误导：assets未翻译submission_unknown，delivery helper把非成功一律称生成中。本批仅显示“提交结果待确认”及“等待提交确认，暂无可下载视频”，保已有预览能力、不转换持久状态。脱敏诊断JSON私有归档diagnostics/2026-11-12-submission-unknown/diagnosis.private.json，SHA256 `7f91e8a89d39f912e8a105853982f8c44b68b6a30a443511029e9f42bd1adf7a`；源码/日志行/只读命令有原证，未查询上游或创建任务。

缩略图实际读链还包含library/workspace DTO的旧thumbnail_url，须仅将active合法图片投影到同一保护端点；hidden/deleted沿旧合同，不借旧图修复扩大已删除素材权限。BMP兼容限同一两并发/32队列内私有临时单帧，40MP/96MiB和45秒编码边界；不写公开新原图、不替换DB或源文件。

### 16.4 实现与必要工程完成（未发布本轮）

产品净改8文件：两图片读取route、library/workspace DTO、image-studio/media BMP兼容，以及普通tasks/create、assets状态与delivery helper。另新增legacy-thumbnail-complete工程、扩既有multiview-reference-transport工程；未改上传器、schema、权限中间件、transport实现、上游错误/SAFE_RETRY与计费链。两执行者已STOP-WRITING，root自核净差异、读取权限与调用顺序。

- 缩略图9组隔离工程通过，绑定12源SHA；真实图片派生/响应函数运行，auth/DB为夹具边界，合成PNG/JPEG/GIF/WebP/BMP边缘和比例、旧缓存、HEAD/304、低权限640、失权/缺原件、40MP与2active/32pending均有证。窄ESLint和当前schema独立client TypeScript均exit0，无共享依赖变更。
- 传输/状态11组隔离工程通过，绑定11源SHA；真实transport/payload/delivery函数运行，两模型×三模式、外链保序、原字节和64MB/失权/路径限制有证；编排、原请求及冻结前顺序为实际AST断言，不冒全POST/真实费用验收。窄delivery类型和四文件lint exit0，仅assets旧区域一条Hook提醒。原producer为completed=true/count11，未伪造passed字段。
- 两工程network/database/真实上传/生成/账务/浏览器均0。脚本通过既有server-runtime.cjs进入，未新增stub/私密consumer。草稿夹具预热同步和VM Error上下文问题已定向修正，原失败保留；并非产品失败。
- 风险取舍：首次完整缩略图需按原件派生，远程读取仍受原180秒/96MiB/40MP边界；缺源或超限返回真实错误，不回旧裁片。只支持原视频transport的PNG/JPEG/WebP与每图30MB/总64MB，BMP配套仅改善显示，不隐式改生成格式。工程运行使用发布器已有env -i/NODE_ENV=test，不继承生产URL环境。

同站UX22已实际部署355be2dbb61eb78e632df4cf885eb23b7703ab0c/v1480/e_hsRKcVhd5V_SQ-q0I_X，public原证08:00:01Z、cutover0；root08:01:07Z核7服务同源active/内外health200ok/运行发布控制器0。新guard67305263189ecfddc79dcd11202764595bf2be1a/tX6SyfBNWAgTKvuak-X8k十门完整成功07:56:52Z。本轮将继承这一实际健康源，计划1481，仅构建main、复用该guard原成品与原时刻；未把本地工程冒本轮已部署。

CodeGraph同树两次准备分别遇already-running及合并时源码变化而退出，未返回成功结构查询；本批已沿真实源码与上述实际模块工程核关系，不把工具连接/准备冒成功。最终稳定源再按需同步，不阻断已授权的必要工程和发布。

### 16.5 精确组源与候选构建启动

最终主源8f73f25a7a6a83c461178f9097258ca7f507c1b5/v0.148.1，分支codex/legacy-thumbnail-complete-20261112已推且ls-remote核同；合入实际健康355be/v1480，融合21文件及外部模板开放修复保留。Git-only精确导出2534文件、13运行净差量、继承113原排除/新排除0、无docs/tasks运行差量、工作树读0/无凭据入包。29文件冻结包SHA256 `6bd56b71f42e0bf7873da82803407fb117b23131769c1bee8a85e947f74bb6ae`（312128字节）已上传并在服务器核同，16份继承原证逐字节复制，assemble逐Git blob核过。

新stage `/data/video-api-debugger/release-staging/legacy-thumbnail-complete-20261112/attempt01`，控制器sd2-legacy-thumbnail-complete-build-20261112-01已启动main-only构建。启动前核正式站仍355be active、其它build/release/cutover/recovery控制器0、工程父目录755与候选私有generated client约束；未切换版本。完整types/改动lint/两真实工程原件/native按输入复用或刷新/fresh计价/完整Next与实际子进程回执仍待收，不预填BUILD或冒已部署。

稳定源CodeGraph prepare/sync已exit0，绑定8f73、2099文件、pending/mismatch/missing/parse均0，源指纹fa0753c3f3836b765d1711d3a2ec3f0b3ba9c63dd3f9819080210b08304dee32；实际MCP context约90秒未返回，保留“查询未完成”缺口，不把索引成功冒结构查询通过。源码caller替代核readStudioThumbnail→readStudioDisplayImage(url,thumbnail)，后续preview预热原样。

### 16.6 首候选完整成功，但切版前捕获同版并行候选

本轮attempt01主源8f73/v1481完整构建已exit0，实际BUILD rux_lj-5WkdLdQBnvZK3B。服务器完整types/改动lint/两工程20组通过；原生17记录12复用5刷新，关联17记录13复用4刷新，fresh计价通过；Next实际子进程exit0/no signal/error、source-pair/十门guard原成品、prepared-pair及持久链接就绪。未切版。

切版前新鲜进程检查捕获另一个controller：multiview-action-controls-20261112/attempt04，candidate1fe7e725be9d0e74f907d638f2c99ee47f8a46cd也为v1481、base355be。root受影响发布命令在启动release前停止，未停服、无配置/数据切换；不是本轮编译失败。Reason live inventory仅本会话，未向其它聊天派工/广播，原单及实际controller是协调事实源。不能让同版候选先后覆盖同期修复；本轮保01全部成功原证，等待该后继实际健康后合入为1482，再构建/顺序发布。只读13差量对方17文件，交集仅package/lock/release公告；工程22依赖字节仍待整合鲜核。不会以未上线candidate冒健康基线或重放其发布。

两条旧任务进一步各按真实耐久clientRequestId精准只读查询一次（SDK既有POST /getResult，仅clientRequestId，非create/收费/结算）。08:27:33.919Z最新匹配返回HTTP200/0字节/119ms，08:27:34.045Z前一条HTTP200/0字节/85ms，无原key回显、上游ID或状态；仍不能证明受理/未受理/免费。SDK空响应回填clientRequestId只属占位，绝不当上游号。停止继续查询，原DB/135冻结各自保留，需供应商按两原key给明确受理与费用回执。

额外确认旧媒体错误503文案借用“喜欢暂时不可用”，已记tasks/discoveries.md的D-20261112-MEDIA-ERROR-COPY，未夹入本次代码或借此扩大重建。相容guard为原1480程序，不含本轮显示/传输修正；若实际用于恢复，只回程序/配置、保业务数据，修复行为需再接续，未演练生产回退。

### 16.7 发布占用判断纠正：原ready修复先发，后继须鲜核继承

16.6曾因同站候选build与同版号暂停。本轮随后核实际项目入口：对方仅build，无cutover-started/正式release或recovery控制器，当前健康主源仍355be；对方实际pre-cutover.py强制7服务cwd等于其baseline355be，禁止另一个fixed cutover同时运行。release-window-coordination也明确本地编辑/build/Git不自动占生产窗口。root临时人工预检把所有build-controller也列为正式切版占用，判断过宽；这不是既有发布器/工具安全拒绝。

按这些实证纠正计划：保本轮已完成8f73/v1481/BUILD rux_lj-5WkdLdQBnvZK3B首候选不变，确认无实际live切换且旧基线仍健康后先沿原guard发布；本轮实际发布开始/健康源在原单及固定todo登记，后继1fe等必须鲜核新主源、合入本轮修复并重新定版本，不能切回旧355基线或同号覆盖。未提前部署对方未验内容，不停止其build，不向其它chat派工，不绕过既有发布器。

02接续包仅本地inactive准备，已STOP-WRITING，不作为本轮待发布目标、不删除01成功原证或改冻结脚本。22绑定源与对方candidate零变，两业务修法无重叠，但该事实不把未上线candidate冒健康源。接下来仅执行原01固定来源release controller；真实前置/恢复边界全部继续有效。

### 16.8 实际上线与风险闭环（已部署，待用户手动验收）

**v0.148.1已于2026-11-12 08:37:42Z（纽约03:37:42）部署，08:38:40Z健康收口。** 主源8f73f25a7a6a83c461178f9097258ca7f507c1b5／BUILD rux_lj-5WkdLdQBnvZK3B，分支codex/legacy-thumbnail-complete-20261112已推并核远端；继承实际355be/v1480。主构建0、实际types/Next子进程0、cutover0；7服务均加载8f73，54公网资源核同实际成品、12匿名401（含两个图片读取GET及tasks/create和封面登记POST）、4timer、6真实启动检查和内外health通过。无真实上传/生成收费/浏览器或截图功能验收。

产品改8源码及2工程脚本、3版本文件，共13运行差量：合法active旧图的两授权读取入口和library/workspace投影按同一原件重派生完整缩略图，viewOnly仍640、BMP有界私有兼容；普通Seedance合法图片复用既有直传，保序/原件/三模式/两模型及大小限制，未知状态中文不误报生成中。上传器、原件/旧缩略图/DB及角色Asset ID未改写，无批量重建/重传。20项工程和22绑定SHA、完整types/lint/Next、34原生关联记录（25复用/9刷新）及fresh计价均有原证。

发布保护已实核：旧writer自然退出、无旧source进程/强杀；配置及一致SQLite备份保server私有，Works/CharacterAsset/5 Fusion表仅只读核既有迁移，未执行DDL或回业务数据。原两行价费全字段SHA d03c539d74a31b5e2a6a0305724b1b9f193e0ade878370898c7632d1bdc96539、私密36目标policy及持久数据链接保持；video delivery仍TimeoutStartUSec=2h/RuntimeMax=infinity。实际十门guard67305263189ecfddc79dcd11202764595bf2be1a／tX6SyfBNWAgTKvuak-X8k沿07:56:52Z原成功成品复用，不新造时间。

恢复入口：`bash /data/video-api-debugger/release-staging/legacy-thumbnail-complete-20261112/attempt01/program-recovery.sh /data/video-api-debugger/release-staging/legacy-thumbnail-complete-20261112/attempt01/release-input.json`。仅回相容程序/config、保新数据，不依赖坏main物理完整；未演练生产回退。guard不含本轮修正，若恢复使用须后续接续，不能冒新功能仍存在。其它build不等于live切版占用；本轮实际源/BUILD/时间登记固定todo和部署入口，后继必须鲜核并继承，不用同号或旧355覆盖。

**仍未闭环：** 两旧任务08:40:09Z只读鲜核仍submission_unknown/provider_task_id=null、各冻135、actual_cost/refund_amount均null；本轮未重发、退款/解冻或清预算。原key各精准只读查询一次仍HTTP200空体，无可验证受理/费用回执，需供应商按原key核对。前一generic错误不套用后一缺图根因，不能把新传输修复冒两旧单已恢复。首次完整缩略图仍需读取原件，受源站速度/可用性与原限额影响，缓存后复用，不承诺秒开。

用户手验：刷新核1481；原问题旧图在素材列表/大图完整呈现、不用重传；角色下拉旧图及新增/编辑换图保持；普通2.5多图新生成和原首尾/多帧照常，旧单仅看明确待确认状态。工程/健康不代替实际功能手验，不追加收费调用。非阻断旧媒体错误文案单记D-20261112-MEDIA-ERROR-COPY，未扩本批修改。

[本轮发布摘要](../../docs/materials/2026-11-11-seedance-private-character-assets/legacy-thumbnail-complete-release-summary.json)保存脱敏身份、检查和剩余风险。私有release/legacy-thumbnail-complete01/completed仅取回8份无凭据元证，未下载env/配置备份/DB或真实媒体；01冻结包和未用02材料原样保留。代码索引对应8f73已同步，MCP context超时缺口沿16.5，未冒结构查询成功。

<!-- /LEGACY-THUMB-REPAIR16-20261112 -->
