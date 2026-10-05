# SD2现有抠图全功能升级交接

project: SD2视频创作平台（video-api-debugger）
target_path: /Volumes/Data/Projects/video-api-debugger
version: 1.1.0（本工单；已发布应用v0.46.0）
version_source: SD2交付worktree/package.json；上游参考AI Cutout Web frontend/package.json及SDK sdk/pyproject.toml
relock_before_execution: true
status: 已部署v0.46.0，待用户手动验收；原入口升级及安全验证完成，真实业务接通和模型效果未验收
risk: L4有界接口、上传与可回退发布；不创建凭证、不付费、不覆盖生产业务数据
updated_at: 2026-10-06 Asia/Shanghai

**用户要求**：SD2原本已有抠图，只是功能原始、没更新。现在升级原入口，接上 AI Cutout Web 的完整能力。本工单只说明功能和运作事实，具体页面、适配、分工及实现由 SD2 项目 agents 解决，不另造平行工具。

## 现有什么功能

| 能力 | AI Cutout Web 已有内容 |
|---|---|
| 普通抠图 | 文件上传/粘贴、模型选择、透明PNG及mask；背景移除、边缘平滑、残留清理、孔洞修复、细节保护、阴影保留六项调整，以及高级透明度/边缘参数与预设 |
| 角色图拆切 | 完整角色框→每个角色单独抠图→按透明范围裁剪；支持自动/手工框与提示点，输出逐角色PNG/mask、总览、清单及ZIP；手工辅助与自动效果需区分 |
| 结果继续处理 | 裁剪、拆分预览、框选拆分、合并、导出；参数可提交任务；画笔细修、角色编辑撤销/重做属于网页前端能力，不能当成已有服务端接口 |
| 任务与记录 | 提交、排队/执行状态、分页历史、结果下载、幂等防重复；可取消排队任务，运行中的取消会冲突，不能承诺立即停止计算 |
| 接入方式 | 版本化 `/api/v1` 任务接口、旧 `/api/integration` 兼容接口、Python SDK 0.1.0；SDK有上传/提交/等待/取消/历史/下载，角色和拆分使用通用任务类型 |

SD2已有 `/cutout` 和 `/api/cutout`：能力查询、抠图、角色拆图及原有三项调整仍是升级基础。项目AGENTS记录的部署源是 `/Volumes/Data/Projects/video-api-debugger-v12-full-todo`，其相关文件与本资料根不同；该源导航标管理员入口。本轮未核线上配置/角色可见性，不把旧源码观察当线上证明。

## 怎么运作

入口：**https://cutout.youdooart.com/**，当前已登记网站v0.3.0、运行源29824dd；正式源码 `/Users/gouki-youdoo/work/ai-cutout-web`。

**网站/调用方上传文件→服务器校验并保存原图、建立任务→队列把任务交给Mac→Mac下载原图并计算→结果回传服务器→查询状态、预览或下载。** 服务器保存任务、输入和结果，Mac负责计算；Mac不在线时不能把任务描述成已完成。结果与历史按所属身份隔离。

新版接口事实：`POST /api/v1/assets` 用 multipart `file` 上传文件本体；`POST /api/v1/jobs` 传 `asset_id/kind/parameters`，可带 `Idempotency-Key`；`GET /api/v1/jobs/{job_id}` 查询，`GET /api/v1/jobs/history` 分页历史，`DELETE /api/v1/jobs/{job_id}` 取消排队任务，`GET /api/v1/results/{job_id}/{filename}` 下载。kind 包括 `cutout/characters/crop/split_preview/split_export/split_merge/split_region`。没有直接接收 `fileURL` 的新版上传接口，嵌套参数以源码/SDK为准。

外部业务凭据、管理员凭据和Mac执行器凭据是不同身份；SD2实际使用哪种身份及用户归属尚未确定。凭据不能交给浏览器，不用管理员/Mac凭据代替业务身份，也不能靠放开跨站权限解决。后续需要新的凭据、权限或付费时按项目授权处理，本轮没有创建。

## 已验证与仍有缺口

- **已验证记录**：新域名HTTPS、真实页面及只读身份边界通过；公网SDK曾完成普通抠图、16角色、透明裁剪、拆分→合并→导出、排队取消与身份矩阵。普通任务真实使用MPS，16角色SAM真实使用CPU。以上是已有证据，本轮不重跑。
- **不能称“全功能质量通过”**：整体仍为部分验收。网页上传曾被调试工具权限拒绝；fileURL相关工具授权待答（也不代表API支持URL上传）；注销登录/整机重启、有图刷新恢复未验；拆分预览完成回执超时及异常队列消息未核清；角色质量C2及完整能力C3仍未关闭。原图、真实结果和手工辅助参数随工单保留。

## 原文与附件

正式附件目录：[docs/materials/2026-10-06-ai-cutout-upgrade](../../docs/materials/2026-10-06-ai-cutout-upgrade/)，[来源及校验清单](../../docs/materials/2026-10-06-ai-cutout-upgrade/附件来源与校验.json)。原件仍保留在 AI Cutout Web；媒体仅本地归档，不推公开仓。

- [16角色原图](../../docs/materials/2026-10-06-ai-cutout-upgrade/原图/355d707027284cdeb3d9c84b229a82d7.jpg)及机械/三视图两张原图：识别质量与复杂边缘参考；原角色用户文件名与失效缓存来源见清单。
- [v0.3.0真实16角色总览](../../docs/materials/2026-10-06-ai-cutout-upgrade/真实结果-v0.3.0/roles16-contact-supervisor.png)、同目录16份PNG/mask、manifest与roles.zip：真实产出参考，不当成全自动质量PASS；[历史辅助参数](../../docs/materials/2026-10-06-ai-cutout-upgrade/历史辅助参数/角色验收参数_v0.2.0.json)保留版本区别。
- [新版API源码](../../docs/materials/2026-10-06-ai-cutout-upgrade/接口参考/routes_v1.py)、[任务结构](../../docs/materials/2026-10-06-ai-cutout-upgrade/接口参考/server_api.py)、[参数](../../docs/materials/2026-10-06-ai-cutout-upgrade/接口参考/cutout_settings.py)、[SDK及示例](../../docs/materials/2026-10-06-ai-cutout-upgrade/接口参考/sdk/client.py)。[旧API文档](../../docs/materials/2026-10-06-ai-cutout-upgrade/接口参考/第三方API接入文档_v1.md)只解释兼容接口，旧鉴权/域名说明不能代替新版事实。
- 当前状态原文：`/Users/gouki-youdoo/work/ai-cutout-web/docs/todo/2026-10-03-mac-api-migration.md` 文末A1及M1–M7；背景原文已复制到附件接口参考目录。

## 本轮收口

| 编号 | 任务 | 完成标准 | 状态 |
|---|---|---|---|
| S1 | 编写 SD2 全功能接入工单 | 依据真实接口，列清接入项、缺口、验收及附件，并归档登记 | 已完成；只文档交接 |

验证限于正文、链接、关键附件可读及复制一致、聚焦Git差异；不实施应用、测试业务、重跑模型、部署、收费或跨聊天发送。SD2远端实核为公开仓，本轮仅本地聚焦提交；原脏改保留。具体接入由项目agents自主调查并决定，仍须区分已有能力、实际接通和真实效果。

## 升级实施计划（2026-10-06，用户已授权）

本节为当前实施记录；上方“本轮收口/S1”保留历史交接范围，不代表本次仍只做文档。任务只升级SD2视频创作平台的 `/cutout` 与 `/api/cutout`，不新造平行工具。明确停止条件：新增权限/凭证创建、费用、生产数据覆盖；不修改登录、点数、数据库或导航可见范围，不安装依赖。正式资料保持本机归档，不随公开Git或部署包外传。

| 编号 | 任务 | 完成标准 | 状态 |
|---|---|---|---|
| CUT1 | 升级现有抠图 | 工单要求接入原功能，失败可恢复、原图保留 | 受阻；实现已发布，生产业务授权未核实，不能声称完整实接 |
| CUT2 | 验证实际接通 | 完成安全范围内的接口与操作验证，明确未验证项 | 受阻；73项隔离检查及只读公网检查通过，生产账号/真实模型未验证 |
| CUT3 | 发布与交付 | 提交推送、可回退部署，记录实际版本与结果 | 已完成；源码/回退点已推送，候选构建及公网新产物核对完成 |

### 当前证据与接入选择

- 开工时公网SD2为v0.45.0，生产BUILD_ID `KbJIPWhOPLhIslbk70m-a`。本轮从相同源码的 `bf71a45c469c139ad8936ac79698a896c7902323` 隔离到 `worktrees/cutout-upgrade-20261006`；主目录旧应用与他人未提交记录不作为部署源。最新发布状态见下方，不把开工记录当当前线上状态。
- 原代理默认 `127.0.0.1:8098`，2026-10-06只读检查该端口无服务。新版 `https://cutout.youdooart.com/api/v1/capabilities` 实际返回Mac在线、队列可用。当前源 `5dbb013729e2801a29b101a2ed6c2eeda9469459`，上游脏改不改动；参考原生worker和后端接口真实字段，不只靠旧文档。
- 采用现有Next.js代理、原生fetch/FormData、已有lucide及SD2图片预览/近时组件；直接适配用户所有的AI Cutout Web参数与Canvas修图逻辑，无第三方新包。SDK Python语言与本站不匹配，仅核对协议，避免不必要的Python旁路。
- 升级任务接口：上传真实文件→asset_id→七类处理任务→状态/结果/分页历史，幂等键防重复；禁止转发SD2 cookie、浏览器认证头或上游管理/worker接口。上游不同API Key可能属于同一owner，不能凭密钥不同声称账号隔离：本版 `CUTOUT_BUSINESS_KEYS` 只接受安全服务器配置中一个SD2账号与一个既有授权业务Key的映射，多账号配置全部拒绝。配置只在服务端使用，不借管理员/worker/guest身份、不创建凭证；实际配置未核实，多账号接入未实现。
- UI分层：普通抠图/角色拆切为主操作，六调节与预设直接可达，高级参数/框选提示点/画笔细修按需展开；结果可裁剪、拆分、框选、合并和导出。角色编辑及画笔有有限撤销重做，原图不覆盖。图片缩略图与大图复用本站已有组件。
- 刷新恢复安全参数及任务ID，只GET重新查询，不重新上传/生成；历史按12条分页，第一列稳定预览和近时。失败保留输入、旧结果和重试/重查路径。缺业务授权时明确禁用提交而非空转或冒称已接通。

### 实施与验证顺序

单一lead本地处理代理/身份保护/共同协议/发布；两个不重叠工作包分别改页面参数和编辑组件。全部修改及测试代码完成后冻结版本统一验证，不边测边补。验证范围包括：代理白名单、账号隔离、认证头不外传、上传/幂等/结果引用、排队取消与失败恢复、安全设置和GET找回、原图/修图/导出路径；费用0、不覆盖业务数据。真实授权缺失或工具安全拒绝时停止相应操作，明确接口模拟不冒充真实模型效果。构建/发布核对、业务链路和质量证据分开登记。

发布只用本轮精确commit归档、隔离候选构建、与运行源码/BUILD核对、既有部署锁、回退源码及构建保护；不原地构建live目录，不同步 `.env*`/DB/上传素材。保留既有更新弹窗，仅更新该产物实际版本和摘要。旧工作区或并行发布漂移会阻断切换，不能用聊天锁冒充物理防覆盖。

相关附件仍沿用本工单“附件清单”及 `docs/materials/2026-10-06-ai-cutout-upgrade/附件来源与校验.json`；原图用于接入/质量参考，旧手工辅助结果不冒称新自动效果。

### 实现与安全验证（2026-10-06）

- 交付源码：`worktrees/cutout-upgrade-20261006`，分支 `codex/cutout-upgrade-20261006`；主目录旧源码与既有脏改保留。已发布应用v0.46.0，版本仅来自package.json，无依赖安装或升级；保留既有升级弹窗、共享大图/手机返回及近时组件，旧客户端实际更新弹窗未另做登录态验收。
- 原入口已加入普通/角色模式、六项调节/五预设、高级参数、角色框与前景/背景点、裁剪/拆分/框选/合并/导出、分页记录、结果PNG及mask/ZIP实际可用时下载、本地画笔细修。画笔输出新文件，不覆盖原图。合并要求已知且相同的全图坐标；裁剪图不能凭空冒充全图。缺原图或尺寸不匹配时禁用恢复画笔。
- 提交前保存原幂等标识和参数；断线/服务5xx表示“受理未知”，刷新只读查询，明确重试才沿用原标识提交。未知时仍能查看历史，不自动认领相似任务、不另建任务。连续点击同步防重；页离开、修改原图和未应用画笔保留现有保护。
- `node --import tsx scripts/cutout-contract-smoke.ts`：44项通过，仅内存代理协议/白名单/凭证边界/结果引用/受理未知检查；非真实上游任务。
- `scripts/cutout-browser-smoke.ts`：29项通过，实际React组件+Canvas/桌面与390px手机宽度，用合成PNG及模拟API；验证像素坐标/撤销/画笔PNG和mask/粘贴清除/防重/刷新/原标识重试/未知状态看历史。真实模型任务0、费用0、外部请求0。[报告](../../docs/materials/2026-10-06-ai-cutout-upgrade/实施记录/final-check/browser-check.json)、[桌面页面](../../docs/materials/2026-10-06-ai-cutout-upgrade/实施记录/final-check/cutout-desktop.png)、[手机页面](../../docs/materials/2026-10-06-ai-cutout-upgrade/实施记录/final-check/cutout-mobile.png)、同目录editors-desktop.png/editors-mobile.png为隔离检查截图，不是生产管理员界面或真实模型结果。
- 聚焦只读审查修复：多Key同owner串号风险收窄为单账号；5xx不能谎报未提交；回退某步骤失败仍继续尝试恢复其余步骤；服务停止窗口收到信号必须恢复并非零退出。审查与脚本语法检查不等于故障注入或实际回滚演练。
- 未通过/未完成检查也保留：旧 `enhance-video-entry-smoke.ts` 在已有“无线画布”导航字面断言失败，未改无关导航；独立本地tsc/lint耗时无结果已终止，不算通过，发布候选Next构建仍须完成。真实Chrome接续在Cua/ClickOps超时，bsk无连接，现有Chrome仅其他项目页签未占用；不安装扩展或伪造实际登录态。
- 实际模型上传/普通抠图/16角色质量/续处理完整闭环、生产管理员页面与实际业务授权均未验证；此前上游C2/C3缺口仍开放。本次没有新建凭据、修改.env/登录/权限/点数/Provider/数据库，不使用旧结果冒充新验收。
- 开源参考：已读[Next.js 14 Request实现](https://github.com/vercel/next.js/blob/v14.2.35/packages/next/src/server/web/spec-extension/request.ts)适配流式代理，复用已有[Playwright](https://github.com/microsoft/playwright/blob/main/LICENSE)进行隔离检查；无新包。原生AI Cutout Web参数和worker实现为用户项目内协议来源，不泛称其未知许可证为MIT。

### 发布与交付事实

- 北京时间2026-10-06 03:47发布核对：`https://sd2.youdooart.com/cutout`；v0.46.0，源码 `353f339603d6bf6d923fb09d79e24410fadc1167`，BUILD_ID `UG_Av_AwnF45orH5-oQgI`。服务器816个源码文件与精确归档相符；上线前803个旧文件与回退归档相符。Next候选构建（含lint/类型）完成，保留已有img/hooks警告，不是无警告构建。
- 公网 `/api/release`、`/api/config`、`/login` 均200且来源 `server-42-193`；13份抠图静态资源SHA与候选相符。独立匿名只读检查中 `/api/cutout/v1/capabilities` 返回401/UNAUTHENTICATED，证明真实入口仍有登录保护，不证明已授权账号接通。上游公开capabilities为200/计算端在线/队列可用；SD2服务器配置与业务绑定未读取或验证，不能把上游健康冒充SD2实接。
- web与image-studio服务active，仅切换web，未停止图像worker。旧构建保存在 `/srv/video-api-debugger/app/.next-prod-prev-cutout-353f339603d6`，旧源在 `/srv/video-api-debugger/releases/545d9d6f3bbf9d0299fc1d34ac136b02958536aa-cutout-rollback-source`；回退至v0.45.0/旧BUILD已留保护，未主动故障注入或执行回滚。
- 公开Git仅推本轮应用代码分支、`rollback/2026-10-06-before-cutout-upgrade-v0.46.0`（545d9d6）和 `release/v0.46.0-cutout-upgrade`（353f339），不推主目录旧未发布提交或私人原图/结果/资料。正式工单和证据本机归档；共享todo/索引的无关脏改保留。
- [构建日志](../../docs/materials/2026-10-06-ai-cutout-upgrade/实施记录/build-server.log)、[服务器44项报告](../../docs/materials/2026-10-06-ai-cutout-upgrade/实施记录/contract-server.json)、[候选内容](../../docs/materials/2026-10-06-ai-cutout-upgrade/实施记录/candidate.json)、[公网静态匹配](../../docs/materials/2026-10-06-ai-cutout-upgrade/实施记录/public.json)、[独立匿名检查](../../docs/materials/2026-10-06-ai-cutout-upgrade/实施记录/public-readonly.json)、[运行与回退](../../docs/materials/2026-10-06-ai-cutout-upgrade/实施记录/runtime.json)、[上游公开状态](../../docs/materials/2026-10-06-ai-cutout-upgrade/实施记录/upstream-public.json)、[完整统一diff](../../docs/materials/2026-10-06-ai-cutout-upgrade/实施记录/source.diff)均为本次证据，不替代上方历史原件。
- 下一步：核实目标SD2账号已有的专用业务凭证与服务器安全配置位置，先做该账号只读能力/历史核对，再在明确无费用且不覆盖数据的范围做真实上传和出图。没有既有授权、需要创建凭证/扩权限/收费时停止相应动作。本次已问安全配置位置，未收到答案，不反复确认或擅自配置。C2/C3质量与完整流程缺口继续开放。
- 守门员：按有界L4处理代理/上传/受理未知/发布保护，只有安全范围已验证；没有越界操作，分级/归类误判记录无。费用0、真实模型任务0；没有数据库迁移/点数/鉴权/Provider修改或生产数据覆盖。

### 实际文件

应用改动均在 `worktrees/cutout-upgrade-20261006/`，共19文件：

| 文件 | 实际内容 |
|---|---|
| `src/app/cutout/page.tsx` | 升级原页、异步任务/历史/继续处理、原标识恢复和提交防重 |
| `src/app/cutout/cutout.module.css` | 桌面/手机布局、稳定预览与工具层级 |
| `src/app/api/cutout/[[...path]]/route.ts` | 原登录/管理员入口复用，共享安全代理 |
| `src/lib/cutout/proxy.ts` | 路径/方法白名单、单账号服务器凭证、受理未知、私有结果引用 |
| `src/lib/cutout/client.ts` | 上传/提交/状态/历史/取消/下载与统一错误处理 |
| `src/lib/cutout/types.ts` | 原生设置、7类任务及结果/框/提示点字段 |
| `src/lib/cutout/settings.ts` | 6调节/5预设、校验与按账号保存偏好及未确认提交 |
| `src/components/cutout/CutoutSettingsPanel.tsx` | 设置面板及高级参数 |
| `src/components/cutout/CharacterBoxEditor.tsx` | 像素坐标角色框、命名、前景/背景点、撤销重做 |
| `src/components/cutout/RegionSelector.tsx` | 继续拆分区域的像素选区与清除 |
| `src/components/cutout/BrushRepair.tsx` | 4画笔、插值、有限历史、新PNG/mask及未保存保护 |
| `src/components/cutout/editors.module.css` | 编辑组件响应式样式 |
| `package.json`、`package-lock.json` | 仅应用/锁元信息版本v0.46.0，不改依赖 |
| `src/lib/release.ts` | 既有升级机制使用的真实更新摘要 |
| `scripts/cutout-contract-smoke.ts` | 44项隔离代理检查 |
| `scripts/cutout-browser-smoke.ts` | 29项真实组件+合成图片+模拟API检查 |
| `scripts/check-cutout-release.mjs` | 候选内容及公网版本/资源校验 |
| `scripts/enhance-video-entry-smoke.ts` | 旧检查的cutout鉴权断言改为共享代理入口；全脚本仍因既有导航断言失败 |

正式根另更新本工单、`AGENTS.md`当前部署源、`tasks/todo.md`及`docs/materials/index.md`；`实施记录/`存本轮检查/统一diff及发布保护脚本。所有文件入口与原图/历史结果都保持在正式项目根，不以临时目录代替交付。
