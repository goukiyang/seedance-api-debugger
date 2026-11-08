# STUDIO-READ-LOCK01 生图模块间歇加载卡顿

日期：2026-11-08。用户反馈：读取生图模块很卡、要很久才出来。范围为既有模块读取、其共享版本检查与共同数据库入口；不触发生成、收费或通知，不将此前完整高清一秒目标冒称完成。

## 1. 已证根因与实测口径

生产基线 v0.138.1 / e8ef6eabf147b58999073c58977ee970ac080bb1 / BUILD kbIXWCclwPsqKnmEk3Hcu。

- Ego 自有工作空间2、同一已授权管理员会话、同一既有过度帧模块，连续3次无缓存GET：6690.9ms/503/74字节、132.5ms/200/6203字节、95.6ms/200/6203字节。失败保留，非只挑成功；这是HTTP读取时间，不是前台完整上屏时间。
- 同页活动模板首60秒的共享revision请求21次，全部200，中位136.8ms，最慢10151.1ms。整次记录90次，中位108.4ms，最慢10419.6ms。最初封面gallery读取1650.4ms，后续读取590.3/384.6ms，仍有独立解析成本。
- 生产WAL字节120的写锁持有者定位到 `sd2-multiview-works.service` 的实际Node子进程2461146，源同基线。服务CPU配额为100%（一CPU），引擎线程覆盖未配置。两个正常消费者并行领任务，即使空扫描也会发起事务。
- worker事务正文约10.1ms，提交却约10018.7ms；竞争事务等待约10秒并P1008/P2028。Web共享revision同步出现约10129ms总耗时、10018ms事务入口等待、43ms正文。主要耗时为等待数据库，不是浏览器绘制或6KB模块内容下载。
- 隔离合成库复现：同一原版Prisma5.22的两个事务，不限CPU约58ms；放入同100%配额后约5011ms并P1008。裸SQL写同样可触发引擎阻塞。证明开发机顺序/多核测试不能覆盖这次生产条件。

数据库本身只有一个同时写入者；本次问题是竞争BEGIN阻塞有限引擎线程，持锁者的COMMIT也无法调度，锁被放大到超时。

## 2. 架构判断与最小改动

复用 `catalogDirectoryWrites` 的公共Prisma入口，在SQLite原生事务边界通过进程共享FIFO有序执行。callback/batch/隐式目录写与明确的顶层ORM/SQL写共用队列；事务内语句及普通SELECT不额外排队，不串行化媒体处理或整条后台消费，不提高CPU额度。保留原业务事务正文、目录标记原子性、maxWait和失败释放，超时排队回调不得迟到执行。

必须将队列放在实际引擎入口，保留动态this及query extension。受理前的权限钩子可先独立写撤权再进入原事务，不能提前持队列导致自己等待自己。无schema、费用、素材、旧请求或权限合同变更；不采用延长锁超时掩盖问题。

## 3. 实施及工程检查

- a16efe81f：初始修法。attempt01完整原生门发现arch03与multiview-flow兼容失败，未进入上线。原失败记录保留。
- 0bd4d8cdc24b462e2e93ed97e8ecbcd6b24e1535：最终原生边界修正，v0.138.2，已推送。原先把普通extends怀疑为根因，独立测试反证后收窄到捕获事务方法的观察/受理前写钩子，不保留错误归因。
- 新增8项真实Prisma合成库检查：单引擎线程callback/batch、隐式目录标记、裸SQL写、普通ORM写、回滚与释放、extension及受理前写顺序、maxWait后不晚执行。两项原失败检查以最终源码独立通过。两次直接运行multiview夹具因未提供既有private root而拒绝，补正确输入后通过；不将输入失败记成业务回归。
- attempt02最终完整内置15原生/16用量夹具及计价检查已通过；Next类型检查随后发现新增fixture的块内function声明不支持项目默认ES5目标，尚未切版。只将声明改成等价const async表达式，不改全局tsconfig或断言。
- fc82a5338649019137be3cf09b37a6dab269f80b：仅上述工程脚本语法修正，已推送；隔离源码完整 `tsc --noEmit --incremental false` 退出0。attempt03按最终源重新生成完整候选，0bd调度业务源码字节保持。

## 4. 证据与重跑入口

- 本机私有证据：`/tmp/sd2-studio-read-lock-20261108/browser-before.json`；同目录baseline/with-writes复现脚本。
- 服务器隔离工程：`/data/video-api-debugger-engineering/studio-read-lock-20261108`。baseline/with-writes/cpu-quota保存红/绿对照，native-boundary-green与arch03-boundary、multiview-boundary-configured保最终检查；原失败保留。
- 最终发布目录：`/data/video-api-debugger/release-staging/studio-read-lock-fix-20261108/attempt04`；最终源2239a1完整继承fc82等前序修正，attempt01–03原失败、通过及性能否决证据保留。
- 可复跑工程入口：在独立合成数据库与隔离环境内运行 `node --import tsx scripts/sqlite-transaction-scheduling-engineering.ts`；不可将fixture指向生产DB。完整构建已将其接入原image-recovery门。
- 浏览器复测仅导航同模板、等待可见补充框，并连续3次读取同API、记录实际响应请求号；首次出现1.74秒长尾后另增3次暖读，分组保留不替换原样本；不读取/导出Cookie或响应正文，不点击生成。活动模板按首60秒汇总全部revision请求，保留失败/缺测。Ego帧率限制不拿DOM就绪当完整画面一秒。

测量纠错：第一次宽泛textarea选择器命中隐藏编辑框而20秒超时，这不是产品延迟。最初三次浏览器探针自行指定的请求号未在服务日志匹配，不冒称已逐条关联；服务器时段证据和浏览器样本分开保留。复测使用实际响应头请求号。

## 5. 部署、复测与未完成边界

最终v0.138.3已部署，真实同模块复测已完成本次严重锁等待验证；界面仍待用户手验，首次报价/个别首读长尾单列后续，不宣称全流程1秒。详细结果见§8。原0.138.1及138.2候选切换均未覆盖生产业务数据。既有guard bbeb854c82e47650ba3ea703f1918800af96881b / 0.135.9+points-pricing-guard.2 / BUILD bQTt2tX_GFRrdmNPmYcpf沿原完整成品及原时间复用；1491成品字节已鲜核。仅回程序，不回数据库、配置价格、账本、原件或请求回执；guard未含本次调度修复，回退可能重现旧卡顿。

全功能仍待用户手动验收；这批短时只读性能样本不能证明全站、大量同时在线或所有设备的SLO。后续活动revision轮询读放大另登D-20261108-STUDIO-REVISION-READ-AMPLIFICATION，不顺手引入缓存/服务或放松撤权一致性。

## 6. 138.2上线后实测否决闭环，继续修正覆盖（2026-11-08T22:58Z）

- attempt03完整15原生/16用量/计价/Next（含types/lint）通过，22:48:41Z正式切版fc82a5338649019137be3cf09b37a6dab269f80b / v0.138.2 / BUILD tO5JrYylj66eMrl-koebj，22:49:00Z七服务健康。6启动门、48资源及3匿名401，原件/价格/旧回执保护保持，无DDL。
- **性能仍未闭环**：正常消费者首批8事务出现正文7.3ms/提交10012.7ms及P1008；持续至22:58:17Z的74事务中P1008 17、P2028 8。不能用工程门或健康检查冒性能通过。原始worker-after-initial.json、worker-after-unresolved.json留attempt03。
- 进程exec环境只读确认两个实际Node进程均有file: DATABASE_URL，排除“未启用SQLite分支”；不输出连接串。简化CJS/ESM import身份探针返回sameClient=true，故不能将该具体导入方式编造成生产重复初始化根因。
- 新增第二个分别包装的真实PrismaClient，同合成数据库、引擎线程1，原8项仍过，新竞争稳定约5012ms/P1008。证明SDK引擎资源跨client共享，原每client闭包tail不足。**生产的具体未覆盖实例初始化来源尚未完全证明**，不把合成场景冒运行栈。
- 2239a1eaaa8e91bf53cb7e6f18a99a4c5a1cb1ed / v0.138.3：将已有native边界FIFO移至进程globalThis共享状态，保留原正文、动态this、maxWait、前置权限钩子与裸写规则；普通SELECT和非SQLite不串行。新增第二client与独立wrapper模块副本检查，9项通过，竞争约54ms。首个绿测试的结果格式化遇SELECT返回BigInt，修成同样SELECT但void回调后退出0，保留原日志，不记为应用故障。
- attempt04候选准备，基线必须使用现场fc82/138.2（不再e8ef），沿attempt03真实source-pair，原bbeb guard及137迁移只读继承；完整构建和生产复测仍待完成。未经过公共wrapper的独立客户端不自动被此队列覆盖，不谎称全部写者已归一，不顺手扩改反馈专用日志/存储边界。
- 先前Ego自有空间2在部署后直接查找不存在，fresh inventory仅剩用户空白空间0，未操作或接管它。旧基线数据保留；需要沿既有浏览器恢复规则核对身份后，在同一目标范围内补浏览器复测。

## 7. 真实启动依赖图的根因补证（attempt04）

在独立合成DB中按实际worker顺序导入work-render → previews → prisma，沿实际server-runtime标记兼容入口、production模式与单引擎线程；仅拦截SDK构造计数，不启动消费者或调用模型。共观察3个SDK对象：2个来自应用prisma.ts，1个来自明确只读的hd-readonly-db.ts。生产单例只依赖模块加载缓存，实际依赖图中会形成两份应用客户端；先前简化import顺序返回sameClient=true不能覆盖实际图。

使用这条真实依赖图创建的两份应用SDK对象，在相同原生入口竞争同一个合成DB，fc82旧版约5020.28ms且一项P1008，2239共享版约59.95ms两项成功。输出bootstrap-red.json、bootstrap-green.json及原日志留attempt04，明确productionDatabaseOpened=false、consumersStarted=false。初次尝试从最后加载的export重取旧对象，因缓存已指向当前对象导致身份断言拒绝，原bootstrap-red-identity-input.log保留；后改成捕获实际构造对象做对照，不把这个诊断输入问题算应用故障。先前未载入standalone server-only兼容标记的尝试同样未跑消费者。

本次最小修法以进程共享SQLite调度修正真实共享资源边界，保两份客户端各自原配置和现有权限/费用流程；不顺手全局复用SDK实例，避免另改客户端配置/生命周期合同。当前9项专项及最终完整内置门已通过，Next最终成品和生产多轮复测继续等待，仍不宣称解决。

浏览器恢复：旧空间2直接查询失败且fresh inventory仅用户空白空间0，按既有一次恢复规则在同目标重建本人空间3；相同管理员身份与原模块已核，用户空间0未操作。空间3当前about:blank停止轮询，最终复测仍复用它，完成后关闭本人页签。

## 8. 最终部署与本次只读性能收口（2026-11-08）

应用2239a1eaaa8e91bf53cb7e6f18a99a4c5a1cb1ed / v0.138.3 / BUILD rn8XdBxbJp9LDnH00cgyr；23:13:32Z完整成品通过，23:14:57Z正式切版收口，23:15:37Z七服务健康，控制器0。run 1ea81450-aedc-435c-8f4d-77af3dd23113，attempt04。完整15原生/16用量/计价/Next（含types/lint）、新增9项调度检查、6启动门、4timer、48公网资源字节及3匿名401有证。无本轮DDL，137迁移只读继承；价格三合同原修订及2行全字段SHA保持，CPU预算未增加。应用已提交推送，功能由用户手验。

| 测量组 | 样本数 | 原版 | 138.3 | 判定边界 |
| --- | --- | --- | --- | --- |
| 同模块首次3次无缓存HTTP | 各3 | 6690.9ms/503、132.5ms/200、95.6ms/200 | 323.0、355.6、1735.7ms，均200 | 保留1.74秒长尾，不能宣称所有首读<1秒 |
| 138.3后续暖读 | 3 | 不补造同口径旧暖组 | 101.9、96.6、99.7ms，均200 | 独立分组，不替换首轮较慢样本 |
| 活动模块点击后首60秒revision | 旧21、新28 | 中位136.8ms，最慢10151.1ms，全200 | 中位117.65ms，最慢426.7ms，全200 | 固定60秒保留全部请求，非P95或多人容量 |
| 正常worker事务 | 新84次/约8分钟 | 旧约半小时189次，100次P1008/P2028 | 23:14:56–23:22:59，84次全成功，最大提交收尾5.8ms | 两窗口时长不同，不拿错误数相减算百分比；CPU仍100000/100000 |

新版首轮与暖读6个请求的真实响应号全部在`/data/video-api-debugger/logs/sd2-gray.log`关联，原始module-after-traces-all.json保留。最初误查journal未匹配的空结果另保留，Web真实stdout为该文件，并非请求关联本身失效。旧基线自行指定请求号未匹配仍如实保留缺口。

1.74秒请求的auth为1.8ms、事务入场等待1374.8ms、事务正文170.8ms、提交0.2ms，服务器总1714.9ms；同段另有无父请求标识事务正文1363.7ms，以及首次报价HTTP2447.8ms。两者时段重叠但**报价持有该事务尚未直接关联证明**，不得归因成报价金额或费用错误。报价入口未接统一HTTP请求跟踪，后续按D-20261108-STUDIO-COLD-QUOTE-TRACE补证，不为提速省权限、冻结快照或改变费用。严重10秒提交饥饿已消除，仍未完成“全部首开1秒”或原先完整高清图1秒目标。

私有原证集中attempt04：performance-summary.json、worker-after-final.json、browser-before/after.json、module-after-traces-all.json、slow-module-overlap.json、bootstrap红绿及本机可复跑的Ego/SDK脚本；不把原始业务响应、私有正文或凭据提交仓库。Ego自有空间3已finish关闭，用户空间保持。恢复仅沿本stage原program-recovery和既有guard回程序，不回数据库/价格/账本/媒体/请求；guard未含本次修复，恢复可重现旧卡顿。
