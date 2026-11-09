# ARCH-AUDIT01 共享基础设施结构排查（2026-11-08）

状态：排查完成；用户已授权本轮结构整改，A01–A10代码已实现并进入统一工程检查/同lead复核，A11由主控完成只读约束候选及发布接续。尚未部署，功能仍由用户手动验收；本轮没有清理生产数据。

## 1. 基线、范围与结论

审计基线为实际运行应用 `2239a1eaaa8e91bf53cb7e6f18a99a4c5a1cb1ed` / v0.138.3 / BUILD `rn8XdBxbJp9LDnH00cgyr`。工作分支 `codex/template-sharing-conflict-20261108` 的起点 `2c456f6a9808b5435bf78027a9762f85e3462088` 仅比它增加上一轮文档，相关应用代码相同。下文日期使用 America/Los_Angeles；私有证据 UTC 2026-11-09 01:40–01:55 对应本地11月8日。

覆盖数据库客户端及事务、模板目录/共享修订、素材权限、收藏、报价与费率、请求关联、后台报表/图片处理和实际服务拓扑。先用与工作树匹配的 CodeGraph 查询真实调用链，再核源码、运行元数据及必要隔离实验；没有进行全站浏览器回归、收费生成、飞书发送或生产压测。

**主SDK修复有效，但入口覆盖尚不完整。** 已部署的进程共享事务队列解决了原两份应用SDK互相饿死提交的问题；反馈仍有独立客户端绕过它。更深层是多个业务共用一个SQLite写入口，同时部分显示查询、报价准备、全局配置解析和权限扫描的范围仍偏大。不能把单个页面恢复当作所有上下游已闭环，也没有证据要求立即换库、拆微服务或加机器。

### 证据强度与优先级

“已复现”指隔离环境执行真实实现或故障注入，不等于该故障当前正在生产发生；“已核实现”指源码/查询计划证据明确，性能或规模收益仍需实测。P1先补共同入口和诊断，P2做局部结构整改，P3按真实规模安排。A编号用于本报告索引，已有发现沿原D编号更新，不另开重复单。

| 编号 | 优先级 | 位置/结构问题 | 已有证据 | 影响与下一步 |
| --- | --- | --- | --- | --- |
| A01 | P1 | 反馈数据库客户端绕过统一事务入口 | 实际依赖图隔离复现5–10秒及P1008；包装入口对照55–57ms | 可再次拖住同进程其他业务；接共同准入，保反馈隐私日志 |
| A02 | P1 | 初始化标记按进程，配置实际作用于连接 | 两应用客户端测得等待10000/5000ms、NORMAL/FULL不一致 | 客户端行为不一致；统一生命周期和每客户端初始化 |
| A03 | P2 | 显示读取和报价准备仍竞争写锁 | 只读事务使用BEGIN IMMEDIATE；报价复用提交准备事务；已有首读入场等待1.37秒 | 放大普通操作间排队；先关联持锁者，再缩短事务/用只读投影 |
| A04 | P2 | 全局修订失效范围粗，活动模板轮询仍解析依赖 | templates/assets两大域；前台在线约2秒轮询；单页60秒28次 | 人多时重复工作放大，当前多人容量未测；细分依赖和失效范围 |
| A05 | P2 | 部分前缀查询没有利用现有key索引 | 实际Prisma LIKE查询EXPLAIN为SCAN；等价候选范围查询为SEARCH | 配置增长时权限/读取/清理成本增加；核语义后定向改查询 |
| A06 | P2 | 单批封面权限仍受全局数据上限和坏行影响 | 非管理员封面路径全局私密引用LIMIT257，超过256拒绝；当前22 | 不相关引用增长可使正常封面不可用；按目标资产/别名限定权限查询 |
| A07 | P3 | 收藏/喜欢先全量解析，再分页 | listReactions完整循环后截页；当前全站63条、单人最多52条 | 每页成本随个人总收藏增加；批量授权投影与分页一起改 |
| A08 | P2 | 固定报价预览的过期清理路径不完整 | 固定分支早返，清理在实际计费分支；601条固定预览已过期 | 无生成的反复报价也累积记录；补统一、有界的过期生命周期 |
| A09 | P2 | 费率目录跨业务耦合故障 | 隔离注入坏H3配置，整个收费目录读取失败 | 一个领域坏配置可阻其他报价；隔离业务能力，保真实收费拒绝 |
| A10 | P1 | 成功慢请求和事务缺少完整关联 | quote路由未接现有请求追踪；1.36秒事务无父请求，同段报价2.45秒 | 无法准确归责或证明优化收益；复用现有追踪补成功慢路径 |
| A11 | P2待核 | 老版预览服务也打开生产同一数据库 | 服务实际同文件device/inode，源码版本不同；只读策略未证 | 需要确认完整读写拓扑；不先判定它越权写入或停服务 |

## 2. 已完成主链修复与本轮新增项的边界

v0.138.3 的真实依赖图原生事务隔离样本由约5020ms/P1008降为59.95ms双成功；生产后约8分钟84次事务成功、提交最慢5.8ms。原revision首60秒21次最慢10.15秒，改后28次最慢426.7ms。新旧窗口样本数不同，不能拿它们推导固定人数上限或百分比容量提升。

原首轮3次模块读取仍保留323/355.6/1735.7ms，追加3次暖读约97–102ms；首轮1735.7ms中入场等待1374.8ms。同段另有无父请求事务正文1363.7ms和报价HTTP2447.8ms，**不能仅凭重叠断定该事务就是报价**。上一轮原证和失败接续均保存在[模块读取原单](2026-11-08-studio-module-read-latency.md)，本轮不重测它们。

## 3. 逐项判断、落点与保护边界

### A01 反馈独立客户端是统一入口的真实旁路

[feedback/notification.ts:9–12](../../src/lib/feedback/notification.ts) 直接创建PrismaClient，未走 [catalog-directory-writes.ts:67](../../src/lib/catalog-directory-writes.ts) 的原生事务包装。消费者包括网站/Bridge反馈提交、管理员反馈处理、飞书反馈回调及通知状态处理，不仅一个页面。反馈单独禁日志是为避免用户粘贴凭据被数据库错误打印，不能简单换成会输出正文的客户端。

隔离实验加载实际worker依赖，捕获两份应用SDK及真实反馈SDK，仅在新合成库执行SELECT 1事务。单引擎线程下包装入口对照55.423ms双成功，混入反馈入口5012.287ms有1个P1008；第二组设4引擎线程、同时进入8个反馈事务，包装对照57.018ms双成功，旁路组10019.9996ms、9个事务中7个P1008。使用50ms释放屏障和显式15秒maxWait/timeout，未启动消费者、提交反馈或访问生产业务库。

判断：共同准入应独立于“目录失效”业务，覆盖实际写入客户端及原生入口；反馈隐私配置、事务回滚、超时不迟到执行和原号保护必须保留。进程内队列不代替跨进程数据库锁和迁移隔离。第二组的包装对照仍为2个事务，不用于计算吞吐提升比例。实验不是生产并发人数上限，也没有证明当前每次反馈都会超时。

### A02 客户端生命周期与初始化范围不匹配

[prisma.ts:14–36](../../src/lib/prisma.ts) 在production不保存全局client实例，却用进程级 `prismaSqlitePragmasStarted` 只初始化第一份client。真实依赖图确实产生两份应用client，合成库测得第一份busy_timeout=10000、synchronous=1，第二份5000/2；反馈也是5000/2。

判断：统一客户端生命周期，并保证每个实际连接按已选择的持久性/等待策略完成初始化，不能由第一份实例的标记替其他实例作保证。此处已证配置漂移，未证数据损坏；不为统一参数任意弱化持久性。和A01一起修比继续单点加timeout更有效。

### A03 读取、报价与受理共用写事务入口

[read-snapshot.ts:38](../../src/lib/image-studio/read-snapshot.ts) 用Prisma事务保证共享一致性，SQLite实际从BEGIN IMMEDIATE进入写锁竞争。[billing-quote-service.ts:152](../../src/lib/image-studio/billing-quote-service.ts) 为报价调用 `submitStudioBatch`，以注入save方式捕获准备结果；[tasks.ts](../../src/lib/image-studio/tasks.ts) 在事务内完成大量权限、模板、素材、价格及快照准备，之后还可能确认模板和存预览。报价本来就有预览写入，不能冒称整个接口是纯读。

判断：先做A10明确等待者和持锁者，再将可显示内容迁到稳定只读投影，把最终受理/费用冻结/CAS保在短事务内。沿用同一授权与价格实现，避免复制一套“快速报价”规则。不能用去掉事务、旧缓存或宽松隔离来绕过撤权、共享版本和费用核对。现有首读等待证明仍有排队，但报价具体占锁时间尚缺父请求证据。

### A04 目录修订与活动共享依赖放大

[catalog-revision.ts:5](../../src/lib/image-studio/catalog-revision.ts) 只有templates/assets全局域；[catalog-directory-writes.ts](../../src/lib/catalog-directory-writes.ts) 的多类写入会使同一域失效。[use-shared-studio.ts](../../src/app/image-studio/use-shared-studio.ts) 约2秒检查活动共享状态，已正确跳过隐藏/离线页面；[shared-contract.ts:1573](../../src/lib/image-studio/shared-contract.ts) 即使轻量目录分支，仍需计算活动定义和相关可用性。已有分页目录/轻量协议，不能说“每两秒全量下载整个目录”。

判断：按对象/依赖限定失效，复用现有目录标记与只读投影；保模板、固定参考、风格/提示词及撤权传播。当前单页改后窗口28次/分钟，多用户总成本未测，不能仅把轮询间隔调大后宣称架构问题解决。

### A05 有索引不代表当前查询用上索引

实际Prisma5.22 `startsWith` 生成 `key LIKE ? LIMIT ? OFFSET ?`；对 `studio_fixed_references_v1:%`，与生产同BINARY索引定义的合成库EXPLAIN为 `SCAN main.PlatformSetting`。生产只读EXPLAIN代表查询也是SCAN，候选上下界范围为 `SEARCH ... PlatformSetting_key_idx`。现有key唯一索引和普通索引都在，不能再加同列索引冒修复。

原生产只读摘要：PlatformSetting 4604行，value_json约11.55MB。涉及权限回退读取、历史/共享配置和报价清理等前缀路径，不把所有startsWith或整个应用一概判慢。实施前核大小写、前缀边界、旧ID及命名空间语义，再比较范围/GLOB或定向ID读取；EXPLAIN变化不是端到端秒开收益证明。

### A06 权限查询的故障和预算边界仍是全局

[protected-assets.ts:81](../../src/lib/image-studio/protected-assets.ts) 的现代assetId路径已有定向查询；无assetId兼容路径仍会读取全局私密绑定。[readableStudioCoverIds:124](../../src/lib/image-studio/protected-assets.ts) 对非管理员先查全局坏记录，再读取全局私密引用（LIMIT257），超过256在目标匹配前拒绝；历史绑定也有独立257/256预算。调用含[首页收藏封面](../../src/lib/content-reactions/home-templates.ts)和[主图预览](../../src/lib/image-studio/input-main.ts)，不是所有图片请求都走这条路径。

本次相关现存引用22、格式异常未见；未触发256阈值，不能声称已有封面因此全部坏掉。但全局无关数据增长足以令正常用户的目标封面失败。沿原D-20261107-PIN-MEDIA-SCOPE继续收窄：现代置顶任务/资产已定向查询，不重复把旧全任务扫描当现状；残留是全局权限回退与封面保护范围。

判断：将权限匹配限制到本次目标资产及文件别名，按目标预算，并保留旧绑定/撤权/私密保护的fail-closed规则。坏数据不能静默当公开，也不能靠提高256上限掩盖全局故障范围。

### A07 收藏分页的工作量取决于全部个人标记

[content-reactions/service.ts:107–161](../../src/lib/content-reactions/service.ts) 读取本账号所有喜欢/收藏，逐条解析当前授权内容、搜索和计数，最后截取页。现存全站标记63条、单人最多52条；当前延迟和增长曲线未测，不冒现在线上性能故障。

沿已有D-20261104-TEMPLATE-MARK-LIST-SCALE更新：批量构建当前授权投影，再让排序、过滤、统计和分页使用同一口径；不能先取一页再丢无权内容，导致漏项/统计错误。它不是“越后面的页必然越慢”，而是每一页都依赖总收藏量。

### A08 过期报价预览缺少统一生命周期

[billing-quote-service.ts:204–218](../../src/lib/image-studio/billing-quote-service.ts) 固定报价每次新建UUID预览并早返；按owner清理旧预览只在实际计费分支317–318行执行。全源码精确查该key前缀未见另一统一清理路径。本次只读607条预览（约1.19MB），601固定/6实际全部过期，无缺失expiresAt。

[billing-quote-store.ts:40](../../src/lib/image-studio/billing-quote-store.ts) 成功受理会CAS消费删除，故不能说“所有已消费票据永久积累”。缺口主要是过期且未使用的预览、尤其只使用固定报价的账号。判断：补共用、有界、按有效期和真实合同关系判断的清理；已受理/未知原请求、任务冻结合同和账本不参与泛化删除。本轮没有删除任何生产预览。

### A09 一个业务配置坏掉会阻断收费目录其他领域

[image.ts](../../src/lib/pricing/image.ts) 的图片报价沿policy readState进入 [getPricingCatalog:187](../../src/lib/pricing/catalog.ts)，该入口同时校验image/IP/enhance/H3共10个配置key。用假的配置reader仅返回一个坏H3 JSON，真实getPricingCatalog拒绝整个收费目录；未调用供应商，也没有改生产配置。

判断：按业务能力隔离来源校验/目录读取，让H3故障只阻相关能力；真正共用的费率策略损坏仍须安全拒绝。不能吞错误、价格置0、自动选更贵供应商或放宽权限。当前生产H3损坏未被证明，实验体现的是耦合故障范围。

### A10 仍缺准确定位持锁者的请求关联

[quote/route.ts:9](../../src/app/api/image-studio/quote/route.ts) 未接现有 `traceHttpRequest`，总耗时主要在错误日志可见；报价阶段WeakMap也主要用于失败。原证中的成功2.45秒报价和无父请求1.36秒事务无法一一归属。反馈原生旁路也不在现有统一事务观测范围。

沿原D-20261108-STUDIO-COLD-QUOTE-TRACE：复用已有追踪，为成功慢路径补requestId、operation、阶段/事务等待与正文时间，不记提示词/配置正文、凭据或私有素材。模块和管理报表已有追踪，不建另一监控平台。先修这个缺口，后续每项性能修复才有可归责的同口径证据。

### A11 预览服务与生产数据库的读写拓扑未闭合

运行元数据证实 `sd2-mj-dna-preview.service` active，打开与正式服务同一device/inode数据库文件；预览源码是 `72f4c5a356ce741c88114d98871a34a782b5fa9f`，与本次7个正式常驻角色2239不同。只读约束和是否实际写入尚未核实，不能把“打开同文件”说成越权写入、数据已污染或当前故障根因。

判断：先确认预览用途、负责人及可验证的只读/写入合同；如能写，须纳入完整writer拓扑和迁移隔离范围。此次部署没有DDL，本轮也未停止、重配预览服务或迁移数据库。主应用SDK队列不能替代对其他进程的识别。

## 4. 还需要证据的三组问题

| 组别 | 已有事实 | 缺口与后续方法 |
| --- | --- | --- |
| B01 管理报表纯计算/IPC | [usage-analytics.ts:431](../../src/lib/admin/usage-analytics.ts) 已有独立只读快照，capture后再fold，并有spool/取消；旧11月1日证据1403查询、约7.45MB IPC、fold 0.82–1.52秒 | 旧数不当新测量。需固定当前真实时间窗/规模并看是否与普通请求重叠，不能再声称整份报表仍在长写事务内 |
| B02 同机资源和供应商容量 | 服务器4逻辑核；HD/Works/role上限分别2/1/0.5核，Web/image/prompts无CPU硬上限；已有任务额度、claim、媒体slot | quota不是预留或实际利用率。当前未证OOM/CPU故障；按正常同时使用的时间窗测CPU/内存/数据库等待与供应商真实账户额度，不拿个人8并发当全站承载人数 |
| B03 高清/原件交付 | 前序高清生成、缓存及查看器证据继续有效；完整高清上屏与整张原件传输是两项指标 | 273ms应用发送/12.3秒公网原件是历史样本，不冒本轮复测。当前多人出口吞吐及完整一秒覆盖仍缺证，数据库修复不等于原件秒开 |

没有将以下内容误列为新缺陷：高清已有持久claim/flock与子进程隔离；作品媒体已有并发slot；报价实际受理已有冻结合同及CAS消费；现代单asset权限已有目标查询；隐藏/离线共享页已停止轮询。数据盘约24%已用、约2.8TB可用，本次没有空间耗尽证据。旧失败transient unit记录不等于当前常驻服务故障。

## 5. 推荐整改顺序与每批停止条件

1. **共同入口补齐：A01/A02/A10。** 抽出或复用最小数据库准入，接反馈但保其不打印私有正文；初始化覆盖实际client；请求关联覆盖成功慢路径。验证复用当前真实依赖图对照，补受影响入口即可，不重跑所有业务或收费生成。失败、超时、原号、回滚和后台状态不变，回退仅回程序，不回数据。
2. **缩短共享竞争和查询范围：A03/A05/A06，配A04。** 先凭新追踪定位持锁方；优先定向查询、短事务和已有只读投影，验证权限/撤权、别名和共享定义相容。若变化会影响历史读取或受理合同，先保旧reader和冻结数据，不批量迁移，不先上长TTL缓存。A11先补拓扑事实，与业务性能修改分别安排。
3. **切断增长和故障放大：A07/A08/A09。** 收藏批量投影及授权分页；统一预览有效期清理；来源故障按业务能力隔离。清理先证明对象是可丢弃预览而非原回执/账单，来源未知仍拒绝真实收费。B01–B03按各自缺证再定改动，不预先购买带宽、扩容或换库。

未来是否拆库/独立服务，应由已测事务吞吐、持续写入等待、CPU/内存和媒体出口决定。当前最小有效路线是让已有共同机制完整覆盖、减少不必要竞争和全局扫描；没有证据支持全站重写。上述为建议顺序，尚未冒称实施完成。

## 6. 原始证据与复跑边界

服务器私有证据目录：`/data/video-api-debugger-engineering/architecture-audit-20261108`（仅聚合元数据/合成数据，无生产库副本、用户正文或凭据）。

| 文件 | 用途 |
| --- | --- |
| probe.json / probe.log | 1引擎线程包装对照、反馈旁路、PRAGMA差异和H3故障隔离实验 |
| probe-4workers.json / probe-4workers.log | 4引擎线程、8反馈事务样本，完整成功/失败数量保留 |
| probe-source-proof.json | 7个相关真实源文件SHA；与2239运行源匹配 |
| prefix-sql-proof.json | 实际Prisma5.22生成SQL、绑定参数及EXPLAIN；非手写LIKE冒充ORM证据 |
| runtime-extra.json | 只读报价过期聚合、22引用、收藏最大52、预览同库元数据 |
| production-aggregate-receipt.json | 本轮01:40:05Z只读stdout的聚合摘要摘录，明确不是重新测量或原始数据库导出 |
| sqlite-architecture-probe.mjs / sqlite-architecture-probe-single-engine.mjs | 隔离探针源码；无生产业务写入/生成/通知调用 |
| probe-reproduction.json | 新合成库复跑参数、对照组数量差异及安全边界 |

隔离源副本在 `/data/video-api-debugger-engineering/studio-read-lock-20261108/source`。探针用实际依赖图初始化，须显式指向**新建的合成SQLite库**，使用 `NODE_ENV=production`、现有server-runtime/tsx及TOKIO_WORKER_THREADS=1或4；输出只能到上述私有审计目录。4线程样本额外参数8。不可把DATABASE_URL换成生产库、启动消费者或为对照发送真实反馈。归档的复跑参数、日志和JSON是复跑依据；相同等待时间不承诺每台机器一致。

本轮生产取证仅SQLite mode=ro + query_only，未更改业务表、设置、余额、历史、文件、服务和供应商配置。仅本清单、固定待办/发现索引和私有证据归档有写入；功能仍按项目安排由用户手验。


## 7. 整批整改实施与工程证据（2026-11-08）

用户在审计后授权将已确认的结构整改一并落地，内部按不冲突范围修改，最终统一候选发布。实际工作树为 `video-api-debugger-worktrees/template-sharing-conflict-20261108`；保留原审计基线及失败原证。本节记录实现和工程检查，不代表功能验收或生产性能达标。

| 范围 | 实际实现 | 保护与边界 |
| --- | --- | --- |
| A01/A02 | `sqlite-client.ts` 把进程共享SQLite准入从目录失效中抽出；主应用和反馈生产单例、每实际client独立初始化，反馈原生事务及隐式写接同一准入 | 反馈仍 `log: [] / errorFormat: minimal`，显式保FULL；主应用保持既定NORMAL，均busy_timeout=10000/WAL。不放宽回滚、等待超时或迟到执行规则 |
| A03 | 显示主快照及明确内部 `quoteOnly` 准备沿现有Python同文件 `mode=ro/query_only/BEGIN DEFERRED`；共享原权限/输入/价格实现。旧通道捕获所需不可变加密版本只在该client的专用异步上下文暂存，读快照结束后短事务保存，再沿原鲜核和预览落库 | 只读adapter继续拒绝全部写，不变成通用写缓冲。真实受理及批次真实save保原鲜核/报价CAS/冻结收费事务。首次显示稳定5位context码仍有既有独立短初始化写，暖读无writer；报价首次不分配码，正常受理才绑定 |
| A04 | 活动共享修订复用已判权投影前鲜核actor、私有策略和真实读取依赖marker；未知依赖不缓存。writer按相关模型/字段/命名空间原子更新对象依赖，保旧templates/assets marker | 无TTL、未改2秒周期或隐藏/离线门。固定参考、风格/提示词、来源/账号撤权立即失效。纯workspace/preset settings元数据不再扰动全局protection marker，仍保exact marker；无法定向的legacy保护仍可触发保守失效 |
| A05/A06 | 已证server生成的固定ASCII命名空间用BINARY上下界，后缀ID原样保留；封面绑定/文件别名匹配和256预算按目标计算 | 未加表/索引/DDL。现代asset/pin既有定向路径不倒退；完全无法归属的坏legacy仍fail-closed，异常旧URL保原解析回退，不把坏绑定当公开 |
| A07 | 请求内按目标批量读取实体/owner/授权，授权投影后统一搜索、排序、统计和分页；最终页再enrich封面/来源；点赞groupBy及私人组织复用原标记行 | 当前授权搜索及精确统计仍需O(N)候选投影，已减少逐项数据库往返；没有先分页漏授权项，也未为消除此成本新增通用投影表/合同 |
| A08 | 固定/实际报价共用按owner、expiresAt和有界候选的预览清理，验证预览合同及原值CAS后删除 | 只在后续报价时整理该账号可丢弃预览，未执行生产清理；原提交回执、未知请求、任务冻结合同、账本及不可变通道版本均不纳入 |
| A09 | 收费消费者按image/seedance/IP/enhance/H3 capability读取来源，管理及跨业务聚合目录仍严格全量 | 坏H3不再阻图片收费来源；真正共用policy/authoring损坏及原收费权限门继续拒绝，不补0、不换通道 |
| A10 | quote成功/失败及准备/确认/供应商账单读取/落库接既有RequestTrace；网站、Bridge、后台处理/归档及飞书ack关联HTTP父请求和事务耗时 | 固定operation/phase，不记正文、配置值、凭据、私有素材或动态ID；后台独立worker没有HTTP父请求时不伪造 |
| A11 | 主控已准备 `ops/sd2-preview-database-readonly.conf`，仅将预览service的数据库目录挂载为只读 | 旧Prisma URL的mode=ro不作为只读证明；合成systemd只读mount实际SELECT成功、INSERT拒绝，另一个合法writer提交后预览鲜读到新值。正式安装/唯一预览重启及健康验证由统一发布接续 |

`pricingRuntimeSourceFiles` 已纳入新公共准入、只读TS/Python、prefix helper及schema，原能力协议和收费配置不改。新reader按原freshness门等待同源新worker；最终候选沿原 `preparePricingInputs` / startup guard再生证明，不手改价格、账本或已冻结合同。

### 7.1 已取得的隔离工程证据

- `scripts/catalog-object-permissions-fixture.ts`：最终15项通过，真实definition/shared modules/catalog/非lightweight revision/module暖显示/gallery穿同文件只读快照，组内无writer；首次显示码初始化单列验证。300条无关绑定/坏owner不影响目标，257只拒overflow目标；风格/素材/提示词撤权传播、旧URL别名和大小写后缀相容有证。真实Prisma范围SQL的EXPLAIN为 `SEARCH ... PlatformSetting_key_idx (key>? AND key<?)`。原证 `/tmp/catalog-object-permissions-fixture-final.json` 及同名log。
- A07–A09真实模块/新合成SQLite：65私人标记在授权搜索后得到59项，跨cursor无漏/重，撤权/归档/私有文本和历史null/alias/group保持；每请求批量读取与公开likes隔离有证。固定/实际预览过期、owner、有界/CAS及非预览保留；坏H3能力隔离和共享policy坏拒绝有证。脚本 `/tmp/bounded-projections-fixture.cjs`，最终 `/tmp/bounded-projections-fixture-r3.log`。两次fixture前置/期望错误已纠正，原日志保留。
- 只读delegate工程12项真实Prisma对照通过：scalar/日期/布尔/关系/select/include/count/groupBy/raw及同快照并发撤权，真实raw RETURNING及delegate写均拒绝。原receipt `.role-tests/sqlite-read-delegates-XsRKHF/receipt.json`；最新源已接原prebuild门，最终Linux候选需再核。
- 真实quote首用→正常受理→历史恢复probe通过：首用quote不分配context码、不建任务、不动点数；受理沿原mapping成对写入，specification相同；已有历史code保持，原task/freeze各一次，无供应商请求。原证 `/tmp/architecture-quote-consumers-20261108.json`、`-r3.log`。此合成单任务受理总耗时13.3ms，精确事务body未由query event同步捕获，不能将它写为精确持锁时间。原pricing G11追加同组合及callback/body计时，待最终Linux候选工程。
- `node scripts/test-req01-reuse-diagnostics.cjs` 通过（`/tmp/arch-audit-req01-20261108.log`）；最终新增依赖/标签的RequestTrace 8组同源复验已退出0，原证 `/tmp/arch-audit-request-trace-20261108-final-r3.json`。
- `npx tsc --noEmit --incremental false` 第二轮退出0，修正了真实strict类型问题；随后必要通道版本暂存/后台trace差量的最终本地类型检查因外盘I/O仍未收口，未冒称通过，最新差量交统一Linux候选Next内置类型门。各责任范围ESLint和diff检查已通过，最终统一diff检查另留证。

SQLite队列工程曾完整通过；补production单例断言后的本机复跑在原1500ms阈值得到1519ms，两事务均成功且无P1008，已停止同类盲重跑，未放宽阈值。反馈FULL及最终namespace依赖修正后，以统一Linux候选原生门为最终证据；不能拿旧receipt冒最新源码全过。

### 7.2 发布与仍待观察项

本节实现未提交/推送/部署；统一构建、同源服务/guard、备份/回退保护及A11正式只读mount由主控接续。上线后仍写“已部署，待用户手动验收”。没有浏览器操作、收费生成、真实反馈发送或生产数据清理。

实际生成受理继续承担必要鲜核/费用原子段；本轮把重复报价准备及显示主快照退出writer，不声称全部受理都已缩短。B01报表、B02全站容量/资源、B03完整原件一秒交付及多人出口仍按原缺证口径，不因数据库整改冒完成。已知坏legacy不可归属时的fail-closed和首次显示码短初始化明确保留；本轮未新增任务外问题。
