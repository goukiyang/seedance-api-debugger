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
| D-20261102-02 | 已部署，待用户手验；历史影响未核 / P2 | 旧入口缺少耐久提交回执，丢响应后可能重复建反馈/通知。网站新版Widget与插件已统一冻结输入和原号回执；旧无编号请求维持兼容，旧页面需刷新。 | [原提交源码](https://github.com/goukiyang/seedance-api-debugger/blob/6629e540dadaa816d17e6784a904d24ec50262a1/src/app/api/feedback/route.ts)、[R02实施与证据](todo/2026-11-02-plugin-feedback-entry.md#11-r02-实施与发布接续2026-11-02) | 后端ba7/v0.128.0已保护部署，插件980/v0.4.0已签名发布；10组单元与8项真实SQLite证明防重/回放/原子回滚，guard保读及回放并关闭新建。A01–A10用户手验，历史重复数量未核、不删历史；勿另起重复修复。 |
| D-20261101-01 | 待核线索 / P2 | 生产构建已确认共享 Prisma 类导入桥；实际客户端实例数、跨 Next 路由 bundle 的展示缓存是否共用仍未知。可能重复建连接或重算菜单，不能认定已发生。 | [窄拓扑证据](../docs/materials/2026-11-01-admin-usage-read-snapshot/built-cache-topology.md)、[初始化](/Volumes/Data/Projects/video-api-debugger-worktrees/admin-usage-read-snapshot-reader-20261101/src/lib/prisma.ts) | 待核；需要时映射实际初始化与缓存身份，不先改 singleton / TTL，不加生产探针。 |

## 已确认问题

尚无录入条目。

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
| D-20261102-03 | 工具线索 / P3；本工作树已刷新，增量根因待核 | 插件CodeGraph普通sync/index返回Already up to date，但status仍报8个modified，handleFeedback索引126行与实际134行不符。非业务运行问题，未用旧图指导后续改码。 | 实际worktree `.worktrees/sd2b-integration`；CodeGraph CLI context/status与源码行号；[本轮工单](todo/2026-11-02-plugin-feedback-entry.md) | 已对该本地索引执行force重建，CLI确认storageUpdate:8/handleFeedback:134、78文件/664节点且up-to-date。未改CodeGraph工具源码或全局配置；再次出现时单列核索引增量/适配输入，不阻塞已发布反馈功能。 |
