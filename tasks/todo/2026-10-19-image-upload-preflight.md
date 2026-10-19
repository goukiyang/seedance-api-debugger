# 图片上传与生成问题前置工单

文档 v1.0.0；2026-10-19；项目 `video-api-debugger`，正式根 `/Volumes/Data/Projects/video-api-debugger`。本单仅调查、设计和归档，不授权实施或恢复暂停的发布。用户最新要求包括此前撤回的粘贴反馈及“现在好像上传图片都会出错”。

| 编号 | 任务 | 完成标准 | 状态 |
| --- | --- | --- | --- |
| PRE01 | 汇总前述问题（含粘贴报错）并完成前置调查 | 原反馈、根因证据、修改位置、方案和验收条件齐全，存入项目固定工单及索引 | 已完成，仅前置工单，未实施 |

## 1. 结论与范围

目前最急的问题是共享上传路径与真实服务器目录布局不相容，不是粘贴专属错误：程序要求临时上传目录本身是真目录，80d5 发布准备却将该目录接成软链接；当前2a程序沿用该布局，必然被同一安全检查拒绝。多个上传入口受同一故障影响，但未实际逐个上传，不能宣称所有入口均已实测失败。

另有独立界面问题：素材库刷新会清掉上传错误，失败行只留文件名和“重试失败文件”。截图的“2个素材暂不能用于此处”是已有素材用途提示，不是这次上传失败数量或原因。

此前的2K尺寸缩水、供应商错误详情未保存、压缩响应/查询退避兼容问题一并保留；相关TRACE实现已有未发布候选，不能再从头重做。三笔历史供应商内部具体失败原因仍未知；已确认的本站缺陷不冒充它们的真实原因。

本轮不改业务源码、生产数据/配置/服务，不执行真实上传、生成、收费、原请求重发、退款或部署；不重启已经暂停的TRACE发布，不恢复用户主动删除的三张图，不新增上传平台或全站重构。

## 2. 已完成的前置证据

### 2.1 当前版本与真实布局

2026-10-19 09:03:57 UTC（America/Los_Angeles 02:03:57）只读核对：Web/image运行源为 `2a1c641d0864850b5ca63f9d6201891341aa79bb`，v0.96.0；不是本机正式根旧分支，也不是候选f5d。相关11个线上源文件SHA见[鲜读原证](../../docs/materials/2026-10-19-image-upload-preflight/live-upload-evidence.json)。

- 当前运行根：`/data/video-api-debugger/managed-releases/2a1c641d0864850b5ca63f9d6201891341aa79bb`。
- `storage`真实指向 `/data/video-api-debugger/releases/80d5cf6f1ec489ea93257d42e8dd5c7e4e782560/storage`。
- 该根的 `verified-uploads` 是软链接，最终指向 `/data/video-api-debugger/var-lib/storage/verified-uploads`；最终目录为0700、uid/gid1004、gouki可写，数据盘dev64784与系统盘64770不同，剩余约1.83TB。不是磁盘满或最终目录无写权限。
- `verified-upload.ts:45–55` 对这个leaf直接lstat，拒绝软链接和路径重定向，抛 `UPLOAD_PRIVATE_DIRECTORY_INVALID`/503。上传正文已在 `upload/route.ts:219` 将原请求推进writing，之后223进入存储，在首次文件暂存之前触发该检查。
- 原 [img-vis-release.mjs:103](../../docs/materials/2026-10-17-image-content-incident/inc24/img-vis-release.mjs) 逐项创建storage leaf软链接；[80d5准备收据](../../docs/materials/2026-10-17-image-content-incident/inc24/deploy/prepared.json) 时间08:38:26.327Z、包含verified-uploads，与该链接ctime 2026-10-18 08:38:26.014Z相合。代码、执行收据及现状相互印证，不归咎于RATE新业务代码；没有逐条历史系统调用录像，不伪造此类证据。

当前原目录判定的只读复算为拒绝；原函数内存FS合成诊断另见本单附件，正常真目录对照可通过。它们是定位证据，不是修复通过或真实上传验收。

### 2.2 一笔真实失败与取证边界

限定同账号，读取UTC08:00–09:03:57（当地01:00–02:03:57）的上传日志、原请求状态、上传回执和新Asset；数据库只读事务，未读取图片内容或输出账号、nonce、凭据。

- 08:23:49.138Z，`image.png`，PNG，677918字节；ticket unavailable后走proxy是既有正常后备选择，不独立当错误根因。
- 请求摘要 `f04ce0af08935ef6`，内容摘要 `ed338fbe0e3e1d52`，08:23:49.312Z进入writing，此窗口未见上传回执或新Asset。当前目录确定拒绝与此状态吻合。
- 日志仅有ticket unavailable；`VerifiedUploadError` 在route273直接返回、未经过普通失败日志，因此“没错误日志”不代表一直上传中。
- 08:19:47的mount succeeded只证明已有素材挂载成功，不证明新图片上传成功。
- 浏览器只读页签清单中仅见本站登录页，没有原失败页及网络响应；未登录、刷新、重试或发新POST。没有取得截图那一次HTTP原响应，不能把文件名相同说成已精确绑定截图请求，也不能证实每个历史失败都只有这一个原因。现有线上布局＋真实源＋原函数诊断足以支持本单共享路径修复，无需为了重复定位进行生产上传。

### 2.3 界面因果与影响边界

行号按已核线上2a源码：

- `GenerationComposer.tsx:2454` 的“添加视频参考素材”使用共享 `ResourceLibraryPicker`、target=workspace。
- `ResourceLibraryPicker.tsx:327,331–333` 收集最后一条上传错误，同时刷新目录；目录effect216清空同一error，224覆盖notice；487失败行只保留文件名和重试按钮。刷新与上传共用错误状态，确定会丢失诊断信息，不需要把它冒充服务端故障原因。
- `api/assets/picker/route.ts:150,203` 的用途提示是目录素材可用性；当前workspace下无可用本地/公网结果的视频会被标记不可用。它与failedFiles独立，不删除或自动修复这些既有素材。
- 新文件的raw落地、直传完成校验、multipart完成及缩略图均经过 `privateUploadDirectory`/`stageVerifiedUpload`。文件选择、拖入、粘贴，及调用共享上传器的主图/参考/人物/多视图/素材入口共用底层。已有完成回执或纯目录选用不是“必然失败”；封面裁剪生成及头像等独立链不能只因名称里有“上传”就认定受影响，具体入口清单沿共享调用证据，不扩为全站改造。

共享入口已追到：视频参考 `src/components/GenerationComposer.tsx:2472`→`src/lib/hooks/useWorkspace.ts:211` 的上传回调；图片模板 `src/app/image-studio/studio.tsx:3436,3514,3901`、批量 `src/app/image-studio/use-studio-batch.tsx:248`；人物 `src/app/avatar-studio/studio.tsx:266,282`；多视图 `src/app/multiview/MultiviewGenerationPanel.tsx:551,908`；模板封面**源文件上传** `src/components/ModuleCoverEditor.tsx:277`；素材库 `src/app/assets/page.tsx:1838`；画布 `src/app/tools/ultimate-canvas/CanvasFrame.tsx:35–57`。画布本来禁止raw fallback，保留其差异，不为了统一入口改变供应商/调用约束。封面源文件上传在范围内，不等于全部裁剪保存链均有同一个根因。

### 2.4 此前生成问题的有效证据与真实状态

- [TRACE全链报告](../../docs/materials/2026-10-17-image-content-incident/inc24/code-trace/chain-report.md)、[源核对](../../docs/materials/2026-10-17-image-content-incident/inc24/code-trace/source-audit.json)、[9项TLS合成原证](../../docs/materials/2026-10-17-image-content-incident/inc24/code-trace/synthetic-receipt.json)及[比例复算](../../docs/materials/2026-10-17-image-content-incident/inc24/code-trace/ratio-specification.json)已复读；当前ratios/provider/resolution三个关键源SHA仍与原诊断相同，复用有效证据，不再跑五分钟TLS实验。
- 确定：2K预算4194304像素，1856×2464参考约分58:77，旧算法优先精确比例，解析成928×1232、1143296像素；未来规格算法与显示需要统一。不是这三笔uncertain的已证根因。
- 确定：provider未耐久保safe_error/error_stage，自定义HTTPS不解gzip，忽略Retry-After。原202/summary已正常解析，无证据这些缺陷造成三笔历史失败。
- 三笔已有原号、先running后generation/uncertain、assets=[]；本站未发现可恢复却藏着的完整图。供应商内部池/适配/参考转交细因无日志，旧七单Word回复不能套到三笔。继续原号有限核对、不新建、不伪造费用结论；本轮不联系供应商或追加付费测试。
- 两张用户指定非删除原图此前已同字节恢复；三张用户移除原图未恢复。完整返图必须可见的IMG-VIS政策保留，不重复执行修复或追扣旧退款。
- TRACE候选主 `f5d97bfe8f28cfa9a4ce303182e53b6e6c29e588`、相容guard `ae72969c6aebebcbed15ef71171112115a726f87`，各完整构建及既有门成功是历史工程证据，非已上线。v0.96.1只是候选版本。用户已暂停，不自行恢复。
- [b441发布拒绝原证](../../docs/materials/2026-10-17-image-content-incident/inc24/trace03-fix/b441449d-0f6d-47bf-b4d2-d50904216622/switch-launch-failed.json) 为批准文件hardlink/nlink2触发首项检查；[原站收口](../../docs/materials/2026-10-17-image-content-incident/inc24/trace03-fix/b441449d-0f6d-47bf-b4d2-d50904216622/stopped-attempt-restoration.json)证明未进入生产切换。这是发布工程错误，不是图片上传根因，不应转成又一套产品功能。

## 3. 已选最小方案与具体实施落点

优先UP01/UP02修复上传；GEN01/GEN02可以另批，复用已完成TRACE候选，不与上传故障绑定，不以“等费率”要求重做。RATE01目前确已发布，但当前请求仍只有前置工单。

| 工作包 | 修改点（项目根下真实路径） | 选定处理与不变项 |
| --- | --- | --- |
| UP01，P1 | `src/lib/assets/verified-upload.ts:privateUploadDirectory`；`src/app/api/assets/upload/route.ts` raw接收/落地边界；`scripts/upload-root-cure-smoke.ts`；发布候选准备的目录布局检查 | 保原共享storage及链接，不移动或交换目录。仅该固定leaf可解析到已核的固定canonical `/data/video-api-debugger/var-lib/storage/verified-uploads`；最终目录必须是真目录、0700、运行uid、受信父目录、真实数据盘且非系统盘，容量/访问条件继续校验；其他目标/链或最终软链接拒绝。普通本机真目录仍可用，不为兼容移除安全门，不放开任意软链接。无可直接复用的通用安全helper，限于此函数，不推广所有storage消费者。 |
| UP01的拒绝边界 | 同上raw route中receiving→writing之前 | 用同一helper先检查私有目录；stage/publish仍按原位置重核，不能用早期检查代替真正写时核验。仅本次尚未进入writing且目录检查确定拒绝的接收者，凭原nonce及CAS成功沿已有receiving→notAccepted返回安全拒绝；CAS失败仍未知。不能在普通catch把所有失败一律notAccepted。保留所有原bytes/hash/owner检查。 |
| UP02，P2 | `src/components/ResourceLibraryPicker.tsx`：上传循环、目录effect、失败行；`src/lib/http/file-upload.ts` 的已有错误/原号恢复；`src/lib/assets/upload-log.ts`、raw/direct-complete对应VerifiedUploadError返回分支 | 目录错误、逐文件上传失败、用途提示分开；每个失败文件保留原因及可用动作，目录刷新不抹除。目录故障说明“上传服务暂不可用”；未知写入显示“原上传结果待确认”，操作叫“核对原上传”；只有服务端证明notAccepted才可主动重试原文件。复用已有sessionStorage原号和WeakMap/File，不生成新key、不重复重传已成功文件。保留安全错误码与阶段/请求摘要到现有日志，不能落nonce、密钥或签名URL。 |
| UP03，历史请求保护 | `src/lib/assets/raw-upload-state.ts`、`file-upload.ts`、当前原请求；原则性不修改旧状态 | 既有writing/receiving/旧v1状态不凭超时、缺Asset或缺回执解锁，不批量改notAccepted，不自动重发。当前f04c这笔保留原号；本单并未承诺恢复该笔上传，修目录不等于旧请求解除未知。前台如实表达并保留只读核对，旧回执一旦存在仍沿原权威读取。无需新建恢复系统。 |
| GEN01，P2 | 既有候选的 `image-studio/ratios.ts`、`image-generation/resolution.ts`、`output-plan.ts`、`integrations/image-generation.ts`、`tasks.ts`、报价/批量创建/人物/画布消费者及原工单§17.6.5 | 复用原选定规格合同：新选择尺寸/报价/创建/执行同源，历史v1与RATE v2冻结语义保留，新合同按原设计区分。不可只单改尺寸函数，不能重算旧请求或把58:77偷偷替换3:4。完整输出可见与费用判断分开。具体已完成代码/消费者闭包沿原单，不重新设计一套。 |
| GEN02，P2 | 既有候选 `image-studio/provider.ts`、`provider-wait.ts`、`response-diagnostics.ts`、`response-evidence.ts`、`delivery.ts`、`worker.ts`、`async-recovery.ts` | 复用安全错误详情/阶段留存、正确解压和退避合同，以及先保202原身份后后续处理的现有候选。原号、冻结配置、限频/预算/CAS、费用与原件不改；补观测不冒历史原因已补齐，也不因暂态查询错误重发。 |
| ENG01，发布依赖 | 原TRACE发布控制中的批准文件创建与目录布局门；原RATE发布/guard成套约束 | 不再修原过期批准。未来获实施授权后只用新run、独占常规单链接文件和新鲜同源证据；保留原拒绝及失败收据，不延时效、不放松nlink/owner保护。不为这次问题新造发布平台。共享上传布局必须进入真实候选的内置准备检查，而不是只验证source文本或服务进程健康。 |

### 3.1 用户路径与恢复设计已确定

文件选择、拖入、粘贴仍从原入口直接加入上传列表，不新增确认弹窗或要求用户辨别目录/协议。每个文件显示真实上传/核对状态，成功文件可继续选择加入，部分失败不挡已成功项。失败原因和动作留在对应文件旁；“2个素材不可用”等用途提示留在目录区，不能替代上传结果。普通可恢复提示不用红字；真实失败不隐藏。未知状态不显示完成或假进度，核对不偷偷发送文件。

保留现有账号/目标/上传会话隔离及素材额度，切账号或迟到响应不把结果写入新目标；刷新只恢复既有安全原号元数据，浏览器没有保留File时提示重新选择同文件以核对，绝不自动重传。关闭不丢已确认素材，不新增重复dirty确认。上传成功不等于已加入当前视频参考；原“添加”动作及权限重验保留。

### 3.2 方案/开源核对

已核Node20 [lstat语义](https://nodejs.org/docs/latest-v20.x/api/fs.html#fspromiseslstatpath-options)及[realpath](https://nodejs.org/docs/latest-v20.x/api/fs.html#fspromisesrealpathpath-options)，与当前拒绝软链接吻合。选择固定受信canonical目录兼容，而非删安全判断或迁移全部共享storage；成本仅局部helper/边界和相应工程门。

已读成熟上传器Uppy当前 [Uppy.ts实际代码](https://github.com/transloadit/uppy/blob/main/packages/%40uppy/core/src/Uppy.ts) 的upload-error处理：错误、响应按file保留，而不是仅全局一条文本；[MIT许可证](https://github.com/transloadit/uppy/blob/main/LICENSE)。可借其逐文件状态方式，不安装或整体接入：其插件/传输生命周期不能直接代替本站owner/requestId/CAS/未知保护，换库成本大于本次局部修复。查到并读代码不代表已集成或验证本站可用。此前TLS/Undici、gzip、Retry-After比较沿原TRACE报告来源，不重复搜索或改供应商。

## 4. 实施顺序、验证和回退

1. 本单交付后仍不实施。用户另行授权时，鲜核正式运行源与root+i/RATE相容reader，保护脏改；使用安全匹配的现有工作区，不能拿正式根旧分支覆盖当前2a。UP01+UP02形成最小上传修复批次，GEN01/GEN02仍可保持暂停。
2. 先完成该批全部修改及内置工程用例，再统一候选构建/Review。现有 `upload-root-cure-smoke.ts` 很多只是字符串断言，必须补实际helper调用的隔离FS正反例：真0700、当前层级软链、恶意target、最终软链、权限/owner/跨盘/容量异常；不能只有代码含某字符串就说通过。同批覆盖preflight→notAccepted的原nonce/CAS、writing仍未知、已成功receipt复用及并发不重复登记；合成库/目录不接生产。把这些接入该次候选已有内置检查，不强加全站新门体系。
3. 界面工程断言：两文件一成功一失败时，目录刷新后逐文件原因仍在，成功的不再重传；目录用途提示和上传原因并存；未知按钮只查原key；账号/目标改变不串状态。保留原分页/12–24张小屏规则及现场恢复，不改当前布局。
4. 发布必需检查：新候选/相容guard真实目录布局与权限、完整构建与原生门、版本唯一来源/更新提醒既有合同、Web/image同源与启动允许清单、原数据/配置/账务/回执不变。不能用在线2a的健康检查冒新候选可上传，不能复用b441过期批准。不存在新源码行为的本次文档更新不抬应用版本、不重启网站。
5. 功能仍用户手动验收：同一小PNG文件选择/粘贴/拖入；视频参考和主图等共享入口；部分成功；关闭重开与换账号；只查旧未知；重复素材/真实加入/撤销。不自动真实上传、收费生成或浏览器回归；之后若用户明确追加相应测试才执行。
6. 回退只回相容程序和该轮自有运行映射，保留新回执及数据，不回DB/账本/媒体/配置；已知旧2a仍有上传目录缺陷，回到它不能叫问题已解决。不能回旧不相容writer，不能挪shared storage或删除80d5实体、root+i标记及原失败材料。发布期间出现源/权限/受信路径/CAS不一致即停，保原运行站。

GEN01/GEN02若获后续实施授权，应比较实际新源与f5d/ae729，只合入仍需内容，复用有效设计/测试代码；新产物重新形成必要构建证据，不复制旧成功回执冒本轮通过。既有历史供应商细因未知不是要求接手方“再调查后才决定怎么修”，而是不能事后补造的已知边界；本单可执行的是已确证本站修复及保护。

## 5. 前置完成核对及非实施边界

| 必要前置 | 证据/结论 | 分类 |
| --- | --- | --- |
| 反馈范围及被撤回问题归回 | 本轮明确重新纳入，原截图与新“上传都会错”保留原意 | 已完成 |
| 当前源/真实目录/真实失败链 | 线上11源SHA、目录元数据、只读原请求与原函数拒绝对照；无写入 | 已完成 |
| 共享影响及界面原因 | 共享helper/调用入口、picker effect与失败行、用途提示分离 | 已完成 |
| 历史生成及已完候选复用 | 原TRACE证据、当前关键源仍同字节、候选未部署及暂停原因核清 | 已完成 |
| 选型/安全/状态/用户路径 | §3固定canonical限白名单、原号安全、不丢逐文件错误；不迁移或扩架构 | 已完成 |
| 文件落点、依赖、工程/手验及回退 | §3–4 | 已完成 |
| 真实上传/生成/收费/新发布 | 当前只是前置阶段；不作为本轮完成证据 | 不适用，未执行 |
| 原截图HTTP原响应/供应商内部日志 | 已穷尽原页及现有只读路线；缺失明确记录，不影响已证共享路径和既有本站修复设计，不据此声称历史逐笔归因 | 已知证据限制，不伪造补齐 |
| 附件/固定todo/资料索引 | 本单§6已归正式根，正文12个本地链接均存在、两JSON可解析、原图复制SHA一致；私有资料不推公开，正文/固定入口聚焦文档提交 | 已完成 |

守门员等价纠正：这是“前置调查＋工单归档”，而非general闲聊或继续实施；本轮文档L0、生产只读证据按敏感信息最小化；未来UP01涉及共享文件/身份保护须按其实际风险单独执行。当前不调用部署/验收动作。Graphify没有已有可复用图，精确Git对象/rg足以定位，不新建全库图；Jev当前不可调用，未启用或外发文字。未因技能扩阶段。没有把目录问题升级成重建架构。

收口核对：原PNG可读且源/副本一致，原函数诊断源码及JSON已实际读回，源SHA与线上相同；已复读80d5发布脚本和prepare原件，未仅凭代理结论交付。既有TRACE原证按其原适用范围复用，缺HTTP原正文/供应商内部日志明确列为限制。业务修复、旧writing恢复、生成成功和新版本上线均未发生。本次没有新增分级误判；不抹去此前TRACE发布工程失败历史。

## 6. 已有附件与正式入口

以下资料均在正式根，不以临时剪贴板或侧聊路径作为唯一入口；私有材料不推公开Git。正文与复制交接都必须携带这些路径。

- 原截图 `codex-clipboard-fee305d0-4091-4d37-8c34-564eaa404338.png`：[项目内原件](../../docs/materials/2026-10-19-image-upload-preflight/codex-clipboard-fee305d0-4091-4d37-8c34-564eaa404338.png)。来源为本轮用户剪贴板附件；1286×491，可读，复制前后SHA256均 `2dc8ee7861b51caa0f2b6b6f234e875a18bb321f1dc683728bc155c90b03c91d`。用途：核对失败行/用途提示，不用作网络错误原证。
- [鲜读JSON](../../docs/materials/2026-10-19-image-upload-preflight/live-upload-evidence.json)、[只读采集脚本](../../docs/materials/2026-10-19-image-upload-preflight/read-only-upload-inspect.py)：当前源/目录/失败状态，脱敏，无媒体导出。
- 原函数诊断 `docs/materials/2026-10-19-image-upload-preflight/original-private-directory-diagnostic.mjs` 及同名JSON：只模拟FS元数据，证明原拒绝路径；不是修复或真实上传通过。
- 历史原图/Word及完整调查：`docs/materials/2026-10-17-image-content-incident/inc24/gen12-report-2026-10-18.md`、`supplier-reply/图片任务核查回复-20261018.docx`、`code-trace/chain-report.md`及其引用原图。原Word只适用于原七单，不重新复制或冒新三单回复。
- 暂停候选原件：`docs/materials/2026-10-17-image-content-incident/inc24/trace03-fix/b441449d-0f6d-47bf-b4d2-d50904216622/` 的main/guard-build.json、原log、unified-verification.json、integrated-review.json、switch-launch-failed.json、stopped-attempt-restoration.json；保历史时效，不当新批准。
- 既有正式总单：`tasks/todo/2026-10-10-fluxport-image-api.md` §17.6.5；费率保护：`tasks/todo/2026-10-18-points-pricing-settings.md` §15.3。固定索引 `tasks/todo.md`、`docs/materials/index.md`。

## 7. 实施交接正文（本轮不执行）

```text
修复共享图片上传与错误展示
项目：video-api-debugger
正式根：/Volumes/Data/Projects/video-api-debugger
前置工单：/Volumes/Data/Projects/video-api-debugger/tasks/todo/2026-10-19-image-upload-preflight.md
当前只交前置；仅在用户另行明确实施后执行，不自行恢复TRACE发布。
先做UP01/UP02：限白名单使用既有canonical私有上传目录，保所有安全门；私有目录确定失败在writing前沿原nonce/CAS安全拒绝；逐文件原因不被目录刷新清掉。旧writing和原号不改、不重发。
整批完成后统一内置工程检查与候选构建；功能由用户手验。真实上传/收费/浏览器测试另循实际授权。
GEN01/GEN02复用既有未发布f5d/ae729设计及实现，不重写，允许继续暂停，不与上传批次捆绑。
启动前仅复核证据后的真实源/布局变化；不得拿旧分支覆盖当前站，不迁移shared storage、不移除root+i/RATE屏障，不复用过期批准或回旧writer。若这些边界不成立即停止相关发布，保护原运行站。
附件：正式根docs/materials/2026-10-19-image-upload-preflight/内原PNG、live-upload-evidence.json、只读采集脚本、原函数诊断脚本/JSON；历史docs/materials/2026-10-17-image-content-incident/inc24/内GEN12报告、supplier-reply原Word、code-trace原证和b441暂停候选原件。不得只引用聊天临时图。
回执：实际修改/构建与部署分层，写已部署待用户手验或明确未部署；旧未知与三笔供应商内部原因仍未知，不冒已恢复/已查明。
```
