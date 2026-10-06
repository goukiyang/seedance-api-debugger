# 生成过程耗时统计

项目：video-api-debugger（SD2视频创作平台）
正式入口：https://sd2.youdooart.com/admin
正式根目录：/Volumes/Data/Projects/video-api-debugger
有效来源：2026-10-06开工核对服务器c56c293b4afb69b5ef2cc4c7157a39a1010cd598、BUILD pzf9njsDB5Mh4qvdd_UFb，与v0.47.2源码相符；发布前重查。
实现工作区：/Users/gouki-youdoo/.codex/worktrees/generation-timing-20261006/video-api-debugger
分支：codex/generation-timing-20261006
状态：已部署v0.48.0，待用户手动验收
风险：只读统计与管理页面L2；不改生成、计费、权限、上传或数据库结构。
更新时间：2026-10-06，Asia/Shanghai

## 目标与范围

用户要求“我需要做生成过程需要多少时间？的统计功能。”统计等待耗时，不与视频内容秒数混用。复用管理中心日期范围、任务时间、CSV及现有视频交付统计计算，不安装监控系统。

| 编号 | 任务 | 完成标准 | 状态 |
|---|---|---|---|
| TIME1 | 生成耗时统计 | 能查看耗时、统计口径和样本数，缺失数据明确标注 | 进行中：实现与发布完成，实际数据效果待用户手动验收 |

- [x] 核对现有时间字段及视频交付统计脚本，锁定正式版本，隔离主对话工作区。
- [x] 补充普通视频、视频超分、图片的平均、中位用时（50%）、90%完成用时及最长耗时。
- [x] 补充结果可下载、接收保存及模型/线路拆分；缺记录不算零秒，不假造排队或纯模型耗时。
- [x] 最近视频任务展示耗时；CSV包含样本数与耗时；沿用管理员访问边界。
- [x] 统一发布必需检查、只读复核、聚焦提交推送，重查源码与发布窗口，保留回退。

## 口径与边界

起点为系统创建任务，不冒充本机点击或上传开始。成功视频到系统记录的生成完成时间（含状态回查延迟），图片到保存完成。可下载要求成功保存及对应时间，不用更新时间补造历史值。接收保存包含响应体接收、下载、校验、保存、可能的恢复及后补保存等待，不宣称纯模型时间。

各口径只用有效成功样本计算平均和分位（复用视频脚本最近秩方式）；失败/取消、未完成、缺失、时间逆序不混入。按创建日期归组；图片没有项目/视频清晰度，相关筛选不显示图片并注明。原始时间与导出保留精度。

不采集新提示词、签名URL或凭据，不外传，不读取.env，不改生产记录/schema，不发起付费生成。当前图片未持久记录线路，明细按模型，线路显示未记录。

## 验证、Git与回执

仅候选构建及内置类型/lint、代码与口径复核、版本/服务健康/静态资源检查；真实后台数据、日期切换、模型对照及CSV由用户手动验收。侧聊禁止子agent，由本对话复核，不声称独立审核或功能验收通过。

Git：独立分支只提交功能文件，推送origin，保留发布前回退标签。正式根已有脏记录不覆盖、不混入应用包。发布前源码变化先整合，不用旧版覆盖。

参考：已读scripts/video-delivery-metrics.ts；[Prometheus耗时统计](https://prometheus.io/docs/practices/histograms/)仅借鉴统计口径，不安装服务或复用外部代码。

已部署，待用户手动验收。旧记录缺分段时间是既有数据缺口，不回填或重发任务。

发布检查记录：本地共享依赖的Prisma类型文件落后，未改共享目录；在/tmp独立生成类型后全量tsc通过，专项lint通过。纯数据检查脚本已补，按项目默认手动验收规则未执行。首轮候选打包漏带既有ops目录，构建因scripts/credit-gateway-smoke.ts无法解析依赖而停止；属于本轮打包错误，不是既有业务代码故障。补齐相同提交的完整应用源包后重建通过，失败候选及日志保留。发布核对脚本补查Next共享文件后确认统计代码已打包，不改应用代码。

## 实际交付（2026-10-06 15:02，北京时间）

- 应用v0.48.0；实际发布提交ecbbc3258f4e89958f5bf55b2eae975904503b1d；BUILD F2D7ZkKByROZ0JjfpqvaX。入口为管理中心原日期范围下的“生成耗时”，支持任务完成、结果可下载、接收与保存三种口径，模型/线路明细及CSV；最近视频记录追加耗时。新口径和展开状态按账号保存。
- origin分支codex/generation-timing-20261006已推送；发布前rollback/2026-10-06-before-generation-timing-c56c293标签已推送，回退提交c56c293b4afb69b5ef2cc4c7157a39a1010cd598。正式根其他人的脏记录未混入功能提交。
- 候选构建及其内置类型/lint、86个静态页面构建通过。切换前843个源文件与原运行源一致，切换后847个源文件与本次发布源一致；新构建管理页JS/CSS及统计接口引用文件含预期实现。
- 公网15项发布检查通过：release/config/login及12个管理页静态资源；资源SHA与实际服务器构建一致。网站和图片worker均active，worker PID保持1043189，未重启；storage/uploads/videos原持久目录链接保持，未迁移数据库、未覆盖生产数据、无付费生成。
- 回退构建保留在/srv/video-api-debugger/app/.next-prod-prev-timing-ecbbc3258f4e（原BUILD pzf9njsDB5Mh4qvdd_UFb），原完整源码包保留。发布窗口已登记结束。服务器磁盘99%，余约2.1GiB；没有清理历史文件或扩大权限。
- 未执行浏览器、业务接口、纯数据smoke或付费功能验收；未确认真实账号/日期切换/CSV效果，未把发布检查说成功能验收。守门员：L2只读统计，手动效果缺口保留；无风险分级误判、无子agent。打包遗漏已纠正，留存失败证据。

实际文件及用途：src/lib/admin/generation-timing.ts（计算和样本规则）；src/lib/admin/generation-dashboard.ts（只读查询及整合）；src/app/admin/GenerationTimingPanel.tsx与.module.css（统计区及账号状态）；src/app/admin/AdminGenerationDashboardClient.tsx（接入和最近记录耗时）；src/app/api/admin/generation-dashboard/export/route.ts（导出）；scripts/generation-timing-smoke.ts（未执行的纯数据检查）；src/lib/release.ts、package.json及package-lock.json（单一发布信息/版本元数据）；本工单、tasks/todo.md及docs/materials/index.md（固定记录）。不改鉴权、计费、Provider、生成逻辑或数据结构，不新增依赖。

正式证据：无本轮新媒体附件。[统一源码diff](../../docs/materials/2026-10-06-generation-timing/source.diff)、[候选产物](../../docs/materials/2026-10-06-generation-timing/candidate-assets.json)、[实际运行产物](../../docs/materials/2026-10-06-generation-timing/runtime-assets.json)、[公网发布检查](../../docs/materials/2026-10-06-generation-timing/public.json)、[服务与回退](../../docs/materials/2026-10-06-generation-timing/delivery.json)、[失败构建日志](../../docs/materials/2026-10-06-generation-timing/attempt-1/build-server.log)、[成功构建日志](../../docs/materials/2026-10-06-generation-timing/attempt-2/build-server.log)可访问；关键源码diff对应确切提交，源包/回退包SHA及公网资源一致性已核，辅助日志不逐项hash。

下一步仅用户手动验收TIME1；历史字段缺失、图片线路未记录及纯模型/排队阶段缺独立时点不作造数，不宣称API线路速度已测准。
