# 设置保存成功关闭统一修正

项目：video-api-debugger
工单版本：1.0.0
正式版本来源：package.json，应用 src/lib/release.ts 和既有 ReleaseNotice 共用
开工需重锁版本：是，发布前重新核对生产 commit、BUILD_ID 和发布活动
目标路径：/Volumes/Data/Projects/video-api-debugger
正式入口：https://sd2.youdooart.com
状态：实现完成；最终候选构建与正式发布中，功能待用户手动验收
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
| S2 | 提交与正式发布 | 可回退、正式站新版本可访问；功能待用户手动验收 | 进行中 |

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
- [ ] 全部修改后统一 git diff --check、完整差异只读复核；仅执行发布需要的 Next.js 候选 build（含 lint/type）。初候选通过，复核补齐返回覆盖与未保存保护后仅重建最终影响范围。
- [x] 共用 SemVer 版本来源升一次 PATCH，更新现有 release 摘要，不重复新建更新系统；外部账号摘要仍按既有隐藏约定处理。
- [x] 保护未提交工作，用隔离分支 codex/settings-save-close-20261004；基于生产 138a2c70493ff91a87feab1de4a6aebd76f2c0fa 的仅文档后继 0927aa1f，代码等价已核对。
- [x] 精确暂存 UI、版本及本工单；推送 origin（github.com/goukiyang/seedance-api-debugger），推送指向上一生产的 rollback 标签。
- [ ] 核对发布活动、线上源码/build，登记预约并取得服务器 flock；git archive 精确提交，排除资料、密钥、数据库、上传和运行目录。
- [ ] 不可变 release 中候选构建，保持 live .next-prod 不原地构建；保护原 source/build、持久软链接及图片 worker，不重启 worker。
- [ ] 成功切换后确认系统服务、公网 release/config/login、相关新静态资源及实际 BUILD_ID；失败恢复原 source/build，不覆盖数据库。
- [ ] 正式根保存统一 diff 和发布证据；同步 S1/S2 状态、版本及实际入口。

手动验收：图片/视频通用与模块设置保存一次后退出；人为保存失败留住输入并可重试；保存中继续输入的未提交草稿不丢；API 设置无其他修改时回入口，其他表单未保存时不离开；即时保存/应用/主工作台不误关；外部/Esc 和重开焦点沿用共享机制。未执行这些功能场景不得宣称通过。

## 开源依据与方案选择

[Radix Dialog 异步提交后关闭](https://www.radix-ui.com/primitives/docs/components/dialog#close-after-asynchronous-form-submission)：已读官方受控 open 示例，等待提交完成再关闭。
[Ant Design ActionButton 实现](https://github.com/ant-design/ant-design/blob/master/components/_util/ActionButton.tsx)：已读实际 Promise 成功/失败分支，成功关闭，失败取消 loading 且不关闭，clickedRef 阻止重复。借鉴状态处理，复用现有 React 和 useDialogDismiss，无新库或拷贝源码，非声称已运行开源例子。

## 停止条件与收尾

实际生产源码变化或发布锁冲突时重新核对并移植本轮窄改，不覆盖他人发布；候选失败、缺关键返回、回退点缺失、服务或公网不一致时不强行切换。生产数据与凭据不读取、不回写。非独立自行 Review，不冒充用户功能验收。最终源码 ec34a4c28d6c0cf3e65801b69141175b9ded5e09 已推，rollback/2026-10-04-before-settings-save-close 指向上一生产，远端已核对；正式发布证据待补。

## 实际文件与内容

应用改动17个文件：图片 global-settings-dialog.tsx/settings-controller.ts/studio.tsx 确认返回、草稿比较和成功关闭；视频 VideoContextEditor.tsx/VideoTemplateWorkbench.tsx 成功退出、保存中输入保护；旧模板 TemplateEditorDrawer.tsx 统一成功返回与退出，AdminTemplatesClient.tsx/TemplateLibraryClient.tsx/GenerationComposer.tsx 三调用方适配；后台 AdminIntegrationsClient.tsx/BananaImageChannel.tsx 多表单提交/脏值与等待保护；AppShell.tsx/settings-return.ts 记住并校验真实来路（同源、有效功能路径、保留query/hash）；use-settings-page-submit.ts 共用提交锁、其他未保存保护，复用原 useUnsavedNavigation 的刷新/更新/离开保护，不存凭据；package.json/package-lock.json 仅同步版本，无依赖图变化；release.ts 替换真实用户摘要。

配套4个固定记录：本工单、tasks/todo.md 仅增加索引、docs/materials/index.md 仅追加本轮资料入口、tasks/todo/hygiene-log.md 自动工具最小记录；正式主目录另有[统一diff](2026-10-04-settings-save-close.diff)，是完整本轮应用与工单差异，不含其他任务的未提交内容。

config/page.tsx 为只读状态/测试，不含保存；admin/integrations/aimediakit/page.tsx 复用同一后台组件，无额外复制。旧候选9782c72的完整build通过，BUILD Uay72Q1JcKs6X_LH3JvbX；自行复核后放弃未切换候选，脚本退出 synced=0/moved=0，原线上未动。普通账号sudo不可用，按既有服务器技能核对并复用 root SSH 入口，构建仍以 gouki 运行，不修改权限或单元。

发布活动复核（20:33）：主线程已登记 v0.39.0，commit 54f67d1668ea0bd23d96630860e6c8bd2e651f15。本轮 ec34a4c 旧基线候选停止上传，待新生产发布完成后，只在隔离分支合入已发布源码并重算 PATCH 为 v0.39.1，保留对方新功能；重新核对 build、回退点和发布锁后继续。不得覆盖或干预主线程。
