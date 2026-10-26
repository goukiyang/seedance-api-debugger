# 参考素材选择入口修复

- 用户要求：素材选择弹窗有明确可见的选择功能；不应把选择入口藏在素材名称中。
- 资料：[固定资料索引](../../docs/materials/index.md)，内含用户原始截图与路径。
- 根因：预览与选择已分开，但选择按钮仅显示名称；通用按钮选择器覆盖局部padding，按钮被压成一行普通文字。
- [x] 保留点击图片预览，新增常显原生复选框和选择文字；选中显示顺序，可取消多选，沿用原有加入参考区逻辑。
- [x] 样式限定具体组件，避免通用按钮规则覆盖选择入口；保留已有工作台标识。
- [x] 版本0.2.1，更新摘要使用现有检测和弹窗。
- [x] `npx tsc --noEmit --incremental false`、`git diff --check` 通过；服务器 `NEXT_DIST_DIR=.next-prod-candidate-points npm run build` 通过（仅原有lint/CSS警告）。
- [x] 正式站v0.2.1，生产commit 53d02740e935920aac7776f27ea44763dd0c1f44，BUILD_ID=JxwOvB8wN7TtUZuIPlWSg；公开release与新页面交互通过，回退源码/构建保留在 /srv/video-api-debugger/backups/reference-picker-53d02740e935920aac7776f27ea44763dd0c1f44。
- [x] 实际已登录Chrome通过BrowserSkill独立Agent Window验收，未接管用户正在使用的生成页。勾选2张→取消1张→重新选中→加入参考区，真实页面出现图2/9、两张缩略图和@图片1 @图片2引用。未点击生成、未扣费。
- [x] [选中状态截图](../../docs/materials/2026-09-16-reference-picker/verified-selection-v0.2.1.png)已核对复选框可见、选中边框与顺序正确，无此区域重叠。
- 浏览器插件启动缺失旧版本模块，一次重连仍失败；按既有接续流程使用已连接BrowserSkill完成验证，会话已关闭。固定审核任务工具本轮不可用，本记录为执行自测，不冒充独立审核。
- 范围：ReferenceAlbumPicker.tsx、globals.css、版本元信息；不改上传、生成计费、权限或数据库。
