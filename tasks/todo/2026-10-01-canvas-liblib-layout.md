# 画布输入面板、连接菜单与风格广场

项目：video-api-debugger
正式版本来源：https://sd2.youdooart.com/api/release 与服务器 .deployed-commit
开工核对：v0.32.1；发布前再次核对并发版本
目标路径：/Users/gouki-youdoo/.codex/worktrees/canvas-liblib-layout/video-api-debugger
状态：v0.33.0已部署，发布检查通过；功能待用户手动验收
风险与验证：L3；复用现有权限和生成服务，仅发布检查，功能由用户手动验收
最后更新：2026-10-01

来源：2026-10-01 用户提供 Liblib 画布四张标注，明确“复刻到我们版本”。使用参考布局，不复制其品牌、收费、模板数据或虚构能力。正式入口为 https://sd2.youdooart.com/tools/ultimate-canvas 。

| 编号 | 任务 | 完成标准 | 状态 |
|---|---|---|---|
| L1 | 复刻节点输入面板布局 | 保留现有生成能力，按参考组织布局与操作 | 进行中：已部署，待手动验收 |
| L2 | 复刻左右加号菜单 | 左侧添加上游、右侧创建下游，正确连线并按能力限制 | 进行中：已部署，待手动验收 |
| L3 | 接入风格广场 | 支持真实内容浏览、搜索、收藏、最近使用和应用 | 进行中：已部署，待手动验收 |
| L4 | 发布与交付 | 完成候选构建及版本、健康、公网检查，部署后由你手动验收 | 已完成：候选构建、四服务与公网检查通过 |
| L5 | 文本快捷创作栏 | 单击文本显示生成角色图等快捷操作，结果正确连到后续节点 | 进行中：已部署，待手动验收 |
| L6 | 通用与专属规则 | 分开展示、保存，并明确各自作用范围 | 进行中：已部署，待手动验收 |
| L7 | 模型补齐 | 查清历史约定和接入状态，补上已有可用模型及真实限制 | 进行中：已部署，待手动验收 |

2026-10-01 补充确认：L7指模板页的文案模型，不是增加新的图片/视频供应商。复用 `src/lib/template-studio/text-models.ts` 的六个选项、既有Musk通道及调用方式；选择随文本节点保存，服务器按白名单校验并使用，不修改全局默认模型、计费或密钥。既有模板页已实现多模型，旧画布文本入口仅固定后台默认模型。L6的通用规则作用于本站所有画布后续文本生成，专属规则仅当前节点；沿用管理员编辑权限，并明确保存范围。L5仅创建下游节点，不自动付费生成。

## 边界与方案

- 图片及视频面板沿用真实模型、参数和生成入口。左右连接菜单按当前节点的输入、输出能力区分，不把未接通的功能变成可生成状态；现有工具流节点继续保留入口。
- 风格内容复用本站可访问图片模板、现有收藏服务。应用复用模板复制及任务链路，保留内部上下文、固定图和风格组，不向普通用户泄露内部资料。不改变支付、点数、登录、Provider 或数据库结构，不安装依赖。
- 搜索分类、收藏和最近使用保留账号/项目隔离；恢复页面不自动应用或生成。目录分批加载，未核实商用授权的模板不标可商用。
- 开源复用：项目已安装的 Lucide（ISC / 部分图标 MIT）用于工具图标；读用本机组件导出与许可，不新增图标依赖。弹窗和画布延续现有实现，不引入第二套画布引擎。Lucide 来源 https://github.com/lucide-icons/lucide 。
- 验证边界：仅候选构建、内置检查、版本及健康、公网与回退保护。按项目要求不自动操作浏览器、不截图、不功能验收、不付费生成。

## 参考资料

- 四张浏览器标注：1 输入面板；2 左加号“添加上下文”；3 风格广场；4 右加号“引用该节点生成”。[资料登记](../../docs/materials/index.md)。原图在会话中已阅；工具未提供可访问文件路径或导出句柄，文件归档仍有缺口，不以重画图冒充原件。
- 参考页 https://www.liblib.tv/canvas?guideSource=home-feature-grid&spaceId=10349539&projectId=c92d851aa47f417784e1da218ba99a12 。

## 发布记录

Git Plan：以线上提交 241f83de2166c4bb04304b7f1809e9ab25a340fb 新建隔离分支 codex/canvas-liblib-layout；仅提交本工单源码和记录，推送现有 origin，并推送部署前 rollback tag。不覆盖旧开发分支、其他工作区脏改或运行数据。整批完成后做 JavaScript 语法、差异、服务器候选 Next 构建及内置检查，正式公网 release/config/login 与实际静态资源核对；未授权功能验收不运行。

实现已完成；6个画布JavaScript入口的`node --check`和`git diff --check`通过。候选v0.33.0；开工线上提交241f83de2166c4bb04304b7f1809e9ab25a340fb，发布前只读复核仍一致。隔离分支codex/canvas-liblib-layout；守门员等价检查L3，涉及画布及既有模板链路，不扩大账号权限或执行真实生成。子任务守门员自动分类误报general/L0，不能代替主线L3判断。

原始资料仅本地归档，Git与发布包排除参考图。未新增依赖、数据库结构、密钥或计费规则。前端既有ReleaseNotice沿用，摘要与package.json单一版本源同步；支持手动检查、稍后去重及刷新确认，未自动操作旧客户端验收。

首次候选caa3e33构建停在类型检查，正式服务未切换；同版完整TypeScript检查仅发现styles/route.ts最近使用数组unknown值缺少字符串窄化。整批补齐后继续v0.33.0候选构建，不重复升号。服务器发布管理使用既有root SSH密钥连接；普通gouki的sudo未授权，没有修改sudo规则或增加权限。

### 已发布结果

- 应用提交：`a3e8421a4262f3e56e33a78660b31e5246f7915b`；版本0.33.0；BUILD_ID `_C81XI-rofPDDN7wK8b9J`。分支与回退标签`rollback/2026-10-01-before-canvas-style-gallery`已推送，标签指向部署前241f83d。
- 候选：服务器独立release目录，使用生产数据库的受限副本构建；`NEXT_DIST_DIR=.next-prod-candidate npm run build`通过，包含TypeScript和内置lint。现存img等lint警告保留，不顺手改无关页面。
- 运行检查：`sd2-gray.service`、`sd2-image-studio.service`、`sd2-finalize-pending.timer`、`sd2-video-delivery.timer`均active。本机`/api/config`200；公网`/api/config`、`/api/release`、`/login`200，均确认服务器来源；公网release返回0.33.0。
- 资源检查：9份画布宿主构建资源公网可达且与服务器哈希一致；9份画布静态文件与本地提交一致；匿名访问画布仍307到登录页。此为发布检查，不是登录态页面或功能验收。
- 回退：`/srv/video-api-debugger/backups/canvas-layout-a3e8421a4262f3e56e33a78660b31e5246f7915b/source`与`live-build`保留；只回退代码与构建，不用旧整库覆盖生产数据。上传、视频、storage、数据库、密钥与旧构建均排除源码同步。
- 用户手动验收待办：节点面板和连线、风格搜索收藏应用及任务恢复、文本快捷创建、两类规则保存作用范围、六种文本模型的实际生成。未发起付费生成、未跑功能测试/自动浏览器/截图验收、未派审核线程。
- 已知限制：风格模板参数锁定，移除后恢复普通设置；商用授权未核实不标可商用；风格生成的共享非本人参考图沿用模板服务限制并明确报错。四张最初浏览器标注没有可导出的原图，归档缺口保留；后补快捷栏原图已本地归档。
- 收尾仅更新工单和资料登记，随后独立文档提交，不重复升级产品或重启网站。

### 实际修改文件

| 文件 | 本轮内容 |
|---|---|
| `.gitignore` | 排除本地用户参考图，避免公开上传 |
| `docs/materials/index.md` | 两批参考资料登记与归档缺口 |
| `package.json`、`package-lock.json` | 仅同步版本0.33.0，不改依赖 |
| `public/tools/ultimate-canvas/app.js` | 连接菜单、风格适配、文本快捷动作、六模型选择与两类规则窗口 |
| `public/tools/ultimate-canvas/backend-contract.js` | 增加本站风格、规则、收藏接口白名单 |
| `public/tools/ultimate-canvas/canvas-engine.js` | 输入面板、左右菜单、图标及文本快捷栏 |
| `public/tools/ultimate-canvas/canvas-styles.js` | 风格应用、参数恢复、请求保存与结果恢复 |
| `public/tools/ultimate-canvas/icons.js` | 导出既有Lucide图标，保留许可 |
| `public/tools/ultimate-canvas/index.html` | 新入口与资源版本引用 |
| `public/tools/ultimate-canvas/style-gallery.js`、`style-gallery.css` | 风格目录窗口、筛选分页、收藏和最近使用 |
| `public/tools/ultimate-canvas/styles.css` | 面板、连线菜单、文本快捷栏和规则窗口样式 |
| `src/app/api/tools/ultimate-canvas/bootstrap/route.ts` | 返回模板页同源文案模型列表 |
| `src/app/api/tools/ultimate-canvas/generate/route.ts` | 实际使用选中模型，服务端合并全站与节点规则 |
| `src/app/api/tools/ultimate-canvas/styles/route.ts` | 可访问风格目录、收藏、最近使用分页 |
| `src/app/api/tools/ultimate-canvas/styles/apply/route.ts` | 复用现有模板应用并返回价格及设置版本 |
| `src/app/api/tools/ultimate-canvas/styles/generate/route.ts` | 校验上下文和设置快照，复用既有提交服务 |
| `src/app/api/tools/ultimate-canvas/styles/results/route.ts` | 按所属账号模块请求查结果并归档素材 |
| `src/app/api/tools/ultimate-canvas/text-settings/route.ts` | 管理员通用规则GET/PATCH及冲突保护 |
| `src/app/tools/ultimate-canvas/CanvasFrame.tsx` | 弹窗覆盖整页，包括外层站点侧栏 |
| `src/lib/canvas-documents.ts` | 复制保留设置，不复制运行任务 |
| `src/lib/canvas-style-bridge.ts` | 风格入口权限、上下文、请求大小和错误处理 |
| `src/lib/canvas-text-settings.ts` | 复用PlatformSetting保存画布通用规则及修订号 |
| `src/lib/release.ts` | 本次更新摘要，沿用既有升级提醒 |
| `tasks/todo.md`、本工单 | 本轮任务、范围与发布证据 |
