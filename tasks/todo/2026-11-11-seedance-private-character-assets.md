# Seedance 私域角色资产接入与管理入口

版本：v1.0.0 / R01。日期：2026-11-11（America/New_York）。
状态：已获用户“落地”授权；业务实施与聚焦模拟已完成，工程检查与原号读取鉴权窄检查已完成；正式候选构建、保护部署及唯一真实测试由主控接续，功能仍待用户手验。
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
- [ ] 完成对应模拟/工程检查，核对实际差异；必要发布沿现有受保护发布流程，新增 schema 的备用 reader 必须可运行，只回程序不回业务数据。
- [ ] 有条件执行一次真实测试并观察原任务到终态/交付；未满足条件则只保留该项缺口，继续不依赖它的工程交付。

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
