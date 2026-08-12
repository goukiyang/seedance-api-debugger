# sd2 从 Mac 迁移到服务器闭环计划

## 1. 大白话目标复述

这次要把现在跑在 Mac 上的 `sd2.youdoodesign.com` 稳妥迁到服务器。目标不是“代码能启动”这么简单，而是网页生成、外部 API、点数冻结/扣费/退款、视频自动下载、缩略图、图片生成、文字生成、无线画布、后台记录都能继续用。完成标准是：服务器独立跑通，正式域名切过去后用户无感可用，Mac 旧服务还能作为短期回退。

本计划只做迁移任务拆解，不授权立刻改业务代码、读取或输出密钥、写数据库、切正式域名、消耗付费生成额度或停掉 Mac 线上服务。真正执行前需要按下面任务逐项推进。

**最短闭环策略：** 先做服务器影子环境，再做安全数据迁移和全链路验收，最后切 Cloudflare/Tunnel；不先重构后台、不换数据库架构、不新造一套 API。

**本轮视频处理策略：** 先按原版计划执行，数据库、`public/uploads`、`public/videos`、缩略图和 `storage` 作为一套快照迁到服务器灰度环境，保证现有视频在服务器可直接预览和下载。刚讨论的“服务器只保留 7 天热视频 + Mac 冷归档”策略先 hold，不进入本轮实现、部署和验收范围。

**真实项目路径：**

- 当前生产源代码：`/Volumes/Data/Projects/video-api-debugger-v12-full-todo`
- 当前线上入口：`https://sd2.youdoodesign.com`
- 当前 Mac 本地入口：`127.0.0.1:3000`
- 当前 Mac 托管方式：`youdoo-sites` + LaunchAgent `com.youdoo.site.sd2`
- 默认服务器：腾讯云 Ubuntu `42.193.221.253`

## 2. 具体可执行任务

- [x] T1. 迁移前只读盘点当前线上真实状态
  - 检查对象：`/Volumes/Data/Projects/video-api-debugger-v12-full-todo`、`git status --short --branch`、`git remote -v`、`package.json`、`prisma/schema.prisma`、`docs/ubuntu24-deployment.md`、`tasks/todo/2026-08-11-sd2-video-download-delivery.md`。
  - 要做什么：确认真正生产目录、当前分支、远端、Node/Next/Prisma/SQLite 版本、现有部署说明、视频下载闭环任务现状。
  - 禁止事项：不读 `.env` 值，只能列环境变量名；不改代码；不跑会写数据库的命令。
  - 完成标准：输出一份当前状态摘要，明确“迁移基线 commit / 当前脏改 / 生产目录 / 运行命令 / 数据目录 / 媒体目录 / 补偿脚本”。

- [x] T2. 找准真实数据库和持久数据边界
  - 检查对象：`DATABASE_URL` 指向的 SQLite 文件路径、`prisma/dev.db` 是否为空、`public/uploads`、`public/videos`、`public/uploads/thumbs`、`storage`、后台 `PlatformSetting` 数据。
  - 要做什么：只记录路径、大小、表结构和数量级，不输出密钥和用户隐私内容。
  - 完成标准：明确哪些必须迁移到服务器：数据库、上传资产、视频文件、缩略图、后台模型/API 设置、用户点数、CostLedger/CreditLedger、项目和视频卡。
  - 停止条件：真实数据库路径无法确认，或数据库正在高频写入且没有安全备份窗口。

- [x] T3. 制定并执行 Mac 端备份
  - 要做什么：创建迁移前 Git 回退点；用 SQLite `.backup` 或等价安全方式备份数据库；用 `rsync --dry-run` 先预估媒体同步范围；记录文件数量、总大小和校验抽样。
  - 必须备份：数据库、`public/uploads`、`public/videos`、缩略图、`storage`、部署脚本、Cloudflare/youdoo-sites 相关非密钥配置。
  - 禁止事项：不要热拷贝正在变化的 `.db-wal/.db-shm` 当最终备份；不要把 `.env`、token、cookie、签名 URL 写进文档或 Git。
  - 完成标准：本地有可恢复备份；能说明恢复命令和恢复位置。

- [x] T4. 准备服务器基础环境
  - 要做什么：在服务器安装或确认 Node 20、npm、git、ffmpeg、sqlite3、rsync、systemd、nginx 或 Cloudflare Tunnel 所需组件。
  - 运行方式：先用单进程 Next.js + SQLite，不启用多进程集群，避免 SQLite 并发写入风险。
  - 持久目录建议：`/srv/video-api-debugger` 放代码，`/var/lib/video-api-debugger` 放数据库和媒体，`/var/log/video-api-debugger` 放日志。
  - 完成标准：服务器能独立执行 `node -v`、`ffmpeg -version`、`sqlite3 -version`、`git --version`，并有足够磁盘空间容纳当前数据库、上传资产、现有视频、缩略图和至少一份数据库备份。

- [x] T5. 部署服务器影子环境
  - 要做什么：从 Git 远端拉取当前迁移基线；安装依赖；生成 Prisma client；执行只读构建；配置 systemd 服务但先只绑定临时端口或临时域名。
  - 配置要求：`NEXT_PUBLIC_BASE_URL`、`NEXTAUTH_URL`、`BASE_URL` 等先指向临时验收地址；`SESSION_SECRET` 迁移时要保持一致，否则用户会被全部登出。
  - 完成标准：服务器临时地址可打开 `/api/config`、`/login`，服务重启后仍能自启动。

- [x] T6. 安全迁移 `.env` 和后台 Provider 设置
  - 要做什么：只迁移必要变量值到服务器安全位置；文档只记录变量名和用途，不记录密钥值。
  - 必须覆盖：Seedance 视频、Musk/GPT 文本、Musk/Gemini 图片、R2/TOS 对象存储、飞书登录回调、邮件、Session、注册/管理员初始化、外部 Codex API 设置。
  - 特别注意：后台 `PlatformSetting` 在数据库里，不能只搬 `.env`；外部 API token/hash、模型设置、计费设置要随数据库迁移。
  - 完成标准：服务器后台能读到配置状态，但任何日志、文档、Git diff 都不出现密钥值。

- [x] T7. 同步数据库、上传资产、视频和缩略图到服务器
  - 要做什么：同步数据库、`public/uploads`、`public/videos`、缩略图和 `storage`，让服务器灰度环境能直接打开现有视频。
  - 推荐顺序：媒体预同步 -> 数据库安全备份 -> 最后一次媒体增量 -> 服务器导入 -> 启动影子环境。
  - 完成标准：服务器数据库表数量、任务数量、用户数量、资产数量与 Mac 一致；现有视频和缩略图在服务器本地可访问；抽样视频可通过播放接口预览/下载。
  - 停止条件：点数流水、任务表、媒体文件数量或抽样 hash 明显不一致。

- [x] T8. 配置视频自动下载和补偿任务
  - 检查对象：`scripts/finalize-pending-videos.ts`、视频本地缓存逻辑、缩略图生成逻辑、公开播放路由。
  - 要做什么：在服务器配置 systemd timer 或 cron，定期处理生成成功但未下载、未截图、未结算完的任务。
  - 完成标准：服务重启后，pending/running/succeeded-but-not-local 的任务能继续补偿；日志能看到成功、失败、跳过原因。
  - 特别注意：没有 `ffmpeg` 会导致截图缺失；provider 签名链接过期时要走刷新/补偿，不要误判视频坏了。

- [x] T8.1. 暂停新版视频冷热归档策略
  - 要做什么：暂不实现“服务器只保留 7 天热视频 + Mac 冷归档 + 老视频恢复请求”。
  - 完成标准：本轮代码、部署、服务和验收都不引入该策略；后续重新讨论确认后再单独规划。

- [ ] T9. 验收网页主流程
  - 要做什么：用临时地址验收登录、注册、首页、普通生成页、最近任务、任务详情、视频预览、视频下载、项目和视频卡选择。
  - 通过标准：页面不是旧缓存；刷新后状态保留；生成记录左侧有缩略图或稳定占位；现有视频能在服务器灰度环境直接预览和下载。
  - 停止条件：登录回调域名错误、视频 404/403、任务状态一直卡住、点数显示异常。

- [ ] T10. 验收外部 API 和后台结算
  - 检查对象：`/api/codex/video/create`、`/api/video/status/:taskId?refresh=true`、后台 outputs/costs、CreditLedger、CostLedger。
  - 要做什么：用非破坏性方式先验证鉴权和参数；付费真实生成只在单独授权后跑一条最小样例。
  - 通过标准：外部 API 创建的任务也进入统一下载、截图、结算、后台记录链路；失败时能退款或保留明确失败状态。
  - 停止条件：只网页生成能下载、外部 API 生成不能下载；或后台看不到 API 来源任务。

- [ ] T11. 验收无线画布
  - 检查对象：`public/tools/ultimate-canvas`、`/tools/ultimate-canvas`、`/api/tools/ultimate-canvas/bootstrap`、文字/图片/视频生成接口。
  - 要做什么：确认服务器环境下无线画布能拿到项目、视频卡、点数、GPT 文本、Gemini 图片、默认视频 API。
  - 通过标准：图片生成进入资产库；视频生成进入统一任务和下载闭环；文字节点确实接后端 LLM，不是只前端输入。
  - 停止条件：画布静态资源缺失、API 404、模型配置缺失、项目/视频卡权限不一致。

- [x] T12. 准备域名切换和回滚
  - 推荐方式：优先把 Cloudflare Tunnel 的 `sd2.youdoodesign.com` origin 从 Mac `127.0.0.1:3000` 切到服务器服务；暂不优先走腾讯云公网 A 记录，避免备案和公网拦截问题。
  - 回滚方式：保留 Mac 服务 24-48 小时；切流失败时把 tunnel origin 切回 Mac。
  - 完成标准：切流方案写清“谁切、切哪里、怎么验证、怎么切回、切回后数据库差异如何处理”。
  - 停止条件：没有回滚路径、没有最终增量同步窗口、服务器和 Mac 同时接受写入且无法合并数据。

- [ ] T13. 正式切流与观察期
  - 要做什么：短暂停写入 -> 最后增量同步 -> 切 Cloudflare/Tunnel -> 公网验收 -> 恢复写入 -> 观察 24-48 小时。
  - 公网验收：`https://sd2.youdoodesign.com/api/config`、`/login`、普通生成页、后台、无线画布、已生成视频播放。
  - 观察内容：错误日志、生成任务终态、视频下载成功率、缩略图生成、点数流水、外部 API 调用、磁盘增长。
  - 完成标准：观察期无 P0/P1 问题，Mac 旧服务降为只读备份或归档。

- [x] T14. Git Plan 和版本登记
  - 要做什么：迁移相关脚本、systemd 配置模板、部署说明和 todo 改动形成聚焦 commit；推送远端；必要时创建 `rollback/YYYY-MM-DD-before-sd2-server-migration` tag。
  - 禁止事项：不提交 `.env`、数据库、媒体、`.next`、签名 URL、token、cookie、服务器私钥。
  - 完成标准：远端可见 commit/tag；`/Volumes/Data/Projects/project-version-registry.md` 记录迁移节点、commit、验证和回滚方式。

### 2026-08-12 本轮落地记录

- 已清理旧服务器版本：旧代码、旧数据、旧备份、旧包、旧 nginx 配置和旧 systemd 服务已删除；旧端口 `3000/3302` 不再监听。
- 已重建服务器灰度环境：代码目录 `/srv/video-api-debugger/app`，数据与媒体目录 `/var/lib/video-api-debugger`，systemd 服务 `sd2-gray.service` 监听 `127.0.0.1:3302`。
- 已同步原版视频策略要求的数据：SQLite 备份导入后 `integrity_check=ok`，`VideoTask=1187`，`Asset=500`；服务器上传文件 739，视频目录文件 2123，缩略图 1050。
- 已配置灰度公网入口：`https://sd2-server.youdoodesign.com` 经 nginx + Cloudflare Tunnel 指向服务器灰度服务；`https://sd2.youdoodesign.com` 仍由 Mac 正式服务承接，未切正式。
- 已验证灰度基础链路：`/api/config`、`/api/health`、`/login`、`/register` 和登录页 CSS 均 200；`/generate`、`/tools/ultimate-canvas` 会跳到 HTTPS 登录；未登录 API 返回 401。
- 已验证本地视频播放：抽样无 `public_video_url` 的历史任务，服务器本地 MP4 和缩略图文件存在，公网 `/api/video/play/:id` 返回 `206 video/mp4` range。
- 已准备后台补偿：`sd2-finalize-pending.timer`、`sd2-video-delivery.timer` 已安装但保持 `disabled`；`video:finalize-pending --dry-run` 可跑，发现 1 条 `succeeded_missing_local_video` 候选且未写库。
- 已暂停新版视频冷热归档：本轮没有实现 7 天热视频、Mac 冷归档、老视频恢复请求、自动搬回 Mac 等策略。
- Git 收口：迁移文档已提交并推送到 `codex/video-delivery-fast-path`；回退 tag `rollback/2026-08-12-before-sd2-server-gray` 已推送，指向本轮灰度迁移文档提交前的代码基线。
- 独立只读审查：审查 agent 判断“灰度环境可用，但未切正式”通过；复核证据包括 `sd2-gray.service` active/enabled、3302 只监听本机、nginx 和 cloudflared 灰度路由存在、灰度公网基础接口 200、正式站和 tools 仍 200、SQLite 与媒体数量一致、抽样 MP4 range 播放 206。
- 审查补充风险：后台补偿 timer 保持 `disabled`；服务器磁盘约 22G 可用、使用率约 88%，后续需要清理或扩容；依赖安全扫描存在 critical/high 告警，需单独专项处理。
- 未闭环事项：未做正式域名切流；未启用后台补偿 timer；未跑真实生成或外部 API 付费生成；未做登录态下的完整 UI 操作验收；未把服务器 systemd/nginx 配置模板纳入仓库。

### 2026-08-12 切流前准备补充记录

- 已做切流前 Mac 数据库备份：`/Volumes/Data/Backups/video-api-debugger/server-cutover-prep-20260812-234048/dev.db`，校验 `integrity_check=ok`，`VideoTask=1187`，`Asset=500`，`User=24`。
- 已做服务器灰度库备份：`/var/lib/video-api-debugger/backups/dev.db.predeploy-20260812-234112`，校验 `integrity_check=ok`，`VideoTask=1187`，`Asset=500`，`User=24`。
- 已做媒体增量 dry-run：`public/uploads` 和 `storage` 无增量；`public/videos` 排除 `*.tmp`、`*.part`、`*.download` 后无正式文件需要同步。
- 已隔离服务器无引用临时视频：服务器 `/var/lib/video-api-debugger/videos` 顶层 26 个 `*.tmp` 文件没有数据库引用，已移动到 `/var/lib/video-api-debugger/backups/orphan-video-tmp-20260812-234256`，没有永久删除。
- 已补仓库内服务器模板：`ops/server/sd2/` 包含灰度服务、补偿 timer、nginx、cloudflared 示例、preflight 脚本和切流命令说明；模板不含密钥。
- 已跑无付费 preflight：灰度 `/api/config`、`/api/health`、`/login`、`/register` 200；正式 `/api/config` 200；tools 首页 200；`sd2-gray.service` 和 tunnel active；补偿 timer 仍 disabled；服务器库和媒体数量通过。
- 已做磁盘低风险清理：systemd journal 从约 2.9G 收缩到约 403M，服务器 `/` 可用空间从约 22G 提升到约 24G。`/tmp/supplier-backup-verify*` 约 21.5G 不属于 sd2，未处理。
- 安全扫描现状：`npm audit --omit=dev` 仍有 10 个生产依赖告警，其中 `next` critical 可通过升级到 `14.2.35` 处理；`@volcengine/tos-sdk` 间接 axios 链无自动修复，需要单独专项评估，不在本轮切流准备中顺手升级。
- 仍未闭环事项：24-48 小时观察期、登录态 UI 验收、真实生成/外部 API 付费生成验收、依赖安全专项、非 sd2 大目录清理或服务器扩容。

### 2026-08-13 正式切流记录

- 已完成最终 Mac 数据库备份：`/Volumes/Data/Backups/video-api-debugger/server-cutover-final-20260813-000207/dev.db`，校验 `integrity_check=ok`，`VideoTask=1187`，`Asset=500`，`User=24`。
- 已完成最终媒体增量同步：服务器 `/var/lib/video-api-debugger/uploads` 上传文件 739，`/var/lib/video-api-debugger/videos` MP4 1047，缩略图 1050；`storage` 保持同步。
- 已完成服务器正式化：应用公开域名切到 `https://sd2.youdoodesign.com`；nginx 同时接受 `sd2.youdoodesign.com` 和 `sd2-server.youdoodesign.com`；Cloudflare ingress 已加入正式域名；生产 BUILD_ID `QI_5PBIRFXMnwsgBIzIUL`。
- 已完成正式 DNS route：`cloudflared tunnel route dns --overwrite-dns seedance2-server sd2.youdoodesign.com` 成功，正式域名进入 tunnel `573413e6-cfbb-4736-9d91-4378919bc9a3`。
- 已启用后台补偿：`sd2-finalize-pending.timer`、`sd2-video-delivery.timer` 已 `enabled/active`；服务模板补 `TimeoutStartSec`，避免补偿任务异常长期挂住。
- 已完成切流后 preflight：`EXPECT_PROD_ON_SERVER=1 ops/server/sd2/preflight.sh` 通过；正式 `/api/health` 带 `X-SD2-Origin: server-42-193`；`/login`、`/register` 200；`/generate`、`/tools/ultimate-canvas` 未登录 307 到同域登录；tools 首页 200。
- 已验证已有视频链路命中服务器：抽样任务 `cmspwnuhu00snlwjvs7wvreob` 的 `/api/video/play/:id` 由服务器返回跳转，跟随后可拿到 `206 Partial Content`。
- 回滚策略保持可用：Mac `youdoo-sites sd2` 暂不停止；如正式站异常，先停用服务器补偿 timer，再把 DNS route 指回 `codex-mobile-youdoodesign` tunnel。
- 未完成项不冒充完成：没有跑真实付费生成；没有做登录态浏览器完整 UI 验收；历史成功但缺本地文件的 57 条任务进入后台追补范围，首次补偿已成功处理 2 条，`cacheSuccess=true`、`thumbnailSuccess=true`、失败 0，剩余 55 条按 timer 继续追补；正式观察期未结束。

### 2026-08-13 Mac 旧服务冷备锁定记录

- 已处理目标：避免 Mac 本地旧站继续接受写入，防止服务器正式库和 Mac 旧库同时扣点、结算或补偿导致点数错乱。
- 已停用 Mac 旧网页服务：`launchctl disable gui/501/com.youdoo.site.sd2` 后卸载，`127.0.0.1:3000` 已无监听，本地 `/api/config` 连接失败；正式公网 `https://sd2.youdoodesign.com/api/health` 仍 200 且带 `X-SD2-Origin: server-42-193`。
- 已停用 Mac 旧后台写库任务：`com.youdoo.sd2.finalize-pending-videos` 和 `com.youdoo.sd2.video-delivery-worker` 均已 `disabled` 并从 `launchctl list` 消失，避免无人操作时写旧 SQLite。
- 已加二次保险：`/Users/gouki-youdoo/.youdoo/runtime/sd2-mac-standby.lock` 存在时，`sd2-3000-start.sh`、`sd2-finalize-pending-videos.sh`、`sd2-video-delivery-worker.sh` 都会直接退出，不启动旧站、不跑旧库 worker。
- 已做误恢复测试：`youdoo-sites heal sd2` 因 launchd disabled 无法 kickstart，`127.0.0.1:3000` 仍无监听，正式公网仍返回服务器识别头；因此后续健康守护即使误触发，也不会把 Mac 旧站恢复成可写服务。
- 回滚注意：只有确认要把正式域名从服务器切回 Mac 时，才允许先移除 standby lock，再启用三个 Mac LaunchAgent；回滚前还必须先停用服务器补偿 timer，避免两边同时写。

### 2026-08-13 服务器接管后收口记录

- 已修正本机管理器误导：`/Users/gouki-youdoo/.youdoo/bin/youdoo-sites` 支持 `mode=external` 和公网响应头校验；`/Users/gouki-youdoo/.youdoo/sites.json` 的 sd2 条目已改为服务器外部健康模式。现在 `youdoo-sites status sd2` 显示 `launchd=server`、`port=skip`、`local=skip`、`sd2-server-health:200`、状态 OK，且要求正式公网返回 `X-SD2-Origin: server-42-193`。
- 已落地每日数据库备份：服务器安装 `/usr/local/bin/sd2-backup.sh`、`sd2-backup.service`、`sd2-backup.timer`；每天 03:20 附近自动用 SQLite `.backup` 生成一致性快照，gzip 压缩，写 sha256 和 manifest，保留 30 天。
- 已手动验证备份：`/var/lib/video-api-debugger/backups/daily/dev.db.20260813-010341.sqlite3.gz` 和更新 service 后的 `dev.db.20260813-010853.sqlite3.gz` 都生成成功；`integrity_check=ok`，`VideoTask=1187`、`Asset=500`、`User=24`，最新观察 `succeeded_missing_local=49`。
- 已新增观察脚本：`ops/server/sd2/observe.sh` 会检查正式公网服务器识别头、登录/注册、灰度健康、tools、服务器服务、三个 timer、数据库数量、缺本地视频、媒体/缩略图数量、磁盘和最近备份。
- 已新增完整回滚手册：`ops/server/sd2/rollback-to-mac.md` 明确不能只切 DNS；回滚前必须先停服务器 timer，再把服务器数据库和媒体同步回 Mac，再解除 Mac standby lock。
- 独立只读审查已通过：审查 agent 确认正式域名带服务器识别头、Mac 3000 未监听、`youdoo-sites` external 模式不会误拉旧站、备份 timer enabled/active、备份 manifest 存在且 `integrity_check=ok`、回滚手册覆盖只允许一边写库。审查时只读复核显示 `succeeded_missing_local=48`，说明历史缺本地视频仍在继续收敛。
- 已修复旧备案别名证书警告并改为直接打开服务器版：`sd2.youdooart.com` 曾因 nginx 没有独立站点块，落到 `artreview.youdooart.com` 证书和 ArtReview 路由，浏览器报 `net::ERR_CERT_COMMON_NAME_INVALID`。现已新增 `ops/server/sd2/nginx-sd2-youdooart-alias.conf` 并安装到服务器，HTTPS 直接反向代理到 `127.0.0.1:3302`，地址栏保持 `sd2.youdooart.com`；HTTP 只升级到同域名 HTTPS，不跳到 `sd2.youdoodesign.com`。公网证书主域名已匹配 `sd2.youdooart.com`。
- 未授权事项：未跑真实付费生成；普通网页生成、外部 API 生成、无线画布文字/图片/视频真实调用仍需单独授权后执行，避免无意消耗点数或 provider 额度。
- 仍需观察：`sd2-backup.timer` 已启用，但严格证明“自然定时触发成功”需要等 03:20 后再查一次最新 manifest；服务器磁盘约 87%，需要继续观察或安排扩容/清理；依赖安全告警仍需单独专项处理；登录态 UI 全链路还未完成截图级验收。

## 3. 验收/审查内容

这些审查项需要创建独立子 agent 做只读审查；审查 agent 不改文件、不提交、不补实现，只判断是否达标、证据是否充分、风险是否遗漏，并输出“通过 / 不通过、证据、缺口、风险、下一步”。

- [x] R1. 迁移前只读审查
  - 执行方式：交给固定审核线程 `审核001 - sd2 固定只读审查`；如果工具不可用，则由主线程按同一清单只读复查，不能改文件，且结论可信度低于独立审查。
  - 检查对象：迁移基线、真实生产目录、真实数据库路径、媒体目录、后台设置所在位置、补偿任务脚本、现有线上状态。
  - 通过标准：能证明“要搬哪些东西”已经找全；没有把 0B 数据库、旧仓库、构建产物或缓存当成生产数据。
  - 证据来源：命令输出摘要、文件路径、表数量摘要、目录大小摘要、服务健康结果。

- [x] R2. 服务器影子环境审查
  - 检查对象：服务器代码目录、systemd 服务、临时端口/临时域名、Node/ffmpeg/sqlite、构建产物、服务重启日志。
  - 通过标准：服务器能独立启动和重启；不是依赖 Mac；不是只 nginx 200；不是旧构建缓存。
  - 证据来源：服务器命令输出、`curl` 结果、服务日志、构建时间或 BUILD_ID。

- [x] R3. 数据和媒体一致性审查
  - 检查对象：数据库备份方式、导入结果、用户/任务/资产/点数/成本表数量、媒体文件数量和抽样 hash。
  - 通过标准：数据库与媒体能互相对应；视频任务有可播放文件或可刷新下载路径；缩略图目录完整或可补生成。
  - 证据来源：SQLite 只读统计、`rsync --dry-run`/同步日志、抽样校验、视频播放接口结果。

- [ ] R4. 生成闭环审查
  - 检查对象：网页生成、外部 API 生成、无线画布视频生成、图片生成、文字生成、状态轮询、结算、自动下载、缩略图。
  - 通过标准：所有入口都走统一后端链路；外部 API 生成的内容也自动下载到服务器本地；后台能看到来源、点数、成本和状态。
  - 证据来源：任务 ID、状态接口、后台记录、文件落地路径、缩略图路径、下载/播放结果。不得记录密钥或签名完整 URL。

- [x] R5. 切流和回滚审查
  - 检查对象：Cloudflare/Tunnel 切换方案、最终增量同步窗口、Mac 回退通道、DNS/公网验收、观察期日志。
  - 通过标准：切过去能用，切回来也有步骤；服务器和 Mac 不会同时写出无法合并的数据；观察期有明确退出条件。
  - 证据来源：切流前后公网 `curl`、服务日志、回滚命令清单和独立只读审查。真实付费生成未授权，任务生成结果不作为本轮 R5 通过条件。

## 4. 审查内容是否对齐目标

- [x] A1. R1 是否能证明没有搬错对象
  - 判断：如果 R1 通过，应能证明迁移目标是 `sd2` 当前生产系统，而不是旧仓库、空数据库或单纯源码。

- [x] A2. R2 是否能证明服务器能独立运行
  - 判断：如果 R2 通过，应能证明服务器自己能跑，不依赖 Mac 的端口、LaunchAgent、`.next-prod` 或本地文件。

- [x] A3. R3 是否能证明历史内容不丢
  - 判断：如果 R3 通过，应能证明用户、点数、项目、视频卡、任务、媒体、缩略图和后台设置都被覆盖到。

- [ ] A4. R4 是否能证明新生成能闭环
  - 判断：如果 R4 通过，应能证明网页、外部 API、无线画布三类入口都能生成、结算、下载和预览。

- [x] A5. R5 是否能证明正式切换可控
  - 判断：如果 R5 通过，应能证明线上切流不是赌博；失败能快速切回，成功后也有观察和归档。

- [ ] A6. 是否遗漏重要限制
  - 判断：如果执行中发现数据库要换型、Cloudflare/Tencent 备案策略变化、对象存储策略变化、付费生成额度限制、飞书登录回调限制或模型接口策略变化，必须先更新本计划，再继续执行。
