# 项目任务外发现报告

<!-- D-20261112-MEDIA-ERROR-COPY -->
## D-20261112-MEDIA-ERROR-COPY 媒体读取失败沿用喜欢功能文案（已确认，非阻断）

本轮旧缩略图/参考传输修复的风险核对中，定向源码确认`src/app/api/content-reactions/media/route.ts`在非鉴权读取异常时调用共用`reactionError`；`src/lib/content-reactions/http.ts`对未知异常固定503与“喜欢暂时不可用，请稍后重试”。因此该媒体API实际错误场景的JSON提示与图片读取无关。普通img失败仍走既有不可用占位，不等同原件丢失/权限绕过/生成失败，未做浏览器现场复现。

后续在该读取route窄改为明确媒体错误提示，保401/403/404、Cache-Control及真实503，不扩改其它喜欢/删除接口。本轮main8f73已冻结构建，未将这项旧错误文案夹入或重建全站；完整缩略图与普通视频引用两项目标继续。原任务和证据入口：[LEGACY-THUMB-REPAIR16](todo/2026-11-11-seedance-private-character-assets.md#16-旧缩略图完整显示修复与提交未知排查2026-11-12)。
<!-- /D-20261112-MEDIA-ERROR-COPY -->

项目全名：video-api-debugger（sd2 视频生成API调试平台）
正式根：`/Volumes/Data/Projects/video-api-debugger`
建立日期：2026-11-01
规则：[额外发现与夜间维护](/Volumes/Data/CodexHome/rules/rule-sync-and-maintenance.md#额外发现与夜间维护)
处理线程：[半夜维修工登记](/Volumes/Data/CodexHome/tasks/night-maintenance.md)

本报告仅保存正常任务中额外发现的线索、问题及处理入口，不扩大原任务，不替代[固定todo](todo.md)或已有工单。本轮仅录入导航排查的额外线索，不表示已做全项目排查。

## 待核线索

<!-- D-20261107-PIN-MEDIA-SCOPE -->
**D-20261107-PIN-MEDIA-SCOPE｜已证读取放大 / P3，非已证当前延迟根因。** resolveStudioPinnedAsset查单asset索引后仍读整root（上限200）；可见性又读全部私密绑定，列表前后各核。生产29同源码隔离SQLite顺序6组×7暖样本：1pin/0绑定p50=5.63ms、10次查询/6返回行；200pin/0绑定10.96ms/404行；1pin/1000绑定29.98ms/2006行；200pin/1000绑定42.61ms/2404行。计数是Prisma返回行，不是底层扫描行，非HTTP/并发SLO或改造收益。生产只读当次仅3pin（最大组2）、77相关绑定/23引用/20独立asset、格式异常0，另9metadata子记录按reader排除。另在合成库添加1个无关不兼容私密引用后，两个模板的同事媒体和普通feed失败、管理员读正常，证明全局parse的故障放大；生产坏行0，属已复现风险，不冒当前根因。定向catalog SQL同样有全局兼容检查，不能只传assetIds或忽略坏行就称修复。沿[原单§16.8.3](todo/2026-11-05-template-sharing-cutout-open-preflight.md)优先按原索引缩小任务/资产范围并复用权限投影，保撤权/文件别名/私密保护，不先建缓存、表或服务；无真实坏行时不加理论兜底。原始42样本、源码身份及故障注入见正式根私有pin-wide-gallery/architecture-audit-20261107。
<!-- /D-20261107-PIN-MEDIA-SCOPE -->

<!-- D-20261107-PIN-REMAINING -->
**D-20261107-PIN-LEGACY-SOURCE｜已确认历史谱系边界 / P2，待界定兼容发布。** 同一9宫格旧工作区6条成功active、任务与冻结source均null的结果全部早于当前共享源创建（2026-10-04T14:34:12Z）；原冻结名为未命名/表情，publisher/binding/reproduction关联均无。现规则403可复现，原图保留；不是42条工具样本，也不证明6条都应按今天源共享。现代绑定不可变，不按名字猜来源。不能回写source冒历史事实；补可信执行/显式发布关联，沿原单§16.8.3处理。

**D-20261107-PIN-VISIBILITY-STATE｜已复现本人管理状态投影缺口 / P2，待实施。** 私密化后stored pin保留而普通读者被正确过滤，管理员仍可见；补测普通生成者自己也可遇stored=1/visible=0，后端active=false可取消，但按钮从可见集合推断active，不能得知此记录仍已发布。应分离本人已记录管理状态与读者可见投影/原因，不放松私密或原图权限。生产本次3条pin，同asset私密引用重合0（未覆盖文件别名的ACL全判定），不冒现场发生证明。

**D-20261107-PIN-CONFLICT-RECOVERY｜已确认目录游标恢复缺陷 / P2，待实施；CAS保留。** 隔离生产29原源码两用户对不同图从同revision提交，一成功一409；旧feed游标在置顶变化后连续两次409，新读成功。普通onRetry仍用taskRetryCursor，已翻页silent不更新nextCursor；喜欢列表refresh虽首读但pageReads>1仍保旧nextCursor，后续more可再遇同409。最小修法针对目录失效重建分页边界，保持已见结果/账号/模块/筛选；不吞全部409或移除CAS。待确认置顶原操作只存模块Map，整页刷新接续提示丢失但服务器记录不丢；未证生产重复操作、丢图或并发频率。

统一入口为[原联合工单§16.8.3](todo/2026-11-05-template-sharing-cutout-open-preflight.md)。新证为正式根私有pin-wide-gallery/architecture-audit-20261107下生产只读元数据与两次隔离探针（均退出0、无网络/费用）；12相关源SHA与生产29一致。原§16.8.2保留前次判断，以上为后续取证收窄，不冒已修复/功能验收，不重复建单。
<!-- /D-20261107-PIN-REMAINING -->

<!-- D-20261107-SHARED-CPU -->
**D-20261107-SHARED-CPU｜同机资源待核 / P3。** 2026-11-07T17:05:03Z只读资源核对：服务器4逻辑核，PID830293（仅命令名python3）已运行2863727秒，ps报告CPU99.3%。未调查用途、所属项目或合法负载，不能据此判定异常、模板故障根因或用户延迟收益。可能压缩同机可用CPU预算，后续先核归属与时间窗口再判断；本轮不杀进程、不改资源分配。原证：[共享生成修复资料](../docs/materials/2026-11-07-template-sharing-generation/shared-cpu-clue.json)，仅含资源元数据，无进程参数或业务内容。
<!-- /D-20261107-SHARED-CPU -->

| 编号 | 类别 / 优先级 | 事实、潜在影响与证据边界 | 来源与证据 | 状态 / 下一步 |
| --- | --- | --- | --- | --- |
| D-20261106-PRICING-BOOT-READ | 恢复后的待核线索 / P3 | v0.134.7切版后第一次管理员费率GET为503，未提交保存；原503正文未保留，随后GET200、正常CAS和独立只读核对均完成。所采服务日志仅见启停，细因未证，不当成持续故障或核验通过。 | [原单运行记录](todo/2026-11-05-ledger-rate-accounting.md#rate-video01-最终交付)；13:03切版后的首次配置读取，最终13:06:26Z保存成功。 | 已恢复、不阻本次交付；复发再保响应正文和关联日志，不扩成冷启动优化。 |
| D-20261106-RELEASE-FINALIZE | 工程包装层待核 / P3 | RATE-10 guard完整Next、类型/lint和源码校验已成功并写原证，但包装层退出120，链接/权限/ready未执行；原控制器已退出而本机SSH仍未返回。仅核证后补齐原收尾，未重编或改旧失败。输出连接为疑似原因，尚未证实细因，不是生产功能复现。 | [原单最终交付](todo/2026-11-06-points-scale10-welcome.md#最终交付)；服务器points-scale10-20261106/attempt01/build-progress.json与guard-finalization-recovered.json | 发布已完成且数据未回；后续若复发补采原stdout/stderr与连接状态，不因此重跑已成功构建或扩改发布引擎。 |
| D-20261106-HD-GATE-STATE | 待核线索 / P2 | 费率启停候选的原有HD检查相同源码输入一次通过、一次E06执行响应身份失配用例得到queued而非failed（22/23）。不是生产复现，根因尚未确认；本轮不修改HD模块。 | RATE-ENABLE01；服务器pricing-item-activation-20261105/attempt02原失败报告及hd-chain-ub4HpD/child-1.log，和attempt01通过回执逐字段源码hash相同。 | 待独立核查用例时序和执行状态；保留失败原证，不以重跑掩盖。 |
| D-20261102-02 | 已确认机制、线上影响待核 / P2 | 网站反馈POST仅前端submittingRef防重，服务端每次新建Feedback；网络丢回执后重提可能形成多条反馈和多份通知。未查生产重复数，不能称已发生。 | [提交源码](https://github.com/goukiyang/seedance-api-debugger/blob/6629e540dadaa816d17e6784a904d24ec50262a1/src/app/api/feedback/route.ts)、[插件反馈工单](todo/2026-11-02-plugin-feedback-entry.md) | 插件新路径已设计同事务耐久提交回执，尚未实施；网站旧入口另行核影响与迁移，保旧行为，不在本轮工单阶段修代码。 |
| D-20261101-01 | 待核线索 / P2 | 生产构建已确认共享 Prisma 类导入桥；实际客户端实例数、跨 Next 路由 bundle 的展示缓存是否共用仍未知。可能重复建连接或重算菜单，不能认定已发生。 | [窄拓扑证据](../docs/materials/2026-11-01-admin-usage-read-snapshot/built-cache-topology.md)、[初始化](/Volumes/Data/Projects/video-api-debugger-worktrees/admin-usage-read-snapshot-reader-20261101/src/lib/prisma.ts) | 待核；需要时映射实际初始化与缓存身份，不先改 singleton / TTL，不加生产探针。 |

## 已确认问题

<!-- D-20261108-RELEASE-RECOVERY-ANCHOR -->
**D-20261108-RELEASE-RECOVERY-ANCHOR｜已确认，相关入口已修正；未实际回退演练。** 复用135.0 stage发现program-recovery.sh仍断言旧pin-wide-gallery/attempt03及3516，与fusion真实stage/3654不符，事故时会在停服前拒绝；没有由本次切版触发现场故障。原作者4修其fusion stage、角色2修其role31入口，各保原脚本及SHA。本人最终135.4 stage pin-recovery-20261108/attempt02锚点为本stage/cbaf239基线，F0原构建1469文件验证；真实切版后marker/备份/contract齐备时第一段只读前置通过，实际恢复未执行。不能复制切版成功回执冒恢复入口可用，后继按实际源/目录接续；[原联合单§16.8.4](todo/2026-11-05-template-sharing-cutout-open-preflight.md)，私有recovery-readonly-preflight.json保存无业务写证据。
<!-- /D-20261108-RELEASE-RECOVERY-ANCHOR -->

PIN相关原四项处理：135.4/38fc52f已部署目录恢复、本人管理/取消、可信旧图显式发布及单图定向权限，完整22聚焦/types/native/Next及发布检查通过，待用户手验。新单图Prisma目标任务/Asset各1行，但全局兼容坏行探测与整组CAS仍保持；旧6图未批量发布，旧未知/CPU等不关闭。详原联合工单§16.8.4及正式根私有recovery-20261108证据；上方§16.8.3为原调查事实，不冒全站无问题。


**D-20261105-ACTUAL-RATE-COVERAGE｜已修复部署，功能待用户手验**：历史aff41下已确认样片用3/4.5固定点数、IP未接人民币，原抽查30条流水与各自冻结合同一致；该历史事实保留。2026-11-06 RATE-VIDEO01/v0.134.7已正常CAS新增16条同代同分辨率人民币关系、移除2条旧通用规则，当前22条视频规则按10点/元，新缺价付费报价拒绝旧兜底。原40金额/来源/开关及旧账不改，新用户赠分仍关；站内继承不冒供应商实扣。[原单最新交付](todo/2026-11-05-ledger-rate-accounting.md#rate-video01-最终交付)为唯一详情。

| 编号 | 类别 / 优先级 | 事实、潜在影响与证据边界 | 来源与证据 | 状态 / 下一步 |
| --- | --- | --- | --- | --- |
| D-20261105-NOCHARGE | 已确认旧判定不等于原账证明 / P2 | taskCostFailureClassification仅按未获provider_task_id判failed_no_charge，理由本身写“暂按未收费”；旧界面部分将其写成“已确认未收费”。此次缺口中116条命中旧标记，不能证明供应商确未受理或免单，不应据此补0或解除未知请求保护。未证实际漏费。 | src/lib/costs/ledger.ts:210；src/app/admin/outputs/AdminOutputsClient.tsx:193；COST-CHECK01追加缺口清单 | 本批保留原账和原请求，不按旧标记补0；另行局部区分旧推定/上游明确未收费，缺上游凭证继续待核，不全量改历史。 |

## 结构性线索与方案

| 编号 | 类别 / 优先级 | 事实、潜在影响与证据边界 | 来源与证据 | 状态 / 下一步 |
| --- | --- | --- | --- | --- |
| D-20261101-02 | 疑似结构问题 / P2 | 目录 revision 仍按 templates / assets 全局域更新；无关回执已排除。多人跨账号刷新放大尚未量化，未证无限循环。 | [失效边界](/Volumes/Data/Projects/video-api-debugger-worktrees/admin-usage-read-snapshot-reader-20261101/src/lib/catalog-directory-writes.ts)、[D 调查](../docs/materials/2026-11-01-admin-usage-read-snapshot/investigation-D-gallery-feedback.md) | 待确认；先量化真实定义变更的账号影响，再比较局部失效与现状，保权限失效保护。 |
| D-20261101-03 | 疑似结构问题 / P2 | SQL 已独立只读；自然报表仍有 1,403 次查询、25,750 行、约 7.45 MB IPC，Node fold 0.82–1.52 秒。数据增长可能增加 Web 竞争，但尚未证明 fold 阻塞重叠导航或并发上限。 | [B 调查](../docs/materials/2026-11-01-admin-usage-read-snapshot/investigation-B-shared-runtime.md)、[汇总实现](/Volumes/Data/Projects/video-api-debugger-worktrees/admin-usage-read-snapshot-reader-20261101/src/lib/admin/usage-analytics.ts) | 待确认；先分解查询和转码成本，再据重叠证据比较减少往返或隔离纯计算；不顺手建 worker 池或迁库。 |
| D-20261101-04 | 疑似结构问题 / P2 | 生图政策解析仍构建含 image / IP / enhance / H3 的共享计价目录；本轮已减少重复计算。其他配置异常会否导致整份生图菜单失败，尚未逐项核实。 | [政策读取](/Volumes/Data/Projects/video-api-debugger-worktrees/admin-usage-read-snapshot-reader-20261101/src/lib/pricing/policy.ts)、[共享目录](/Volumes/Data/Projects/video-api-debugger-worktrees/admin-usage-read-snapshot-reader-20261101/src/lib/pricing/catalog.ts)、[汇总](../docs/materials/2026-11-01-admin-usage-read-snapshot/findings.md) | 待确认；先用隔离夹具核故障范围，再比较按能力分区展示；保真实收费、权限和来源核验。 |

## 最近关闭与归档

总览只保留简短状态及链接；已关闭历史索引变长时按需移至 `discoveries/archive/`，保留可检索入口和原编号，不改写历史结论。

### D-20261108-FUSION-RECOVERY

已确认缺陷 / 发布保障；本单已修，实际恢复未演练。角色融合attempt03继承的program-recovery.sh仍固定旧任务stage/baseline，会在停服前拒绝恢复；实际发布成功未触发，无线上中断。10:04Z仅修本单两处锚点，保原脚本/前后SHA，bash语法、只读前置和F0原1469编译哈希通过；未运行后段恢复或改服务/数据。源头为15号复用资料时补查；其它历史stage未核，不扩修。证据及完整边界：[原单补正](todo/2026-11-08-character-fusion.md#发布保障补正2026-11-08t1004z)，私有anchor-fix-proof.json沿原单；后继15已获知自身stage需绑定自身输入。

## 记录约定

- 新项使用项目内稳定编号，如 `D-20261101-01`；同根因或同对象的新证据更新原编号，不重复建单。
- 各分区条目使用“编号、类别、影响/优先级、简述、来源与证据、状态、详情链接”的短表格；明确事实与待验证假设。
- 短线索就地记录；较长调查与方案放 `discoveries/<编号>.md`。已有工单或附件直接链接，不复制长文、私有媒体或凭据；没有实际详情时不造空文件。
- 详情按需保存现象、证据、影响、根因/假设、候选方案与推荐、确认状态、实施及验证/恢复结果。状态区分待核、待处理、待确认、处理中、受阻、已修待手验、已关闭。
- 小修沿既有授权及项目工程检查执行；结构性、大范围及影响不明事项先出方案等用户确认。功能验收仍由用户手动完成，不以构建、推送或健康检查冒充通过。

- **D-20261104-TEMPLATE-MARK-LIST-SCALE｜个人收藏列表先全量解析再分页｜待核线索 / P3**：`/api/content-reactions` 的模板组织列表沿 `listReactions` 先读取本账号全部有效标记，逐条 `resolveReactionContent` 后再截取页；分组统计也读本账号模板标记。实现事实已核，当前收藏数量、请求耗时和瓶颈未测，不能判成已发生的性能故障，也不把它归因于本次统一标记。CP01/ARCH03封面目录的有限SQL分页仍保留。本轮不扩为重构；后续如列表卡顿，先固定真实账号、标记量、权限条件，测一次请求耗时/查询数，再决定是否将组织列表接入相同授权投影与分页，不能先分页后漏权限/搜索结果。来源：TEMPLATE-MARK01，`src/lib/content-reactions/service.ts:listReactions`、`template-favorites.ts:favoriteOrganization`；未做浏览器或生产规模测试。


**D-20261108-ROLE-RECOVERY｜已确认并修正本单恢复入口锚点。** 同类发布模板复用后，角色31/movable-layout/attempt04的program-recovery.sh首段仍断言pin-wide旧stage与3516旧baseline，自动恢复未触发，因此此前cutover0并不能证明入口可执行。按15/4证据，仅修本单两常量至role31 stage/179f，保原脚本及SHA；只读首段通过guard检查后正确拒绝后继135，未执行停服/切版/写配置/数据。新135.3恢复入口匹配本单stage及实际135，发布前验证自身首段。详见角色原单§19、movable-layout/attempt04/anchor-fix-proof.json与image-fit新批证据。不扩改其他发布或创建治理系统。

## 2026-11-08 共享全链路追加审计（SHARE-CHAIN01）

- **D-20261108-SHARE-STATE-ORDER｜已确认缺陷 / P1，已部署v0.138.0，功能待手验。** 实际a50/135.11的共享receiver直接替换；真实React延迟旧读在active props已为8后仍投递7并回退token。已发布共享onSettled又仅写isShared，丢掉真实回执的moduleRevision（示例9/页面8）；接收端隔离复现成立；普通save父层原已有refresh，不能断言该完整路径必然回退。修法按同账号/对象的统一确认投影与读取代次，不能只加Math.max、比较hash大小或吞撤权。上轮原文回调修复仍有效，不冒整个共享已闭环。
- **D-20261108-SHARE-COMMAND-DURABILITY｜已确认恢复缺口 / P2，已部署v0.138.0，功能待手验。** 普通模板定义保存原号只在moduleSaveRequest ref，temporaryDraftPayload无原号，真实React重挂后null。服务器原回执没有丢；未证重复生成/扣费。沿既有耐久命令方式保最小元数据，刷新先查原号，不把私有正文写本机。
- **D-20261108-SHARE-DEFINITION-STORAGE｜已确认交集缺陷 / P2，已部署v0.138.0，功能待手验。** 严格加密合成库中，作者只读definition返回存储信封，专用private-editor返回同一授权明文，组件直接渲染context。需接既有私有正文授权/解密/脱敏边界；不是生产明文泄漏证明，也不授管理员绕策略的权限。
- **D-20261108-SHARE-COUPLING-ISOLATION｜结构耦合及已复现风险 / P2，已部署v0.138.0，功能待手验。** 真实rename仅改名、生成正文/参数/参考不变，仍改生成token；无关合成坏复现记录使目录/旧revision整体失败，健康定向读取成功。生产本次17条复现、82binding相关JSON异常0，不冒本轮线上根因。分离展示/生成合同、目录摘要与条目解析，私密保护失败不能被静默忽略。
- **D-20261108-SHARE-LEGACY-MATRIX｜兼容样本已补 / P2，生产逐模板待手验。** 原18:08Z生产只读有24个带source无新binding工作区、11个共享原件无新publisher映射；82新绑定owner/source匹配且无缺workspace。需分类旧apply/个人副本/历史/现代live，不按名字推断迁移，不批量回填。多人吞吐和逐模板实页未验，不把2秒轮询/32队列上限当人数承诺。 无binding/无publisher与参数副本/modern live隔离样本已过；不回填旧记录。

- **D-20261108-SHARE-NAV-NAME｜交集缺陷 / P3，已部署v0.138.0，功能待手验。** 飞书导航label读raw workspace.name，共享源改名主要改source.name并增workspace revision。已核任务快照冻结实际源moduleName；新导航优先该次受理名，旧无字段任务保本人工作区名。隔离工程检查覆盖新/旧路径，真实飞书卡片待手验；不重发、不改共享范围。

完整证据、边界和整改顺序见[共享全链路审计](../docs/template-sharing-chain-audit-2026-11-08.md)及[原联合单§16.11](todo/2026-11-05-template-sharing-cutout-open-preflight.md)。原17项和完整构建复用，新增三批诊断仅复现新缺口，无生产业务写/收费生成/浏览器验收；上述新增缺陷尚未修改上线。

SHARE-CHAIN-FIX01收口：R1–R5及飞书命名交集已部署0.138.0，实际回执/原失败沿联合单§16.13与审计§8；数据与费用不回滚。旧生产模板逐项、真实卡片与多人吞吐仍待手验/取证。

## 2026-11-08 发布资源页面预检（任务外发现）

- **D-20261108-RELEASE-PAGE-PREFLIGHT｜已确认流程缺口 / P2，通用工具固化待办。** 我在03发布资源配置中猜用了不存在的`/tools/page`，后核触发保护回guard；应用构建/服务本身已过，未回业务数据。04按真实app-build-manifest先核4个路径及1514原成品字节，同构建接续成功。本轮已做前置核对；后续在现有发布准备工具加同样局部预检，让缺项在停服前拒绝，保公网HTTP/字节核对，避免靠事后回退发现配置拼错。未顺手扩建平台或把通用工具冒已改。


<!-- D-20261108-STUDIO-REVISION-READ-AMPLIFICATION -->
## 生图模块读取的后续规模线索（2026-11-08）

**D-20261108-STUDIO-REVISION-READ-AMPLIFICATION｜已核实现，规模影响待测 / P3。** 活动模板共享revision约2秒轮询，沿sharedStudioRevision解析当前共享定义，并经readSharedStudioSnapshot使用Prisma事务；SQLite该事务即使只读也竞争写锁。STUDIO-READ-LOCK01已定位一CPU引擎线程争抢造成约10秒停顿，最小修法在原生事务入口排队，不能由此声称轮询成本或多人容量已解决。生产基线首60秒21次revision（含10.15秒长尾）及约6KB模块样本保留，不构成人数上限。后续先测真实并发、查询量与依赖标记覆盖，再决定是否以现有目录修订构建纯读投影；权限/撤权及模板/风格/提示词依赖不能被缓存省略，不预先改库或扩建平台。[原单](todo/2026-11-08-studio-module-read-latency.md)保存根因、当前修法和部署证据；本条不要求扩大本轮范围。
<!-- /D-20261108-STUDIO-REVISION-READ-AMPLIFICATION -->


<!-- D-20261108-STUDIO-COLD-QUOTE-TRACE -->
## 生图首轮报价与无父请求事务（2026-11-08）

**D-20261108-STUDIO-COLD-QUOTE-TRACE｜现象已核，归属/持续性待核 / P3。** 138.3严重10秒SDK提交饥饿已修，但同一真实只读首轮仍有模块HTTP1735.7ms，其中事务入场1374.8ms；同段另有Web无父requestId事务正文1363.7ms、首次报价HTTP2447.8ms。quote/route.ts未接traceHttpRequest已核，不能仅凭时段重叠把长事务判给报价；未证金额错误、重复扣费或持续每次2.45秒。后续先补报价原请求关联与必要阶段计时（不记录私有提示词/凭据），核无父事务调用方，区分冷初始化、价格/快照读取与普通数据库排队；按同口径复测再定最小修法，保冻结合同、权限及费用，不先缓存掉撤权或改价格。首轮3样本和追加3暖读均保留，[原单§8](todo/2026-11-08-studio-module-read-latency.md#8-最终部署与本次只读性能收口2026-11-08)及attempt04私有原证可追；本轮不顺手扩改收费核心。
<!-- /D-20261108-STUDIO-COLD-QUOTE-TRACE -->


<!-- ARCH-AUDIT01-20261108 -->
## 2026-11-08 共享基础设施横向排查（ARCH-AUDIT01）

完整证据和11项边界见[结构排查清单](todo/2026-11-08-shared-resource-architecture-audit.md)，审计基线2239/v0.138.3；下列为发现时事实。A01–A11现已整批部署v0.139.2，实际结果与保留边界见原单§9。

- **D-20261108-DB-CLIENT-COVERAGE｜已确认入口/初始化缺口，隔离复现 / P1。** 反馈独立SDK未走进程共享原生队列；4引擎线程/8反馈事务合成样本10.02秒、7个P1008，包装对照57ms。真实两应用client的busy_timeout分别10000/5000ms、synchronous NORMAL/FULL，原因是进程初始化标记只覆盖第一份实例。覆盖网站/Bridge/管理/飞书反馈状态路径，但不是已证当前生产反馈事故。先补共同准入和按client初始化，保反馈隐私不打印正文、原号/事务保护；不拿8个事务当8人容量上限。
- **D-20261108-DB-PREFIX-PLAN｜已确认查询计划 / P2。** 实际Prisma5.22固定参考startsWith生成LIKE，EXPLAIN为SCAN；范围候选可用现有key索引。当前4604配置、JSON约11.55MB，未证这是10秒根因；核前缀/大小写/旧ID语义再局部改查询，不重复加同列索引。
- **D-20261108-QUOTE-PREVIEW-LIFECYCLE｜已确认清理路径缺口 / P2。** 固定报价早返跳过实际分支的旧预览清理；607预览中601固定/6实际全部过期。受理仍会CAS消费，不说所有票据永久累积；本轮未删生产记录。后续共用有界预览清理，保已受理/未知合同和账本。
- **D-20261108-PRICING-FAULT-DOMAIN｜隔离复现的跨业务耦合 / P2。** 图片报价可进入全10配置源校验，假的坏H3 JSON阻断整个目录；未证生产H3已坏。按业务能力缩小故障范围，真实共用费率损坏继续拒绝，不吞错误/补0价/切更贵供应商。
- **D-20261108-PREVIEW-DB-TOPOLOGY｜运行事实已核、只读合同待核 / P2。** 老源72f4的mj-dna预览服务打开生产同一device/inode数据库，未证只读策略、写权限及实际写入；不判定污染或越权，不停服务。补完整writer拓扑和迁移隔离边界，本次无DDL。
- **更新原D-20261107-PIN-MEDIA-SCOPE：** 现代置顶任务/资产已有目标查询；残留非管理员封面权限仍全局引用LIMIT257、超过256拒绝，现有22未触发。无ID兼容路径仍读全局绑定；按目标/文件别名缩小，不忽略私密坏行。
- **更新原D-20261104-TEMPLATE-MARK-LIST-SCALE：** 先全量授权解析再分页仍存在，现存63全站标记、单人最大52；延迟未测，待批量授权投影/分页同口径处理。
- **更新原D-20261108-STUDIO-REVISION-READ-AMPLIFICATION及COLD-QUOTE-TRACE：** 两大目录全局域/约2秒活动依赖解析及报价复用提交准备事务已核；隐藏/离线已有轮询门。沿用首读1.74秒/入场1.37秒、无父事务1.36秒、报价2.45秒原证，不能按时间重叠认定持锁者。先补现有请求关联再缩事务，不省撤权/价格校验。
- **更新原D-20261101-03及SHARED-CPU：** 报表已有独立只读capture后fold，旧1403查询/7.45MB IPC/0.82–1.52秒不是本轮复测；当前4逻辑核及各worker quota不等于实际争用/预留。同机负载、供应商容量和高清/原件出口仍单列待核，不先扩容或换库。

**2026-11-09T07:26:09Z接续：** A01–A11已统一部署9784618d1 / v0.139.2 / BUILD 2XhgF8s3POHaZvOTAlE6y。完整原生/计价/Next/types/lint及7服务4timer/58资源/6匿名401通过；旧预览已实际内核只读，同库旧SDK读取正常。反馈隐私/FULL、原权限撤权、费用/原号/CAS及历史保持；无DDL、手工生产清理或改价，待用户手验。收藏批量后精确搜索统计仍O(N)，不可归属坏legacy仍保守拒绝；B01–B03仍缺证，本轮未新增任务外产品问题。
<!-- /ARCH-AUDIT01-20261108 -->

<!-- D-20261109-CAP-REPORT-HD -->
## 本轮新发现的线索与问题（CAP-REPORT-HD01）

- **已确认缺口已修：Works鉴权计时与HD暂停可见性。** v1397计时含route鉴权/作品权限，线上合法样本HEAD200已见auth3.4ms/work_access25.6ms，access31.2ms包含两者，不相加。HD硬暂停由现有通知投影管理员，10项工程覆盖故障/正常/身份，正常GET200；UI手验及离线推送边界保留，不冒全套存活告警。
- **已确认结构残留：目录就绪核对仍承担大量源码工作。** 同次同root重复hash减半，127次每次仍296读取/3.54MB；8actor四个10秒均成功不证明长期全站上限。后续若真实请求仍由此主导，将发布身份绑定的只读就绪制品与浏览分责；本批不跳过鲜核、加跨请求缓存或放松吊销。
- **已确认增长残留：proof/ref、IPC与fold。** cash10x SQL6501→2850，但仍96742行/34.3MB IPC，整CPU仅单次-1.7%。有限准入已部署，Web计算隔离未做；沿原分段先裁重复关联/传输，再判断既有只读计算是否移出Web，不造第二套账。**待核**个人/项目近6月120s事务路径无相同规模数据，不能当成已证长占锁或已整改。
- **原验收残留：** 旧4.11MB高清冷开6/6超标，正常Chrome完整组/手机/未就绪等仍缺证，Ego约1Hz不可替代。固定新样本任务15:44真实删除，两HEAD404符合保护，未恢复；历史保原时间，另一个合法样本HEAD仅验计时，不冒同源A/B。

详[统一工单§12](todo/2026-11-08-capacity-report-hd-closure.md#12-第二批交付与逐项验收utc-2026-11-09)，原值/失败/复跑入口保正式根私有资料索引。未扩全项目审计，未加账务真值、云消费或媒体外传。

- **本轮边界补查已确认：项目列表与个人报表耦合。** view=list等待近六月个人用量完整读取/汇总，翻页和筛选重复承担它；home/lite不在该链。实际拖慢程度待测。下一批先解耦列表/摘要，保原费用和权限。
- **已确认应用排队机制及取消缺口：** 个人/项目报表callback事务与部分写入共用进程串行queue；其HTTP和snapshot未传播请求signal，管理员1运行+1等待不覆盖这些入口。不能称已证数据库锁120秒；应审纯读后迁既有只读快照、保真实写入排序并接取消。
- **已确认方案前置缺口：** 当前140.2发布源码由运行UID所有，无只读挂载/immutable封存；在补运行写目录分离与发布制品封存前，不能把每次fresh源码核验改成只信收据。
- **待核放大路径：** 正常任务状态/usage变化推进全局目录版本，实际订阅重读放大未测；部分服务无服务级CPU/memory预算，但HD/role已有配额与应用门，尚无当前资源竞争致延迟证据。均沿原链补测，不扩成全站换库/重构。

- **已确认共同阻塞源并已写最小修复：** 现有日志精确找到1158.5ms个人用量读取及五笔666.5–1144.8ms排队；当前Linux Prisma5.22隔离库确证SELECT callback使用BEGIN IMMEDIATE并挡另一连接写。作品大图权限SQL/部分封面读也进同网页进程队列，但五笔未标op，不能指认其路由。a9f58已将公共用量接既有RO固定快照、接signal/late-close清理并复用报告预算，7项/7子进程检查过；尚待发布，不改真实写保护。
- **已确认目录重读机制，规模待核：** 一次全局版本变化让两个active封面查看者各重读一次，非active工作台和同版本重复值不重读；任务status/usage会推进版本，lease单独续期不会。未测生产人数/触发率/CPU，不称全员无限风暴。
- **共享资源待核已补被动样本：** 20秒窗口四服务无OOM/节流、HD未编码，主机另有负载；它不与历史慢请求同窗，不能认定或排除HD满载争用。未改其他进程/额度，详原单§14与原始私有元数据。
<!-- /D-20261109-CAP-REPORT-HD -->

<!-- TPL-CURRENT01-TOOL-20261109 -->
## D-20261109-CODEGRAPH-IO 本机索引准备缓慢（待核线索）

TPL-CURRENT01的实际独立checkout初始化CodeGraph约50分钟仍未完成，进程处于读取等待，已停止本人索引；未取得可用查询，不声称覆盖当前源。日志 /Volumes/Data/Cache/template-current-input-20261109/codegraph-init.log，过程及安全源码替代见[原单](todo/2026-11-09-template-current-input.md#8-最终交付回执)。与既有D-20261101-06 worktree准备缓慢同属本机工具链线索，未核是否同根因，未证明仓库损坏或网站故障。应用以精确Git源、32项工程、两套完整构建和必要部署证据交付；本轮不扩为磁盘、Git存储或索引服务整治。

R02扩查补证：准备入口虽返回READY，独立checkout的git-common-dir不符合适配器限定，实际SQLite缺少current-inputs/tasks/batches/shared-contract四个后端文件。studio.tsx和PrivateDefinitionEditor.tsx已有记录且与当时源SHA一致，前端结构查询可用；不能据此声称后端索引恢复。缺口按定向源码接续，未扩改全局工具。
<!-- /TPL-CURRENT01-TOOL-20261109 -->

<!-- FUSION-UX15-BUILD-EXIT-DISCOVERY-20261111 -->
## D-20261111-BUILD-INTERRUPT-ZERO 构建控制器中止后退出码可误写0（已确认工具缺陷）

UX15 为避开另一项活动构建而停止自身候选控制器后，`main-complete-types.log` 明确记录 `Session terminated, killing shell...`，但 `build-exit.txt` 为0。继承 `build-controller.sh` 仅在 EXIT trap 读取当前 `$?`，没有把 TERM 中止固定为非成功，因而该文件不能单独证明完整检查完成。原证在[本轮中止材料](../docs/materials/2026-11-08-character-fusion-prototype/implementation/ux15/interrupted-01/)。

本次完整类型没有报通过；尚无本次 main/guard build-success 与 source-pair 完整证明，后续发布仍被实际完整证明约束，未因退出码0切换线上。已完成的源码校验/私有Prisma准备可以按字节复用，被中止的类型检查须接续。发布引擎与另一任务均未修改；后续专项维护控制器时修正信号/退出记录，不能删除必要成品证明条件。本轮主任务继续，不扩大为发布工具重构。
本轮发布影响已关闭：最终 b2 正式版与 b034 兼容回退版均有同源完整类型/Next 成品、源对和启动检查，v0.145.0 已部署并通过服务/公网检查。未用中止退出码0作成功证明；工具自身信号记录问题仍待专项维护，未冒称已修复。
<!-- /FUSION-UX15-BUILD-EXIT-DISCOVERY-20261111 -->

<!-- FUSION-UX16-DOCUMENT-SWITCH-20261111 -->
## D-20261111-FUSION-DOCUMENT-SWITCH 首次重验的文档切换（待核线索）

1453真实LLM验收首次重验时，当前URL曾切到另外两份空的本人文档；当轮模型对不存在的第3条正确不写，原验收文档结果/设置保持。尚无原始点击/创建来源证据，不能断言自动新建缺陷或归因浏览器工具/人工操作。

后续显式核文档身份及界面就绪，记录点击和创建请求，两轮重载及成功的局部调整/新词抽卡未复现；最终9条刷新保持。保留原文档与观察，不删/改两份来源未定的文档、不为猜测加并发架构。后续单独核创建来源与触发；完整事实与私有原证见[原单UX16](todo/2026-11-08-character-fusion.md#fusion-ux16-live-acceptance)及[观察材料](../docs/materials/2026-11-08-character-fusion-prototype/implementation/ux16/document-switch-investigation.private.json)。

后续事实：限定nginx创建路由/时段已核15:10的7次新文档来自Windows Chrome157，而本次调试为Mac Chrome156，不能将这些创建定性为当前页自动创建。用户随后明确反馈新建/继续体验问题并要求输入常驻，本线索已并入[UX17实际修复与验收](todo/2026-11-08-character-fusion.md#fusion-ux17-persistent-documents)，当前按用户正常流程测通，不扩大为来源不明的后台清理。
UX17收口：v0.145.5按本轮用户授权完成实际新建A/B/C、A/B及C/B互切、独立草稿、讨论不抽卡、原话8条双语、继续只改单条、刷新和保存中停止。当前指定流程通过；不把这次结果倒推成旧URL切换的已知根因，不清理来源未定文档。详见原单UX17；本轮未新增范围外问题。

<!-- /FUSION-UX16-DOCUMENT-SWITCH-20261111 -->
<!-- FUSION-UX18-DISCOVERIES-20261111 -->
## D-20261111-FUSION-LOCAL-LINT 本机依赖缺口（已确认，待维护）

本次角色融合聚焦lint在本机工作区因缺原依赖debug无法启动；候选Linux相同源码的改动lint及完整Next成功，因此不是生产故障证明。本轮未安装或升级无关依赖，不扩大成仓库依赖清理；后续本机维护按原lock/现有安装核对。工程证据沿[UX18原单](todo/2026-11-08-character-fusion.md#fusion-ux18-eight-scenarios)和正式根私有`docs/materials/2026-11-08-character-fusion-prototype/implementation/ux18/followup01/evidence/main-focused-engineering.json`。

浏览器工具自有覆盖层挡鼠标、5分钟空闲关闭及一次测试脚本把键盘成功code=Enter误当报错均已区分工具/脚本与站点行为；原生同控件键盘继续、明确停止本人窗口，不更改共享工具或关闭用户Chrome。站点实际缺陷留原单修复/复测，不将这些路线观察记为额外站点Bug；未做全项目排查。

后续补证：本机完整tsc还缺dotenv/recharts/radix/dnd-kit等已有依赖，并带出相关页面隐式any，完整本机类型检查未通过；本次改动模块无类型报错。保留正式根ux18/local-engineering/local-complete-types-environment.log，不为通过检查安装/升级共享依赖或改动无关页面；最终必须由同源Linux正式候选完成完整类型检查。

最终补证：9eec/v0.145.9同源Linux完整类型exit0、改动lint与17组融合/完整Next通过；本机依赖缺失仍待独立维护，本轮不冒已修本机环境，也未新增范围外线上故障结论。
<!-- /FUSION-UX18-DISCOVERIES-20261111 -->


- **D-20261112-RELEASE-PROCESS-SCOPE｜待核线索，未改。** Ark受控传图发布准备复用既有pre-cutover时发现，含`/release-engine/`或`sd2-release-run.mjs`的命令行会统一按其他发布器阻止，未解析实际build/cutover动作。尚未证本轮被此条件阻止；最终须核实际健康基线与mutating controller，普通candidate build本身不占切版窗口，也不在未知CLI协议下放宽保护。源码及判断见[本轮原单](todo/2026-11-12-feedback-submit-rootcause.md)和本机私有ark-reference-transport01/deploy/pre-cutover.py。主任务按原发布入口继续，通用维护另核实际动作协议。
