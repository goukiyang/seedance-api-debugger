# UIUX ART 下载与 SD2 API 接入评估

日期：2026-11-22。当前状态：支线实施与主流程证据保留；本次定向回归补验确认5项未修复缺陷（2项P1），完整验收未闭环。当前审查见§10，§9为此前主流程自测。

## 目标与本轮边界

用户要求下载 GitHub 上收到的系统、拉出独立支线，评估如何接入现有系统，并优先用我们的 API 替代繁琐依赖。初次评估阶段交付源码归档、支线与接入方案；其后用户已授权接入、落地并自测，当前实施和调用范围见§9。生产发布仍未执行。

## 已完成

- [x] 从本机 goukiyang 账号找到唯一待接受分享邀请，接受并核定来源为私有仓库 `zhouh231-lang/uiux-art`。仓库只有 README，完整源代码位于 Releases，不能只克隆 main 就宣称取得系统源码。
- [x] 克隆原仓库，并创建本地分支 `codex/sd2-api-assessment-20261122`，来源提交 `c258da5`。没有向分享者的仓库推送内容。
- [x] 下载 `art-2026-11-22` 的完整归档和校验文件。ZIP 为 501,514,209 字节，SHA-256 实测为 `ec22430289417474f6a64710bb58f8a261f901493af89ffc6053c3209444561a`，与发布者一致。
- [x] 解包取得 1,911 个归档条目，包含桌面源码、独立云端源码、客户端、运行时、规范和结构资料。未执行包内程序、启动器、安装或生成操作。
- [x] 对照宿主已有实现，完成下方能力映射、共享影响判断与接入顺序。

## 下载与分支位置

- 下载根：`/Volumes/Data/Downloads/uiux-art-20261122`。
- 原仓库及本地评估分支：`/Volumes/Data/Downloads/uiux-art-20261122/repo`。
- 完整源码：`/Volumes/Data/Downloads/uiux-art-20261122/unpacked/UIUX-ART/project`。
- 结构库：`/Volumes/Data/Downloads/uiux-art-20261122/unpacked/UIUX-ART/structure-library`。
- 本项目文档分支：`codex/uiux-art-api-assessment-20261122`。基于远端已核同头的 `cd242a33fff66604ab37dedc7227f0ace325e675`（`codex/gpt-generic-flow-release-20261121`），仅加入本报告与固定 todo 索引。

原根仍在 `codex/mediakit-video-enhance`，其源码较旧且已有大量脏改，不能拿它证明当前部署能力缺失。本次同时明确读取了上述新版 Git 提交中的对应接口；这属于有版本标记的源码对照，没有核查生产运行版本，不声称这些接口已在线实测。

## 判断：值得复用设计流程，执行接回本站

这套系统主要做“结构来源 → 选择界面 → 需求与风格分析 → 逐屏提示词和素材 → 生成与修改 → 图库”。它不是另一套视频供应商后台。结构库、逐屏约束、设计规范检查和连续修改最值得保留；登录、模型执行、费用与成品归档应接回现有系统。

| 外部能力与真实源码 | 建议接法 | 必须保留的行为 |
| --- | --- | --- |
| `structure-plans.js`、`structure-quality.js`、`screen-scope.js`：Figma／上传图片结构、跨方案选择 | 保留业务逻辑与离线结构资料；在本站工具入口承载 | 原尺寸、画板 ID、勾选范围、来源版本，不把结构原图当纯风格图 |
| `design-standards.js`、`design-direction.js`、`codex-design-analysis.cjs`：规范与结构化设计分析 | 保留输入构造、输出 schema、逐屏覆盖和冲突检查；将启动本机 Codex 的传输层换为本站服务端 LLM 调用 | 真正完成分析才进入生成，不能用普通文字回复冒通过规范检查 |
| `generation-provider.js`、`studio-engine.js`、`lovart-workflow.js`：Lovart 项目／线程／上传／生图 | 新增本站执行适配；逐屏接入本站图片报价、任务、原号回执与结果读取 | 每屏独立任务；报价后确认；未知只查原号；不转换或重发历史 Lovart 任务 |
| `youdoo-workflow.js`：导出 ZIP、手动去网页生成、下载后导入 | 将新任务改为“上传有权素材 → 报价 → 创建 → 查原任务 → 自动关联本屏结果” | 附图顺序、线框／风格／上一版的角色与画板对应关系 |
| `cloud/worker/openai-images.mjs`：个人 OpenAI Key 与 Responses 生图 | 使用本站现有模型配置和任务服务，不要求每位同事再填供应商 Key | 本人权限、实际费用、受理与交付状态、原请求恢复 |
| `feishu-auth.cjs`、`team/` 与 `cloud/worker/identity.mjs`：各版本独立账号与存储 | 在本站内复用已有登录、项目／素材权限与账号隔离，不部署独立匿名共享身份体系 | 服务端逐次核权；不能用一个共享扣费账号代替所有用户 |
| Figma 来源、离线缓存与原始规范 | 首轮直接用已带的离线结构及上传图片；需要在线更新时再接用户自己的 Figma 授权 | 我们的 LLM／图片 API 不能替代 Figma 原始数据读取，不借作者授权或丢掉节点事实 |

源码确认：现有 `youdoo` provider 的模式是 `web-hand-off`，导出清单明确 `automaticSubmission: false`；它不是现成的本站自动调用。桌面分析实际通过 `spawn` 启动 Codex `app-server`。云端则另有直接调用 OpenAI 的实现，与桌面版本不同，不能混为一条链路。

## 宿主可复用入口与实际差距

新版源码对照基准为 `cd242a33f`，以下结论来自对应文件而非线上调用：

1. LLM：`src/app/api/llm/models/route.ts`、`src/app/api/llm/chat/route.ts`，使用既有登录和后台模型配置。`src/lib/integrations/musk-chat-images.ts` 提供有权限的图片准备能力。
2. 图片：`src/app/api/image-studio/quote/route.ts`、`tasks/route.ts`、`requests/route.ts`；底层 `src/lib/image-studio/billing-quote-service.ts` 已负责报价、当前费率提交和原提交链。接入应复用这些服务，不能绕过它们直接找供应商。
3. 图片任务查询、结果权限与下载沿本站已有链路；外部的 `frameId` 要明确关联本站 `requestId`、任务 ID、素材 ID，生成成功与文件可读分别判断。
4. 现有 `/api/llm/chat` 与图片接口要求本站登录态。不能把桌面端的跨域请求换一个 URL 就视为已接好；推荐将设计工具放入本站同源入口，服务端复用内部能力。若以后仍要独立桌面客户端，须另核该客户端的用户身份协议。
5. 输入协议有实质差异：外部分析允许最多 300,000 文本字符、最多 3 个界面和 5 个视觉参考，并可再带结构图／上一版。本站通用聊天接口为总计 24,000 字符、单条最多 6 图，并不直接接受外部的内联图片协议。因此不能原样透传或静默截断；应保留来源档案，逐屏组织分析，复用合法素材准备并核实最终模型上下文；仍超限时明确保留输入并报告。
6. 不新增供应商 Key 配置、不硬编码归档中的模型名，不把某个旧模板 UUID 当作所有账号都可用的固定入口。使用本站真实目录与可用性判断。

## 后续最小实施顺序（本轮未实施）

1. 在本站工具入口内承载结构选择、需求、参考与结果，保留账号和项目上下文；首个闭环使用现有离线结构中的单张界面。
2. 接分析服务：保留原分析合同和规范校验，移除新任务对本机 Codex 的启动依赖，处理上述文本／图片协议差异。
3. 接图片服务：合法素材上传与引用、模型／尺寸选择、真实报价、显式生成、原请求恢复、结果自动回到对应界面。旧任务保持原 provider，只查各自原号。
4. 补本人草稿／方案的服务端持久化；旧浏览器 IndexedDB 记录通过用户显式导入关联，不能承诺迁入页面就已经跨设备同步。成品直接沿本站资产留存，不复制另一套云数据库或个人 Key 库。
5. 工程检查与发布沿项目既有流程；真实生成、视觉效果、刷新恢复与用户操作按当次授权及项目用户手验边界记录。

共享影响集中在身份、素材、报价／冻结、原号恢复和资产归档。首次实现应把这些关联贯穿一张界面，避免只更换生图 URL 后留下手工导回、重复扣费或丢失归属的问题；不需要为此搬库、改供应商协议或重写全站。

## 验证、剩余边界与 Git Plan

- 本轮为 L1 下载／文档评估：已核分享来源、release 文件与 SHA-256、实际源码入口，以及远端开发参照提交。没有改业务代码，不需要构建、服务健康或功能验收。
- CodeGraph 准备失败：历史资料中的三份 `.mjs` 未通过索引覆盖核验。没有使用该索引作结论；改为定向读取上表中的实际源码。未将准备成功或空查询冒充结构验证。
- 资料中的 191 张源画板、181 张可选界面和 7 套结构方案为发布说明／归档声明，本轮没有通过运行界面逐张验收。
- 本轮没有配置本站 Key、修改账号／费率、生成收费图片、运行浏览器或部署。API 实际效果和 UI 质量未验证。
- 仓库未提供总体许可证。本人获得的私有分享已支持下载评估；如以后需要向第三方重新分发整包或商业发布，届时须核对分享方的使用许可，不影响当前评估。
- Git：原根与 index 保留；用独立临时 index 基于已核新参照提交构造仅含本报告与索引的文档分支，推送至既有 `goukiyang/seedance-api-debugger` origin，并核远端同头。完整私有源码、规范原件、缓存和客户端只留下载目录，不随本项目推送。

本轮新发现的线索与问题：未新增任务范围外事项；上述协议差异、持久化和授权边界均为本次接入评估内容，尚未实施。

<a id="uiux-art-api02"></a>

## API02 支线接入实施工单（2026-11-22，v1.1）

### 1. 用户确认、目标与交付范围

用户本轮明确：“按这个方案在支线上接起来，保留它的结构库和设计流程，分析和生图都用我们的 API……规划任务。”本轮完成任务规划与 Git 保存，不实施业务代码。本单后续工程目标是在独立支线上交付完整可继续使用的设计工具，不合回主线、不自动切换正式环境。

最终主路径：本站工具菜单 → UI 界面设计 → 选择结构与界面 → 输入需求／风格参考 → 本站 API 分析 → 查看设计方案与逐屏报价 → 确认生成 → 每屏结果自动回到原设计记录 → 下载或继续修改。用户无需安装 Codex、授权 Lovart、填写个人供应商 Key、手动导出素材包或导回结果。

保留全部 7 套结构方案、原始画板／原图／节点说明、跨方案选择、上传交互图、规范检查、对话与逐屏精修、历史及导出能力。原有 191 张源画板与 181 张可选界面口径不同，不将辅助画板强行变为可选；原禁用／删除状态继续生效。在线 Figma 更新继续需要用户本人的合法授权，不让更新授权阻止已有离线资料使用。首个工程闭环采用一屏，最终交付仍须覆盖整库与多屏流程。

### 2. 已查明的边界与选定方案

- **代码基线**：继续现有 `codex/uiux-art-api-assessment-20261122` 支线。当前规划前头为 `c17a953f`，业务参照为 `cd242a33f`／v0.151.4。实施前核对本支线、最新有效发布记录及变更，不把这些提交永久冻结为未来起点；不得从正式根旧 `codex/mediakit-video-enhance` 或陈旧 `origin/main` 拼接业务源码。
- **私有来源的交付**：已实际查询 GitHub，宿主 `goukiyang/seedance-api-debugger` 为 public，来源 `zhouh231-lang/uiux-art` 为 private。公开支线仅提交原创接入代码、工具配置与摘要校验清单。原 ART 源码、原规范、结构 JSON、缓存、客户端和设计成果作为本机私有依赖包，放入新工作区忽略目录 `.private/ui-design/<归档摘要>/`；从已校验下载归档生成。包的实际路径和校验结果记录在本机记录，不能默认上传到公开 Git。
- **运行方式**：沿 `src/app/tools/ultimate-canvas/page.tsx`／`CanvasFrame.tsx` 的“本站页面＋同源 iframe”模式，新增 `/tools/ui-design`。外层保本站账号／项目上下文，内层保原设计工作台布局，避免重写整个原生 JS 界面。私有 HTML／JS／结构原图由本站鉴权运行时路由提供，不放进 `public/`、公开 CDN 或客户端 Next 静态 chunk；直接打开内层地址也必须鉴权。
- **最小改动面**：复用 `team/client.js` 已存在的 `UIUXTeam.load/save/user/template/relogin` 适配面。新增本站客户端适配，保留 `studio.js` 的设计逻辑，调整 API 定位、状态／provider、分页历史、保存／导出和账号连接等接缝；不能把原来“全历史整包保存”直接接到分行存储。原含 Lovart 名称的模块同时承担本地任务／提示词构造，不能按文件名整份删除。
- **持久化**：沿 `src/lib/character-lab/store.ts` 已有的 `PlatformSetting` 命名空间、事务与 `value_json` 条件更新模式新增 `ui-design:v1:<session-user>:library|workspace|request:<id>` 记录，不新增云数据库或迁表。工作区按对话独立存储、历史分页读取；共享结构大对象与图像放私有文件包／本站资产，仅保存来源版本、摘要及引用，不将 48 MB 工作台、base64 成品或全部历史塞进一个 JSON。草稿与每屏提交回执分行，避免普通自动保存覆盖受理事实。
- **分析**：新增本站专用分析入口，复用 `getMuskApiSettings`、模型目录／启用校验、`prepareMuskChatMessages` 和 `createMuskChatCompletion(jsonMode: true)`。保留 ART 的 `prepareAnalysisRequest`、`outputSchema`、`validateOutput`、`resolveAnalysisOutput` 及规范／覆盖检查，替换 Codex 子进程传输，不调用原 `analyzeDesign` 启动器。通用 `/api/llm/chat` 的 24,000 字符／6 图限制保持原义；专用入口独立约束原分析合同与实际模型能力，不能用通用接口透传或悄悄提高通用上限。原 300,000 字符是本地输入边界，不是上游能力承诺。
- **生图**：新增 `sd2` provider，仅新工作区默认选用；历史 provider 缺省仍按原 Lovart 含义读取，旧已受理／未知任务不能改路由或重发。新任务复用本站图片报价、提交、回执、查询和资产链，按 `frameId` 关联结果。使用不指定业务模板的既有通道，不硬编码旧模板 UUID，不读写本人正在编辑的默认模板，也不自动创建／发布共享模板。增加仅供服务端核属使用的 UI 设计执行来源，冻结本作业上下文与素材角色，避免继承无关通用模板上下文；具体合同及定向检查见下方复核补正 R03／R04。

以上为当前方案选择，不代表相应接口、目录或文件已经实现。新增路径在下表标明；已有路径以支线实际源码为准。

### 3. 页面、状态与数据合同

**入口与布局。** 名称为“UI 界面设计”，纳入 `src/lib/navigation.ts` 工具组及顶部工具匹配；现有 `ToolsMenu.tsx` 自动消费工具组，不另造主导航。首版使用活跃内部账号及既有图片使用资格，外部账号不因模板已开放而自动取得这批私有资料权限。左侧保持方案／对话／图库，主区保需求、当前结构、设计方案与大图。项目归属沿本站已有有效选择；设计记录名与本站项目名分开，不自动建立视频卡。

**常显。** 当前方案及界面数量、需求与风格参考、分析／生图模型、必要规格、主操作和真实阶段。模型下拉及相邻更新复用角色融合范例；目录失败保选择，不悄悄换型号。

**按需。** 完整节点、原始规范、素材顺序、费用明细、原请求诊断、来源版本、Figma 在线更新与导入导出。普通用户不显示 provider transport、Codex 路径或秘密配置。没有结果时显示可开始的空态；不放示例成品。图片下方不新增元信息说明行，操作和详情使用现有工具栏／按需入口。

**状态。** 草稿 → 分析中 → 设计方案就绪／分析未完成 → 待确认报价 → 提交中 → 已受理／提交结果待确认 → 排队／生成中 → 生成完成、保存中 → 可查看／下载。每屏独立显示，父记录按真实子项汇总部分成功。通用查询失败不覆盖已成功事实，不编百分比。

**操作与接续。** 分析不触发生图；确认生成前显示所选界面数、各规格和真实总报价，使用一次费用确认覆盖该冻结输入。改需求／结构／素材使相关分析及未受理报价失效，保旧结果；改模型／规格重报价。明确失败后的新生成由用户主动发起。刷新只读原任务；停止只封未受理屏，不宣称取消供应商任务。关闭页面后已受理项继续由本站 worker 处理，重新打开自动查回；尚未受理项明确保留并提供“继续未提交界面”，不假装后台已经受理。

**对象合同。**

| 对象 | 保存内容及权威边界 |
| --- | --- |
| 来源库／方案 | `planId + sourceVersion + frameId + contentHash`，原始节点与图片保持可追溯；个人改名、禁用、勾选另存，不回写共享原包 |
| 工作区 | `workspaceId + ownerId + projectId + revision`，需求、参考资产引用、结构选择、方案和对话；owner 仅由 session 决定，保存冲突保本地草稿并可读取新版 |
| 分析 | `analysisId + inputHash + model + model/configRevision + schemaVersion`，绑定本次来源、规范、参考及模式；迟到分析只进入所属记录，不覆盖更新后的输入 |
| 逐屏作业 | `workspaceId + frameId + runId + parentRunId + requestId + inputHash`，冻结模型／规格／有序素材／提示词／分析修订及报价。首次提交前持久化，与普通草稿独立 CAS 更新 |
| 任务与结果 | 既有 `batchId/taskId/assetId` 为受理、执行、计费及交付权威；本模块只存映射。不能以收到 batchId 冒已出图，图片就绪后才能提供真实预览和下载 |

本地应急草稿按账号／工作区隔离；退出或换账号先停旧账号请求与写入，再读取新记录。保存失败明确显示未同步并保留草稿。旧 ART 的 IndexedDB 数据只能在本人显式导入后关联，不跨浏览器读取；旧外部任务只作为原 provider 历史，不从导入文件采信服务端用户归属或扣费身份。

**原图传递。** 浏览结构只读取受保护库，不批量上传全库。选定图片首次用于分析／生图时，由服务端按库版本、frameId 和摘要定位原件，通过本站已有素材存储登记有权限的资产引用，再进入既有图片准备与生成链。同一有效来源可复用已有引用；不接受客户端任意磁盘路径。线框、风格参考、原始素材、上一版各自的角色和顺序贯穿报价与创建，数量超过真实线路上限时明确保留输入，不能删掉末尾参考来迁就接口。

### 4. 工作包、依赖与完成标准

实施顺序：W1 → W2 → W3 → W4 → W5 → W6 → W7。按每批结果提交，不强制并行、不自动创建审核对话。W1／W2 内部可先做同源受保护入口，入口仅在相应能力完整后向工具列表开放；不能将无后端的占位按钮作为交付。

- [x] W1 形成可校验的私有依赖包，完整接入 7 套结构及受保护读取。
- [x] W2 完成本站页面、身份、本人工作区保存和合法素材引用。
- [x] W3 用本站 API 完成原合同下的设计分析与规范校验。
- [x] W4 接通单屏报价、真实提交、原号恢复和结果映射。
- [x] W5 完成多屏、单屏精修、部分成功接续与自动回图。
- [x] W6 完成工具入口、历史／导出、恢复及手机／键盘交互。
- [ ] W7 必要工程检查、可重建本机候选和用户手验入口已完成；当前 Git 上传因网络待接续。

| 工作包 | 具体范围／主要修改点 | 完成标准 |
| --- | --- | --- |
| W1 私有依赖与全结构库 | 新增原创 `scripts/import-ui-design-source.mjs`、私有包校验／载入模块及精确 `.gitignore` 条目。输入为本次已校验完整 ZIP；保留原件，只生成选定源码、规范、7 套结构与原图依赖包，排除 Node、客户端、node_modules、outputs、个人连接和云端部署产物。新增受保护 `src/app/api/tools/ui-design/runtime/[...path]/route.ts`，只读受限包内目录并核 session | 归档摘要和目录清单可复核；全部结构按 catalog 对账，565 去重图像及节点引用无丢失；原禁用状态保持。本轮新增公开 diff／Git 对象及可匿名读取静态产物中不出现私有源码或资料；缺包明确不可用，不能回退连作者机器 |
| W2 本站页面、身份、工作区和素材 | 新增 `src/app/tools/ui-design/page.tsx`、`UiDesignFrame.tsx`；新增 `src/lib/ui-design/{access,store,types}.ts` 及 bootstrap／workspace／library／media 路由；私有运行包内新增本站 `UIUXTeam` 适配。沿 `PlatformSetting` 的本人命名空间与 CAS，复用本站上传／素材授权入口，移除新流程的独立飞书／Lovart／个人 Key 连接要求 | 本人可创建、改名、保存并重开对话和个人方案；刷新恢复实际服务器记录。跨账号或无项目／素材权限直接请求被拒；大图通过资产／私有资料引用读取，不变成匿名静态 URL。原工作区、库和图片不被导入覆盖 |
| W3 分析 API 与原设计规则 | 新增 `src/lib/ui-design/analysis.ts`、`src/app/api/tools/ui-design/analyze/route.ts`；复用私有包原输入／schema／输出修复函数、本站模型及图片准备服务。按原最多 3 屏分析窗口组织大选择，完整保存所有输入，逐批维护共享视觉方案；每次提交核实际模型的文本、视觉输入能力。真正不可分割的超限保资料并说明需调整的范围，不截断或删参考 | 新流程不启动 Codex、不请求 Lovart；模型来自真实可用目录。输出覆盖选中 frameId、原图文字／节点、规范及精修锁定要求。普通文字、坏 JSON、缺屏或规范冲突不能冒分析完成；不改变通用 LLM API 对其他消费者的限制 |
| W4 单屏报价、生成、原号恢复 | 新增 `src/lib/ui-design/generation.ts` 和逐屏 quote／submit／status 路由，运行包 provider 只添加新 `sd2` 分支。复用 `prepareImageBillingQuote`、`submitStudioBatch`、`readStudioSubmitReceipt` 及素材授权／参考策略；传本人有效 projectId，单屏 `count=1`，先保存输入与 requestId，再受理；事务调用必须保持实际 helper 的 tx 边界 | 同一屏只有一份原受理、一次预留／结算；报价不创建业务模板。超时、空查询和刷新只查原号，不重发；费用状态由现有服务决定。参数、权限、费用或素材数量不支持时保留原输入，不静默换模型、删图、拉伸或免费重生 |
| W5 多屏、精修与自动回图 | 基于 W4 串起现有选中屏，父设计记录只组织映射、不额外扣费；逐屏真实报价汇总后一次确认，再按原图顺序提交到既有图片队列。精修仅为用户选中的屏建立新作业，保 parentRunId、上一版原图和已确认不变内容；结果就绪后按 frameId 自动关联本站 Asset | 多屏部分成功可继续处理剩余明确未受理屏，成功与未知项不重生。报价过期／配置变化只影响未受理项，需重新确认时原地处理。等待与关闭不阻止本站已有任务保存，重开可查回；不要求用户下载再上传结果，不建立第二套 worker／账本 |
| W6 连续使用与完整界面 | 接入既有导航与工具菜单；保原方案选择、勾选折叠、对话／历史／图库、预览／下载、继续修改、上传交互图和导出。完善旧工作台显式导入、本人状态恢复、手机／键盘和保存反馈；清除新流程里失效的 Lovart 连接、OpenAI Key、手工网页交接提示，原历史仍按来源可读 | 从入口到出图再到精修均同页可完成；输入、旧结果、勾选、来源和费用信息不丢。仅尺寸差异不当生成失败。图片完整 contain，操作可达，信息不撑高图片下方；刷新与账号切换不串现场。未接在线 Figma 更新时保离线／上传完整主路径，明确在线边界 |
| W7 工程检查与支线交付 | 按下节跑必要检查；将私有依赖与本支线在本机隔离环境组装为可运行候选，记录启动入口、依赖包摘要、Git 提交及用户手验清单 | 公开支线可从 Git 取回原创适配源码；具备原私有包后可重建同一候选。无主线合并、生产部署、实际收费生成或自动浏览器验收；交付标记“支线已实现／待用户手验”，不能以构建成功宣布效果达标 |

### 5. 工程验证、手验与停止条件

本次业务影响按 **L3** 规划：涉及本人私有数据、异步受理和费用；工程证据与用户功能验收分开。当前只写文档，以下命令和场景均是后续任务，不记为已通过。

- 工程命令沿用仓库：`npx tsc --noEmit --pretty false`、`npm run lint`、`npm run build`（保原 prebuild 内置检查）、`npm run test:ui-account-boundaries`。原 ART `node --test` 仅取仍复用的结构选择、规范校验和任务构造用例；不为本任务跑全套外部云版／桌面授权测试。新增的回归检查只捕获本次新接缝的具体问题，调用实际实现，不抄业务逻辑。
- 必要隔离工程场景：① 7 库来源／原图引用与禁用状态；② 匿名／其他账号／被撤权素材；③ 原分析 schema、完整输入及模型限制；④ 报价变化、原号提交未知、仅查不重发及单次计费；⑤ 草稿 CAS 冲突、换账号／迟到返回、刷新后仅查询；⑥ 单屏精修／多屏部分完成及本站原图交付。供应商传输用已有可注入接口隔离，禁止命中真实付费地址，也不通过复制算法验证自身。
- 共享影响按本次变化定向核对：LLM 服务复用不改变通用聊天合同；图片接缝不破坏模板普通提交、当前报价和旧回执；新私有运行包与检查脚本不改共享上传目录权限／清理规则。没有改动的发布服务、下载 timer、其他模型线路不做全盘回归。
- **用户手验**：A01 内部账号打开 `/tools/ui-design`，查到全部 7 套原结构并正确勾选；A02 上传交互图／参考、分析后保原规范与文字；A03 明确确认真实费用后单屏出图，自动回到对应屏并可下载；A04 多屏部分成功、刷新和原号待确认不重复生成；A05 选择一屏精修、旧满意屏保持；A06 关闭重开／保存冲突／账号切换不丢或串资料；A07 手机／键盘预览、勾选、参数和操作可用。A03–A05 中的真实收费生成由用户主动操作，Codex 不自动代跑；构建与模拟证据不替代这些手验。
- 执行停止条件限受影响动作：私有依赖缺失或摘要不符；素材权限不成立；实际模型输入不支持且无法按保原义规则分批；报价未确认；提交结果未知；原结果未可读。保留其余输入和已成功结果，不用换身份、放宽权限、静默换模型或重发来“完成”。
- 支线恢复：保原 ZIP 与源码、规划前分支提交、导入包版本；功能代码可回退／入口可隐藏，新增命名空间、原提交回执、账本和图片保留，不回业务数据。正式发布不在本轮范围；以后需要上线时，另沿现有无感发布入口核私有包同版本交付和相容消费者，不先停旧服务或改变下载 timer。

### 6. Git Plan 与执行交接

- 正式根：`/Volumes/Data/Projects/video-api-debugger`；原根分支、index 与旧脏改保持。本轮用临时 index 隔离更新已有文档支线，仅提交本工单及固定 todo 条目；remote 为已核 `https://github.com/goukiyang/seedance-api-debugger.git`，推送后核远端同头。
- 未来实施沿该支线使用干净工作树；若没有合适活动 worktree，再用 `create_worktree` 创建并以工具实际返回路径执行。不要直接切走有脏改的正式根；不复制所有旧未提交文件。
- 聚焦提交建议：W1 私有包接入；W2 身份／持久化／基础页面；W3 分析；W4 单屏受理；W5 多屏精修；W6 界面与恢复；W7 工程修正／交付记录。包间检查按实际变化复用；先核 `git diff --cached` 确认没有私有源文件、规范、素材、Key、依赖或构建产物，再推公开支线。
- 不创建新的个人 Key 库、供应商账号、公共素材源、云数据库、迁移平台或独立调度器。若实际能力与本单证据不同，当前执行者先补查受影响接口并更新同一原单，不擅改整单验收标准。

**交付前体验复核已并入本单设计**：已确定可发现入口、内部身份、结构选择、费用确认、阶段与部分成功、原号恢复、结果直接使用、单屏精修和离开后接续；已删除计划中的手动搬图／个人供应商连接负担。该复核是方案推演，没有页面或真实生成验收。

**本轮 review**：上轮下载、分支与分析证据复用；本轮核对了 `UIUXTeam` 接口、原 provider 与 schema、本站 shell／工具菜单、普通图片无模板提交、CAS 存储及真实 GitHub 可见性。所有 W1–W7 尚未开始，用户手验未执行。未新增任务范围外事项；私有来源与公开目标的差异已在 W1 处理为交付边界，不是另一个待派工任务。

<a id="uiux-art-api02-review"></a>

### 7. 缺漏、风险与闭环复核补正（2026-11-22，v1.1）

审查对象为 `d786b8f98` 的工单与其明确引用的源码，不是尚未实现的业务，也不是线上安全扫描。本次由当前对话按代码关系和用户任务路径定向复核，未启动独立审核、应用、收费生成或浏览器。下列问题是 **v1.0 方案中已确认的缺口**；本节将修法、依赖与检查并入原 W1–W7，不以增加保护层或扩展功能代替解决。

| 编号／影响 | 证据与缺口 | 并入原任务的处理和通过标准 |
| --- | --- | --- |
| R01 高：私有运行包边界不够明确 | 原包同时含前端、服务端、规范原件；只写“受限目录”不足以定义 catch-all 可返回哪些文件。`studio.js` 的 ready／focus／online 还会恢复 Figma／Lovart 连接，隐藏按钮不能关闭这些调用 | W1／W2：清单区分可返回的前端文件、可读资料和仅服务端模块；运行时路由只服务前端白名单，资料走独立授权读取，拒绝任意路径／越界软链／服务端模块／凭据。响应 `private, no-store`，按 Cookie 区分，不能由代理缓存给其他账号。启动即装本站 adapter，`sd2` 分支跳过旧连接恢复；登录后、返回窗口和重联网不发旧授权／Lovart 创建或作者云服务请求。写接口按本站 Origin／CSRF 规则，仅信 session，`X-UIUX-User` 不能成为身份凭据 |
| R02 高：分析协议与多轮上下文遗漏 | `prepareAnalysisRequest().request` 是 Codex 的 `input`／`outputSchema`，图片为 `type:image,url`；`resolveAnalysisOutput`、`adaptTemplateConflicts` 再调用 `ask`，原 app-server 自动保留上下文。普通 Chat 请求是另一套协议 | W3：逐项转成本站消息／图片格式，保结构图、风格样本和旧图标签与顺序；首次及每次补漏均携带本 analysisId 下冻结的原始上下文、先前 assistant 答复和本轮修正请求，输出 JSON 仍用原 schema 验。只执行原有有界补漏／冲突修正，不无限重问；总超时／取消时保草稿与已完成分析，不留下永久“分析中”，不自动生图。多批分析锚定同一份 `shared/artDirection/styleTransfer` 及规范版本；后批冲突明确保留，不让每组三屏各自产生不同皮肤 |
| R03 高：生图长度、上下文与附图角色不匹配 | 原 `lovart-workflow.js:8` 允许 30,000 字；本站 `tasks.ts:450` 的 `prompt` 上限是 20,000，`:863` 默认继承 `settings.context`，`:1089–1102` 又会按主图／辅助图重排素材。普通默认模板并非隔离执行合同 | W3／W4：原无损说明编译入口增加按 provider 的目标上限，原 Lovart 记录仍按原规则读取，`sd2` 的 prompt 字段须 ≤20,000；报价前编译检查，不截断、不挪到管理员专属字段绕限。若无损压缩后仍超限，明确指出本屏未提交并保完整档案。新增服务端核属的 UI 设计来源参数，参照现有 `characterLabPlanId` 的上下文冻结接缝，仅此来源使用本作业上下文／明确参考策略，不带无关全局模板文案或固定图。冻结并核对实际发送的附图编号／角色／摘要，精修上一版顺序不漂移；最终合成文本与图片数还须符合真实线路能力 |
| R04 高：原号重复与明确拒绝的闭环不完整 | `submitStudioBatch:529–535` 已受理快路径可直接返回原 batchId；新 adapter 若不先核自己冻结的输入，改内容用旧号可能被误展示为新提交成功。明确拒绝的耐久投影在 `/api/image-studio/tasks/route.ts` catch 层，直接调 helper 不会自动获得该路由回执 | W4：提交前核 owner/workspace/frame/run/inputHash 与已存原号，内容不符返回冲突并指向旧任务，不能把旧 batchId 贴给新屏；首次发送通过本作业 CAS 标记，两窗口仅一个能派发。复用原路由的 `studioSubmitFailureDetail`／`rejectStudioSubmission` 安全分类及原受理证据核对，DB／网络故障继续 unknown。增加“核对原提交”及既有 `closeStudioSubmission` 支持的显式安全结束入口：有原任务继续查；仅服务端原证核验允许时封原 key，迟到写入受原 helper 拦截；开关关闭或有疑点继续保原号，不自动退款／改号。封口或明确拒绝后也只由用户主动发起新生成 |
| R05 高：整批一次确认与停止／恢复缺少绑定 | N 个真实逐屏报价有不同 `billingQuoteId`、`expiresAt`、`pricingRevision`；仅累加数值不能证明同一套输入被确认。关闭或停止时也可能有一个子项正在提交 | W4／W5：持久化批次的有序 frame/run/requestId、各报价／规格／线路版本、已确认总额和批次修订；合计使用本站点数精度工具，父记录不扣费。逐项核当前冻结输入再提交；价变／过期只重报价尚未受理项并重新确认，不触碰已受理／未知项。停止与领取子项在同一批次状态下 CAS，已领取发送中的项按原号核对，不能当未受理再投。未来 quote／submit helper 各自管理原事务，外层不包事务后再调全局 DB、LLM 或供应商；队列补位与并发沿现有 worker，不另起执行循环 |
| R06 高：共享素材的使用、复制和下载权限混淆 | `musk-chat-images.ts` 默认仅内联本人 Asset；`canvas-studio-reference-use.ts` 明确“use grant is not an import/copy/download grant”，`reference-albums/permissions.ts` 分开核这些权限。把共享参考转为本人副本会改变权限结果 | W2／W3／W4：内置随包结构和本人上传沿原计划登记；同事共享参考保原 owner/Asset，用 `assertCanUseReferenceImage` 等现有权限服务核具体操作。必要时通过 `prepareMuskChatMessages` 已有 dependencies 接口接入本模块授权读取，不放宽全局 owner-only 默认，也不复制／改 owner 来通过检查。服务端可用的原件不因此成为浏览器可下载原图；报价和提交重核，已冻结任务沿既有在途规则，不清账重发 |
| R07 中：分页存储与原保存合同不兼容 | `studio.js:724` 的 persist 每次传完整 conversations；renderHistory／changeConversation 依赖每项 `.state`。`studio-draft.js` 原固定键 `uiux-art:composer-draft:v1` 不隔离账号 | W2／W6：新增列表摘要／单对话详情／当前对话保存接口，定点改历史渲染与切换逻辑；不将未加载历史当删除，不把每次输入变成全部对话写入。草稿、个人库和每屏提交分别按自身 revision 更新；迟到保存只清已确认 checkpoint。客户端绑定 session 用户和工作区后再读本地应急草稿，新模式不读取无身份旧固定键；旧格式仅显式导入。冲突支持保当前草稿、查看／恢复服务器版本，不强迫先导出才能继续全部工作 |
| R08 中：需求文档／网站参考的入口未落到接口 | 原 `requirements-source.cjs` 处理 TXT／Markdown／JSON／DOCX／PDF，`visual-reference-source.cjs` 处理公开网址与截图；v1.0 只有分析和素材路由，原控件会继续请求旧 `/api/requirements`／`visual-reference`／`figma` | W1／W2／W6：增加原输入能力对照清单和对应 `/api/tools/ui-design/requirements`、`visual-reference` 适配，复用原解析器与公开网络约束，不把未读到画面的 URL 当已分析。优先保原受限网址的“打开网页／粘贴截图”恢复，不能携本站 Cookie 代抓外站，也不读本机 Chrome 账号。离线 Figma 库不联网；在线更新沿本人合法授权与可用能力提示，不再启动作者机器。PDF／网站截图依赖见下方候选依赖合同，缺失时保输入并明确该能力不可用，不伪造正文／截图 |
| R09 中：原导出／删除假设失效 | `exportConversation()` 直接把 `candidate.dataUrl` 写进离线 HTML；新设计仅存 Asset 引用，照抄会得到空图或离线不可读链接。原 deleteProject 会移除本地对话，搬入服务端后不能连同受理映射／费用删除 | W5／W6：展示／图库用可授权的 Asset URL；用户显式导出时读取当次有权导出的成品字节，生成自包含 HTML／ZIP，不写 Cookie、Token、临时签名链接或服务端路径，不为导出永久保存 base64。共享参考原件须另有复制／下载权限才可打包。部分成品按实际可取数量导出并说明缺项。删除设计仅归档本人工作区与个人方案可见性，确认影响；原图、已受理／未知任务、映射和账本保留，后台照常完成，可从本人原任务／资产找到结果 |
| R10 中：私有候选可重建条件不完整 | 原 ZIP 摘要只能证明输入包，不能证明修改后的私有运行包。PDF 解析器还回退到作者的 Codex 缓存，排除全部 node_modules 后不能假定这一依赖随候选存在 | W1／W7：保原 ZIP；记录原创接入 Git commit、私有适配补丁／导入规则版本、最终运行包摘要及资料清单。需要私有源码片段的补丁也放私有包，不以公开 diff 泄露。候选必须从原包＋同版补丁可重建，缺失即停止受影响能力。本机已核可复用 `pdfjs-dist` 5.6.205、Apache-2.0 许可、cmaps/standard_fonts 与 Node22.22.2；仅按依赖清单组装必要库／资源／许可，不复制完整 Codex 缓存或自带 Node。目标候选实际验证兼容性后才能称 PDF 可用；无可用截图引擎时沿原 URL／上传截图恢复，不擅装整套浏览器 |

**共享接缝的具体落点。** R03 的变化落在 `src/lib/image-studio/tasks.ts` 的准备／冻结环节，以及 `billing-quote-service.ts` 对相同 UI 设计来源的传递。新增来源由本站路由从已持久化的本人作业解析，客户端不能伪造管理员通用上下文。普通模板、默认模板、画布与角色参考图调用不传该来源，保持原行为；不把修改整个共享上下文规则当作隔离修法。R04 的原号核验先在新作业记录完成，再进入原 helper，不调整历史请求合同。

**本次补全的闭环链路。**

- 新建／导入：校验来源与本人权限 → 明确写入新对话／个人库 → 有服务器 revision 才显示已同步；拒绝保原输入，不覆盖原工作区。
- 分析／继续：将 Codex 数据转换为 API 合同 → 原 schema 检查及有界补漏 → 固定共享设计方向 → 分批覆盖全选屏；中断保部分成果，不能冒全部分析完成或自动生成。
- 报价／受理：相同编译输入、素材角色及线路 → 逐屏报价与批次费用确认 → 原号先存 → CAS 派发 → 原服务受理／拒绝证据 → 单结算；网络未知不猜结果。
- 未知／停止：查原号 → 有受理继续原任务／有疑点保留 → 仅明确允许时显式封口；停止只阻止后续领取，不承诺取消正在发送／已受理任务。
- 成品／维护：可读后关联原屏 → 下载／仅选中屏精修／有权离线导出 → 归档工作区仍留任务与资产；账号切换、共享撤权与迟到返回不能把旧成果带入新身份。
- 支线交付：可取回的原创适配提交＋私有运行包摘要／资料清单／必要依赖＋本机启动命令＋工程结果＋用户手验状态；不以“有 Git 分支”冒可运行候选，也不以候选可运行冒已部署。

**追加到 W7 的定向工程证据。** 不另建全站验收：

1. R01：匿名／外部账号／换账号读取运行文件和原图；服务端文件／编码越界路径拒绝；缓存不串身份；新 sd2 工作区初始化、focus、online 不调用旧登录／生成。
2. R02：实际输入转换、图片标签顺序、补漏时携原答复与上下文；缺节点／错 schema／修正失败保原规范结论；多组三屏共用同一视觉版本；取消／断连／超时后状态可恢复。
3. R03：20,000 与 20,001 字入口边界、原 20,001–30,000 字任务的无损编译或明确拒绝；私有 UI 来源与普通模板各自的上下文／固定图行为；线框、风格、上一版的最终发送顺序与报价输入一致。
4. R04／R05：双窗口同号只派发一次；旧号变内容不能投影为新屏成功；明确拒绝有耐久回执；空查询不换号；安全封口拦迟到请求；报价过期／改价／队列满／停止与领取交错，已受理、未知与未受理分别处理。用隔离 DB／可注入传输调用真实实现，不向供应商付费。
5. R06／R07：本人素材和仅授 use 的共享参考均按真实权限处理，撤权后新提交拒绝；不能借导出／复制取得原件；分页／局部保存不删未加载历史，全局旧草稿不串账号，迟到保存不盖新草稿。
6. R08–R10：需求文档及 URL 被接受／受限／依赖缺失时的真实反馈；导出成品离线可读且不夹凭据／无权原件；归档时原任务继续留存；原包和补丁能重建同一运行包，缺依赖不以普通构建通过冒功能可用。

用户手验 A01–A07 保持原范围，A02 补看需求导入／参考，A04／A06 补看安全结束、分页、归档和导出；不为补正自动追加收费样本。工程证据尚未执行，以上是明确的实施／检查要求，不是已经生效的保护。

**复核结论与剩余风险。** 10 处方案缺口均已有明确修法、原工作包和通过标准，v1.1 可作为支线实施依据；公开／私有交付边界和普通消费者兼容要求均保留。当前 W1–W7 仍全部待实施，实际模型能力／画面质量、候选依赖运行和用户手验仍未证明。计划中的可恢复行为须由真实实现和隔离工程证据证明，不能把本节文字当作保护已上线。本轮无任务范围外发现，不另建待办或派工。

## 8. API02 实施记录

- 当前批次 W1/W2；独立工作树 `/Volumes/Data/HomeRelocated/gouki-youdoo/.codex/worktrees/uiux-art-api/video-api-debugger`，支线 `codex/uiux-art-api-assessment-20261122`，基线 `bfcc1f779`，开工业务干净。
- 当前执行者直接完成，无原生 worker 入口，未创建侧栏任务或审核线程。
- 已落文件：私有目录忽略规则；正在写入私有包导入器、运行白名单、账号鉴权和分行 CAS 存储。
- 工程依赖和 Prisma 客户端保持本工作树独立；没有对共享 node_modules 安装或 generate。正式根只读。
- 当前无业务决策阻点；W1–W7、统一工程验证与自查尚未完成。未收费生成、浏览器验收、push 或部署。

### W1/W2 实际文件批次

已落 importer、运行包载入校验、前端白名单 runtime 路由、store/access/types，以及 bootstrap/workspace/library/requirements/visual-reference 路由。私有包正在实际组装。前两次写入被范围登记目录非递归和 cwd 不匹配拦住；查明登记要求后改为实际工作树模块 `/**`，写入已成功，无跳过检查。仍未进入统一验证。

### W3/W4 实施中

私有包首轮实际摘要 `6425d175f65f407105042a0b68cffebe4bea28a274a31c6c8f5c72ce416a4246`（后续私有适配会改变最终摘要）；原库口径及 PDF 依赖已实际对账。已落 media 素材接缝、analysis 多轮转换/逐三屏分析、generation 逐屏报价与父批 CAS/原号状态、安全结束接口、同源页面。共享 tasks/billing helper 新增仅服务端 UI 来源；普通调用不传该来源。正在组装原工作台私有 adapter 及连续流程，尚未统一验证。依赖使用独立克隆副本，未改共享客户端。

### 整合差量与工程准备

- 已接原工作台 sd2 provider、本站模型/项目/规格、批次报价确认/停止/原号核对/安全结束、分页历史、归档和 HTML/ZIP 结果导出；适配均在忽略的私有 overlay。原始库与成品继续走鉴权引用。
- 父会话指出上传结构重开后的 PNG 判定缺口：已给私有 `structure-images.js` 增加精确本站受保护 media URL 识别，服务端读图仍核属/核 use；正在补实际持久化→恢复→选屏/分析准备回归。
- 本工作树从旧根独立克隆的依赖缺少当前支线所需包，首次 tsc 显示缺包及本次 3 处类型问题；类型问题已定向修正，正按当前 lockfile 在本工作树独立 npm ci，不改共享 node_modules。私有原包暂存目录排除宿主 tsc，私有规则/JS 单独校验。
- 原私有包带 overlay 的第二轮实包摘要为 `17622042664a829bb226e088d6c02cad47931e3d276d5513bdda6a3583e04af8`，最终以完工重建摘要为准。仍未收费生成、浏览器验收、push 或部署。

PDF 首失败保留：父会话只读导入私有 parser 发现 `Cannot find module '@napi-rs/canvas'`，最终 `DOMMatrix is not defined`。此前 manifest 的 5.6.205 仅表示已复制版本，不表示可运行。当前只补既有缓存内 canvas JS/当前平台 native/许可闭包，并补真实 PDF 文本提取工程证据。

### W5/W6 收尾与 W7 定向检查准备

素材选择已沿宿主 ResourceLibraryPicker 接入，shared use 保留原 Asset/owner，不能借本模块原图/导出获取他人原件；归档不删任务/账本。已落 `scripts/check-ui-design.mjs`：调用实际 serializer/store/结构模块做持久化恢复、实际分析输入转换、真实权限撤销/原件拒绝、CAS/分页/单次派发及安全封口、真实 PDF 提取。测试使用独立临时 SQLite 和可注入受理传输，不访问付费供应商。工程结果待实际执行，不能把脚本存在当通过。

依赖安装停滞诊断：当前 package.json 与 lockfile 根依赖逐项一致；686 个 resolved 均为 registry.npmjs.org，公开 registry 连通。npm 60974 的 debug 仍停 idealTree，无已完成下载或错误；一次进程采样显示缓存解压/文件 IO，未证明网络或锁文件损坏。为避免无界等待，已终止本工作树这次安装，等待进程退出后才采取单一恢复路径，不并行第二个安装；共享依赖未改。

依赖最短恢复：已确认首次 npm 进程退出（137），其残留仅在本工作树重命名保留；随后单独在空 node_modules 按原 lockfile 重建，禁用 audit/fund、优先缓存并开启进度日志。现已有逐包进度，不是并行第二安装。匹配当前应用的 gpt 工作树 package/lock 均完全相同，但没有现成 node_modules，因此未从它冒用依赖。私有 importer 改为仅解包已选源码/规范/结构资料，不再反复展开无关桌面 Node/客户端。

### W7 当前实证与 Linux 接续（8/10）

独立依赖已在系统临时目录按原package/lock完成 npm ci（609 packages，18s），工作树软链仅指向本任务独立依赖，Prisma5.22.0生成前核实际独立路径。tsc/lint/ui-account-boundaries exit0；原结构/规范/预算/选屏/结构图52项50PASS、2SKIP。上传结构真实保存引用→恢复→SI.isSource/targets→分析转换PASS；根因是save后内存个人库仍为原始dataUrl，重开attachLibrary覆盖受保护引用，已改为hydrate(personal)，不改断言。PDF复用主控合法PDF提取exit0（parser和依赖hash匹配），首失败仍保留。

Mac标准build原门拒绝darwin!=linux，未绕过。既有代理502后同登记工程机直连成功：Linux、/data真实挂载、gouki UID/GID1004、Node20.20.2、现有build-work。已完整读bootstrap-root.sh，确认只准备工程fixture；源码冻结后在新ui-design-api02目录跑该入口及原npm run build。此记录时Linux构建和本机候选均未启动。禁止发布器、current切流、服务/timer及共享权限操作。Linux canvas native按0.1.100实际元数据需gnu/musl后缀，已修importer；Mac PDF证不冒Linux运行证明。

主控已核/uploads/_next/image→upload-access现有鉴权链，未发现新私有泄漏，不扩改。私有最终有效runtime+overlay+构建输入给摘要清单，主控负责稳定Downloads归档；本会话未另建稳定归档。正在补真实共享helper快照及旧导入历史保护；不重复已匹配检查，无收费/浏览器/push/部署。

Linux已实际启动：公开实现提交 `7bd4a4aa3e41d1e8e04064c0dcc1a5e4fa0a5a60`（未push），仅git archive公开追踪源码传入 `/data/video-api-debugger/build-work/ui-design-api02-20261122-7bd4a4aa3`。该目录新建，gouki1004独占，正在 `timeout 300 npm ci --no-audit --no-fund`，cache/client皆本目录；随后独立Prisma generate。安装/构建不接生产DB，不含私有ART。新增认证/实际helper快照、20000接受/20001拒绝、顺序/默认上下文、余额不变与任务0写入PASS，旧工作台显式导入个人库与历史原外部requestId保留PASS（`engineering-cDXM11/result.json`）。Linux标准build与本机候选启动结果仍待补。

Linux安装/独立Prisma生成 exit0，真实标准 `npm run build` 已运行（prebuild仍在执行，日志在隔离候选 build.log，结束写build.exit）。实际root bootstrap只写新候选`.role-tests/pricing-prepared-<uuid>/pricing-legacy-fixture-runtime`工程标记，未触碰运行服务。源码为7bd4a4aa3。Mac用户候选已就绪：`http://127.0.0.1:3316/tools/ui-design`，`bash .private/ui-design/start-candidate.sh`；独立系统临时空SQLite、零余额工程账号、未拷业务账户/供应商配置，未起worker。GET /api/health HTTP200，私有runtime匿名HTTP401，curl均exit0；这只证明启动和入口保护，不冒功能通过。登录说明只在忽略的 `.private/ui-design/candidate-login.txt`，env/login/临时DB绝不归档/提交。原分析缺失/错schema、原结构图片/上一版标签及定向补漏6项离线检查exit0（analysis-original.log），无Codex或供应商实际调用。

### W1–W6 实施与统一自查

- [x] W1：`scripts/import-ui-design-source.mjs`、`runtime.ts`及runtime/library/requirements/visual-reference鉴权路由，私有10文件overlay和真实运行包组装；7/191/181/565对账。原ZIP+overlay+包内最小PDF依赖独立完整重建，与最终1519文件清单一致。最终runtime digest `db7bc360edb8a43f6388a7a3115e2bebd65fcce31b6e0854b2183263e332740b`；overlay digest `8087709c48d36c3845fb79e1fccd53e1363ed75c7dd962dfe173ebe53753f140`。
- [x] W2：`access/store/media/types.ts`、workspace/bootstrap/media、同源`UiDesignFrame`；本人命名空间/CAS/鉴权/Asset/use-only，旧库显式导入与历史逐条新副本保原外部原号。`uploads`实际保护链复用主控证据。
- [x] W3：`analysis.ts`和analyze路由，真实Codex text/image转换、原schema/补漏、多轮完整上下文、每组三屏同视觉方向、保部分与按原ID恢复；原LLM owner-only不变。
- [x] W4：`task-source/generation.ts`、quote/submit/status及共享tasks/billing helper可选服务端来源，原号先存、原报价/素材顺序/上下文冻结、真实确认后CAS领取、未知只查与原耐久安全结束；不借characterLabPlanId。
- [x] W5：私有sd2-adapter/provider/workflow完成多屏、已成功/未知/未受理分别处理、选中屏精修、原Asset直接交付、停止/重报价；export路由离线HTML/ZIP读取本人实际成品并报缺项；归档保任务/映射/账本。
- [x] W6：navigation与原完整工作台整合，原结构/勾选/对话/历史/图库/预览/上传/导出保留；分页/冲突草稿/账号隔离、旧外部只读、本站素材选择与模型刷新。结果contain/操作归位，在线Figma与网站截图不可用时保离线/上传恢复。
- [x] W7：定向工程、隔离候选、主流程自测及支线推送完成；不同阶段Linux与正式环境未验边界见§9。

最终定向脚本exit0，回执 `.private/ui-design/engineering-3jONpd/result.json` 对应最终runtime；覆盖认证、匿名/外部/换号/Origin、运行白名单、真实保存引用恢复/SI/选屏/分析顺序、个人库与旧历史导入、共享use/撤权/禁止原件、CAS/分页/归档、双窗口单次派发、未知/安全封口、实际共享helper UI隔离与普通默认、20000接受/20001拒绝、0任务/余额未变。原分析6项补漏/schema等离线用例PASS；PDF证据hash匹配复用，不重复同模块加载。

统一自查R01–R10：逐项回到实际路由、shared helper及私有overlay，补正上传结构内存库覆写、导入丢历史/覆盖个人库、外部旧批次继续按钮、精修继承参考丢assetId/referenceImageId四处实际问题。没有新增全局权限/数据库/worker/发布流程；共享原默认调用未带UI来源保持，实际quoteOnly快照已证。CodeGraph实际工作树ensure成功：7bd4a4aa3、2187文件、hashMismatch/missing/parseError皆空；context精确查询命中resolveUiTaskSource→readUiDocument，关系回源码确认。未用旧根索引，未另派审核。

私有交付完整说明见 `docs/ui-design-candidate.md`；待主控按 `.private/ui-design/delivery-inputs.json` 将最终runtime、10文件overlay、重建脚本和无账号回执归档到既备delivery目录。尚未由本执行者稳定归档，勿拷env/login/DB/日志/失败依赖或重复ZIP。私有包已冻结，后续如工程未要求实际变更不再改包。A01–A07仍全部用户手验，无收费/浏览器/部署证明。

主控已按db7bc360/overlay8087709c开始稳定delivery归档；本会话冻结私有runtime/overlay，不作静默变更。Linux build继续原进程，已过usage-report-admission等内置检查；未结束前不报exit0。候选配置/数据隔离及私有登录入口已写交付说明，公开记录没有密码。

### Linux首轮失败与原工程环境补齐

首轮`npm run build` exit1，原pricing-policy门真实通过；失败清单为multiview-private-batch、multiview-flow、private-prompts。实际日志查明：Linux必须提供专用MULTIVIEW_PRIVATE_FIXTURE_ROOT；backup验证要求该目录在真实/data且0700；works-runtime夹具另外硬要求源码canonical为 `/data/video-api-debugger/managed-releases/<40位source>`，原build-work不符合。不是UI源码断言失败，未修改这些夹具/业务或跳门。

已核source槽原先不存在，仅新建未激活独立候选 `/data/video-api-debugger/managed-releases/7bd4a4aa3e41d1e8e04064c0dcc1a5e4fa0a5a60`，由同一公开archive重组，从本任务首轮独立依赖复制为独立inode并在目标再generate。新建run/source绑定的 `/data/video-api-debugger-engineering/private-<run>-7bd4a4aa3e41d1e8e04064c0dcc1a5e4fa0a5a60` 0700/gouki，与pricing prepared run一致。此路径只是原夹具的工程源码位置，不调用发布器/服务/current链接/timer。第二轮继续原`npm run build`，其标准prebuild无逐项续接入口，因此必须由原入口重跑内置门，未手动重跑其它已匹配检查。首失败保留在原build-work日志/failure-report.json。

私有runtime/overlay未变。主控已完成稳定delivery逐文件校验与归档，具体归档hash由主控回写，不在本会话重复打包。候选仅本地3316本人开发进程改为nohup启动，PID记在忽略目录candidate.pid，避免工具会话结束后预览消失。

### 编译后实际运行差量（私有包不变）

检查Next实际生成的route.js发现原动态createRequire(path.join(...))被Webpack转换为 `undefined(...)`，静态tsc和tsx工程脚本没有覆盖这一编译行为，会阻断私有解析器。`runtime.ts`改为`process.getBuiltinModule('node:module').createRequire`，仍先原白名单/realpath/hash校验。已在真实工程机Node20.20.2执行该createRequire类型检查，结果function；本机Node22.22.2匹配。私有runtime/overlay摘要完全不变，不重打包。

补实际编译后工程请求时，同源Origin还暴露Next内部nextUrl.origin归一化与实际Host不一致的403；仅UI access沿已有multiview-settings-api同源语义改为Origin.host对实际Host并拒cross-site，非法/缺Origin仍拒。隔离脚本模拟不同内部URL与实际Host补证，不放宽身份/素材权限。

使用已创建的独立零余额工程账号，经本站真实登录后的Next编译requirements路由读取TXT，HTTP200，正文严格为`Compiled private loader smoke`；`compiled-runtime-evidence.json`不存cookie或密码，无浏览器、供应商或PDF重复提取。这是新loader实际运行证，不拿普通静态导入冒通过。最终Linux产物必须包含本次公开宿主修正；7bd只作首轮私有importer及历史构建基线，后续新commit构建继续，不报旧源码为最终通过。父侧materials/index.md及push/归档状态由父负责，本会话不stage。

最新公开宿主提交 `99db202c3177dbb1f2fa9b78acf784b1673af5dd` 已形成（未push），仅runtime/access和定向检查增量。tsc再次exit0；完整定向脚本exit0（engineering-lka4eS/result.json）；Next编译TXT实际HTTP200已证。新Linux候选已按7bd公开archive加 `git diff 7bd..99db --name-only` 精确三文件delta组装99db，未复制额外脏改；目标`managed-releases/99db...`、独立客户端已再generate、新prepared/private fixture按run/source绑定。为避免同时占用工程机重门资源，等待原7bd环境修复轮结束后自动执行99db标准build；该等待有180秒上限，不阻塞其它交付记录。最终以99db产物为准。

99db已实际进入标准build/prebuild，不再处于180秒等待；旧7bd规范路径轮exit1，flow/backup/private-prompts和pricing均已通过，仅works-runtime夹具仍失败。没有继续盲试：在flock保护的独立probe直接打印原runtime异常完整stack，定位sourceBytes:87。实测新候选源码0664、nlink1、hash正确；root解开git archive保留group-writable，而原runtime要求mode&022=0。99db本轮同夹具JSON也已失败，故精确核cwd=99db的本任务gate PID和synthetic子进程后停止，不浪费等待其余已匹配检查。保部分失败JSON/log与停止exit；仅新候选追踪源码去group/other写位，未改bytes、父目录、共享权限、运行服务或timer。单独失败runtime确认后，用新run/root输入继续原标准build；不弱化源保护或改断言。

源码权限定向修复后，原 `multiview-works-runtime-engineering.ts` exit0，真实once/heartbeat/heartbeat-failure/unlocked/symlink/permissions均PASS（99db候选runtime-after-seal.log及其evidence receipt）；无源码或断言变化。99db的runtime.ts/access.ts/check-ui-design三文件已逐hash与本机一致。原99db失败轮停止exit143（build-before-seal.log/exit），不能冒工程通过。

现已使用新UUID的prepared/private fixture重新启动99db `npm run build`，当前实际stage为prebuild，build.exit尚未产生。依然仅一个重门进程。当前候选源mode644符合原护栏；原门和完整Next build均保持。稳定私有runtime/overlay不变，候选本机独立会话PID18683/PPID1仍存活。

最终Linux build继续prebuild，未有最终exit；为Next构建读目录提供本候选专属`engineering.db`空库（已只读确认4096B、0表），仅对这份空工程库沿现有Prisma db push --skip-generate建当前schema，不拷账号/配置/业务数据，不generate共享客户端。原门各子夹具仍使用自身隔离库。

最终源码99db的实际标准门目录为 `.role-tests/image-recovery-gate-LP9LVL`。该轮private batch JSON已completed=true、7项全通过，之前的源码组可写阻点已在原完整入口得到通过证据；当前build.log已进入works-engineering完成后继续其它内置门。build.exit仍未有，未标W7完成。99db CodeGraph最终ensure同工作树成功（2187文件、hashMismatch/missing/parseError空）。

99db最终原prebuild已完整通过并由原验证器复核：`Image recovery build gate verified`。真实pricing receipt为 `.role-tests/pricing-policy-gate-C9BM7i/receipt.json`，完整门receipt为 `.role-tests/image-recovery-gate-LP9LVL/receipt.json`（均在99db隔离候选）。当前实际进入 `next build` → `Creating an optimized production build`，尚待整体exit与BUILD_ID；无切流。

99db原prebuild回执统计：17 fixtures + 17 publicUsageFixtures全部完成，pricing也已通过；完整门receipt SHA256 `110baf38eb30f94e502cffce8edfabe7a14fa6a41bafe1e0ffaffb752c467fa3`，pricing receipt SHA256 `f11b2b74d2bf622f8aa54567d47fdf486f5be77bf2ea2f9a7e3aeb738b6367d2`。Next已结束优化编译进入lint/typecheck；仅见已有角色融合CSS autoprefixer等警告，没有新loader转换警告。整体exit/BUILD_ID仍待产生，未切流。

### Next类型子进程内存失败（不冒绿）

最新实际stage停在Next lint/typecheck，已核具体进程而非静止等待：Node20子进程892971的GC记录约2028MB后`FATAL ERROR: Ineffective mark-compacts near heap limit ... JavaScript heap out of memory`。外层npm返回0，但没有`.next/BUILD_ID`、没有最终页面构建清单，按失败保留，绝不把外层0当完整build通过。主机16GB、实测MemAvailable约10GB，未见第二个构建进程。

依主控“复用已过证据/不重开整轮”，不重新跑已通过17+17/pricing门；保留原npm build.log/exit0（异常首证）。用原`check-image-recovery --verify <LP9LVL receipt> --since <原startedAt>`核源码/run/receipt仍相容后，只给同一99db的失败Next构建步骤设置`NODE_OPTIONS=--max-old-space-size=4096`，沿原build脚本的next build继续。无源码/平台/断言变化，无全局Node配置，不扩大生产内存或服务操作。最终仍必须取得Next exit0、BUILD_ID和完成清单；当前未达W7结束。

原gate --verify再次实际返回`Image recovery build gate verified`（gate-reverify.log）；随后只续跑 `NODE_OPTIONS=--max-old-space-size=4096 npm exec -- next build`。当前Next类型worker PID900187实际R运行，过滤读取其NODE_OPTIONS确为4096，VmRSS约2.59GB，已越过原2GB失败点；不是静止等待，也未并行另一个构建。退出/BUILD_ID仍待实际产生。

4GB Next续跑已越过类型检查，实际输出`Generating static pages (105/105)`完成，当前`Finalizing page optimization / Collecting build traces`。原2GB worker已退出，未有新错误；仍等最终exit和BUILD_ID。

### 用户指定费用文案差量（解冻仅此一文件）

主控新增明确修正：恢复/停止重报时，服务只派prepared，但旧确认标题/明细/费用用batch.jobs冻结快照全量，误含已受理/未知/拒绝项。仅私有overlay `sd2-adapter.js` 改为从/status实际 `initial.jobs[].job` 的当前state/quote筛prepared，显示本次张数及费用，明确其余不重发、已受理/未知仅查原号。服务器confirm仍原样传冻结batch.total/inputHash/revision，不改任何公开generation/账务/创建合同。此为已授权解冻，旧db7/808归档保留，manifest更新后在本节登记新摘要，不静默替换。

实际adapter VM确认弹窗工程检查exit0（confirm-copy-evidence.json）：① 状态混合且batch.jobs故意保全prepared/999旧价，显示仅当前2项2.35点，不露其它屏/旧价/整批43.85；确认payload仍43.85/原hash/revision，实际仅派该2原号；② 0.1+0.2显示0.3而冻结confirm.total仍88；③ 无prepared时不弹确认、不派发，仅原号查询。无浏览器/供应商/DB调用。仅此私有显示变化，99db完整Linux证据继续复用，不重新跑应用build。

99db最终Linux完整门17+17/pricing已通过；原门复核后4GB Next续跑exit0、BUILD_ID `GIUvF14tnqi2tbps1Z_a0`，105页、13个UI路由、生产bundle保原生loader。工程空库User/ImageStudioTask/Asset均0，未传私有ART，未切流。证据 `linux-build-evidence.json` 保留原npm外层0但worker OOM无产物的首失败，不用它冒绿。

主控同因追加的取消消息已逐字改为「报价已保留，本次待提交项尚未确认费用，未新增提交；既有任务保留原号」。第四个实际adapter取消场景exit0：当前有accepted/unknown/prepared，取消后文字匹配、0新增confirm/submit；前三场景仍PASS。仅该私有adapter一文件最终冻结刷新，0af为中间候选不作最终归档，最终以随后新摘要为准。


### 首次工程交付记录（历史，后续自测见§9）

- **W1–W6 源码落地**：沿 `codex/uiux-art-api-assessment-20261122`，基础实现 `7bd4a4aa3e41d1e8e04064c0dcc1a5e4fa0a5a60`，宿主加载／实际 Host 修复 `99db202c3177dbb1f2fa9b78acf784b1673af5dd`。保留原 7 套结构库及选屏、需求／参考、分析、逐屏生成、精修、历史和导出流程；分析与生图使用本站现有 API、权限、模型、报价、原请求和 Asset 链。没有把原 ART／修改后的原文件／图片提交到公开 Git。
- **W7 工程证据**：tsc、lint、账号边界检查 exit0；原结构／规范／预算等 50 PASS、2 SKIP，原分析 6 PASS；隔离真实实现验证保存恢复、共享 use／撤权、CAS、分页、归档、单次派发、未知／封口、20000／20001 和普通调用默认行为。实际登录后的 Next 编译需求解析 TXT 返回 HTTP200；PDF 原解析器／依赖摘要未变，复用真实提取原证。
- **最终 Linux 构建**：同一宿主99db，原17组夹具＋17组公开用量夹具及 pricing 门通过；核对原门回执后，以单命令4GB堆接续失败的 Next 步骤，exit0，BUILD_ID `GIUvF14tnqi2tbps1Z_a0`，105页、13个UI入口，生产bundle保留原生私有加载。早前外层npm0但worker内存溢出且无产物的结果保留为失败，不能拿它冒通过。工程空库User／ImageStudioTask／Asset均0，未传私有ART或操作切流。
- **续跑费用确认**：仅私有 `sd2-adapter.js` 更新，按 status 返回的当前 prepared 项展示本次张数／费用；服务器冻结 total／hash／revision、账务、派发和既有原号不变。实际 adapter 的混合状态、过期快照、浮点展示、无待提交项和取消四场景通过；取消不新增确认／提交，既有任务保留。
- **最终私有包**：运行内容摘要 `2880a0358be963351ca3c600b4ea9fa511500297a47993d747a2662ca55456b9`，overlay摘要 `0fd5ace3f273c78cb450d1eb78b00a9c053d4441e18d109143582582edd6bf61`。稳定目录 `/Volumes/Data/Downloads/uiux-art-20261122/delivery` 已保runtime、10文件overlay、重建脚本和无账号原证；最终压缩包 `ui-design-api02-v1.1-private-darwin-arm64-2880a0358be9.tar.gz`，369457110B，SHA256 `48df97f67850e96ad3aec51017b7a0b0a04df555bb96295a6e6d36d23f2412c4`，1532文件流式逐项校验通过。db7旧备份保留，0af中间版未归档；不含环境、密码、会话、数据库或日志。详[稳定交付说明](/Volumes/Data/Downloads/uiux-art-20261122/delivery/README.md)和[候选说明](../../docs/ui-design-candidate.md)。
- **本机手验入口**：[UI界面设计](http://127.0.0.1:3316/tools/ui-design)，独立空库／零余额工程账号／无真实供应商配置／无worker。登录说明仅在实际工作树 `.private/ui-design/candidate-login.txt`，启动为该工作树下 `bash .private/ui-design/start-candidate.sh`；nohup进程已与工具会话分离。此为可运行工程候选，不是正式数据或真实生图效果验收。
- **上传阻点与接续**：普通 `git push origin 99db...:refs/heads/codex/uiux-art-api-assessment-20261122` 实际失败于 TLS；已有7897代理 CONNECT503、系统fake-IP、GitHub连接器传输失败、既有工程机SSH连接关闭。尚未取得远端成功证据，不能写已推送。已请求恢复正常联网或明确授权调整现有全局连接；继续完成本地聚焦提交和可验证Git bundle，恢复后只普通push并核远端HEAD，不强推，不扩大为跨项目网络程序修改。

以上勾选仅指实施及相应工程事实。A01–A07 全部待用户手动验收，未自动收费分析／生成或浏览器功能验收；Linux只验证公开宿主，未验证Linux私有PDF包；网址截图无引擎时保留上传截图恢复。未合主线或部署。正式根原分支、index及非本任务脏改保持；当前仅同步本任务记录和索引。

本轮新增环境线索：出站网络异常影响上传，根因待核，见统一[发现记录](../discoveries.md#uiux-art-api02-network-20261122)；未据此认定代理产品缺陷或另行派工。


<a id="uiux-art-api02-selftest"></a>
## 9. 用户授权自测结果（2026/11/22 22:58:34）

用户要求“先安排自测验收跑通”，并确认验收窗口非本人关闭、允许重建。本次沿原支线完成实际浏览器自测、必要修复及单张真实 API 调用。主流程已跑通；未合主线或部署，最终视觉认可仍由用户决定。

| 原验收项 | 本轮证据与实际结果 |
| --- | --- |
| A01 结构库与选屏 | 7 套结构、191 原画板、181 可选画板、565 图片对账；浏览器完成双屏选择和单屏真实案例。未逐页评价全部画板视觉质量。 |
| A02 文档、参考与分析 | 原 TXT/PDF 工程证据继续有效；真实 gpt-5.6-luna 分析同时使用风格图与结构图。首轮字段错误后仅作一次完整 JSON 修正，原严格 schema/语义校验通过，两轮原答复保存；刷新未增加调用。 |
| A03 报价、取消、返图与费用 | 本地协议测试验证取消零任务、过期拒绝及同批重报价；真实单屏按最高/1K/16:9 确认5点。实际 FluxPort 返回1280×720 PNG，原任务成功、同页显示1/1。 |
| A04 部分完成与未知 | 双屏1/2→2/2、原号查询及不重发在协议和工程层通过。真实调用首次查询超窗，临时测试桥接遗漏回调；已备份隔离库、按真实原号GET取回同一图片，修复该测试记录后由未改动的宿主worker保存结算。全程仅一次生成POST；这不证明正式环境自动接续已经验收。 |
| A05 单屏精修 | 协议测试只修改Title屏，另一屏原Asset保持，共用视觉系统及美术方向继承；本轮没有额外收费精修或相似图片重生成。 |
| A06 保存、权限、恢复、导出 | 实际store/CAS/分页/归档/共享use及撤权检查通过；浏览器重开自动取回结果，并保持最后工作区。真实PNG下载与ZIP内PNG、宿主Asset字节一致；宿主PNG与上游PNG解码像素一致，ZIP CRC通过。 |
| A07 小屏与键盘 | 390×844模拟视口及结构选择器、键盘打开已核；最新参数区宽度390、无横向溢出，最高画质和16比例+自动均可达。不是实体手机验收。 |

本轮修正：稳定来源版本；报价失败保留输入/分析；结果原号状态恢复；旧Lovart文案与本站执行分开；分析错误可见且仅一次schema修正、每轮原答复持久保存；参数复用宿主目录；旧接口快照保留画质路由；参考图Asset序列化与分析缓存稳定；按账号记住最后工作区并同步其参数；图片下方重复说明归入详情；PNG下载直读原Asset。未放宽素材、价格、原号或schema校验。

**账务边界**：隔离候选获200个合成测试点，协议三任务结算15点、真实图对应的本地任务结算5点，余180、冻结0。调用现有真实供应商账户，但未写生产任务/点数账本，未核供应商实际账单，不能将本地5点当成供应商实扣证明。临时合成供应商配置已停用，测试桥接已停止；4个任务和成品保留，本机候选可查看和导出历史。

**工程与上传**：应用提交25dfb3c43b5731762ad0359a2c3f6b43b7de3ccb已普通推送既有origin并核远端同头。最新tsc/lint exit0；最终私有包对应9项定向工程检查通过，分析修正4项回归通过。99db的Linux17+17/pricing及Next构建证据仍为历史基线；最新应用增量未再跑Linux全构建，Linux私有PDF亦未验。未操作正式服务、current链接或timer。原根HEAD/index及16个非本任务脏文件hash保持。

**最终私有交付**：runtime 4e61d76fd6d8426b887bd034a3ee2df098c395aedb85daf442c237e89cd113c7，overlay 99d639a10eeb1df0628a6d346f3e53ef24de91e9b5fc98ced97f101fd00e57ab；ui-design-api02-v1.1-private-darwin-arm64-4e61d76fd6d8.tar.gz，365199281字节，SHA256 2328994bfa80192460ea974702367fbc3fe07d144e4a14b8210e821c538b3717，1534文件流式逐项校验通过。前版f4/2880/db7归档保留。原ART、覆盖文件、图片、PDF依赖只在私有delivery，不入公开Git；归档不含账号、环境、会话、数据库或日志。合并证据见delivery/acceptance-evidence.json，重建输入见delivery-inputs.json。

**剩余边界**：正式环境启用与自动接续、最新源码Linux全构建、Linux私有PDF、实体手机和用户最终视觉认可未验。在线Figma及网站截图引擎仍按既定范围使用离线库/上传截图。现网默认gpt-5.5返回“无可用通道”，本次明确选目录中合法gpt-5.6-luna，未改现网默认；见统一发现记录。


<a id="uiux-art-api02-regression-audit"></a>
## 10. 本次定向回归审查（AUDIT01，基于 c2ca5ce4d）

**当前结论：5项已复现缺陷，含2项P1、3项P2；尚未修复，完整验收未闭环。** 这些结果不否定§9实际跑通的单屏主流程，但说明它不能覆盖删除、历史恢复、原任务故障、断网草稿和真实旧工作台导入。此次仅核查、补验和更新记录，没有修改业务实现，也未重新调用真实分析/生图API。

**对象与版本。** 工作树仍为 `/Volumes/Data/HomeRelocated/gouki-youdoo/.codex/worktrees/uiux-art-api/video-api-debugger`，分支 `codex/uiux-art-api-assessment-20261122`，审查起点HEAD `c2ca5ce4d3a08861f2cdd63c7ef3a4b48138a9d1`，应用源提交 `25dfb3c43b5731762ad0359a2c3f6b43b7de3ccb`。基线 `bfcc1f779b24d4b069e19f3d335fd0b1dfad3df4` 至该HEAD共35个跟踪文件变化；本轮沿新UI模块与其对tasks、billing-quote、image-generation、navigation及私有资源路径的实际改动核查，没有全站扩查。私有runtime仍为 `4e61d76fd6d8426b887bd034a3ee2df098c395aedb85daf442c237e89cd113c7`；10个overlay与运行清单逐项匹配，§9对应源码/资源的有效证据继续复用。本机3316的实际Next进程cwd仍指向此工作树；它是本机候选，不是正式线上版本证明。

本节AUDIT01-1至5为新增问题编号，不替换此前R01–R10或A01–A07。

### 10.1 已确认问题与最小修法

| 编号 | 优先级 | 触发、实际结果与影响 | 因果位置与最小修法 |
| --- | --- | --- | --- |
| AUDIT01-1 | P1 | 当前A对话使用项目A/型号A，删除历史B时适配先打开C，随后把A保存成项目C/型号C。补验删除当前A后应进入B，也复现B名称保留但项目被改成C。下一次报价/生成会读取错误归属或参数；本轮没有真实生成或错扣。 | `build-overlay.py:42`把T.open放在判断删除对象/选择next之前；`sd2-adapter.js:85–108,151–160`的open会改全局项目/参数，save读取这些值。先沿原逻辑判断对象并选定真正的next，只有确实切换时才open；删除非当前对话不能改变当前绑定。改源覆盖脚本后再生成，不能手改运行产物。 |
| AUDIT01-2 | P1 | 已有设计保存后，从个人库删除其结构方案，旧设计重开报 `Cannot read properties of undefined (reading 'source')`。原ART删除只移除方案，历史帧仍完整；新压缩表示把冻结历史变成了对当前可变库的依赖。成品Asset/原请求没有被删除，但正常工作区恢复、查看/导出入口受阻。 | `sd2-adapter.js:36–43,69–80`把历史帧存为planId引用，hydrate直接依赖当前library.find结果。历史引用应按不可变原源/版本定位，并兼容旧引用；无法还原详细结构时仍须保留原结果和导出，不能丢run或阻断整份档案。不得改写已受理/未知任务的冻结正文。 |
| AUDIT01-3 | P2 | 原任务实际为 `sr_uncertain`，宿主公开状态应为uncertain，但新工作台仍显示running；任务failed时虽识别失败，原worker错误却显示为空。真实故障、费用待核对与恢复含义被隐藏。原任务/费用保护没有被补验改变，也没有发生重发。 | `generation.ts:111–113`直接投影内部状态且省略任务错误；`sd2-adapter.js:293–305`只区分成品/终止/受理，把已受理待核对归为运行。复用宿主公开状态及安全错误/恢复投影，区分提交受理与执行状态；已受理待核对仍只查原号，不能借前台清状态关闭原任务或释放费用。 |
| AUDIT01-4 | P2 | 工作区保存遭遇503时，内存中新选参考仍为1张；刷新后恢复成0张，只有修改后的文字留下。此前CAS/成功保存证据未覆盖这一故障条件。 | `sd2-adapter.js:154,170–171`本机备用草稿仅保存brief/designIntent/projectName。沿原IndexedDB保存按账号/工作区隔离的完整必要草稿（含引用及未上传文件），服务器真实保存成功后才清理；不把完整ART资料硬塞localStorage，也不替旧请求生成新号。其他非文本字段存在同类线索，但本轮直接复现的是参考选择。 |
| AUDIT01-5 | P2 | 直接导入原包的真实 `UIUX-ART.uiuxworkspace`（48,610,050字节、schema1、7库）失败413。观测实际待写入为47,729,706字符、无data:image、14个方案；触发的是4MB保护。默认7库直接选用仍正常，不能把它当成导入旁路已验。 | `sd2-adapter.js:209–224`用完整JSON比较源；旧`/api/figma-assets/`和本站受保护URL仅命名空间不同，却使7个相同源全部换ID、失去源引用压缩，产生大正文。先按原内容hash/源版本归一合法资源定位，再判断是否真正换源；保个人副本及原外部任务号，不通过放宽4MB限制掩盖问题。 |

**复现方式与原证。** 使用当前未改动的adapter、原ART删除/结构函数及实际store，在新建空SQLite中执行；删除逻辑含集成前函数对照，另补当前删除后的next交接。不是浏览器实页或正式环境验收，不把DOM替身当点击证据。证据在本机忽略目录 `.private/ui-design/audit-20261122/`：`handoff-evidence.json`（AUDIT01-1–AUDIT01-4）、`active-delete-evidence.json`（AUDIT01-1另一状态）、`import-evidence.json`/`import-write-shape.json`/`import-source-equality.json`（AUDIT01-5）。7个原源逐一核对：归一URL命名空间后内容完全相同。首轮夹具初始化/序列化失败日志保留；按仓库既有独立空库和真实serializer接续后才形成上述结果，业务源码和保护断言未放宽。

### 10.2 仍有效或新增通过的边界

- 复用同版9项工程、实际原号/CAS/分页/权限、TXT/PDF及单屏真实返图/下载原证，不重跑收费生成或已结束任务。共享tasks和billing helper的UI来源为服务端可选参数；没有UI来源时的原默认上下文/参考行为仍沿既有实际helper证据，不能把它外推为所有入口全量回归通过。
- 新补非空共享use-only参考在真实事务内的调用：原Asset owner保持，冻结内容被换拒409，身份不符拒403，撤销use后新调用拒403；旧无qualityRoute与新带max/revision的快照reader均通过。0任务、0信用/成本账本写入。`transaction-evidence.json`对应实际resolveUiTaskSource与事务贯穿，不以空共享数组冒通过。
- 已受理任务的worker、delivery、async-recovery、Prisma schema、package/lock和发布脚本没有本次差异；冻结版本读取与新提交时的鲜核仍分开。没有修改或重启旧请求、清租约、重置预算、回退生产数据、操作正式服务/current/timer。对旧已受理路径的结论是源码合同与仍有效原证，未新跑生产在途任务。
- 只读核对现有候选：仍4个succeeded任务，余额180、冻结0、合成任务点合计20；两个临时测试供应商仍停用。新增补验只写独立空库与本机证据，未写现有候选/生产账本。正式根HEAD/index及16个非本任务脏文件与前轮保护快照一致。
- 本轮没有业务版本变更、打包/发布、浏览器接管或服务重启。原1534文件私有归档及其SHA保持；额外Git备份的旧未核验状态保留，没有恢复那项已停止的检查。记录更新只需文档提交推送，不触发应用发布。

### 10.3 待核线索及剩余缺口

- **导入后的原库图件定位（待核）**：导入会更换个人planId，而T.attachment仍将它交给只认识原库planId的取图入口。当前真实导入已先被AUDIT01-5阻断，尚未走到相应报价路径；不能写成“已复现404”。修AUDIT01-5时须接着验证原图取件/角色顺序，而非只以不再413结案。
- **非文本草稿其他字段（待核）**：AUDIT01-4已直接复现参考选择丢失；选屏、未上传文件与参数的具体恢复组合尚未逐项实测。完整草稿修法应覆盖实际需保留字段，按账号/工作区隔离，不能仅补一个visual字段冒通用恢复。
- 正式自动接续、最新准确宿主源码的Linux全构建、Linux私有PDF和实体手机仍是旧未验边界；本轮没有把它们改成通过。此前文本默认型号不可用只保留历史记录，不凭旧记录重启模型维护或收费调用。
- **修复未实施。** 建议先处理AUDIT01-1/AUDIT01-2，再处理AUDIT01-3–AUDIT01-5，并沿以上准确故障条件、相邻正常路径和旧引用/旧快照复验。只读已有成品验证恢复/导出，不重发已受理、未知或已结束原号，不重新生成相似图片。5项未修及上述关键缺口未补前，不报完整闭环或正式验收通过。
