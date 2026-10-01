# 图片生成下载超时与结果找回

来源：2026-10-01 用户反馈及同名原工单（旧开发树提交 `084743a`）。正式入口 https://sd2.youdooart.com/template-studio 。在保留正式 v0.31.0 全部功能的生产工作树实施，不部署旧 `codex/gpt-image-studio` 分支。

| 编号 | 任务 | 完成标准 | 状态 |
|---|---|---|---|
| D1 | 原图恢复与超时排查 | 明确可否找回、慢速原因、积分及上游费用证据 | 受阻；下载断点与退款已确认，原图及链路需上游后台会话；对应 T1/T2 |
| D2 | 防复发与交付 | 在授权范围内处理，说明代码、部署及待验事项 | 进行中；v0.31.1 已部署，真实源站续传适配未闭环；对应 T3/T4 |

## 现有证据和限制

- 原任务 `90484fcde8dc4dde69415fb734d328bff1ce4d116ced289151166f73f2ea4563-0`，2026-10-01 13:35:37 北京时间结束。原工单只读证据：HTTP 200，下载 1,179,648 / 4,752,867 字节后触发 180,011ms 总时限；当天另一例为 12,189,696 / 12,235,926 字节。状态 uncertain，无 asset_id；站内冻结 -20/退款 +20。provider_cost_usd 仅估算，不是上游账单。
- 本轮重新核对实际 provider/media/worker：旧实现只在内存保存 URL 和分片；180 秒时限到达即丢失恢复信息。只能证明下载低速/停顿后触发总时限，不能据此认定是图片托管端、CDN 或本站网络出口。
- 旧任务没有已持久化 URL 或完整图片，本站无法直接恢复。未发起付费重试、第三方支持消息、生产资产覆盖或历史账本修改。原截图没有可复制本地原件，不能声称已归档。
- T1 上游查询未完成：BrowserSkill 未列出用户页签，CUA 两次初始化超时；Chrome 只读页签查询出现连接无效。未获得可信的上游后台会话，未读凭据、未改权限。公开主页 https://api.muskapis.com 需要 JavaScript，公开搜索未找到可核实的原图查询接口。仍需在上游已登录后台核查原请求；不能将没有查到等同于上游已删除。
- T2 原因边界已确定，历史任务缺少下载主机与进度曲线，不能重建实际域名吞吐和有效期。新代码仅记主机、阶段、字节、时间、状态，不记签名链接。
- 单独运行的 `sd2-image-studio.service` 在本轮前仍为 09-30 启动的长驻进程。后续图片 worker 修改必须单独安全排空、重启并验证，网页服务重启不代表图片 worker 生效。

## 实施与检查计划

- T3：同一 URL 受限落盘（storage/studio-delivery，目录 0700 / 文件 0600），分片流式写入、强 ETag + If-Range 续传。服务器忽略 Range 则从头下载原 URL；无有效校验标记不拼接。单次 180 秒、最多 6 次、30 分钟恢复期限，终态清理、孤立临时文件一天清理。引用图 20MB、生成图 96MB 与逐跳 DNS/SSRF 防护不变。
- 仅持有原任务租约者交付/结算；中间恢复不退还/重复冻结积分，终态沿用原结算事务。重启恢复直接进入下载，不读取参考图或调用生成。无恢复记录仍标记未交付并退款。
- T4：整批实现后统一执行离线慢速、接近完成断流、超时、Range、过期、重启、租约和单次结算检查，使用全新临时库与合成图片，不调用付费 API。随后候选构建、Git/回退点、服务器与公网发布检查。UI 功能由用户手动验收。
- 风险按 L4（付费结果、资产、积分及 SSRF）处理；自动守门员给出的 L3 不作为实际降级依据。不改生产数据库结构、密钥、鉴权或旧任务数据，不安装依赖。
- 参考已读取的 [Got 流式下载源码](https://github.com/sindresorhus/got/blob/main/source/core/index.ts)：独立超时、流读取及受控重试。复用现有 Node HTTPS 逐跳 DNS 校验，不引入 Got 或新增依赖。

## 实现与离线检查

- v0.31.1 已实现 T3。`delivery.ts` 管理受限临时文件、期限、续传和清理；`media.ts` 共享逐跳安全下载；`provider.ts` 先保存链接再交付；`worker.ts` 与 `tasks.ts` 负责仅下载恢复、租约和幂等结算。成功后清除恢复中提示。
- `scripts/process-image-studio.ts` 增加排空标记检查；对应 systemd 配置的停止等待改为 660 秒，覆盖现有 480 秒任务上限并留结算时间。发布前核对服务器 unit 与现有源码完全相同，切换时等待旧进程自行结束，不直接杀死生成请求。
- 离线检查通过：`tsx scripts/image-studio-download-smoke.ts`、`tsx scripts/image-studio-provider-smoke.ts`、`tsx scripts/image-studio-delivery-smoke.ts`；最后一个使用独立 `/tmp/sd2-image-studio-test-delivery-recheck-20261001.db` 与合成图片，包含慢速、断在最后 2 字节、Range 正常/忽略/错误、总时限、403/本地过期、次数上限、私有文件权限、模拟进程重启、过期租约与一次结算。外部 fetch 被禁止，生成请求数为零。
- `tsc --noEmit --incremental false` 与 `git diff --check` 通过。初检发现测试替身类型声明不匹配，整批修正后复查；初始化临时库首次失败，创建空 SQLite 文件后成功。没有修改生产库。
- 本轮重新读取正式日志及任务/账本，确认原任务下载字节与 HTTP 200/180 秒超时证据、无资产，以及冻结 -20 / 退款 +20。上游实际扣费仍未核实。
- v0.31.1 已部署，待用户手动验收。应用提交 `fb8ee0e3881e7fbc1b162ca66e5c531f6527566a`，远端分支 `codex/content-reactions-live-20260930`；回退标签 `rollback/2026-10-01-before-image-delivery-recovery` 指向原正式 `69f852e`，均已核对远端可见。
- 候选在独立数据库副本上构建成功，无生产迁移；构建保留原有 CSS autoprefixer 兼容性警告。上传包排除环境文件、数据库及运行期媒体，SHA256 `5fb8c4fd15fdf6af09d1af637726efb3a526495ef2dc4a81aef66d5368f03d7a` 上传前后相同。
- 实际 BUILD_ID `q55m_EaNXiuiZjTrhDKPF`；网页与图片 worker 在 2026-10-01 14:40:51 北京时间安全重启，均 active/running、NRestarts=0，启动后未见 error 级日志。源码与对应 release 一致，持久 storage/uploads/videos 链接不变。切换前没有 queued/running 图片任务。
- 服务器回环 config、公网 release/config/login 均 200；公网来源 `server-42-193`，release 为 0.31.1。构建清单中的 layout 与 release 两份 JS 公网 SHA256 与运行目录一致，客户端 chunk 包含 0.31.1。升级提醒沿用既有检测、稍后去重、手动检查与刷新确认；真实弹窗交互未自动验收。
- 回退目录 `/srv/video-api-debugger/backups/image-delivery-fb8ee0e3881e7fbc1b162ca66e5c531f6527566a/` 保存旧源码、构建与服务 unit；部署脚本 `/tmp/sd2-image-delivery-release-20261001.sh` 有仅代码/服务回退，不恢复覆盖生产数据库。

## 用户要求继续深查后的证据与缺口

来源：2026-10-01 用户再次要求“有概率是，图片已经生成，到下载出了问题，你帮我深究下”。沿用本工单，不另起任务。新阶段只增加离线证据与记录，不再修改已发布应用或发起生成。

- 两个历史失败均由同模型 `gpt-image-2.5-sunburst` 的结果 URL 进入 HTTP 200/body 下载后触发绝对 180 秒上限。第二例只差 46,230 字节，已收约 99.62%。旧版 60 秒无数据计时随 data 重置，但总计时不延长。可确认终止发生于本站下载阶段；没有 Content-Type、魔数、完整解码、实际源域名或逐段曲线，不能把 HTTP 200 等同于有效完整图片。
- 本轮重新读取时，当天新增到 13 条任务：10 条 succeeded、3 条 uncertain，其中 2 条明确 download_total_timeout。邻近两条成功任务 `7f71632818ed...`、`3c81aefe132e...` 总耗时分别 67.6 秒、225.6 秒；总任务耗时包含生成，不能当纯下载时间。
- 新版上线后观察到另一个真实成功任务 `c79746549ad3...`（不是本轮调试触发）：14:42:12 创建，14:43:05 完成；实际源域名 `cdn.jd23kjs.work`，HTTP 200、无重定向，下载流程 3,895ms，完整收到 4,471,741 / 4,471,741 字节，随后成功解码保存。它证明当时该对象的交付正常，不证明历史失败使用同一域名、CDN 节点或链路，也不能证明持续无故障。
- 真实源站的强 ETag / Range 支持仍未知。新成功样本的临时恢复记录已按规则清理，日志未记录相关响应头；目前没有合法可用的原结果 URL，不能对原对象重做 DNS、连接、首字节、分段吞吐或续传对照。不拿 API 域名或 CDN 首页探测冒充图片对象链路证据。
- 补充离线对照已实际运行：无 ETag、以及有 ETag 但服务器忽略 Range 返回 200 两种慢速样本，均每次停在 51 / 102 字节，连续 6 次后达到上限。正向续传样本 100 / 102 字节中断后只取剩余 2 字节成功。结论：v0.31.1 的保留/续传/同 URL 重试机制已生效于模拟，但非续传慢速源仍会反复撞到每次 180 秒上限，不能称为根治或保证旧图可救回。
- 下一步先取得合法现存结果 URL，验证真实 ETag/Range 和慢速阶段；若真实源不支持续传，需要再设计有进展才延长的下载预算，并同时核对 worker 480 秒总预算、租约及停止等待，不能只改一个超时数字。没有原 URL 时，历史链路无法重现；保留未明结论。
- 上游后台路线已实际接续：只读页签清单确认没有 Musk 页；经 Chrome `Default`（xiaobo）新开 `https://api.muskapis.com` 后到达登录页，原生与 BrowserSkill 均指向新页签 2054140093。ClickOps auto-connect 两次连接关闭；BrowserSkill 借用此页签等待人工确认超时，已停止 rnqh 会话，不自动重试或换工具绕过确认。未进入后台、未读取保存密码、未发送私有资料。需用户完成登录并允许接管后继续 T1。
- 历史原图仍未救回；原任务仍 uncertain、无资产，站内 20 积分退款已核实；上游实际费用未核实。截图原件仍不可访问，未声称归档。

## 改动文件与交付入口

- `src/lib/image-studio/delivery.ts`：受限恢复记录、流式临时文件、ETag/Range 校验、期限和清理。
- `src/lib/image-studio/media.ts`：共享安全响应流，保留逐跳 DNS/SSRF、大小和阶段超时；补域名诊断。
- `src/lib/image-studio/provider.ts`：上游返回 URL 后先交给持久交付处理；保留纯 base64 通道。
- `src/lib/image-studio/worker.ts`：恢复只下载同一结果；租约检查、延后恢复与终态清理。
- `src/lib/image-studio/tasks.ts`：结算返回是否实际完成，旧租约不能重复结算，成功清除恢复中提示。
- `scripts/process-image-studio.ts`、`scripts/sd2-image-studio.service`：安全排空入口及足够的停止等待。
- `scripts/image-studio-download-smoke.ts`、`scripts/image-studio-delivery-smoke.ts`：共享传输回归、离线恢复/结算验证，以及非续传源的已知限制对照。
- `package.json`、`package-lock.json`、`src/lib/release.ts`：仅版本元数据和更新摘要，不改依赖。
- `AGENTS.md`、`tasks/todo.md`、本工单：图片 worker 发布约束、固定入口、执行与深查记录。原指定工作树同名工单回写最新结论，不部署其旧开发代码。
- 应用统一 diff：`/tmp/sd2-image-delivery-v0.31.1.patch`；真实入口 https://sd2.youdooart.com/template-studio 。完整发布检查命令和结果已在上述段落列明，不以健康检查替代用户功能验收。

守门员按 L4 执行；有自动分级校正，已写入全局误判记录。未扩大权限、安装依赖、付费重试或修改旧任务资产/账本。仍有 D1 与真实源站适配缺口，不将部分发布算作全工单完成。
