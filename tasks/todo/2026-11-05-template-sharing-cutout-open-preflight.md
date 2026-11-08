# 生图模板共享与 AI 抠图开放联合前置工单

版本 V1.2 / R03，2026-11-05，video-api-debugger。原联合功能已于v0.132.0部署；共享即时生效与工作台封面入口追加已于v0.133.8部署，待用户手动验收。本单统一承接 SHARE-DEFAULT01、CUT-OPEN01及后续追加，作为本批唯一执行与交接入口；历史采样和阶段状态保留原时点，以§15为最新收口。

## 1. 联合目标与基线

同一批完成“过度帧”等默认编号模板的主动共享，以及 AI 抠图面向内部成员的完整开放。交付覆盖入口、后台能力、业务身份、正常操作、异常恢复、验收和回退。

SD2 正式根为 /Volumes/Data/Projects/video-api-debugger。调查时生产基线 v0.131.2，应用源 d09830e2691081846849d4daac1416f62d1bfc42。上游抠图项目正式根为 /Users/gouki-youdoo/work/ai-cutout-web，调查时 API 源 29824dd2382874ebc1955db9f728b6a2b4a88f78、产品 v0.3.0。所有结论保留原采样时点；实施时继承最新正式运行源、已接受的费率/模板标记/使用次数及相容回退。

抠图开放范围按本站内部成员设计。现有私有模板是否共享由本人显式选择并保存；抠图的成员任务、历史和结果沿独立业务 owner 隔离。

## 2. 已确认现状与根因

### 2.1 模板共享及同类范围

用户反馈“过度帧”在模板上下文中缺少共享按钮，并要求排查同类。该记录属于本人、已保存 revision 55，source_preset_id 为空，但编号仍是本人最早的 default 工作区。前后端按编号前缀永久判定不可共享，改名和后续保存不能解除。

三个确定落点分别为 src/lib/image-studio/modules.ts 的 moduleDTO 返回 canChooseSharing、chooseStudioModuleSharing 的参数校验，以及 src/lib/image-studio/shared-contract.ts 的 publishSharedStudioModule 名称校验。src/app/image-studio/studio.tsx 的 canManageTemplateSharing 据此隐藏 templateSharingAttributes。只补前端按钮会在后续接口失败，必须统一三处规则。

生产只读 mode=ro / query_only=1，采集于 2026-11-05T09:09:21.382Z，对应洛杉矶 11 月 5 日凌晨。覆盖所有 91 个持久工作区、41 个模板原件，核对 source_preset_id、所有者、scope、共享状态、归档标记及 publisher/live 绑定。

| 类别 | 数量 | 结论 |
| --- | ---: | --- |
| default 编号被排除 | 5 | 其中 1 个为已改名的“过度帧”，其余 4 个为初始名称。共享选择记录均不存在 |
| 按现有来源关系可管理共享 | 48 | 不应受本次 default 修复影响 |
| live 引用工作区 | 30 | 沿原件发布者管理共享，不能从引用工作区另行发布 |
| 非本人来源或不具该原件管理权限 | 8 | 保留原限制 |
| 来源缺失、关联归档、绑定错配 | 0 | 本次元数据分类未发现 |

本人工作区共 48 个，分别为 default 1 个、可管理 45 个、live 引用 2 个。此为元数据与源码核对，不冒充每个模板的登录页面验收。未读取或归档模板提示词、参考素材或用户凭据。

### 2.2 抠图入口、业务授权与上游能力

SD2 生产 v0.131.2 / d09830e2691081846849d4daac1416f62d1bfc42。正确加载运行目录的 Next 环境后，现有业务绑定共 1 条，对应本次用户。2026-11-05T09:26:05.065Z 用该绑定只读查询原上游 history，返回 200。上游 /api/v1/capabilities 返回 200，计算端在线、未暂停、派发可用。上游服务为 ai-cutout-web.service，API 源 29824dd2382874ebc1955db9f728b6a2b4a88f78、产品 v0.3.0，当前 /opt/ai-cutout-web/current/backend。没有上传图片、创建任务、扣费或修改业务授权，原始凭据没有写入材料。

SD2 的导航与 ToolsMenu 限管理员，/cutout 页面另按角色拦截，proxyCutout 仍要求管理员且 cutoutBusinessCredential 只接受单个 SD2 账号绑定。图片结果“去抠图”的 controller/server 也有同类角色限制。普通成员需要同时完成这些入口和服务接入，单改菜单会进入拒绝或无授权状态。

上游现有 services/auth.py 已将 external key 解析为独立 owner 的 business principal，api/routes_v1.py 的 POST /api/v1/admin/keys/external 可按 owner_id 签发凭据。现有业务 API 没有查询当前凭据真实 owner 的接口，SD2 的单绑定保护正是为避免不同 key 实际归到同一 owner。不能只删除单绑定限制或让同事共用原账号的 key。

## 3. 联合修改地图

### 3.1 模板共享能力与发布

1. modules.ts 的 moduleDTO 去掉 canChooseSharing 中 default 编号排除。继续要求已持久保存，以及无原件来源或确有原件管理权限。
2. chooseStudioModuleSharing 去掉 default 编号排除。继续验证本人合法编号、当前活跃身份、工作区所有权、来源管理权限、共享绑定、版本 CAS 和原请求回执。
3. shared-contract.ts 的 publishSharedStudioModule 去掉按 default 编号拒绝。保留合法正式名称、显式共享选择、本人原件、版本、受保护上下文和固定素材校验。
4. 复用模板上下文中既有“共享给同事”开关、原请求核对和“保存并共享模板”。切换先保存个人共享选择，提示保存模板后生效；真正发布仍由本人保存触发。未知结果查询原操作，不换号重发。发布后沿原件管理入口取消共享。
5. 自动初始化默认工作区不写共享偏好的规则继续有效。上线不自动开启已有模板、不补写共享原件，不改模块编号和生成任务归属。默认工作区保留及不可删规则、封面、历史、费用和原件读取沿原合同。

该问题是已有业务规则过度依赖历史编号。复用现有共享选择、发布与回执能力即可处理，无需新表、迁移或引入组件/服务，没有需要额外开源选型的能力缺口。

### 3.2 抠图内部成员接入

1. 工具栏和移动导航保留原“AI 抠图”与 /cutout。内部已登录成员可见、可进入，页面使用本人账号恢复原图、参数和任务。没有绑定时明确显示尚未接入并禁提交，不跳走或伪造就绪。
2. 上游增加 GET /api/v1/identity，沿现有 _business(request) 和 require_business_principal 返回当前真实 owner_id、principal kind、credential_id 与 business scope。只返回身份元数据，响应 private/no-store。无凭据、worker 或管理凭据不能作为 business 身份。沿现有密钥和数据表实现，不新增身份体系。
3. SD2 的业务映射支持每用户记录 key 与 expectedOwnerId。保留现有单字符串绑定的兼容 reader；正式多成员模式需每条都有已核真实 owner，禁止重复 key 或多个 SD2 用户共用 owner。新成员使用 sd2:<用户ID> 命名空间的独立 external business key。原账号继续使用原 key、原 owner 和原任务归属。
4. 对多成员映射，proxyCutout 在本次请求内先用业务 key 调用 identity，确认实际 owner 与该 SD2 用户绑定一致，再转发原业务请求。身份不符、无 scope、已撤销或无法确认时不上传、不创建任务。身份检查失败在转发前可明确 submission_made=false；原任务提交后的未知保护继续沿旧合同。
5. 本批给现有获准内部成员建立独立业务绑定。沿现有管理 API 明确 owner_id 和原限额，密钥只进服务器私有配置，不发前端、日志、Git 或工单。创建回执未知时先核原 credential 记录，不重复签发。后续成员沿同一管理入口按需接入，不为本批新增账户管理平台。
6. 图片结果的“去抠图”沿当前有权读取的原件和原 handoff，不扩大他人原件权限。服务端以当前内部身份和本人业务绑定决定是否接收，客户端去掉仅管理员限制；禁用原因沿当前真实接入状态显示。接收导入不自动创建抠图任务，用户显式开始后才提交。
7. 原模型范围、参数、原尺寸、遮罩/修复/拆切、队列与账户限额沿当前服务。任务、历史、导出和结果访问均由上游真实 owner 隔离；同站 Cookie 不转给上游。原请求未知时只查原任务或原提交标识，切号清理原会话展示。

SD2 正式根 /Volumes/Data/Projects/video-api-debugger，实施从当时正式运行源建立隔离候选。

- src/lib/navigation.ts 和 src/components/ToolsMenu.tsx。开放内部成员的工具入口，保留原 /cutout 和当前菜单样式。
- src/app/cutout/page.tsx。将仅管理员门控统一改为已登录内部成员的访问条件，保原草稿/任务账号隔离及 readiness 禁用。
- src/lib/cutout/proxy.ts。映射兼容、内部访问判断、真实业务 identity 核对；原路径白名单、Origin、未知回执及敏感头过滤继续共用。
- src/lib/image-result-next/controller.ts 和 server.ts。结果交接同步开放给具备本人业务授权的内部成员，原件与原请求校验保持。
- scripts/cutout-contract-smoke.ts、scripts/test-image-result-next-controller.ts、scripts/external-access-matrix-smoke.ts 和相关导航断言。覆盖实际变更，不将菜单可见替代业务接通。

上游正式根 /Users/gouki-youdoo/work/ai-cutout-web。本轮可复用检查工作区 /Volumes/Data/HomeRelocated/gouki-youdoo/.codex/worktrees/cutout-progress-upstream-20261008，已有实际生产源对象。修改 backend/app/api/routes_v1.py，复用 backend/app/services/auth.py 的 principal 与 backend/app/services/server_credentials.py 的独立 owner 凭据能力。上游已有 owner 隔离检查直接复用，仅补 identity 与两用户交接需要的断言。不要从 SD2 直接读写上游 SQLite 代替服务 API。

## 4. 统一执行顺序

| 阶段 | 本批内容与完成条件 |
| --- | --- |
| W1 冻结联合候选 | 从实施时实际正式源建立隔离候选，保留已接受的其它修复。核对本单证据与当前差量，复用已有共享修复候选 |
| W2 补上游读取能力 | 上游先实现并部署只读 business identity，验证业务、worker 和管理身份边界，现有任务继续沿原身份 |
| W3 完成 SD2 同一包修改 | 统一修复共享的三道编号限制，同时接通抠图导航、页面、业务映射、代理和结果交接，准备可读新映射的相容恢复程序 |
| W4 验证联合候选 | 运行本单第 5 节受影响工程检查、必要候选构建。创建成员业务绑定时核准真实独立 owner，敏感值仅存服务器私有配置 |
| W5 联合交付 | 两项纳入同一 SD2 发布候选和一次联合发布，核版本、服务健康、匿名权限、持久数据和恢复入口，再按统一清单交用户手验 |

上游只读接口是抠图接入的技术先决条件。某个必要条件受阻时，在本单记录具体阶段、影响和接续条件，不将本批拆为两份独立工单或分别宣称完成。

## 5. 统一验收清单

| 编号 | 必验内容 | 通过条件 |
| --- | --- | --- |
| A01 入口一致性 | 模板上下文共享开关、工具栏/移动导航的 AI 抠图、结果卡去抠图 | 目标内部用户能在约定位置找到并进入真实功能 |
| A02 共享完整流程 | 持久默认编号模板选择共享、保存发布、原请求重放、取消共享 | 仅本人显式操作生效，记录与 UI 一致；重放不重复发布 |
| A03 共享权限与兼容 | 非本人原件、live 引用、未命名、旧版本、初始默认与普通模块 | 原权限/CAS/名称保护有效；已有未共享记录不自动公开，原编号、任务及原件保留 |
| A04 抠图独立身份 | 原账号和至少两名内部账号、错 owner、同 key 或同 owner 误配、撤销/过期、worker/admin 凭据 | 仅真实匹配的本人 business 身份进入对应业务路径；错误身份不能发起新处理 |
| A05 抠图正常操作 | 本人上传、显式开始、原号查询、历史、结果下载、原图 handoff | 用户能完成当前工具的完整流程，原用户历史可继续读取 |
| A06 两用户隔离与异常 | A/B 任务与结果读取、取消、切号、提交未确认、队列/计算端暂不可用 | 两账号不能交叉读取或更改任务；未知仅查原操作，输入与已有结果可恢复 |
| A07 联合发布与回退 | 必要构建、实际版本与健康、匿名权限、数据保护和相容恢复 | 证据绑定同一联合候选，恢复保留任务、媒体、账务、原请求与用户业务身份 |

工程阶段沿实际服务函数和隔离 fixture 验证；真实上游处理使用明确授权的账号和样本。页面功能由用户手动验收，服务健康或 capabilities 200 只证明对应运行条件。

## 6. 风险、发布与统一回退

模板共享继续保留本人权限、CAS、原请求回执、受保护上下文与固定素材验证。原 default 编号及任务归属保持；自动初始化默认工作区仍按原私有规则处理。

先发布上游只读 identity，现有用户和 worker 路径可继续使用。再准备 SD2 映射双格式 reader、页面/入口与交接修复及相容回退。继承当前正式费率、模板标记和次数统计，不覆盖其它发布。核准两名内部账号的不同 owner 与独立 credential 后配置新映射，最后启用成员入口。

最小工程验证包括匿名拒绝、普通内部成员可进入、外部账号原限制、本人上传/原号接续、A 的任务及结果不能由 B 查询或取消、worker/admin 凭据不能充当成员身份、同 key 或同 owner 误配拒绝、原用户历史可读、业务身份过期/撤销、结果交接和未确认提交不重发。先沿隔离 fixture 验证；真实上游创建或处理只用明确授权账号及样本，不能拿 capabilities 200 冒出图通过。页面功能仍用户手验。

回退保留原上游 owner、密钥回执、任务与媒体。新 identity 是附加读取能力，可留在相容上游。SD2 恢复程序必须能读取本批双格式绑定；若回旧单绑定程序，需先恢复原单绑定配置且关闭新成员入口，明确新成员暂不可用，原用户继续读原历史。出现跨账号读取、错 owner、旧任务失联、来源权限不符或新操作未知时停止扩大开放。

两项合入同一 SD2 正式候选。出现跨账号、错 owner、原件越权、旧任务失联、已受理操作未知或不相容回退时停止受影响动作并收口本单剩余项。普通部署检查与用户功能手验分别登记。

## 7. 前置完成与当前实施状态

| 必要前置项 | 状态与证据 |
| --- | --- |
| 生产对象、共享记录与同类范围 | 已完成，91 工作区/41 原件的只读分类和实际运行源 |
| 模板共享根因及修改点 | 已完成，DTO、共享选择、发布三道编号限制与 UI 能力链 |
| 抠图服务、原账号真实授权与独立身份能力 | 已完成，服务状态、原绑定 history 200、上游 owner-scoped key 实现 |
| 两项用户流程、异常恢复、权限与历史 | 已完成设计，复用现有共享回执、抠图原任务和 handoff |
| 联合依赖、验收、发布及回退 | 已完成设计，统一按 W1–W5 和 A01–A07 执行 |
| 工程实现、成员凭据创建、双用户实际联调与正式部署 | 实施阶段执行，尚未完成 |

用户追加“先写前置工单”之前，隔离工作区 /Volumes/Data/Projects/video-api-debugger-worktrees/default-template-sharing-20261105 已形成三处修改及 scripts/default-module-sharing-engineering.ts 候选。尚未提交、推送或部署，按新指令封存，后续实施可核差量复用。脚本首次在 Mac 创建隔离 SQLite 时遇 Prisma schema engine error，尚未进入业务断言，不能算通过，也不把环境错误当作生产缺陷。

现网身份、服务健康、原账号真实授权、所有访问限制、上游独立 owner 能力、修改地图、数据与交接流程、上线次序和相容回退设计均已完成取证/设计。工程实现、独立成员凭据创建、真实双账号隔离联调和部署属于实施阶段，本节不冒为已完成。现有源、服务及凭据可复用，无需购买模型、迁移数据库或开通新云资源。此次不调整旧 CUT-P1 数据盘迁移授权范围，若后续操作确会触及尚未获准的路径迁移，单列停止该操作，不能混入本次开放。

## 8. 原证与附件

- [生产模板元数据分类](/Volumes/Data/Projects/video-api-debugger/docs/materials/2026-11-05-default-module-sharing/metadata-evidence.json)，用于复核共享问题和同类范围。
- [抠图服务与实际只读授权](/Volumes/Data/Projects/video-api-debugger/docs/materials/2026-11-05-default-module-sharing/cutout-preflight-evidence.json)，仅保存版本、布尔状态和 HTTP 状态码。
- [原抠图资料与历史工单](/Volumes/Data/Projects/video-api-debugger/tasks/todo/2026-10-06-ai-cutout-upgrade.md)，复用已有正式原图、真实结果、接口资料和历史迁移边界。该文件中本批旧章节仅转引本联合工单。

本轮无新增用户截图。资料可访问性及已有证据复用沿原检查结果；凭据和用户媒体保持原有私有存放边界。

## 9. 唯一实施交接

```text
模板共享与AI抠图开放联合实施
SD2 项目 video-api-debugger
SD2 正式根 /Volumes/Data/Projects/video-api-debugger
抠图上游正式根 /Users/gouki-youdoo/work/ai-cutout-web
工单 /Volumes/Data/Projects/video-api-debugger/tasks/todo/2026-11-05-template-sharing-cutout-open-preflight.md
统一完成默认编号模板主动共享，以及内部成员AI抠图的独立业务身份、工具入口、代理和结果交接。
从执行时正式运行源继承已有成果，按W1–W5完成，SD2只组织一份联合候选和一次联合发布。
沿A01–A07核完整流程、两账号隔离、原请求、历史、实际版本及相容回退。
附件使用本单第8节的两份原证和既有抠图资料，不重复调查已确认事实。
出现跨账号、错owner、原件越权、旧任务失联或不相容回退时停止受影响动作。
回执统一列实际版本、入口、工程证据、部署状态、待用户手验及剩余问题。
```


## 10. 本次实施追加：插件下载页与模板封面共享开关（2026-11-05，PLUGIN-COVER01）

用户本次明确要求“落地上线”，并列明插件下载页与模板封面共享开关两项。本节记录这两项及与之直接相关的默认编号模板共享修复；原 §3.2 的 AI 抠图独立业务授权不是本节已完成内容。已询问是否一并实施，未得到范围答复前不签发成员凭据、不修改抠图权限，不以本批交付冒称原联合工单全部完成。

1. 工具菜单新增“Chrome 插件”，入口 `/tools/chrome-extension`。页面分桌面版与 Chrome 版，提供原 Mac Apple/Intel、Windows 64 位及固定 ID Chrome 安装包，说明折叠展示。版本和地址直接读取现有 `ext/mj/sd2b/latest.json`；沿原公钥与签名域验签，不写死当前版本，不修改下载登录保护、不新增发布清单或数据表。
2. 名称旁复用同一共享开关，预留固定宽度，悬停/键盘聚焦显现，触屏常显；点击只操作共享，不打开模板。只对有现有管理权限的对象投影状态与修订，分页内批量复用读上下文，不带出正文、输入或原件权限。
3. 已发布模板复用 `useSharingCommand` 原请求、当前状态投影和停止共享确认。未发布模板复用原 `set-sharing-preference` CAS/回执；封面与编辑器共用命令，丢失回应或刷新保留原号，不换号。成功只合并共享偏好与修订，不替换当前编辑内容。未发布只显示“已选择共享，保存模板后生效”，真正共享仍沿本人显式保存。
4. 原默认编号三处修复沿 §3.1，未增加自动发布/历史回填；未命名、他人原件、失权、过时版本和未知请求保护保留。
5. 已继承费率说明首候选 `63fcf3ed4270d6f7e66c9c3f2a7f2ba2fd2e7b78`，计划网站 v0.131.7；费率说明同批最终源尚需接续，构建/发布串行，不覆盖 0.131.6 成果，不修改生产桥 0.6.11 打包工作树。

工程检查：签名/版本/平台/地址校验 8 项；原请求持久化、响应丢失、存储失败、并发点击、账号切换、刷新接续 6 项；Linux 隔离 SQLite 原模块/原件/权限/CAS/页内投影 12 项。全部零真实生成、零生产业务写入、零真实浏览器功能验收。原封存脚本未走到的请求字段、不同操作复用 requestId 及已撤回原件读取预期已修正；失败原证保留，不放宽业务实现。

待完成：接续费率说明最终提交，完成最终类型/构建与受保护部署，补实际版本及证据。验收由用户手动完成：入口与下载对应当前清单、封面/内部共享一致、未发布不提前共享、点击不打开、标题不跳动、键盘与触屏可达。AI 抠图开放单列待范围明确，生产桥 MJ-SAFE01 继续保留原任务与串行边界。

## 11. CUT-OPEN01 范围确认及联合交付（2026-11-05）

用户明确“抠图开放也一并实施”，取代§10等待答复的临时状态，已组织一份网站联合候选和一次受保护发布。原A01—A07及下载/共享交互仍用户手验。

## PLUGIN-COVER01 / CUT-OPEN01 插件下载、封面共享与成员抠图（2026-11-05）

已部署，待用户手动验收。主源6bc35e893b01a893f780eadd358ba8f32deb4dc2，v0.132.0，BUILD IypmpFaIXw0yioR3NJuhS，2026-11-05T13:13:58Z公网收口；继承71a2/v0.131.6费用说明与使用统计。新guard d2d8f22405e5f0f93d0d4184a6baffd8aac64380/v0.132.0+cutout-reader-guard.1，BUILD clzBn6edeiJmirGZEgieU，保25独立绑定、关闭普通成员抠图入口。

- 工具菜单Chrome插件入口 /tools/chrome-extension，复用签名五包清单自动版本/下载，安装说明折叠；封面与模板内部共用共享开关、原回执和CAS，默认编号模板可主动共享，未发布仍本人保存才生效。悬停/聚焦预留槽位、触屏常显；不新建表或回填历史。
- /cutout导航、页面、代理与结果原图handoff统一内部权限，业务请求先核真实owner/scope/credential。25获准内部账号独立绑定，新增24个business key；原账号key/owner不变，私有密钥只在服务器，沿既有限额。原图导入不自动处理，未知只查原号。
- 工程：8清单+6共享原号+12隔离SQLite复用，60代理及控制器/导航、本地类型/lint通过；主/guard各32项实际私有reader检查。上游7身份函数、2种HTTP模式、22原API复用，另1项A/B临时SQLite读/取消/下载隔离通过。双完整Linux原生/价格/Next/types/lint、6启动门、7同源服务/4timer、公网4资源SHA/4匿名401通过。两价格键全字段SHA194e8d3a2a9e009585ec005a488c9767c31b4fc1c6550abc378053f70eb259fe保持。
- 上游7e28858/v0.5.0已部署，原身份/历史200且指纹一致；新identity拒绝guest/worker/admin。两次早期切换失败及自动程序恢复原证保留。SD2在writer排空/一致DB备份和6门通过后仅原子更新绑定行，保其余env及uid/gid/mode。恢复只回新reader，保上游附加接口、身份、DB/媒体/账务/原请求。
- 原Mac计算端：既有0.3 App自然停止后按原身份重启；已证继承失效127.0.0.1:7898代理，同HTTPX对照ConnectError，进程限定NO_PROXY后health200。只给项目私有.env.worker追加原抠图域名/loopback直连，不改电脑代理、原URL/token/ID、模型或数据路径；真实心跳接续中。未上传用户图片或创建真实处理任务，无收费生成或浏览器验收。
- 用户手验：入口/最新安装包、封面与内部共享同步/未发布状态/标题稳定/键盘触屏、本人和另一账号上传—显式开始—原号历史—原尺寸结果、原图handoff及保存导出。

正式工单及私有发布原证见原单§11和docs/materials/2026-11-05-plugin-download-cover-sharing/release/attempt01。0.131.7/beecd仅中间构建未上线。生产桥MJ-SAFE01仍独立接续：38隔离检查通过，W4/W5、兼容/整合/提交打包未完成，不冒已发布。

### 11.1 发布接续与剩余边界

中间0.131.7/beecd曾完整构建mDC7RPGMCZ9xoydrQU3gq（11:30:06Z），未部署；加入CUT后主6bc完整重建。新guard从正式71a2建立，旧1f82只能读单绑定，未用作恢复。

guard原生/价格完整通过后，包装输入误将两个reader标签串成一个，触发原works-method-reader.1描述断言。仅修描述字段并单列cutoutReaderContract，经既有readPreparedPricingInputs和原receipt验证后接续尚未运行的method fixture/Next，保原run e07cb9c9-cb57-4fb7-9a9f-b2eef50c042a、native开始1793883311949/结束1793883667868；未改受限engine、降门、重跑成功原生或重造时间。原生完成后本机SSH空连接未退，核服务端无原执行者后只关该自有连接，保原成功证据继续Next。

业务key签发沿原管理API逐条持久回执，未知/保存失败即停，不重签；真实25条identity/history均核准。应用绑定前两包完整构建和6门通过；无schema、数据覆盖或计费通道调整。真实图片处理、共享/下载/安装仍用户手验。上游实际源7e28858，后续测试/资料31756a7未改运行代码。

恢复入口为同run的recovery-commands.sh，只回新guard d2d8f2240，保新增业务身份、上游identity和全部数据；未做线上回退演练，不冒通过。Mac真实心跳接续见后续worker-recovery脱敏证据，不能以人工心跳或health200冒就绪。

### 原生计算端接续证据（2026-11-05）

原有AI Cutout Mac进程已按原bundle及身份恢复，私有项目NO_PROXY已修正继承代理导致的HTTPX ConnectError；全局网络设置未改。当前仍没有真实worker心跳，页面继续禁用新增处理。模型状态导入连带加载FastAPI是待核线索，不能写成已证实死锁。未上传用户图片、创建真实任务或人为补心跳；详细脱敏记录为本单materials内worker-recovery.json。此阻点保留，不能以网站/API部署成功冒抠图可用。

2026-11-05接续纠因及恢复：上述为早期状态。原进程实际还继承了小写no_proxy，仅含loopback，覆盖了项目大写NO_PROXY；HTTPX同环境对照原样ConnectError、统一小写后HTTP200。原生bootstrap局部修正并以d7bfcf78提交推送；45项检查通过。确认三队列ready/unack均0后仅原App自然退出并重启，14:13:54Z真实心跳两次推进32.604秒，worker在线、未暂停、MPS及BiRefNet可用，派发可用。未改全局网络／授权／API／模型及数据，没有提交图片处理；连接恢复与实际出图手验分开。此前FastAPI导入等待未证实死锁。详见[本轮根因及恢复证据](../../docs/materials/2026-11-05-plugin-download-cover-sharing/worker-proxy-root-cause-20261105.json)。

### 原生计算端已恢复（最终状态，覆盖上方待核记录）

后续核对（2026-11-05T14:14:57.788619+00:00）：真实worker已恢复在线且空闲，device=mps，原worker身份保持。已确认剩余根因是继承的小写no_proxy覆盖项目NO_PROXY，HTTPX继续连接已关闭的127.0.0.1代理；正式本机native bootstrap d7bfcf7在客户端创建前同步大小写绕过设置后恢复。独立模型状态诊断最终完成mps/13项，不再把模型初始化列为未解决阻点。未伪造心跳、未生图、未改全局代理；实际抠图操作仍待手验。
## 12. “过度帧”选择共享后未发布的定位（2026-11-05）

生产鲜核 v0.133.7 / 796da6b036573b358aeca48df08d14190a768fc5。UTC 采样时间为 2026-11-06T03:22:16.171Z，对应洛杉矶 11 月 5 日晚间。本人原 default 工作区现为 revision 58，共享偏好 enabled=true / revision 3，但 source_preset_id 仍为空，没有对应共享原件或 publisher 绑定，也没有成功发布回执。

洛杉矶 19:20:17 与 19:20:19 两次已持久保存的原操作都为 set-sharing-preference，分别关闭和打开选择，最终保持开启。实际界面流程中，changeModuleSharing 对未发布模板保存偏好后打开上下文弹窗；saveModuleSettings 的“保存并共享模板”调用 saveModule 的 definition 分支后，才创建共享原件。已发布模板的同一开关则直接变更原件的共享状态。

直接原因已确认为“共享选择已保存，首次发布尚未完成”。两种状态使用同一开启外观，虽有“待发布 · 保存后共享”和提示文字，操作含义仍容易与已发布模板混淆。当前证据不能判断用户是否点过最后的保存，也不能排除一次未成功的保存。所查日志没有模块读取错误；该时段 Nginx 请求日志受当前系统账号权限限制，未取得失败请求证据，不将缺日志写成请求未发生。

本轮仅调查并保留现有显式保存合同。下一步正常入口是同一上下文弹窗的“保存并共享模板”，成功须核共享原件、publisher 绑定和当前源状态，而不能只看开关。若该操作仍失败，沿原保存请求与客户端错误继续定位，不自动更换原号或直接改库发布。原证见[本次状态和命令回执](/Volumes/Data/Projects/video-api-debugger/docs/materials/2026-11-05-default-module-sharing/sharing-pending-diagnosis-20261105.json)。

## 13. SHARE-EFFECT01 共享开关实际发布（2026-11-05）

用户在上述调查后明确要求“修改上线”，授权两个入口统一为实际共享；不拆新工单，原插件及AI抠图范围和交付保留。

- 封面与上下文开关发送显式 `share-saved-module`，沿既有发布事务创建共享原件与publisher绑定，成功回显后才显示开启。共享已保存模板，当前未保存编辑保留，不再额外打开设置弹窗。
- 原偏好命令与本机旧待确认请求按原号、原含义接续；部署不批量发布已勾选模板。撤回后的原发布回执只回当前状态，不重新开启共享。
- 个人补充描述迁入本人overrides，直接主图和临时参考不进入共享定义；受保护模板原文、作者归属、固定参考与提示词组限制、封面、CAS和费用合同继续沿原链路。首次绑定仅同步来源和保存基线，保留当前草稿。
- 针对性检查已发现合法初始revision=0被自动封面准备reader错误排除。修正为非负整数，与数据库默认值和原CAS合同一致；其它版本、owner、request、lease、指纹及封面校验保持。
- 工程证据：客户端原号、账号切换、旧命令兼容及开关9项通过；隔离SQLite覆盖直接发布、个人输入隔离、权限/并发/重放、撤回，以及默认编号模板直发与同事目录。首次无权对象fixture把404误当必须403，按既有隐藏对象策略修正断言；revision=0缺陷保留原失败记录后实际修复。最终工程数、构建与上线身份在发布后补记。
- 待用户手验：刷新后“过度帧”显示实际尚未共享；主动点击后同事目录可见；撤回后失权；当前未保存上下文、补充、主图及参数保留。未自动发布现有私有模板，无收费生成或浏览器功能验收。

补充检查已完成：直接共享从同一事务沿用已保存的current/historical设置模式和原历史任务来源，不接收客户端覆盖。历史发布新建version2记录后，固定参考setter仍只认version1，会把合法记录误报“所有者不匹配”；现统一接受合法v1/v2，v2仍校验task-settings-v2协议，原owner和CAS保持。20项隔离SQLite＋9项客户端工程检查通过，0上游调用、0生成任务、0生产业务写入；唯一任务为隔离fixture种入的历史来源。

另补两项实际处理函数检查：首次发布成功但响应丢失，目录先变为已发布来源时，封面和编辑器仍优先核对原module发布请求，不能误走普通开关撤回。核对完成后的正常撤回继续沿原preset链。客户端11项＋隔离SQLite20项，共31项通过；新增处理函数由真实TS源码提取执行，无浏览器操作。

早期12e069764、584dca603候选被上述补充证据取代，均未运行Next构建、未部署；最终候选重新绑定实际源码和受影响检查，保留早期原证与时间，不把旧结果改成新运行。

当前状态：代码已实现，正在必要工程检查及保护发布，尚未声称上线。

## 14. COVER-ENTRY01 工作台即全部封面（2026-11-05）

用户追加“侧栏的全部封面删掉，以后点模板工作台就是全部封面”，同批合并，不拆单。删除工作台桌面侧栏及手机分组栏的重复“全部封面”按钮；顶部导航、常规侧栏、首页及工作区入口统一显式进入 `/template-studio?type=image&view=covers`。旧裸入口完成原鉴权和允许类型核对后，同样进入封面，避免恢复到上次视频任务。

具体图片模板、共享原件、视频模板/结果等带明确目标的链接及浏览器前后记录继续保留；没有图片权限的合法视频账号不被带入图片页。共用原封面页与原路由，不建新页面、不清草稿或历史。专项入口检查覆盖登录回跳、裸入口、封面直达、具体图片、具体视频、仅视频账号与原拒绝权限；桌面/手机外观和同页点击入口待用户手验。既有共享修复继续合并，实际发布见§15。

## 15. SHARE-EFFECT01 / COVER-ENTRY01 已部署收口（2026-11-05）

已部署，待用户手动验收。UTC 2026-11-06T04:59:20.550626Z切入，实际Web及6个常驻辅助服务同源 `2dc29ec3c40fd7b940e7c8d26f033ebe09075338`，版本 **0.133.8**，BUILD `GpD4_VSWXng9OZ827K2k-`，run `e4a92312-485a-47c4-bc18-681212ae00d6`。此前0.133.7基线的头像、默认项目、抠图、角色参考图及相关交付保留。

- 共享：封面与上下文开关实际发布已保存定义，成功才显示已共享；本人补充、主图、当前编辑保留。旧偏好和待确认原请求兼容；来源已变成preset时仍先核对原发布，不误撤回。默认revision=0、current/historical模式及v2固定参考记录相容已补齐。不在部署时自动公开已有私有模板。
- 入口：工作台桌面/手机不再单列全部封面按钮；常规模板工作台直接进入 `https://sd2.youdooart.com/template-studio?type=image&view=covers`，裸入口同样落封面，明确模板/视频目标及原权限保留。
- 工程：38项专项检查（后端20项沿匹配源码原证复用，最终候选11项客户端＋7项入口）；主源完整Linux原生恢复/价格检查、Next构建/types/lint通过；同源6项启动检查、7服务/4timer、3个公网页面资源SHA、3项匿名401核对通过。未运行浏览器功能验收或收费生成。
- 保护：无schema/迁移变更；旧writer自然排尽，无强杀，一致数据库备份保留在本次server stage；原环境、数据链接、私有策略及两费率键全字段SHA `194e8d3a2a9e009585ec005a488c9767c31b4fc1c6550abc378053f70eb259fe`保持。未回业务数据、图片、账务或原回执。
- 公网清单初填了不存在的`GET /api/image-studio/gallery`，收到404后原控制器末段退出；服务已正常切入。保留原输入与错误日志，只补核真实`POST /api/image-studio/gallery/query`及共享PUT的匿名401，并以补充只读清单完成公网资源、服务、策略与价格核对；没有重建或再次切换。
- 回退沿既有相容guard `1d452f9186053d3012f420d330f4dce93a33d7f2` / `0.133.0+body-pair-reader-guard.1` / BUILD `4THsI43mwKhhvzVsWliHk`，原完整构建时点2026-11-05T16:46:20.139681Z不改；本次未重新构建guard、未演练回退。只回程序和配置，不回DB/媒体/费用/回执。入口：`bash /data/video-api-debugger/release-staging/template-sharing-effective-20261105/attempt04/program-recovery.sh /data/video-api-debugger/release-staging/template-sharing-effective-20261105/attempt04/release-input.json`。

待手验：刷新后从模板工作台直接看封面；桌面/手机侧栏精简；“过度帧”重新主动开启共享后同事可见、撤回后失权；当前草稿和个人输入保留。旧勾选未实际发布的模板仍显示尚未共享，不能把旧勾选冒充已经公开。

原证：[部署收口](/Volumes/Data/Projects/video-api-debugger/docs/materials/2026-11-05-default-module-sharing/release-effective/closure.json)、[公网证明](/Volumes/Data/Projects/video-api-debugger/docs/materials/2026-11-05-default-module-sharing/release-effective/public-deployed.json)、[专项工程证据](/Volumes/Data/Projects/video-api-debugger/docs/materials/2026-11-05-default-module-sharing/release-effective/focused-evidence.json)。完整原始记录保留服务器`/data/video-api-debugger/release-staging/template-sharing-effective-20261105/attempt01—04`；08ee候选完整构建通过后因用户追加入口被取代，未部署。更早原记录不重写为当前结果。

本轮未新增范围外问题；原工作区未提交的前置候选已保存在stash `a5b299431ac2279170823771761583392089bf63`，未覆盖他人脏改。


<!-- SHARE-READBACK02-20261105 -->
## 16. SHARE-READBACK02 首次共享后回读503（2026-11-05追加）

用户再次反馈“过度帧仍无法打开共享”，明确要求修完实地验收；本项真实浏览器验收已获授权，视频复用和GPT Image2.6原任务继续保留。

本次真实证据：Ego空间5/p1，正规飞书原权限重授权后实际登录杨波管理员。过度帧已显示共享，但选中模板后真实GET模块503、主体错误；14:46:31—48连续共享PUT503。数据库原件is_shared=true，publisher绑定、封面和原发布回执均已提交，不能把503当成未写入而重发。只读原DTO定位studioDefinitionOrigins第12行：首发后source_preset_id指向新共享别名，但静态来源未登记这个新ID；现存prompt/context两字段仍是绑定原模块、原作者的有效密文，却在认证密文前被无关的明文来源推断挡住。

上次工程测试漏掉“真实加密字段＋首次发布后的回读”，本次用独立随机密钥和严格策略重现同一503（旧代码失败），修复后通过。共用读取改成逐字段：密文沿现有codec核kind/id/field并做AEAD认证，使用已认证的原来源；明文仍严格按既有来源推断。错行、错字段、密文篡改、未知明文来源仍拒绝，其他账号不获得原文权限。既有模块保存也只沿已认证原字段和原protectPatch；新建非空定义仍核作者，不对既有行无条件重算newOrigins。

不改生产原密文、共享数据、原请求/回执，不重发生成、不扣费、不扩白名单。相容保护版须继承d2ee配方读者，并带本次共同读取修复及2.6模型键读者；不能用不识别新配方的旧1d保护版。当前生产已由其他批次正常升级到e3e4ecb/v0.134.2，本批源码已整合该最终源，尚未部署本项修复。

工程复跑：`node scripts/module-sharing-readback-engineering.cjs`，5组真实加密检查通过，零生产写入/网络/费用；`node --import tsx scripts/test-video-reuse-image26.cjs`原证保留。最近两条视频原素材只读执行至写入边界，新候选分别prepared=4/7、skipped=0，未改变真实工作区或回执。Mac全仓types因数据盘等待已终止，最终types/lint沿Linux完整候选，不冒通过。

待闭环：完整主/相容保护版构建和发布检查；随后真实Ego核原模板能打开、上下文与共享状态、保存/刷新、共享目录和现有权限。不能以is_shared=true、fixture或构建冒实地通过。2.6仅预接入，真实通道/费用/凭据目的地许可未确认，仍默认关闭；视频复用已修源码，待同批部署和用户手验。
<!-- /SHARE-READBACK02-20261105 -->


### 16.1 同根因入口补齐与发布接续

已沿studioDefinitionOrigins全部调用点核对：普通读取、既有模块保存、显式私密维护计划。维护计划器也对密文过早推断新别名，现同样按字段惰性处理；原cell/AEAD认证、显式ID选择、列白名单、行CAS和执行授权不变。新增真实加密计划检查：现存合法密文计划返回unchanged=1、无替换行；未知明文和篡改仍拒绝。共6组工程检查通过；没有运行生产迁移/密钥轮换，正常数据库备份不调用该计划器。

其他发布正在以56c7c9ff/0.134.3和新的pricingEnabled读者3e9b6ba8构建。本批不并行重型构建或切版；后继源必须继承它最终实际主源与新保护版，再叠加本项修复。d2ee及其早期2.6衍生源码包不得单独用于新启停字段上线后的回退。真实Ego仍保留空间5/p1，完整实地验收待正式修复上线后继续。


### 16.2 实际部署与本次指定的Ego验收完成（2026-11-06）

本节更新§16/16.1的待发布、待实测状态，不改早期原证。共享读取、既有保存和显式维护计划三个同根因入口均已修复。上次只验证了共享状态写入和非真实加密fixture，漏掉共享已提交后的真实密文回读；这次补齐该场景及其读取消费者，不靠重复发布或重新加密消除报错。

- 实际发布：UTC 10:21:13Z，run `a37d72d2-968b-442b-8136-5a40baf3598f`，主源 `dd570b07346690eb5dfcd8b31554c8e756f13855` / **v0.134.4** / BUILD `t2AGRROw2FDxROyB39UAi`；相容保护源 `f351f2df54050b09a8e952fcc17b3ed18546dadb` / BUILD `luHNe4Re7_5rjC-MGXf_K`。两源完整Linux原生14组、计价、Next/types/lint通过；六启动检查、七服务四timer、四公网JS同SHA及三个真实GET匿名401通过，无DDL或费用/余额/合同改写。
- 真实页面：使用Ego中已登录的实际作者杨波，打开“过度帧”及模板上下文，原GET503变为200，共享开关可用。10:32:43Z在页面关闭共享并确认，GET shared=false；10:35:22Z页面重新开启，GET shared=true；10:37:19Z刷新、重开上下文仍为true，revision59→61，无错误提示，待确认共享请求为0。没有点击保存当前编辑定义，不提交既有草稿，不生成或扣费。最终保持共享开启。
- 数据保护：共享开关前后核对原数据库，模块/原件四个prompt/context密文字段SHA全部不变，来源ID、双方owner保持。只发生本次明确关闭/开启所需的共享状态、版本及原号回执变化；没有改写旧回执或生产密文。
- 同事边界：11:11:57Z，以真实普通内部同事身份，在当前生产源的一致私有SQLite快照运行实际共享getter；来源解析和依赖权限通过，返回私密templatePrompt/context均为空，productionWrites=0。相关读取源码SHA与0.134.4一致。这是服务端真实身份核对，不能冒充另一位同事登录浏览器的验收。
- 首次attempt05公网脚本错把不存在的GET `/api/tasks`预期为401，收到404后自动保护恢复成功，未回数据库；核源确认该路由本来不存在。attempt06仅去掉错误探针，复用同一已通过的构建与原时间，保留三个真实GET匿名401后成功发布。原失败、恢复和最终成功原证均保留；没有修改鉴权迁就探针。
- 后继发布：本次实地验收运行0.134.4；当前0.134.5主源 `c2dc71893e0bd6f8f5c7a4b15781182b551d571c`继承共同读取修复，11:11Z同事核对基于该版本。当前相容源为 `3234d55db60d74f57eaadd03612dbdf7b7d8faae`；本节早期保护版和旧费率指纹仅作历史，不可重放旧发布脚本恢复后继价格或合同。

原始证据仅归档在正式根私有目录：[实测与发布原证](/Volumes/Data/Projects/video-api-debugger/docs/materials/2026-11-06-sharing-readback/)。其中sharing-before/after.png为原截图，sharing-off/on/persisted.json为页面实测，sharing-data-before/after.json为原字段指纹，sharing-recipient-projection.json为同事getter核对；构建/发布/错误探针与一致备份元数据同目录。截图、原始私有数据不推Git，数据库文件不外拷。Ego专用空间9已完成并关闭。

本次用户指定的“过度帧能打开、共享关闭/开启、刷新保持”已实地通过；原联合单的侧栏、封面及其他工具不因此冒充已手验。视频复用同批部署，前端待用户手验；2.6仍未开放真实通道。未新增任务外产品缺陷。


<!-- SHARE-COLLEAGUE01-20261107 -->
### 16.3 SHARE-COLLEAGUE01 同事打开与正常生成两条链路（2026-11-07）

已部署，待用户手动验收。实际主源9ae7ab0cb318adc0a5d34d2af632257e1ff2b508，v0.134.20，BUILD NWJKE_YesaMnvCSTysJFY，UTC 2026-11-07T15:56:15.763706Z切换，15:57:27Z健康收口。承接原生产v0.134.19/6f8106ed8与19最终配置，没有覆盖前序18结果UI/角色单格复制、19最高画质切换及此前任务。

三处根因和修法：

1. 普通同事的过度帧live工作区已创建，源共享开启且定义/素材权限正常。空prompt/context却在完整moduleDTO返回前被私密定义reader按新module-source别名推断作者，静态来源未登记而503。现只对严格空字符串跳过来源推断；密文仍核AEAD、原来源及kind/id/field，非空与空白字符串未知来源仍拒绝。已有密文字节和归属不改，不需要按每个新模板迁移私密名册。
2. generationPayload对普通/shared本次风格选择发送styleGroupVersions（空风格也传{}），旧assertRestoredStudioDraft却限制只有显式恢复才可传，提前409。现去掉这一冲突限制；实际消费端继续鲜核风格权限与版本，显式恢复仍核原来源、禁止混未保存定义并要求完整版本。
3. 单张/批量API遗漏共享、恢复、设置三类明确业务错误的拒绝回执，导致明确拒绝仍停在“查询这次提交”。现沿原rejectStudioSubmission的新鲜证据事务及耐久屏障处理；任意HTTP4xx、网络/数据库失败、有费用/调用/部分受理证据仍保持unknown，不自动重发或解锁。

完整数据对照：同一267444224字节一致生产备份、真实普通同事工作区，基线19过度帧503→当前20完整DTO可返回（200），技能03原本200→200；两者普通同事的私密上下文返回均0字，源prompt/context与工作区四字段指纹在对照中相同。上线后又只读核真实生产两模块，四字段仍与之前相同。最初直接只读Prisma事务的StringExpected来自BEGIN IMMEDIATE与只读连接不相容的探针，改用私有隔离备份复核，不能把该探针错误当线上故障；备份不外拷、不做恢复。

工程与发布证据：真实加密9组、Linux真实SQLite完整同事选用/DTO/原选用重放/撤回23组、真实API及原号/费用/部分受理/数据库异常保护14组，以及普通与恢复风格工程通过。前两轮完整构建分别因新增fixture的联合类型收窄和ES编译目标下iterator写法失败，未停服；随后先完整tsc退出0、补受影响14组，再由最终源完成新鲜Linux原生、计价及完整Next/types/lint。原失败、原时间与前期fixture参数失败均保留，不改编译目标或跳过类型门。

正常保护切换退出0，6项实际main/guard启动门通过，7服务/4timer、1页公网JS同SHA、3匿名401、内外health200且发布控制器0。费率两键全字段8f4ab818…前后保持；没有本轮新生成或收费验收、手工业务行/密文迁移或权限扩大。guard841ad62a9e4b59ee8f1f903c2c67f27c745f71d7/Al_ZSWzar0oc5c7xDQE3R复用原完整产物/时间，只回程序不回DB/配置数据/媒体/账本/回执。发布前发现继承脚本仍静态断言旧18基线，已在本次新stage绑定真实19并记录前后SHA，未改原历史脚本、未线上演练恢复。

剩余边界：最近fc68b61d-5bfb-49b1-a33b-aeac1408230d日志为input409且无耐久拒绝，符合本次机制；原账号和完整原请求体尚未取得，不能冒称截图旧原号已结束。旧pending保留，只查原号，不自动关闭/回填/重发。前项VIDEO-SUBMIT01原视频页现场缺口仍保留。诊断浏览器没有取得该同事原页，不把数据快照对照冒充真实同事浏览器操作或实际出图验收。

证据：正式根docs/materials/2026-11-07-template-colleague-open/，最终attempt03；服务器stage同名attempt03。原attempt01/02失败保持，最终source/BUILD取本节实值，不取文档HEAD。本轮未新增范围外问题。
<!-- /SHARE-COLLEAGUE01-20261107 -->


<!-- SHARE-GEN21-20261107 -->
### 16.4 SHARE-GEN21 继续补齐默认提交与私密任务冻结（2026-11-07）

v20是阶段交付，默认共享模板完整生成尚不能结案。继续从真实入口追到任务冻结发现：提交/冻结消费者还有独立旧正则，拒module-source:default-*；内容key已修不代表提交已修。现抽同一纯模板ID判定供两处复用，所有访问权限仍在服务端鲜核。

新共享别名不在静态私密来源清单时，任务writer未承接已认证定义来源，合成实测Task.prompt、snapshot.moduleContext/templatePrompt会留明文。新写现从真实解读模板/恢复快照传来源；旧读按服务器冻结作者或本人无来源模块补分类，密文依旧沿AEAD绑定，不能将消费同事变成作者，个人补充保持明文。所有日期仍可关联现存加密源的267任务只读审计，动态未登记来源任务0、受影响0；不据此泛称全部历史不存在问题，不迁移原行/费用/冻结记录。

本轮实际CJS/ESM双加载复现同一模块getter不同、跨模块原快照指针丢失，导致原image-private-snapshot工程的raw/runtime断言失败；已按项目现有Symbol.for模式共享进程弱引用来源/原行/解读缓存，私密错误加不可JSON伪造的跨加载品牌，不以普通Error.code/status冒该错误。真实跨加载6组、原加密冻结与恢复4组、动态来源12组、内容ID34、普通/恢复风格22组、完整类型已通过，未放宽原始冻结断言。

已部署，待用户手动验收。实际主源bb1e2a8a52bbbd9229e215ab1c5ab23b6563b565，v0.134.21，BUILD qk3KkN_2IPMDDo88rP3HW；UTC 2026-11-07T18:22:51.005155+00:00公网核对成功，2026-11-07T18:23:20.198345+00:00健康收口。相容guard a3eb7d5187d2c90bede8039dbd9d1014da1cd9b9 / 0.134.21+sharing-guard.1 / BUILD LmuG-gXhGygd9yW5-bBSt，原完整构建时间2026-11-07T17:35:55.923969+00:00；main与guard原生/计价/Next/types/lint均独立新构建通过，guard不复用841。不含新schema/迁移/配置/媒体/费用写入，价格两键全字段8f4保持。

新证据：全库42模板ID（35模块源/6普通/1默认），34共享标记记录及41工作区来源编号，旧提交规则各拒1个默认ID，新规则拒0；此为编号协议盘点，不把is_shared当成完整生命周期权限或真实出图证明。发布6实际启动检查、7服务4timer、1公网JS同SHA和3匿名401、内外health200；两目标模板源与工作区原四字段和切换前一致。新相容guard回退入口：bash /data/video-api-debugger/release-staging/template-sharing-generation-20261107/attempt02/program-recovery.sh /data/video-api-debugger/release-staging/template-sharing-generation-20261107/attempt02/release-input.json；只回程序，不回DB/媒体/账本/回执，未实演回退。

首轮native整门拒绝是新preset-id依赖未加入聚合sources：实际子项status0/22组，聚合hash undefined被拒，其余29/30含pricing通过；补同一行登记后新main/guard全门通过，不降验证、不改原失败。初始私有材料style回执属性/陈旧hash探针错误修正并重核真实最终文件，无生产影响。原前两轮20类型构建失败仍在旧目录；21 attempt01失败及attempt02完整发布证据都保留于docs/materials/2026-11-07-template-sharing-generation/。原视频现场、截图原号归属和同事实页手验缺口仍保留，未新生成或自动关闭旧未知请求。

用户追加同类排查后，已确认API漏StudioStyleError（实际无效skill400无耐久拒绝），以及image worker5处/jimeng provider1处尚用单模块私密错误instanceof，正补统一品牌识别与隔离旧新对照，沿本原单下一节接续。来源静态迁移维护与skills局部WeakMap未见同类实际故障，未扩大改造。另登记同机CPU待核线索D-20261107-SHARED-CPU，不杀进程或冒本次模板根因。
<!-- /SHARE-GEN21-20261107 -->


<!-- SHARE-SIM22-20261107 -->
### 16.5 SHARE-SIM22 用户追加同类排查（2026-11-07）

范围沿编号→共享权限/私密来源→报价/任务冻结→worker→结果与恢复→明确拒绝回执，不扩大生成通道或价格。全库ID盘点沿§16.4原证复用；现存42模板和41工作区来源新规则拒0。shared-live、报价、持久批次的所有提交消费者均复用parseSharedStudioIntent；维护迁移中的静态名册是显式选单/未知拒绝边界，不改迁移或回写历史。skills的局部storedJson WeakMap在同模块get→save/delete闭环，未见跨模块传参故障，不类推全局化；报价/费用JSON.parse只取通道/合同，未不加区别替换为解密。

确认漏项一：parseSkillIds及fresh风格/提示词权限reader抛StudioStyleError，API expected清单遗漏，真实隔离SQLite实际API无效skill400却无耐久拒绝。两API只补该具体类，复用fresh证据事务；普通Error仅带status409仍unknown、部分受理/费用/证据读取失败仍不封原号。新增实际skill/style单张和batch具体类，原14组扩15组。

确认漏项二：image worker5处及jimeng create catch1处仍用单模块PrivatePromptError instanceof，CJS/ESM同文件错误构造器不同，会进普通故障处理。改用已通过跨加载品牌的isPrivatePromptError，保原queued/uncertain、lease/快照/费用路径及原错误对象。原18组私密工程用实际另一ESM错误＋原worker函数、真实SQLite补before-send不结算；不引入通用error.code解锁。

已部署，待用户手动验收。实际主源9a116be260a9aae51ecab18fc3c6ac8dccb01050 / v0.134.22 / BUILD a11zrypusif8s0CqQWHY8；2026-11-07T18:53:05Z公网成功，18:54:18Z健康收口。基实际21/bb1e继承全部修复，原相容guard a3eb7d5187d2c90bede8039dbd9d1014da1cd9b9 / 0.134.21+sharing-guard.1 / BUILD LmuG-gXhGygd9yW5-bBSt，保原完整构建时间2026-11-07T17:35:55.923969Z；不改原产物。读者/格式合同相容，5原写门关闭；回退只回程序，不回DB/账本/媒体/回执，guard中不冒本批错误分类已修。回退入口：bash /data/video-api-debugger/release-staging/template-sharing-similar-20261107/attempt01/program-recovery.sh /data/video-api-debugger/release-staging/template-sharing-similar-20261107/attempt01/release-input.json；未线上演练。

工程证据：15组实际SQLite/API拒绝及原号保护、18组私密保护、完整tsc退出0，正式源fresh native/pricing/Next/types/lint通过。最终旧worker负对照因实际另一ESM错误进入普通delivery/settlement保护禁区而被夹具拒绝，新worker保原queued/uncertain及费用；最初负对照缺readStudioDelivery注入的ReferenceError不冒最终证明，已用禁止普通分支的真实依赖重跑窄对照。临时目录起初在/tmp不符真实data盘，改cwd内又被密钥外置保护拒绝，均属探针误配；最终选data盘且cwd外engineering fixture根通过，保原日志，不改业务保护。

构建期间18:24:02Z及18:25:27Z两次正常管理员save，使6c9经6ce2834f更新到policy14260367-319b-41bb-bf60-7a3f98c8165c、authoring9a82ad7b-41e4-40d2-90f8-7b61a5132c26，capability f4保持。首次旧价capture在停服前拒绝，单跳history准备断言也拒绝；后只读追两条history、核current/revision/authoringAfter及成功operation一致，重绑release-input两revision和source-pair配置SHA，原配置/契约及preparation-input/构建证据保持。未写业务价格，切换前后两键SHA7d8ea02c291679e895b5c839d213afc0ac74b9bfdefcbc59888d4dbaaa541047保持。切换exit0，6实际启动门、7服务4timer、1公网JS同SHA/3匿名401、内外health200、发布控制器0；两目标源与工作区原四字段保持。

本批9应用输入，无新schema/迁移或收费生成；原截图原号归属、视频原页及同事实页手验缺口保持，不自动关闭旧未知或重发。资料docs/materials/2026-11-07-template-sharing-similar/含audit-scope.md范围表、原失败与旧新对照、配置重叠和完整发布原证；20/21原证保留。已有D-20261107-SHARED-CPU只待核，本小批未新增范围外线索。
<!-- /SHARE-SIM22-20261107 -->


<!-- TPL-OWNER-CARD02-20261107 -->
### 16.6 TPL-OWNER-CARD02 作者保存边界与全状态结果卡（2026-11-07，已授权实施）

状态：用户后续已明确“落地上线”，本节按已确认规划进入实施，另合入通用费率折叠、宽屏完整三行、共享开关常显缩小30%及失败自动核对。原规划时点为只读，不改写为当时已经授权部署。与正式根永久封面原单§17/UIH01衔接，补上其尚未覆盖的无成品分支，不重新改封面裁切。

#### 已核对的事实与架构判断

- 本轮只读采样时生产为v0.134.22，实际主源9a116be260a9aae51ecab18fc3c6ac8dccb01050；这是取证时点，不冻结后继正式版本。规划查看位置为default-template-sharing-20261105工作树，HEAD83c69aca6含该源及文档。实施前核最新运行源，不能用广告cwd的旧detached796da6作起点。
- studio.tsx的saveModule把非definitionEditable用户导向saveIntent=personal；saveSharedStudioPersonal只写其本人工作区，且禁止context/templatePrompt/isShared等原定义字段。由此可确认界面混淆了个人工作区保存和模板默认保存；截图本身不能证明越权改写了作者原模板。
- saveAsPreset又以contextEditable短路，另存按钮同样据该值禁用；服务端saveSharedStudioPresetAs/personal-quick也拒live非作者。只隐藏“保存本次设置”会使同事无合法另存路径，不能作为完整修复。
- GeneratedImageResults的hasMediaDetails/moreMenu依赖item.media；无media分支仍直接渲染metadata、primaryActions和supplement。SafeRetryStatus包含停止按钮、尝试记录及说明，所以排队/生成阶段图下重现多行。原UIH01已归位成品，不代表覆盖了等待、重试、失败等状态。
- 最小整理是分离“原定义作者”“可另存参数方案”“可读写私密原文”三种能力，并让有无成品共用同一卡片信息层。无新服务或新数据库表，不改队列、生成费用、任务状态或高清加载算法。

问题原图保留于正式根私有资料docs/materials/2026-11-07-template-owner-result-card-plan/，01保存入口、02等待卡信息；不进入公开源码。

#### A. 保存与另存的最终交互

| 身份/对象 | 保存模板默认 | 另存为 | 当前参数与生成 |
| --- | --- | --- | --- |
| 当前原模板作者，包括本人默认模板 | 显示“保存模板”，作用于本人原件 | 显示“另存为” | 正常编辑和生成 |
| 非作者，同事或管理员在普通工作台使用他人模板 | 不显示，不留灰色占位；设置弹窗、快捷键、自动持久写也遵守 | 显示“另存为”，保存自己的参数模板 | 可修改本次参数、保留草稿并生成，无须先保存 |
| 作者/来源尚未确认或撤权 | 不显示可写入口，不凭工作区owner或admin猜作者 | 来源确认后才可另存；读取异常保留输入及核对入口 | 沿真实来源状态，不伪造可用 |

- 作品使用者拥有live工作区，不因此拥有原定义。普通工作台后端由真实路由与源作者校验写权限，不接受客户端entryPoint/ownerId/role作为提权依据；管理员已有独立维护入口不并入本次普通工作台，也不新建管理后台。
- 非作者设置层称“本次生成设置”，关闭保留现有安全草稿；不再显示“保存本次设置/保存默认/保存共享模板”。原已存个人设置和旧回执保持可读，不批量清空；已受理或未知保存只核原号，不偷换为一次另存。
- 只要基础来源可用且没有原保存未知等真实阻点，即使参数尚未改动，非作者“另存为”也可用；不再用generationChanged或contextEditable控制复制资格。
- 主区非作者只留一个文字保存操作“另存为”。恢复上一次草稿另有恢复入口，不再借用“另存为”同一按钮忽然变成恢复；文件夹/重置等原有低频工具归现有设置/更多入口，正常生成主操作保持原位置。
- “另存为”跟随按钮打开短命名表单：默认名称“原名·副本”；成功后在“我的模板”可见并进入该新模板，本次主图和未提交描述留在工作现场。失败保输入；结果未知查询同一requestId，不重复建副本。普通命名操作不新增第二层确认。
- 推荐的非作者另存语义是“本人参数模板”：保存当前可用的型号、画质、尺寸、比例、数量及合法的风格选择，基础内容仍来自原模板。它不是取得原模板原文或再发布他人素材的授权；本次主图、临时参考和个人描述不并入共享定义。原私有快捷设置的合法个人内容不因此公开。
- 新条目归本人，默认私有；这属于使用者另存，不把它当成“明确新建公共原模板”来自动共享。原作者新建模板默认共享的既有规则保持。若已有原权限支持显式共享，仍须由相应来源能力控制，不能因另存自动获得。
- 不通过把原密文改绑给复制者、让浏览器回传隐藏原文、创建空白模板或去掉原作者guard来实现。复用既有PlatformSetting存储，记录版本化根来源关联及本人参数；根来源由服务器解析，副本再另存仍关联同一根来源，不累积依赖链。基础模板更新不偷偷覆盖副本已保存参数；撤回/删除/失权后停止新的基础内容使用，历史结果沿原权限保留。
- 先接根来源读取/撤权及相容消费者，再开放另存写入；新条目带真实读能力标识。恢复版本必须认识新记录，不能回到忽略根来源的旧程序，已有任务/费用快照不迁移。

#### B. 图片卡片布局：所有状态同一外框

日常场景：同事连续生成并比较多张图。常显主内容是图片/本次输入缩略图和真实进度；元信息与诊断按需，外框及下一行起点不随状态信息增加而移动。

| 状态 | 卡内常显 | 按需入口 |
| --- | --- | --- |
| 排队 | 图内简短“等待生成” | “⋯”中取消未受理排队、查看详情 |
| 生成/安全重试中 | 图内现有真实阶段、进度条与百分比 | “⋯”中停止后续重试、查看尝试记录 |
| 已完成 | 完整图片与原有图片情境工具栏 | “⋯”中详细信息、置顶及原合法操作 |
| 失败/需核对/尺寸不符 | 原内容保持；既有工具栏位置出现可点击的圆形感叹号，不出图下长说明 | 原因、实际尺寸与费用状态、核对原任务/恢复入口 |

- 图下新增信息高度为0：模板名、头像/作者、型号、分辨率、版本码、时间、排队取消、停止重试、尝试记录及恢复说明全部进入对应详情或菜单；必要信息没有删除，也不整排搬到图上遮图。
- “⋯”默认鼠标悬停或键盘聚焦才出现；菜单打开期间保持可见；触摸设备常显可点。异常提示图标在确需用户关注时可见，点击直达当前问题，不能把原因只放hover tooltip。
- 元信息复用现有“详细信息”，其中组织“基本信息/尝试记录/原任务恢复”，默认只展开与当前异常有关的区域；保完整任务号和原请求、真实费用及实际尺寸，不因删图下内容丢掉诊断能力。
- “取消排队”只作用于未受理任务；“停止后续重试”只停止后续尝试，不能声称撤销正在执行的上游任务。菜单只列当前真实可用动作，沿原API/CAS/请求与费用合同；无图时不显示不可执行的下载/发送生成原图。
- 页面翻页仍是结果区的公共导航，保留原顶/底同步分页；不跟随单张卡片信息撑高，也不改三行分页、图片比例或原有按钮命中尺寸。
- 不缩字、不裁说明、不靠display:none丢能力；将无成品分支的节点真正归位。SafeRetryStatus的数据与展开视图分开，利用现有task.safeRetry投影，不为每张折叠卡另加一套轮询。普通/喜欢/批次一致，改共用卡片时核其他直接消费者，不顺带全站改版。
- 桌面详情锚定“⋯”或异常图标，视口边缘避让；小屏必要时沿现有sheet承载。外点/Esc只关顶层，内部滚动/拖动不误关，关闭不发起保存、生成或取消，焦点回到原卡片操作。复用现有组件和图标，无新UI库或装饰动效。

#### C. 原规划实施映射与顺序（实施结果见§16.7）

1. 权限与保存语义：shared-capabilities.ts、shared-types.ts、modules.ts、shared-contract.ts、presets.ts及modules/presets API。分离author defaults/copy personal/private text能力；后端拒绝非作者新持久默认写，新增受来源授权的个人另存协议，原回执重放先于新写校验。先做相容读取与撤权，再开writer，无新表或历史回填。
2. 入口：studio.tsx的definitionEditable/contextEditable、saveModule/saveModuleSettings/saveAsPreset和两处按钮区。主区与弹窗共用同一作者能力；非作者只另存，已有本次参数/草稿/生成不被保存提醒阻断。
3. 卡片壳：GeneratedImageResults.tsx及其module.css，去掉“有media才能有详情”的结构限制；主区和batch-results.tsx将renderMetadata/renderPrimaryActions/renderSupplement映射到同一卡片工具栏、菜单和详情。ImageResultStatusDetails沿用；generation-retry/SafeRetryStatus.tsx提供紧凑动作/详情呈现，视频调用者保持原行为。
4. 批次收口：统一检查权限和无成品所有状态，必要完整类型/lint/候选构建及保护发布；仅规划阶段不跑构建、不操作浏览器、不生成图、不改生产。实际功能按项目规则由用户手验。

#### D. 验收与风险

- 普通作者、普通非作者、管理员非作者分别检查主区/设置弹窗/直接写接口；后两者没有保存默认入口，伪造原模板写入拒绝，另存只能落本人新条目。
- 同事不具备私密原文能力仍可合法另存自己的参数；DTO无隐藏原文，根来源/素材权限与撤权有效；修改副本不改变原模板、共享状态或其他同事默认值。来源更新/失权/读取失败时草稿保留，不生成空白副本。
- 同一另存响应丢失只查原回执，重复操作不多建；保存与生成不互相冒充，不调用生成/扣费。旧未知保存/生成和已受理费用合同保持。
- 排队→生成→重试→完成/失败、无media及真实尺寸不符均核图下无信息块，相邻卡片和下一行不被新增说明顶开；详细信息/取消/停止/原号核对均能由鼠标、触摸、键盘找到。
- 复用已有有效证据，只补本批权限/来源与状态投影的必要工程检查；不写镜像实现的样式测试，不把构建或规划当真实效果通过。工程检查、实际部署与用户手验分别记录。
- 主要风险是只按workspace owner隐藏按钮、另存解灰却后端拒绝、复制者借副本得到原文/绕撤权，以及仅修完成卡而遗漏无media/批次/重试。前三项靠同源服务能力与真实隔离权限用例；卡片靠完整状态设计与用户手验。
- 本轮未新增任务外缺陷；既有旧未知提交账号/正文、VIDEO-SUBMIT01原页和同机CPU待核线索不以本规划冒已完成。

本节是一份合并规划，后续实施以它为准，不拆成相互遗漏的两张工单。
<!-- /TPL-OWNER-CARD02-20261107 -->


### 16.7 TPL-OWNER-CARD02 / GALLERY03 / RATE-READ01 联合实施（2026-11-07）

**已部署，待用户手动验收。** 继承实际v0.134.24 / 74b6f09d14f6b309919cec5150c5c23939d4e379及首页限高CSS，主版本v0.134.25 / 3516a22eee160a3e5c9bcfd913a08fb51a9ba0b3 / BUILD WuPPvlzZS71IUIxEaLQ7J，公网成功于2026-11-07T21:28:52.588031+00:00，健康收口2026-11-07T21:29:31.110897+00:00。本节为§16.6原规划的后续授权实施结果，不改写当时只读事实。共享、抠图开放及20–24原成果保持，不重复迁移/配置。

1. 作者边界：原定义保存、工作区持久默认和私密原文写入均核实际原作者，旧成功回执先重放。非作者包括管理员，普通工作台只显示“另存为”；原生成参数、草稿、当前主图保持，恢复草稿独立入口。
2. 本人参数模板：复用PlatformSetting，保存版本化根来源关联及本人型号/质量/分辨率/比例/数量/合法风格，不复制私密正文、主图或个人描述。再次另存扁平关联根来源；普通库、显式应用和深链共用live来源读取，根撤回/失权即阻止新使用。本人条目仍私有，不能借副本共享原文；原作者更新不覆盖副本参数。新worker和相容guard均识别该关联，无新表/迁移或历史重写。
3. 另存原请求先保存本机元数据，响应未知只GET原回执，不换号POST；成功进入新条目，当前主图和描述仅留本次编辑现场。共享的明确未写入拒绝须服务器绑定原人/原号/原模块的证明，普通409不当作解锁证据。
4. 全状态图片卡：有无media均可打开更多/详情；metadata、取消排队、停止重试、尝试记录等不再增加图下节点。真实进度仍在图内，异常和原号核对保持可达。详情关闭不挂载重试轮询；批次、原顶/底同步分页及非compact消费者保持。
5. 模块封面启用完整三行容量计算，目录页容量放宽到120以容纳宽屏；独立素材选择器12–24合同不改。共享开关常驻，视觉缩小30%，44px命中区域保持。目录/封面和原共享回执有限三轮读取，联网恢复再核对，不自动重发共享写操作或生成。
6. 通用积分规则默认折叠，展开才GET现有管理员费率快照，按通道/规格显示真实开关状态与价格；启停/改价仍在/admin/pricing。切账号/关闭取消读取，回到标签时鲜读；旧存储、费用合同和现价不迁移、不回写。

工程检查：主/guard分别通过6组实际隔离SQLite来源/权限/另存/撤权用例、13组真实共享hook用例、作者/封面纯合同检查、fresh原生30组与计价检查，以及完整Next构建内含types/lint。最终精确源作用于Linux候选，Mac完整类型和聚焦lint也通过；无浏览器功能验收或本轮收费生成。最初Mac共享schema engine失败、离线夹具漏纯依赖/转导出、Next保留变量名、隔离lint缓存权限原失败均保留；只修对应源/夹具或使用原lint的no-cache方式，不弱化发布门、不写生产DB。最终attempt05在同一精确源接续构建，build-resume退出0。

发布检查：6实际启动门、7服务/4timer、3匿名401、内外health200，模板页33个manifest资源逐个公网200且SHA一致，后台8个设置reader（含parameter-copy.ts）回执同源、同SHA且有效。首页限高CSS SHA 8a36cfd2a81fa3fc8fb05da12f24262c3fb1427c02e305558515e839d818614f保持。两费率配置全字段SHA7d8ea02c291679e895b5c839d213afc0ac74b9bfdefcbc59888d4dbaaa541047前后相同，policy14260367、authoring9a82ad7b、capability f4a48550保持；原.env/数据链接、私密策略、rollout代码不改。原writer自然停尽、一致SQLite备份后仅切程序，未执行DDL或覆盖数据。

相容回退：2005447688dab260b0af38aded7f966f5c269762 / 0.134.25+template-reader-guard.1 / BUILD ymCCwzq0anLlN0zkh5tbq，新来源reader与主源一致，关闭既有五写门，保正常反馈提交。入口：bash /data/video-api-debugger/release-staging/template-owner-card-20261107/attempt05/program-recovery.sh /data/video-api-debugger/release-staging/template-owner-card-20261107/attempt05/release-input.json。仅回程序，不回DB/账本/媒体/原件/回执，未在线演练；新副本不可退回不识别来源的旧21guard。

待用户手验：本人/同事/管理员非作者的保存与另存，副本来源撤回，全状态卡片图下零增高，宽屏完整三行/常驻小开关/断线核对，以及通用积分折叠与费率页跳转。工单与固定todo、Git提交推送、服务发布分别有证；构建和健康不冒功能验收。

原fc68b61d-5bfb-49b1-a33b-aeac1408230d未知提交、VIDEO-SUBMIT01原页缺证及D-20261107-SHARED-CPU待核保持，不自动结束旧请求、重发或回写费用。本轮未新增范围外缺陷。完整资料及失败记录见docs/materials/2026-11-07-template-owner-card/，最终attempt05；额外只读探针最初误写协议常量，后从实际源码读取并通过，原误配保留，不作为业务故障。


### 16.8 PIN-CONSIST01 / WORKS-WIDE02 置顶全链路与广场宽屏规则（2026-11-07）

状态：**已部署，待用户手动验收。** 实际主版本v0.134.26 / e730b7334f224d8d07e41d686311b10d73b97584 / BUILD NXJFuymZl8lJq1A317gfm，发布时间2026-11-07 19:10:20 PST（原证UTC：2026-11-08T03:10:20.199027+00:00），健康收口2026-11-08T03:11:00.859069+00:00。继承已发布v25/3516全部成果；本节沿原合并单落地，不改写前节历史、原未知请求或手验边界。

兼容分支取证与统计纠正：默认模板列表容许本人module_id=null旧任务，原pin读写却要求物理编号相等；合法作品复用历史也存在列表与pin范围不一致。两类代码差异已由隔离SQLite验证。最初把线上42个null模块成功输出当作普通旧图受影响，口径错误：按业务排除规则复核，实为20头像+22角色工具，普通模板为0；不能宣称42张受影响或已恢复。生产确有3个作品复用草稿，关联原publisher的14/36张成功结果，其中8/33张无source；这些是机制取证，不把它们冒图1原号或全部受影响数量。原403把归属/来源/素材保护混为一条。

近期原始样本口径：goukiyang14张、杨波24张，共38张成功输出；其中12张null模块属于独立工具，不是普通模板受影响样本。其余26张资产active、归属一致，未命中已知来源冲突/固定或系统参考保护。该近期组不包含图1的10月12日旧任务，不能据此排除截图问题。原证保留，正确排除口径见ordinary-default-cohort.json。

修法：空模块仅规范为该任务owner的default；沿真实studioMethodHistoryModuleId、publisher及root绑定认合法历史，不按名称猜模板。作者旧无source只认实际publisher，其他同事无来源仍拒；任务源冲突、私密参考、头像/角色工具、他人结果、旧原号/版本CAS保护保持。新pin保存任务实际模块的规范值，读/写/本人按钮资格共用；普通/喜欢页资格原因由服务端按本人任务投影，null可清旧原因；已经置顶仍可取消本人失效输出，不删广场条目。无旧行回写、DB迁移、生产自动置顶或收费生成。须构建支持新默认pin的相容guard。

界面规则：作品浏览列表解除本组件1920居中限宽，详情保原约束，工具栏与作品网格同宽。列数=max(原断点最少列数,ceil((容器宽+间距)/(370+间距)))；列宽=(容器宽-(列数-1)*间距)/列数。宽屏增列，窄屏保持原密度或缩小，不靠放大/裁剪/拉伸填边。缩略图object-fit:scale-down，保持比例与完整图；内容不足一行自然左对齐，不复制图或放大补空。沿用TanStack已有多列虚拟化、稳定key、焦点/滚动位置恢复，无新图库依赖。图2信息按钮桌面hover/focus或已打开时显示；触摸常显，原详情/操作权限不改。

行业依据：读Flickr justified-layout的index/row实际实现（https://github.com/flickr/justified-layout），它按容器与比例计算行几何；结合当前纵向瀑布流任务，选择保留已用TanStack lanes/gap（https://tanstack.com/virtual/latest/docs/api/virtualizer），避免更换布局引擎。scale-down语义以MDN（https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/object-fit）核实。借鉴规则不冒已完成实页效果验证。

工程检查：最终attempt03，主/guard各通过6组真实隔离SQLite（默认空模块、复用历史、原号重放、同事feed/媒体授权解析、来源/私密/头像拒绝、隐藏后取消及CAS）、9组真实按钮工程、fresh原生30组及计价、完整Next构建内含types/lint。真实HTTP媒体文件和页面效果仍待手验，未用模拟数据或编译冒效果。最初本地夹具两处TS调用/目标写法及一次原号断言放错阶段已修并保原失败；attempt01会话缺飞书身份，attempt02遗漏explicitSelection=true，均保真实保护拒绝。已读全部相关入口约定后只修夹具，补非授权邮箱及自动恢复不创建的负对照；未放宽业务/发布保护。attempt01/02未进入native/Next或生产切换。

发布检查：6实际启动门、7服务4timer、内外health200、2页面JS与3匿名401。额外核首页/模板页/Works动态清单共40个公网资源均同SHA，已通过的2个叶JS复用原证；置顶匿名PUT返回401，不进入写入。后台8个设置reader同源且有效，首页原限高CSS SHA8a36cfd2a81fa3fc8fb05da12f24262c3fb1427c02e305558515e839d818614f保持。两费率配置全字段SHA7d8ea02c291679e895b5c839d213afc0ac74b9bfdefcbc59888d4dbaaa541047前后相同，policy14260367/authoring9a82ad7b/capability f4a48550保持；环境/数据链接、私密策略和rollout代码不改。原writer自然停尽、一致SQLite备份后仅切程序，无DDL、历史回填、生产自动置顶或本轮收费生成。

相容回退：554ab5eb2a1fa60cc6fdd22e76d1dfe6190b3caa / 0.134.26+pin-reader-guard.1 / BUILD xqwYjnesnV5QbgJjO80dK，新pin规范归属及参数副本reader保持；既有五写门关闭、正常反馈提交保持。入口：bash /data/video-api-debugger/release-staging/pin-wide-gallery-20261107/attempt03/program-recovery.sh /data/video-api-debugger/release-staging/pin-wide-gallery-20261107/attempt03/release-input.json。仅回程序，不回DB/账本/媒体/原件/回执，未在线演练；不可回忽略默认空模块pin或参数副本来源的旧reader。

待用户手验：图1具体原图置顶/取消和刷新后排序、同事可见性；图2鼠标hover/键盘焦点/触摸入口；图3大屏铺满且单图不放大，缩放窗口/折叠侧栏保焦点和工作位置。直接消费者已核WorkMedia只用于广场和相关推荐缩略图，不改详情主图/高清/原件。主源与guard及原记录均已提交推送，收口文档提交不冒运行源。旧fc68未知请求、VIDEO-SUBMIT01原页缺证及CPU待核保持；本轮未新增范围外缺陷。最终证据见docs/materials/2026-11-07-pin-wide-gallery/attempt03，原失败保留。


#### 16.8.1 截图原号与历史复现来源纠正（2026-11-07，v27已部署）

已用截图可见边缘和1219个本人相关资产缩略图做有界只读匹配，并目视确认：图1为任务9ecf6e6bf2c78367a301573a6a464ca3181d3b508a5e053c092366d9d95c767e-0。实际执行工作区baaadf18-e6ae-4728-a136-8375b6e9a7b5，名称“9宫格剧照”，当前源34111a20-e8b9-41a4-a425-4ef086201bed；任务与冻结快照sourcePresetId=fbcbe5cd-663d-49f9-807c-d6d47626df5e（“表情”），快照另有reproducedFromTaskId=bd40228386ccb8727d124edd301e746ad5a64607cd54d57256f7ce0a214ac80d-0。快照moduleId/moduleName/moduleRevision与本次执行工作区相符；不是42个null模块的情况。原浏览器PUT正文未采到，不冒实际点击验收。

共同原因：合法历史复现按tasks.ts保留旧配方source，同时记录新执行workspace；列表按执行工作区显示，pin读/写/资格却把任何source差异都当成跨模板，从而错拒。v26把原因说清且修了两类兼容分支，但尚未修到这张真实截图的复现分支。本次保持原source、快照、费用和原号不变，只在可信冻结version/moduleId/sourcePresetId相符且有合法非自身原复现taskId时承认本次工作区归属。任意来源冲突、他人/其他工作区、私密底层文件仍拒；沿现有共享root、事务CAS及原号重放。读出只为来源不同的既有pin批量读取复现证明，不把snapshot返回给同事，也不增加普通pin的快照读取或逐卡查父任务。

工程：Linux原26源码先在独立临时SQLite中重现同类“来自其他模板”错拒；Mac首次尝试停在本地Prisma schema engine，未到业务断言，不计有效红测试。最终主/guard各9组真实隔离SQLite、9组按钮工程、fresh原生及计价、完整Next构建内含types/lint全部通过；补与截图相同的旧命名工作区/无publisher绑定情况，验证原号重放、同事仅输出投影、原source/快照不改、私密撤权、任意跨工作区与伪复现拒绝。实际9ecf任务已捕获元数据的纯资格函数对照：26报来自其他模板，27为null（合法）；该对照未连接生产库、不是生产PUT或浏览器验收，未仪表计数的查询/网络数字已从材料中移除。

最终发布：**已部署，待用户手动验收。** 实际主源d0c1b31693125ddb9f37d70e323fdf01e3cc9040 / v0.134.27 / BUILD cqHwJ1BrxECXfOkCNFins。2026-11-08T04:42:33Z启动，04:42:41.844300Z公网收口（洛杉矶11-07 20:42）；继承v26全部广场全宽/缩略图上限/hover成果，只补历史复现的共同资格判据。最终stage为pin-reproduction-20261107/attempt03，cutover-exit=0；6实际启动检查、7服务4timer、内外health200、2公网叶JS同SHA及3匿名401通过，追加置顶匿名PUT401。后台实际source为d0c1，44个加载文件全匹配，其中正式设置子集8个，租约有效；最初收尾探针把整个44项map误当只应有8项，属于计数断言错误，按代码定义子集核对后通过，未改应用。两费率行全字段SHA7d8ea02c291679e895b5c839d213afc0ac74b9bfdefcbc59888d4dbaaa541047、policy14260367/authoring9a82ad7b/capability f4a48550保持；首页限高CSS原SHA8a36cfd2a81fa3fc8fb05da12f24262c3fb1427c02e305558515e839d818614f保持。原writer自然停尽、一致SQLite备份，仅切程序，无DDL/历史回写/数据恢复/生产pin或收费生成。

构建复用与原失败：attempt01新增命名工作区夹具用了非UUID，被真实API正确400，改夹具用randomUUID，未放宽保护；该次未native/Next/切版。attempt02主/guard完整构建分别完成于04:23:33.393592Z / 04:35:20.041683Z；首次切版缺少原helper的运行链接--prepare，断在停服前（无cutover-started），七服务仍26，不冒生产事故或应用失败。最终attempt03保留并复用这两份原构建、native与实际完成时刻，补原有链接准备并两次验证，不重编；source-pair和build-reuse.json明确复用来源，02失败原证保留。未修改发布核心、原配置/权限校验或旧成功包。

相容回退：c5768159621d8bf23becbade3828b289dc13ed21 / 0.134.27+pin-reproduction-guard.1 / BUILD phBaNJOYNUJyPtNdI9bVE，保本次合法复现pin读者、默认归属及参数副本读者，关闭既有五写门，正常反馈提交保持。入口：bash /data/video-api-debugger/release-staging/pin-reproduction-20261107/attempt03/program-recovery.sh /data/video-api-debugger/release-staging/pin-reproduction-20261107/attempt03/release-input.json。仅回程序，不回DB/媒体/账本/回执；未线上演练。不能使用会过滤新复现pin的旧26 reader作相容回退。

手验仍含：原9宫格结果置顶/取消/刷新及同事可见性；图2的hover、键盘焦点和触摸入口；图3超宽屏、侧栏伸缩时两侧铺满、单卡不超过370px且图像只缩小。应用主/guard已聚焦提交推送，收口文档HEAD不是运行源。新范围外线索仅D-20261107-PIN-MEDIA-SCOPE：单图媒体鉴权会读取整组置顶，增长开销待测，不当当前403根因，不顺手扩改；旧fc68未知、VIDEO-SUBMIT01原页缺证、CPU待核保持。


证据沿同一材料目录match/screenshot-match-proof.json、image-match-scores.json、screenshot-match.webp；三份用户原附件按原文件名保留于attachments。匹配只读缩略图，不处理或替换原件；原截图已与资产缩略图目视对应，数字边缘分数仅用于找候选。此前误记受影响数量的两处正文及固定todo已纠正，原查询日志保留，不改历史失败。


#### 16.8.2 置顶未闭环边界复核（2026-11-07，仅诊断登记）

用户追问上一轮是否遗漏结构问题；本节如实补足未在简报展开的边界，不把v27特定截图修复扩大成全部置顶/共享问题解决。只读鲜核生产仍为0.134.27，result-pins.ts与本地SHA4bb02794df5a97f3cd79cb38ef0f669ac254e8943e9a836f50e10d4662778862一致。未修改应用源码、生产记录、权限或价格，未重跑已通过检查或浏览器功能验收。

1. **已确认遗留：6条无来源旧结果。** 9宫格原工作区另有6条succeeded且asset active的记录，任务source与冻结source均null；冻结module均匹配本工作区，4条无复现父号、2条有同一原复现父号。当前源34111的publisher绑定不存在，因此按当前source-null/non-publisher规则仍不满足置顶条件。尚未证明它们全部应允许共享，不据此补造来源或批量放开。原始最小元数据见remaining-boundaries-20261107.json；“原始null模块42条”是另外一组已纠正工具样本，不能混计。后续先核旧共享/发布者关联及可信冻结执行归属，再决定兼容修法。
2. **已证机制，现场发生待核：发布记录与实际可见性不同。** readableStudioPins按资产状态、模板共享/归档及私密文件权限过滤，并只返回可见投影；管理员与普通同事的私密访问范围不同。既有9组夹具已验证把置顶图随后设为私密参考会让同事读不到。当前UI没有向本人完整投影被过滤的原因，所以“已记录置顶”不等于“同事当前可见”，失效记录的取消管理也需补核。保留权限保护，补本人状态/原因，不以放开私密访问消除差异。
3. **已确认设计，发生频率未测：冲突范围为整组。** 同一共享root的pin列表和原号回执放在同一文档，CAS比较整组revision；两人从同一版本操作不同图片，后提交者也会因版本变化被409拒绝。结果feed的epoch同样包含该revision，别人置顶会使旧分页游标失效。现有CAS有必要；待验证能否保显式目标/原号与顺序一致，同时减少无关操作需要用户刷新重试的情况，不直接删并发保护。
4. **已见恢复边界，体验待验：置顶待确认只存内存。** 原操作体保存在模块级Map，组件内重试可保原号；整页刷新后该Map丢失，但仍能重新读取服务器当前置顶状态。不能据此认定置顶记录丢失或发生重复操作；跨刷新提示与原操作接续尚未闭环验证。置顶不生成、不扣费，不泛化为生成任务的费用恢复问题。
5. **既有性能线索继续待测。** 单张媒体会读取整组pin；列表读取还在前后各核一次可见集合，私密保护可能读取完整参考绑定。新广场变宽会增加同屏图数，不过已有虚拟化、lazy缩略图，不把这些机制直接说成已发生卡顿或按比例计算性能收益。沿D-20261107-PIN-MEDIA-SCOPE另做同口径规模测试，再定向优化，当前不新增缓存、表或服务。

架构判断：执行工作区、历史配方来源与显式发布目标仍有历史复用语义交叉；v27只消除了有冻结复现证明的错误拒绝。后续优先核6条旧图与本人/同事可见状态，再补正常并发及断网恢复，最后量化规模成本；识别逻辑可集中，写入权限与读者可见性按各自职责保留，不做万能校验器、历史批量改写或全站重构。以上为已登记遗留/风险，不冒已修复。

#### 16.8.3 五项架构疑点取证结论（2026-11-07，仅排查；未修改应用）

用户要求把上一轮怀疑查清。基线为生产v0.134.29、source `2266d7d8098acf531a87940929fb6263a9876444`、BUILD `q6NJi504KhO7IJgAleb9f`；本次涉及的12个后端/前端源文件与本工作分支SHA逐一相同。沿用v26/v27已通过检查，只补新疑点。CodeGraph本次工作树同步180秒超时，改用定向源码和真实调用链，不把失败写成工具已用成功。原证与两个可复跑隔离探针统一在正式根私有材料 `docs/materials/2026-11-07-pin-wide-gallery/architecture-audit-20261107/`。

| 疑点 | 核实结论与根因 | 影响和处理边界 |
| --- | --- | --- |
| 工作区、配方来源、共享目标混同 | **现代绑定稳定，旧记录兼容缺口成立。** bindStudioModule禁止已有publisher/live绑定换root/mode；openShared不会按名字猜旧工作区。生产6条source为空的旧图全部生成于10月1日及10月4日12:42Z以前，而当前9宫格共享源创建于10月4日14:34:12Z；原冻结名称先为“未命名模块”/“表情”，当时尚无今日共享源。当前publisher、binding、reproduction关联均不存在。隔离复现同形记录仍403，原图保持active。 | 这是旧结果早于发布源、随后工作区复用/改名形成的谱系边界；不能回写今天的source冒历史事实。执行工作区、历史配方来源、显式发布目标应分别判断。6条是否应发布需可信执行/本人发布关联，不据现名批量放行。v27只修有冻结复现证明的另一张截图，没有覆盖这6条。 |
| 置顶记录存在但同事看不到 | **确认投影/操作状态缺口，权限过滤本身正确。** 同一隔离置顶记录后被用作私密参考，管理员仍见、普通同事被过滤，存储记录保留。补测普通生成者自己的图：stored=1、visible=0；后端显式active=false仍可取消成功，但按钮active取可见assetIds，当前客户端无法由此知道它仍已置顶。 | 读者可见集合不能同时充当本人已发布管理状态。最小修法是给本人返回独立已记录状态及不公开原因，取消入口沿原owner校验；不向同事返回私密引用或快照，不放开原图/参考权限。生产当次仅3条置顶，同ID私密重合0，未证明现场已发生此例。 |
| 任务、费用、预览、共享状态是否全混在一起 | **大范围判断被源码反证。** ImageStudioTask执行和billing字段独立；完整尺寸不符结果可独立交付；Work有previewStatus/discoverable/withdrawn/audience；共享有objectKind/lifecycle/sharing/dependency、reasonCode与各操作capabilities。 | 不做全系统状态重写。具体缺陷是置顶可见投影丢了不可见原因、本人操作状态，与上项合并修，不能把所有“成功”当成同一个含义。 |
| 新旧入口是否暗中走不同逻辑 | **有明确分流，不能一律删除兼容。** 模板sharedLive发送共享intent/个人覆盖，恢复设置走restoredSettings；非shared/非restored入口才可发送旧reproduceFromTaskId。旧任务执行逻辑保留历史recipe来源，可为null；现代shared/restored使用独立已解析定义。29角色工作台关闭提示词弹窗/布局协议适配已在其他线程修复并部署，不重复列作未修问题。 | 保历史冻结和既有可达入口；只在入口边界统一执行/配方/发布语义及状态投影，不建立一个万能校验函数，不借诊断改角色工作台。 |
| 并发、恢复和读取规模 | **整组CAS是现有设计，分页恢复存在实际缺陷。** 两用户从同revision置顶不同图，隔离运行一成功一409。任一置顶使旧feed epoch失效；原游标连续重试两次409，新读成功。普通列表onRetry仍用taskRetryCursor，且已翻页后silent成功不更换nextCursor。喜欢列表刷新虽不带cursor，但pageReads>1时仍保旧nextCursor，因此后续“更多”仍可能再次409。另有单图整组/全局读取成本，见下表。 | 不删CAS或忽略epoch。优先对目录失效单独重建第一页/分页边界，保现有图片、账号/模块和筛选；普通网络故障仍原请求重试，不把所有409重置。置顶未知原号仅存模块Map，整页刷新会丢接续提示，服务器记录不因此消失；未证明丢图或重复写。生产并发频率未测。 |

**规模与故障范围的补证。** 在同服务器独立临时SQLite、生产29原源码下顺序低优先级运行，每组预热1次后7次，共6组42个计时样本；测的是单个asset服务函数鉴权，不含HTTP、下载、解码/上屏，也不是多人容量压测。

| 同root置顶数 | 无关私密绑定数 | 查询数/次 | Prisma返回行/次 | p50 / 最大耗时（ms） |
| --- | --- | --- | --- | --- |
| 1 | 0 | 10 | 6 | 5.63 / 9.63 |
| 50 | 0 | 10 | 104 | 6.74 / 7.37 |
| 200 | 0 | 10 | 404 | 10.96 / 14.14 |
| 1 | 1000 | 11 | 2006 | 29.98 / 40.34 |
| 50 | 1000 | 11 | 2104 | 32.87 / 51.21 |
| 200 | 1000 | 11 | 2404 | 42.61 / 52.66 |

返回行由Prisma middleware实录，不是数据库内部扫描行；用时含同机负载，不能按比例外推人数或性能提升。确定机制是单图resolve先走asset索引却再核整组pins；readableStudioPins又不带asset范围读取全局绑定，列表前后还各读一次。生产2026-11-08T07:02:21Z的只读快照：3个文档、总3条pin、最大2；相关绑定77行（60 fixed＋14 style＋3历史复现），另9个metadata子记录按正式reader排除；23个引用/20个独立asset；格式异常0。当前规模不支持“容量已耗尽”的说法。后续优先让单图沿原索引定向查目标任务/资产，再复用既有权限投影；不先建缓存、队列、表或换服务，短路不得跳过root撤权、文件别名和私密保护。

**新确认的故障放大风险。** 人工只在隔离DB加入1行与两个模板都无关的旧/不兼容私密引用（references=null），两个模板的同事媒体及普通feed均抛“参考内容权限记录无效”，管理员读仍成功。原因是普通读者/发布写入的全局绑定扫描先统一parse，坏行导致全请求失败；定向catalog SQL路径也有全局兼容检查并回退，不能只传assetIds就声称已解决。不跳过坏行来放开未知私密文件。生产同类坏行0，因此这是有复现的故障范围风险，不是本次线上根因，现不增加理论兜底。

**先后顺序与闭环。** 第一批先局部修普通/喜欢列表的失效游标恢复；第二批补本人已发布管理状态与过滤原因，并沿可信证据界定旧结果显式发布；第三批按实际增长缩小单图权限读取范围。整组CAS保持，正常不同图冲突的自动重基必须先证明原号/显式目标与顺序不被改变；跨刷新未知接续另按同一恢复边界补，不能顺便改变生成/费用合同。全局不兼容行风险保留失败关闭，遇真实记录按原owner/版本修对应记录和writer兼容，不批量改历史。

本轮只完成排查与工程隔离验证，应用源码/生产DB/权限/价格未修改，无新生成、浏览器功能验收、构建或部署。探针网络调用0、CreditLedger0，所有合成DB在finally清除；服务器只保诊断脚本与日志。前述修法为待实施，已部署v27修复和用户手验状态不变。原未知fc68、视频原页缺证、同机CPU及旧报表线索不因此关闭。


#### 16.8.4 PIN-RECOVERY01 / DELETE-FAST01（2026-11-08，已部署135.4，待用户手验）

用户“开改”并追加查缺补漏/风险/闭环及个人工作区删除反馈。原三步继续，删除作为同批必要配套；不拆新工单。候选在codex/pin-recovery-20261108，真实路径`/Volumes/Data/Projects/video-api-debugger-worktrees/pin-recovery-20261108`；已完整继承当前135.0/9b2ecc及此前31角色、30上传修复。3号明确交下一135.1发布窗，本批不修改其费率/模型开关，后续按实际正式源接续。

1. **目录恢复。** feed目录变化独立code=studio-directory-changed、只读directoryVersion；普通/喜欢共用一次有界GET恢复，清旧重试游标并更新当前目录边界。网络、其它409、Abort不重置。保账号/模块/筛选与合法结果；撤权结果按鲜读eligible集合移除，不保留越权旧图。共享撤回后本人历史可读，不因“无共享可见记录”反复409。
2. **本人管理。** 存储事实ownAssetIds与当前可见assetIds独立；按需“我的置顶”才展开本人状态/原因/合法缩略图，不在每次poll分页搬运200条详情。自己已发布的取消独立于模板仍共享、原工作区仍存在或图片可见；事务只允许现存本人task/asset记录、原revision/CAS和原号回执。GET按原指纹核对；本机仅持久化原目标/意图/版本/号，恢复只GET，显式点击才重试原body，缺回执仍unknown。
3. **旧图与读范围。** source=null旧图仅在当前目标作者拥有工作区和输出、服务器冻结v1执行module/source/moduleRevision有效时允许现在显式发布；不按名字或现有指针回写过去来源。单图沿原asset索引只查询目标task/asset；私密SQL按目标original/thumbnail两类文件别名核对，NULL公共受众也走同一严格投影；不兼容记录仍回退失败关闭。原Pin文档v1/六字段指纹/200上限与128回执不变，无新表、迁移或公共权限扩大。
4. **个人工作区快速删除。** 删除的是配置，已受理任务依赖冻结快照，不能因此等待其provider结果；仅个人删除允许这些task继续，原模板/分组删除的强限制不变。未受理批次、未知本机提交/保存、owner/default/CAS及永久删除ID保护保留；任务/媒体/账本/费用不改。确认缩为一段，错误留当前操作，恢复入口缩到标题栏按需展开，不再在页面下方堆墙。真正回执缺失仍只自动GET；用户明确点“继续原删除”并确认后，沿原id/revision/requestId执行同一操作，不采用界面的新配置版本、不换号、不自动重发；之后鲜读原回执/current，避免把后来恢复的模板当仍已删除。

**工程证据与缺口。** 179f隔离harness verify01：后端15组（含旧图、撤回/私密本人取消、工作区消失后的原回执、单图200pin＋1000私密绑定、别名、坏记录、运行任务删除/晚到保存/未受理批次），client05七组实际helper/真实删除hook调度检查，完整tsc02退出0。首次后端fixture01的最后late-save用例遗漏合法save字段，先400未到期望409；已修测试输入而非降低保护，02通过。client04用了同步前的删除hook，仍只查不继续，故0次确认与期望1不同；同步真实当前hook后05七组通过，原失败保留。15组原证早于最后的轻量投影/源撤回一致性及显式继续补测；最终冻结源还须再跑这两份聚焦脚本及原全native/Next，不把旧证冒最新源全通过。

隔离样本单图7次p50约36.99ms、Prisma返回6行；删除一次15.27ms。这里只是同机临时SQLite服务函数，不是生产HTTP、页面秒开/秒删、并发容量或百分比提速证据，不外推。未自动浏览器验收、真实生成、生产删除或配置写。最终功能由用户手动验收。

**本次恢复准备差量。** 复用当前135.0已完成stage发现program-recovery.sh仍绑定更早pin-wide-gallery批次和3516基线，事故时会在恢复停服前断言拒绝。新批需把自己的stage/9b2ecc基线锚点写正确并只读校验F0/contract/配置入口；原发布者已内部告知。只回程序，不回DB/媒体/账本/回执，不能把cutover0当恢复入口正确。见D-20261108-RELEASE-RECOVERY-ANCHOR；尚未演练真实回退。

**当前交付状态。** 代码已实现，集成与版本135.1已准备；构建、部署、公网/健康及实际手验仍待本节后续运行回执。既有F0全构建仅按相同source/1469编译字节和原完成时间复用；不重标时间、不回数据。旧fc68/视频原页缺证/CPU/其它报表发现不随本批关闭。

**发布接续2026-11-08。** 原135.1/e2849完整构建于10:21:51Z成功、22组聚焦/完整类型及原native通过但未切版。接续时正式源已为135.3/cbaf239、BUILD VFqcM3XS-0vUU6QIqpZ0a；完整合并该源，保角色布局/已选标记，下一候选135.4。旧构建证据保留，不改写成已部署；新stage attempt02继承实际135.3，只补新源构建与部署证据。

**最终发布闭环（UTC 2026-11-08）。** 实际发布源`38fc52f1a8497046578ceeb2bf37be40019c94b0`，v0.135.4，BUILD `tbnrYXNkjO59pkM8oPhi3`；完整继承135.3角色预览修复，25文件差量，不改pricing/provider/角色源码或schema/migrations。独立stage为`/data/video-api-debugger/release-staging/pin-recovery-20261108/attempt02`，run `478a1abb-626d-4b56-ab26-fe6975516964`。11:44:14.742590Z最终Next完整成功（含types/lint）；实际22组聚焦、独立全tsc及原16组native/计价门成功。已有非阻断CSS/React lint提示保留，不冒零告警。

11:45:02Z开始正常切版，11:45:27Z公网证据完成，11:45:54Z健康收口：7服务实际cwd/main PID同源、4timer active、main/F0六启动检查、模板/图片页两实际chunk200且SHA同源、3匿名GET401及置顶PUT/工作区DELETE匿名401通过；控制器0、cutover0，无恢复。数据库一致备份仅留服务器0600，环境/数据链接保持，价格全字段SHA仍d03c539d…，private policy字节保持；没有真实生成、生产删除、账本/历史/快照覆盖或自动功能验收。

F0兼容guard source `f0fc87f9896daa685c1067bb341e85ee21933a9a`、BUILD `_JwQu0Zzx5P5dk89dyQd9`，逐一核原源码与1469编译文件，复用原2026-11-08T05:29:46.672838Z成功构建，非重新构建或重标时间。新恢复脚本锚点为本attempt02及实际135.3/cbaf239基线；切版后真实marker/备份/contract齐备时，执行其第一段只读前置成功（11:45Z），没有执行后面的停服、repoint或数据恢复。原135.0及角色31脚本由原作者分别修其自己的锚点；本次未演练实际回退。

**效果证据边界及残留。** 最新冻结源合成库单图200pin＋1000绑定七样本：每次目标任务/Asset各1行，Prisma总返回6行；删除服务函数约31.08ms。它们不含生产HTTP/网络/浏览器上屏，不据此宣布稳定秒删或百分比提速。原全局不兼容引用探测和整组CAS仍保留，坏行依旧失败关闭；不同图同时置顶可能真实409，用户鲜读后主动重试，不自动重基或把未知当失败。旧6张图仅提供有可信冻结执行的显式发布路径，未批量共享或改历史归属。fc68、视频原页缺证、同机CPU、旧报表等任务不随本批关闭。

**用户手验。** ①有已受理生成时删除个人工作区：一次简短确认后移除配置，已有图/历史/在途任务保留；②断网或旧待确认：只出现标题栏小提示，刷新只核原回执，明确继续仍原号/原版本，不删除新版本；③置顶变动后的普通/喜欢翻页恢复且编辑输入保留；④在“我的置顶”查看本人不可共享原因并取消，权限和同事私密读取保持；⑤可信旧图主动置顶，不按现名批量放行。以上待手验，工程/发布成功不替代功能验收。

原始工程、发布、公网与只读恢复证据已按白名单存正式根私有`docs/materials/2026-11-07-pin-wide-gallery/recovery-20261108/`（本地忽略、0700）。135.1成功但未部署证据单独保留，首错fixture01/client04及修正边界仍保留；未下载DB备份、配置快照、价格全字段正文、凭据或用户媒体。后继已交还发布窗并告知从实际38fc52f源继承；本轮只做记录收口，不再改运行源。


### 16.9 NAMED-SETTINGS01 同模板另存设置（2026-11-08，实施完成待发布）

用户明确：生成区底部“另存为”保存同一模板下的多套不同设置，不是另建模板。135.4实发原入口作者默认勾共享，走saveSharedStudioPresetAs新建publisher工作区；非作者走personal-parameters并openShared新工作区。旧personal-quick仍创建ImageStudioPreset，且未绑定工作区会改source与共享意图，不能仅把checkbox去掉或改文案冒修复。

**架构与实施。** 模板定义、个人当前输入和命名设置分别保留职责。新`studio_named_settings_v1:{owner}:{module}:{request}`复用PlatformSetting，不建表，不创建ImageStudioPreset或工作区，不回写source/共享/default。只保存本次模型/画质/分辨率/张数/比例、补充、风格ID和临时参考；原件主图、上下文、固定参考、共享定义、项目/供应商/价格不随方案复制。作者与非作者共用“另存为设置”命名入口，下方轻量方案按钮切换，保持当前主图；改变默认/模板正文仍显式点原保存入口。已有快捷模板/历史另存不删除；旧parameter-copy待确认只读原回执，不重建、不带当前编辑跳到另一模板。

保存按账号/模块隔离并持久保留原命令，UUID与归一化body指纹在同一事务落记录。恢复与刷新只GET，明确继续才沿原号/原body发送；只有业务拒绝且鲜读原记录确不存在时才解锁，网络/DB/空查询不冒失败。列表按当前owner/module前缀读取名称与值，按需应用才重核来源/风格/临时参考，避免每次列表全量素材解析。作者显式套用方案时可采用本次纯风格选择；普通未保存上下文/固定定义依旧不能绕保存使用。报价和创建仍同一个parse/normalize路径，冻结任务/费用及worker记录格式保持；新命名空间由旧reader忽略，F0回程序不回数据。

**已验证与首错保留。** 同服务器独立verify01合成SQLite fixture05通过12项（作者/非作者不增模板/工作区、源默认不变、账号/模块隔离、原号幂等/状态、篡改同号拒绝、版本冲突确未应用、多个方案、临时参考失效、模板风格使用、作者纯风格且定义保护、撤回来源、task/ledger/network为0）。当前实现未做生产写或浏览器验收。首次Mac schema engine在建临时库阶段非零、无功能断言；local tsc01仅quality字符串类型不匹配，已按受校验模型质量类型修正。Linux fixture02用他人的default ID查询，正确400而测试误期望not-found；03给共享源注入私人风格使源本身依现规则不可用，改为有效shared风格；04另一个纯parse用例遗漏原requestId，补齐真实请求合同。均保原失败日志，未放宽保护或改业务数据；复查了调用方合同后05完整通过，未将夹具输入错误写成生产根因。

当前分支codex/template-named-settings-20261108，实际工作目录沿pin-recovery工作树，初始a81完整保135.4修复，并完整合入实际135.6/7c63角色更新。待135.7完整构建/发布，功能继续用户手动验收；不因12项隔离检查冒真实网页完成。
