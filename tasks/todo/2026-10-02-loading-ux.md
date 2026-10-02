# SD2加载与体验优化工单

项目：video-api-debugger
工单版本：v1.0.0
状态：2026-10-02用户已明确授权U1-U6实施、提交推送与安全部署；整批实现进行中，尚未构建/部署，功能待用户手动验收
更新时间：2026-10-02
正式项目目录：/Volumes/Data/Projects/video-api-debugger
应用源码观察位置：/Users/gouki-youdoo/.codex/worktrees/canvas-liblib-layout/video-api-debugger
源码观察提交：20931f7fb4b5af9dc8886120cd03d64ee5f87c09；历史定位不作为本次发布来源
实施源码起点：ff2af12dbca63406383f7df3c58a5218c656d129；分支codex/canvas-liblib-layout。开工服务器源码afc4489cac533523832e317aa7e4d694d35434eb，BUILD vNT0S5yAGwiHTBok0KVLe，4服务active；发布前再次核对漂移。
开工重新锁定版本：是；上述开发源码不能冒充当前生产源码
风险/验证等级：前端状态交互L2/L3，守门员start已执行；仅发布必需静态/构建/运行证据。用户明确禁止自动功能验收、浏览器、真实生成和生产库写入。

## 目标

先让等待、完成和失败说准确，再把已盘点位置统一成用户认可的局部刷光。保留已有内容和工作现场，让用户知道发生了什么、下一步能做什么。

来源：2026-10-02 用户要求盘点 SD2 加载与体验，并确认“这些就够了。写工单”。该句为历史来源；随后用户明确执行U1-U6。本工单只收纳已发现的范围，不要求继续全项目无遗漏审查，不代表线上问题已复现。

## 范围与禁区

- 范围：任务列表与详情、画布节点和恢复弹窗、图片工作台、资产库、模板读取，以及已盘点的项目和后台页面的等待、确认框与时间展示。
- 不做：新增生成引擎、全局换库、数据库迁移、权限/登录/计费/Provider 改造、性能架构重构、付费生成或旧域名部署。上传下载只改前端反馈，不顺带改传输链路。
- 本轮已获实施授权，按项目规则提交、推送、候选构建和部署，用户手动功能验收。不自动派审核线程、操作浏览器或执行功能回归。
- 既有图片原图恢复归属 [下载超时工单](2026-10-01-image-download-timeout.md) ID1-ID4；本单只使用其真实状态，不重复开发恢复链路。模板弹窗优先核对 [已交付工单](2026-10-02-template-primary-actions.md)，已完成项不重复修改。
- 正式根目录保存工单与附件；本目录旧应用分支不能作为当前前端修改来源。执行前确认当前有效源码与并行改动，禁止覆盖主线程内容。

## 执行清单

按 U1-U3 状态和结果、U4 动效、U5-U6 一致性顺序完成整批修改，再统一发布检查。每项保留编号，实施、部署、手动验收分别登记。

| 编号 | 优先级 | 任务 | 完成标准 | 状态 |
|---|---|---|---|---|
| U1 | 高 | 修正视频下载阶段 | 接口 202 只显示准备文件，不出现“完成”；可下载依据真实就绪结果；失败提供下一步 | 进行中（源码已实现；发布检查中，未部署，人工未验收） |
| U2 | 中 | 任务列表保留内容与正确重试 | 首次读取、刷新、失败、空列表分开；刷新保留旧内容，成功清旧错误，同页保留有效选择 | 进行中（源码已实现；发布检查中，未部署，人工未验收） |
| U3 | 中 | 修正恢复入口和画布状态文案 | 恢复设置不冒充重新生成；画布用真实中文阶段，未知受理不冒充失败 | 进行中（源码已实现；发布检查中，未部署，人工未验收） |
| U4 | 中 | 统一局部刷光及触发条件 | 下表场景开始/停止一致，尺寸稳定、防连点、减少动画；已有恢复与进度不被替换 | 进行中（源码已实现；发布检查中，未部署，人工未验收） |
| U5 | 中 | 已盘点业务弹窗采用产品样式 | 复用共享弹窗；取消无副作用，未保存保护、外部/Esc关闭及焦点正常 | 进行中（源码已实现；发布检查中，未部署，人工未验收） |
| U6 | 常规 | 已盘点记录复用近时展示 | 创建/更新时间用共享近时组件，点击可看准确时间；不改变日志、导出和截止时间 | 进行中（源码已实现；发布检查中，未部署，人工未验收） |

### U1 下载状态准确

源码 `src/app/tasks/[id]/page.tsx`：约1252行处理202并写入准备中状态，finally退出downloading；约2046行把非失败且非downloading判为完成，造成标题与正文相反。

- 根据真实任务交付状态区分准备、就绪、传输及失败；不要只用 downloading 布尔值推断完成。
- 准备中的刷光只在下载区域；沿用既有状态更新与重试，不新增后台循环、不重复付费请求。
- 若只能提供保存链接，描述为“文件已准备好”，不能声称用户已经保存到设备。

### U2 列表连续性与错误恢复

源码 `src/app/tasks/page.tsx`：约218行每次fetch设loading、成功清空选择但未清旧error；约329行loading隐藏已有列表，初次失败同时可能显示“暂无任务”。

- 首次无数据用骨架；刷新保留旧列表，并明确正在更新。切换筛选/页码时旧结果若暂留，标明其并非新条件的已完成结果。
- 失败显示重试而不是无记录引导；刷新失败保留旧结果，注明最新读取未成功；成功清理旧错误。
- 同页刷新只移除失效选择；换页按既有选择规则处理。核对迟到响应不会覆盖更新的页码与状态，优先复用既有请求保护。
- 资产库已有缓存保留与失效选择清理，只统一其反馈，不重做缓存层。

### U3 名称与真实动作对应

- `src/app/image-studio/studio.tsx` 约875行restoreTask只恢复输入；约1285行按钮称“重新生成”。改为“恢复设置”，明确尚未生成/扣积分，指向原生成入口，不自动提交。
- `public/tools/ultimate-canvas/app.js` 约4552/4645行显示检查次数或直接拼接状态。映射为实际排队、生成、准备下载、核对受理或需处理状态；不要猜测上游进度。
- 未确认受理沿用既有核对保护。主动核对期间可轻量等待，无法继续自动核对则停止持续刷光并给操作入口；不能让“失败重试”创建重复任务。
- 刷新/重开恢复草稿、选择和视口，不恢复假忙碌，不重复执行发送、上传或生成。

### U4 动效覆盖矩阵

| 场景 | 范围与表现 | 触发与停止 |
|---|---|---|
| 任务、资产、模板首次读取 | 真实布局的稳定骨架刷光，不造假内容 | 请求等待启动；结果/错误后停止 |
| 已有列表刷新或加载更多 | 原内容保留；列表头或新增尾部局部提示 | 刷新开始；更新成功或失败后停止 |
| 图片结果/视频画布节点 | 对应占位局部低亮度刷光，配真实阶段 | 仅真实待处理任务；终态/需人工处理停止 |
| 上传、保存、复制 | 当前按钮或操作区域，尺寸不变 | 有实际未完成操作；结果后退出，防重复提交 |
| 下载文件准备 | 下载状态区刷光；准备和保存区分 | 文件准备未完成；就绪/错误/取消停止 |
| 后台配置读取/保存 | 所属配置区局部反馈，不遮整个后台 | 所属操作进行中；终态停止 |

- 参考用户认可样例：左到右低亮度刷光，2.4秒周期、约65%扫过，其余停顿；按主题和面积适配，不把数值机械套用全站。
- 仅有真实字节/可核实步骤时显示进度百分比；无真实进度显示阶段。100%传输不冒充校验、保存完成。
- 小于约一秒的短等待克制显现，不为播完动画延迟结果；长等待保留输入与离开/返回能力。
- 使用既有CSS/伪元素和transform，不安装动效库；覆盖层不拦点击，定位与裁剪保持为常驻样式，完成后预览不越界。
- 遵循prefers-reduced-motion和项目减少动画设置；关闭动画后状态文字仍清晰。

### U5 产品弹窗

已盘点：任务列表window.confirm、任务详情alert、后台用户/配额/反馈/集成确认，以及画布备份选择、命名、规则退出/保存的window.prompt/confirm。

- React页面复用 `src/components/useProductDialog.tsx` / `useDialogDismiss`；画布沿用其HTML体系内的等价产品弹窗，不强行嵌入React。
- 备份恢复从输入编号改为可识别的备份列表，说明另存恢复作用；名称输入和危险确认保留原逻辑。
- 主操作可见且主次明确；外部空白/Esc只关闭最上层，内部点击、拖动、下层交互不误关；未保存保护优先，取消不保存/删除/生成。
- 不改变现有权限、积分事务、管理员操作作用范围，纯视觉统一不授权扩大管理动作。

### U6 近时与已有能力复用

`src/app/projects/page.tsx` 约456行更新日期为绝对日期；任务列表及部分模板/后台有各自日期格式函数。仅补已盘点且实际展示记录时间的位置。

- React优先复用 `src/components/RelativeTime.tsx`；准确时间按项目时区显示，支持点击/手机轻点、悬停和键盘聚焦，外部/Esc关闭。
- 不把截止时间、时长、日志、接口与导出转成近时。缺失时间显示未知，不造精度。
- 已有共享弹窗、近时、资产缓存、图片草稿与提交核对能力保留，不另建平行系统。

## 技能与开源参考

执行者按实际触及场景读取以下已存在技能，不批量改造未触及项目：

- `/Users/gouki-youdoo/.codex/skills/loading-state-design/SKILL.md` v1.1.0：局部刷光、真实状态、触发与停止；配套 `/Users/gouki-youdoo/.codex/skills/loading-state-design/assets/loading-motion.css`。
- `/Users/gouki-youdoo/.codex/skills/product-design-philosophy/SKILL.md`：用户意图与实际结果对应。
- `/Users/gouki-youdoo/.codex/skills/radical-simplicity-design/SKILL.md`：主操作及信息层级。
- `/Users/gouki-youdoo/.codex/skills/ui-state-persistence/SKILL.md`：工作现场恢复与避免重放动作。
- `/Users/gouki-youdoo/.codex/skills/interaction-pattern-library/SKILL.md`：产品弹窗与安全关闭。
- `/Users/gouki-youdoo/.codex/skills/relative-time-display/SKILL.md`：近时与准确时间交互。

已核对 [MUI Skeleton官方文档](https://mui.com/material-ui/react-skeleton/)，样例既有记录包含 [Skeleton实现](https://github.com/mui/material-ui/blob/master/packages/mui-material/src/Skeleton/Skeleton.js) 的阅读来源。只借鉴wave模式与尺寸占位，推荐现有CSS少量适配；不引入MUI依赖，不把官方模式说成本站已验证效果。

## 附件与正式入口

以下已有附件沿用原件，无新截图或录制，无音频附件。均位于正式项目资料目录；本地用户原图及其截图/录像不公开Git或外发。跨环境执行无法访问时需先按授权安全交接，不能把链接存在当成文件已收到。

| 名称 | 用途 | 可访问路径 |
|---|---|---|
| 独立刷光样例 index.html，v1.0.0 | 已认可视觉与状态交互参考；非生产任务 | /Volumes/Data/Projects/video-api-debugger/docs/materials/2026-10-02-loading-study/index.html |
| 样例检查脚本 check.cjs | 历史样例检查方法，未经新授权不执行功能测试 | /Volumes/Data/Projects/video-api-debugger/docs/materials/2026-10-02-loading-study/check.cjs |
| desktop.png / dark.png / mobile.png | 桌面、暗色、手机布局参考 | /Volumes/Data/Projects/video-api-debugger/docs/materials/2026-10-02-loading-study/evidence/ |
| interaction.webm | 本地模拟交互参考；查看其完整短片，未登记精确时间段，不作生产证据 | /Volumes/Data/Projects/video-api-debugger/docs/materials/2026-10-02-loading-study/evidence/interaction.webm |
| report.json | 既有样例检查结果，不替代正式功能验收 | /Volumes/Data/Projects/video-api-debugger/docs/materials/2026-10-02-loading-study/evidence/report.json |
| 既有用户画布原图 | 样例原图来源与节点上下文，不代表真实生成结果 | /Volumes/Data/Projects/video-api-debugger/docs/materials/2026-10-02-canvas-plan-split/codex-clipboard-1f20d528-af7d-4e00-b5b5-e1d90892de90.png |
| 图片原图恢复/模板弹窗工单 | 关联边界与避免重复开发 | /Volumes/Data/Projects/video-api-debugger/tasks/todo/2026-10-01-image-download-timeout.md；/Volumes/Data/Projects/video-api-debugger/tasks/todo/2026-10-02-template-primary-actions.md |

## 验证与停止条件

历史仅文档阶段的检查已完成。本轮实施完成后统一做发布必需检查；不运行浏览器、业务测试或付费生成。旧样例证据仍仅作为参考。

本轮实施：整批完成后执行项目要求的候选构建及内置检查；同一版本汇总问题再整批修正。不默认运行test:api、真实生成、浏览器截图或自动功能验收。发布须保护持久数据与回退构建，核对运行版本、BUILD_ID、服务健康、正式公网config/login及必要静态文件；源码提交不能冒充线上生效。

用户手动验收目标入口：https://sd2.youdooart.com 的任务列表/详情、画布、图片工作台、资产、模板及本单实际改动后台页。实际路由开工按代码核对，不猜不存在的地址。

手动通过标准：202不显示完成；列表刷新内容和有效选择不丢，失败可重试且不报无记录；恢复设置不自动扣积分；画布中文阶段准确；成功/失败/取消后动画停止；手机、减少动画、关闭保护可用；刷新后安全现场保留且不重复生成；准确时间可查。任务/资产真实状态、既有记录与日志保持原逻辑，本次不新增业务审计系统。

- 当前需求与有效源码冲突、需改鉴权/积分/Provider/数据库、需要新依赖或付费、会覆盖并行改动时，停下对应动作并说明缺口，继续安全独立项。
- 发布构建、版本或健康异常不切换；切换失败恢复旧版本。生产入口仅sd2.youdooart.com。
- 回执逐项U1-U6更新：源码修改、发布检查、远端提交/回退点、部署状态、待用户手动验收及缺口分开；不能称全项目无遗漏或自动验收通过。

## Git与收尾

- 本轮聚焦提交实际UI实现及工单、固定索引的新增内容，保留tasks/todo.md既有未提交段落，不提交旧计划、素材原图、证据录像或worktrees。
- 本轮应用拟交付v0.36.1兼容修正，仅一次升号；发布预约及线上漂移切换前重核。后续纯归档不重新构建或重启。
- 历史W1文档交付已完成。当前交付沿用U1-U6，区分实现、发布检查、部署与人工待验收。

## 本轮实施记录（2026-10-02）

用户本轮明确U1-U6执行并安全提交推送部署，替代历史“仅文档”授权状态；不继续已closed图片恢复后台工单。实际源码仅来自上述canvas-liblib-layout工作树，正式根目录仅同步工单、todo和资料索引。版本按既有行为的兼容修正采用v0.36.1，不新增生成能力或依赖。

逐文件修改（路径相对于实际源码工作树，正式根目录同名旧应用文件不是本轮源码）：

| 文件 | 修改 |
|---|---|
| public/styles/loading.css | React与画布共享的局部低亮度刷光，2.4秒/65%扫过、固定裁剪、覆盖不拦点击、系统/宿主减少动画属性 |
| src/components/LoadingState.tsx | 共享列表/卡片骨架和局部状态；无假百分比或延迟结果 |
| src/app/layout.tsx | 打包同一共享CSS，画布直接引用同一源文件 |
| src/app/tasks/page.tsx | 首载/刷新/错误/空态分开，保留旧列表与同页有效选择；读取序号防迟到覆盖，账号隔离；产品移除确认、共享近时 |
| src/app/tasks/[id]/page.tsx | 下载准备/可下载/停止显式阶段，202不完成，依任务真实文件就绪更新；错误内联、准备区域动效、共享记录时间 |
| src/app/image-studio/studio.tsx | 恢复设置名称；首载/刷新和实际生成占位、复制/上传/保存局部动效；既有请求查询隔离与恢复状态未改 |
| src/app/assets/page.tsx | 原缓存与请求保护保留，仅调整首载/刷新/失败反馈及上传/下载局部动效 |
| src/components/UploadProgressIndicator.tsx | 可选busy属性，仅指定的图片/资产入口启用；保留真实字节百分比及原默认行为 |
| src/components/templates/TemplateLibraryClient.tsx | 模板读取骨架、刷新保留内容；更新记录使用共享近时 |
| src/components/templates/AdminTemplatesClient.tsx | 模板列表/详情读取局部反馈、既有操作按钮刷光 |
| src/components/templates/TemplateEditorDrawer.tsx | 既有保存按钮局部刷光，保留共享关闭/未保存保护 |
| src/app/projects/page.tsx | 项目更新时间共享近时，保留期限与其他行为 |
| src/app/admin/feedback/AdminFeedbackClient.tsx | 归档产品确认、局部读取/保存反馈、操作防连点；提交时间共享近时 |
| src/app/admin/users/AdminUsersClient.tsx | 既有用户操作产品确认、前端操作锁与局部反馈；创建/最近登录近时；流水保持准确时间 |
| src/app/admin/users/quotas/QuotaManager.tsx | 草稿退出和已有额度操作产品确认，局部读取/操作反馈；请求身份、策略、期限与日志不变 |
| src/app/admin/integrations/AdminIntegrationsClient.tsx | 已盘点停止确认、配置读取/保存动效、测试记录近时；未执行测试连接或变更协议 |
| public/tools/ultimate-canvas/app.js | 中文真实阶段、查询未知受理仅主动查询busy，恢复不假忙；备份可识别列表另存恢复、命名锚定/小屏居中、规则关闭/保存共享native dialog底座 |
| public/tools/ultimate-canvas/styles.css | 备份/命名沿原品牌补充样式，生成按钮旧旋转不再和刷光叠加 |
| public/tools/ultimate-canvas/index.html | 引用共享CSS并刷新改动脚本/样式的缓存版本 |
| package.json / package-lock.json | 仅根版本0.36.1，依赖未变 |
| src/lib/release.ts | 与包版本同源的用户可感知摘要，既有SemVer及ReleaseNotice能力保留 |
| tasks/todo/2026-10-02-loading-ux.md | 当前授权、同一U表、逐文件记录与发布/人工边界 |

开源参考：已读MUI官网和Skeleton.js实际实现，并核对仓库MIT许可；仅借鉴稳定占位与transform wave技术，不接入/安装/复制MUI组件。已有用户样例完整短片0–7.8秒、195帧/25fps、无音轨及桌面/暗色/手机参考证据复用，不冒充生产验收，不执行check.cjs。项目未发现独立减少动画设置；共享CSS遵循系统设置并支持宿主data-reduced-motion/data-motion属性，不新增设置项。

发布检查进行中；最终commit、BUILD、归档SHA、服务/公网/回退证据部署后更新。无浏览器、DOM、截图、功能/离线回归、实际生成、生产DB写入；现有beforeunload、文件选择和浏览器保存属于平台语义保留。已盘点业务native框均替换，不声称全站无遗漏。
