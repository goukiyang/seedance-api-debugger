# 高清全链路可靠性修复计划

project: video-api-debugger
document_version: 1.0.1
target_root: /Volumes/Data/Projects/video-api-debugger
version_source: package.json → src/lib/release.ts → /api/release
runtime_observed: 2026-10-19T22:41:02.841Z v0.99.2 / 6512e723804b1e2d1274309498c3e5bb514ee3ae / laGD9U4RLJWwcK60Qxkxa（Web/image/HD同源保护部署完成）
source_reviewed: codex/hd-chain-reliability-20261019 / 6512e723804b1e2d1274309498c3e5bb514ee3ae（实际应用源；后续纯记录提交不冒运行源）
relock_at_execution: true
status: H01–H10整批工程与保护部署完成，v0.99.2已上线；两完整Linux20构建/原门、Review0open、实际原生切换与最终保护/公网产物有证，待用户手动验收。旧失败/恢复原件全部保留
planning_depth: G5（跨前台、后台、持久文件、权限、生产切换与回退）
risk: L4（原件/私有媒体/历史结果/发布及恢复保护）
updated_at: 2026-10-19 America/Los_Angeles

当前实施：用户明确“按之前完整计划开始修，把整个高清链路修好，不要只修目录。已有高清直接复用，没有再补做，保原图已有结果权限，做完部署手验”。17:39–17:43Z鲜核实际Web/image为32ba8e5f67112de63721c11e3cdc131aca1dab1a／v0.99.0，保其质量路由增量；HD仍原649独立进程。Web/image仍读5a59分叉：120 queued均同key/原件版本匹配canonical，119已有ready长度有效、1 skipped；canonical共1250（1226ready/24skipped）、无job锁/publish/tmp，control active。原件/DB/全局锁身份保持，未改生产。此为鲜只读样本，不硬编码后续数量；原规划“本轮不实施”均为历史阶段，不取消本次实施授权。任务编号和完成标准不变，应用版本交付前按鲜核PATCH一次，所有功能仍用户手验；TRACE/GEN继续暂停。

## 1. 目标、依据与交付边界

用户本轮确认：“就按你推荐的方案，把整个高清链路修好做任务规划，不要只修目录问题。保留原图、已有结果和权限。”本轮交付完整修复计划，不把规划完成当成修复完成，也不立即改生产。后续实施应一次覆盖下列H01–H10，不得修好路径就关闭整单。

目标：图片原件成功交付后自动提前准备高清；用户打开时能先看图，正常等待与真实故障分开；一张图的已知可恢复故障不拖停其余图片；中断、发布和回退后仍能沿原任务接续，原图、已有成品与权限不变。

已完成依据复用：[原高清工单§21根因与开源审查](2026-10-07-image-preview-download-performance.md#21-hd-roothd-strategy高清反复不可用的根因与链路审查2026-10-18)。2026-10-18T10:00:32.780Z生产只读数据：Web的24条queued均对应独立worker同key/同源版本的ready成品，文件长度相符；两者真实HD目录不同；worker仍自然完成新图。锁争用升级硬停、部分单图异常升级全队列硬停、发现/编码串行、优先级与文案问题有源码证据，但未把这些风险冒充每次历史故障的原因。

本轮补充核对：`finishStudioTask`存在被外层事务调用的路径，不能把HD登记塞进结算事务；`finishRejectedStudioDimensions`保留规格不符原件后仍可能是failed/uncertain，不能只依据succeeded决定有无可交付图片。真实产物判断应复用`studioTaskHasViewableOutput`，不是另造“失败即没图”。

选定技术：继续Sharp和现有耐久HD任务/原子发布回执，不新增Redis/PostgreSQL、云服务或队列平台；借鉴BullMQ任务隔离、Capistrano固定共享数据和PhotoSwipe渐进读取。开源实际代码、许可及适配证据见§8。H01–H10是同一修复交付，不是十轮独立发布。

### 1.1 不可破坏条件

- 原图字节、格式、尺寸、透明度、存放位置/版本和已保存资产ID保持；不覆盖原图，不转码“修正”供应商原件，不替用户淘汰已交付结果。
- 已有ready成品优先复用；保持旧HD_POLICY、原件版本键和现有编码参数。没有参数变化不得批量换key、全量重新压缩或把所有结果退回queued。
- 保任务、原request/providerID、冻结参数、账单/退款、隐藏/删除状态、素材归属、模板/作品/收藏/分享关系。高清失败不能改生图终态、重复结算、重发生成或恢复用户隐藏项。
- 所有既有读取权限仍在服务端校验：本人、共享可用、仅预览/仅点赞、原件下载、管理员分开；不能因固定磁盘路径或缓存可用而授权。共享预览不升级成HD/原图读取。
- 保文本/透明无损WebP、其它AVIF quality95/4:4:4/effort6、原尺寸/完整性检查；AVIF不称无损。远端版本未知、已WebP、ICC/位深等不适配继续沿原图合法路径，不强行转换。
- 保单击预览、500ms单双击区分、双击直接输入主图回填、缩放/平移/对比/复制/下载、账号隔离和工作现场。此前PREVIEW01精简、手机素材及IMG-VIS修复不得被旧分支覆盖。
- 不改DB schema/DDL、供应商、费用、执行并发上限或全站媒体系统；不新增监控定时任务、公开媒体入口、全量日志采集或自动外发。

## 2. 修好后的统一合同

### 2.1 固定存储与兼容

生产唯一HD根使用现有`/data/video-api-debugger/var-lib/storage/hd-derivatives`；通过一个统一解析入口/显式配置（建议`HD_DERIVATIVES_DIR`）供Web、生成完成登记、HD后台、管理员与发布工具复用。生产不再按各release的cwd选目录，也不静默在系统盘或release下新建替代根；本地/隔离测试可显式指向私有临时根。

必须分别验证真实挂载、realpath、目录设备/权限和读写各方的最终目标，而不是只比较配置字符串或顶层storage链接。全局worker锁继续落同一个已有持久锁位置，不能因新路径解析产生第二把锁。原件根不搬动，避免改变hdRequestIdentity中的原件身份。

固定根/存储安全无法确认时，HD领取与发布停止并返回明确状态；既有原图接口不因此全站失效，也不能绕权读旧缓存。已运行的新程序使用错误根时由发布门拒绝上线，而非上线后等待用户发现。

### 2.2 登记、发现与调度

原图/小图和资产/任务/账务事务成功提交 → 尝试立即耐久登记HD → 独立、有界扫描补漏。登记失败单独记录，不抛回供应商生成/结算catch，不回滚交付，不调用供应商。无论同步、原异步接续还是正常的规格不符原图保留，都覆盖实际可交付资产；已完成一次性历史修复不重跑。

有外层事务时只在外层提交成功后登记；不能在事务未提交时让HD读取到资产，也不使用无人管理的fire-and-forget冒充耐久登记。登记延迟/异常时由原游标补漏；任务发现复用`studioOutputTaskWhere`候选与`studioTaskHasViewableOutput`精确判断，覆盖有原件的failed/uncertain交付，不泛化所有失败任务。

同一个主管进程拥有全局锁；发现/资源复核与编码采用可独立推进的循环，扫描同一时刻只跑一次。继续原双流游标、100项/轮上限、登记或隔离成功后才推进游标、资源等待期间可安全发现。不是增加多个并行编码者；默认实际编码仍1张。

调度顺序为“当前打开的图片 → 新图提前准备 → 历史补齐”，必须让当前查看真的排到后台新图前。用共享命名优先级/调度函数，兼容旧0/1/2/3含义，不按重新赋数字误解旧记录；可追加版本化调度字段，缺字段按原语义映射，不全量改写历史。连续高优先任务须有有界公平插槽，不饿死新图和旧批；不抢占已经编码中的单图。HEAD和邻图预取保持只读，不借预读无限建任务。

### 2.3 隔离单图与恢复

主管负责取任务、资源准入、任务租约、阶段/尝试记录和最终发布；独立子进程只处理指定原件到本次私有临时输出，不写DB、control或任务终态，不访问供应商。重用既有编码及验证逻辑，提取共享函数，不复制一套质量规则。

子进程设置有界整任务期限及必要阶段期限，参数集中维护，不能只依赖Sharp局部timeout。期限应覆盖现有编码、解码校验与调度余量，不未经证据缩短正常大图能力；隔离夹具验证期限/退出机制，真实性能数值不预先承诺。超时仅针对本次已知子进程，确认它和所属后代已退出、临时输出及原发布回执可解释后才能释放/重试；不能仅Promise超时就启动第二个写者。主管异常退出后的systemd进程组/锁继承也须证明不会留下可发布的旧执行者。

父进程核key、源版本、执行代次、输出路径/长度/类型和验证结果；源版本及权限边界变化不发布旧结果。临时文件不可越出本次受控目录；未确认退出/身份、未知回执、完整性错误继续保护。发布继续沿临时文件→fsync→耐久publish回执→rename→ready登记→清回执，不删除被回执引用的输出。

错误合同：

| 类别 | 处理 | 禁止 |
|---|---|---|
| 有效活锁短暂争用 | 本轮跳过/有界退避，再选其它due任务；不改持锁者 | 不全局硬停，不抢锁、不消耗编码次数 |
| 已知单图不兼容 | skipped并保原图，继续后项 | 不强转色彩/格式冒成功 |
| 已知、已确认无未知发布的单图临时IO/编码超时 | 仅该图有限重试，沿原3次上限和有界退避；耗尽保failed及原因，其余继续 | 不无限重试、不复用旧进程、不重新生图 |
| 未分类单图异常 | 保原始脱敏原因与现场；未证明可隔离前维持保守保护 | 不把所有unknown都自动重试 |
| 系统资源暂忙 | 原resource_wait、稳定样本恢复；无due项保持空闲 | 不自动解除人工暂停或硬故障 |
| 持久根/权限/磁盘/源边界/成品完整性/未知发布或锁身份 | hard_pause并明确维护入口，修复后鲜核才能恢复 | 不清pause绕过、不覆盖原记录 |

保持现有queued/running/ready/failed/skipped与control v2兼容；阶段、错误类别、retryAt、执行代次等优先作为向后兼容可选字段。旧记录缺新字段不伪造进度。恢复先核原任务/原回执，已发布完成登记即可，不重复编码；在途未知不将超时当已退出。

### 2.4 用户查看、下载与管理员入口

普通用户仍从原结果卡单击进入共享大图查看器，不增加“先生成高清”步骤。主内容是图片，状态用底部短文字；不新增正常流程确认弹窗或整屏技术面板。

| 实际状态 | 查看器行为 | 可做什么 |
|---|---|---|
| 确认中/排队/处理中 | 先保同对象的合法缩略图/预览，已有1600预览可做中间档；状态分别为“正在确认高清/高清准备中” | 可缩放查看、离开；有权者可主动查看/下载原图 |
| HD ready | 直接读同版本HD；已显示预览时解码完成后替换，不先自动下载原图 | 正常查看、复制、下载；预览不冒充原尺寸 |
| ready且原件更合适，或确定不适配压缩 | 沿现有合法原图路径，说明使用原图，不当故障 | 原正常操作保持 |
| 单图失败/全局暂不可用 | 保已有合法预览，说明实际影响；适用时沿原图兜底，不重新生图 | 保原图入口；HD读取失败可“重新读取”，不误作重新编码 |
| 登录/权限/来源失效 | 取消读取、清同族缓存与已显示受保护内容，沿原登录/返回入口 | 不能以“原图兜底”绕过拒绝 |
| 用户已主动选原图 | 保原图选择，不因后台HD完成自动切走 | 用户自行切回高清；不重置现场 |

轻量预览→HD保持同一内容ID/源版本及标准化缩放中心、fit/100%语义；不能按低清预览固有像素重算100%。复用`use-media-preview-state`/comparison现有键，不另造并行状态仓库；账号切换、换图、迟到响应不覆盖新现场。loading/锁/错误状态不持久化，重开只读原任务不重新提交。

预览可立即显示，但不因此过早解除“当前目标图优先”：若HD已ready，当前HD读取先完成再恢复邻图；若仅排队等待，本图无需持无限网络优先锁，但只能有界预取已ready邻图，当前HD就绪后重新优先。保最多2个方向邻图、账号/变体/版本缓存、取消无人使用读取、saveData约束；不把预览Blob借给HD/原图下载。

下载继续fresh HEAD核当前权限、同源版本、MIME和完整长度后借HD Blob；miss走原生流。原图下载仍完整原件，不用预览替代，不改文件名/格式规则；复制沿原本权限和实际清晰档要求。HTTP409新版本仅有限重新确认，不循环；401/403/404仍撤销同族访问。

管理员沿`/admin/image-studio`现有“高清图准备”，不另建后台：显示全局实际状态、待办/重试/失败数、最后真实进展及下一次检查；详细原因按需展开，普通页面不暴露路径/堆栈。已有“暂停/继续/重新检查/重试”只对对应真实可操作状态启用，继续鲜核admin、Origin和control token；普通错误重试只处理允许的原HD任务，不放开硬停。沿用RelativeTime近时显示、点击准确时间及账号隔离展开偏好，不新增通知服务。

## 3. 任务包与完成标准

以下是同一交付的实施清单。2026-10-19本批代码及配套已交齐，正在统一工程检查；源码完成、工程通过、部署和功能手验分别对账，不以工作包交稿冒验收。

| 编号 | 任务内容与主要落点 | 完成标准 | 依赖 | 状态 |
|---|---|---|---|---|
| H01 | 统一HD持久根和保护性接回：`src/lib/media/hd-derivatives.ts`的hdDirectory/容量/访问检查、`authorized-image-response.ts`；统一存储解析模块及发布收敛脚本按需新增 | Web/登记/后台/admin根相同；原件根与key不变；原24条ready直接可读不重编码；两侧现场不丢 | 执行时鲜核版本和writer | 已部署待手验；固定根/同锁/既有ready原字节读取有证 |
| H02 | 生成后立即登记并可靠补漏：`src/lib/image-studio/worker.ts`两个完成点、`dimension-rejection.ts`外层事务完成后、`hd-discovery.ts`、扫描调用处；复用`dimension-mismatch.ts`产物谓词 | 成功/保留交付均覆盖；登记失败不改任务/费用；崩溃漏登记由有界扫描补回；旧一次性修复不重跑 | H01合同 | 已部署待用户手验；整批Linux20默认工程门通过 |
| H03 | 真正的查看优先与独立发现：`scripts/process-hd-derivatives.ts`、`hd-derivatives.ts` selectHdJob/requestHd、`hd-discovery.ts`、`authorized-image-response.ts` | 当前查看优先于后台新图，所有队列有公平机会；编码进行中仍可发现/复核；无重复领取 | H01，H04接口 | 已部署待用户手验；整批Linux20默认工程门通过 |
| H04 | 单张编码进程隔离：从`processHdJob`提取现有编码/验证，新增`scripts/process-hd-image.ts`及共享执行器 | 子进程不碰业务/终态；有界超时、退出确认和旧代次拒绝；默认并发仍1；原尺寸/质量验证保持 | H01 | 已部署待用户手验；整批Linux20默认工程门通过 |
| H05 | 故障分类与原任务接续：`withHdLease/processHdJob/retryHdKey`、worker顶层catch、`hd-resource-state.ts`、原publish回执路径 | 正常争用/单图已知异常不全停；3次有限重试；中断前后只接同key；真硬故障不误解锁 | H03/H04同一后端包 | 已部署待用户手验；整批Linux20默认工程门通过 |
| H06 | 查看器渐进显示和真实状态：`image-preview-session.ts`、`hd-display-policy.ts`、`hd-source-session.ts`、`ZoomableImagePreview.tsx`、`ResultImageCover.tsx` | queued/running不报不可用、不自动读完整原图；ready平滑替换；主动原图不被抢回；双击/缩放/对比/小屏保持 | descriptor合同先锁定；可与后台并行 | 已部署待用户手验；整批Linux20默认工程门通过 |
| H07 | 权限、缓存和下载守住原合同：`image-read-session.ts`、`native-download.ts`、`image-comparison.ts`、`use-hd-image-source.ts`与原媒体授权路由 | 无跨账号/跨版本/跨变体复用；拒绝清族；HEAD/preload不创建任务；原图/复制/下载不降档或越权 | H06同一前端包 | 已部署待用户手验；整批Linux20默认工程门通过 |
| H08 | 后台状态及最小诊断：`HdDerivativeManagement.tsx`、`src/app/api/admin/hd-derivatives/route.ts`、hdStatus及执行阶段记录 | 状态/实际进展/重试时机对应；admin/Origin/CAS保持；原异常脱敏可定位，不出现假健康/假完成 | H05状态合同；UI可独立 | 已部署待用户手验；整批Linux20默认工程门通过 |
| H09 | 把防复发检查接入真实构建/发布：扩展`test-hd-stability.ts`、`test-hd-display.ts`及必要私有夹具，接现有`check-image-recovery.mjs`完整回执门；新增统一HD存储运行检查供本次发布控制器调用 | 隔离负例真实失败；既有门不丢；缺脚本/空跑/旧回执/目录分叉拒绝发布；不是只写未调用测试 | H01–H08整批完成后统一运行 | 真实默认prebuild/双完整构建/生产resolver及40公网资源核对通过 |
| H10 | 同批版本、保护部署、相容回退与手验交付：`package.json`、`src/lib/release.ts`、`ReleaseNotice.tsx`及实际服务器发布控制器 | 完整构建/Git/真实运行/持久保护有证；保可运行相容回退；已部署待用户手验，不冒功能已通过 | H09通过，发布窗口鲜核 | 已保护部署v0.99.2，实际原生切换/最终策略与持久保护通过；相容guard完整构建保留、回退未演练，待用户手验 |

### 3.1 共享修改边界和执行顺序

1. 先锁定H01存储、H05错误/执行代次、H06 descriptor与显示合同，确认不改原任务和费用。
2. 后端H01–H05由一个写入负责人维护`hd-derivatives.ts`/worker，避免多人改同一核心；前端H06–H07一个负责人维护会话/查看器；H08管理界面与H09发布门的独立文件可在接口明确后并行。无需人为规定人数，实际容量按执行时核对。
3. 单一lead集成整批代码、工程夹具和配套后，统一Verify→Review；不逐项边测边发布，不让“目录暂时恢复”替代整单。
4. 本轮只有规划，不派实施或审查线程。项目默认用户手验及不自动派审核规则优先；实施者做同一清单的源码Review，须注明非独立，不以独立审查已通过回执。用户另行要求审核时才安排对应只读审查。

## 4. 数据接回、发布与回退

### 4.1 收敛现有分叉，不清空重建

执行前重新盘点固定根与发布树分叉目录的job、control、lease、publish回执及成品；制作私有清单和必要备份，全部在真实/data。当前24条证据可复用为定位，不当成执行时全集。

- 同key/源版本在固定根已有合法ready：保留固定根原成品/清单；分叉queued仅作为现场证据，不覆盖ready，不重复编码。
- 分叉独有queued：原件/原版本和用途可确认且无在途/回执冲突后，沿正常登记入口补同key；记录对应关系，不手改生图状态。
- 分叉独有ready：保留原件与该成品；核身份、长度/格式/原完整性证据后按兼容导入流程接到固定根，不能被低级queued覆盖。
- 任何同key版本、成品或发布状态矛盾：保两侧，停止该冲突对象的迁移与相关切换；不按更新时间猜赢家。
- control/人工或硬暂停只用当前权威worker的鲜状态，不把分叉或备份control覆盖回去；锁和在途回执不得直接复制成新活动锁。

发布收敛阶段须排尽会继续写旧目录的旧Web/登记/HD writer及子进程，再完成最终差量核对。允许准备新候选及只读预检并行，不允许两套HD后台同时消费。原图读取尽量保持；若切换需短暂HD只读，状态如实显示，已成功生图和原图不被回滚。不要求用户重发请求。

### 4.2 正常发布门必须覆盖旧问题

复用现有完整候选构建和发布保护入口，不绕过`check-image-recovery.mjs`或替换原prebuild合同。将HD离线工程门纳入其同run/源码/时间窗/私有完整回执核对；同一门由实际发布控制器调用。另做真实运行存储检查，离线门不能替代挂载、realpath或运行者一致性。

本次发布控制器不能再沿旧`storage`整树盲链接，也不能继续豁免`hd-derivatives`冲突。将共享存储合同检查放入正常后续发布路径；旧临时脚本保历史原证但禁止作为新发布入口。若普通部署账号仍可绕过实际服务器切换门，回执明确“非不可绕过”，不得声称绝对防覆盖；不为此擅自扩大权限或重建部署平台。

构建前重新核线上源码、worktree脏改、原件/DB身份、图片生成worker与HD独立运行源、实际/data、在途任务/回执、当前发布窗口。实施采用当前有效源码的干净隔离工作区，保护正式根已有脏改，不能以旧649/v0.90.2整树覆盖当前应用。

H02修改生成完成登记，实际部署要包含对应生成worker；不得只换Web就称立即登记生效。切换须沿项目自然排空/冻结原请求规则，不中断正在受理的供应商任务、不重复提交；HD则确认原锁唯一、旧子进程已退出后接续。未涉及的多视图作品/角色消费者不重启。

版本按实施时真实发布版本自动升一次PATCH（若仍v0.95.4则v0.95.5；执行时重核，不锁死编号）。单一来源保持，更新摘要写“高清加载与后台接续修复”等实际变化；旧客户端仅对真实更高版本提示、标题≤8字、稍后去重、手动再检查和工作现场保护沿原实现。当前规划不升级应用版本。

### 4.3 相容回退

回退只回程序/配置中属于本次程序的定向差量，不回DB、媒体、任务、账单、用户权限、隐藏状态、原control和新成功回执。保留原始两套目录与备份，不清理release或用户文件。

旧v0.95.4程序直接回退会恢复错误目录/旧硬停语义，不能作为唯一安全回退。准备完整可构建的相容回退包：旧界面或前一应用功能加固定存储解析、必要新字段/回执reader和拒绝不相容writer保护；如新后台记录无法由旧worker安全读写，则回退包保相容HD后台，不能硬启动旧649。实际新旧worker都须在无活动子进程、原锁空闲和原回执可解释后切换。记录回退允许范围、缺失体验和未演练项，不用git标签冒充可运行回退。

## 5. 验证与防复发证据

遵项目“用户手动验收”：本轮只规划与静态核对；后续默认保完整候选构建及内置离线工程门、版本/健康/公网/持久数据保护。不得自动跑浏览器、生产故障注入、收费生图、供应商调试或全站回归。以下离线故障夹具作为本次候选内置门设计，不能绕到生产数据执行。

### 5.1 整批离线工程门（实施后）

| 编号 | 对应目标与负例 | 必须证明 |
|---|---|---|
| E01 | 同原件、两release cwd、同共享根；错误分叉/未挂载/权限不足 | 新resolver始终同根同key；错误配置被拒绝，不偷偷建本地空队列 |
| E02 | ready/queued重复及两侧冲突、回执未决 | ready复用不重编码；冲突保两侧不覆盖；不改原件/账务 |
| E03 | 登记成功/失败/进程中断；正常与保留规格不符产物；外层事务回滚 | HD仅见已提交资产；登记失败仍保持原成功/保留结果与原结算一次；扫描最终补漏 |
| E04 | 当前查看、新图、旧批持续到达 | 查看优先且旧批不饿死，次数/延迟有界，HEAD与邻图不注册 |
| E05 | 真实锁竞争、已退出持锁者、未知锁身份 | 活锁争用不硬停/不抢锁；已证退出才回收；未知仍保护 |
| E06 | 子进程超时/崩溃/迟到输出/无法退出；随后正常图 | 不双写，后项可继续；无法证明退出则不重启第二个写者 |
| E07 | publish前、rename后、ready登记前/后的中断 | 原key接续一次，已完整发布不重编码；原回执/临时文件不误删 |
| E08 | 真磁盘/权限/完整性/人工暂停与资源暂忙 | 硬停不自动解除；暂忙按原稳定窗口恢复；空队列不误报等待 |
| E09 | descriptor pending→ready/failed/denied；主动原图；换图/切号迟到返回 | pending保预览不拉原图；ready只显示同版本；主动选择和缩放保持；拒绝清族 |
| E10 | fresh HEAD通过/拒绝/版本变化；缓存不同账号、变体、长度、MIME | 只有完整合法HD可借用；预览不得冒原图/下载，拒绝不绕过 |
| E11 | admin身份/Origin/token变化及错误类别 | 普通用户无管理能力；冲突不重放POST；重试不触发供应商或费用 |
| E12 | 门缺失、空回执、旧run、旧源码、断言失败 | 默认构建与实际发布入口均拒绝；既有27项检查完整保留 |

实现先合完全部修改再执行统一`npm run build`（带新旧内置门）、必要lint/type；不运行`npm run test:api`。私有夹具使用新临时根、隔离DB或明确无SQL的适用路线，不接真实供应商。已有`npm run test:hd-stability`可作为同一内置门底层复用，不能凭独立脚本exit0冒完整回执。若需额外真实功能测试，单独沿用户明确范围进行。

### 5.2 发布必要薄核（实施发布时）

- 候选与相容回退源码/依赖/BUILD有证；同批release/config实际版本一致，静态资源可达，现有访问保护未放开。
- 所有HD生产者/消费者/管理读取者真实根相同，持久卷/原件/DB身份保持；同一既有ready记录和成品可从新服务使用的读取路径核到，不新编码造样。
- 唯一HD锁与实际子进程受控；无旧writer继续写分叉根；已存在成果/控制状态/账单保留，无法确认时不强切。
- 写明应用程序已部署与用户功能手验的区别，不以active、200、版本号或源码存在当效果通过。

### 5.3 用户手验清单（不自动执行）

- U01：模板普通/喜欢结果打开已有ready图片，看到原尺寸高清，原图和HD分别能按原权限下载。
- U02：自然新增图片提前准备；pending时可看预览、可主动原图，HD就绪自动换清晰档但不改变缩放中心。
- U03：明确选择原图后HD完成不抢回；关闭重开/切换图片/对比/双击回填沿原行为，手机操作不挡图。
- U04：仅预览分享账号不能看原图/HD或借缓存下载；切号/撤权后原受保护图片不残留。
- U05：管理员能区别单图失败、资源等待、人工暂停、硬故障；仅适用状态可重试，查看“最后成功”不冒当前仍健康。
- U06：旧客户端发现已发布新版本，稍后不反复弹，主动刷新后版本正确且现场保留。

手验不通过保留具体对象/步骤，统一归因后整批修复，不无授权造收费样本。无网络/解码耗时基准，不承诺“稳定秒开”；预期目标是消除已知断链、无故全停和错误加载，而非人为设成功率。

## 6. 停止条件与未决边界

以下不是允许缩减目标的理由：新鲜证据显示源/权限/控制/发布状态冲突、无法确认旧执行者退出、无法证明相容回退、数据盘异常、真实读写目标不一致、构建门缺失/失败时，停止受影响切换或写入，保原运行与资料，继续不依赖它的安全工作。

已知但不阻规划：未取得本次具体图ID、浏览器网络瀑布及真机性能值；不影响已证目录根因和选定修复合同，真实体验留手验。第一次创建分叉目录的具体命令尚未定位，不是恢复当前一致性所需前置，不能编造责任动作。没有新的产品选择需要用户决定；实施时须复核动态状态，不能把当前24条样本当永久数据集。

当前自动防复发门尚未接入，H09是必须实施的交付项；本计划及规则文字本身不是保护。若只实现H01、只做构建或只完成发布，整单仍未完成。

## 7. 资料、路径与交接

正式根：`/Volumes/Data/Projects/video-api-debugger`。当前已核应用源码工作区：`/Volumes/Data/HomeRelocated/gouki-youdoo/.codex/worktrees/context-toolbar-ui-20261017/video-api-debugger`，分支`codex/context-toolbar-ui-20261017`；正式根含历史脏改，不能整树覆盖或整树提交。后继实施从当时线上有效代码和适用最新修复接续，聚焦提交到既有origin，不force push。

现有资料（均为本机正式根，私有原证不随安全代码推公开Git）：

| 资料 | 用途 | 路径/状态 |
|---|---|---|
| 原高清工单§21 | 本次生产根因、24条对应、代码/开源依据和缺口 | `tasks/todo/2026-10-07-image-preview-download-performance.md`，UTF-8已读 |
| 原高清工单§18/19及HD-ST07原证 | 保护已有首开/下载、资源等待/空闲、旧control兼容与历史回退事实 | `docs/materials/2026-10-15-result-controls-hd-stability/implementation/source-review.json`及同目录`supervisor-thin.json`，已核存在可读；详细历史沿原单 |
| INC24发布脚本 | 对HD目录冲突豁免与继承路径证据，只作历史参考 | `docs/materials/2026-10-17-image-content-incident/inc24/img-vis-release.mjs`，已读 |
| 手机发布脚本 | 顶层storage沿用及后继保护缺口证据 | `docs/materials/2026-10-18-mobile-materials/mobile-release.mjs`，已读 |
| 现有应用代码与两个HD工程脚本 | 复用点/接口与隔离验证基础 | 上述已核源码工作区，不以正式根旧分支代替 |

本轮无新图片/视频附件；不凭空附截图，不把历史素材作为新效果。已有私有原件继续在原目录保留，执行环境不可访问必要资料时先按授权安全传递，不拿摘要替代原证。

### 可复制执行交接（仅交接说明，不触发本轮实施）

```text
高清全链路可靠性修复
项目：video-api-debugger
正式路径：/Volumes/Data/Projects/video-api-debugger
计划：tasks/todo/2026-10-18-hd-chain-reliability.md
按H01–H10完整执行，不能只修目录。先复核真实运行源和数据身份，保正式根脏改；锁定存储/状态合同后，隔离后端与前端/发布门工作包，整批修改后统一候选内置检查与源码Review，再保护发布。
必须保原图字节、已有ready/保留交付结果、权限、原请求、账单、隐藏状态和查看现场。单图已知异常不全停，未知发布/存储/完整性仍保护；中断只接原任务，不生成或扣费。
复用原单第21节及本计划第7节的本机原证。默认不跑浏览器/收费生成/生产故障注入，不自动派审核线程；功能用户手验，部署只按既有必需检查。
数据/锁/回执冲突、旧writer未排尽、缺相容回退或发布门失败时停止受影响动作，不覆盖或清空现场。
回执逐项列H01–H10、源码与真实运行版本、内置检查、Git、公网/持久保护、回退及未验项；上线仅写已部署待用户手动验收，不能以目录恢复关闭整单。
```

## 8. 开源选择与规划复核

沿用本轮前序已实际读取且仍适用的实现：[BullMQ worker失败处理](https://github.com/taskforcesh/bullmq/blob/master/src/classes/worker.ts)、[child-pool隔离](https://github.com/taskforcesh/bullmq/blob/master/src/classes/child-pool.ts)（MIT）；[Capistrano共享目录](https://github.com/capistrano/capistrano/blob/master/lib/capistrano/tasks/deploy.rake)；[PhotoSwipe content](https://github.com/dimsemenov/PhotoSwipe/blob/master/src/js/slide/content.js)和[loader](https://github.com/dimsemenov/PhotoSwipe/blob/master/src/js/slide/loader.js)（MIT）；[Sharp输出接口](https://sharp.pixelplumbing.com/api-output/)及项目0.34.5源码（Apache-2.0）。本方案借成熟隔离/共享目录/渐进读取模式，不导入上述整套平台，不照搬外部删除操作。无新增依赖、收费、安装或线上开源替换验证。

规划按“用户看图→等待→取得结果→恢复”和复发四类风险完成静态复核：入口已沿原查看器/admin指定；所有共享媒体路由都在H07而非只改单页；H01/H10绑定实际运行源和共享根；H09必须接正常构建/发布路径；旧worktree/相容回退不能带回错误路径。保用户操作连续性、近时显示与等待状态，普通等待不红字/假进度，不新增不必要弹窗。

| 编号 | 本轮任务内容 | 完成标准 | 状态 |
|---|---|---|---|
| HD-PLAN | 整个高清链路修复规划 | 明确修改落点、执行顺序、数据保护、验证及回退，不遗漏已确认问题 | 已完成规划；H01–H10尚未实施 |

本轮只有计划和固定记录，未改应用、部署、移动数据、恢复控制、运行功能测试或新生成。项目手验规则优先于技能的通用独审/自动验收建议；未执行独审不冒称独审通过。实施后须按H01–H10真实状态回填，不能将本轮“规划完成”复制成“链路已修好”。

## 9. H01–H10 实施与统一验证（2026-10-19，进行中）

本节替代上文仅规划的当时状态，不删除历史。整批业务及夹具已完成，候选 main `9bc3916bf8250c2ebf8dcb9d2822078344bc481f`、guard `5d5f42155679be8e126c87f029d5fbf8e17c7c58`，计划交付 v0.99.2，已聚焦推送并核远端。已并入实际已部署 `53eb8b54` 的多视图更新；18:39Z生产仍是53eb/v0.99.1，Web/image与原HD PID/Invocation未变。

本机补充统一检查：显示23、提交后登记4、管理5通过；旧25/后端13及类型检查的180秒超时仍不算通过，保原件，不扩大时限。新私有真实临时FS/AVIF检查13组及实际保护断言72组通过。60个既存legacy-ready仅按原盘点固定key、完整manifest摘要和原件身份接受；现代记录、未知key、删integrity伪降级、身份/尺寸变化均拒绝，不补字段或重编码。[首轮原件](../../docs/materials/2026-10-18-hd-chain-reliability/implementation/verification-r01/)、[补充13/72组原件](../../docs/materials/2026-10-18-hd-chain-reliability/implementation/verification-r02/)保留；不是功能验收。

新run `f1409252-e55f-4fef-9859-631fe5dc59d4` 经正常共享窗口认领，精确双源包上传数据盘，root所有权/nlink/SHA核对通过；[manifest](../../docs/materials/2026-10-18-hd-chain-reliability/implementation/f1409252-e55f-4fef-9859-631fe5dc59d4/manifest.json)摘要 `3c345de5880b82ad79a0520c03862f31bb2ff8bcf03124507c45d3b2f235c185`。Linux20候选准备/完整构建继续，成功与否另记真实回执，不能沿用本机22结果。

**生产切换尚未执行**：只读核实旧Web没有覆盖全部外部写入handler的统一临近POST维护门/完整Promise计数。图片同步admission只能证明该路；H3预上传、分块建票据、邮件/登录等仍有无全局耐久排空证明的窗口。nginx连接0、systemd inactive或固定等待不能代替。用户随后明确确认“已确认无人操作、无上述在途请求，允许短暂维护”；这是人工确认，不冒技术全业务排空证明。R03私有发布接线将同时要求两入口维护、鲜核同步0、旧image/HD完整退出、短空写锁与精确旧Web cgroup的临时网络保护；只作用原Web，已证原生机制复用，不动父slice、其它服务或永久+i屏障。该组合门/Review与双完整候选未齐前不切换；30分钟门自然到期即失效，不延长或伪造时效。当前0生产维护/网络/服务动作。

f140 主prepare随后真实exit1，尚未npm/fullbuild或guard prepare：新增只读HD门发现11个历史版本不等于当前原件stat。原件[prepare失败](../../docs/materials/2026-10-18-hd-chain-reliability/implementation/f1409252-e55f-4fef-9859-631fe5dc59d4/prepare-main-failed.json)、[完整冲突列表](../../docs/materials/2026-10-18-hd-chain-reliability/implementation/f1409252-e55f-4fef-9859-631fe5dc59d4/hd-prepare-conflicts.json)和[字段重算盘点](../../docs/materials/2026-10-18-hd-chain-reliability/implementation/historical-version-inventory-20261019.json)均保留。11个原key用原version重算全部正确；4条早已skipped/source_changed，7条旧ready有v2完整验证且输出长度正确；不是本轮损坏，也不能作为当前原件对应ready。60条legacy AVIF真实头/尺寸已60/60通过，不与这11条混同。

主管同意仅在新私有release-r02做历史保留与当前可复用分层：11条按完整原manifest摘要、原version、当前源身份冻结，旧成果原样保护但不充当当前ready；新对象或身份再次变化仍拒绝。不改产品lookup/new-key公式、不补写历史、不重编码。f140已登记失败并释放实际构建路径，旧目录/批准/回执不覆盖；纯记录新提交及新guard产生新精确候选根，沿正常窗口冷却接续，应用版本同一交付不再次上抬。

第二run `8b32d07a-c143-48d5-bd27-690a062ad47d`（main800f/guardd1f4）主prepare在原`candidate-inputs`权限门真实exit1，仍未npm/fullbuild或guard prepare。原因是本轮外层日志命令误用umask077，原0444票据实际变0400；不是产品故障，也不放宽原0444校验。旧目录、manifest、完整日志及[失败回执](../../docs/materials/2026-10-18-hd-chain-reliability/implementation/8b32d07a-c143-48d5-bd27-690a062ad47d/prepare-main-failed.json)保留；后续沿原umask022与0700日志父目录，整批静态核对新增调用的环境、权限、单链接/root所有权和写读路径后再开新run。9bc/800f候选根已存在且不可覆盖，后继仅以必要固定记录提交产生新精确根，同一v0.99.2、不改业务或TTL。

R03接续：新main `3c60ab19832299bbaad11dd0be6b07863895c0cf` / guard `a3a6d9a176d1b2716c6393fd697f47ba37af4e9b`已原子推送/远端核同，仅必要固定记录与guard三文件差量，v0.99.2不重复升号。新run [`2e5caaad-e4b0-4ff8-8501-db9abb6ca00b`](../../docs/materials/2026-10-18-hd-chain-reliability/implementation/2e5caaad-e4b0-4ff8-8501-db9abb6ca00b/) 正常sole-owner认领，manifest `2348ceca09f250b0527b8fea58d324ac1fefd8f3ce140a19329a15ef1809aec4`；22私有源冻结，[同leadReview](../../docs/materials/2026-10-18-hd-chain-reliability/implementation/hd-release-safety-r03/integrated-review.json)0open，Linux20.20.2私有99/20/29/78检查全exit0，31个root输入实际元数据/SHA核对通过，无本轮原生或生产动作。main/guard prepare均真实exit0，canonical1250/fork121全动态核对、legacy60/60及历史11保留/排除7当前复用均通过；主完整npm build已实际开始，guard完整build及最终发布仍待真实证据，不能据prepare冒完成。

2e5主完整prebuild随后真实exit1，未进入Next或guard完整build；原7组及RATE检查通过，HD五子组32.468秒自然退出（全部signal=null、禁止调用/生产写/收费均0）：旧25为24通过、新13为12通过，各一断言失败；显示23/登记4/admin5通过。完整[`hd-chain-original/`](../../docs/materials/2026-10-18-hd-chain-reliability/implementation/2e5caaad-e4b0-4ff8-8501-db9abb6ca00b/hd-chain-original/)、[`default-gate-original/`](../../docs/materials/2026-10-18-hd-chain-reliability/implementation/2e5caaad-e4b0-4ff8-8501-db9abb6ca00b/default-gate-original/)及build-failed/log保留。首次未经原exit核实联想到Mac180超时的判断已立即纠正并记同主题lessons/全局误判；现按实际control/error/子进程退出证据集中归因，并收同源有界类型诊断，不抬deadline、不修改历史或放松硬保护。已真实登记构建失败，仍0生产维护/网络/服务变更。

集中根因已完成：同冻结Node20实际[构造器比较](../../docs/materials/2026-10-18-hd-chain-reliability/implementation/2e5caaad-e4b0-4ff8-8501-db9abb6ca00b/module-identity-diagnostic-r02.json)证实fixture两次加载的HdProcessorError并非同一对象，core因此按未知错误保护，默认生产同静态加载图未用该fixture注入入口；没有把所有异常路径冒成正常。原[类型日志](../../docs/materials/2026-10-18-hd-chain-reliability/implementation/2e5caaad-e4b0-4ff8-8501-db9abb6ca00b/main-types-diagnostic.log)61.191秒自然exit2，全4错收齐。仅5文件集中+6/-6修正并同lead读完整diff；新main `9e5655431d3e799eb36c55f7b1da93160117b67b` / guard `21a691942c85257012ef721ecb18d9bb85161572`已原子push/远端核同，v0.99.2不再升号，原断言/错误类/硬保护/TS配置/依赖不改。

新run [`ca4a9490-4c2e-4916-b031-6f5d3301f328`](../../docs/materials/2026-10-18-hd-chain-reliability/implementation/ca4a9490-4c2e-4916-b031-6f5d3301f328/) 正常冷却/sole-owner认领，manifest `e3098c125640930a6e84048a7b2da9d26ca08eb5c8cccf4e0c7328362224846d`，两prepare实际exit0。31root输入元数据及22私有源SHA再次核同，显式[复用原99/20/29/78证据](../../docs/materials/2026-10-18-hd-chain-reliability/implementation/ca4a9490-4c2e-4916-b031-6f5d3301f328/private-engineering-source-reuse.json)，不伪造新时段/新执行。主Linux20完整build于19:35:20.824Z开始、19:40:05.218Z自然exit1（signal=null）；默认8组及RATE门完成，随后Next14 webpack拒绝`hd-image-processor.ts`内运行期`createRequire(...).resolve('tsx')`的ESM依赖。不是HD断言或超时，尚未到完整类型/静态页阶段；guard未完整build。原[失败回执](../../docs/materials/2026-10-18-hd-chain-reliability/implementation/ca4a9490-4c2e-4916-b031-6f5d3301f328/main-build-failed.json)及[完整日志](../../docs/materials/2026-10-18-hd-chain-reliability/implementation/ca4a9490-4c2e-4916-b031-6f5d3301f328/main-build.log)保留，19:44:27.142Z真实登记失败。集中窄修仅child运行期解析与Next服务端打包边界，不改全局忽略/依赖/质量/退出保护；同版新精确源与新run重建。生产19:32:50Z鲜核仍六角色原PID/Invocation/53eb，构建进程现已退出，仍0维护/网络/服务动作。

最小修正已聚焦push：main `3826b550a45e9ce172d7e36be1d68e3d4018ef2b` / guard `ee6deaef627633666b7fc41552fed89c02b809e3`，仅child原生`--import tsx`与显式release cwd；同lead核IPC、脚本定位、绝对输入输出和故障退出均不变。Node20官方`--import`按cwd解析，与正式已保留tsx依赖/既有脚本一致；不增加全局忽略或改依赖分类。新run [`0ef4e9a5-7cfd-4e6d-b99d-24330aa8f8c4`](../../docs/materials/2026-10-18-hd-chain-reliability/implementation/0ef4e9a5-7cfd-4e6d-b99d-24330aa8f8c4/) 正常冷却后19:49:46.534Z sole-owner认领，manifest `931d6c719f6337f50988c311be6f75ec85a715c5ab20e5cc3c953db18187bc2a`；31root输入/22私有源再次核同并明确复用原工程证据。主prepare已exit0，guard prepare/双完整build接续；此处只记实际准备状态，不冒构建/发布完成。19:47:39Z六角色仍原PID/Invocation/53eb，公网0.99.1、无并行fullbuild；仍0维护/网络/服务动作。

483c主/guard真实完整构建均exit0，BUILD BJWW1Q1--lI8Ltr9kAS5T / 24oKmy2oygH8eDzLjfdFh；最终只读proof被旧HD空ExecStartPre的systemd输出格式拒绝，未维护。[两原build与拒绝原证](../../docs/materials/2026-10-18-hd-chain-reliability/implementation/483cdbf0-d937-465f-9ba5-022198fcfdad/)完整保留，不能改旧manifest/回执续接。R05仅固定HD缺此一字段时，要求原生D-Bus精确类型及空长度后规范为空；Web/image和其它字段仍严格。[10正反例/真实三unit只读证据](../../docs/materials/2026-10-18-hd-chain-reliability/implementation/hd-release-safety-r05/empty-hd-exec-observation-native.json)exit0，六角色原PID/Invocation/原保护、HD1250与分叉121全量无冲突。新main a0e4b199 / guard c0bcc16a已push，只有H固定记录及guard三文件变化，v0.99.2不抬；新run16d3121a-e7e1-46f6-836d-92c2e334b68e本机打包，按正常冷却/鲜核后重新两完整build。未引入supplement或跨run承接，仍0维护/封网/服务变更，生产53eb/v0.99.1。

16d实际后续：主完整build 20:39:26–20:46:09Z、BUILD `J91qQnr4QCqp61ZSg4ESK`；guard 20:50:13–20:57:09Z、BUILD `x_G1I0khf2wLNaIYwFfnQ`，均exit0/verified=true，默认8组、RATE与HD70及未跳过类型/lint/87页通过。[两完整原件与统一Review](../../docs/materials/2026-10-18-hd-chain-reliability/implementation/16d3121a-e7e1-46f6-836d-92c2e334b68e/)保留。首次capture缺既有required seed字段的拒绝与误串行prepare亦保留，实际修正输入后exit0才完成两build；不冒原首次准备成功。

21:01Z原批准下switch真实exit1，发生在`beforeMaintenance`首个既有`.env`读取，尚未安装维护、停服务或封网。私有适配器将既有uid1004/0600应用配置误作root专属发布输入；一次穷尽同类还发现uid501/0644 Nginx配置，以及维护后保原owner的config/swap两读取点。不是生产配置变坏，不改owner/mode。21:03:56原保护proof及21:09:20[完整分类原证](../../docs/materials/2026-10-18-hd-chain-reliability/implementation/16d3121a-e7e1-46f6-836d-92c2e334b68e/input-reader-classification.json)确认35 root输入、5原配置身份/字节、六原PID/Invocation/NRestarts0保持，维护marker不存在、operation目录空；0生产动作。原批准21:05:38及最早build21:09:26自然过期，旧回执不改/不续用。

[R06集中私有修正及同lead Review](../../docs/materials/2026-10-18-hd-chain-reliability/implementation/hd-release-safety-r06/)仅3源：导出现成稳定FD配置snapshot，三配置落点改按原/维护后精确身份、SHA及swap核对；其余19私有源、rootFile、系统proc/log reader、业务/质量/收费/TTL不变。正式`beforeMaintenance`仍先原checkpoint；共用纯只读主体另有不返回切换能力的工程入口。21:13:14Z Linux20[真实FS17、适配26、完整native只读主体](../../docs/materials/2026-10-18-hd-chain-reliability/implementation/16d3121a-e7e1-46f6-836d-92c2e334b68e/readonly-before-maintenance-r06/summary.json)全部exit0，实际配置→sync0→进程/cgroup→pricing屏障→nginx日志通过，非mock；所有临时文件仅隔离证据目录，0维护/stop/fence/DB/供应商写。工程明确不授发布权、不复用过期时段；下一轮只以固定记录新精确main/guard、新run及真实双完整build接续，不恢复TRACE业务或新增通用授权机制。

### 9.1 5c2d双构建成功、切换失败及原站恢复（21:44Z历史）

本轮main `9baf40d0c01adcd3896ce02ca4f944bd164f0638` / guard `9ee7b237f32243babd2d6ba25e2deb9532f1b654`已原子push，业务字节与前轮不变。run `5c2d103a-4bb2-4c5d-ae62-b7f08e4b0965`两真实Linux20完整构建均exit0/verified=true：主21:20:38–21:27:35Z、BUILD `35pKoRZ3rZyqG5f0NHEvg`，guard21:28:39–21:35:19Z、BUILD `lAS104DozwrE3tApK3177`。默认8/RATE/HD70及类型lint/87静态页完成，43份引用工程原件分别完整拉回；[统一验证/原Review](../../docs/materials/2026-10-18-hd-chain-reliability/implementation/5c2d103a-4bb2-4c5d-ae62-b7f08e4b0965/)保留，不能据此前Review0open否认随后发现的发布接线缺陷。H01–H09工程通过但未上线、功能未手验；H10未完成。

主管绑定批准下21:38Z真实switch exit1：[原日志](../../docs/materials/2026-10-18-hd-chain-reliability/implementation/5c2d103a-4bb2-4c5d-ae62-b7f08e4b0965/switch-command.log)及[失败回执](../../docs/materials/2026-10-18-hd-chain-reliability/implementation/5c2d103a-4bb2-4c5d-ae62-b7f08e4b0965/switch-failure-6f69962e-32b1-4832-8219-36aa3e629e20.json)不覆盖。两入口已503、原image/HD已自然停止，旧Web未停止；native `prepareWriterFenceProbe`发现自身模块实际在`fix01-release`，而硬要求`hd-release-safety-r03`，在任何probe/fence安装前拒绝。不是产品构建失败，也不是本轮0生产动作；无新pair/新writer/业务迁移，不能继续原窗。

恢复授权下先鲜核实际BPF空、网络属性/运行dropin无安装、operation仅authority/fence-view两个前置文件、Web原PID/Invocation、原pair/root+i及三cwd不变，原image/HD自然退出和原进程/cgroup空有证。只移除精确匹配本run快照的3个临时no-force文件，恢复原服务策略、启动原image53eb/HD649，未重启Web。首次恢复观察先于nginx reload生效而遇503，现成函数已保守重挂，原失败不删；按实际200条件等待后[最终恢复回执](../../docs/materials/2026-10-18-hd-chain-reliability/implementation/5c2d103a-4bb2-4c5d-ae62-b7f08e4b0965/original-service-restoration-complete.json)于21:44:00.349Z completed=true。两入口200/.99.1、旧编译JS逐字节相同，原nginx inode/字节恢复。Web仍2812713/原Invocation；image新PID3068203、HD新PID3068179，均原源健康，不能声称其原PID未变。原assertProtection核DB/账本/原图/旧任务/配置/其它三服务不变，永久+i屏障及旧pair不动，未重发任务或回业务数据。

恢复原件SHA `939d6b9235808139e186d68d9e60652c12c30f00242a3ca3dd37e5e04a91bece`、switch日志 `a7ca6a0098d1a0c4871d812551b4cec7891eb4720b9d8131af990020296645d0`及失败回执 `c5bd1b94a56a6e4d3e46cb4ea4e2906e56e5a8baff7c872bfcc392d3fb14a84e`与服务器原件一致，含前置/自然退出/临时策略/nginx重挂及恢复原件共18份已拉回。当前停止生产切换与新fullbuild；只读复盘helper的probe/install/restore/empty-lock真实目录及隔离native完整流程，先给最小包再决定，不单点修后重上。原H01–H10目标、暂停TRACE/GEN、质量/费用/媒体与用户手验边界不变。

### 9.2 native目录接线只读路径复查（未修改发布源码）

[完整字段级前置结果](../../docs/materials/2026-10-18-hd-chain-reliability/implementation/5c2d103a-4bb2-4c5d-ae62-b7f08e4b0965/native-stage-path-preflight.json)记录5真实源SHA、完整调用链、各同类落点、历次私有失败分类和两条路线比较。确定冲突：driver要求代码位于`fix01-release`，safety静态从该处导入native helper；helper却要求自己的模块文件位于`hd-release-safety-r03`。没有复制或重新导入，改变工作目录不能改变已加载模块的URL。prepare、lease acquire、持久receipt写/读及openProbe都经过同一stage检查，必须整条接线处理；empty-lock无SELF目录依赖，但JS与Python均有意硬绑定正式DB，不能为测试换任意DB。

推荐最小路线A：保持已核helper原字节/硬绑定，维护前将唯一所需代码按精确SHA、root/单链接/不可写合同独占放入正确operationStage，使用其真实文件URL重新加载并一致调用同一namespace/native IO；从真实`beforeMaintenance`前置阶段执行无service/fence/DB写的prepareProbe及目录/公开同字节探针准备，后续安装仍鲜核。只涉及私有loader/adapter/await调用和既有工程接线，不改产品、helper算法或增加通用权限。对照路线B虽只需改helper模块目录期望，但会改变已验证helper字节和原身份合同，本轮不优先采用，不能简单删断言或接受任意目录。

验证边界：新接线可在真实隔离data目录完成实际加载、prepareProbe、目录/权限/SHA/硬软链接反证、真实lease及receipt FS读写，不接触生产unit/DB；既有f9dd原生独立unit的双栈/旧连接/子进程/BPF/短锁回滚/控制器退出/精确恢复机制证据可按源复用。原样完整helper固定了正式unit/端口/DB，不能声称已在任意独立unit/临时DB完成整条native切换，也不为凑PASS重构目标权限；真实旧unit安装/短生产空锁/恢复仍须后续维护批准与鲜证。目前这项新native接线尚未实现或执行。

已实际阅读官方[Node20.20.2模块语义](https://nodejs.org/download/release/v20.20.2/docs/api/esm.html#importmetaurl)、[initialize_import_meta.js:49–64](https://raw.githubusercontent.com/nodejs/node/v20.20.2/lib/internal/modules/esm/initialize_import_meta.js)与[同版测试](https://raw.githubusercontent.com/nodejs/node/v20.20.2/test/es-module/test-esm-import-meta.mjs)，证实URL来自模块而非cwd；[systemd255实际BPF测试](https://raw.githubusercontent.com/systemd/systemd/v255/src/test/test-bpf-firewall.c)使用隔离runtime/cgroup并核内核与真实执行，不把属性文本冒执行有效。只借鉴边界和证据方法，未复制C代码、安装依赖或新增平台。此复查按三次失败后的路径复查执行，不清零原失败计数；正式源9baf工作树仍clean、未新提交应用或重建。

### 9.3 R07路线A实施、隔离统一验证与Review

主管随后明确授权路线A。仅4既有私有源变化：[R07冻结22源](../../docs/materials/2026-10-18-hd-chain-reliability/implementation/hd-release-safety-r07/frozen-private-source.json)，map SHA `fadea18e4601f20a9c61bce88b1f421f9f8c1e910ad7fa642dc284a92a5b8b56`。loader按原SHA将唯一helper独占复制为root/0600/单链接、验证整个canonical目录链后从operationStage真实URL加载；adapter的prepare/inspect/install/read/restore一致使用该namespace/native IO；release等待异步加载。真实prepareProbe已移入原checkpoint/只读核对后的beforeMaintenance，先于任何503/no-force/stop，安装前仍鲜核。原helper `d9482933…adda28`、empty-lock `b33fc87c…57807b`及其余18源逐字节不变，没有通用目录/目标/数据库覆写、依赖或权限扩大。

Linux20隔离工程原件在[operation-stage-engineering-eca93aa8](../../docs/materials/2026-10-18-hd-chain-reliability/implementation/operation-stage-engineering-eca93aa8/)：真实文件/prepare/lease/receipt21项、适配27项、配置FS17项、批准29项、网络/恢复/锁99项通过；[统一r02](../../docs/materials/2026-10-18-hd-chain-reliability/implementation/operation-stage-engineering-eca93aa8/operation-stage-unified-engineering-r02.json) SHA `1d74db68f0d9a06626dd9eddb3fe3495bedff1f912f57ba57b460a39962105c6`。首轮仅外层tar的`.`把隔离证据父目录带成0755，原0700保护正确拒绝；[原失败与精确更正](../../docs/materials/2026-10-18-hd-chain-reliability/implementation/operation-stage-engineering-eca93aa8/isolated-parent-mode-correction.json)保留。未改source/门，测试目录改回0700后只补FS17，其余四份实际通过SHA复用，不冒全部重跑或重写时段。

主管专项提示后另补唯一[同run双prepare真实原件](../../docs/materials/2026-10-18-hd-chain-reliability/implementation/operation-stage-engineering-eca93aa8/native-same-run-double-prepare.json)，SHA `ac4253a41d1d149ba0468af9f74967587f0cbe7e459f0e3be9379b7bb8f50307`：在原首次创建的同run上、同namespace/native IO连续两次prepare均exit0，公开同字节探针的原inode/SHA/owner/0444/nlink1不变，无O_EXCL碰撞或重写。原21项未冒其此前已测第二次prepare，四私有源/原helper未因补证变化。所有原生调用只涉及自有隔离文件及findmnt，不读生产DB或调用正式unit/网络栅栏；原固定unit/DB门不为实验泛化，不称完整生产链演练。

[同lead Review](../../docs/materials/2026-10-18-hd-chain-reliability/implementation/hd-release-safety-r07/integrated-review.json) SHA `03ea9a4aa0f2d819da63db5d84526a25fda9aaf1ac513bea7fee947014665670`，0open，明确旧失败/恢复、隔离布局更正与真实覆盖边界。正常switch原来已有nginx真实200的30秒条件等待，此次未改nginx；先前单次原站恢复回调过早503不能泛成新产品故障。

唯一后继run方案 `9b720778-c28a-47dd-8c00-9782387fde87`随后获主管继续授权。以下§9.4记录真实接续，不覆盖本节R07原件；原9baf/9ee7及所有旧包证据保留。H10未完成、功能仍用户手验，TRACE/GEN暂停不变。

### 9.4 9b720恢复后精确源与候选准备

新main `6512e723804b1e2d1274309498c3e5bb514ee3ae`仅改本固定工单记录，guard `4e0403a6304752335dcfee78f21d1d88e8f3d675`仅其三版本/收费写入开关文件，两分支均已正常push；业务字节及未交付v0.99.2不变。22:12:04Z同次只读[六角色及HD锁原证](../../docs/materials/2026-10-18-hd-chain-reliability/implementation/hd-release-safety-r08/restored-six-role-input.json)核全部PID/Invocation/ExecMainStart单调时间；原HD flock父3068179/子3068180、唯一内核锁owner和五入口dev64784/ino171450476一致。[R08](../../docs/materials/2026-10-18-hd-chain-reliability/implementation/hd-release-safety-r08/frozen-private-source.json)仅release的六角色观测断言更新，其余21源/原helper/权限合同不变，map `a06d32f1838817c86bfeef59ab3e5738e597b0f572b4a27f51f36209fbad00e3`；原R07隔离193项及同run双prepare证据按未变源码复用，不冒新全生产演练。

22:13:55Z通过正常recent/sole-owner/official confirm登记本run，explicit-entry tar不带`.`目录元信息；Linux20真实数据盘stage0700与29个root专属输入的owner/mode/nlink/SHA检查通过。新capture实际exit0，六启动身份全部严格匹配，manifest SHA `476a9fc9e1f892cde03ba710ea0dfc50eda650f29963b1bc648da282429484ce`；[本run原件](../../docs/materials/2026-10-18-hd-chain-reliability/implementation/9b720778-c28a-47dd-8c00-9782387fde87/)保留。两prepare及两完整Linux20 build均真实exit0/verified：main22:16:04.824–22:22:45.257Z、BUILD `laGD9U4RLJWwcK60Qxkxa`，guard22:24:13.497–22:30:44.861Z、BUILD `oAi35q9S2WJaIg3uq38Pc`。各8默认组/RATE与HD70、类型lint/87页齐，各43份工程原件已完整拉回；144默认/1424 RATE源码逐项同本run1556冻结清单。两构建期间按真实阶段续同run记录，结束后明确“构建退出、发布前核对进行中”，不假称仍占构建CPU或已释放整个发布路径。

22:31:44.396Z [最终只读核对](../../docs/materials/2026-10-18-hd-chain-reliability/implementation/9b720778-c28a-47dd-8c00-9782387fde87/fresh-release-ready.json)确认六启动PID/Invocation/ExecMainStart全等、原数据/配置/账务/原件保护不变，全账号同步schema有效且running0；动态HD1250canonical/121fork/121重叠safe，60旧ready严格核对、7旧版本ready只保留不冒当前可复用。[统一验证](../../docs/materials/2026-10-18-hd-chain-reliability/implementation/9b720778-c28a-47dd-8c00-9782387fde87/unified-verification.json)与[同lead Review](../../docs/materials/2026-10-18-hd-chain-reliability/implementation/9b720778-c28a-47dd-8c00-9782387fde87/integrated-review.json)0open；该时点尚未维护，正式切换及终态见下节，原记录不冒事后已部署。主构建硬截止22:46:04.824Z，未延时效。

### 9.5 H01–H10已保护部署、待用户手验（当前）

v0.99.2已于22:37:38.553Z完成本run保护部署：Web/image/HD同源`6512e723804b1e2d1274309498c3e5bb514ee3ae`、BUILD `laGD9U4RLJWwcK60Qxkxa`，PID3136361/3136078/3136003健康。[实际switch-complete](../../docs/materials/2026-10-18-hd-chain-reliability/implementation/9b720778-c28a-47dd-8c00-9782387fde87/switch-complete.json)在批准窗口22:40:27.149Z及主构建硬截止22:46:04.824Z前完成。两新完整Linux20 build/default8/RATE/HD70/类型lint/87页及Review0open有证（§9.4），没有修改TTL或重写旧失败。

用户已确认无人操作、无相关在途并允许短暂维护。原image/HD/Web全部自然结束，精确旧Web网络保护实际安装并按批准时点恢复、新pair/真实prestart均通过，两入口恢复原配置和200。22:41:02[最终保护/服务策略](../../docs/materials/2026-10-18-hd-chain-reliability/implementation/9b720778-c28a-47dd-8c00-9782387fde87/post-release-proof.json)确认原DB/账务/冻结任务/原件/隐藏/配置/未知上传/作品/+i保护不变、其它三服务原启动保持、fence=restored。最终Restart/Timeout分别Web always/90秒、image on-failure/11分钟、HD on-failure/3分钟，SendSIGKILL yes/yes/no，与原合同一致；临时run drop-in已撤，正式cwd/HD env/no-fork保持。中间runtime probe的Restart=no/infinity不是最终状态。

[新source实际resolver读取](../../docs/materials/2026-10-18-hd-chain-reliability/implementation/9b720778-c28a-47dd-8c00-9782387fde87/release-receipts/hd-runtime-probe-main.json)证明真实gouki1004 helper使用canonical `/data/video-api-debugger/var-lib/storage/hd-derivatives`（64784:171598992），原锁64784:171450476仅新HD持有/no-fork。原key`00293950…d5b1`同version/218150字节/inode直接读取，0 SQL/网络/写；原件根、两侧成果/control、1250/121动态集合及历史版本保留，不迁移、覆盖或重编码。

[39目标公网资源](../../docs/materials/2026-10-18-hd-chain-reliability/implementation/9b720778-c28a-47dd-8c00-9782387fde87/main-public-proof.json)与线上产物HTTP200/长度/SHA全同，覆盖HD查看器/后台真实chunk；四管理API匿名401。[升级layout](../../docs/materials/2026-10-18-hd-chain-reliability/implementation/9b720778-c28a-47dd-8c00-9782387fde87/release-notice-public-proof.json)另核HTTP200/SHA与原ReleaseNotice入口；本轮HD摘要在release.ts，匿名/非internal摘要空是原权限投影，internal才提供。真实旧客户端弹窗和页面功能未自动手验。[73发布/原生原件索引](../../docs/materials/2026-10-18-hd-chain-reliability/implementation/9b720778-c28a-47dd-8c00-9782387fde87/release-receipt-index.json)及两包各43工程原件已拉回逐SHA核同，私有不推公开。

相容guard `4e0403a6304752335dcfee78f21d1d88e8f3d675` / v0.99.2+points-pricing-guard.1 / BUILD `oAi35q9S2WJaIg3uq38Pc`保留本批reader/子进程/固定根；仅三服务成套回程序，不回DB/媒体/账务/回执，不直接退53eb或旧649，回退未演练、执行仍须鲜核现行安全门。守门员finish已完成、无blocking warning（启发式L3但按实际L4保护），旧分级/归因误判与更正沿原条目保留。H01–H10工程及部署闭环，待用户手动验收；0AI生成/收费/重发/数据迁移，TRACE/GEN暂停不变。
