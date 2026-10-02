# 模板主操作与产品弹窗

项目：video-api-debugger（SD2）
正式版本来源：package.json、正式站 /api/release 与服务器生产构建。
目标：https://sd2.youdooart.com/，交付版本 v0.34.2。
源码：/Users/gouki-youdoo/.codex/worktrees/canvas-liblib-layout/video-api-debugger，实际路径 /Volumes/Data/HomeRelocated/gouki-youdoo/.codex/worktrees/canvas-liblib-layout/video-api-debugger。
正式记录：/Volumes/Data/Projects/video-api-debugger；该目录旧应用代码不是部署源。
状态：整批实现已完成，待候选构建及发布检查；用户手动验收。
风险：L3，用户可见操作及可回退发布；不改权限、接口、费用、Provider、数据库或依赖。
更新日期：2026-10-02。

## 已确认目标与范围

用户确认“同时修改并部署模板相关页面”。沿用暗色工作台和青绿色主色；保存、确认、生成按当前面板任务突出，取消/辅助保持次级，危险后果使用危险色。不重设计全站，不安装组件库，不生成 mock 图。

| 编号 | 任务内容 | 完成标准 | 状态 |
|---|---|---|---|
| G1 | 全局主操作与弹窗规范 | 明确按钮层级、项目弹窗样式、位置判断及验证要求 | 已完成，supervisor负责；差异证据 /tmp/primary-actions-global-20261002.diff |
| G2 | sd2模板页面优化范围 | 确认本次是否同时实施，保留到项目待办 | 已完成，用户明确批准本批修改及部署 |
| G3 | 模板按钮与产品弹窗落地 | 主操作清楚，业务系统框替换，位置及取消行为符合场景 | 进行中，代码已实现；待发布、用户手动验收 |
| G4 | 发布与正式归档 | 候选构建、可回退、公网新版本及项目记录到位 | 未开始 |

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

候选构建、源码/文档提交、回退点、线上 BUILD_ID、公网与静态资源证据在发布完成后同处更新。
