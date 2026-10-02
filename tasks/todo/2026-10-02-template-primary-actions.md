# 模板主操作与产品弹窗

项目：video-api-debugger（SD2）
正式版本来源：package.json、正式站 /api/release 与服务器生产构建。
目标：https://sd2.youdooart.com/，交付版本 v0.34.2。
源码：/Users/gouki-youdoo/.codex/worktrees/canvas-liblib-layout/video-api-debugger，实际路径 /Volumes/Data/HomeRelocated/gouki-youdoo/.codex/worktrees/canvas-liblib-layout/video-api-debugger。
正式记录：/Volumes/Data/Projects/video-api-debugger；该目录旧应用代码不是部署源。
状态：已部署 v0.34.2，发布检查及正式归档到位；待用户手动验收。
风险：L3，用户可见操作及可回退发布；不改权限、接口、费用、Provider、数据库或依赖。
更新日期：2026-10-02。

## 已确认目标与范围

用户确认“同时修改并部署模板相关页面”。沿用暗色工作台和青绿色主色；保存、确认、生成按当前面板任务突出，取消/辅助保持次级，危险后果使用危险色。不重设计全站，不安装组件库，不生成 mock 图。

| 编号 | 任务内容 | 完成标准 | 状态 |
|---|---|---|---|
| G1 | 全局主操作与弹窗规范 | 明确按钮层级、项目弹窗样式、位置判断及验证要求 | 已完成，supervisor负责；差异证据 /tmp/primary-actions-global-20261002.diff |
| G2 | sd2模板页面优化范围 | 确认本次是否同时实施，保留到项目待办 | 已完成，用户明确批准本批修改及部署 |
| G3 | 模板按钮与产品弹窗落地 | 主操作清楚，业务系统框替换，位置及取消行为符合场景 | 代码已实现并部署，待用户手动验收 |
| G4 | 发布与正式归档 | 候选构建、可回退、公网新版本及项目记录到位 | 已完成，构建/健康/32项公网静态及回退/正式记录证据到位 |

## 实施批次

1. 复用 useDialogDismiss 的原生 dialog、顶层关闭、拖动区分和焦点保护，不另造 layer。
2. 共享 useProductDialog：业务确认等待明确结果；取消、关闭、Esc、外部点击和组件卸载都返回取消，重复触发不覆盖旧决定。短名称在触发入口旁，边界 flip/shift，窄屏或不可见入口回退居中；删除、发布、停用、替换、未保存退出使用居中产品框，初始焦点为取消。
3. 图片模块/分组/风格组、通用设置、参考图备注，视频模板管理/上下文、旧模板编辑/卡片/最近生成和更新前刷新保护接入；GenerationComposer 的两处图集替换为模板上下游共用入口，同批接入。图片模块链接离开保护也复用该确认结果，系统 beforeunload 保留。
4. 修正 image-studio 普通按钮背景及 hover 的选择器优先级，给主要保存/生成独立样式；旧模板 CSS 的 primary 规则就地维护，不全站亮化按钮。管理员生成草稿后主动作转到保存草稿；文案结果的“带到视频生成”突出。原有保存、应用、生成动作及导航不合并。
5. 图片替换仍须明确肯定继续；上传成功前保留旧图，未改上传或后台链路。普通成功、错误继续 inline 提示；不增加结果弹窗。
6. 同批 PATCH v0.34.2，package/lock 仅根版本变化，release 摘要对应用户可见变化。保留更新检测、手动检查、数字 SemVer、稍后去重和点击才刷新；补回前台 visibilitychange 检查。

## 检查与发布计划

- 全部修改及配套完成后统一候选 `NEXT_DIST_DIR=.next-prod-candidate npm run build`（含 Next 内置 lint/type 检查），再整体 source/diff Review。不运行功能回归、浏览器/DOM/截图验收、付费生成或生产数据库写入；画面、边缘定位、触控/键盘实际体验待用户手动验收。
- 实施分支 codex/canvas-liblib-layout，起点 93879b73907ca5ad1b3b4188254b8c36a4d6c235，开工干净。保护正式主目录已有 August todo 脏改、未跟踪计划与 worktrees；正式记录仅精确暂存本轮新增 hunk。
- 当前正式运行 v0.34.1，源码 81de84c4d8d92dc80473086a22f551991c317fb6，BUILD_ID W9QJVKRSi6UatqT56N5OZ，四项服务/定时器 active。以完整 commit git archive，排除运行产物；本地归档完成后计算 SHA 再上传。
- release-window 检查、部署开始 append 返回码与 confirmed、reservation 所有权全部通过才上传。唯一 runId；仅自己的同 run 续跑可继续，其他 run 等待。root flock 保护同步、候选构建及切换；gouki 上传/构建，root 常规切换/重启，不修改权限。
- 保留 81de release、旧 live build 和 pushed rollback tag；任何 gate/append 非0停止后续 live 操作，候选失败或切换后健康/公网不一致恢复旧源码及构建。
- 公网版本/构建、服务健康、config/release/login HTTP 与 X-SD2-Origin、必要静态文件 SHA 对照候选构建。匿名受保护入口重定向只证明鉴权，不代替 UI 验收。

## 资料与依据

本轮无新附件。已有资料及原图仍在正式项目索引，不复制或公开用户原图：

- [固定资料索引](/Volumes/Data/Projects/video-api-debugger/docs/materials/index.md)：按模板、素材、弹窗主题检索入口。
- [统一资源库工单](/Volumes/Data/Projects/video-api-debugger/tasks/todo/2026-10-02-unified-resource-library.md)：当前图片选择及替换保护的上下游实现。
- [风格广场原图](/Volumes/Data/Projects/video-api-debugger/docs/materials/2026-10-02-unified-resource-library/codex-clipboard-c227fe09-9c94-47d3-9259-224ace6380d7.png)：布局/风格使用参考；PNG 1068x1032 可读，复用既有完整性检查。
- [历史模板反馈](/Volumes/Data/Projects/video-api-debugger/tasks/todo/2026-10-01-feedback-template-assets-dialogs.md)：固定图与权限约束及共享关闭底座；其旧本地附件缺失未恢复，不声称全部资料齐全。
- 主操作参考 [Carbon Button](https://www.carbondesignsystem.com/building-blocks/core/components/button/guidelines)，入口定位/关闭参考 [Radix Popover](https://www.radix-ui.com/primitives/docs/components/popover) 与 [MIT 源码](https://github.com/radix-ui/primitives/blob/main/packages/react/popover/src/popover.tsx)。supervisor 已核对源码/许可证，本轮复读官方规范；仅借鉴层级、定位及焦点，不接入新库。
- 已读用全局 interaction-pattern-library 的 Primary Actions and Product Overlays；G1 规则写入不等于 G3 页面已验收。

## 原生例外与缺口

保留浏览器 beforeunload、文件选择、系统权限与密码/认证验证；未扫改非模板业务页面。旧客户端首次拿到 v0.34.2 前仍执行自身旧逻辑。既有工作现场/草稿、URL 优先和刷新恢复入口保持，不持久化危险确认。用户实际画面及交互未自动验收，构建和健康检查不冒充效果达标。

## 发布回执

v0.34.2 已部署到 https://sd2.youdooart.com/。以下为本轮实际文件、命令与证据；不代表功能验收通过。

## 实际文件与内容

| 文件 | 本轮核心修改 |
|---|---|
| package.json | 唯一应用版本升为 0.34.2 |
| package-lock.json | 仅顶层与根 package 版本同步；依赖不变 |
| src/lib/release.ts | 用户可感知的按钮、弹窗更新摘要 |
| src/components/useProductDialog.tsx | 等待用户选择的共享确认/命名框；复用关闭、焦点底座与入口定位 |
| src/components/ProductDialog.module.css | 暗色青绿按钮层级、危险色、手机/边界尺寸和 anchored 定位 |
| src/app/globals.css | 模板 primary 规则就地修正、范围内生成主按钮及状态 |
| src/app/image-studio/studio.module.css | 降低通用按钮背景规则优先级，避免覆盖主按钮；保存/生成实色 |
| src/app/image-studio/studio.tsx | 图片模板、分组、恢复、删除、替换、上下文、草稿及未确定生成改用明确等待的产品确认 |
| src/app/image-studio/global-settings-dialog.tsx | 通用设置保存与确认主按钮 |
| src/app/image-studio/reference-grid.tsx | 参考图片备注编辑保存主按钮 |
| src/app/image-studio/style-groups-view.tsx | 风格/分组命名保存主按钮 |
| src/components/GenerationComposer.tsx | 两处共享图集替换改用产品确认；保持明确肯定后才替换 |
| src/components/ReleaseNotice.tsx | 刷新前未提交内容保护使用产品确认；补回到前台检查更新 |
| src/components/template-studio/VideoContextEditor.tsx | 未保存关闭改用产品确认 |
| src/components/template-studio/VideoPromptResult.tsx | “带到视频生成”作为结果面板主操作 |
| src/components/template-studio/VideoTemplateWorkbench.tsx | 未保存关闭、冲突读取、发布、停用改用产品确认 |
| src/components/template-studio/template-studio.module.css | 主按钮触控尺寸/按下状态；窄屏底部操作换行 |
| src/components/templates/AdminTemplatesClient.tsx | 有草稿后主要操作转为保存草稿 |
| src/components/templates/TemplateContextCardsPanel.tsx | 删除上下文卡片改用产品确认 |
| src/components/templates/TemplateEditorDrawer.tsx | 未保存关闭改用产品确认 |
| src/components/templates/TemplateGenerateClient.tsx | 移除生成记录改用产品确认 |
| src/lib/hooks/use-unsaved-navigation.ts | 捕获离开目标，肯定后才跳转；保留 beforeunload、取消和页面恢复保护 |
| tasks/todo.md | 当前工单入口与实际状态 |
| tasks/todo/2026-10-02-template-primary-actions.md | 本完整工单、逐文件说明、授权/资料与发布回执 |
| tasks/todo/2026-10-02-template-primary-actions.evidence.json | 公网状态与32项静态 SHA 的持久证据；不包含用户素材或凭据 |

正式主目录另更新 docs/materials/index.md 和 tasks/todo.md 的本轮新增入口，不使用该目录旧应用源码。

## 实际发布结果与检查

- 已部署 v0.34.2，待用户手动验收。应用源码 commit `7b6da8395f21ea2677d6dc418f253f8f75c4a71a` 已 push 至 origin/codex/canvas-liblib-layout，并以 `git ls-remote --heads` 确認相同提交。
- 生产 BUILD_ID：`QKD4tRwtUPLxCLCxFc9yU`；`.deployed-commit` 与应用提交相同。正式源包 SHA256：`9884bab6e2b6527a6afb10d4db17f18eaf7876ed191377c512f28bb269e639f8`。1337 项归档，排除运行期文件检查命中0。
- 候选构建命令 `NEXT_DIST_DIR=.next-prod-candidate npm run build` 已通过：编译、Next 内置 lint/type 检查通过。构建日志服务器路径：`/tmp/sd2-template-primary-sd2-template-primary-20261002-fdf6f92-1790916156711-build.log`。既有 CSS start/end 兼容性警告仍在；无编译失败。候选只构建一次，输入通道修复后复用相同 BUILD_ID，不再次升版本。
- 整批 source/diff Review、`git diff --check` 与暂存差异检查通过；TypeScript parser 对16个本轮 TS/TSX 文件解析错误0；限定入口 window.confirm/prompt/alert 搜索0。旧26处业务调用、共享图集2处及图片离开保护1处，共29处改为等待产品确认。依赖比对确认除根版本外无变化。
- `systemctl is-active sd2-gray.service sd2-image-studio.service sd2-video-delivery.timer sd2-finalize-pending.timer` 四项均 active。
- `curl` 本机 `http://127.0.0.1:3302/api/config` HTTP200，`/api/release` 0.34.2。公网 `/api/config`、`/api/release`、`/login` 均 HTTP200，来源标记均 `X-SD2-Origin: server-42-193`。
- 基于生产 app-build-manifest.json 的9个相关路由，32个 JS/CSS 资源公网 HTTP200，SHA256 全部与生产构建相同。命令 `node /tmp/sd2-template-primary-verify.mjs`，完整结果归入 [发布证据](2026-10-02-template-primary-actions.evidence.json)，记录时间 2026-10-02T04:57 前后。
- 匿名 `/template-studio`、`/image-studio`、`/templates` HTTP307 指向正式域名登录，未绕过；`/template-generate` HTTP200。只记录既有入口响应，不把匿名可达当功能、权限或页面效果验收。
- 回退 tag `rollback/2026-10-02-before-template-primary-actions-v0.34.2` 已推送，`git ls-remote --tags` 确认 peeled commit 为原运行 `81de84c4d8d92dc80473086a22f551991c317fb6`。
- 原 release `/srv/video-api-debugger/releases/81de84c4d8d92dc80473086a22f551991c317fb6` 保留；原 BUILD_ID `W9QJVKRSi6UatqT56N5OZ` 构建保留在 `/srv/video-api-debugger/app/.next-prod-before-template-sd2-template-primary-20261002-fdf6f92-1790916156711`。新 release 为 `/srv/video-api-debugger/releases/7b6da8395f21ea2677d6dc418f253f8f75c4a71a`。
- storage、public/uploads、public/videos 原持久目录软链保持；assets/thumbs/thumbnails/backups 可写性检查通过，不改数据库、用户数据、权限或运行配置。
- 发布脚本 `/tmp/sd2-template-primary-deploy.sh` 使用 root flock 排他、gouki 同步/构建、root 常规重启；切换和最终结束指令均在相应 gate 成功后才提交，脚本最终返回0并输出 DEPLOY_COMPLETE。

## 发布窗口与失败保护实录

registry：`/Volumes/Data/Projects/project-version-registry.md`。runId：`sd2-template-primary-20261002-fdf6f92-1790916156711`。各 append 返回0、confirmed=true；每次 gate 都检查返回码和 reservation，未跳过失败继续 live 动作。

- 04:43:26.703Z：初始部署开始登记；04:46:20.250Z：更新为实际 7b6da83 源码并续跑。
- 首次候选构建通过后，普通 SSH 输入通道提前结束，保护脚本触发退出：源码恢复81de，live未切换、旧 BUILD_ID 和四服务均确认正常。04:49:13.934Z 如实登记部署失败。
- 04:50:10.969Z 同 run 续跑：改用本地 PTY + SSH -tt 保持输入，复用相同候选。04:53:58.347Z 再次确认远端提交/回退与发布预约后，才发送 SWITCH。
- 04:57:14.706Z：live已切换且公网/32项静态检查通过，确认部署完成登记后发送 COMPLETE；远程脚本退出0、flock释放。完成记录对应真实运行产物，不把候选构建冒充上线。
- 发布证据脚本最初误把代理 CONNECT 头当站点响应，明确诊断并按最终响应头修正；另使用独立 gouki 输出文件避免覆盖 root 临时文件。不改生产权限，不把取证脚本错误当应用故障；最终完整检查通过。

## 完成边界与回查

守门员 start/finish 已运行，语义按 L3 用户可见可回退发布；工具关键词不能扩展授权。应用实现、候选构建、Git远端、真实公网产物与回退证据到位；没有执行浏览器、截图、DOM、功能回归、付费生成或生产数据写入。无本人的风险分级/任务归属误判；不写全局规则文件。

实际画面、入口旁位置、拖动/触控、取消后上下游和旧客户端更新行为仍待用户手动验收。旧客户端需自行刷新取得新版；既有历史附件缺失仍照实保留，不扩大找回范围。

统一应用差异：
`git diff 93879b73907ca5ad1b3b4188254b8c36a4d6c235 7b6da8395f21ea2677d6dc418f253f8f75c4a71a`；
[完整应用 compare](https://github.com/goukiyang/seedance-api-debugger/compare/93879b73907ca5ad1b3b4188254b8c36a4d6c235...7b6da8395f21ea2677d6dc418f253f8f75c4a71a)。
后续归档提交只更新本工单、证据与 todo；以同分支已推送 HEAD 回查最终统一 diff，实际源/正式记录归档提交 hash 由最终回执列出，不冒充生产源码。
