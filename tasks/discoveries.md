<!-- BR-FEEDBACK02-20261105 -->
## BR-FEEDBACK02 反馈截图混入素材库（2026-11-06接续）

用户已授权的定向修复已部署：后端0.134.4/dd570及插件0.6.17，2026-11-06T10:23:47Z完成发布，待用户手验。补用途冻结、正常同字节素材保护及统一列表/计数过滤，原图不删；7组真实SQLite、原raw13项、反馈10项、目录回执8项、主/guard完整构建与公网资源/签名通过。发布探针误查不存在接口触发恢复，已由原批修正并在06成功切版，无数据回滚；本轮调度误判guard运行阶段也已按实际回执纠正。原证与边界沿[原反馈工单§12](todo/2026-11-02-plugin-feedback-entry.md#12-br-feedback02-反馈截图与素材目录隔离2026-11-05实施中)，不另起重复任务；未新增独立修复事项。
<!-- /BR-FEEDBACK02-20261105 -->

# 项目任务外发现报告

项目全名：video-api-debugger（sd2 视频生成API调试平台）
正式根：`/Volumes/Data/Projects/video-api-debugger`
建立日期：2026-11-01
规则：[额外发现与夜间维护](/Volumes/Data/CodexHome/rules/rule-sync-and-maintenance.md#额外发现与夜间维护)
处理线程：[半夜维修工登记](/Volumes/Data/CodexHome/tasks/night-maintenance.md)

本报告仅保存正常任务中额外发现的线索、问题及处理入口，不扩大原任务，不替代[固定todo](todo.md)或已有工单。本轮仅录入导航排查的额外线索，不表示已做全项目排查。

## 待核线索

| 编号 | 类别 / 优先级 | 事实、潜在影响与证据边界 | 来源与证据 | 状态 / 下一步 |
| --- | --- | --- | --- | --- |
| D-20261102-02 | 已确认机制、线上影响待核 / P2 | 网站反馈POST仅前端submittingRef防重，服务端每次新建Feedback；网络丢回执后重提可能形成多条反馈和多份通知。未查生产重复数，不能称已发生。 | [提交源码](https://github.com/goukiyang/seedance-api-debugger/blob/6629e540dadaa816d17e6784a904d24ec50262a1/src/app/api/feedback/route.ts)、[插件反馈工单](todo/2026-11-02-plugin-feedback-entry.md) | 插件新路径已设计同事务耐久提交回执，尚未实施；网站旧入口另行核影响与迁移，保旧行为，不在本轮工单阶段修代码。 |
| D-20261101-01 | 待核线索 / P2 | 生产构建已确认共享 Prisma 类导入桥；实际客户端实例数、跨 Next 路由 bundle 的展示缓存是否共用仍未知。可能重复建连接或重算菜单，不能认定已发生。 | [窄拓扑证据](../docs/materials/2026-11-01-admin-usage-read-snapshot/built-cache-topology.md)、[初始化](/Volumes/Data/Projects/video-api-debugger-worktrees/admin-usage-read-snapshot-reader-20261101/src/lib/prisma.ts) | 待核；需要时映射实际初始化与缓存身份，不先改 singleton / TTL，不加生产探针。 |

## 已确认问题

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

尚无关闭条目。总览只保留简短状态及链接；已关闭历史索引变长时按需移至 `discoveries/archive/`，保留可检索入口和原编号，不改写历史结论。

## 记录约定

- 新项使用项目内稳定编号，如 `D-20261101-01`；同根因或同对象的新证据更新原编号，不重复建单。
- 各分区条目使用“编号、类别、影响/优先级、简述、来源与证据、状态、详情链接”的短表格；明确事实与待验证假设。
- 短线索就地记录；较长调查与方案放 `discoveries/<编号>.md`。已有工单或附件直接链接，不复制长文、私有媒体或凭据；没有实际详情时不造空文件。
- 详情按需保存现象、证据、影响、根因/假设、候选方案与推荐、确认状态、实施及验证/恢复结果。状态区分待核、待处理、待确认、处理中、受阻、已修待手验、已关闭。
- 小修沿既有授权及项目工程检查执行；结构性、大范围及影响不明事项先出方案等用户确认。功能验收仍由用户手动完成，不以构建、推送或健康检查冒充通过。

- **D-20261104-TEMPLATE-MARK-LIST-SCALE｜个人收藏列表先全量解析再分页｜待核线索 / P3**：`/api/content-reactions` 的模板组织列表沿 `listReactions` 先读取本账号全部有效标记，逐条 `resolveReactionContent` 后再截取页；分组统计也读本账号模板标记。实现事实已核，当前收藏数量、请求耗时和瓶颈未测，不能判成已发生的性能故障，也不把它归因于本次统一标记。CP01/ARCH03封面目录的有限SQL分页仍保留。本轮不扩为重构；后续如列表卡顿，先固定真实账号、标记量、权限条件，测一次请求耗时/查询数，再决定是否将组织列表接入相同授权投影与分页，不能先分页后漏权限/搜索结果。来源：TEMPLATE-MARK01，`src/lib/content-reactions/service.ts:listReactions`、`template-favorites.ts:favoriteOrganization`；未做浏览器或生产规模测试。
