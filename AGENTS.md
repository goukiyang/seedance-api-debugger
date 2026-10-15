# AGENTS.md

## 交付方式（2026-09-29 用户确认）

- 本项目默认由用户手动验收。Codex 不主动执行功能验收、浏览器操作/截图验收、生成调试或自动回归验收，也不自动派审核线程；用户后续明确要求测试、排查或审核时，再执行该次指定范围。
- 实现完成后自动聚焦提交、推送并部署到现有正式服务器，不等待用户验收或二次上线确认。用户明确要求只规划、只本地、暂停或暂不部署时，遵循当次指令。
- 保留发布必需的候选构建及其内置检查、版本/构建一致性、服务健康与公网可达性检查、持久数据保护和回退点；这些是部署检查，不是功能验收。构建失败、服务异常或存在明确数据/权限风险时，不强行上线，保留或恢复原运行版本并说明原因。
- 上线后回执写“已部署，待用户手动验收”，附版本、入口及未解决问题；不得把构建成功、进程健康或发布成功说成“功能验收通过”。
- 本节替代项目此前的自动验收、强制审核及等待验收后部署要求；不扩大付费、权限、生产数据覆盖、删除等高风险操作授权。仅规则/文档修改时提交推送即可，不为此升级应用版本或重启网站。

## 项目身份

- 新保存封面正方形（2026-10-14用户明确授权COVER02）：新保存及草稿裁剪预览为1:1，1280×1280成品和640×640小图；旧4:3配方/封面/原图与历史保留，不批量重裁。v1旧记录和已存在原保存回执按原1280×960/640×480、裁剪/指纹/requestId查询重试；新v2才用方图，无原回执的旧客户端4:3新写安全拒绝并说明升级，不静默改请求。打开旧封面只读与新方形草稿分离，旧4:3裁剪不直接当方形恢复，自动裁剪回调不触发保存；用户显式保存才生效。源归属、共享/原图权限、账号/目标隔离、未知保护与成功关层保持。此条取代先前“新1:1裁切未授权”约束，历史发布事实保留；正式永久封面原单COVER02追加及固定todo为入口，功能用户手验。

- 模板自主删除与封面入口（2026-10-14用户授权DEL02等联合批）：侧栏真实删除本人工作区，虚拟本人源沿原件删除权限，不把隐藏冒充删除、不因管理员身份开放他人原件；素材、已生成结果与历史保留。删除/所见版本/原请求回执及旧ID防重造记录同事务；自动恢复仅读现存工作区，只有再次显式选用才新建新代次，旧open/save/delete不作用于新工作区，未知只查原GET不换号重发。旧DEL01清理不重跑或补写生产标记。模板结果卡保留型号/分辨率/版本码/近时，去序号及常驻供应商/画质；普通/喜欢封面置顶和本人删除入口复用原菜单/确认。模块封面显示1:1 contain，居中设置弹窗鲜读真实当前封面，固定失权不回旧图；新保存比例已由后续COVER02授权更新，旧4:3历史与原图保留。素材筛选按实际交集表达，显式查看全部不扩调用用途/权限；原缺图对象未指认不冒称根因已定位。正式删除文案单§9、结果封面单、生成选择器原单与固定todo为入口，功能用户手验。

- 作者修复失效固定参考（2026-10-14用户授权FIXREF01）：仅服务器新鲜身份、真实source owner和publisher绑定确认的本人原模板失效槽位可移除或一对一替换；预览受保护不等于失效，数据库/网络未知不授予修复能力。不开放他人模板、正常固定项新增/改序/备注或原图读取；原管理员权限不变。替换素材沿原可访问/可用限制，服务器提交时重核失效和版本、保合法项/相对顺序/原备注，完整最终定义校验失败则整次保存拒绝；不保留坏ID特殊保存、不自动重共享或生成。正式共享生命周期工单FIXREF01追加与固定todo为入口，功能用户手验。

- 模板封面与未保存免打扰（2026-10-13用户确认并授权落地）：封面浏览沿认可R01，大1:1外框contain已有成品、短底栏，完整授权目录先过滤排序再分页；最近使用只记录本账号本浏览器主动成功进入或新生成受理，不拿轮询/部署时间当历史。我的与共享按真实目录归属/共享状态，不能以管理员可编辑当本人，保留返回现场和重置。用户已选B：本模块未保存模板定义不提醒、不因dirty挡生成/报价或关闭离开，不自动保存发布或丢弃；新生成一律服务器确认的保存定义，个人本次主图/描述/临时参考/参数仍当前值，单张/批量/计价签名及计数同口径。静默草稿、显式保存及真实权限/费用/素材/上传保存中/requestId未知保护保留；不把免提醒扩到独立通用设置或其他页面，也不因升级提醒重加本模块dirty导航注册。历史复现仍冻结原来源。正式根PRE工单§8/10、固定todo及私有implementation为入口，实际功能用户手验。

- 界面轻量控制（2026-10-13用户确认）：模板结果点赞/置顶回到封面左上角，未激活悬停或聚焦显示，已激活各自常显；背板视觉缩小30%但保留触控命中，置顶仅图标且保留可访问名称，第三方Pinterest不改。风格组移除当前引用用卡片右上角按需X，添加用图片式方块，取消中间常显标题/说明；此为原UI01标题/添加布局及PIN02底部常显的后续替代，不删底层选择/共享能力。左栏拖动由按需手柄启动，键盘/触摸等价可达；移除重复导航不等于删除模板/历史/资产。查看个人信息用站内弹层不导航，真正切号保留未保存保护与账号隔离，退出未知不冒充成功。比例卡片仅点击展开，16标准项及auto和实际参数不变。正式根高清工单17.10.8及固定todo为本轮证据入口，功能仍用户手验。

- 新模板默认共享（2026-10-13用户确认）：明确新建的模板默认共享给现有授权同事范围，仍可关闭；首次有效主动保存发布模板定义，后续定义保存更新同一原件。关闭选择须持久保存，私人另存不在之后保存时意外重新共享；个人描述、主图、临时参考、结果和旧私有/隐藏/撤回内容不自动公开。沿用原共享权限及保存失败保护，不批量改历史。详情见正式根F24工单SHARE01与固定todo。

- 精确上传与比例（2026-10-12用户确认，2026-10-13交付及纠正）：只解决相同字节安全复用、并发重试与当前目标关联，相似识别移出范围且保持OFF；不同字节正常新文件，不跨账号或恢复隐藏资产。上传必须保留原请求ID，只有服务器证明尚未写入才可主动恢复；在途、写入未知和旧无证明票据不得超时解锁或自动重发。比例形状＋文字卡片仅在下拉层展开，全部16标准比例及auto可选，不因供应商/型号能力元数据未登记而禁选；保存、提交和执行保留选择，旧受理快照不改，实际上游拒绝如实说明，不静默替换或重发。原像素、权限、费用及输出完整性保护保持；此前仅开放两型号的解释由RATIO02替代。放大预览点空白关闭而拖动不误关。实施与手验沿正式根固定todo及原工单，功能仍待用户手动验收。

- 模板与素材选择区（2026-10-12用户确认）：素材来源直接常显小页签，保留原分类/类型条件及模板子筛选，不缩成隐藏下拉；模板工作台的模型、图片质量、分辨率紧凑同排，非模板供应商设置不改。风格与文字组共用一个全宽选择区，显示“风格与提示词”；原 Skills 仅是提示词组，不是自动执行技能，相关选用/详情/管理称“提示词组”，内部ID、顺序、版本、接口及历史不迁移。保留额度、共享权限、独立查看/移除和保存恢复。细节与三张原图见正式根统一选择工单第10节、素材库UI01追加及固定todo，实际效果仍用户手验。

- 模板结果置顶与等待条（2026-10-12用户确认）：模板结果卡点赞右侧改为单张置顶，仅该结果本人置顶/取消；同模板有权访问者可查看和点赞被置顶输出，不带出私有任务、输入、提示词或原件下载权限，不向全站公共图集/匿名开放。取消置顶不撤销既有公共分享；跨用户结果仅走显式新feed及只读输出投影，旧客户端和回退须保留新后台数据/权限合同。生成等待沿原真实受理时间显示平稳百分比，前5分钟短时查询异常不提前替换等待；正常待处理继续等，真实失败或取消立即显示。仅本次待处理转为合法可下载结果时短暂补满100%再结束等待，下载即时可用、清除过期错误；历史完成不重播，刷新不重计。2026-10-13用户WAIT05最新追加取代同日无百分比方案；不另加模拟文案，不让未就绪结果到100%，不改真实状态/收费。细节与手验沿正式根分享工单PIN01/PROG01追加及固定todo。

- 飞书登录长期授权（2026-10-11用户确认）：本项目正规飞书SSO登录失效时，优先复用电脑已登录飞书；确认目标为`sd2.youdooart.com`、既有账号、同一应用及原权限范围后，可直接点击正常授权登录，不重复询问。遇验证码、2FA、本人解锁、新应用或新增权限时停止相关动作并交用户处理；不读取或导出密码、Cookie、Token，不绕过安全拒绝。此为长期操作授权，不表示登录凭据永久有效；已登录时不为核对而重登。
- 项目名称：video-api-debugger
- 项目类型：用于调试视频生成接口、任务状态、资产上传、用户点数与后台管理流程的 Next.js 应用
- 技术栈：Next.js 14 + React 18 + TypeScript + Prisma + SQLite
- 默认协作链路：明确任务边界 -> Codex 实现并自动部署 -> 用户手动验收；只读审查仅按用户明确要求安排。

- 模板主图与登录落点（2026-10-11确认，2026-10-12澄清输入主图）：普通首页登录成功进入创作首页`/`，合法显式站内目标优先，真实入口包括首页转到的`/register`；不因此改变注册或鉴权流程。恢复某张结果的设置时保留当前主图，其余合法参数、参考及风格组恢复；新快速设置不保存主图，旧快速设置读取忽略主图，不删除历史资产或普通草稿。普通模板/工作台及批量结果的双击回填，取该次任务冻结快照中实际使用的直接输入主图原件，不是生成输出、不递归祖先，也不用辅助参考/风格图兜底；生成图曾作为该次输入时，它就是合法直接主图。多张输入由用户明确选择；纯文生图无主图、旧记录未标角色、源图失效/无权读取、切模板或迟到返回均保留当前现场并说明。单击预览、不生成不扣费保持；人物/抠图/画布原双击放大或编辑语义不改。详情及手验状态沿正式根固定todo的MAIN01、UX01–UX05和生图工单13.11，私人资料不随源码公开。

## 主要目录结构

- `src/app/`：Next.js App Router 页面、布局、API Routes 与 `middleware`
- `src/app/api/`：服务端接口，包括鉴权、点数、后台用户、视频任务、资产、工作区等路由
- `src/components/`：前端交互组件与生成器工作区相关 UI
- `src/lib/`：数据库、鉴权、Provider、价格、任务状态、资产与工作区等共享逻辑
- `src/lib/auth/`：登录态、密码与 API 鉴权辅助逻辑
- `src/lib/provider/`：外部视频/资产 Provider 适配相关逻辑
- `src/lib/assets/`：资产归一化、集合、工作区、快照与仓储逻辑
- `src/types/`：项目共享 TypeScript 类型
- `prisma/`：Prisma schema、迁移与 SQLite 数据模型
- `scripts/`：管理员种子脚本和外部 API 测试脚本
- `docs/`：工程协作、任务模板、执行记录等文档
- 根目录配置：`package.json`、`tsconfig.json`、`next.config.js`、`README.md`、`SPEC.md`

## 常用命令

- `lint`：`npm run lint`
- `typecheck`：当前未发现独立脚本
- `test`：当前未发现通用测试脚本；仅发现 `npm run test:api`，该脚本面向 Seedance 外部接口调试，不应默认作为本地回归测试执行
- `build`：`npm run build`
- `sd2` 服务器状态：`ssh gouki@42.193.221.253 'systemctl is-active sd2-gray.service && curl -sS http://127.0.0.1:3302/api/config'`
- `sd2` 公网验证：`curl -sS -D - https://sd2.youdooart.com/api/config -o /tmp/sd2-public-config.json`
- `sd2` 服务器部署：按本文件“sd2 服务器生产托管规则”执行本地提交、归档上传、候选构建、服务重启、公网验证和回滚保护；不再用 Mac `youdoo-sites` 当生产部署链路
- 数据库相关脚本：`npm run db:generate`、`npm run db:push`、`npm run db:studio`，默认不得执行会修改数据库状态的命令

## sd2 服务器生产托管规则

- DEL02/CAP01/COVER01/结果入口/PICK01已保护部署（2026-10-14）：实际源`9ab819c91f0c9119597821d178391c4506bb7676`、v0.89.0、BUILD`SPpqZcC0YErOcg-Y1-90L`，web158327/image158376及自然sender同根真实/data，19:15:33Z同run窗口结束；功能用户手验，原缺图对象/授权HTTP未核实，COVER保存1280×960不变。两完整主/guard构建与内置检查/源码Review、公网及主管运行薄核有证；相容guard`4200e9dee01e091f197858b8921dcbae146c5953`/v0.88.0+studio-delete-guard.1/BUILD`MY9y4XdjBmBvI5jR-nzOr`保14后台合同与旧UI只读保护，旧UI两写入口（nonce删除/缺工作区选用）暂不可用，须恢复新主client、不能仅刷新guard，未演练。完整原d58源/构建/自身依赖/0600配置留本run stage；鲜核源/BUILD/配置/未知请求与单窗口，自然排空成套web/image/sender到相容guard，不直接退d58或回DB/素材/审计/回执/control、重发或重跑DEL01。HD原af/flock2872537/Node2872539/Invocation及动态v2、role047/128、DB64784:171442216/env/nginx/原件/配置/导航/相似OFF保持。正式删除文案单§9/固定todo/私有closure为入口，安全文档HEAD不改运行源/版本，后继仍鲜核。

- FIXREF01已保护部署（2026-10-14）：实际源`d58e2ba25eb5a175652edc4b21c9691c7dfedc41`、v0.88.0、BUILD`bRN0cyw1DnC-XAEH5Eao7`，web53203/image53296及自然sender同真实/data；17:25:33Z同run窗口完成，功能用户手验。相容guard`a066299b55c366894133828906701e2761189eaf`/v0.87.0+author-fixedref-guard.1/BUILD`a88oGix8Zf8QHtY4DfT8p`独立实建，保13后台合同及旧UI只读媒体/备注保护，旧UI无新槽位按钮；完整5dcf原源/构建/自身依赖/0600配置保留author-fixedref-repair-20261014 stage。后继鲜核源/BUILD/配置/原ID未知任务与单窗口，自然排空成套web/image/sender，只选相容guard，不盲退5dcf/af6a，不回DB/素材/audit/receipt/control或重发；HD原af/v2自然推进与role047/128不动，未演练。原单§12/固定todo/私有closure为入口；安全文档HEAD不改变运行源或版本。

- PRE01/PRE02已保护部署（2026-10-13）：实际源`bf349c5aba91d98dfdf7d5e0e711d6079029b8b0`、v0.86.0、BUILD`TYk-r0K5OqkcCtpiVRP4p`，web3571659/image3571759及自然sender同根真实/data release；04:42:09Z同runId窗口完成，三远端标签已确认。大封面/完整目录本机浏览及B免打扰已工程交付，功能待用户手验；完整候选内置类型lint/六TS覆盖、lead非独立Review、1195源/39静态/9原访问保护/37启动模块及主管薄核有证，功能矩阵明确skipped/0。首81fab Set展开类型失败保留，一次编译修正后整批R2 exit0，不改编译开关/依赖、不反复抬号。662后台/API/worker/Prisma合同不变，0Browser/功能回归/收费生成/生产造样/DDL。HD原af750219/flock2872537/Node2872539/Invocation799d7e741a894bed88c48629109615ca及动态v2自然推进，不停启/覆写control；角色047/128、DB64784:171442216/env/nginx/原件/配置/导航/相似OFF保持。完整9053/v0.85.2/BUILD`IWMXZ-Xvr2ZGZha9uQx3j`及自身依赖、0600构建/配置留真实/data的cover-unsaved-20261013 stage；鲜核源/BUILD/配置/未知任务/窗口、自然排空后成套web/image/sender回退，不回DB/素材/任务/通知/HD/control、不重发，后继漂移停止自动回退，未演练。正式根PRE单§10/固定todo/私有closure为入口，文档HEAD不改变运行源/版本，原root脏改和资料不整树公开；下方均历史，后继仍鲜核。

- WAIT05/FEED48-01真实验收修正（2026-10-13）：运行源`9053ca6943f8474a7f527fba5246a630af7daade`、v0.85.2、BUILD`IWMXZ-Xvr2ZGZha9uQx3j`，web3491769/image3491819及自然sender同根真实/data；03:13:57Z窗口完成。两项真实核心PASS，新ready页无过期红字；保存期只读显示修正有两目标/完整构建/1191源/38静态/9保护/37模块证据，未额外收费重放，不改worker/账本/权限/FEED。HD原af/PID/Invocation/v2、role047/128、DB/env/nginx/原件/配置/导航/相似OFF保持。完整38e/v0.85.1及0600备份留generation-wait-save-display-20261013 stage，鲜核自然排空成套回退，不回DB/control/素材或重发，未演练。正式原单§7.4/固定todo/私有acceptance分列工具缺口；RATIO不扩验，文档HEAD不改运行源或版本，下方历史。

- WAIT05/RATIO01/FEED48-01已保护部署（2026-10-13）：实际源`38e2c565f919e2ce337bbb2af16eb8d90914e212`、v0.85.1、BUILD`0KZ6FhTuo7VFujTYWkiw6`，web3030857/image3030907及自然sender同根真实/data release；18:13:30Z同runId收尾。等待条下平稳百分比、合法可下载后补满100%清旧错误、比例仅分组、复用等待初始化/保真实冲突/实际应用才消费来源；未知复用只核对不重发，专用未确认URL被旧v85忽略。原reuse仅补已授权参数投影/无写409与真实分支，生成/收费/权限不改。8组离线工程/完整构建/非独立Review、1190源/38公网静态/9原访问保护/37启动模块及主管薄核有证，功能待用户手验；首轮两fixture错误及一次修正原证保留。HD原af750219/flock2872537/Node2872539/Invocation799d7e741a894bed88c48629109615ca及动态v2保持，不停启/覆写控制；角色047/128、DB64784:171442216/env/nginx/原件/配置/隐藏导航/相似OFF不变。完整1ecfbc/v0.85.0/BUILD`yZG62xNywyueUwRj2Qs2V`、自身依赖及0600构建/配置备份留真实/data的generation-wait-ratio-reuse-20261013 stage；鲜核当前源/BUILD/配置/未知任务/窗口，自然排空后成套web/image/sender回退，不回DB/通知/HD/素材或重发，后继变化停止自动回退，未演练。正式同名工单§7.3/固定todo/私有closure为入口，私人资料不公开；文档提交不改运行源/版本，下方均历史。

- MENU-P1–P3已保护部署（2026-10-13）：实际应用源`1ecfbc366857c36195b06c9e542c66f338857eee`、v0.85.0、BUILD`yZG62xNywyueUwRj2Qs2V`，web2954283/image2954398及自然sender同根真实/data release；16:49:40Z同runId收尾。仅templateWorkbench普通/喜欢结果封面启用右键/长按菜单，常驻交接控制器与卡片反馈复用旧回执链；删除仍原确认，恢复保主图，权限/费用不扩，点赞置顶及其它页面入口保留。三组离线工程/完整构建/非独立Review、1181源/29公网静态/7原访问保护及主管薄核有证，功能待用户手验；首轮fixture编译失败与缓存/标签时序误判留证。HD保持`af7502195cf9ba4e3b8300bf066ce064d9b536c6`原flock2872537/Node2872539、Invocation`799d7e741a894bed88c48629109615ca`和`hd-control-v2`自然进展，不停启或覆写control；角色047/宿主128、DB64784:171442216/env/nginx/原件/配置/两隐藏导航及相似OFF不变。回退直接复用完整af/v0.84.0/BUILD`sRr4tpyQFrciviZsc8Mqj`及其原依赖、0600构建/配置备份，真实/data的result-card-context-menu-20261013 stage已核相容，不新建guard；鲜核当前源/BUILD/配置/未知任务/窗口并自然排空后成套web/image/sender回退，HD保持原进程与动态v2，不回DB/通知/导航/旧control、不重发，后继变化停止自动回退，未演练。正式菜单工单第9节/固定todo/私有closure为证据入口，原图与工单不公开Git；本条安全文档提交不改变运行源或版本，下方均为历史，后继仍鲜核。

- UI-A–E/HD-ST已保护部署（2026-10-13）：实际源`af7502195cf9ba4e3b8300bf066ce064d9b536c6`、v0.84.0、BUILD`sRr4tpyQFrciviZsc8Mqj`；web2868547/image2868603与唯一HD flock2872537/Node2872539均同根真实/data，HD Invocation`799d7e741a894bed88c48629109615ca`。HD协议`hd-control-v2`已配套资源等待/CAS、双发现游标/单源隔离、发布收据恢复、4新1旧与管理/显示；旧load_guard鲜核后经稳定窗口自动继续，15:26:08Z已239→249 ready（新125→133、旧114→116），仍有843 queued/1 running/1 skipped，旧库未清空、功能待手验。两指定导航只写本人一条UserPreference/revision2，模板/任务/资产不删，现有调整顺序可恢复。主/guard完整构建、1173/1171源、48公网静态/15原访问保护及工程矩阵有证，首编译失败与flock误计原证保留；后者在HD变更前停住，纠正actual executable核对后接续，已记误判日志。兼容guard`9f8d0b73ca6d63cd8a8f167491894496f273d9a1`/v0.83.0+hd-stability-guard.1/BUILD`Pt0hTYL4XaHJWBnG9b3xR`已实建；完整旧源/构建/0600配置及HD原unit/control留真实/data的ui-hd-stability-20261013 stage。回退须鲜核当前源/配置/租约/未知任务/窗口，先自然停HD并切同协议guard，再自然排空成套web/image/sender；保留SendSIGKILL=no，不回旧control/全库或直接启动旧2e worker，不重发，未演练；旧UI可能重显导航但偏好保留。角色047/宿主128、DB64784:171442216/env/nginx/原件及相似OFF保持，0Browser/收费生成/造压坏图/DDL。持续成品/逐项账与最终窗口以正式根高清17.10.8及私有closure为准；文档HEAD不冒充运行源，后继鲜核，下方为历史。

- CUX/NEXT/LOOP/MV已联合保护部署（2026-10-13）：实际源`d3c90e32ff3dc44d4aa1c3e1871f0f43fd04bdb2`、v0.83.0、BUILD`-W-kOtns3HmeQQeumbllT`；web2755031/image2755133与自然sender同根真实/data，13:19:58Z原runId收尾。四项工程已部署、功能待用户手验；抠图主工作区/本地修复草稿、图片合法原图接续、循环偏好、多角度选帧/排版导出已接入。当前抠图无可靠报价须导入后明确确认，视频只带独立首帧草稿、不自动生成收费；MV初始为时间候选，方向由用户确认。主/guard完整构建、1160/1149源、45公网静态/13访问结果/37图片模块和主管实际cwd/BUILD/公网薄核有证；失败原证保留，公开抠图权限空壳误期待已登记，原窗口过期仅补原完成记录，未新建窗口或二次切换。相容guard`0ba2dbfc82a657700367caed42acb26aaa333cd2`/v0.82.5+creative-tools-guard.1/BUILD`NLo3-sACWH10R1gZNuql3`保留耐久交接/私有帧/原比例共享raw协议；原418完整源/构建/0600配置在真实/data的creative-tools-batch-20261013 stage。回退须鲜核后自然排空、成套web/sender/image，不回DB/清草稿/重发，未演练；HD81c2暂停、角色047/128、DB64784:171442216/env/原件/比例配置和相似OFF保持。0Browser/功能回归/收费/DDL/扩权。正式根固定todo四项清单及原CUX12/NEXT9/LOOP9、私有资料索引为入口；文档HEAD不冒充运行源，下方旧记录仅历史。

- SHARE01/PIN02/RATIO02已保护部署（2026-10-13）：共享先于10:05Z发布ce671d60/v0.82.4；当前实际源`41857036b227a21ec6087a2131ad5a7319c5b5ab`、v0.82.5、BUILD`jQDN6blVEBMMIsP8sfTSn`，web2619279/image2619336与自然sender同根真实/data，10:31:09Z窗口完成。新共享可关闭、置顶入口及比例下拉/全标准项已工程部署，待用户手验；主/guard完整构建、1135/1134源、29公网静态/6原保护/37图片模块及主管薄核有证。相容guard`e2d566bd85d59760fbb003ea788ec2242972e4e5`/v0.82.4+pin-ratio-guard.1/BUILD`BLXXLrrOG6Nk4j22v5060`保留新旧比例任务、共享与raw恢复协议，原ce整源/构建/0600配置留真实/data的pin-ratio-correction-20261013 stage；鲜核后自然排空、成套web/sender/image回退，不回DB/重发，未演练。HD81c2 load_guard暂停、角色047/TasksMax128、DB64784:171442216/env/原件及相似OFF保持，0Browser/收费/DDL/生产配置写。正式F24单SHARE01、固定todo与私有资料索引为入口；文档HEAD不冒充运行源，下方旧记录仅历史。

- CLOSE01/EXACT01–03/RATIO01已保护部署（2026-10-13 08:41Z）：有效APP为image-wait-20261012工作树、codex/preview-upload-ratios-20261012分支；运行源`8b261e037c1d5318480cf6010f7a2c4cad844999`、v0.82.3、BUILD`udlS2_vB8SSAbr0ULuXKo`，web2515635/image2515689及自然sender同根真实/data release。主/guard完整构建各1133源、29公网静态/6原访问保护、37图片模块及主管薄核有证，三标签/窗口完成，功能待用户手验。相容guard`f63a17ec2b98586df3aea17dfce3e0f56d4ff709`/v0.82.2+raw-upload-guard.1/BUILD`zlxMXtSnaEfnxvShcEzXZ`保留新raw协议；原c5源/构建/0600配置在真实/data的raw-upload-recovery-20261013 stage保留。鲜核当前源/配置/未知任务/窗口并自然排空，成套回web/sender/image；不可直接退c5/774，不回DB/回执/通知或重发，未演练。已批准两型号比例窄CAS保留，本次纠正配置未改；HD2e90原进程/81c2 load_guard暂停、角色047/宿主128、DB64784:171442216/env/原件/nginx保持。0Browser/功能回归/真实上传压测/收费/DDL；原失败和目标纠正沿正式根原单9.7.1–9.7.2及私有closure留证，不公开私人资料或root脏树。文档HEAD不冒充运行源；以下旧条目为历史，后继鲜核。

- UI01–UI03已保护部署（2026-10-13 05:43:22Z）：有效APP为image-wait-20261012工作树、codex/studio-ui-clarity-20261012分支，运行源`48d8207f02de954131fb3b4bd0974737ade51510`、v0.82.1、BUILD`dVK3OWqbxW8PYFjZoxJcm`。web2357745/image2357827及自然sender同根真实/data release，12应用/版本路径、1132源、完整候选类型/lint含7个改动TS、29公网静态/5原访问保护及37图片启动模块有证，实际界面待用户手验。本地两检查依赖读取超时保留，独立服务器完整构建exit0，不冒称本地通过；主管实际cwd/BUILD/公网薄核一致，误路径更正留证。复用完整00c/v0.82.0/BUILD Z89R5yspJlpTLqwpdnz_K回退，原整源/构建/0600配置留真实/data的studio-ui-clarity-20261012 stage，不另建guard、未演练；鲜核同源/配置/未知任务/窗口，自然排空后成套web/sender/image，不回DB/通知/HD或重发。HD原2e进程及81c2 load_guard暂停、角色047/宿主128、DB64784:171442216/env/原件/nginx保持，相似policy不存在且worker未安装，仍OFF。三标签及窗口完成，0Browser/功能回归/收费/DDL/配置写。正式根统一选择工单第10.1节、素材库UI01追加、固定todo与私有closure为入口；文档HEAD不冒充运行源，原root脏改/资料不整树公开。以下旧运行项为历史，后继鲜核。

- PIN01/PROG01已保护部署（2026-10-13 04:55:26Z）：有效APP为image-wait-20261012工作树、codex/template-result-pin-20261012分支；运行源`00c192f758dec5147ca8ce6aca3b62620095fa5e`、v0.82.0、BUILD`Z89R5yspJlpTLqwpdnz_K`，web2313385/image2313440及自然sender同根真实/data release。19应用/版本路径、双树完整候选及16源lint、7后台同字节、1132主/1131guard源、42公网静态/23原访问保护有证，功能待用户手验。兼容guard`3b4c9cf3a8a78cce7e2b5e794796cb1e0114943d`/v0.81.0+template-pin-rollback-guard.1/BUILD`JphwTXB8XBN4p4JoqzPYz`完整构建，原3e整源/构建/0600配置保留真实/data的template-result-pin-20261012-r2 stage；回退须鲜核当前源/配置/未知任务/窗口并自然排空，成套web/sender/image，保留置顶后台/权限、DB/原件/回执，不重发，后继变化即停止，未演练。HD在前次恢复后01:31:56Z再次load_guard暂停，本批原2e进程/PID1624225/Invocation及81c2控制保持，不resume；角色047/宿主128、原DB64784:171442216、env/原件/nginx保持，相似提示OFF且未装worker。首lint失败、定点更名修正及本地SSH255/服务器候选0的只读对账分别留证，不掩盖失败或重跑主构建。主管04:54:46Z薄核一致，自然sender/三标签/窗口已收尾，0Browser/功能回归/收费/DDL/配置写。正式根分享工单PIN01追加、固定todo与私有closure-complete为入口；安全文档HEAD不冒充运行源，原root脏改/资料不整树公开。以下旧运行条目仅历史，后继鲜核。

- HD-R2原高清队列已受控恢复（2026-10-13 01:18:20Z）：用户第6问授权后，01:14:27Z仅原生resume一次；01:16:32Z旧944批ready98→100、843排队/1处理中/0失败，两成品完整性及对应原件版本核同，不代表全库完成。HD仍2e90d896源、PID1624225/Node1624226、原Invocation，control从89a5…暂停变为4552…/paused=false，原字节0600备份留真实/data的studio-seven-fixes-20261012-r2/hd-r2；仅paused/reason/updatedAt直接变化，DB直接写0行，无重启/源码参数改变/重发生成/新增收费。web/image仍3e7d5de6/v0.81.0/原BUILD，角色047/宿主128、DB64784:171442216及原件/env保护保持。原生自动暂停继续有效，新异常不反复resume或用旧control覆盖；相似提醒OFF、网页手验未结案。正式HD工单17.9、固定todo与私有hd-r2/closure.json、supervisor-thin.json记录全部原证，窗口结束；仅安全文档提交，不升级应用或重启网站。下方七项发布时“保持load_guard暂停”是当时历史，不代表此后状态。

- 工作台七项修复已保护部署（2026-10-12 19:39Z）：实际源`3e7d5de61671015935ed4b43b6093e0b45eecf9c`、v0.81.0、BUILD`aZSVEtKtq6HtBJ3wCplrD`；web1798658、image1798707及自然sender同真实/data release。生成等待、风格Skills统一选择、视频首帧交接、本人本机排序、直接输入主图回填及作者/快捷保存已部署，均待用户手验。上传精确复用/回执已部署；相似识别两次限定校准未达标，第二次零误报但13/18=72.2%低于90%，提示OFF、不第三试；关闭时不入队，私有Python运行时与新worker未安装/启动、policy仍不存在，不能称整单完成。原HD同1624225/1624226及2e90源在18:46:54Z自行load_guard暂停，当前control保持该暂停，不擅自resume；下方16:51解除output_integrity仅历史。角色047/宿主128、DB64784:171442216、原件/env/nginx保持。主1127/guard1122源、37图片启动模块、41公网静态/22原访问保护、完整双构建及三标签核同，窗口完成；0Browser/功能回归/收费/DDL/历史扫描。完整相容guard`54323baddd5b36e00334a4ea31f56070042ce98e`、v0.80.0+studio-seven-rollback-guard.1、BUILD`EMJGozukcpUnGEByYKUFN`，旧2e90整源/构建/0600配置保留真实/data的studio-seven-fixes-20261012-r2 stage。回退须鲜核当前源/BUILD/配置/未知任务/窗口，自然排空后成套web/sender/image；保留安全上传回执和关闭门，不回DB/清账/重发、不改HD或角色，后继漂移即停，未演练。正式根七项todo、三工单及私有closure为证据入口；私人记录/原root脏改不整树推，记录HEAD不冒充运行源。

- 模块封面与高清修复已保护部署（2026-10-12）：实际应用源`2e90d896cd5b324f611428330e2e22a02b4d3939`、v0.80.0、BUILD`HbUQKcXe4za1chxZlnJHh`，web/image/自然sender同根真实/data release，功能待用户手验。固定封面私有模块归module、共享归真实preset，专用4:3成品与640小图优先且失权不回最新图；移除两项上下文UI但历史/生成语义保留；比较锁复用旧linked偏好。10项HD代表/反例验证通过，原唯一失败key精确恢复且累计attempts/旧失败记录保留；HD现MainPID1624225、Node1624226实际同2e90，原unit不覆盖，仅`hd-source.conf`指定新WorkingDirectory，原全局锁/单任务两线程不变，16:51:37Z受控解除原output_integrity暂停。后继部署必须鲜核并保护这个新HD源/当前control/队列历史，不能将下方旧“HD1303881暂停”当当前状态或覆盖旧备份；原件、DB、配置与角色047源/独立宿主128不动。完整相容guard`0df80dbf2f17bc38eec36cd2387fd421ea9fb480`/v0.79.1+module-cover-rollback-guard.1/BUILD`WdvY6Mi20qfBKzmlkSZmY`已实建，保留新封面/HD合同；回退鲜核当前源、配置、任务与窗口后自然排空，成套web/sender/image至guard，保持已恢复HD源和历史，不回DB/control/通知或重发，未演练。主1110源/guard1108源、38公网静态/21访问保护、原失败依赖修正及两分支/标签有证；真实新旧批推进以正式封面工单9.1、性能工单17.8、固定todo及本批私有closure为入口，旧944未全部完成，0Browser/功能回归/收费生成/DDL。文档HEAD不冒充运行源，原root脏改与私人资料不整树推。下方发布均为历史，下次仍鲜核实际状态。

- UX01–UX05及Sunburst就绪修复已保护部署（2026-10-11）：实际运行源`6b99eb52171a34d5752f33e44139740b26c7403c`、v0.77.1、BUILD`eKQfOQ7GLWO8WBuVxjP0W`，web、自然sender与image同源；主管18:44:50Z独立公网200/v0.77.1及实际服务目录薄核一致。登录创作首页、复制图文区分、恢复/快速设置保留主图、双击结果替换主图和查看器去青框已实现部署，功能待用户手验；首次v0.77.0遗漏register默认落点，已限定纠正，未改鉴权核心。候选内置检查、1079应用源/37公网静态/原访问和持久保护已核，不冒充功能验收。完整即时回退`92229c5f5f6a033beeadd2ac015f422aaa08b111`/v0.77.0/BUILD`tjRbWXTjbvVJzEdU5sllN`与0600配置保留真实`/data/video-api-debugger/release-staging/template-login-correction-20261011`，退回会恢复该register漏点；须鲜核当前源/配置/未知任务、自然排空后成套回退web/sender/image，不回数据库/通知/HD、不重发，后继变化停止自动回退，未演练。Sunburst两次明确能力补配已只读核差，包含原模板3:1；唯一单张验收按正式根原任务继续，受理/校验中不等于出图，站内点数/报价不等于供应商实扣。ROLE02保持暂停，新UX不Browser。正式工单/配置包/脱敏证据只在正式项目根，文档HEAD不是运行源，不抬应用版本或重启；下方旧发布仅历史。

- IMG02分组配置纠正已部署（2026-10-11）：实际运行源`6a71690c32372467fc76523e59d00e5174b13b57`、v0.76.1、BUILD`wo7QmAH8ovP-5nPVkaOUx`；web、正常sender与image同源。Image/Banana两组主表单、供应商二级编辑及组隔离原子保存已实现，未接入字段保留只读。13工程检查/12组合成检查、主与相容回退构建、1079应用源/17公网静态及原访问/持久保护已核；仅工程部署，真实页面与生成不能据此判通过。相容回退源`b10f4a61802787c922a389a23bc9cdaca39b6d9d`、版本`0.76.0+image-group-rollback-guard.1`、BUILD`t50hqSMTNDaaHXG9jGRTg`，保留新组后端并拒绝旧UI不相容写入；须鲜核配置/任务/当前源并自然排空后成套回退web/sender/image，不回数据库/通知/HD，未演练。当前API专项页面仅主管Ego单控，PAY01不提交，ROLE02保持暂停；私人验收与费用记录仅正式项目根，不随源码公开。文档HEAD不是运行源，本记录不抬应用版本或重启；以下旧发布仅历史。

- CACHE02已保护发布（2026-10-10 America/Los_Angeles）：运行源 `9c7a9aedd8f27ba17b3a96ba82f811d36cb2cbbd`、v0.68.3、BUILD `6YYMJ_7_xreBzFa61mtE8`，web与正常sender同源真实 `/data/video-api-debugger/releases/9c7a9aedd8f27ba17b3a96ba82f811d36cb2cbbd`。共用查看器复用账号/权限上下文隔离的图片正文，每次新显示先核当前权限；本地inline图片stat版本与条件响应、只读HEAD/预取、HD描述去重、已加载前后各一张及32项/64MiB有界内存缓存已实施。网络不明不沿旧批准显示，缺派生只读请求409不入队/编码，下载与非图片Range不改。19应用路径，统一Verify03的23工程/69离线检查、lead非独立源码Review、主管有界源码门、main/guard内置构建及1017源/38公网静态/7原访问保护有证；首轮与私有产物检查器失败原证保留。原USD7/PAGE02/RAIL/RECON/AVIMG/CanvasFrame/ReleaseNotice/schema/FEED3、本人通知配置、两worker PID1303824/1303881及原app/env/依赖/持久inode/HD `output_integrity` 暂停、真实 `/dev/vdb /data` 不变。无新依赖、持久缓存/公开缓存、DB迁移、生产图片请求、Browser、造样、试发或收费；真实速度、切图/缩放/账号撤权/升级提醒仍用户手验，不解除其他冻结任务。
- CACHE02相容回退与原件分离：实际guard `d0434299c8b9c81d336d3eb6eb88cfc2485c7f98`、v0.68.2+cache02-rollback-guard.1、BUILD `kQEo67xLORPNOVQU-Xchp`，保留a505原UI及五处同main的服务端只读/HTTP协议；HD key/编码/控制与FEED3不改。完整原a505/v0.68.2/BUILD MbbQ另保留于 `/data/video-api-debugger/release-staging/cache02-20261010` 的整源、0600原构建/配置；原a505不识别新预取合同，不能直接当长驻新客户端的自动回退。先核当前源/BUILD/env/原保护，仅停反馈timer自然排空，再成对回guard web/sender，不回DB/清重放通知/覆盖原件/重启原worker，后继发布或保护变化停止自动回退，未实际演练。标签 `release/cache02-v0.68.3-20261010`、`rollback/cache02-compatible-v0.68.2-20261010`、`rollback/pre-cache02-original-v0.68.2-20261010` 分别指主源/相容guard/原件。正式根私有 `docs/materials/2026-10-10-image-cache-implementation/checkpoint.json` 是工程与发布证据入口；正式工单/todo/index由主管维护，不公开Git或部署。安全文档HEAD不冒充运行源，本记录不改变应用版本或重启服务；以下条目仅历史，后续仍须鲜核。

- PAGE02已保护发布（2026-10-10 America/Los_Angeles）：运行源 `a50598dce4b06ed4406e42d209c4c54cc0d15d3c`、v0.68.2、BUILD `MbbQoBGA0mWsYyWfOPHDf`，web与实际sender同源 `/data/video-api-debugger/releases/a50598dce4b06ed4406e42d209c4c54cc0d15d3c`，正常timer执行回执及原FEED3三核心SHA核同。公共结果、素材选择器与封面分页去除冗余加载更多，增加最后一页图标；共享数字分页沿真实服务端总数定位。未知总数不猜末页，失败保留当前页和目标；每次最多20轮游标读取，未到目标可明确继续翻页，不能把缓存尾页冒充真实末页。按实际列数最多三行、首页/上一页/下一页、账号筛选与工作现场恢复保留；仅游标收藏和模块内容懒取的加载入口不删除。8应用路径，Verify03共23工程项及29离线检查通过，类型/lint复用同源Verify02且候选重新执行内置检查；lead非独立源码Review、1014源/37公网静态与7既有访问保护有证。原USD7、RECON/AVIMG/RAIL、FEED3/本人通知配置、两worker PID1303824/1303881及app/env/依赖/持久inode/HD `output_integrity` 暂停、真实 `/dev/vdb /data` 不变。0Browser/生产查询/业务样本/收费/试发/DDL/审核线程；实际翻页、恢复与旧客户端更新提醒仍用户手验，CACHE/FEED调查及其他冻结任务不实施。
- PAGE02即时相容回退：完整 `eb5c8c11af7218ee6fcdb0d324f6825ccfddcc8b`/v0.68.1/BUILD `odQUYPjxOszz00KfJHmEW` 保留于 `/data/video-api-debugger/releases/eb5c8c11af7218ee6fcdb0d324f6825ccfddcc8b`；整源、0600原构建/配置备份及 `rollback.sh` 在 `/data/video-api-debugger/release-staging/page02-20261010`。先核当前源/BUILD/env/原保护，只停反馈timer自然排空，再成对回web/sender，不回DB/清重放通知/覆盖原件/重启原worker；后继发布或保护变化停止自动回退，未实际演练。标签 `release/page02-v0.68.2-20261010` 与 `rollback/pre-page02-v0.68.1-20261010` 对应上述源；正式根私有 `docs/materials/2026-10-10-feedback-pagination/PAGE02/checkpoint.json` 为证据入口，由主管维护正式记录，不公开Git或部署。本安全文档提交不改变运行源或版本；以下生产条目仅作历史，后续须鲜核。

- RAIL01已保护发布（2026-10-10 America/Los_Angeles）：运行源 `eb5c8c11af7218ee6fcdb0d324f6825ccfddcc8b`、v0.68.1、BUILD `odQUYPjxOszz00KfJHmEW`，web与实际sender同源 `/data/video-api-debugger/releases/eb5c8c11af7218ee6fcdb0d324f6825ccfddcc8b`。仅隔离我的喜欢组件与桌面/手机侧栏导航按钮、select样式；原30px/触屏36px图标、名称省略、选中/hover/focus及图片/视频共享入口保留，收藏/API/权限/费用/美元7元规则不改。5应用文件、Verify01工程检查与lead非独立源码Review、候选内置检查和编译边界、1014源/31公网静态及7既有访问保护有证；真实布局与操作仍用户手验，0Browser/生产查询/业务样本/收费/试发/DDL/审核线程。原FEED3三核心SHA、本人通知配置、两worker PID1303824/1303881及原app/env/依赖/持久inode/HD `output_integrity` 暂停和真实 `/dev/vdb /data` 不变，不恢复冻结任务。
- RAIL01即时相容回退：鲜核保留完整 `8e9437859206783a11785b86435f5e487487fc66`/v0.68.0/BUILD `0aq1IttGIutdLEUVBaAHU`；原整源、0600构建/配置备份及 `rollback.sh` 在 `/data/video-api-debugger/release-staging/rail01-20261010`，完整运行源仍在 `/data/video-api-debugger/releases/8e9437859206783a11785b86435f5e487487fc66`。先核当前源/BUILD/env/原保护，只停反馈timer自然排空，再成对回web/sender，不回DB/清重放通知/覆盖原件/重启原worker；后继发布或保护变化停止自动回退，未实际演练。标签 `release/rail01-v0.68.1-20261010` 和 `rollback/pre-rail01-v0.68.0-20261010` 对应本批源及即时回退；正式根私有 `docs/materials/2026-10-09-favorites-card-compact/rail01-implementation/checkpoint.json` 为证据入口，不公开Git或部署，正式root记录由主管维护。本条安全文档提交不改变运行源或版本；以下生产条目仅作历史，后续须鲜核。

- PRICE01/PAGE01/RECON01/AVIMG01已保护发布（2026-10-10 America/Los_Angeles）：实际运行源 `8e9437859206783a11785b86435f5e487487fc66`、v0.68.0、BUILD `0aq1IttGIutdLEUVBaAHU`；web与真实sender同源 `/data/video-api-debugger/releases/8e9437859206783a11785b86435f5e487487fc66`，正常timer执行回执及FEEDIMG三核心SHA核同。人民币显示两位小数，用户明确默认1 USD=7 CNY，保留有效环境配置优先；不改扣费、账本、点数兑换或原env。共享分页采用同权限筛选真实数量、稳定顺序和首页按钮，按实际列数最多三行；素材目录变动要求刷新，不把缓存当全量。公共图片仅有效已对账时显示标签；人物逐张查看和确认后的可撤销删除复用既有本人AvatarRecord/deletedAt，不删除任务、账单、其他输出或物理原件。26应用路径、0 schema/生产DDL/依赖改动；最终Verify05七工程检查及52离线检查、lead非独立源码Review、候选内置检查、1014源和44公网静态/7画布权限保护有证。功能、分页现场、金额和逐图操作仍待用户手验；未做Browser、真实删除、生成收费或测试发信。原两worker PID1303824/1303881、app1a3d源/依赖/构建/env、持久链接inode、本人精确通知配置、HD `output_integrity` 暂停及真实 `/dev/vdb /data` 不变；DEFAULT02及其他冻结任务不恢复。未上线c7候选与历史失败证据保留，不能发布旧7.2候选；本条后安全文档提交不改变上述运行源或版本。
- 本批即时相容回退仍是完整 `9825cb7fae053b62157834337430ba247b05b9fe`/v0.67.0/BUILD `MYzHNWe2m3mdWyUsDRZkz`，源和构建在 `/data/video-api-debugger/releases/9825cb7fae053b62157834337430ba247b05b9fe`；真实数据盘原构建归档和0600原配置在 `/data/video-api-debugger/release-staging/price-page-recon-avimg-20261010`。同目录 `rollback.sh` 先核当前源/BUILD/env/原保护，只停反馈timer并自然排空，再成对回web/sender，保留反馈、通知、数据库、账本及原件，不回放或清空，不动原worker；后继发布或保护改变停止自动回退，未实际演练。`release/price-page-recon-avimg-v0.68.0-20261010` 与 `rollback/pre-price-page-recon-avimg-v0.67.0-20261010` 对应上述源；own发布窗口已完成。正式根 `docs/materials/2026-10-09-price-pagination/implementation/checkpoint.json` 为私有证据入口，正式工单/todo/index由主管维护，不公开私有材料或原root dirty/ahead内容。以下旧生产条目只作历史，后续先鲜核真实web和sender。

- FEEDIMG03已保护发布（2026-10-09 America/Los_Angeles）：实际运行源 `9825cb7fae053b62157834337430ba247b05b9fe`、v0.67.0、BUILD `MYzHNWe2m3mdWyUsDRZkz`；web实际cwd `/data/video-api-debugger/releases/9825cb7fae053b62157834337430ba247b05b9fe`，真实sender同源同版，沿 `sd2-feedback-delivery.timer` 正常运行。新反馈仅从本人有效Asset和校验后的本站哈希原件准备图片，使用原批准机器人上传key后冻结一条卡片；正文、原比例截图、较轻来源与唯一鉴权详情入口依次展示。快照最多128项、卡片最多20张，缺图如实说明；未知上传不盲重传，消息固定uuid/租约/结果未知安全窗和旧文字/卡片兼容保留。9应用路径、0 schema/生产DDL/依赖或费用改动；27隔离场景及7工程检查、lead非独立源码Review、主/guard内置检查、1014源和32公网静态核同完成，主管限定8目标源/2静态与实际sender三核心SHA薄核通过。真实图片上传受理、客户端卡片实收及UI仍待用户手验，平台配置或健康不当功能验收；0测试反馈/上传/发送/Browser/收费/权限扩大/独立审核线程。原app `1a3d1dec878c376b2930c8847f13607aa0d2b35f`、两个worker PID1303824/1303881、env/持久链接和inode/依赖/HD `output_integrity` 暂停及真实 `/dev/vdb /data` 不变。RECON01及其他冻结事项不实施。本条之后仅APP安全记录提交不改变运行源或版本；以下旧运行条目为历史，后续先鲜核实际web与sender。
- FEEDIMG03相容回退：guard `2ce26e18f8087f2d7758a18b068161ce8e75ae5e`、v0.66.1、BUILD `4Ab9M6ZvyretVAq5rFnnF`，完整源/构建在 `/data/video-api-debugger/releases/2ce26e18f8087f2d7758a18b068161ce8e75ae5e`；保留新图片准备及固定消息，旧API仍产生旧格式。必须先只停反馈timer并自然排空，再成对回web/sender，保留所有反馈/通知行、不重放、不回DB、不动原worker；不用未支持新元信息的旧sender。原3a0整源仍在 `/data/video-api-debugger/releases/3a0c13d9540d589f0fe2ed303579ae2b5f6f17e1`，原BUILD `PCaJUNybCGKSGxoXbFYbc`完整归档及受保护配置备份在 `/data/video-api-debugger/release-staging/feedimg03-20261009`；同目录 `rollback.sh` 有实际源/配置/保护守卫，后继发布或保护改变停止自动回退，未实际演练。远端标签 `release/feedimg03-v0.67.0-20261009`、`rollback/pre-feedimg03-v0.66.1-guard-20261009`、`rollback/pre-feedimg03-original-v0.66.1-20261009` 已核对应源，own窗口完成。正式根工单第8节与 `docs/materials/2026-10-09-feedback-feishu-notify/image-implementation/checkpoint.json` 是私有证据入口，由主管维护正式记录；私有材料、原根dirty/ahead内容不推Git或公开部署。

- 当前正式生产入口是 `https://sd2.youdooart.com`，长期使用腾讯云 Ubuntu 服务器版。旧 `sd2.youdoodesign.com` / Mac 本地 Cloudflare Tunnel 入口不再作为生产入口；除非用户明确要求回滚或排查旧入口，不得重启 Mac 本地 `sd2` 当作恢复手段。
- 用户未明确指定其他站点时，本项目所有页面查看、问题排查、代码修改、配置核对、登录回调、部署验证、截图验收和 API 验证，默认目标一律是 `https://sd2.youdooart.com/`。App 浏览器、Chrome、日志或历史记录里出现 `sd2.youdoodesign.com`，只能当作旧 tab/旧入口背景，不得自动切回 design 域名继续修改或验收。
- 不得在 `sd2.youdoodesign.com`、design 域名、Mac 本地 Cloudflare Tunnel 或旧 `trycloudflare` 链路上做默认修改、默认部署、默认验证或默认排查。唯一例外是用户明确要求“旧入口 / design 域名 / 回滚 / 迁移核对”时，才可只读确认旧入口状态，并且不得把它的结果当成 `sd2.youdooart.com` 生产结论。
- `sd2.youdooart.com` 必须直接打开服务器网站，不得用跳转临时代替。飞书 OAuth、回调地址、登录后跳转地址和前端公开域名配置都必须以 `sd2.youdooart.com` 为准；登录后跳回旧域名时，按配置错误处理。
- 服务器默认是 `42.193.221.253:22`，普通操作用户 `gouki`；线上 nginx 反代到 `127.0.0.1:3302`，systemd 服务名 `sd2-gray.service`，服务器应用目录 `/srv/video-api-debugger/app`，公网响应应能看到 `X-SD2-Origin: server-42-193` 这类服务器来源标记。
- 最近已发布UI29（2026-10-07）：同一APP工作树/分支，v0.52.0，实际built/deployed-source `9cec8f15c386c2929a824c66187a9830e7e89af2`，BUILD `eK6CQJpF06uoVM0mSn4FW`；随后仅本文件安全运行记录提交不改变运行源。PASTE29共享上下文粘贴仍替换全文，仅已有读取授权且用户指向/聚焦粘贴键或明确复制后取得非空文本证据才亮起；未知/拒绝状态仍可点击明确读取，不后台轮询、不在打开弹窗或窗口聚焦时偷读、不自动询权限、不持久保存或传输外部全文。弹窗响应式最大820px，数量标签与主图范围紧凑单行，原限制/保存成功关闭/未保存保护不变。FAV29结果区增加当前模板本人喜欢筛选，不跳资产页、不混模板喜欢；沿原授权来源先筛本人liked或历史favorited的有效资产及成功结果再游标分页，all/liked各自按最多3行恢复位置，取消喜欢确认后移除、账号/模块/请求及返回viewer隔离，空/载/错/重试/刷新保留；只读筛选不发DOT24进入确认回执。CMP29左当前缩略、中央对比、右选定缩略紧邻中央，保留固定左原图右选图、无交换、外置联动锁、独立缩放定位及更多/关闭，不改预览缓存或下载引擎。
- UI29工程证据：13份应用文件，一次MINOR；整批统一候选内置lint/types与编译、同产物lead源码Review、887份源码一致、46公网项含43静态SHA完成。首候选内置检查成功但产物证明脚本未读取分拆server chunk而阻断，未切live；集中修正记录及旧候选保留，最终新增clipboard hook警告消除、其他已有警告未扩大修改。完整三ID根因/逐文件/限制/命令/Git/调度在 `/tmp/sd2-ui29-20261007/handoff.json`，应用diff `/tmp/sd2-ui29-20261007/app.diff`，含本记录完整diff `/tmp/sd2-ui29-20261007/full.diff`，候选/Review/公网/窗口/保护JSON与日志同目录，由主管正式归档。实际工具无native spawn/容量入口，1 lead/0 worker串行，不建侧栏/审核线程、不改模型。ReleaseNotice唯一版本源、SemVer、稍后/手查/未保存保护按源码保留；真实剪贴板/跨浏览器、喜欢分页/取消/恢复/跨账号/撤权、多端布局及旧客户端更新提醒NOT_RUN，已部署待用户手动验收。外部剪贴板状态无法持续保证，权限查询不支持时不提前伪亮；很大喜欢历史读取成本未实测。守门员等价按部署/回档L4纠正工具L3关键词输出，误判已记录；无浏览器/截图/业务回归/收费/喜欢写样本/删除/生产回执或DB写迁移。IMG29、TXT28及所有旧未完成项不纳入，UI28媒体/cache/原件/下载限制及PERF26-N未知、UI27固定左右、UI26单心及DOT24回执语义保留。正式根私人记录和三原图由主管独占，不进入Git或服务器。
- UI29保护发布：远端peeled tags `release/ui29-v0.52.0-20261007` ->9cec8f15、`rollback/pre-ui29-v0.51.6-20261007` ->实际旧运行e9858163。回退源码 `/srv/video-api-debugger/releases/e985816369cc1382dbb525f1804a7cd3ff20d748-ui29-rollback-source`，回退构建 `/srv/video-api-debugger/app/.next-prod-prev-ui29-9cec8f15c386`、旧BUILD `u3yqXcTy9wdrsK4jDRq0a`。跨盘候选复制到app同盘后保护切换，发布锁与512000KB线生效，最后鲜核根盘933368KB，下轮重核；50旧回退全保留，新增第51个，历史无BUILD条目仅保留缺口。只重启web，worker PID1043189/Invocation121606e35406489ea26faa2490c7de65、持久storage/uploads/videos目标/inode与env元信息均不变；无凭据内容读取、权限/依赖/锁/schema/点数/支付/Provider/worker/网络改动。匿名release只证明version/channel且摘要合法为空，BUILD以SSH和编译资源SHA证明，不冒造API字段。以下运行条目为历史，不替代本轮鲜核。
- 上一轮UI28+PERF26（2026-10-07）：同一APP工作树/分支，v0.51.6，实际built/deployed-source `e985816369cc1382dbb525f1804a7cd3ff20d748`，BUILD `u3yqXcTy9wdrsK4jDRq0a`；随后仅本文件运行记录提交不改变运行源。TAB28复用原完成提醒开关/提交观察/回执去重，后台真实新成功合并为有界温和标题提示及静态回退，前台/退出/关闭提醒停止，不写DOT24回执、不承诺后台定时节奏或标签物理移动。CARD28元信息紧凑、下方次操作桌面hover/focus出现且保留布局、触屏/恢复操作可达；REF28连续紧凑图区及用途添加框、原素材/风格/顺序规则保留；CLEAR28清空回图片区内部留边距沿原保护；TITLE28图片生成H1由24px改48px加粗、手机换行，不用vw。
- PERF26-1..5已实施保护发布，功能仍手验：已知图片入口沿原授权路由分640缩略/1600轻量/2048细节/原件，保留private no-store/Vary Cookie、原件权限先验及HEAD/Range/长度/取消安全流，不建任意URL代理。缩略与清晰请求并行，解码后升级，UI27左当前原图/右选对比图、无交换、独立引擎及联动锁保留。会话缓存仅内存、32项/64MiB压缩字节/3分钟空闲，账号role/type/content/version隔离，decoded-ready才复用；重新打开/前台HEAD核权，可见期间约60秒再核，失败abort/revoke/清bytes，不等于即时撤权或GPU内存上限。单图/图片ZIP浏览器原生下载与yazl懒加载原件流，不冒称已保存；原图inline与download attachment区分，清晰图不是原件。外部未知来源/视频音频封面明确原生回退；无可靠MIME/大小元信息仍未知，不能声称全部普通URL不读原件。仅已授权web缩略读取触发轻量派生预备，不更新worker、不保证所有新图首次打开前编码；远端版本缺失按分钟缓存键可能重读。原显式目录保存及其他全站视频ZIP客户端保留旧Blob流程，素材页视频ZIP仅交浏览器且原服务器打包逻辑不改。PERF26-N网络16秒波动/重传/约2.2s首字节原因仍未知，仅媒体请求增加最小access/media计时和随机请求编号，无云指标/代理/带宽/权限改动。
- UI28工程证据：30份应用文件，一次PATCH；首次候选内置类型检查失败（ES5 Set迭代）未切live，失败日志及首Review保留。R1-R7集中修正涵盖decoded-ready、失败取消清理、下载owner收束、进度发布节流及资产/图集缩略来源、role/type身份，第二统一候选内置lint/types完成，非阻断警告原样保留；同产物lead源码Review、886源码一致、46公网项含43静态SHA完成。完整逐文件/六ID/PERF26-1..5与N/入口映射/限制/命令/调度在 `/tmp/sd2-ui28-20261007/handoff.json`，应用diff `/tmp/sd2-ui28-20261007/app.diff`、含本记录完整diff `/tmp/sd2-ui28-20261007/app/full.diff`，日志及JSON同目录，由主管归档。工具鲜核无native spawn/capacity接口，实际1 lead/0 worker串行，不建侧栏任务/不改模型；正式根私人记录/原图由主管独占，不进入Git/部署。ReleaseNotice唯一版本源/SemVer/稍后/手查/未保存保护按源码保留，真实旧客户端未验。守门员按媒体/cache/原件/下载/保护发布L4等价纠正（关键词工具L3误判已记录），real-result及独立审核线程按项目明确手验跳过；无浏览器/截图/业务API测试/自动功能回归/收费/真实删除/生产回执样本/DB写迁移，实际布局/撤权/跨账号/原件完整流/ZIP/原生下载效果待用户手动验收，不标功能PASS。
- UI28保护发布：远端peeled tags `release/ui28-v0.51.6-20261007` ->e9858163，`rollback/pre-ui28-v0.51.5-20261007` ->实际旧运行447047a1，不指向纯记录2d517694。回退源码 `/srv/video-api-debugger/releases/447047a1c0308c2dc5875c64eebb3f1fa92f95c9-ui28-rollback-source`，回退构建 `/srv/video-api-debugger/app/.next-prod-prev-ui28-e985816369cc`、BUILD `eb5q2lfsbeuqxYlKJR94V`。新候选保留在数据盘，stat鲜核不同设备后复制到app同盘切换，发布锁及512000KB保护线生效；发布后根盘986084KB，下轮鲜核。49旧回退全部保留，本轮新增第50个（历史无BUILD条目仅保留缺口，不冒称可恢复）；只重启web，worker PID1043189/Invocation121606e35406489ea26faa2490c7de65、持久storage/uploads/videos目标/inode、env元信息未变，无env/key内容读取、权限/依赖/锁/schema/点数/支付/Provider修改。UI27/DOT24及其他旧缺口保持，以下条目均为历史，使用前鲜核实际源/BUILD。
- 最近已发布源码（2026-10-07 UI27）：APP工作树与分支不变，v0.51.5，实际built/deployed-source `447047a1c0308c2dc5875c64eebb3f1fa92f95c9`，BUILD `eb5q2lfsbeuqxYlKJR94V`；随后仅AGENTS记录提交不改变运行源。REF27模板主图/风格/参考区域去常显标题与计数，管理入口保留规则；GEN27主操作与张数间距、真实单次/批量总积分及小屏重排，去上游成本与空清参考。DOT24-1共享正常列表与提醒的本人/来源/权限口径，人物历史保留；DOT24-2仅明确进入且列表成功后确认服务端限定当前模板的不可变成功版本快照，晚完成与其他对象不清；DOT24-3私有单调seen回执、权威revision、账号/请求/旧GET隔离与失败重试，初始URL/自动恢复不清，单图阅读语义保留；DOT24-4整批候选/源Review/Git/保护发布。CMP27固定左当前原图、右用户选的对比图，已移除内容互换入口和函数，不恢复反置/身份不明的旧选择；两侧换图及独立尺寸位置、可选常显联动锁、居中对比、缩略图先行保留，原文件bytes已知才显示，预览像素不当原像素，未知如实显示。ASSET27共享选图卡只常显有效名称/必要状态，详情保留数据，图内左上角独立删除图标hover/focus/touch可达且原确认保护不变；HOME27五类别恢复Lucide，父区无卡、子入口整块可点，链接与账号条件不变；WAIT27真实输入快照铺满1:1、cover及首次即2.4px模糊（原6px减少60%），不改进度或重放生成。
- UI27交付证据：22份应用文件、一次PATCH，最终候选内置类型/lint成功（警告原样保留）、统一lead源码Review及整批修正完成；881份源码一致、41公网项含38静态SHA及实际SOURCE/BUILD相符。前两候选编译成功但未切live，最终CMP27纠偏及恢复不清提醒纳入新候选；所有日志/旧候选保留。完整逐文件/七项及DOT24-1..4/实际调度/命令/保护/远端证据在 `/tmp/sd2-ui27-20261007/handoff.json`，应用diff `/tmp/sd2-ui27-20261007/app.diff`，含运行记录完整diff `/tmp/sd2-ui27-20261007/app/full.diff`，候选/公网JSON及日志在同目录，由主管归正式资料。当前工具未暴露内部spawn_agent/容量接口，实际零worker、单lead串行写者，无侧栏新任务或模型改配。正式工单/规则/索引/五原图由主管独占，本轮私人资料未进入Git或部署；LIB24及其他未授权旧待办保留。ReleaseNotice唯一版本源、稍后/手查/未保存保护按源码核对保留，真实旧客户端提醒未验。守门员L3-visible-runtime，real-result按项目手验跳过，不标PASS；无浏览器/截图/自动功能回归/业务API/收费/真实删除/测试性生产回执确认/生产DB写或迁移，七项真实交互与持久提醒均待用户手动验收。
- UI27保护发布：远端解引用已核 `release/ui27-v0.51.5-20261007` ->447047a1，`rollback/pre-ui27-v0.51.4-20261007` ->原实际运行35393c35，不指向记录0d5c3c62。回退源码 `/srv/video-api-debugger/releases/35393c35d340e3a970d99aecd319f642a2f06845-ui27-rollback-source`，回退构建 `/srv/video-api-debugger/app/.next-prod-prev-ui27-447047a1c030`、BUILD `fCnZP3CsWbt6x1ZEQxSgP`。新候选保留在数据盘，鲜核不同设备后复制到app同盘原子切换，发布锁及512000KB根盘保护生效；最后根盘1198716KB，下轮鲜核。只重启web，worker PID1043189/Invocation121606e35406489ea26faa2490c7de65不变，storage/uploads/videos目标/inode及env元信息不变；48个旧回退全部保留（旧缺失BUILD条目只标历史缺口，不冒称可恢复），本轮新增第49个。无依赖/锁/schema/权限/点数/支付/Provider变化，不读env或key内容。
- 上轮已发布源码（2026-10-07 UI26）：APP工作树与分支不变，v0.51.4，实际built/deployed-source `35393c35d340e3a970d99aecd319f642a2f06845`，BUILD `fCnZP3CsWbt6x1ZEQxSgP`；随后纯记录HEAD不改变运行提交。LIKE26共享喜欢与分享的同级key曾相同，v0.51.2及v0.51.3实际源码均有此缺陷，现按控件类型和对象隔离，历史喜欢/收藏、真实计数、分享权限及异步/动画清理保留。FAV26真实喜欢模板在原侧栏下展开，分批读取与账号隔离/展开恢复；已安装定位原模块，未安装沿原显式使用，不因读取或恢复创建/生成，全站资产喜欢不变。GRP26分组浮层使用同级选择/删除按钮、键盘及外部/Esc关闭，复用影响确认，受保护分组和busy保护保留；DEL26仅删除模块改44px图标按钮，取消确认与其他文案保留。PRE26同对象缩略图先绘制后启用高清预览，失败保留可看缩略图和重试，身份/取消/迟到解码隔离；原图仍显式、每侧独立位置和尺寸/fitwidth/actual/manual恢复及可选联动保留，不安装库或重写引擎。无真实独立缩略图的来源沿已有原生加载回退，不伪造缩略图。
- UI26交付证据：14份应用文件、一次PATCH摘要，候选内置类型/lint及统一源码Review、880源码一致、39公网项含36静态SHA完成；首次候选被漏留变量的类型错误拦下，未切live，原失败日志保留；本机Node公网连接失败后使用curl完成同批检查，不冒称首次一次成功。应用统一diff `/tmp/sd2-ui26-20261007/app.diff`，完整含运行记录diff `/tmp/sd2-ui26-20261007/full.diff`，候选/运行/公网JSON与构建、保护、Review、Git证据均在 `/tmp/sd2-ui26-20261007/`。正式根工单/五项清单/索引/规则及私有PNG由主管独占登记归档，不公开Git或部署；DOT23、LIB24及其他旧待办不纳入。守门员L3-visible-runtime，real-result按项目手验跳过；未运行浏览器、截图、自动功能回归、收费生成或生产DB写，真实五项及旧客户端更新提醒均待用户手动验收。
- UI26保护发布：`release/ui26-v0.51.4-20261007`指向上述实际应用提交，`rollback/pre-ui26-v0.51.3-20261007`指向原运行90d165d，均已推送；回退源码 `/srv/video-api-debugger/releases/90d165dd64cfecf9377c5048deae46b74797d3ae-ui26-rollback-source`，回退构建 `/srv/video-api-debugger/app/.next-prod-prev-ui26-35393c35d340`、BUILD `vEHOloT6Kp_nStXUuITvE`。数据盘独立候选及跨盘复制保护保留；只重启web，图片worker PID1043189/实例121606e35406489ea26faa2490c7de65未变，storage/uploads/videos目标与inode、env元信息不变，根盘鲜核1261404KB高于512000KB保护线，下轮重新核。旧回退全部不删除，无依赖/锁/schema/权限/点数/支付/Provider变化，不读取env或密钥内容。
- 上轮已发布源码（2026-10-07 UI25）：APP工作树与分支不变，v0.51.3，实际built/deployed-source `90d165dd64cfecf9377c5048deae46b74797d3ae`，BUILD `vEHOloT6Kp_nStXUuITvE`；随后纯记录HEAD不改变运行提交。REF25把虚线加号图片块放入现有StudioReferenceGrid，与缩略图同组，原选图/预览/移除/排序/草稿链路保留；NAV25把创作首页放在共享固定顶栏且不受小屏隐藏导航影响；PRE25单行工具栏保留两图选择、对比、紧凑缩放、更多及关闭，次要操作进弹层，每侧独立定位与可选联动保留，不改引擎。8文件应用diff、候选内置类型/lint、878源码一致及39公网检查（含36静态SHA）完成；只重启web，图片worker PID1043189/实例未变，持久目录与env元信息未变。未运行浏览器、截图、自动回归或收费生成，真实REF25/NAV25/PRE25及旧客户端提醒待用户手动验收；LIB24及其他旧待办不纳入。完整应用diff、构建、公网及保护证据在本机 `/tmp/sd2-ui25-20261007/`，正式根工单/附件/索引由主管独占归档，不上传私有资料。
- UI25保护发布：`release/ui25-v0.51.3-20261007`对应上述应用提交，`rollback/pre-ui25-v0.51.2-20261007`对应原运行6a5a8f5；回退源码 `/srv/video-api-debugger/releases/6a5a8f539ce6af9dcdb6edd05f1d08080cb5a30f-ui25-rollback-source`，回退构建 `/srv/video-api-debugger/app/.next-prod-prev-ui25-90d165dd64cf`、BUILD `tZEbkDJvoGLXx368EiZ1G`。新候选保留在独立release设备，跨盘复制到app且保留原候选与所有旧回退；部署后根盘保护检查高于512000KB，下轮重新鲜核。不改变账号权限或数据库，不安装依赖，不改锁文件；原有项目边界保持。
- 上一轮已发布源码（2026-10-07）：`/Users/gouki-youdoo/.codex/worktrees/cutout-validation-paste-20261006/video-api-debugger`，分支`codex/image-compare-20261006`，v0.51.2，实际built/deployed-source `6a5a8f539ce6af9dcdb6edd05f1d08080cb5a30f`，BUILD `tZEbkDJvoGLXx368EiZ1G`；纯记录HEAD不改变运行提交。VREF23把独立视频页与素材弹窗接到已有共享用户状态，保留两入口及原选用链路，加载/失败/未登录有反馈和重试。3文件应用diff、候选内置类型/lint、878源码一致、29公网静态SHA及健康/Git/回退检查完成，功能/浏览器/收费生成未运行，真实选图及旧客户端提示待用户手动验收。正式资料`docs/materials/2026-10-07-feedback-24h/vref23-v0.51.2/`及同日反馈工单VREF23节；VREF22/NAV22的v0.51.1历史交付/手验缺口与其他待办保留，不自动结项。
- VREF23保护发布：release/vref23-v0.51.2-20261007与rollback/pre-vref23-v0.51.1-20261007已推送；回退源码`/srv/video-api-debugger/releases/30e16ef33e478cbbf884b5c1266ea5e98f46d26c-vref23-rollback-source`，回退构建`/srv/video-api-debugger/app/.next-prod-prev-vref23-6a5a8f539ce6`、BUILD8wHmI-2KqZwqjKsRcfpyr。只重启web，图片worker PID1043189/实例未变，持久storage/uploads/videos未覆盖；根盘最后余874296KB高于512000KB保护线，后续发布鲜核。普通gouki账号用于常规读取，不能假设其可sudo bash；必要发布沿已有ops/服务器技能登记的root SSH及既有密钥，不改sudoers、凭据或权限。私人记录不公开Git或部署。
- 上轮v0.51.0的LIKE21/AVUI21运行源b5c8b9f、BUILD w2dFDm8K2jjpZHZ9uQopw保留为历史：喜欢终态/圆背板缩小、头像分格与可选参考链路及双击/Enter预览已部署，仍未功能手验。原19文件/15公网静态证据在`docs/materials/2026-10-07-feedback-24h/ui21-v0.51.0/`，不以本次31资源检查冒称旧功能实测。
- 本轮v0.51.1保护发布：标签`release/vref22-nav22-v0.51.1-20261007`与`rollback/pre-vref22-nav22-v0.51.0-20261007`已推送；回退源码`/srv/video-api-debugger/releases/b5c8b9f82bebc38a62837e5c289bbb19e7c4fbb5-vref22-rollback-source`，回退构建`/srv/video-api-debugger/app/.next-prod-prev-vref22-30e16ef33e47`。只重启web，图片worker PID1043189/实例不变，storage/uploads/videos原持久目录未覆盖；跨盘保护切换、根盘最后余923124KB大于512000KB保护线，下次发布重新核容量。旧回退不删除；私人截图/工单/索引只在正式根本机保留，不公开Git。
- 前版60b/v0.50.0/BUILD Wflt的SIDE/CMP/PAGE18限定10项最小实页PASS保留为历史，只对应该产物，不冒称v0.51.0功能验收；其主管浏览器session已停止。原17项+PAGE18完整状态见`tasks/todo/2026-10-04-template-context-version-code.md`第17节，第18节BUX保留。PAGE18按容器列数×最多3行，cursor下批进下一页，账号/模块或批次隔离恢复；resize保可见项、预读最多20批，失效位置安全回退，不无限追加。
- CUT-A2本人绑定、NAV2真实用途图/脚本、PIN1真正位置、AUD20-D01人物来源/未读口径漏接、FB07其他布局/折叠/等待图及重复暗底、真实付费BUX结果ZIP/物理触屏/clipboard等缺口仍保留。后续无新明确实施或验收授权时不自动改源、测试、收费或发布；收到同对象新授权按现有流程继续，不要求重复确认。当前实际动画、参考生成效果、裁格CORS、跨账号恢复和旧客户端更新提醒未验证，不使用旧照片或构建冒充。
- 保护发布：原60b/Wflt源码与构建回退保留，标签`rollback/pre-like21-avui21-v0.50.0-20261007`；中间71de构建另保留，最终发布标签`release/like21-avui21-v0.51.0-final-20261007`。只重启web，图片worker PID1043189与实例不变；源同步排除.env/依赖/构建/storage/上传/视频/数据库，不删用户资料或旧回退。跨盘按实测暂存，根盘最后余966372KB且保护线512000KB，后续重新核容量。正式根私人反馈/作品/资料索引不推公开Git，应用分支只提交安全源码和脱敏运行记录；发布前重新核`.deployed-commit`/BUILD_ID与实际源，服务器`.git`不作为部署来源，不默认git pull或沿用历史worktree。喜欢、耗时及抠图历史沿固定工单与资料索引检索。
- 服务器部署必须按 `server-deploy-closure` 思路执行：本地形成可追溯 commit / rollback tag -> 用 `git archive` 打包当前提交 -> 上传到服务器 `/tmp` -> 解压到 `/srv/video-api-debugger/releases/<commit>` -> `rsync -a --delete` 到 `/srv/video-api-debugger/app` -> 执行 `scripts/server-ensure-runtime-dirs.sh /srv/video-api-debugger/app` 或等价命令，把 `public/uploads`、`public/videos`、`storage` 迁移并软链接到 `/data/video-api-debugger/var-lib` 下的持久运行目录，同时确认运行目录权限和 `gouki` 对应用根目录的候选构建写权限。
- 上传或同步服务器源码时必须排除 `.env`、`node_modules`、`.next`、`.next-prod`、`storage`、`public/uploads`、`public/videos`、数据库文件、上传资产、视频、截图和其他运行期产物，避免覆盖密钥、现有视频、截图、用户上传和生产构建。
- 当前生产数据盘是 `/data`，`/var/lib/video-api-debugger`、`/var/log/video-api-debugger`、`/srv/video-api-debugger/releases`、`/srv/video-api-debugger/backups` 都应保持为指向 `/data/video-api-debugger/...` 的软链接；不要把数据库、上传素材、视频、缩略图、备份、发布 release 或 sd2 日志重新落回旧根盘。
- 每次同步服务器源码后必须确认 `public/uploads`、`public/videos`、`storage` 是指向 `/data/video-api-debugger/var-lib` 的软链接，并确认 `public/uploads/assets`、`public/uploads/thumbs`、`public/videos/thumbnails`、`storage/backups` 存在且 `gouki` 可写；否则发布同步可能清空历史视频/封面，或让缩略图接口、上传、视频封面补偿和备份脚本在运行时失败。
- `sd2-gray.service` 使用 `NEXT_DIST_DIR=.next-prod`。普通 `npm run build` 只会更新 `.next`，不代表线上生效；服务器生产构建必须用 `NEXT_DIST_DIR=.next-prod-candidate npm run build`，验证 `BUILD_ID` 和预期变更后，再把 `.next-prod-candidate` 切换成 `.next-prod`。
- 图片队列由独立的 `sd2-image-studio.service` 长驻进程处理。涉及 `scripts/process-image-studio.ts` 或其加载的图片生成、下载、引用权限代码时，发布必须同时安全排空并重启该服务；网页服务重启不能证明图片处理代码已更新。停止等待时间须覆盖最长任务及结算余量，确认旧进程正常退出后再同步源码；保留服务配置回退点，核对新启动时间、源码与服务健康，不能为发布强杀已付费请求。背景与检查入口见 `tasks/todo/2026-10-01-image-download-timeout.md`（2026-10-01）。
- 不得直接删除或原地构建 live `.next-prod`。切换前保留 `.next-prod-prev` 或等价回退目录；候选构建失败、候选内容不含预期变更、重启失败或公网仍是旧版本时，必须恢复上一版并停止报告。
- 每次涉及 `sd2` 服务器部署、登录域名、nginx、systemd、构建目录、公开 API、用户可见页面或静态资源改动后，至少验证：
  - `ssh gouki@42.193.221.253 'systemctl is-active sd2-gray.service'`
  - `ssh gouki@42.193.221.253 'cd /srv/video-api-debugger/app && cat .next-prod/BUILD_ID'`
  - `ssh gouki@42.193.221.253 'curl -sS -D - http://127.0.0.1:3302/api/config -o /tmp/sd2-local-config.json'`
  - `curl -sS -D - https://sd2.youdooart.com/api/config -o /tmp/sd2-public-config.json`
  - `curl -sS -D - https://sd2.youdooart.com/login -o /tmp/sd2-login.html`
  - 前端发布只核对公网版本/构建标识及必要静态资源可达性；不自动操作页面、截图或执行功能验收。
- `sd2.youdoodesign.com` 的状态只能用于确认旧入口已停用或迁移，不得把它的健康状态当成当前服务器生产站结论。以后排查“线上没生效 / 无法登录 / 生成失败 / 视频下载失败”时，默认先查服务器链路、`sd2-gray.service`、`127.0.0.1:3302` 和 `sd2.youdooart.com`。

## UI 规则

- 2026-10-07 UI27用户确认：模板图片区用途在框内、数量规则按现有管理入口设置；主生成清楚且显示真实总积分。模板提醒复用私有seen回执，仅本人/当前模板/服务端成功版本快照在明确进入且列表成功后确认；后台/初始URL/自动恢复不清，失败可重试，快照后新完成仍提示，人物历史不误亮正常模板。对比左原图/右对比图原则不变，禁止自动或手动互换内容及反置恢复，但两侧可各自换图并独立定位/缩放、联动锁常显、对比居中；文件大小/原像素未知不伪造、不为查大小下载原图。素材卡只留有效选图信息、原数据按需可看、图内删除保留原确认；首页明确改选抽象Lucide而非历史NAV2用途插图；等待图是实际输入快照、首次就模糊且铺满方框，不冒称AI中间结果。正式原话及五私有图沿主管同日UI27/DOT24工单与资料索引读取，功能仍手验，不重复旧诊断/生产账号探针。

- 2026-10-07 UI26用户确认：模板“我的喜欢”在模板页原导航下就地展示实际清单，不代跳资产页；已安装定位原模块，未安装只经原明确使用。分组删除放各行独立图标，不在native option里嵌交互、不以删除选择分组或生成；仅删除模块按钮去文字，原保护确认不丢。共享大图和两侧换图先用同对象缩略图再升级预览，原图仍显式请求；独立双图定位优先于默认同步技能。相关原话/私有附件沿正式同日工单UI26与资料索引检索，五项真实效果待用户手验，不用源码标记或构建冒称通过。

- 2026-10-07 VREF23用户反馈及源码结论：独立视频生成页使用共享素材选择器时，页面及弹窗必须读取同一已初始化的AppSession；不保留仅页面局部user却让弹窗读空共享user的并行状态。保留账号隔离与原选图/图集回调，登录读取失败给可重试反馈，不删除守卫或重放生成。完整原话、源码因果与手验缺口见同日正式工单VREF23节；不将代码/构建证明冒称用户按钮实测。

- 2026-10-07确认：视频模板需求输入框上方使用生图模板同款参考图区，沿用素材ID、槽位、首尾帧和草稿链路；视频/音频/参数按需展开，不重复图片列表。顶部导航移除“超分”，原功能和其他入口保留。文案模型仍按现有文字能力运行，未确认任务不自动重试，真实功能由用户手动验收；正式原话/资料在根目录同日反馈工单VREF22/NAV22节和资料索引，私人原件不公开Git。
- 所有生成记录列表、任务记录列表、产出记录列表、项目内生成列表和视频卡生成列表，最左侧第一列必须是视频截图/缩略图。
- 生成记录列表不得让提示词、日期、状态、项目名或成本信息直接顶到最左侧；视觉扫描入口必须先看到对应视频画面。
- 视频截图优先使用任务缩略图、首帧、本地视频截图或已有产出预览图；没有可用截图时，也必须保留尺寸稳定的缩略图占位，并明确表现为“暂无截图/预览不可用”，避免列表布局跳动。
- 该规则适用于 `/admin` 最近生成记录、`/admin/outputs`、`/tasks`、项目详情、视频卡详情以及后续新增的任何生成记录列表；如果确需例外，必须先得到用户明确确认。
- 界面中凡是展示用户、成员、创建者、生成者、管理员、操作人等人物姓名，姓名左侧必须显示头像；真实头像缺失时使用稳定首字母/颜色头像占位，避免只展示纯文字姓名。

## Codex 默认职责

- 在 Hermes 明确任务边界后，按允许修改范围执行代码或文档修改。
- 修改前读取必要上下文，优先遵循项目既有目录、命名、技术栈与实现风格。
- 做本项目的新功能或模块时，先查项目内现有实现和成熟开源模块/组件/SDK/模板；能复用就优先复用或少量适配。复用前必须核对许可证、维护状态、依赖体积、安全风险、和当前 Next.js/React/Prisma 技术栈及本项目 UI 风格是否匹配，避免为了省事引入不必要的大包或不可控代码。
- 对高风险区域保持最小改动原则，必要时先要求 Claude Code 或用户补充只读分析。
- 每次只处理当前任务，不顺手重构、不扩大范围、不隐式改变业务规则。
- 修改后默认只执行发布必需检查；功能验收由用户手动完成。用户另行明确要求的测试按指定范围执行，未执行项如实说明。
- 完成用户可见改动后默认自动部署，新产物供用户刷新获取，实际效果由用户手动验收；不能只停在本地代码、构建或 Git。
- 如果当前目标是 `sd2.youdooart.com` 或服务器版 `sd2`，除非用户明确要求“只做本地/只做代码”，否则自动完成候选构建、服务切换及必要的版本、健康、公网可达性检查，不自动做 DOM/截图或业务 API 功能验收。
- 用户反馈线上 `sd2.youdooart.com`、当前浏览器页面或已发布页面仍未生效时，必须把服务器部署作为任务范围：检查服务器 `/srv/video-api-debugger/app/.next-prod/BUILD_ID`、`sd2-gray.service`、`127.0.0.1:3302`、nginx 和公网 `https://sd2.youdooart.com`，不要回到 Mac `youdoo-sites` 链路。
- `systemctl is-active sd2-gray.service` 只能证明进程健康；还须通过公网版本/构建标识或对应静态资源确认新产物已发布，但不代替用户手动验收。
- 发现已有未提交改动时，不回滚、不覆盖非本轮产生的变更；若影响本轮任务，应先说明冲突和处理方式。
- 输出汇报时明确列出实际修改文件、验证命令、验证结果、风险与遗留问题。

## 按需审核线程规则

- 本项目固定审核线程为 `审核001 - sd2 固定只读审查`，thread id：`019f44c6-64d3-7753-acd0-f31fc16763fb`。
- 仅用户明确要求独立审查、审核或只读复查时，交给该审核线程；默认不派审核、不等待审核再部署，功能验收由用户手动完成。下列规则只约束明确启动的审核任务。
- 审核线程默认审查实际生产工作树 `/Volumes/Data/Projects/video-api-debugger-v12-full-todo`，除非工单明确指定其他路径。
- 审核线程严格只读：不得修改源码、配置、数据库、构建产物、生产数据，不得提交 Git、推送、打 tag、部署或补实现。
- 审核过程中发现的问题，统一记录到固定文档 `tasks/audit-001-review.md`；该文档是审核记录唯一允许写入的项目文件，记录只追加审核发现，不做实现修复。
- 每条审核记录必须写清：日期、审查对象、结论（通过/不通过）、阻塞问题、非阻塞风险、证据、建议下一步。
- 审核完成后，审核线程必须回到发起线程同步结果，固定收尾语为：`审核完成，等待推进`。同步内容必须包含通过/不通过、证据、缺口和下一步。

## Codex 禁止事项

- 未经明确授权，不得修改 `src/**`、`prisma/**`、`package.json`、`package-lock.json`、`tsconfig.json`、`.env`、`public/**`、`storage/**`、`.next/**`、`.vercel/**`。
- 不得安装依赖、升级依赖、删除依赖或改动锁文件，除非任务明确要求。
- 不得执行数据库写入、迁移、`db:push`、种子脚本或会改变本地/远端数据的命令，除非任务明确要求。
- 不得修改点数、登录、权限、支付、鉴权、中间件、Provider 适配、上传、外链拉取等高风险业务逻辑，除非任务明确要求且边界清晰。
- 实现完成后默认自动聚焦提交、推送并登记版本；功能验收不是提交或部署的等待条件。分支策略或风险边界不适合直接推送时，使用隔离分支等安全方式，不让改动只留在本地。
- Git 上传不需要用户二次确认：实现完成且存在已配置 remote 时，默认自动 commit、push、创建必要 rollback tag、远端复核和版本登记；没有 remote、认证/网络或必要安全检查失败、疑似敏感文件、会覆盖他人改动或需要破坏性 Git 操作时暂停报告。
- 用户说“上传 Git / 做 git / 形成版本 / 方便回退”时，完成标准是远端可回档：对应 commit 必须推送到 remote，稳定回退点必须创建并推送语义清晰的 rollback tag 或等价保护分支，并用 `git status --short --branch`、`git ls-remote --heads`、必要时 `git ls-remote --tags` 验证远端可见。
- 禁止自动 force push、删除远程分支、覆盖用户提交、破坏性发布或不可回滚部署；这些操作必须得到用户明确确认。
- 不得读取、打印、复制或泄露 `.env`、密钥、token、cookie、数据库凭据等敏感信息。
- 不得把 Claude Code 的只读分析结论扩展成未经确认的事实；不确定时应标注为推断。

## 每次完成后的汇报格式

1. 改了哪些文件：
   - 列出实际修改的文件路径。
2. 每个文件具体写了什么：
   - 简述每个文件新增或修改的核心内容。
3. 跑了哪些发布检查：
   - 列出必要构建、版本、服务健康与公网检查；文档修改只列差异检查。
4. 部署与验收状态：
   - 分开说明部署检查结果和“待用户手动验收”；不把未执行的功能验收写成通过。
5. 是否存在越界或风险：
   - 明确说明是否改出任务边界，是否触及高风险区域。
6. 遗留问题与下一步建议：
   - 如无则写“无”。
7. 统一 diff：
   - 提供本轮允许范围内文件的 `git diff`。
