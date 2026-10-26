# 图片复制、站内分享与模板离开提醒

来源：2026-10-01用户要求放大图片支持右键复制和顶部复制按钮、收藏旁新增按钮，并明确选择“分享：让所有站内用户可见”；2026-10-02中断后确认继续。

| 编号 | 任务 | 完成标准 | 状态 |
|---|---|---|---|
| M1 | 放大图片复制 | 支持右键复制，顶部增加复制按钮 | 进行中：已部署，待用户手动验收 |
| M2 | 收藏旁新增按钮 | 按已确认的“分享给站内用户”实现 | 进行中：已部署，待用户手动验收 |
| M3 | 模板页卡住 | 修复保存／离开提示异常，不丢草稿 | 进行中：已部署，待用户手动验收 |
| M4 | 发布 | 构建、回退及上线检查完成，交用户手动验收 | 已完成：构建、Git回退与公网检查通过 |

## 实现与边界

- M1：统一预览原来在外层和图片舞台阻止右键菜单。现在只阻止事件冒泡，保留浏览器原生图片菜单；顶部复制按钮使用共享剪贴板函数，必要时转PNG，立即发起ClipboardItem请求以保留点击授权。列表已有复制入口复用同一函数。不支持或权限拒绝时明确提示，不能冒充复制成功。
- M2：登录后仅图片拥有者可主动发布自己的普通图片，收藏旁提供分享和取消分享。新入口复用ReferenceAlbum/ReferenceImage，按账号和资产生成稳定单图图集编号，不新增数据库结构。图集公开范围为站内登录用户，其他人从“公共图集”查看；原资产、任务、提示词、参考图、私有文件名和元信息不随分享副本公开。模板固定图、风格参考图即使管理员也不能通过此入口公开。操作受现有登录、账号有效性、同源请求及服务端所有权校验，记录操作日志。
- M3：临时生成参数与默认模板不同，不代表丢失风险。现在以当前草稿成功写入本机为依据；真正未保存设置、名称/分组/封面及正在保存/上传仍受保护。多个模板共用一次离开确认，避免每个模块反复弹窗；允许新标签页和下载，不重复拦截同一次硬导航。浏览器存储失败时保留提醒。
- 版本0.34.0，package.json为唯一版本来源，锁文件只同步根版本，无依赖变化。现有ReleaseNotice保留启动/前台/定时检查、账户页手动重查、稍后去重、短标题、用户确认刷新及保护提示；本轮只更新真实变更摘要，未自动强刷。
- 不修改数据库结构、登录/点数/Provider，不付费生成，不自动操作浏览器或执行功能回归；按项目规则仅候选构建、静态差异及必要上线检查。

## 资料与依据

- [用户原图：模板页离开提示](../../docs/materials/2026-10-01-media-copy-share/codex-clipboard-82847ded-af54-436a-9efc-ab996c8d467c.png)，用途为定位提醒问题；PNG已阅且归档cmp一致，仅本机保存，Git忽略。[固定资料索引](../../docs/materials/index.md)。
- 已读现有图集权限/列表/媒体接口及共享预览实现；沿用成熟浏览器剪贴板能力，不安装新库。[MDN ClipboardItem](https://developer.mozilla.org/en-US/docs/Web/API/ClipboardItem/ClipboardItem)、[WebKit Async Clipboard](https://webkit.org/blog/10855/async-clipboard-api/)。文档与代码路径核对不冒充真实浏览器验证。

## 发布记录

- 首份候选424ac0a构建通过，未切换线上；代码复核补充参考图预览不显示生成图分享、复制中状态及分享状态并发读取保护，同一0.34.0交付重新构建。
- 2026-10-02 00:55 CST正式部署应用提交`6aee43e66891319ad0034d0d420a263c652344b4`，BUILD_ID `77IZ_AigMl46PAmvaSjRF`，Git已推送并通过ls-remote核对。文档回执后续提交不升级版本、不重启网站。
- `git diff --check`和服务器`NEXT_DIST_DIR=.next-prod-candidate npm run build`通过，构建内置Lint/TypeScript通过，保留既有img/CSS等非阻断警告。源包SHA-256两端一致`aa6795d1a2097613a3317fa4d8860aa83030c7915a6ed9ffaf2ed6c7c8603e8f`，用户原图未进入公开仓库或发布包。
- 运行服务`sd2-gray.service`及既有图片/交付相关服务计时器active，源站config与公网config/release/login均200，公网来源`server-42-193`；14份实际模板页前端文件SHA-256与生产构建逐份一致，复制、分享、离开保护三个构建标记均存在。重启后首次探测早于端口就绪，随后有界重试通过，未回滚。构建用备份DB，未迁移或写生产数据库；媒体软链接检查保持。
- 回退标签`rollback/2026-10-02-before-media-copy-share`已推送，指向原运行版a3e8421；服务器`/srv/video-api-debugger/backups/media-copy-share-6aee43e66891319ad0034d0d420a263c652344b4`保留旧源码、live-build及quick_check通过的DB快照。回退仅切代码和构建，不覆盖用户新增数据。
- 入口：[模板工作台](https://sd2.youdooart.com/template-studio?type=image)、[公共图集](https://sd2.youdooart.com/collections?scope=public)。待手验：图片右键及复制按钮、仅自己的图片可发布/撤销、其他登录账号可见且私有上下文不外露、普通已存草稿导航不弹窗、真实未保存内容仍提醒、账户页更新入口及旧客户端升级提醒。
- 守门员：涉及按图片主动分享的权限边界；授权仅限本站登录用户、图片拥有者主动发布，不新增匿名公开权限。功能与跨账号真实效果留用户手验，未标为通过。

## 文件说明

| 文件 | 变更 |
|---|---|
| `src/components/ZoomableImagePreview.tsx` | 恢复右键菜单、顶部复制及状态；参考图单独预览不显示生成图分享 |
| `src/lib/media/copy-image.ts` | 共享PNG剪贴板写入、加载失败反馈及浏览器能力判断 |
| `src/components/content-reactions/ContentReactions.tsx` | 收藏旁接入分享控件，并支持参考图预览禁用该控件 |
| `src/components/content-reactions/ImageShareButton.tsx` | 分享状态、明确确认、发布/撤销、查看入口、失败重查及竞态保护 |
| `src/app/api/image-shares/route.ts` | 同源/登录/拥有者校验、拒绝受保护参考图、稳定单图公开图集与撤销、操作日志 |
| `src/app/image-studio/studio.tsx` | 以成功落盘的草稿签名判断导航风险，列表复制复用共享函数 |
| `src/lib/hooks/use-unsaved-navigation.ts` | 多模块共用一次导航保护，保留真实未保存阻拦，不重复确认硬导航 |
| `package.json` | 应用版本0.34.0 |
| `package-lock.json` | 仅同步根版本，无依赖改动 |
| `src/lib/release.ts` | 本次升级摘要，继续引用package.json版本 |
| `.gitignore` | 本轮用户截图只本地保留 |
| `docs/materials/index.md` | 原图、来源、用途、校验及工单入口登记 |
| `tasks/todo.md` | 固定任务入口和发布状态 |
| `tasks/todo/2026-10-02-media-copy-share.md` | 本工单、同编号对账、完整文件及发布证据 |
| `tasks/lessons.md` | 图片发布权限边界和已保存草稿误报根因 |
