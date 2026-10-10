# AGENTS.md

## 交付方式（2026-09-29 用户确认）

- 本项目默认由用户手动验收。Codex 不主动执行功能验收、浏览器操作/截图验收、生成调试或自动回归验收，也不自动派审核线程；用户后续明确要求测试、排查或审核时，再执行该次指定范围。
- 实现完成后自动聚焦提交、推送并部署到现有正式服务器，不等待用户验收或二次上线确认。用户明确要求只规划、只本地、暂停或暂不部署时，遵循当次指令。
- 保留发布必需的候选构建及其内置检查、版本/构建一致性、服务健康与公网可达性检查、持久数据保护和回退点；这些是部署检查，不是功能验收。构建失败、服务异常或存在明确数据/权限风险时，不强行上线，保留或恢复原运行版本并说明原因。
- 上线后回执写“已部署，待用户手动验收”，附版本、入口及未解决问题；不得把构建成功、进程健康或发布成功说成“功能验收通过”。
- 本节替代项目此前的自动验收、强制审核及等待验收后部署要求；不扩大付费、权限、生产数据覆盖、删除等高风险操作授权。仅规则/文档修改时提交推送即可，不为此升级应用版本或重启网站。

## 项目身份

- 项目名称：video-api-debugger
- 项目类型：用于调试视频生成接口、任务状态、资产上传、用户点数与后台管理流程的 Next.js 应用
- 技术栈：Next.js 14 + React 18 + TypeScript + Prisma + SQLite
- 默认协作链路：明确任务边界 -> Codex 实现并自动部署 -> 用户手动验收；只读审查仅按用户明确要求安排。

## 主要目录结构

- `src/app/`：Next.js App Router 页面、布局、API Routes 与 `middleware`
- `src/app/api/`：服务端接口，包括鉴权、点数、后台用户、视频任务、资产、工作区等路由
- `src/components/`：前端交互组件与生成器工作区相关 UI
- `src/lib/`：数据库、鉴权、Provider、价格、任务状态、资产与工作区等共享逻辑
- `src/lib/auth/`：登录态、密码与 API 鉴权辅助逻辑
- `src/lib/provider/`：外部视频/资产 Provider 适配相关逻辑
- `src/lib/assets/`：资产归一化、集合、工作区、快照与仓储逻辑
- `src/types/`：项目共享 TypeScript 类型
- `prisma/`：Prisma schema、迁移与 SQLite 数据模型
- `scripts/`：管理员种子脚本和外部 API 测试脚本
- `docs/`：工程协作、任务模板、执行记录等文档
- 根目录配置：`package.json`、`tsconfig.json`、`next.config.js`、`README.md`、`SPEC.md`

## 常用命令

- `lint`：`npm run lint`
- `typecheck`：当前未发现独立脚本
- `test`：当前未发现通用测试脚本；仅发现 `npm run test:api`，该脚本面向 Seedance 外部接口调试，不应默认作为本地回归测试执行
- `build`：`npm run build`
- `sd2` 服务器状态：`ssh gouki@42.193.221.253 'systemctl is-active sd2-gray.service && curl -sS http://127.0.0.1:3302/api/config'`
- `sd2` 公网验证：`curl -sS -D - https://sd2.youdooart.com/api/config -o /tmp/sd2-public-config.json`
- `sd2` 服务器部署：按本文件“sd2 服务器生产托管规则”执行本地提交、归档上传、候选构建、服务重启、公网验证和回滚保护；不再用 Mac `youdoo-sites` 当生产部署链路
- 数据库相关脚本：`npm run db:generate`、`npm run db:push`、`npm run db:studio`，默认不得执行会修改数据库状态的命令

## sd2 服务器生产托管规则

- FEEDIMG03已保护发布（2026-10-09 America/Los_Angeles）：实际运行源 `9825cb7fae053b62157834337430ba247b05b9fe`、v0.67.0、BUILD `MYzHNWe2m3mdWyUsDRZkz`；web实际cwd `/data/video-api-debugger/releases/9825cb7fae053b62157834337430ba247b05b9fe`，真实sender同源同版，沿 `sd2-feedback-delivery.timer` 正常运行。新反馈仅从本人有效Asset和校验后的本站哈希原件准备图片，使用原批准机器人上传key后冻结一条卡片；正文、原比例截图、较轻来源与唯一鉴权详情入口依次展示。快照最多128项、卡片最多20张，缺图如实说明；未知上传不盲重传，消息固定uuid/租约/结果未知安全窗和旧文字/卡片兼容保留。9应用路径、0 schema/生产DDL/依赖或费用改动；27隔离场景及7工程检查、lead非独立源码Review、主/guard内置检查、1014源和32公网静态核同完成，主管限定8目标源/2静态与实际sender三核心SHA薄核通过。真实图片上传受理、客户端卡片实收及UI仍待用户手验，平台配置或健康不当功能验收；0测试反馈/上传/发送/Browser/收费/权限扩大/独立审核线程。原app `1a3d1dec878c376b2930c8847f13607aa0d2b35f`、两个worker PID1303824/1303881、env/持久链接和inode/依赖/HD `output_integrity` 暂停及真实 `/dev/vdb /data` 不变。RECON01及其他冻结事项不实施。本条之后仅APP安全记录提交不改变运行源或版本；以下旧运行条目为历史，后续先鲜核实际web与sender。
- FEEDIMG03相容回退：guard `2ce26e18f8087f2d7758a18b068161ce8e75ae5e`、v0.66.1、BUILD `4Ab9M6ZvyretVAq5rFnnF`，完整源/构建在 `/data/video-api-debugger/releases/2ce26e18f8087f2d7758a18b068161ce8e75ae5e`；保留新图片准备及固定消息，旧API仍产生旧格式。必须先只停反馈timer并自然排空，再成对回web/sender，保留所有反馈/通知行、不重放、不回DB、不动原worker；不用未支持新元信息的旧sender。原3a0整源仍在 `/data/video-api-debugger/releases/3a0c13d9540d589f0fe2ed303579ae2b5f6f17e1`，原BUILD `PCaJUNybCGKSGxoXbFYbc`完整归档及受保护配置备份在 `/data/video-api-debugger/release-staging/feedimg03-20261009`；同目录 `rollback.sh` 有实际源/配置/保护守卫，后继发布或保护改变停止自动回退，未实际演练。远端标签 `release/feedimg03-v0.67.0-20261009`、`rollback/pre-feedimg03-v0.66.1-guard-20261009`、`rollback/pre-feedimg03-original-v0.66.1-20261009` 已核对应源，own窗口完成。正式根工单第8节与 `docs/materials/2026-10-09-feedback-feishu-notify/image-implementation/checkpoint.json` 是私有证据入口，由主管维护正式记录；私有材料、原根dirty/ahead内容不推Git或公开部署。

- 当前正式生产入口是 `https://sd2.youdooart.com`，长期使用腾讯云 Ubuntu 服务器版。旧 `sd2.youdoodesign.com` / Mac 本地 Cloudflare Tunnel 入口不再作为生产入口；除非用户明确要求回滚或排查旧入口，不得重启 Mac 本地 `sd2` 当作恢复手段。
- 用户未明确指定其他站点时，本项目所有页面查看、问题排查、代码修改、配置核对、登录回调、部署验证、截图验收和 API 验证，默认目标一律是 `https://sd2.youdooart.com/`。App 浏览器、Chrome、日志或历史记录里出现 `sd2.youdoodesign.com`，只能当作旧 tab/旧入口背景，不得自动切回 design 域名继续修改或验收。
- 不得在 `sd2.youdoodesign.com`、design 域名、Mac 本地 Cloudflare Tunnel 或旧 `trycloudflare` 链路上做默认修改、默认部署、默认验证或默认排查。唯一例外是用户明确要求“旧入口 / design 域名 / 回滚 / 迁移核对”时，才可只读确认旧入口状态，并且不得把它的结果当成 `sd2.youdooart.com` 生产结论。
- `sd2.youdooart.com` 必须直接打开服务器网站，不得用跳转临时代替。飞书 OAuth、回调地址、登录后跳转地址和前端公开域名配置都必须以 `sd2.youdooart.com` 为准；登录后跳回旧域名时，按配置错误处理。
- 服务器默认是 `42.193.221.253:22`，普通操作用户 `gouki`；线上 nginx 反代到 `127.0.0.1:3302`，systemd 服务名 `sd2-gray.service`，服务器应用目录 `/srv/video-api-debugger/app`，公网响应应能看到 `X-SD2-Origin: server-42-193` 这类服务器来源标记。
- 最近已发布UI29（2026-10-07）：同一APP工作树/分支，v0.52.0，实际built/deployed-source `9cec8f15c386c2929a824c66187a9830e7e89af2`，BUILD `eK6CQJpF06uoVM0mSn4FW`；随后仅本文件安全运行记录提交不改变运行源。PASTE29共享上下文粘贴仍替换全文，仅已有读取授权且用户指向/聚焦粘贴键或明确复制后取得非空文本证据才亮起；未知/拒绝状态仍可点击明确读取，不后台轮询、不在打开弹窗或窗口聚焦时偷读、不自动询权限、不持久保存或传输外部全文。弹窗响应式最大820px，数量标签与主图范围紧凑单行，原限制/保存成功关闭/未保存保护不变。FAV29结果区增加当前模板本人喜欢筛选，不跳资产页、不混模板喜欢；沿原授权来源先筛本人liked或历史favorited的有效资产及成功结果再游标分页，all/liked各自按最多3行恢复位置，取消喜欢确认后移除、账号/模块/请求及返回viewer隔离，空/载/错/重试/刷新保留；只读筛选不发DOT24进入确认回执。CMP29左当前缩略、中央对比、右选定缩略紧邻中央，保留固定左原图右选图、无交换、外置联动锁、独立缩放定位及更多/关闭，不改预览缓存或下载引擎。
- UI29工程证据：13份应用文件，一次MINOR；整批统一候选内置lint/types与编译、同产物lead源码Review、887份源码一致、46公网项含43静态SHA完成。首候选内置检查成功但产物证明脚本未读取分拆server chunk而阻断，未切live；集中修正记录及旧候选保留，最终新增clipboard hook警告消除、其他已有警告未扩大修改。完整三ID根因/逐文件/限制/命令/Git/调度在 `/tmp/sd2-ui29-20261007/handoff.json`，应用diff `/tmp/sd2-ui29-20261007/app.diff`，含本记录完整diff `/tmp/sd2-ui29-20261007/full.diff`，候选/Review/公网/窗口/保护JSON与日志同目录，由主管正式归档。实际工具无native spawn/容量入口，1 lead/0 worker串行，不建侧栏/审核线程、不改模型。ReleaseNotice唯一版本源、SemVer、稍后/手查/未保存保护按源码保留；真实剪贴板/跨浏览器、喜欢分页/取消/恢复/跨账号/撤权、多端布局及旧客户端更新提醒NOT_RUN，已部署待用户手动验收。外部剪贴板状态无法持续保证，权限查询不支持时不提前伪亮；很大喜欢历史读取成本未实测。守门员等价按部署/回档L4纠正工具L3关键词输出，误判已记录；无浏览器/截图/业务回归/收费/喜欢写样本/删除/生产回执或DB写迁移。IMG29、TXT28及所有旧未完成项不纳入，UI28媒体/cache/原件/下载限制及PERF26-N未知、UI27固定左右、UI26单心及DOT24回执语义保留。正式根私人记录和三原图由主管独占，不进入Git或服务器。
- UI29保护发布：远端peeled tags `release/ui29-v0.52.0-20261007` ->9cec8f15、`rollback/pre-ui29-v0.51.6-20261007` ->实际旧运行e9858163。回退源码 `/srv/video-api-debugger/releases/e985816369cc1382dbb525f1804a7cd3ff20d748-ui29-rollback-source`，回退构建 `/srv/video-api-debugger/app/.next-prod-prev-ui29-9cec8f15c386`、旧BUILD `u3yqXcTy9wdrsK4jDRq0a`。跨盘候选复制到app同盘后保护切换，发布锁与512000KB线生效，最后鲜核根盘933368KB，下轮重核；50旧回退全保留，新增第51个，历史无BUILD条目仅保留缺口。只重启web，worker PID1043189/Invocation121606e35406489ea26faa2490c7de65、持久storage/uploads/videos目标/inode与env元信息均不变；无凭据内容读取、权限/依赖/锁/schema/点数/支付/Provider/worker/网络改动。匿名release只证明version/channel且摘要合法为空，BUILD以SSH和编译资源SHA证明，不冒造API字段。以下运行条目为历史，不替代本轮鲜核。
- 上一轮UI28+PERF26（2026-10-07）：同一APP工作树/分支，v0.51.6，实际built/deployed-source `e985816369cc1382dbb525f1804a7cd3ff20d748`，BUILD `u3yqXcTy9wdrsK4jDRq0a`；随后仅本文件运行记录提交不改变运行源。TAB28复用原完成提醒开关/提交观察/回执去重，后台真实新成功合并为有界温和标题提示及静态回退，前台/退出/关闭提醒停止，不写DOT24回执、不承诺后台定时节奏或标签物理移动。CARD28元信息紧凑、下方次操作桌面hover/focus出现且保留布局、触屏/恢复操作可达；REF28连续紧凑图区及用途添加框、原素材/风格/顺序规则保留；CLEAR28清空回图片区内部留边距沿原保护；TITLE28图片生成H1由24px改48px加粗、手机换行，不用vw。
- PERF26-1..5已实施保护发布，功能仍手验：已知图片入口沿原授权路由分640缩略/1600轻量/2048细节/原件，保留private no-store/Vary Cookie、原件权限先验及HEAD/Range/长度/取消安全流，不建任意URL代理。缩略与清晰请求并行，解码后升级，UI27左当前原图/右选对比图、无交换、独立引擎及联动锁保留。会话缓存仅内存、32项/64MiB压缩字节/3分钟空闲，账号role/type/content/version隔离，decoded-ready才复用；重新打开/前台HEAD核权，可见期间约60秒再核，失败abort/revoke/清bytes，不等于即时撤权或GPU内存上限。单图/图片ZIP浏览器原生下载与yazl懒加载原件流，不冒称已保存；原图inline与download attachment区分，清晰图不是原件。外部未知来源/视频音频封面明确原生回退；无可靠MIME/大小元信息仍未知，不能声称全部普通URL不读原件。仅已授权web缩略读取触发轻量派生预备，不更新worker、不保证所有新图首次打开前编码；远端版本缺失按分钟缓存键可能重读。原显式目录保存及其他全站视频ZIP客户端保留旧Blob流程，素材页视频ZIP仅交浏览器且原服务器打包逻辑不改。PERF26-N网络16秒波动/重传/约2.2s首字节原因仍未知，仅媒体请求增加最小access/media计时和随机请求编号，无云指标/代理/带宽/权限改动。
- UI28工程证据：30份应用文件，一次PATCH；首次候选内置类型检查失败（ES5 Set迭代）未切live，失败日志及首Review保留。R1-R7集中修正涵盖decoded-ready、失败取消清理、下载owner收束、进度发布节流及资产/图集缩略来源、role/type身份，第二统一候选内置lint/types完成，非阻断警告原样保留；同产物lead源码Review、886源码一致、46公网项含43静态SHA完成。完整逐文件/六ID/PERF26-1..5与N/入口映射/限制/命令/调度在 `/tmp/sd2-ui28-20261007/handoff.json`，应用diff `/tmp/sd2-ui28-20261007/app.diff`、含本记录完整diff `/tmp/sd2-ui28-20261007/app/full.diff`，日志及JSON同目录，由主管归档。工具鲜核无native spawn/capacity接口，实际1 lead/0 worker串行，不建侧栏任务/不改模型；正式根私人记录/原图由主管独占，不进入Git/部署。ReleaseNotice唯一版本源/SemVer/稍后/手查/未保存保护按源码保留，真实旧客户端未验。守门员按媒体/cache/原件/下载/保护发布L4等价纠正（关键词工具L3误判已记录），real-result及独立审核线程按项目明确手验跳过；无浏览器/截图/业务API测试/自动功能回归/收费/真实删除/生产回执样本/DB写迁移，实际布局/撤权/跨账号/原件完整流/ZIP/原生下载效果待用户手动验收，不标功能PASS。
- UI28保护发布：远端peeled tags `release/ui28-v0.51.6-20261007` ->e9858163，`rollback/pre-ui28-v0.51.5-20261007` ->实际旧运行447047a1，不指向纯记录2d517694。回退源码 `/srv/video-api-debugger/releases/447047a1c0308c2dc5875c64eebb3f1fa92f95c9-ui28-rollback-source`，回退构建 `/srv/video-api-debugger/app/.next-prod-prev-ui28-e985816369cc`、BUILD `eb5q2lfsbeuqxYlKJR94V`。新候选保留在数据盘，stat鲜核不同设备后复制到app同盘切换，发布锁及512000KB保护线生效；发布后根盘986084KB，下轮鲜核。49旧回退全部保留，本轮新增第50个（历史无BUILD条目仅保留缺口，不冒称可恢复）；只重启web，worker PID1043189/Invocation121606e35406489ea26faa2490c7de65、持久storage/uploads/videos目标/inode、env元信息未变，无env/key内容读取、权限/依赖/锁/schema/点数/支付/Provider修改。UI27/DOT24及其他旧缺口保持，以下条目均为历史，使用前鲜核实际源/BUILD。
- 最近已发布源码（2026-10-07 UI27）：APP工作树与分支不变，v0.51.5，实际built/deployed-source `447047a1c0308c2dc5875c64eebb3f1fa92f95c9`，BUILD `eb5q2lfsbeuqxYlKJR94V`；随后仅AGENTS记录提交不改变运行源。REF27模板主图/风格/参考区域去常显标题与计数，管理入口保留规则；GEN27主操作与张数间距、真实单次/批量总积分及小屏重排，去上游成本与空清参考。DOT24-1共享正常列表与提醒的本人/来源/权限口径，人物历史保留；DOT24-2仅明确进入且列表成功后确认服务端限定当前模板的不可变成功版本快照，晚完成与其他对象不清；DOT24-3私有单调seen回执、权威revision、账号/请求/旧GET隔离与失败重试，初始URL/自动恢复不清，单图阅读语义保留；DOT24-4整批候选/源Review/Git/保护发布。CMP27固定左当前原图、右用户选的对比图，已移除内容互换入口和函数，不恢复反置/身份不明的旧选择；两侧换图及独立尺寸位置、可选常显联动锁、居中对比、缩略图先行保留，原文件bytes已知才显示，预览像素不当原像素，未知如实显示。ASSET27共享选图卡只常显有效名称/必要状态，详情保留数据，图内左上角独立删除图标hover/focus/touch可达且原确认保护不变；HOME27五类别恢复Lucide，父区无卡、子入口整块可点，链接与账号条件不变；WAIT27真实输入快照铺满1:1、cover及首次即2.4px模糊（原6px减少60%），不改进度或重放生成。
- UI27交付证据：22份应用文件、一次PATCH，最终候选内置类型/lint成功（警告原样保留）、统一lead源码Review及整批修正完成；881份源码一致、41公网项含38静态SHA及实际SOURCE/BUILD相符。前两候选编译成功但未切live，最终CMP27纠偏及恢复不清提醒纳入新候选；所有日志/旧候选保留。完整逐文件/七项及DOT24-1..4/实际调度/命令/保护/远端证据在 `/tmp/sd2-ui27-20261007/handoff.json`，应用diff `/tmp/sd2-ui27-20261007/app.diff`，含运行记录完整diff `/tmp/sd2-ui27-20261007/app/full.diff`，候选/公网JSON及日志在同目录，由主管归正式资料。当前工具未暴露内部spawn_agent/容量接口，实际零worker、单lead串行写者，无侧栏新任务或模型改配。正式工单/规则/索引/五原图由主管独占，本轮私人资料未进入Git或部署；LIB24及其他未授权旧待办保留。ReleaseNotice唯一版本源、稍后/手查/未保存保护按源码核对保留，真实旧客户端提醒未验。守门员L3-visible-runtime，real-result按项目手验跳过，不标PASS；无浏览器/截图/自动功能回归/业务API/收费/真实删除/测试性生产回执确认/生产DB写或迁移，七项真实交互与持久提醒均待用户手动验收。
- UI27保护发布：远端解引用已核 `release/ui27-v0.51.5-20261007` ->447047a1，`rollback/pre-ui27-v0.51.4-20261007` ->原实际运行35393c35，不指向记录0d5c3c62。回退源码 `/srv/video-api-debugger/releases/35393c35d340e3a970d99aecd319f642a2f06845-ui27-rollback-source`，回退构建 `/srv/video-api-debugger/app/.next-prod-prev-ui27-447047a1c030`、BUILD `fCnZP3CsWbt6x1ZEQxSgP`。新候选保留在数据盘，鲜核不同设备后复制到app同盘原子切换，发布锁及512000KB根盘保护生效；最后根盘1198716KB，下轮鲜核。只重启web，worker PID1043189/Invocation121606e35406489ea26faa2490c7de65不变，storage/uploads/videos目标/inode及env元信息不变；48个旧回退全部保留（旧缺失BUILD条目只标历史缺口，不冒称可恢复），本轮新增第49个。无依赖/锁/schema/权限/点数/支付/Provider变化，不读env或key内容。
- 上轮已发布源码（2026-10-07 UI26）：APP工作树与分支不变，v0.51.4，实际built/deployed-source `35393c35d340e3a970d99aecd319f642a2f06845`，BUILD `fCnZP3CsWbt6x1ZEQxSgP`；随后纯记录HEAD不改变运行提交。LIKE26共享喜欢与分享的同级key曾相同，v0.51.2及v0.51.3实际源码均有此缺陷，现按控件类型和对象隔离，历史喜欢/收藏、真实计数、分享权限及异步/动画清理保留。FAV26真实喜欢模板在原侧栏下展开，分批读取与账号隔离/展开恢复；已安装定位原模块，未安装沿原显式使用，不因读取或恢复创建/生成，全站资产喜欢不变。GRP26分组浮层使用同级选择/删除按钮、键盘及外部/Esc关闭，复用影响确认，受保护分组和busy保护保留；DEL26仅删除模块改44px图标按钮，取消确认与其他文案保留。PRE26同对象缩略图先绘制后启用高清预览，失败保留可看缩略图和重试，身份/取消/迟到解码隔离；原图仍显式、每侧独立位置和尺寸/fitwidth/actual/manual恢复及可选联动保留，不安装库或重写引擎。无真实独立缩略图的来源沿已有原生加载回退，不伪造缩略图。
- UI26交付证据：14份应用文件、一次PATCH摘要，候选内置类型/lint及统一源码Review、880源码一致、39公网项含36静态SHA完成；首次候选被漏留变量的类型错误拦下，未切live，原失败日志保留；本机Node公网连接失败后使用curl完成同批检查，不冒称首次一次成功。应用统一diff `/tmp/sd2-ui26-20261007/app.diff`，完整含运行记录diff `/tmp/sd2-ui26-20261007/full.diff`，候选/运行/公网JSON与构建、保护、Review、Git证据均在 `/tmp/sd2-ui26-20261007/`。正式根工单/五项清单/索引/规则及私有PNG由主管独占登记归档，不公开Git或部署；DOT23、LIB24及其他旧待办不纳入。守门员L3-visible-runtime，real-result按项目手验跳过；未运行浏览器、截图、自动功能回归、收费生成或生产DB写，真实五项及旧客户端更新提醒均待用户手动验收。
- UI26保护发布：`release/ui26-v0.51.4-20261007`指向上述实际应用提交，`rollback/pre-ui26-v0.51.3-20261007`指向原运行90d165d，均已推送；回退源码 `/srv/video-api-debugger/releases/90d165dd64cfecf9377c5048deae46b74797d3ae-ui26-rollback-source`，回退构建 `/srv/video-api-debugger/app/.next-prod-prev-ui26-35393c35d340`、BUILD `vEHOloT6Kp_nStXUuITvE`。数据盘独立候选及跨盘复制保护保留；只重启web，图片worker PID1043189/实例121606e35406489ea26faa2490c7de65未变，storage/uploads/videos目标与inode、env元信息不变，根盘鲜核1261404KB高于512000KB保护线，下轮重新核。旧回退全部不删除，无依赖/锁/schema/权限/点数/支付/Provider变化，不读取env或密钥内容。
- 上轮已发布源码（2026-10-07 UI25）：APP工作树与分支不变，v0.51.3，实际built/deployed-source `90d165dd64cfecf9377c5048deae46b74797d3ae`，BUILD `vEHOloT6Kp_nStXUuITvE`；随后纯记录HEAD不改变运行提交。REF25把虚线加号图片块放入现有StudioReferenceGrid，与缩略图同组，原选图/预览/移除/排序/草稿链路保留；NAV25把创作首页放在共享固定顶栏且不受小屏隐藏导航影响；PRE25单行工具栏保留两图选择、对比、紧凑缩放、更多及关闭，次要操作进弹层，每侧独立定位与可选联动保留，不改引擎。8文件应用diff、候选内置类型/lint、878源码一致及39公网检查（含36静态SHA）完成；只重启web，图片worker PID1043189/实例未变，持久目录与env元信息未变。未运行浏览器、截图、自动回归或收费生成，真实REF25/NAV25/PRE25及旧客户端提醒待用户手动验收；LIB24及其他旧待办不纳入。完整应用diff、构建、公网及保护证据在本机 `/tmp/sd2-ui25-20261007/`，正式根工单/附件/索引由主管独占归档，不上传私有资料。
- UI25保护发布：`release/ui25-v0.51.3-20261007`对应上述应用提交，`rollback/pre-ui25-v0.51.2-20261007`对应原运行6a5a8f5；回退源码 `/srv/video-api-debugger/releases/6a5a8f539ce6af9dcdb6edd05f1d08080cb5a30f-ui25-rollback-source`，回退构建 `/srv/video-api-debugger/app/.next-prod-prev-ui25-90d165dd64cf`、BUILD `tZEbkDJvoGLXx368EiZ1G`。新候选保留在独立release设备，跨盘复制到app且保留原候选与所有旧回退；部署后根盘保护检查高于512000KB，下轮重新鲜核。不改变账号权限或数据库，不安装依赖，不改锁文件；原有项目边界保持。
- 上一轮已发布源码（2026-10-07）：`/Users/gouki-youdoo/.codex/worktrees/cutout-validation-paste-20261006/video-api-debugger`，分支`codex/image-compare-20261006`，v0.51.2，实际built/deployed-source `6a5a8f539ce6af9dcdb6edd05f1d08080cb5a30f`，BUILD `tZEbkDJvoGLXx368EiZ1G`；纯记录HEAD不改变运行提交。VREF23把独立视频页与素材弹窗接到已有共享用户状态，保留两入口及原选用链路，加载/失败/未登录有反馈和重试。3文件应用diff、候选内置类型/lint、878源码一致、29公网静态SHA及健康/Git/回退检查完成，功能/浏览器/收费生成未运行，真实选图及旧客户端提示待用户手动验收。正式资料`docs/materials/2026-10-07-feedback-24h/vref23-v0.51.2/`及同日反馈工单VREF23节；VREF22/NAV22的v0.51.1历史交付/手验缺口与其他待办保留，不自动结项。
- VREF23保护发布：release/vref23-v0.51.2-20261007与rollback/pre-vref23-v0.51.1-20261007已推送；回退源码`/srv/video-api-debugger/releases/30e16ef33e478cbbf884b5c1266ea5e98f46d26c-vref23-rollback-source`，回退构建`/srv/video-api-debugger/app/.next-prod-prev-vref23-6a5a8f539ce6`、BUILD8wHmI-2KqZwqjKsRcfpyr。只重启web，图片worker PID1043189/实例未变，持久storage/uploads/videos未覆盖；根盘最后余874296KB高于512000KB保护线，后续发布鲜核。普通gouki账号用于常规读取，不能假设其可sudo bash；必要发布沿已有ops/服务器技能登记的root SSH及既有密钥，不改sudoers、凭据或权限。私人记录不公开Git或部署。
- 上轮v0.51.0的LIKE21/AVUI21运行源b5c8b9f、BUILD w2dFDm8K2jjpZHZ9uQopw保留为历史：喜欢终态/圆背板缩小、头像分格与可选参考链路及双击/Enter预览已部署，仍未功能手验。原19文件/15公网静态证据在`docs/materials/2026-10-07-feedback-24h/ui21-v0.51.0/`，不以本次31资源检查冒称旧功能实测。
- 本轮v0.51.1保护发布：标签`release/vref22-nav22-v0.51.1-20261007`与`rollback/pre-vref22-nav22-v0.51.0-20261007`已推送；回退源码`/srv/video-api-debugger/releases/b5c8b9f82bebc38a62837e5c289bbb19e7c4fbb5-vref22-rollback-source`，回退构建`/srv/video-api-debugger/app/.next-prod-prev-vref22-30e16ef33e47`。只重启web，图片worker PID1043189/实例不变，storage/uploads/videos原持久目录未覆盖；跨盘保护切换、根盘最后余923124KB大于512000KB保护线，下次发布重新核容量。旧回退不删除；私人截图/工单/索引只在正式根本机保留，不公开Git。
- 前版60b/v0.50.0/BUILD Wflt的SIDE/CMP/PAGE18限定10项最小实页PASS保留为历史，只对应该产物，不冒称v0.51.0功能验收；其主管浏览器session已停止。原17项+PAGE18完整状态见`tasks/todo/2026-10-04-template-context-version-code.md`第17节，第18节BUX保留。PAGE18按容器列数×最多3行，cursor下批进下一页，账号/模块或批次隔离恢复；resize保可见项、预读最多20批，失效位置安全回退，不无限追加。
- CUT-A2本人绑定、NAV2真实用途图/脚本、PIN1真正位置、AUD20-D01人物来源/未读口径漏接、FB07其他布局/折叠/等待图及重复暗底、真实付费BUX结果ZIP/物理触屏/clipboard等缺口仍保留。后续无新明确实施或验收授权时不自动改源、测试、收费或发布；收到同对象新授权按现有流程继续，不要求重复确认。当前实际动画、参考生成效果、裁格CORS、跨账号恢复和旧客户端更新提醒未验证，不使用旧照片或构建冒充。
- 保护发布：原60b/Wflt源码与构建回退保留，标签`rollback/pre-like21-avui21-v0.50.0-20261007`；中间71de构建另保留，最终发布标签`release/like21-avui21-v0.51.0-final-20261007`。只重启web，图片worker PID1043189与实例不变；源同步排除.env/依赖/构建/storage/上传/视频/数据库，不删用户资料或旧回退。跨盘按实测暂存，根盘最后余966372KB且保护线512000KB，后续重新核容量。正式根私人反馈/作品/资料索引不推公开Git，应用分支只提交安全源码和脱敏运行记录；发布前重新核`.deployed-commit`/BUILD_ID与实际源，服务器`.git`不作为部署来源，不默认git pull或沿用历史worktree。喜欢、耗时及抠图历史沿固定工单与资料索引检索。
- 服务器部署必须按 `server-deploy-closure` 思路执行：本地形成可追溯 commit / rollback tag -> 用 `git archive` 打包当前提交 -> 上传到服务器 `/tmp` -> 解压到 `/srv/video-api-debugger/releases/<commit>` -> `rsync -a --delete` 到 `/srv/video-api-debugger/app` -> 执行 `scripts/server-ensure-runtime-dirs.sh /srv/video-api-debugger/app` 或等价命令，把 `public/uploads`、`public/videos`、`storage` 迁移并软链接到 `/data/video-api-debugger/var-lib` 下的持久运行目录，同时确认运行目录权限和 `gouki` 对应用根目录的候选构建写权限。
- 上传或同步服务器源码时必须排除 `.env`、`node_modules`、`.next`、`.next-prod`、`storage`、`public/uploads`、`public/videos`、数据库文件、上传资产、视频、截图和其他运行期产物，避免覆盖密钥、现有视频、截图、用户上传和生产构建。
- 当前生产数据盘是 `/data`，`/var/lib/video-api-debugger`、`/var/log/video-api-debugger`、`/srv/video-api-debugger/releases`、`/srv/video-api-debugger/backups` 都应保持为指向 `/data/video-api-debugger/...` 的软链接；不要把数据库、上传素材、视频、缩略图、备份、发布 release 或 sd2 日志重新落回旧根盘。
- 每次同步服务器源码后必须确认 `public/uploads`、`public/videos`、`storage` 是指向 `/data/video-api-debugger/var-lib` 的软链接，并确认 `public/uploads/assets`、`public/uploads/thumbs`、`public/videos/thumbnails`、`storage/backups` 存在且 `gouki` 可写；否则发布同步可能清空历史视频/封面，或让缩略图接口、上传、视频封面补偿和备份脚本在运行时失败。
- `sd2-gray.service` 使用 `NEXT_DIST_DIR=.next-prod`。普通 `npm run build` 只会更新 `.next`，不代表线上生效；服务器生产构建必须用 `NEXT_DIST_DIR=.next-prod-candidate npm run build`，验证 `BUILD_ID` 和预期变更后，再把 `.next-prod-candidate` 切换成 `.next-prod`。
- 图片队列由独立的 `sd2-image-studio.service` 长驻进程处理。涉及 `scripts/process-image-studio.ts` 或其加载的图片生成、下载、引用权限代码时，发布必须同时安全排空并重启该服务；网页服务重启不能证明图片处理代码已更新。停止等待时间须覆盖最长任务及结算余量，确认旧进程正常退出后再同步源码；保留服务配置回退点，核对新启动时间、源码与服务健康，不能为发布强杀已付费请求。背景与检查入口见 `tasks/todo/2026-10-01-image-download-timeout.md`（2026-10-01）。
- 不得直接删除或原地构建 live `.next-prod`。切换前保留 `.next-prod-prev` 或等价回退目录；候选构建失败、候选内容不含预期变更、重启失败或公网仍是旧版本时，必须恢复上一版并停止报告。
- 每次涉及 `sd2` 服务器部署、登录域名、nginx、systemd、构建目录、公开 API、用户可见页面或静态资源改动后，至少验证：
  - `ssh gouki@42.193.221.253 'systemctl is-active sd2-gray.service'`
  - `ssh gouki@42.193.221.253 'cd /srv/video-api-debugger/app && cat .next-prod/BUILD_ID'`
  - `ssh gouki@42.193.221.253 'curl -sS -D - http://127.0.0.1:3302/api/config -o /tmp/sd2-local-config.json'`
  - `curl -sS -D - https://sd2.youdooart.com/api/config -o /tmp/sd2-public-config.json`
  - `curl -sS -D - https://sd2.youdooart.com/login -o /tmp/sd2-login.html`
  - 前端发布只核对公网版本/构建标识及必要静态资源可达性；不自动操作页面、截图或执行功能验收。
- `sd2.youdoodesign.com` 的状态只能用于确认旧入口已停用或迁移，不得把它的健康状态当成当前服务器生产站结论。以后排查“线上没生效 / 无法登录 / 生成失败 / 视频下载失败”时，默认先查服务器链路、`sd2-gray.service`、`127.0.0.1:3302` 和 `sd2.youdooart.com`。

## UI 规则

- 2026-10-07 UI27用户确认：模板图片区用途在框内、数量规则按现有管理入口设置；主生成清楚且显示真实总积分。模板提醒复用私有seen回执，仅本人/当前模板/服务端成功版本快照在明确进入且列表成功后确认；后台/初始URL/自动恢复不清，失败可重试，快照后新完成仍提示，人物历史不误亮正常模板。对比左原图/右对比图原则不变，禁止自动或手动互换内容及反置恢复，但两侧可各自换图并独立定位/缩放、联动锁常显、对比居中；文件大小/原像素未知不伪造、不为查大小下载原图。素材卡只留有效选图信息、原数据按需可看、图内删除保留原确认；首页明确改选抽象Lucide而非历史NAV2用途插图；等待图是实际输入快照、首次就模糊且铺满方框，不冒称AI中间结果。正式原话及五私有图沿主管同日UI27/DOT24工单与资料索引读取，功能仍手验，不重复旧诊断/生产账号探针。

- 2026-10-07 UI26用户确认：模板“我的喜欢”在模板页原导航下就地展示实际清单，不代跳资产页；已安装定位原模块，未安装只经原明确使用。分组删除放各行独立图标，不在native option里嵌交互、不以删除选择分组或生成；仅删除模块按钮去文字，原保护确认不丢。共享大图和两侧换图先用同对象缩略图再升级预览，原图仍显式请求；独立双图定位优先于默认同步技能。相关原话/私有附件沿正式同日工单UI26与资料索引检索，五项真实效果待用户手验，不用源码标记或构建冒称通过。

- 2026-10-07 VREF23用户反馈及源码结论：独立视频生成页使用共享素材选择器时，页面及弹窗必须读取同一已初始化的AppSession；不保留仅页面局部user却让弹窗读空共享user的并行状态。保留账号隔离与原选图/图集回调，登录读取失败给可重试反馈，不删除守卫或重放生成。完整原话、源码因果与手验缺口见同日正式工单VREF23节；不将代码/构建证明冒称用户按钮实测。

- 2026-10-07确认：视频模板需求输入框上方使用生图模板同款参考图区，沿用素材ID、槽位、首尾帧和草稿链路；视频/音频/参数按需展开，不重复图片列表。顶部导航移除“超分”，原功能和其他入口保留。文案模型仍按现有文字能力运行，未确认任务不自动重试，真实功能由用户手动验收；正式原话/资料在根目录同日反馈工单VREF22/NAV22节和资料索引，私人原件不公开Git。
- 所有生成记录列表、任务记录列表、产出记录列表、项目内生成列表和视频卡生成列表，最左侧第一列必须是视频截图/缩略图。
- 生成记录列表不得让提示词、日期、状态、项目名或成本信息直接顶到最左侧；视觉扫描入口必须先看到对应视频画面。
- 视频截图优先使用任务缩略图、首帧、本地视频截图或已有产出预览图；没有可用截图时，也必须保留尺寸稳定的缩略图占位，并明确表现为“暂无截图/预览不可用”，避免列表布局跳动。
- 该规则适用于 `/admin` 最近生成记录、`/admin/outputs`、`/tasks`、项目详情、视频卡详情以及后续新增的任何生成记录列表；如果确需例外，必须先得到用户明确确认。
- 界面中凡是展示用户、成员、创建者、生成者、管理员、操作人等人物姓名，姓名左侧必须显示头像；真实头像缺失时使用稳定首字母/颜色头像占位，避免只展示纯文字姓名。

## Codex 默认职责

- 在 Hermes 明确任务边界后，按允许修改范围执行代码或文档修改。
- 修改前读取必要上下文，优先遵循项目既有目录、命名、技术栈与实现风格。
- 做本项目的新功能或模块时，先查项目内现有实现和成熟开源模块/组件/SDK/模板；能复用就优先复用或少量适配。复用前必须核对许可证、维护状态、依赖体积、安全风险、和当前 Next.js/React/Prisma 技术栈及本项目 UI 风格是否匹配，避免为了省事引入不必要的大包或不可控代码。
- 对高风险区域保持最小改动原则，必要时先要求 Claude Code 或用户补充只读分析。
- 每次只处理当前任务，不顺手重构、不扩大范围、不隐式改变业务规则。
- 修改后默认只执行发布必需检查；功能验收由用户手动完成。用户另行明确要求的测试按指定范围执行，未执行项如实说明。
- 完成用户可见改动后默认自动部署，新产物供用户刷新获取，实际效果由用户手动验收；不能只停在本地代码、构建或 Git。
- 如果当前目标是 `sd2.youdooart.com` 或服务器版 `sd2`，除非用户明确要求“只做本地/只做代码”，否则自动完成候选构建、服务切换及必要的版本、健康、公网可达性检查，不自动做 DOM/截图或业务 API 功能验收。
- 用户反馈线上 `sd2.youdooart.com`、当前浏览器页面或已发布页面仍未生效时，必须把服务器部署作为任务范围：检查服务器 `/srv/video-api-debugger/app/.next-prod/BUILD_ID`、`sd2-gray.service`、`127.0.0.1:3302`、nginx 和公网 `https://sd2.youdooart.com`，不要回到 Mac `youdoo-sites` 链路。
- `systemctl is-active sd2-gray.service` 只能证明进程健康；还须通过公网版本/构建标识或对应静态资源确认新产物已发布，但不代替用户手动验收。
- 发现已有未提交改动时，不回滚、不覆盖非本轮产生的变更；若影响本轮任务，应先说明冲突和处理方式。
- 输出汇报时明确列出实际修改文件、验证命令、验证结果、风险与遗留问题。

## 按需审核线程规则

- 本项目固定审核线程为 `审核001 - sd2 固定只读审查`，thread id：`019f44c6-64d3-7753-acd0-f31fc16763fb`。
- 仅用户明确要求独立审查、审核或只读复查时，交给该审核线程；默认不派审核、不等待审核再部署，功能验收由用户手动完成。下列规则只约束明确启动的审核任务。
- 审核线程默认审查实际生产工作树 `/Volumes/Data/Projects/video-api-debugger-v12-full-todo`，除非工单明确指定其他路径。
- 审核线程严格只读：不得修改源码、配置、数据库、构建产物、生产数据，不得提交 Git、推送、打 tag、部署或补实现。
- 审核过程中发现的问题，统一记录到固定文档 `tasks/audit-001-review.md`；该文档是审核记录唯一允许写入的项目文件，记录只追加审核发现，不做实现修复。
- 每条审核记录必须写清：日期、审查对象、结论（通过/不通过）、阻塞问题、非阻塞风险、证据、建议下一步。
- 审核完成后，审核线程必须回到发起线程同步结果，固定收尾语为：`审核完成，等待推进`。同步内容必须包含通过/不通过、证据、缺口和下一步。

## Codex 禁止事项

- 未经明确授权，不得修改 `src/**`、`prisma/**`、`package.json`、`package-lock.json`、`tsconfig.json`、`.env`、`public/**`、`storage/**`、`.next/**`、`.vercel/**`。
- 不得安装依赖、升级依赖、删除依赖或改动锁文件，除非任务明确要求。
- 不得执行数据库写入、迁移、`db:push`、种子脚本或会改变本地/远端数据的命令，除非任务明确要求。
- 不得修改点数、登录、权限、支付、鉴权、中间件、Provider 适配、上传、外链拉取等高风险业务逻辑，除非任务明确要求且边界清晰。
- 实现完成后默认自动聚焦提交、推送并登记版本；功能验收不是提交或部署的等待条件。分支策略或风险边界不适合直接推送时，使用隔离分支等安全方式，不让改动只留在本地。
- Git 上传不需要用户二次确认：实现完成且存在已配置 remote 时，默认自动 commit、push、创建必要 rollback tag、远端复核和版本登记；没有 remote、认证/网络或必要安全检查失败、疑似敏感文件、会覆盖他人改动或需要破坏性 Git 操作时暂停报告。
- 用户说“上传 Git / 做 git / 形成版本 / 方便回退”时，完成标准是远端可回档：对应 commit 必须推送到 remote，稳定回退点必须创建并推送语义清晰的 rollback tag 或等价保护分支，并用 `git status --short --branch`、`git ls-remote --heads`、必要时 `git ls-remote --tags` 验证远端可见。
- 禁止自动 force push、删除远程分支、覆盖用户提交、破坏性发布或不可回滚部署；这些操作必须得到用户明确确认。
- 不得读取、打印、复制或泄露 `.env`、密钥、token、cookie、数据库凭据等敏感信息。
- 不得把 Claude Code 的只读分析结论扩展成未经确认的事实；不确定时应标注为推断。

## 每次完成后的汇报格式

1. 改了哪些文件：
   - 列出实际修改的文件路径。
2. 每个文件具体写了什么：
   - 简述每个文件新增或修改的核心内容。
3. 跑了哪些发布检查：
   - 列出必要构建、版本、服务健康与公网检查；文档修改只列差异检查。
4. 部署与验收状态：
   - 分开说明部署检查结果和“待用户手动验收”；不把未执行的功能验收写成通过。
5. 是否存在越界或风险：
   - 明确说明是否改出任务边界，是否触及高风险区域。
6. 遗留问题与下一步建议：
   - 如无则写“无”。
7. 统一 diff：
   - 提供本轮允许范围内文件的 `git diff`。
