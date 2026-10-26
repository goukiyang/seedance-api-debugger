# 设置保存成功关闭统一修正

项目：video-api-debugger
工单版本：1.0.0
正式版本来源：package.json，应用 src/lib/release.ts 和既有 ReleaseNotice 共用
开工需重锁版本：是，发布前重新核对生产 commit、BUILD_ID 和发布活动
目标路径：/Volumes/Data/Projects/video-api-debugger
正式入口：https://sd2.youdooart.com
状态：v0.39.1 已部署；实现与发布检查完成，功能待用户手动验收
风险等级：UI L2；服务器发布 L3，回退及数据保护必需
最后更新时间：2026-10-04（Asia/Shanghai）

## 目标与边界

来源：用户先确认跨项目规则“设置保存成功后关闭”，随后明确“写工单，排查项目同情况，一起修改”。用户仅提供文字，本轮无新图片、视频或音频附件。

显式保存/确定须等校验通过、实际保存成功后关闭设置层；失败或未确认结果保留输入。独立二级设置页返回真实来路，无有效来路返回所属功能页。保护同时编辑其他设置、保存中产生的新输入；不增加成功确认步骤。保留即时保存、应用、保存并继续、主工作台的持续编辑语义。

不改生成、点数、登录、权限、支付、Provider、数据库、上传及实际配置内容；只改设置提交后的前端行为。无依赖安装，无业务或浏览器功能验收，无子 agent。已授权自动提交、推送、候选构建、正式发布；实际效果由用户手动验收。

## 固定任务清单

| 编号 | 任务 | 完成标准 | 状态 |
|---|---|---|---|
| S1 | 工单、同类排查与统一修正 | 工单存入项目；设置保存成功后关闭，失败保留输入 | 已完成（实现，功能待手动） |
| S2 | 提交与正式发布 | 可回退、正式站新版本可访问；功能待用户手动验收 | 已完成（部署检查；功能待手动） |

## 同类排查与处理

| 入口 | 代码及原因 | 处理 |
|---|---|---|
| 图片通用上下文 | global-settings-dialog.tsx 不等待保存；settings-controller.ts 吞掉失败且无可判定返回值 | 返回实际保存结果；确认修订号推进后关闭，无新输入才关闭 |
| 图片模块上下文 | studio.tsx 保存模块配置后未关闭 native dialog | 仅设置弹窗保存/重试入口关闭；保存期间出现新草稿则保持打开 |
| 视频通用/模块上下文 | VideoContextEditor.tsx 更新已保存值但未退出 | 同步已保存值，确认结果后关闭；失败/迟到响应/新输入保护 |
| 旧模板编辑抽屉及卡片编辑 | TemplateEditorDrawer.tsx 由三个调用方控制关闭，失败返回 void；保存期间编辑仍可改变 | 共享组件按 boolean 成功结果退出；提交锁及字段锁定；三个调用方返回真实结果 |
| 视频模板草稿编辑 | VideoTemplateWorkbench.tsx 本已成功后关闭，但编辑控件保存中仍可输入 | 保持关闭行为，补提交中编辑保护 |
| 后台 API 设置页（六组及 Banana） | AdminIntegrationsClient.tsx、BananaImageChannel.tsx 保存后停留；多表单同时编辑 | 共用提交锁，缺完整保存返回不退出；其他表单脏值保留，无其他修改才安全返回来路 |
| 参考图备注、分享/收藏/偏好、上下文卡片 | 即时保存或“应用”，已按各自模式工作 | 不因单字段保存关闭 |
| 画布保存、模板主编辑页、项目详情中的内嵌设置、额度规则草稿、反馈详情 | 常驻工作台/业务编辑而非临时设置层；额度发布及反馈处理有后续动作 | 不机械关闭整个工作台，不改变业务发布或审批 |

## 实施与验证

- [x] 整批实现上述 UI 及共享调用配套，正式主目录登记工单和资料索引。
- [x] 整批修改后 git diff --check 与自行差异复核通过；最终 v0.39.1 候选 Next.js build（含 lint/type）通过。仅已有图片优化等非阻塞警告，未改无关代码；非独立审核、非功能验收。
- [x] 共用 SemVer 版本来源升一次 PATCH，以最终发布前 v0.39.0 递增为 v0.39.1，更新现有 release 摘要，不新建更新系统；原 ReleaseNotice 的检查、SemVer、稍后、手动重查和未保存刷新保护沿用，外部摘要继续隐藏。未操作旧客户端功能验收。
- [x] 保护未提交工作，用隔离分支 codex/settings-save-close-20261004；首次基于生产 138a2c7 的代码等价文档后继 0927aa1f；发布前合入新生产 v0.39.0 的 54f67d1，只保留本轮窄改。
- [x] 精确暂存 UI、版本及本工单；推送 origin（github.com/goukiyang/seedance-api-debugger），推送指向上一生产的 rollback 标签。
- [x] 核对发布活动、线上源码/build，登记预约并取得服务器 flock；git archive 精确提交，排除资料、密钥、数据库、上传和运行目录。
- [x] 不可变 release 中候选构建，保持 live .next-prod 不原地构建；保护原 source/build、持久软链接及图片 worker，不重启 worker。
- [x] 成功切换后确认系统服务、公网 release/config/login、相关新静态资源及实际 BUILD_ID；失败恢复原 source/build，不覆盖数据库。
- [x] 正式根保存统一 diff 和发布证据；同步 S1/S2 状态、版本及实际入口。

手动验收：图片/视频通用与模块设置保存一次后退出；人为保存失败留住输入并可重试；保存中继续输入的未提交草稿不丢；API 设置无其他修改时回入口，其他表单未保存时不离开；即时保存/应用/主工作台不误关；外部/Esc 和重开焦点沿用共享机制。未执行这些功能场景不得宣称通过。

## 开源依据与方案选择

[Radix Dialog 异步提交后关闭](https://www.radix-ui.com/primitives/docs/components/dialog#close-after-asynchronous-form-submission)：已读官方受控 open 示例，等待提交完成再关闭。
[Ant Design ActionButton 实现](https://github.com/ant-design/ant-design/blob/master/components/_util/ActionButton.tsx)：已读实际 Promise 成功/失败分支，成功关闭，失败取消 loading 且不关闭，clickedRef 阻止重复。借鉴状态处理，复用现有 React 和 useDialogDismiss，无新库或拷贝源码，非声称已运行开源例子。

## 停止条件与收尾

实际生产源码变化或发布锁冲突时重新核对并移植本轮窄改，不覆盖他人发布；候选失败、缺关键返回、回退点缺失、服务或公网不一致时不强行切换。生产数据与凭据不读取、不回写。非独立自行 Review，不冒充用户功能验收。最终源码 9c8a9ac9af5894f552e8b9d0d30b95cb47442c15 已推；发布前生产已更新为 54f67d1668ea0bd23d96630860e6c8bd2e651f15 / v0.39.0 / BUILD oxKFErSV4OZB-19N8xJKh，隔离分支合并这一源码，新增 rollback/2026-10-04-before-settings-save-close-v0391 回退点，原 v0.38.0 标签保留；最终发布检查通过，完整证据见下。

## 实际文件与内容

应用改动17个文件：图片 global-settings-dialog.tsx/settings-controller.ts/studio.tsx 确认返回、草稿比较和成功关闭；视频 VideoContextEditor.tsx/VideoTemplateWorkbench.tsx 成功退出、保存中输入保护；旧模板 TemplateEditorDrawer.tsx 统一成功返回与退出，AdminTemplatesClient.tsx/TemplateLibraryClient.tsx/GenerationComposer.tsx 三调用方适配；后台 AdminIntegrationsClient.tsx/BananaImageChannel.tsx 多表单提交/脏值与等待保护；AppShell.tsx/settings-return.ts 记住并校验真实来路（同源、有效功能路径、保留query/hash）；use-settings-page-submit.ts 共用提交锁、其他未保存保护，复用原 useUnsavedNavigation 的刷新/更新/离开保护，不存凭据；package.json/package-lock.json 仅同步版本，无依赖图变化；release.ts 替换真实用户摘要。

配套4个固定记录：本工单、tasks/todo.md 仅增加索引、docs/materials/index.md 仅追加本轮资料入口、tasks/todo/hygiene-log.md 自动工具最小记录；正式主目录另有[统一diff](2026-10-04-settings-save-close.diff)，记录发布前生产 54f67d1 到实际发布 9c8a9ac 的本轮应用与配套差异，不含其他任务的未提交内容；收尾状态与检查证据见本工单及下方JSON。

config/page.tsx 为只读状态/测试，不含保存；admin/integrations/aimediakit/page.tsx 复用同一后台组件，无额外复制。旧候选9782c72的完整build通过，BUILD Uay72Q1JcKs6X_LH3JvbX；自行复核后放弃未切换候选，脚本退出 synced=0/moved=0，原线上未动。普通账号sudo不可用，按既有服务器技能核对并复用 root SSH 入口，构建仍以 gouki 运行，不修改权限或单元。

发布活动复核（20:33）：主线程已登记 v0.39.0，commit 54f67d1668ea0bd23d96630860e6c8bd2e651f15。本轮 ec34a4c 旧基线候选停止上传，待新生产发布完成后，只在隔离分支合入已发布源码并重算 PATCH 为 v0.39.1，保留对方新功能；重新核对 build、回退点和发布锁后继续。不得覆盖或干预主线程。

最新源码与安全核对：本轮相对 v0.39.0 仅17个应用文件及固定记录有差异，后台 API、prisma、scripts、auth、Provider、integrations、credits、costs 保持新版原样；package 与 lock 除版本外结构完全相同，未安装或升级依赖。新版快捷模板/历史原上下文代码已保留，未执行功能验收。源码包 SHA256 cf1991fa372dd4ab4c77ac1e1d183ce90b91790fd25f6216fa52616326763b18；候选只使用该已推提交。

## 最终发布回执

- 应用 v0.39.1；源码 9c8a9ac9af5894f552e8b9d0d30b95cb47442c15；BUILD_ID Bh-CIEFvI5EM3Y7NndzrU；2026-10-04 20:48（Asia/Shanghai）发布完成。
- 实际应用源码目录：/Volumes/Data/Projects/video-api-debugger/worktrees/settings-save-close-20261004；本正式根仅同步固定记录，不用正式根旧应用代码覆盖生产。
- 最终候选命令：不可变 release 中以 gouki 执行 NEXT_DIST_DIR=.next-prod-candidate npm run build；包含编译、lint 和类型检查，通过后才切换。git diff --check 通过；后台/数据库/依赖图相对 v0.39.0 未变。
- 发布窗口核对、预约和服务器 flock 完成；上传包 SHA256 与本地相同，排除密钥、数据库、上传、运行和私有资料。保留 live build 再切换，未原地构建。
- 实际源码17文件 SHA256 与提交一致；公网 /api/release、/api/config、/login 均200且 X-SD2-Origin=server-42-193，实际版本0.39.1；19项变更静态资源与服务器字节一致，19项未变化资源复用已验证证据。
- sd2-gray.service、sd2-image-studio.service、sd2-video-delivery.timer、sd2-finalize-pending.timer 全部 active；图片 worker PID1241475、启动时间和单元配置前后未变，未重启；storage/uploads/videos 持久软链接、可写性及 .env 文件属性前后保护校验通过，未读取凭据。
- 服务器回退 build：/srv/video-api-debugger/app/.next-prod-before-sd2-settings-close-v0391-20261004-9c8a9ac；发布记录目录：/srv/video-api-debugger/backups/sd2-settings-close-v0391-20261004-9c8a9ac；上版源码 /srv/video-api-debugger/releases/54f67d1668ea0bd23d96630860e6c8bd2e651f15。远端回退标签 rollback/2026-10-04-before-settings-save-close-v0391 指向 v0.39.0；原标签未覆盖。
- [发布证据](2026-10-04-settings-save-close.evidence.json) 与 [统一diff](2026-10-04-settings-save-close.diff) 均在正式根，可读。部署脚本 COMPLETE 后 exit0；发布检查不等于功能验收。
- 守门员：UI L2、发布 L3；独立 Review 未执行（项目约定），自行差异复核已执行。无分类误判；无越界后台/生成/点数/权限/DB修改；唯一遗留为用户手动功能验收。

## 应用文件清单

以下路径均相对实际应用源码目录，不是主线程未提交改动：

| 文件 | 本轮内容 |
|---|---|
| src/app/image-studio/settings-controller.ts | 明确保存结果，校验返回修订，保护新输入 |
| src/app/image-studio/global-settings-dialog.tsx | 等待真实成功再关闭，提交锁 |
| src/app/image-studio/studio.tsx | 模块设置成功关闭，新草稿不误关；保留新版原功能 |
| src/components/template-studio/VideoContextEditor.tsx | 通用/模块上下文保存退出，失败和迟到响应保护 |
| src/components/template-studio/VideoTemplateWorkbench.tsx | 保持成功退出，保存期间编辑及重复提交保护 |
| src/components/templates/TemplateEditorDrawer.tsx | 共享成功结果和退出，编辑与关闭保护 |
| src/components/templates/AdminTemplatesClient.tsx | 调用方返回真实保存结果 |
| src/components/templates/TemplateLibraryClient.tsx | 调用方返回真实保存结果 |
| src/components/GenerationComposer.tsx | 调用方返回真实保存结果，原页面同步 |
| src/app/admin/integrations/AdminIntegrationsClient.tsx | 六组共用提交及其他未保存保护 |
| src/app/admin/integrations/BananaImageChannel.tsx | 通道设置接入共用提交与草稿保护 |
| src/components/AppShell.tsx | 记录同源实际来路，不持久化凭据 |
| src/lib/navigation/settings-return.ts | 安全校验来路及所属页回退 |
| src/lib/hooks/use-settings-page-submit.ts | 提交锁、等待真实状态同步、其他表单保护、刷新保护 |
| package.json | 唯一应用版本0.39.1，无依赖或脚本变化 |
| package-lock.json | 同步根版本，依赖图不变 |
| src/lib/release.ts | 本轮真实更新摘要，既有检测机制不另建 |

## 发给验收对话的内容

```text
设置保存成功关闭验收
项目：video-api-debugger；正式入口：https://sd2.youdooart.com/；当前版本v0.39.1。
工单：/Volumes/Data/Projects/video-api-debugger/tasks/todo/2026-10-04-settings-save-close.md
实现与发布检查已完成，不重复实施或覆盖新生产；由用户手动验证成功退出、失败保留、其他表单和新草稿保护，即时保存/应用/主工作台不误关。
相关资料：同目录2026-10-04-settings-save-close.diff及2026-10-04-settings-save-close.evidence.json；本轮无新增图片/音视频附件，开源原文链接见工单。
未经新指令不自动浏览器验收、发生成、修改配置/数据库或部署；遇版本不符先核对实际源码/build和本工单，不用正式根旧应用代码覆盖。
```
