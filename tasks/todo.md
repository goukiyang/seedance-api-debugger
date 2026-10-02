# V1.2 剩余模块落地 Todo

## 当前入口

- [模板工作台体验优化 WS1-WS7](todo/2026-10-02-template-workbench-ux.md)：用户明确实施；整批源码已实现，待统一候选构建/安全部署，人工未验收。仅/template-studio，独立图片页门控保留，已有附件及缺口见同一原工单。

- [加载与体验优化 U1–U6](todo/2026-10-02-loading-ux.md)：v0.36.1已部署；源码实现、发布必需检查与安全部署完成，待用户手动验收。运行源码8acaf46，BUILD Ec6Hfe91C-vrdLDtYaCKN，4服务/40公网静态/24源码一致、图片worker正常排空；完整正文、既有附件入口与[发布证据](todo/2026-10-02-loading-ux.evidence.json)归入正式根目录。

- [画布视频方案拆分 v1.1.0](todo/2026-10-01-canvas-plan-split.md)：v0.35.0 最终产物已部署；SP1–SP5 含历史查询收尾修正已实现并部署待用户手动验收，SP6 发布检查及正式归档完成。真实资源ID复用，assetId 如实 null，不创建 Asset；源码80afb99，BUILD ILxByLZ7_8R-4aPl4WWhH，4服务/32公网静态/10源码一致；原版与中间候选均可回退。全文与证据归入 `/Volumes/Data/Projects/video-api-debugger/tasks/todo/`。

- [模板主操作与产品弹窗](todo/2026-10-02-template-primary-actions.md)：v0.34.2已部署；G1/G2完成，G3代码已实现并部署待用户手动验收，G4构建、正式公网32项静态检查、回退及归档完成。

- [统一创作资源库功能盘点与整合建议](todo/2026-10-02-unified-resource-library.md)：I1–I3盘点、A1–A4审查完成；3个代码问题及6处体验问题已部署v0.34.1，R3发布检查完成，R1/R2待用户手动验收。统一资源目录仍待后续批次；正式正文和原图已归入项目主目录，发布预约流程缺口已如实登记。
- [图片复制、站内分享与模板离开提醒](todo/2026-10-02-media-copy-share.md)：v0.34.0已部署，M4发布检查完成；M1-M3已上线，待用户手动验收。
- [画布输入面板、连接菜单与风格广场](todo/2026-10-01-canvas-liblib-layout.md)：v0.33.0已部署，L4发布检查通过；L1–L3/L5–L7实现已上线，待用户手动验收。包含文本快捷栏、通用/专属规则和模板页六种文案模型。
- [图片下载超时与原图找回](todo/2026-10-01-image-download-timeout.md)：v1.1.0 ID1-ID4 已实现并部署 v0.36.0，待用户手动验收；最终源码afc4489、BUILD vNT0S5yAGwiHTBok0KVLe，4服务/25公网静态/14源码一致，原请求查询已从新生成条件解耦、worker正常排空、回退点和完整记录到位。I1及D1/D2/T1-T4历史保留，旧图未救回；上游查询/幂等未确证、透明请求未开放、已退款终态不自动领图。正式正文、参考原件与发布证据见资料索引。
- [图片模板通用上下文恢复与全局生效](todo/2026-10-01-image-studio-global-context.md)：2026-10-01 已恢复批准原文，v0.30.1 已部署；两组非付费定向测试和发布检查通过，待用户手动功能验收。
- [IP 生成接入 Seedance 2.5 与完整交付闭环](todo/2026-10-01-ip-seedance25.md)：2026-10-01 实施中，默认 2.0 不变；完成后自动部署，用户手动验收。

### AV01–AV07 全站同类媒体预览合并方案（2026-09-30，已部署v0.28.0，待手动验收）

用户反馈：资产栏非宽屏视频及图片预览体验差，要求找合理方案/开源优选；随后要求查找其他同类问题一起合并规划。沿用AV01–AV04，新增AV05–AV07，不拆成重复方案。用户随后明确“修改落地”，开始执行；开工核对线上v0.27.0、源码f729a63，当前工作区4cd48b5仅多规划记录且干净。候选v0.28.0，不迁移数据库、不安装依赖、不付费生成；构建发布后交用户手动验收。

- 已确认代码原因：`src/app/globals.css`的`.asset-detail-drawer`宽度上限440px，`.asset-detail-preview`固定16/10；`src/app/assets/page.tsx`虽读实际宽高，结果只决定is-portrait类，没有改变外框。图片详情直接使用thumbnailUrl，放大不能自动获得原图细节。收藏的ContentPreview与普通详情为两个入口/容器规则，现有ZoomableImagePreview又有独立图片全屏能力。不能说所有问题均由CSS造成，具体媒体失效/编码故障需另查。
- 采用方案：保留资产网格、选择/框选、筛选、排序与原详情字段；点击媒体打开统一近全屏查看器，详情按钮打开可折叠信息区。图片复用现有ZoomableImagePreview的鼠标轴心缩放、拖动防误关闭与对比能力，视频保留原生video播放，用一个共享尺寸适配规则覆盖生产历史、项目、收藏、赞过、图片/上传入口。不为本次把全站所有查看器推倒重做。
- 尺寸按媒体真实宽高及实际可用舞台宽高取较小缩放比例，默认完整显示、不拉伸不裁边，不固定16/9或16/10。元数据未就绪时稳定占位，图片onLoad/视频loadedmetadata校正，容器变化用ResizeObserver；顶部操作栏、底部视频控件、手机安全区先扣除，信息区不挤占竖片。横屏按宽、竖屏按高、方图按短边适配；长图提供适合窗口/适合宽度/实际像素，超宽图可放大平移。只在当前打开的媒体上读取元数据，不批量下载全列表。
- 图片源分层：缩略图用于列表/占位，预览用受权限保护且确实存在的高清接口，需要时明确加载原图；实施先核对各接口能力，不假定都有高清层。view/use/download权限不能因查看器合并而扩大。普通预览只保持当前一个播放器，切换/关闭停止上一段，controls/playsInline/fullscreen可用；超分双视频对比是明确例外，保留同步播放/暂停/定位。拖进度条不能触发关闭、切换或图片拖动。
- 连续性：上一张/下一张沿用当前筛选顺序，在已加载边界按需取下一批，失败可重试；关闭恢复原条目位置、焦点和批量选择。按账号+内容ID+版本保存安全查看状态及视频位置，恢复到暂停态，显式链接优先；不存签名URL、不恢复播放声音/下载/生成。内容删除或撤权返回安全占位，不展示旧敏感缓存。
- 开源查证：已读[Yet Another React Lightbox VideoSlide源码](https://github.com/igordanchenko/yet-another-react-lightbox/blob/main/src/plugins/video/VideoSlide.tsx)的容器测量/按比例计算/离开暂停实现，以及[Video](https://yet-another-react-lightbox.com/plugins/video)、[Zoom](https://yet-another-react-lightbox.com/plugins/zoom)文档；[package.json](https://github.com/igordanchenko/yet-another-react-lightbox/blob/main/package.json)声明React18兼容及构建/测试，许可MIT。适合作为统一开源替代候选，但现有图片对比、任意拖移、防误关闭、鉴权和点赞控件仍需适配；本轮未安装、未评估构建后实际包体/完整依赖安全。当前推荐参考其尺寸算法、独立实现容器，先复用已有图片能力，减少行为回归风险。
- 其他候选：[PhotoSwipe官方说明](https://photoswipe.com/custom-content/)以图片为主，视频需自定义，不作本次混合媒体首选；已读[anvaka/panzoom源码](https://github.com/anvaka/panzoom/blob/main/index.js)及说明，适合后续确有手势缺口时替换图片缩放内核，但它不是视频播放器，本次不与现有缩放同时叠加。没有把搜到项目当成已验证可用。

| 编号 | 任务 | 完成标准 | 状态 |
|---|---|---|---|
| AV01 | 预览入口与根因 | 普通资产/收藏/图片/视频入口及布局源核对 | 已完成本次同类入口源码盘点；未浏览器复现 |
| AV02 | 统一自适应查看器 | 按真实比例完整显示，详情可折叠，原列表操作保留 | 实现与部署完成，待用户手动验收 |
| AV03 | 图片视频交互与恢复 | 高清/原图权限、缩放、防误关闭、视频控件、关闭返回和安全恢复完整 | 实现与部署完成，待用户手动验收 |
| AV04 | 发布与用户验收 | 必需构建/回退/公网检查，交用户横竖方图等样例手动验收 | 发布检查、回退保护与交接已完成；功能待手动验收 |
| AV05 | 媒体地址与传输 | 封面/播放/原图/下载用途分离，正确类型与分段响应，原权限不扩大 | 实现与部署完成，待用户手动验收 |
| AV06 | 普通入口统一接入 | 资产、收藏、生成参考素材、图集、模板产物和项目任务复用预览，选择行为保留 | 实现与部署完成，待用户手动验收 |
| AV07 | 专用场景适配 | 超分双视频同步、画布节点交互、移动端手势及例外边界有明确交接清单 | 实现与部署完成，例外已记录；待用户手动验收 |

#### 实施记录

- 发布：v0.28.0，源码`697e2c3880bf89ccd42caaa590af63d540d50f3b`，BUILD_ID `hgGT2pMaWEoRTJYIs4xwS`。入口：[资产](https://sd2.youdooart.com/assets)、[模板工作台](https://sd2.youdooart.com/template-studio)，其他接入入口见下表。[统一代码差异](https://github.com/goukiyang/seedance-api-debugger/compare/4cd48b5cb0db00d545002d9759fc696cedb023ba...697e2c3880bf89ccd42caaa590af63d540d50f3b)。29个文件，未增加依赖或更改数据库结构。
- 发布检查：本地TypeScript/diff通过，服务器独立候选`NEXT_DIST_DIR=.next-prod-candidate npm run build`退出0（保留既有非阻断img/CSS等警告）。本地源站与公网release均0.28.0，config/login均200，公网来源server-42-193；共享chunk `9382-8936414ff21b0573.js`公网200并与服务器文件SHA-256一致，包含图片/视频两种新查看器标记。四个服务active/running，NRestarts=0，三个运行媒体目录软链接保持不变。切换时首次源站探测早于进程就绪、短暂连接失败，随后的有界重试成功；未回滚。沿用现有ReleaseNotice，未操作旧浏览器验证升级弹窗。
- 画布静态脚本未登录访问返回307到本站login，属于原有访问控制；已核对服务器app.js新预览消息与index.html缓存标识，未为检查放开权限，未执行已登录画布页面/功能验收。首轮发布检查脚本把该受保护地址误按公开资源期望200，已修正检查口径，不是应用构建或上线失败。
- 回退：已推送`rollback/2026-09-30-before-media-preview`，指向v0.27.0/f729a63；分支提交已推送并用ls-remote核对。服务器保留`/srv/video-api-debugger/backups/media-preview-697e2c3880bf89ccd42caaa590af63d540d50f3b`旧source/live-build及完整性通过的DB快照；构建使用快照，不写生产数据库；回退仅切代码和构建，不恢复整库。归档两端SHA-256一致`57e1661b6273e7fd54732c80a3e2905c817df14b681689df409df107b2a2d138`。发布窗口开始/完成已登记。
- 主控负责媒体读取、整合、版本与发布；GPT-6 Luna XHigh三个内部执行子任务分别完成共享预览、普通入口、任务/画布适配。不开独立新后台、不新增依赖。代码交接仅静态核对，统一构建在全范围完成后执行，不做浏览器/付费生成/自动功能验收。
- 任务/超分：舞台按稳定可视窗口预算适配，不根据当前滚动位置把屏外结果压成零；保留同步播放/暂停/定位与原全屏。单视频另有共用预览入口，打开前暂停页内视频。
- 画布：已入库图片与视频任务的更多菜单新增预览，保留明确的新标签/原图/任务详情等入口；同源且当前iframe消息只携带真实内容ID，父页重查权限并核对归一编号及受限预览路由。未动画布坐标/拖动/缩放/撤销/保存。没有持久编号的临时图片保留旧入口，当前无独立音频节点，不伪造音频工具。
- 后端：参考媒体新增preview用途；图片无原件下载权限时保持既有缩略图可见度，视频/音频仍需既有使用或下载权限。无视频封面返回暂无封面，不把整个视频伪装成缩略图。共享流式读取用于本地任务视频及参考媒体，支持HEAD/206/416和取消；远端逐跳公网DNS校验及固定地址、无凭据转发、响应类型检查。远端单响应上限2GiB、DNS10秒、等响应30秒、无数据60秒、总限10分钟；不改变生成上传限额或上游结算，远端IPv6-only地址暂不支持。
- 首轮统一静态检查发现两处类型错误（旧尺寸setter残留、选择DTO空值），以及预览翻页改变底层列表、连续跨无媒体页面请求无界的问题，整批修正后再统一检查。图片模板仍复用已有受保护的studio媒体地址，保留高清/完整原图切换，不因统一入口退化为只能查看2048预览。
- 修正后`npx tsc --noEmit`和`git diff --check`均通过。资产使用独立预览序列与分页，不改主列表页码/选择；资产和收藏每次最多检查3页，保留游标供继续查找，读取中/失败提示常显并在成功时清除。已有图集选择、项目任务入口提供单项预览，未新增跨图集/项目连续导航；模板连续导航限当前已加载结果，不自动跨模块。
- 文件分工：`src/components/MediaPreview.tsx`及样式负责共享媒体舞台；`ZoomableImagePreview.tsx`及样式负责缩放/双指/对比/防误关；`src/lib/hooks/use-media-preview-state.ts`负责安全状态保存；`src/lib/media/preview-response.ts`及三个媒体route负责用途、鉴权后的流式读取，`src/lib/content-reactions/content.ts`选择现有有权使用的图集引用。资产页、ContentCollections、GenerationComposer、ReferenceThumb、ReferenceAlbumPicker、UploadedImagePicker、图集详情、image-studio/studio、VideoTemplateWorkbench、项目页逐一接入；任务详情及globals.css适配单视频/双视频；CanvasFrame和画布app.js/index.html适配持久产物预览并更新缓存标识。package两个版本字段、release摘要及本todo记录交付；未改依赖。

#### 同类问题盘点与合并处理

以下“代码确认”只确认源码路径/条件，不代表已在生产逐项复现；视觉溢出、网络耗时和历史数据命中率交手动核对。不把所有固定比例缩略图当成缺陷。

| 范围/位置 | 证据与问题 | 合并处理及归属 |
|---|---|---|
| 资产详情：`src/app/assets/page.tsx`、`src/app/globals.css` | 代码确认440px窄栏、16/10外框、图片用thumbnailUrl；实际宽高未参与外框适配 | AV02/03：主预览完整显示、高清按权限加载；保留网格及详情字段 |
| 任务详情/超分对比：`src/app/tasks/[id]/page.tsx`、`.task-result-stage` | 单视频固定16/9且min-height300；双视频面板有独立最小高度，全屏另有规则；竖片和矮窗口存在适配风险 | AV02/07：共用可用空间计算，双视频各自contain；保留同步与全屏，不硬套单播放器 |
| 图集选择弹窗：`src/components/ReferenceAlbumPicker.tsx`、`.album-media-preview-modal` | 视频宽100%，容器限宽但未限高；竖视频可能超出屏幕，图片和视频使用不同弹窗 | AV02/06：统一舞台高度与操作区，视频不按宽度无限撑高 |
| 参考媒体地址：`ReferenceThumb.tsx`、`ReferenceAlbumPicker.tsx`、`collections/[id]/ReferenceAlbumDetailClient.tsx` | 代码确认视频预览存在thumbnailUrl优先；ReferenceThumb内嵌播放用originalUrl，但打开预览传thumbnailUrl优先的地址。有封面时可能把图片当视频 | AV05优先：poster仅作封面，播放地址必须对应可播放资源；音频同查，不靠后缀猜类型 |
| 参考内容接口：`src/app/api/reference-images/[id]/content/route.ts`及图集DTO | thumbnail分支优先返回封面，却以原资产mime_type响应；无封面时回退原媒体。原图与预览有不同权限，不能只把前端全部改成original地址 | AV05：按实际返回内容给MIME，区分用途和允许动作；保留view/use/download边界，不新增下载权限 |
| 同一参考内容接口的传输 | 本地readFileSync、上游arrayBuffer整文件读完再返回，未处理Range；存在起播/拖进度等待和内存风险，本次未测量耗时 | AV05：复用`api/video/play/[id]/route.ts`已有流式/Range逻辑，核对206/416/HEAD、取消与资源释放；继续鉴权及公网地址安全校验 |
| 上传素材选择：`src/components/UploadedImagePicker.tsx`、图集详情 | 图片有放大入口，视频/音频点击为选中；图集详情也存在预览外观但实际选择的按钮 | AV06：明确分开预览与选择，保留多选/配额/已在工作区状态，不能把原选择动作暗改成打开弹窗 |
| 普通生成/收藏弹窗：`GenerationComposer.tsx`、`content-reactions/ContentCollections.tsx` | 各自容器/媒体/关闭规则，视频有autoPlay且部分无playsInline；收藏刷新处理会setPreview(null)，焦点恢复或点赞事件可打断查看 | AV03/06：明确用户点击播放与恢复暂停，统一关闭/焦点/键盘；刷新列表不关闭仍有效的当前内容，撤权删除则安全关闭 |
| 模板图片预览：`src/app/image-studio/studio.tsx` | 代码确认预览onClose同时清空selected和downloadMode，关图会丢批量选择 | AV03/06：关闭只结束预览，选择与下载模式由显式退出操作结束 |
| 图片查看器：`src/components/ZoomableImagePreview.tsx` | 已有鼠标轴心缩放、拖动阈值和焦点管理；当前单指针拖动未见双指缩放，工具栏换行与固定高度扣除存在遮挡风险 | AV03/07：保留已有能力，补双指/触屏边界、实测工具栏高度、真实像素倍率语义；不是直接宣称现有组件已覆盖手机 |
| 项目/生成卡片：`src/app/projects/[id]/page.tsx`、`TaskVideoThumbnail.tsx`、`VideoTemplateWorkbench.tsx` | 项目卡片直接使用local_video_path/result_video_url；归档、地址过期时有风险。部分列表封面固定16/9 cover属于缩略图策略，不等同主预览错误 | AV05/06：任务ID解析当前可用播放资源；卡片保留稳定尺寸，检查关键画面裁切和明确放大入口，不全站取消缩略图比例 |
| 无限画布：`public/tools/ultimate-canvas/app.js`、`CanvasFrame.tsx` | 生成视频预览目前用新标签链接；画布有自身拖动/缩放和专用场景容器 | AV07：为已入库产物适配共用查看器，不动画布坐标/撤销/保存；若用父子页面消息，验证origin/source/消息类型及内容ID，父页重新核权，不接受任意URL |

#### 最小统一方案与实施顺序

1. **先修正确资源，再修显示（AV05）**：定义一个轻量预览描述，使用稳定内容ID、媒体种类、宽高、封面和受保护的预览/下载入口。沿用现有业务编号与权限，不新增媒体数据库。尺寸缺失按加载事件补齐，不批量读全库。核对请求取消、超时、重定向/内网拦截、范围与总大小限制；不把任意远程地址变成开放代理。参考[MDN Range说明](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Range_requests)，实现优先复用项目已有视频流式路径，不改上游生成下载/结算逻辑。
2. **一个外壳、分媒体能力（AV02/03）**：共用舞台、操作栏、详情区、焦点/关闭与前后切换；图片保留现有缩放/对比能力，视频使用原生播放器，音频只复用弹窗外壳和生命周期。读取到真实尺寸后适配，尺寸未知时不闪大图；旧加载请求不能覆盖新打开内容。无需为统一外观同时安装多个查看器。
3. **普通入口逐一适配、统一交付（AV06）**：资产普通/项目/收藏/赞过 -> 生成参考素材与图集 -> 图片/视频模板已有产物 -> 项目和任务单媒体入口。每处记录打开、选择、下载、点赞、返回的行为，保留原业务操作和侧栏独立滚动；跨页不按URL认同一内容。仅在本来有序的结果集提供上一项/下一项，不跨权限或私自扩大检索范围。
4. **专用交互保留（AV07）**：超分双视频只适配尺寸/生命周期，画布仅适配持久化产物的查看入口。图片双指缩放若复用panzoom，先核对当前维护、许可、依赖和任意拖动需求，只保留一个手势内核；YARL可作为完整替代候选，但不能解决地址、鉴权和分段传输问题，不能只装库就算完成。裁切编辑、3D/导演场景、头像、banner装饰裁图不属于本次统一预览；工具明确的“新标签打开”保留为独立操作。
5. **性能与状态闭环（AV03/05/07）**：列表优先封面/懒加载，不同时下载全部视频；普通查看仅激活当前媒体，对比才允许两路；关闭暂停、释放临时对象/监听、终止请求。加载/无权限/已删除/暂时离线/不支持格式分别提示，重试只重新读取，不触发生成、扣费或转码。恢复按账号/内容版本隔离，尽量保留滚动、焦点、选择和暂停时间；失效内容不保留敏感预览，显式链接优先。错误退回可用入口，不恢复自动播放。
6. **统一发布交接（AV04）**：上述修改完成后执行候选构建及内置检查、版本/回退/健康/公网资源检查，沿用现有更新提醒。发布不等于功能验收；最终列出各入口是否接入和未验证项，交用户一次性手动验收，不只修资产页就关闭整项计划。新增权限或数据库变更不在此规划授权内，若实施确有需要应先停止受影响步骤说明。

手动验收清单：16:9、9:16、1:1、4:3、3:4、超长图、超宽图、尺寸暂缺；桌面宽/矮窗口和手机横竖屏；鼠标轴心缩放/双指/拖图、防误关闭、工具栏不遮挡；视频进度/全屏/双视频同步、关闭不继续出声；有封面与无封面视频、音频、归档/过期地址、Mac离线、大文件范围响应；有查看无下载、有使用无下载、撤权/删除；多选后开关图、点赞刷新不中断查看、刷新与返回恢复暂停状态。以上为待用户验收项，不代表已通过。

范围不含重新生成、转码、批量修复历史元数据、数据库迁移或对既有公开直链作可撤销承诺。无新增媒体附件；以上源码路径和公开链接为参考入口。守门员：本次按用户明确授权修改共享UI与媒体读取路径；沿用已有查看/使用/原件权限，无新增权限、生产数据覆盖或依赖变更；未发现归类越界。功能与画面仍交用户手动验收，源码判断不冒充真实运行效果。

### DT01–DT03 图片下载超时与状态提示（2026-09-30）

| 编号 | 任务 | 完成标准 | 状态 |
|---|---|---|---|
| DT01 | 下载超时根因 | 核对代码与线上记录，按证据修复 | 已修复部署；历史网络卡点证据缺口保留 |
| DT02 | 状态颜色与提示 | 正常等待不报红，真实失败保留明确提示 | 已部署，待用户手动验收 |
| DT03 | 发布 | 构建、Git、回退保护及线上检查完成 | 已完成 |

- 用户要求排查 download_timeout 和正常提交报红。线上 v0.26.0：任务 `14d76a2510c8…-0`，img2.5-S，2880x2880，20:10:57 创建；worker 记录下载阶段超时，总耗时 288301ms。旧日志没有连接、响应与字节进度，无法断言历史那次具体卡在上游哪个网络环节；历史返回链接未持久保存，本轮不能凭空恢复图片，也不付费重生成。
- 代码根因：每次下载有固定60秒墙钟中断，即使持续有数据；生成和下载还共用5分钟信号。改为独立下载最多3分钟（含最多一次GET重试/重定向），DNS10秒、连接20秒、等响应60秒、传输无进展60秒；收到数据延长空闲时限但不延长总时限。整个worker网络处理最多8分钟，预留原10分钟租约内结算时间。重试只下载，绝不重新调用生成POST。
- 保留HTTPS、DNS公网地址校验与固定地址、防重定向内网、TLS和96MiB输出限制；重试可切换已验证公网IP。日志仅增加阶段、尝试次数、收到/预期字节及耗时，不含链接、提示词或凭据。不改积分/权限/schema，不修改历史失败状态或生产数据。
- 状态扫描覆盖图片模板、视频模板及普通视频生成器：图片提交/上传/保存/读取，视频文案排队/处理/配置读取改为明确progress状态；缺少输入为普通提示，需处理的条件为警告，真实错误保留红色。视频生成器按实际命中的阻塞项决定颜色，不按文字或无关并发上传状态猜测。保留禁用、防重复提交和原布局。执行线程Bacon使用GPT-6 Luna XHigh完成5个UI文件，主控复核并补齐普通生成器优先级及按钮旁提示。
- 参考并已读 [Undici HTTP/1下载实现](https://github.com/nodejs/undici/blob/main/lib/dispatcher/client-h1.js) 中按数据刷新body timeout的做法；独立实现，不复制代码、不引入依赖。只进行本次排查所需离线诊断及发布检查，不做付费生成或浏览器验收；上线后交用户手动验收。
- 统一检查：`npx tsc --noEmit`、`git diff --check`、`node --import tsx scripts/image-studio-provider-smoke.ts`及`image-studio-download-smoke.ts`通过。离线模拟真实下载函数的持续传输、断流、总时限、连接超时、重试IP切换及DNS内网拦截；检查生成/下载独立信号、单次生成POST及日志脱敏。不代表真实上游线路或付费生成已经验收。候选版本v0.26.1，复用现有ReleaseNotice及同源版本检查/稍后提醒，不另建升级机制。
- 发布完成：v0.26.1，源码`9477c462066a809c2c5842552cfca752b642eeef`，BUILD_ID `4zx1K8D1I6Vm7yv0TovRS`。服务器候选构建/内置检查通过，公网release=0.26.1、config/login=200且来源server-42-193；图片共享chunk `4369-b533fe409d1e5d07.js`、视频模板chunk `page-df3287851080be52.js`及视频生成器共享chunk `420-aed674b54916a69c.js`均可达并包含新状态标记。普通生成页入口chunk只加载共享组件，最初在入口chunk查标记未命中，按构建清单找到共享chunk后已核对，不属于线上漏发。四个既有服务均active/running、NRestarts=0；源站config=200。
- Git分支和回退tag `rollback/2026-09-30-before-download-status`已推送核对，回退指向兼容周期额度的v0.26.0 `cb9f66d`。服务器保留`/srv/video-api-debugger/backups/download-status-9477c462066a809c2c5842552cfca752b642eeef`的旧source/live-build及DB快照；回退只恢复代码，不恢复整库。归档SHA-256两端一致`3058605002549e01966ed1ded8912f49cc446baceedc930ec612d5b8149a1a12`，解压/同步排除.env和运行媒体；无数据库迁移或历史数据覆盖。发布窗口已登记开始/完成。
- 文件：`src/lib/image-studio/media.ts`分阶段下载/限时/安全诊断；`provider.ts`分离下载信号并传递诊断；`worker.ts`限定任务网络总时长及安全日志；`src/app/image-studio/studio.tsx`与`studio.module.css`图片状态；`src/components/template-studio/VideoTemplateWorkbench.tsx`与`template-studio.module.css`视频模板状态；`src/components/GenerationComposer.tsx`普通视频生成器；两个`scripts/image-studio-*-smoke.ts`离线诊断；`package.json`、`package-lock.json`和`src/lib/release.ts`版本/摘要；本todo留痕。依赖未变化。
- 入口：https://sd2.youdooart.com/template-studio 。[统一代码差异](https://github.com/goukiyang/seedance-api-debugger/compare/dfe719e724704a7b86c55e3b96f565c8cd0e1311...9477c462066a809c2c5842552cfca752b642eeef)。守门员：本次涉及共享外链下载与状态UI，保留网络安全、积分及数据边界；无越界，无分级/归类误判。未执行浏览器、付费生成或用户功能验收，历史失败图片未恢复；本次不能承诺所有上游网络超时彻底消失。

- [x] 周期额度模块 CQ02–CQ06 已部署 v0.26.0，待用户手动验收：[实施与发布记录](todo/2026-09-30-periodic-credits.md)。

### LF01–LF06 全站点赞收藏（2026-09-30）

2026-09-30续办：用户引用“备份后新增两张表并上线”的确认请求，明确“继续落地点赞系统”。本轮据此执行既有点赞+收藏范围的生产备份、两表新增与发布，不覆盖旧数据；“踩、每文件备注、Agent后台只读查询”为随后提出的新目标，目前仅研究，尚未定稿，不混入此版。开源研究已读Open WebUI反馈模型/许可与Langfuse评分接口/许可，后续设计优先扩展本体系，保留作者、内容版本及访问边界，不将个人意见视为团队定论，不把Agent读取权限等同管理员全权；新范围须另行形成实施计划。未安装上述系统。

本次从现网v0.26.1（下载/提示修复）及文档提交cee70f1上续接，保留周期额度。仅选入旧功能提交4c2fa2f，不整支覆盖；旧候选v0.26.0未发布，本次按新增功能升v0.27.0。执行分支`codex/content-reactions-live-20260930`，源码目录沿用下述路径；主控负责迁移发布，GPT-6 Luna XHigh/Bacon处理两个模板UI文件合并，其他改动由主控核对。无付费生成、无自动浏览器/功能验收。

目标：全站统一标记，资产页集中找回，不复制资产。点赞每人每内容一次、总数对有权访问者可见；收藏仅自己可见，不返回收藏总数或收藏人。不改点数、所有权、共享或保留期，不做排行榜/奖励/通知。项目与画布工作入口、失败/临时产物和内部上下文不是标记对象。

- 本轮追加工作现场恢复：遵循2026-09-30新规则，仅收藏/点赞页记住按账号隔离的分类、搜索、条目位置和有界加载数量；当前标签记录优先、关闭重开有本地备份，显式链接优先。图标重置不删收藏。资产通用入口仅恢复上次收藏/点赞页签，切出即清除该入口记忆，其他旧资产设置不做全站改造。共享滚动hook默认行为保持原样，仅新列表启用长期恢复。回载最多240项，正常下拉加载不受该上限限制；账号切换或旧请求迟到不回填原账号内容。不记录媒体URL/内部上下文、不恢复任何生成或写入动作；媒体播放位置不在本次增量实现范围。
- 预发布：本地Prisma客户端生成和TypeScript、差异检查通过；未改本地数据库。v0.27.0沿用既有ReleaseNotice，版本取自package.json，保留稍后、手动检查及刷新确认。服务器候选构建、生产副本迁移演练与正式备份切换已完成，见下方本次发布回执。

| 编号 | 任务 | 完成标准 | 状态 |
|---|---|---|---|
| LF01 | 内容与入口清单 | 明确各类内容编号、权限和返回入口 | 已完成，清单见下 |
| LF02 | 统一后台记录 | 独立存储、幂等写入、取消与最小留痕 | 实施与生产迁移完成，待用户手动验收 |
| LF03 | 全站按钮接入 | 共用组件、状态同步、不干扰原操作 | 已部署清单内入口，待用户手动验收 |
| LF04 | 资产展示页 | 收藏/赞过可筛选、搜索、分批找回及使用 | 已部署，待用户手动验收 |
| LF05 | 权限与失效处理 | 撤权不泄露，失效占位可移除 | 权限代码核对及未登录拒绝检查完成，待用户手动验收 |
| LF06 | 发布交接 | 迁移授权、备份回退、发布检查及手动验收交接 | 已完成发布与交接记录 |

- 源码：`/Users/gouki-youdoo/.codex/worktrees/banana-image-channel/video-api-debugger`；分支`codex/content-reactions-20260930`，开始时线上v0.25.0/7391a07。生产入口保持sd2.youdooart.com。
- 存储：新增ContentReaction和ContentReactionEvent，只含用户ID、类型化内容编号、布尔标记、版本/时间、操作请求指纹，不存原图/原文/上下文。唯一约束防重复，明确设置true/false而非toggle，版本冲突与相同requestId核对；允许撤权后删除自己的标记，不允许凭收藏扩大访问。
- 迁移：使用已审阅的新增表SQL，不执行db:push或整库迁移。现已获本次授权，执行前数据库备份/完整性检查、校验仅新增两表；候选构建使用副本。回退恢复旧代码但保留新增表及新记录，不恢复整库覆盖运行期数据。
- 内容映射：图片生成每张已有asset_id，上传/工具入库产物用asset；reference_image带asset_id时归一到同一asset，不能按URL合并。视频统一video_task；图片模板分别image_template（共享preset）和image_module（个人模块）；视频模板video_template、video_draft（个人模块）、legacy_template；具体保存文案prompt（VideoStudioRun）。旧Seedance官方素材seedance_asset按现有内部权限，不抓上游数据。无稳定独立业务编号的临时节点不伪造资产。
- 访问：复用任务/项目权限、图集view/use/download差异、图片模板租户共享边界、视频模板与文案私有投影。收藏列表只显示当次授权的摘要，不持久化私密快照；不可用项不含标题原文/头像/媒体URL；媒体再次访问、下载、模板应用、文案交接均重新鉴权。网络/离线与删除区分，不自动取消收藏。
- 页面：统一React按钮用于卡片/详情/预览，隔离click/pointer/keyboard，列表/同页/其他标签页失效刷新。资产页加“我的收藏/我赞过的”，图片/视频/音频/模板/提示词筛选、全口径计数、批量加载、浏览恢复、取消撤销。画布复用同一后台协议及真实产物编号。
- 开源：采用已讨论的多态收藏与唯一约束思路，独立实现，不搬GPL/AGPL代码或引入完整书签服务。本轮web工具读取失败后，已通过公开源码地址实际读取Discourse的[bookmark.rb](https://github.com/discourse/discourse/blob/main/app/models/bookmark.rb)及[post_bookmarkable.rb](https://github.com/discourse/discourse/blob/main/app/services/post_bookmarkable.rb)：参考多态类型、用户/目标唯一约束、列表及创建时分别检查权限。未安装或运行Discourse；沿用项目现有Prisma、权限helper与lucide控件。
- 风险：历史公开直链无法因收藏权限自动撤销，不能承诺收回已下载文件；本功能不延长媒体寿命。必要静态/候选构建、迁移与发布安全检查保留，不付费生成，不主动浏览器/功能验收；最终交用户手动验收，未通过不标功能完成。

#### LF 内容及返回入口

| 内容 | 唯一编号 / 权限 | 已接入入口 / 找回后的入口 |
|---|---|---|
| 已保存图片、视频、音频 | `asset:id`；所有者/管理员或现有图集分享、模板素材可见权限 | 资产卡及详情、上传历史选择器、图片模板结果与大图、画布有assetId的节点；按原权限预览/下载/带到生成 |
| 参考素材 | `reference_image:id`，有asset_id先归一为asset；沿用图集view/use/download区分 | 图集详情、图集选择器及大图；返回`/collections/:albumId` |
| 成功视频任务 | `video_task:id`；任务/项目权限+保留状态 | 普通生成、模板生成、任务列表/详情、项目任务列表、视频卡任务、超分列表、后台产出、模板文案关联视频、画布视频节点；返回`/tasks/:id` |
| 图片共享模板 / 个人模块 | `image_template:id` / `image_module:id`；共享租户边界与个人所有权，来源撤权不可用 | 模板库/模块标题；收藏共享模板只打开当前模板库并置顶该模板，明确点击应用才创建个人模块；个人模块按moduleId打开 |
| 视频及旧模板 / 个人模块 | `video_template:id`、`legacy_template:id`、`video_draft:id`；内部用户+现有模板可见性/归属/状态 | 视频模板侧栏/详情、模块侧栏/详情、旧模板详情；返回原模板页，不自动生成视频 |
| 已保存文案结果 | `prompt:VideoStudioRun.id`；仅本人成功且安全投影的具体版本，原模板撤权/停用不可用 | 文案结果与历史详情；未保存编辑不可标记；从资产页重新鉴权后复制，或打开原结果继续编辑/带到生成 |
| 旧Seedance官方素材 | `seedance_asset:id`；现有内部账号边界，排除已删除 | 旧素材面板；只读本地保存记录，不为点赞收藏调用上游 |

边界：项目/画布本体、节点草稿、没有独立持久业务编号的画布文本不在首期内容对象范围内；后台点数/成本/审计列表不是收藏对象。画布已入库媒体使用原asset/task/reference编号，绝不按网址创建另一条记录。收藏保留记录不等于媒体备份。

#### LF 本次发布回执（2026-09-30）

- 已部署v0.27.0，源码`f729a634e2f9d2c5e433f2a4e84d88bce7197a1e`，BUILD_ID `xhlwd4y69M8N8B9atvP6f`。入口：[我的收藏](https://sd2.youdooart.com/assets?view=favorites)、[我赞过的](https://sd2.youdooart.com/assets?view=likes)。原卡片、预览和模板入口增加共用点赞/收藏控件；不另建独立网站，不复制资产。
- Git分支`codex/content-reactions-live-20260930`与回退tag `rollback/2026-09-30-before-content-reactions-live`已推送并ls-remote核对。回退指向v0.26.1/9477c46，保留下载及周期额度功能。源包SHA-256两端一致：`5ecb35df3e5cfe236855070040467cab4efe90fe2a3200fb1355ad4f9f40bbc4`。仅文档回执后续提交，不另升版本或重启。
- 数据保护：`/srv/video-api-debugger/backups/content-reactions-f729a634e2f9d2c5e433f2a4e84d88bce7197a1e`保留旧source、live-build、generated-client、正式切换前`pre-switch.db`与构建用副本。先在副本新增两表、检查完整性/旧schema未变/重复执行，再候选构建；正式切换时确认图片和文字running=0，停止四个服务后备份并事务新增两表。未执行db:push，未改旧业务记录、密钥或运行媒体。回退只恢复旧源码、构建、生成客户端和deployed-commit，保留新表与新记录，不整库恢复。
- 发布检查：`npm run db:generate`、`npx tsc --noEmit`、`git diff --check`、服务器隔离`NEXT_DIST_DIR=.next-prod-candidate npm run build`通过；候选包含新API、收藏页及之前的download_body_timeout/generationFeedback修复。仍有原有img/CSS等非阻断警告。正式库两表与批准结构一致；迁移前后完整性检查通过。
- 公网release=0.27.0，config/login=200且来源server-42-193，源站config=200；四个服务sd2-gray/image-studio/template-prompts/periodic-credits均active/running，NRestarts=0。未登录点赞收藏列表返回401。公网静态文件`app/assets/page-e9933bce3fd7f208.js`、`7826-b2139e940fb45db7.js`、`4369-2df8778c86aca12f.js`均200，含收藏/赞过/重置、共用API按钮和模板接入标记。重启期间健康探测首次连接未就绪，后续探测通过；发布窗口开始/完成均已登记。
- 本轮41个文件明细及职责见下方既有实现清单与[统一代码差异](https://github.com/goukiyang/seedance-api-debugger/compare/cee70f15bd0218af5099d82e9acfd81be6865f82...f729a634e2f9d2c5e433f2a4e84d88bce7197a1e)。新增增量：`src/lib/hooks/use-remembered-scroll.ts`仅opt-in支持长期安全位置恢复；`ContentCollections.tsx`与`assets/page.tsx`补本轮安全偏好恢复。package/lock只有版本变化、没有新增依赖；本次.gitignore无需变更，tsconfig只保留候选类型入口。
- 用户手动验收：点赞/收藏及刷新后状态、跨页与多标签、取消撤销、搜索筛选/位置恢复、深链接优先、账号切换、已删除或撤权内容、图片多张独立标记、手机键盘和画布拖动。未运行浏览器、付费生成或自动业务验收，不把发布检查冒充功能验收。
- 已知限制：超大个人收藏集权限逐条解析未压测；回载位置最多240项，之后可继续正常分批加载。旧公开直链不随收藏权限撤销，收藏不等于备份；未补全站旧页面及媒体播放位置持久化。踩/每文件备注/Agent只读后台仍未实施。守门员核对：本轮触及已获授权的两表新增及既有内容权限复用，无扩大权限/覆盖旧数据/付费，无分级归类误判。

#### LF 既有实现与历史候选检查（非本次上线结论）

- `prisma/schema.prisma`、`prisma/migrations/20260930120000_content_reactions/migration.sql`：两张独立记录表、唯一约束和列表索引。`scripts/migrate-content-reactions.mjs`：默认只输出计划；显式apply时先备份、校验完整性，再事务新增表；既有表结构不一致或部分存在即停止；重复执行只核对，不覆盖。仅在原库已有Prisma迁移记录表时登记本次迁移。
- `src/lib/content-reactions/types.ts`定义跨页协议；`content.ts`集中编号归一、权限及安全摘要；`service.ts`处理本人状态、精确列表计数、游标、显式设置/乐观版本锁/请求去重；`http.ts`负责会话、活动账号、同源写入和脱敏报错。
- `src/app/api/content-reactions/route.ts`为列表/写入；`state/route.ts`批量状态；`content/route.ts`重新鉴权后打开/复制；`media/route.ts`重新鉴权后预览/下载。所有新响应私有且no-store，不输出收藏总数/收藏人/上下文快照；旧公开直链仍有上述限制。
- `src/components/content-reactions/ContentReactions.tsx`共用按钮、批量请求、同页/跨页缓存和标签页失效更新，隔离点击/指针/键盘；不确定结果重试同一请求号。`ContentCollections.tsx`负责分类/搜索/完整计数/分批加载/筛选和浏览位置恢复/取消撤销/预览与再次使用，不持久保存私密内容。`CanvasReactions.tsx`在现有同源iframe节点挂载同一React控件，不另做后台；`reactions.module.css`为紧凑操作区与列表样式。
- 页面接入文件：`src/app/assets/page.tsx`、`src/app/image-studio/studio.tsx`、`src/app/template-studio/page.tsx`、`src/app/tasks/page.tsx`、`src/app/tasks/[id]/page.tsx`、`src/app/projects/[id]/page.tsx`、`src/app/projects/[id]/video-cards/[cardId]/page.tsx`、`src/app/collections/[id]/ReferenceAlbumDetailClient.tsx`、`src/app/admin/outputs/AdminOutputsClient.tsx`、`src/app/tools/ultimate-canvas/CanvasFrame.tsx`。分别新增当前内容的共用按钮/资产页页签/受控返回参数，保留既有生成与侧栏滚动流程。
- 组件接入文件：`src/components/generate/GeneratePageClient.tsx`、`src/components/generate/EnhanceVideoPageClient.tsx`、`src/components/templates/TemplateGenerateClient.tsx`、`src/components/templates/TemplateLibraryClient.tsx`、`src/components/template-studio/VideoTemplateWorkbench.tsx`、`src/components/template-studio/VideoPromptResult.tsx`、`src/components/UploadedImagePicker.tsx`、`src/components/ReferenceAlbumPicker.tsx`、`src/components/SeedanceAssetPanel.tsx`、`src/components/ZoomableImagePreview.tsx`。只关联真实持久编号，不改模型、点数或上传逻辑。
- `package.json`/`package-lock.json`只更新应用版本为候选v0.26.0，无依赖变动；`src/lib/release.ts`更新用户可见摘要，沿用已有升级弹窗/稍后/手动检查机制，未声称验证弹窗效果；`.gitignore`/`tsconfig.json`登记隔离候选构建目录；本todo维护同一任务清单。
- 检查进度：Prisma客户端生成、TypeScript与diff检查通过；离线迁移安全演练通过（临时库、原哨兵记录保留、两张新表、备份/数据库完整性、重复执行及外键结构核对）。首轮发现的Map/Set旧编译目标问题、普通函数误用use前缀、nullable预览字段和备份命令输入问题已整批修正。最终候选构建`NEXT_DIST_DIR=.next-reactions-candidate npm run build`退出0，BUILD_ID `hsUkStM5aqeF49VxOpjsU`；仍有img/CSS等非阻断警告。不确定写入期间锁住另一操作，只可重试原请求，避免断网后误写。未调用生成、未扣费、未执行浏览器或自动功能验收。
- 生产仍为v0.25.0/7391a07，已重新只读确认。本轮尚未修改生产数据库、服务或发布目录；不能把本地实现说成上线。待授权后先按release-window-coordination登记窗口并重新核对当前线上代码，再从本轮commit归档创建候选目录，复制依赖后在候选中生成Prisma客户端、仅在数据库副本应用新增表并构建；通过后备份生产库、执行指定新增表SQL、同步源代码与生成客户端、保留旧构建并切换服务，核对公网release/config/login与新静态产物。失败恢复旧代码/构建/客户端，不恢复整库、不删除已产生的点赞收藏。
- 待手动验收：跨页面/多标签同步、多图逐张标记、取消撤销、搜索全口径计数、图集view/use/download差异、撤权删除占位和隐藏上下文、离线媒体提示、模板当前版本、编辑后文案版本、鼠标/键盘/手机与画布拖动、刷新位置恢复。列表按权限逐项解析，超大个人收藏集的服务端查询耗时未做压测；恢复加载上限当前为240项，超过时可继续分批加载但不保证回到原像素位置。

### M01 视频文案模型选择（2026-09-30）

| 编号 | 任务 | 完成标准 | 状态 |
|---|---|---|---|
| M01 | 文案模型选择 | 下拉选择随任务传到后台，保留费用提示，部署后交用户手动验收 | 已部署v0.25.0，待用户手动验收 |

- 用户指定新增GPT-5.6 Luna/Sol与GPT-6 Luna/Sol/Astra，保留GPT-5.5；不包含Terra或图片模型。复用当前页面的原生select，不引入依赖、不新建页面、不修改后台全局默认。文案费用继续由平台承担，无付费测试。
- 前后端共用受控模型列表，选择进入请求、幂等核对和运行快照，worker使用任务中的模型；新任务排队后不跟随全局默认变化，旧任务兼容原逻辑。结果显示所选模型，不污染后续视频model参数。
- 模型选择按用户/模块保存本机临时草稿，刷新先默认、可点“恢复上次模型”；不覆盖模板默认值。请求结果不明时锁定模型并沿用原请求号核对，禁止换模型重投同一请求。
- 已部署v0.25.0：源码`7391a07e982dc21edf702c5bcf793868a0f484af`，BUILD_ID `00VuqIBYW9eo3OgHo1vS_`；`npx tsc --noEmit`、`git diff --check`、服务器候选构建及内置检查通过。公网release=0.25.0，config/login均200，模板chunk `page-fbe0b56a353e6653.js`可达且包含下拉控件及5个新增模型ID，源站config=200，三服务active。未执行浏览器、模型生成或自动功能验收，沿用文字调用45秒超时及JSON输出约束，各模型的实际兼容性由用户手动验收。
- 代码与`rollback/2026-09-30-before-text-model-select`已推送核对（回退到ea44dcb/v0.24.0）；服务器备份`/srv/video-api-debugger/backups/text-model-select-7391a07e982dc21edf702c5bcf793868a0f484af`保留旧source/live-build。上线前文字队列为空，无schema/配置/密钥/历史数据修改；回退前需停止接收新文字任务并处理排队任务，避免旧worker忽略新增模型选择，不恢复整库。
- 修改文件：`src/lib/template-studio/text-models.ts`集中受控列表和显示名；`capabilities.ts`下发选项及默认值；`types.ts`/`projection.ts`提供安全模型字段；`runs.ts`保存选择并核对重复请求；`worker.ts`按任务模型调用；`VideoTemplateWorkbench.tsx`下拉、临时恢复与请求传参；`VideoPromptResult.tsx`结果同行显示模型；`template-studio.module.css`复用现有控件布局；`package.json`/`package-lock.json`及`src/lib/release.ts`更新单一版本与摘要；本todo登记。无新依赖、无功能越界；未验证项不冒充通过。
- [统一代码差异](https://github.com/goukiyang/seedance-api-debugger/compare/851dac289f424e6d7ea526b5ed260281776dcdd2...7391a07e982dc21edf702c5bcf793868a0f484af)。入口：https://sd2.youdooart.com/template-studio?type=video ，模块“文案生成”区域的“文案模型”。

- 2026-09-30 VP01–VP06 视频文案模板已部署v0.24.0，待用户手动验收：[固定工单及逐项回执](../docs/handoffs/video-prompt-template-work-order.md#10-发布回执2026-09-30)。复用现有模板页、文字worker和配置存储；两层上下文安全投影、文案可编辑、最终文本交接；费用开关获用户明确授权启用，平台承担文字费用。源码ea44dcb、远端及回退tag已核对，候选构建/服务/公网版本检查通过，未做生成或浏览器验收。图片/视频结果头像姓名不独占一行。B11由本单实现，剩余风险见工单。

### B13–B15 草稿与浏览恢复（2026-09-30）

| 编号 | 任务 | 完成标准 | 状态 |
|---|---|---|---|
| B13 | 临时设置草稿 | 不覆盖默认值；刷新先默认，点击恢复后可另存，草稿可生成 | 已部署v0.23.0，待用户手动验收 |
| B15 | 浏览位置恢复 | 模板页刷新恢复主页面和图片侧栏滚动位置，保留独立滚动 | 已部署v0.23.0，待用户手动验收 |

- B13用户确认恢复方式。图片参数/提示词/参考图保存在按用户及模块隔离的浏览器草稿；刷新默认不自动套用，恢复后“另存为”高亮，新模板仍走现有另存接口。结构信息（名称/分组/banner）仍即时保存，上下文仍明确手动保存。生成请求携带临时model/quality/ratio/resolution/count/references，后端验证模型与档位后按服务端价格处理，权限、来源有效性、修订/幂等和积分校验保留；不将参数草稿写回模板默认配置。
- B15参考并阅读[React Router ScrollRestoration源码](https://github.com/remix-run/react-router/blob/main/packages/react-router/lib/dom/lib.tsx)的sessionStorage/pagehide方式（MIT），为现有Next.js编写轻量适配，不安装额外路由框架。按用户、图片/视频页面分别记录，图片记住分组/活动模块及独立侧栏滚动；异步布局变化期间恢复最多10秒，主动滚动/点击/触摸即停止恢复。浏览器禁用存储时不阻止使用，内容删除或超出当前加载范围不承诺相同像素位置。
- 合并B14为v0.23.0；0.22.2仅中间代码提交、未发布。只执行发布必需构建和健康检查，用户手动验收；B11仍未实现，不借此次上传声明已完成。
- 发布：`5492284173c0516a20d67dd2dd38d2c92274ab13`，BUILD_ID `7DRPYjjuMaeWSu4ceoes5`。候选构建及内置检查通过，公网release=0.23.0，config/login/模板chunk均200，三服务active。代码和回退tag `rollback/2026-09-30-before-draft-scroll` 已推送；旧源码/构建留于服务器 `backups/studio-draft-scroll-5492284173c0516a20d67dd2dd38d2c92274ab13`。未执行功能/浏览器验收或付费生成，未迁移生产数据库。

### B14 设置读取失败误报（2026-09-30）

| 编号 | 任务 | 完成标准 | 状态 |
|---|---|---|---|
| B14 | 排查生成设置频繁读取失败 | 找到原因，修复并部署 | 已部署v0.23.0，待用户手动验收 |

- 最近访问日志中55次GET及1次PUT均200，不代表所有历史请求都成功。代码确认settingsError混用了读取/保存异常与草稿保护提示，B12将其统一称读取失败；module.prices对象变化又会触发通用设置重读，模板自动保存会放大此问题。
- 去掉模块价格对象对重读effect的触发依赖，改ref保留后备值；草稿保护/保存中提示移到saveStatus，不伪装网络错误；全局草稿初值复用已读取设置，避免第一模块切换后空上下文误判脏稿。真实异常原文保留，按钮旁增加重新读取；重试仅GET，未保存草稿先确认，不再按settings存在与否擅自PUT。
- 前端状态修复已合并到v0.23.0发布（v0.22.2只是未发布的中间提交）；B13随后获得用户确认并同步落地，详见本页顶部。无付费生成/生产数据改写，用户手动验收。

### B12 生成受阻原因说明（2026-09-30）

| 编号 | 任务 | 完成标准 | 状态 |
|---|---|---|---|
| B12 | 生成受阻原因说明 | 按钮旁明确显示原因和处理办法，完成后自动部署 | 已部署v0.22.1，待用户手动验收 |

- 图片模板按钮统一使用generationBlocker控制禁用和说明，覆盖服务/价格/上下文未配置、读取失败、设置未保存、上传/保存/提交中、比例待确认、无图片与提示词、数量无效、停止共享；服务器处理banner期间也不允许提前生成。未知提交沿用原请求重试，不改计费或放开服务端检查。
- 视频模板直接套用/AI整理分别显示具体字段及缺失素材名，不再只说几项未填；补充登录失效、草稿冲突、素材处理中、上次请求待核对原因。普通生成及模板转入的共享GenerationComposer在提交栏旁常显真实拦截原因，普通提及提醒不覆盖提交阻碍。
- 仅前端说明与按钮一致性，不重构生成/权限/扣点逻辑，不进行付费调用或自动功能验收；v0.22.1。B11上下文功能仍独立待办，本轮不宣称其已实现。
- 发布：`b138988426e397614adafdee500666065290cd9f`，BUILD_ID `tDtzx0rY5sJ3OP6de77ip`。候选构建与内置检查通过，公网release=0.22.1，config/login/模板chunk均200，三服务active。代码与回退tag `rollback/2026-09-30-before-generation-feedback` 已推送，服务器旧构建位于 `backups/studio-generation-feedback-b138988426e397614adafdee500666065290cd9f/live-build`。未执行功能验收或付费生成。

### B13 设置调整只保存临时草稿（2026-09-30）

- 用户明确：每次修改设置自动保存为临时草稿，不自动覆盖模板默认值；“另存为”在有修改时激活；刷新后草稿仍须保留。替代此前将生成参数自动写回默认值的解释，但生成不能被手动保存动作阻挡。
- 用户已确认：刷新先展示默认值，按钮显示“恢复上一次”，点击载入草稿后改为“另存为”。已随v0.23.0实现部署，详见本页顶部；不再沿用此前待确认状态。

### B11 视频模板上下文缺口（2026-09-29）

| 编号 | 任务 | 完成标准 | 状态 |
|---|---|---|---|
| B11 | 视频模板上下文入口 | 可设置、保存并用于视频提示词，自动部署 | 由VP01–VP06实现并部署v0.24.0，待用户手动验收 |

以下为2026-09-29的历史缺口说明，已由2026-09-30 VP工单实现及发布回执替代；上方B12/B13中“B11未实现”同属当时发布状态，不代表当前状态。

- 用户反馈视频侧缺少上下文输入与通用上下文设置按钮。已证实：VideoTemplateWorkbench仅模板编辑/另存为模板有recipe.instruction（“固定要求”），草稿有prompt；不存在视频专用通用上下文配置。不能说只是入口隐藏。
- 必须沿用用户已确认的保密边界：通用上下文管理员编辑，不能随共享模板、普通用户DTO、历史记录、复制或handoff返回原文；模板上下文仅有编辑权限者修改，设置手动保存，不能借此次变更公开上下文。
- 当前runs.draftSnapshot将recipe.instruction直接拼入prompt，worker使用该prompt与instruction，handoff返回完整snapshot；因此不能简单把全局文本加进prompt或snapshot后直接返回。实施需同步划分服务端私有上下文与用户可见提示词、明确直接使用/AI整理/正式视频提交三条链路的注入点、冻结运行配置供历史复现，并核对所有返回/复制入口。
- UI目标：视频页顶部“通用上下文”（管理员），当前模板/模块附近“模板上下文”，使用与图片侧一致的编辑/保存交互，但视频与图片的通用上下文独立存放，不串用图片设置或计费。已有固定要求数据保留、不清空，需兼容历史模板。无付费生成、无生产数据写入；本轮只完成缺口说明，不宣称两个按钮已上线。

### B10 图片入口整合资产库（2026-09-29）

| 编号 | 任务 | 完成标准 | 状态 |
|---|---|---|---|
| B10 | 图片入口整合资产库 | 可上传本地图片，也可分类选择已有图片，自动部署 | 已部署v0.22.0，待用户手动验收 |

- 参考图与banner点击添加/更换后先选“上传图片”或“从资产库选择”；本地上传、粘贴拖入及真实进度保留。复用视频参考素材的UploadedImagePicker，新增可选imageOnly/selectionOnly模式，不改变原视频入口默认行为。
- 选择器展示本人有效图片，按全部/已生成/已上传分页；生成来源按成功ImageStudioTask关联或既有metadata.source=image_generation_api/workspace_generation判断，不猜文件名。未标记来源的历史素材归已上传；不扩大共享权限。后端分类及分页总数一致，前端避免旧分类迟到响应覆盖。
- 支持预览、多选、已有参考图去重、剩余数量限制；banner单选。选择资产不重新上传、不生成、不扣点，不在选择器新增删除能力；沿用模板自动保存。无数据库迁移/新依赖，v0.22.0，用户手动验收。
- 发布：代码 `2eb15dd8849fb4b43a24d008a9c6282b250fb2ea`，BUILD_ID `Xyv5Wrs25dP-dYnzfAwIW`。候选构建与内置检查通过，公网release=0.22.0，config/login/模板chunk均200，三服务active。代码及回退tag `rollback/2026-09-29-before-image-source` 已推送核对，旧源码/构建保留于服务器 `backups/studio-image-source-2eb15dd8849fb4b43a24d008a9c6282b250fb2ea`。未做功能/浏览器验收，无生产数据迁移或付费调用。

### B09 图片上传真实进度（2026-09-29）

| 编号 | 任务 | 完成标准 | 状态 |
|---|---|---|---|
| B09 | 图片上传真实进度 | 显示实际上传百分比，区分上传、处理和失败，自动部署 | 已部署v0.21.2，待用户手动验收 |

- 模板页参考图（选择/拖入/粘贴）及banner复用既有uploadFileAsAsset的XHR字节进度和UploadProgressIndicator；多图显示当前文件序号/总数及文件名。不模拟百分比，无可计算字节时只显示阶段；传完进入服务器处理，成功后加入图片并清理进度，失败仍显示既有错误反馈。保留已成功上传图片，不自动重投生成，无后端/权限/计费修改。候选v0.21.2，仅发布必需检查，用户手动验收。
- 已发布：代码 `a476a42719eac4fbb8ab92541ea584184a9235e6`，BUILD_ID `2bvAFk00WJZIP7WoP3jPL`。候选构建及内置检查通过；公网release=0.21.2，config/login/模板静态资源均200，三个服务active。代码及回退tag `rollback/2026-09-29-before-upload-progress` 已推送；旧构建保留服务器 `backups/studio-upload-progress-a476a42719eac4fbb8ab92541ea584184a9235e6/live-build`。未执行浏览器/功能验收，未改生产数据。

### B08 img2.5-S 图片下载失败（2026-09-29）

| 编号 | 任务 | 完成标准 | 状态 |
|---|---|---|---|
| B08 | 修复图片下载链路 | 保留安全校验、明确失败原因，部署上线 | 已部署v0.21.1，待用户手动验收；历史具体根因仍无法追溯 |

- 只读生产日志确认两条gpt-image-2.5-sunburst任务（ID前缀652e8259、708ada1b）均为download / image_download_failed，outputSize=1632x2272，耗时110729/160137ms；httpStatus=200是生成接口响应，不是图片下载响应。相邻banana2任务成功，不能据此断言整个存储失败。
- 与此前banana pro的normalize错误不同；provider.ts捕获图片下载异常后统一替换为image_download_failed，worker.ts又统一显示“保存失败”，丢失具体网络/HTTP/超时原因，无法从现有记录证明具体根因。未获取或外传凭据、提示词、签名链接，未付费重试、未改生产数据。
- 下一步应先补下载原因的安全分类（HTTP状态、超时、DNS/TLS、大小/地址限制，不记录完整URL或凭据），区分用户文案，再依据真实原因修复；不可仅扩大图片大小限制或盲目绕过安全地址校验。原返回图片链接/原图未持久化，历史任务不能承诺无费用恢复。
- [用户截图](../../docs/materials/2026-09-29-image-download/codex-clipboard-14bb28f9-1ffc-4b55-8826-df6e6696eb6c.png)已归档登记。本轮仅诊断记录，不更改应用版本或部署；线上仍v0.21.0。
- 后续用户授权“修改”：v0.21.1补齐最多3次HTTPS重定向，每跳重新校验公网地址并固定DNS，无凭据转发；单跳下载60秒，继续受生成调用总signal限制。仅临时网络/DNS/超时/不完整响应/指定HTTP错误最多重试一次下载，不重发生成请求；大小限制、安全拒绝和TLS错误不重试。记录安全错误类别及真实下载HTTP状态，用户提示区分下载与转换/保存，不记录签名URL、凭据或原始错误内容。不恢复历史图、不生成、不改计费。
- 发布：`5ae18632ef13fe7dfe600452473cda1af14ea345` / BUILD_ID `y66xMp8V0pQexwFUR-n_o`。候选构建（含类型/lint）通过；公网release=0.21.1、config/login/模板chunk均200，三服务active。代码及回退tag `rollback/2026-09-29-before-image-download` 远端已核对，旧构建留在 `backups/studio-download-5ae18632ef13fe7dfe600452473cda1af14ea345/live-build`。未执行功能/浏览器验收或付费调用；这次兼容修复不等于已证实历史根因或实际新生成成功。

- [ ] 2026-09-29：模板工作台0.20.0已发布。后续0.20.1重做目录遭用户拒绝，已回退0.20.0；该候选与回退记录保留分支`codex/template-studio-20260929`（4bb7398），不得随本轮修复重发。正确目标是保留图片生成原结构，只在侧栏增加视频大类及折叠小类；共享项进入原列表，但不得公开内部上下文。该布局任务暂缓。
- [ ] P1：旧共享模板列表、套用副本和模块DTO仍可能返回内部context，回退不代表保密修复；模板管理的external+admin访问边界也存在既存契约失败。两项不属于P01手势修复，保持待办，不称安全闭环。

## M01 图片模型简称与生成者（2026-09-29）

| 编号 | 任务 | 完成标准 | 状态 |
|---|---|---|---|
| M01 | 统一模型简称与头像 | 显示指定简称，生成者头像与资产库一致，上线可见 | 已完成 |
| M02 | 鼠标位置缩放 | 放大缩小围绕鼠标位置，拖动和关闭不受影响 | 已完成 |

- 用户指定结果卡模型简称为 `ba2`、`baPro`、`img2`、`img2.5-F`、`img2.5-S`，仅改显示映射，不改真实模型ID、费用或请求参数；模板图片结果与资产库共用简称字典，悬停模型仍可查看完整名称。
- 图片结果复用资产库 `UserIdentityBadge` 与卡片头像尺寸，显示实际任务生成者头像和姓名，缺失或加载失败沿用首字占位；保持侧栏、预览、下载和生成入口。任务查询依旧按当前获准owner过滤，仅增加该任务owner的安全展示字段，不新增跨用户访问、不返回邮箱或凭据、不改上下文。
- 实现/测试全部完成后统一跑简称与owner隔离测试、既有UI烟测、tsc/lint；随后从0.20.4接续发布0.20.5，保留回退点，核对公网正式页真实头像与模型简称。无新依赖、数据库迁移、付费生成。
- M02用户补充：缩放必须以鼠标为轴心。普通预览原来已有单次滚轮定位公式，但横/纵对比错误使用总stage中心，连续事件分离更新scale/offset还有旧值风险。使用同一view函数式更新，按鼠标所在pane中心换算；缩放按钮/键盘沿用最近画面指针位置，未指向画面才回退中心；移除transform延迟以免移动鼠标时追赶旧位置。保留拖动防误关、Esc/背景关闭、还原和对比联动。参考[anvaka/panzoom实际zoomByRatio实现](https://github.com/anvaka/panzoom/blob/main/index.js)，现有共享组件已具备行为，无需替换或新增依赖。
- 统一本地验证：`node --import tsx scripts/image-studio-result-identity-smoke.ts`通过，真实listStudioTasks配内存Prisma验证五简称/模型ID不变、owner查询隔离、DTO仅id/name/avatar_url、失去owner时null；未连接真实DB。`image-studio-ui-smoke.ts`、`npx tsc --noEmit`、`npm run lint`通过（仅既存警告）。
- 扩展`image-preview-drag-browser-smoke.ts`使用真实组件、CSS和Chrome鼠标wheel，单图及横/纵对比两侧的放大/缩小、键盘/按钮、同批次滚轮、0.5x/6x极限均保持鼠标下像素误差<0.25px；拖动/背景轻点/Esc/按钮关闭回归通过，无外网/生成调用。首轮测试误把小数坐标当成MouseEvent整数坐标，最大倍数时出现3px测试误差，校正测量点后通过，未为此改业务代码。旧884d81a组件相同测试在键盘轴心环节失败，证实回归脚本能识别旧行为。
- 固定审核001发现鼠标捕获拖出stage后会保存区域外坐标（回执将M01/M02编号写反，实际属于M02）；新增命中区域校验，离开预览区域保留最后有效缩放点，并补真实拖出后按钮缩放回归。首个5624a83候选已构建但未上线，待此修正统一复测后用新提交替换；不重复抬版本，不覆盖生产数据。
- 修正后完整缩放/拖动浏览器脚本通过；同一脚本对5624a83在“outside drag must retain last in-stage y anchor”失败，确认新增回归能复现审查问题。固定审核001已静态复核防护通过，M01 owner隔离结论也通过；不把静态审查冒充页面验收。
- 最终发布：`f314b0b3103a2e07babe719ee0daf6da1847d2ac`远端分支可见，`rollback/2026-09-29-before-result-identity-zoom`指向884d81a(v0.20.4)。修正后tsc和指定文件lint通过（既存img警告），候选构建通过，归档SHA256 `7570d085eb6a568ff8b00f606a3ce3906cda753c80ae602ba7c0004d038d31a8`两端一致；正式v0.20.5、BUILD_ID `GGKNIF_UU4P5wF28oBjxA`。发布窗口已认领/复核/完成，三服务active、源站config200、公网release/config/login200、13/13登录页静态资源200，0.20.4回退构建保留`backups/result-identity-f314b0b3103a2e07babe719ee0daf6da1847d2ac/live-build`。切换尚未就绪时曾短暂502，启动后统一复测全200；无迁移或生产数据覆盖。
- 正式登录态Chrome v0.20.5：5张结果卡都有头像，前三张实图naturalWidth>0、头像宽22px、姓名浅色可读，历史数据可见img2.5-S和img2.5-F，五模型精确映射另由本地测试证明，无为验收付费生成。截图`/tmp/sd2-m01-result-identity.png`已查看（临时证据，不作为永久资料入口），卡片信息无重叠，原侧栏保留。正式加载JS有2个chunk含新简称、失败静态请求0，真实点击预览、键盘+后scale1.2、还原/Esc关闭通过。
- 证据边界：线上bsk合成wheel被工具的BROWSER-SKILL-OVERLAY命中层拦住，宽度未变，不将其0偏差当作缩放成功；CUA连接该tab超时。正式原生滚轮没有另证，完整轴心行为依据相同产物源码的隔离Chrome真实wheel/拖动回归。旧客户端会话在构建期间停止，未重演本次旧版更新弹窗；ReleaseNotice实现未改，复用S01既有手动提醒/稍后验证，当前release摘要和加载版本一致。正式浏览器自有会话已停止，未操作用户原页/输入/提交。

## S01 分组侧栏整理（2026-09-29）

| 编号 | 任务 | 完成标准 | 状态 |
|---|---|---|---|
| S01 | 整理左侧分组栏 | 不遮挡标题、滚动条弱化，原有上下滚动和导航保持可用 | 已完成 |

- 用户确认保留侧边与页面上下翻动；只整理标注侧栏，不重做模板目录、不修改上下文、分组选择或生成接口。原图与来源见[资料索引](../docs/materials/index.md)。
- 原因：侧栏固定top73px与实际顶部导航48px不一致，模板工作台标题没有为236px侧栏留位，原生白底滚动条未按深色侧栏适配。修正为复用导航高度变量、仅图片模式标题左侧留268px（与原内容起点一致），侧栏细灰滚动条及小幅组间距调整。不添加滚轮拦截、页面滚动锁或新依赖，保留滚动条可拖动。窄屏保留既有横向导航，仅避免粘性导航被顶部栏挡住。
- 复用现有原生overflow滚动，参考[MDN scrollbar-color](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/scrollbar-color)及WebKit兼容样式；不用新滚动库，不隐藏滚动条。
- 0.20.3生产接续候选0.20.4；统一验证原CSS的真实wheel侧栏/页面独立滚动、首尾可达、标题无重叠、手机不被桌面留白挤窄，关联banner/UI回归、类型/lint、候选构建、正式页只读DOM/滚动验收。不付费、不写生产数据，保留0.20.3回退。
- 两份真实CSS Module隔离编译的Chrome测试通过：1617×873侧栏与页面真实wheel互不影响，侧栏末项可达；1294×698标题不重叠、侧栏高度随窗口适配；390×844保留既有横向导航，标题没有桌面缩进残留。banner 9项与旧UI smoke通过；[合成布局图](../docs/materials/2026-09-29-sidebar/sidebar-layout-fixture.png)已查看。不读取私有上下文，不把合成DOM称为生产截图。
- 发布：`npx tsc --noEmit`、`npm run lint`、`git diff --check`通过（lint只有既存警告）。产品提交`884d81af3f7e8430efdc0bd42b8d4a48c64e09e7`与`rollback/2026-09-29-before-sidebar-scroll`→`ca6b417`远端可见；归档SHA256 `153fa5f5903485c8963e8d16959b08a02e938e3c7136c91f681299344b375a73`本地/服务器一致。候选数据库副本构建通过，v0.20.4 / BUILD_ID `Y-OqOk0NnSCyINO2So0Lm`上线；三服务active，源站/公网config、release、login、登录页13资源200；0.20.3回退构建保留于`backups/sidebar-scroll-884d81af3f7e8430efdc0bd42b8d4a48c64e09e7/live-build`，未迁移/覆盖数据库或媒体。
- 正式登录态Chrome 1200×753：顶部栏bottom48，侧栏top48/width236/height705，模板标题x302（侧栏right236），scrollbar-width thin、灰色透明轨道。侧栏PageDown后scrollTop134、window.scrollY0且末项可见；右侧PageDown后window.scrollY713、侧栏仍134/top48；点击第二子模块后对应activeLabel正确、目标标题进入视口，分组仍正确。无输入变更、无生成；临时聚焦标题编辑后已离开且nameEditing=false。自有浏览器会话已停止，用户原标签页未改。
- 旧客户端v0.20.3手动检查更新真实出现v0.20.4、正确摘要和20px/700字重的5字标题；“稍后”关闭后仍为旧版，手动检查可再次打开；新页面DOM显示v0.20.4。复用既有自动检测与刷新前确认代码，无新增机制；周期/自动前台触发本轮未等待重测。此项未读取上下文或整页截图，生产以目标DOM与键盘滚动行为为证，合成截图承担布局视觉核验。

## B01 模块 banner 高度（2026-09-29）

| 编号 | 任务 | 完成标准 | 状态 |
|---|---|---|---|
| B01 | 修复 banner 过大 | 横幅高度受控，不挤走下面内容，验证上线 | 已完成 |

- 用户在`/template-studio?type=image`标记模块banner过大；浏览器标记截图仅在会话中可见，无可访问附件路径，未声称已归档原文件。来源为本轮浏览器标注，主题：横幅过高，后续可按B01检索；证据中的私有内容不复制到公开资料。
- 原因：图片100%宽度、auto高度且无上限，横幅高度随容器宽和图片比例增长。只把已有图片横幅限制为桌面180px、手机120px，使用原有contain完整等比显示（[MDN依据](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/object-fit)）；空态保持96px，图片、模板、上下文、上传/删除逻辑与页面结构不改。不引入新库。
- 从0.20.2生产代码接续，候选0.20.3；统一验证真实CSS下桌面/宽屏/手机的横竖方图、按钮边界和工作区位置，旧UI脚本、类型/lint、候选构建、公网资源及登录态DOM。保留0.20.2回退，不改生产数据库或调用模型。
- 统一测试首轮发现新脚本的TS类型缺失和tsx回调序列化`__name`问题，集中修正脚本后布局9/9通过：桌面1617/2560横幅180px、手机390横幅120px，图片contain、两按钮容器内无重叠、无横向溢出、工作区间距24px；[合成截图](../docs/materials/2026-09-29-banner/banner-layout-fixture.png)已查看。旧UI smoke和lint通过，lint仅既存警告；未改产品行为去迁就测试。
- `npx tsc --noEmit`复测通过；产品提交`ca6b4176e37c87bd3cc8c5bb6103f2cf1a7dd374`及回退标签`rollback/2026-09-29-before-banner-height`→`f2f6558`远端已核对。归档SHA256 `b639b052da1614bae3ad34608773dfe0e5f991cc5dc7be0281415d1b8f50ec2a`两端一致；隔离数据库副本构建成功，v0.20.3 / BUILD_ID `IqD4sIESqRrsbQn9GBDLc`已上线，三服务active，源站与公网config/release/login及登录页13静态资源通过。旧构建保留于服务器`backups/banner-height-ca6b4176e37c87bd3cc8c5bb6103f2cf1a7dd374/live-build`；更新通知复用原ReleaseNotice（代码核对），未新增提醒机制，真实旧客户端弹窗本轮未单独复测。
- 登录态Chrome独立窗口实测用户标记模块`module-default-cmpipakyk001nmt1wx4t7wxzg`：桌面1200×753 banner180px/图片178px，contain，workspace top502px、banner bottom478px；手机390×844 banner120px/图片118px，contain，workspace top730.8px、banner bottom706.8px，均留24px间距。浏览器release API200/0.20.3与真实新尺寸相符；未单独读页面内版本标记。因局部截图工具需要整页语义快照，避免采集私有内容，本轮视觉截图仅用真实CSS合成图，线上以目标DOM尺寸为证，不声称已有生产截图。自有会话已停止，无业务写入或付费调用。

## P01 图片拖动误关闭（2026-09-29）

| 编号 | 任务 | 完成标准 | 状态 |
|---|---|---|---|
| P01 | 修复图片拖动误关闭 | 放大后拖动不关闭，正常关闭操作保留，上线验证 | 受阻：修复已上线，本地实测通过；线上真实拖动复验未完成 |

- 从正式a9d913c/0.20.0建立`codex/image-preview-drag-20260929`，不带入撤回目录。候选0.20.2，保留0.20.0回退构建和代码，不改DB、模板字段或模型调用。
- 根因：共享ZoomableImagePreview在stage捕获pointer，松手后的click可能指向stage，原处理仅按target等于currentTarget就关闭，误把拖动判作背景点击；单图和对比面板共用此链路。
- 最小修正：记录手势起点/移动及取消状态，抑制拖动后的关闭，普通背景点击、Esc、关闭按钮继续有效。保持原缩放、对比、导航、布局与内容边界，不替换库。
- 复用现有组件和Pointer Events，不新增依赖；依据[MDN pointer capture](https://developer.mozilla.org/en-US/docs/Web/API/Element/setPointerCapture)与[W3C事件派发](https://www.w3.org/TR/pointerevents3/#event-dispatch)。固定审核检查手势与范围；完整代码/测试写齐后统一验收。隔离真实浏览器拖动覆盖旧版失败、新版不关闭、背景关闭、对比、取消/丢失捕获与键盘退出，随后生产构建及线上相同动作验收。
- 隔离Chrome真实组件测试：`BASELINE_REF=a9d913c`在放大后从图片拖至背景时复现关闭（退出1，`/tmp/sd2-p01-baseline.log`）；相同脚本测试当前组件退出0（`/tmp/sd2-p01-browser.log`），验证移位后仍打开、随后背景轻点能关、图片本体轻点不关、Esc/关闭按钮、横/纵双图拖动均通过。只有合成图片，外网HTTP/Provider调用0。`node --import tsx scripts/image-studio-ui-smoke.ts`通过；此旧静态检查不代表上下文权限已修复。
- 固定审核001静态复核通过，没有阻塞问题或布局越界；pointercancel/lostcapture与其他pointer结束按ID隔离已读代码，未冒充真实触摸/取消事件实测。测试harness复用已安装esbuild和Playwright，不安装依赖；`npx tsc --noEmit`、`npm run lint`通过（lint仅既存img警告）。
- 2026-09-29发布：产品提交`f2f65588875f6672bdbee611489d991b0c53b826`和`rollback/2026-09-29-before-preview-drag`已推送核对；归档SHA256 `f7e9281f2efae1eb684e4632b7bd5c557277b7d67b2dd2f4a1d005a9a2401b27`服务器一致。隔离数据库副本候选构建通过，正式v0.20.2 / BUILD_ID `_9fK7s3pg8k4-7e-q5XCD`；三服务active，源站/public config、release、login 200，登录页13/13静态资源200。图片studio原页面源码与0.20.0逐字节一致，数据库schema未改、媒体未覆盖，保留服务器`backups/image-preview-drag-f2f65588875f6672bdbee611489d991b0c53b826/live-build`回退。
- 更新通知沿用已有ReleaseNotice及唯一package版本来源，未重写提醒；真实旧客户端升级弹窗未在本次重新验证。线上独立登录态页已恢复连接：DOM版本0.20.2，预览dialog打开、图片加载、缩放transform为scale(1.2)，22个静态JS请求200。线上真实拖动复验仍受阻：bsk不支持真实drag，native CUA受用户无关保存窗口阻挡，独立tab重新连接仍超时，未操作或关闭用户窗口。不以本地测试冒充线上鼠标实测；待浏览器可控或用户刷新实测后补齐最后证据。

- [ ] P1 / 2026-09-28 Seedance 2.5普通生成4–30秒：当前用户在三国全动作试验明确授权同步修改共享平台。线上97d48e8/v0.16.0为起点，独立工作树`worktrees/seedance25-duration30-20260928`、分支`codex/seedance25-duration30-20260928`，保留其他工作树脏改；v0.17.0已被未发布动画工作台候选占用，本次候选v0.18.0，不合入工作台功能。核对线上未变化后聚焦推送、回退点、候选构建、发布及真实页面验证；失败不切换线上。
  - 范围：模型感知时长单一规则，类型/普通创建/provider/估价/配置/下拉/偏好/复用/文档及Draft防少计时；2.0/IP/H3维持15，费率不变。Codex估价复用真实认证，普通web权限不扩大。参考输入逐条15及edit试点均不放宽；无线画布保留默认2.0入口，能力表按模型另列，不宣称画布可选2.5。无DB迁移、依赖变更或管理员生成。
  - 依据：[官方2.5模型页](https://seed.bytedance.com/zh/seedance2_5)30秒能力；既有`seedance-models.ts`注册表、`pricing.ts`/`pricing-client.ts`3×1.5/秒、mock provider脚本，复用已有实现不引新包。实际上游30秒/两段参考总30接受与否必须由授权真实试验另证，非本地mock证明。
  - 统一验证：修改整批完成后跑duration/model/edit/reference/draft/preference关联smoke、tsc/lint/build；严格检查3/4/15/16/30/31、小数/字符串、模型/provider隔离、135积分一致与cap134拒绝、两参考顺序。UI检查选2.5→30→切回2.0保留值但禁止提交、偏好/复用不丢模型；复用ReleaseNotice更新通知，不另造机制。
  - 固定审核为`019f44c6-64d3-7753-acd0-f31fc16763fb`，当前工具缺任务消息入口；未提交，不能用内部执行回执冒充。三国媒体审核另归其审核01。
  - 2026-09-28统一本地检查：新增duration及model/edit/draft/upload/provider-error共6项通过，TypeScript未报错，构建完成。reference-media-resolution-guard在`fillMissingAssetDimensions`源码断言失败、IP模型smoke在旧`VolcengineIpModelOption`类型名断言失败，两者已在未改的97d48e8工作树复现；不删断言假装全绿，不在本任务重写上传或IP模型。嵌套worktree导致ESLint读入父仓配置冲突，补本仓`.eslintrc.json`的`root:true`隔离；无规则关闭、依赖升级。待复测lint/tsc、服务器候选构建及页面确认。
  - F1素材任务、原件与批准身份图、全216条/1340ticks统计、费用授权及产物入口见`/Volumes/Data/Projects/三国/tasks/work-order-guanyu-replacement.md#f1-全动作长片识别与复刻试验2026-09-28`。本地代码/线上能力/真实生成/视觉复刻四层分别验收，不因时长入口完成即关闭F1。

- [ ] 2026-09-22：Seedance 2.5 Draft 到 1080p 直出，正文见 `tasks/todo/2026-09-22-seedance-draft-1080p.md`。

## 最近状态

### B05 删除模板（2026-09-29）

| 编号 | 任务 | 完成标准 | 状态 |
|---|---|---|---|
| B05 | 删除模板按钮 | 可确认删除，左栏同步移除，刷新不再显示 | 已部署，待用户手动验收 |
| B06 | 生成参数无需手动保存 | 更换模型、质量、分辨率后可直接生成 | 已部署，待用户手动验收 |
| B07 | 复制上下文仅管理员可用 | 普通用户无按钮，历史任务API不返回受限上下文 | 已部署，待用户手动验收 |

- 模板标题工具栏新增删除按钮，确认提示说明移除个人模块配置，不删除生成任务/资产、不退点、不删除模板库共享原件。默认模块是系统保底入口，不允许删除；有排队/运行任务时拒绝删除。
- 后端沿用会话及公司模板准入，事务内按owner和revision限制删除；不会删除他人模板或任务。前端互斥自动保存/删除，成功清理本模块浏览器草稿及目录；过滤删除前发起的迟到列表响应，避免再次显示。无数据库迁移，不自动执行生产删除测试。
- 用户补充确认B06：模型/质量/分辨率是本次生成参数，不属于需手动保存的后台设置；改为随模板内容自动保存，点击生成仍复用原有保存最新修订后提交链路。仅模块上下文、通用上下文及积分规则手动确认。此条替代B02中模型/质量/分辨率手动保存的旧解释。
- B07用户明确权限收紧：图片结果的复制上下文按钮及处理函数均要求管理员；历史任务DTO的globalContext/moduleContext仅按服务端会话role返回，非管理员为空；保留历史复现标志及服务端按任务ID复现，不将角色判断交给请求参数。普通用户自己编辑的模块上下文权限保持原样，不扩大本次范围。
- 参考：[本轮截图](../../docs/materials/2026-09-29-generation-save/codex-clipboard-dff3e760-f727-4220-95d1-909b0ee4ca91.png)，固定资料索引已登记。删除功能与B06合并为v0.21.0；早期0.20.8候选未构建/未部署，不作为已发布版本。仅必要构建与发布健康检查，用户手动验收。
- 发布完成：v0.21.0，代码 `fda91430cb050b32ab2365858276e124ca5b62b9`，BUILD_ID `a0sE_bKbU3BCiU-BJ8Tqi`。服务器候选构建及内置类型/lint检查通过（既存告警）；公网release为0.21.0，config/login/模板静态chunk均200，三个服务active。未执行浏览器、功能验收、付费生成或生产删除测试。
- 代码及回退tag `rollback/2026-09-29-before-template-delete` 已推送核对；tag指向v0.20.7 `f070b75`，服务器旧源码/构建及构建用DB快照保留于 `/srv/video-api-debugger/backups/studio-delete-fda91430cb050b32ab2365858276e124ca5b62b9`。无生产DB迁移或覆盖；上下文限制仅本轮结果复制/历史任务DTO，不代表顶部既存共享模板保密待办全部解决。

### B04 新建分组与模板刷新后消失（2026-09-29）

| 编号 | 任务 | 完成标准 | 状态 |
|---|---|---|---|
| B04 | 新建分组、模板刷新后消失 | 数据写入服务器，刷新后仍能读取 | 修复已部署，待用户手动验收；生产DB已确认数据仍在 |

- 已证实根因：生产账号已有19个模块，“写实”分组及新建模块均已写入DB；原GET按创建时间正序只取首12条，前端用这一页推导完整侧栏，导致较新的分组和模块刷新后被漏掉。不是数据删除或本轮需要重新写入。
- 修复：首次读取同时返回当前用户的完整轻量目录（仅id/名称/分组，不含上下文或素材）；内容保持每批12条，通过带现有鉴权的ids读取按需补齐。分组入口、模块定位、加载更多与删除分组成员范围一并处理，防止只操作已加载成员；不修改账户权限和数据库结构，不写生产数据、不新增依赖。
- 候选v0.20.7；继续沿用模板自动保存、设置手动保存和侧栏独立滚动。只做发布必需构建/健康/版本/静态资源检查，不派审核、不做自动功能验收或付费生成。
- 发布完成：v0.20.7 / `f070b75b36e923fa75813fe66458c9bd174ea78d` / BUILD_ID `7swbhEzNXX6eNvU0q70Wm`。首个候选因Set迭代不兼容既有编译目标而未发布，改用Array.from后服务器候选构建成功。公网release为0.20.7，config/login/模板静态chunk均200，三个现有服务active；未执行浏览器或功能验收。
- 代码与回退tag `rollback/2026-09-29-before-studio-directory` 已推送；回退指向0.20.6代码 `36be75f`，服务器旧源码/构建保留在 `/srv/video-api-debugger/backups/studio-directory-f070b75b36e923fa75813fe66458c9bd174ea78d`。未改生产数据。

### B01–B03 图片交付与模板保存（2026-09-29）

用户确认：模板内容自动保存；设置更新手动保存；创建分组立即显示在左栏。沿用本日项目规则：实现后自动部署，用户手动验收，不派审核、不跑功能验收、不进行付费生成。

| 编号 | 任务 | 完成标准 | 当前状态 |
|---|---|---|---|
| B01 | banana pro 图片保存失败 | 找到失败环节并修复 | 尺寸限制修复及诊断已部署，待用户手动验收；定位 normalize，历史异常细分原因未留存，不能宣称唯一根因已证实 |
| B02 | 新建模板自动保存 | 新建自动保存，仅设置更新保留手动操作 | 已部署，待用户手动验收；名称/分组/参考图/补充内容等500ms自动保存；上下文、模型/质量/分辨率及通用设置手动保存 |
| B03 | 左栏实时更新 | 创建分组后立即显示，无需刷新 | 已部署，待用户手动验收；导航使用即时名称/分组，隐藏而非卸载编辑器，保留待保存内容 |

- 证据：生产两条任务 `294d8880ac0d6e8e1751b51b2b54bc5950bf7ebde609dcb5bc2a271b982edc3e-0/-1` 均为 `gemini-3-pro-image-preview`、4K，worker记录阶段 `normalize`，约55.7/57.2秒。数据盘剩余约1.8TB。日志没有原始异常、图像字节数，不能断言历史两次一定是超限或解码失败。
- 代码问题：输出原先受28MB base64及参考图20MB读入/PNG转换限制；改为独立96MB生成输出边界，像素上限仍40MP，保持原分辨率及无损PNG。参考图转换仍20MB，不扩大上传权限。记录固定错误码、模型、尺寸、字节数，不记录图片、提示词、URL或密钥。旧失败图没有持久化原响应，本轮不自动重投生成、不重扣积分、不伪造恢复。
- 自动保存不提交设置草稿，保存串行、修订号防覆盖、失败明确保留重试；首次读取浏览器草稿后不在每次保存时反复恢复旧草稿。切换分组保持编辑器，离开页面仍有未保存内容时提醒。原侧栏与页面独立滚动不变。
- 参考：[用户原图](../../docs/materials/2026-09-29-banana-delivery/codex-clipboard-9d91fe74-e132-4ec2-a2cc-8b23064f474e.png)，已登记固定资料索引。只复用既有sharp与模块API，无新增依赖、无DB迁移、无计费和权限变更。候选v0.20.6，复用现有ReleaseNotice更新提醒。
- 发布：v0.20.6，代码 `36be75fa65f1c129b1b4e55b7bcd1caa1693ac4f`，BUILD_ID `j1-ATpRDZTy46Ojtr9QFQ`。服务器候选构建（含内置lint/类型检查）成功；sd2-gray、sd2-image-studio、sd2-template-prompts均active；公网release为0.20.6，config/login及模板页静态chunk均200。原有CSS/img告警未扩大处理。仅做必要发布检查，未运行功能回归、浏览器验收或付费生成。
- Git与回退：代码已推送；远端tag `rollback/2026-09-29-before-banana-autosave` 指向 `f314b0b`。服务器旧代码/旧构建保存在 `/srv/video-api-debugger/backups/banana-autosave-36be75fa65f1c129b1b4e55b7bcd1caa1693ac4f`；构建使用DB快照，不迁移或覆盖生产DB，运行媒体目录保留。

- 2026-07-28：原主 todo 完整迁移到 `tasks/todo/archive-2026-07-28-main.md`；备份见 `tasks/todo/backups/todo-20260728-232548.md`。
- 迁移前大小：7667 行，546944 字节。未直接删除原文内容。

## 历史归档索引

- `tasks/todo/archive-2026-07-28-main.md`：主 todo 瘦身前完整原文，7667 行，546944 字节。

## Todo 子文档索引

- `tasks/todo/2026-07-29-audio-upload.md`：音频素材上传统一链路
- `tasks/todo/2026-07-29-share-button-fix.md`：分享按钮失效修复
- `tasks/todo/2026-08-03-admin-dashboard-trend-redesign.md`：后台趋势图展示重做
- `tasks/todo/2026-08-05-upload-root-cure.md`：上传链路根治收口
- `tasks/todo/2026-08-07-reference-media-resolution-guard.md`：参考素材分辨率提交前拦截
- `tasks/todo/2026-08-07-stuck-video-polling-status.md`：长任务状态卡住修复
- `tasks/todo/2026-08-07-upload-provider-rules.md`：上传限制分层与生成准入收口
- `tasks/todo/2026-08-08-asset-library-integrity.md`：资产管理失败项、缩略图与用户归属彻查修复
- `tasks/todo/2026-08-11-sd2-video-download-delivery.md`：提交生成到稳定下载就绪优化
- `tasks/todo/2026-08-12-admin-cost-audit-p2029.md`：后台成本审计 P2029 崩溃修复
- `tasks/todo/2026-08-12-sd2-server-migration.md`：sd2 从 Mac 迁移到服务器闭环计划
- `tasks/todo/2026-08-13-assets-interaction-performance.md`：2026-08-13 资产管理页面切换与点击卡顿优化
- `tasks/todo/2026-08-13-seedance-25-video-model.md`：Seedance 2.5 视频模型线上接入规划
- `tasks/todo/2026-08-15-h3-api-integration.md`：H3 API 接入现有视频生成链路
- `tasks/todo/2026-08-15-stable-video-thumbnails.md`：视频截图稳定固化与历史补偿
- `tasks/todo/2026-08-16-h3-lora-selector.md`：H3 LoRA 下拉选择闭环
- `tasks/todo/2026-08-16-reliable-task-thumbnails.md`：任务卡片缩略图可靠显示修复
- `tasks/todo/2026-08-16-seedance-25-pricing-multiplier.md`：Seedance 2.5 按 2.0 的 1.5 倍扣费
- `tasks/todo/2026-08-22-external-access-guard.md`：外部用户权限收口与风险闭环
- `tasks/todo/2026-09-15-credit-applications.md`：积分申请与飞书审批
- `tasks/todo/2026-09-16-reference-picker-selection.md`：参考素材选择入口修复
- `tasks/todo/2026-09-19-assets-bulk-download.md`：资产管理批量下载无反馈
- `tasks/todo/2026-09-20-gpt-image-studio.md`：GPT Image 独立生图页与固定上下文
- `tasks/todo/2026-09-22-canvas-toolflow.md`：画布工具流基础能力
- `tasks/todo/2026-09-22-seedance-draft-1080p.md`：Seedance 2.5 Draft 到 1080p 直出
- `tasks/todo/2026-09-29-unified-image-video-template-workbench.md`：图片与视频模板工作台：上下游闭环规划
- `tasks/todo/wallverse-audio-20260715.md`：WallVerse 第一组「世界迁移」声音闭环
# 模板体验整合（2026-09-30）

用户确认：固定参考图属于模板上下文，每次生成都附带；每张独立备注，可添加、移除、重排。外部另加本次参考图。固定图在前、本次图在后，服务端按真实发送顺序统一编号，备注绑定图片而非旧编号。总数超限或固定图失效必须明示，不静默截断。历史复现使用当时固定图与备注。模块设置仍手动保存，本次参数仍临时草稿，不覆盖模板默认。

| 编号 | 任务 | 完成标准 | 状态 |
|---|---|---|---|
| UI01 | 结果卡片排版 | 尺寸悬停显示、头像和时间同行、红色点赞收藏固定在图左上 | 已部署v0.29.0，待用户手动验收 |
| RF01 | 模块参考图与图库 | 固定图/备注持久化与生成编号一致；上传、粘贴、选库及个人相册管理闭环 | 已部署v0.29.0，待用户手动验收 |
| RF02 | 参考图拖动排序 | 顺序可保存，与生成时编号一致 | 已部署v0.29.0，待用户手动验收 |
| UI02 | 紧凑上传弹窗与预览工具栏 | 上传菜单上下排列，空白关闭；预览不显示提示词，对比按钮居中 | 已部署v0.29.0，待用户手动验收 |
| NV01 | 入口隐藏与上次现场恢复 | 隐藏视频卡相关入口，移除独立图片生成导航，模板工作台按账号恢复上次类别与位置 | 已部署v0.29.0，待用户手动验收 |
| AP01 | 资产非横屏预览与侧栏 | 资产卡片、播放及右侧详情栏完整显示竖/方图；恢复点卡片查看详情、点媒体放大 | 已部署v0.29.0，待用户手动验收 |
| UP01 | 上传取消与大图读取进度 | 上传进度删除含义待确认；大图按真实字节显示进度，无总长度不造百分比，关闭取消读取 | 大图进度已部署；上传删除含义受阻待确认 |
| RL01 | 发布 | 聚焦提交推送、回退保护、必要构建与健康检查、自动部署；用户手动验收 | 发布检查完成；功能待用户手动验收 |

资料：[本轮四张界面反馈](../docs/materials/index.md)。复用现有上传进度、资产选择/私人参考相册、指针排序模式与模板权限；不新增第三方依赖，不迁移数据库，不付费生成，不删除视频卡历史数据。功能效果交用户手动验收，不用构建或发布健康代替功能验收。

范围补充：用户随后反馈 `/assets` 非横屏视频仍裁切、侧栏缺失，追加 AP01；截图为浏览器内联标注，无可访问本地原件路径，已阅但不声称已归档。模块固定参考图新增逐图备注，跟随图片增删/排序，不沿用旧编号。
2026-10-01 用户确认侧栏指右侧资产详情栏，撤回未上线的额外左导航改动；追加大图真实读取进度。用户尚未确认上传进度条删除是取消上传还是隐藏进度，先不擅改。
2026-10-01 AP01 根因：v0.28.0 提交 `697e2c3` 将右侧抽屉中的媒体预览移到统一 `MediaPreview`，并把抽屉条件改为 `activeItem && !activePreviewSrc`；有预览地址时抽屉被隐藏，卡片点击因此直接进入大预览。

#### 实现与边界

- 固定图和逐图备注复用 `PlatformSetting` 键值存储，不新增表；模块修订号和固定图在同一事务内保存。发送时固定图在前、本次图在后，逐图说明按实际顺序形成；最大合计10张，失效或超限在冻结积分前报错，不静默截断。历史复现使用原任务快照，工作区临时草稿不覆盖模板默认值。
- 共享上下文保密补齐：共享预设列表及由别人预设创建的模块不向普通使用者返回内部上下文或固定图备注；服务端仍可用于生成。`contextEditable=false` 时禁止改写这些字段，省略字段保持原值；管理员和原创建者仍可维护。来源预设缺失默认隐藏，历史任务正文及备注继续按权限脱敏。此改动不能收回过去已下载或已缓存的内容。
- 图库沿用本人资产和私人参考图集，可创建/加入/选回/进入管理；每批40项核对本人有效图片，history限定ID查询最大80项，不扫描全部上传历史；不放宽他人素材权限。嵌套弹窗隔离Escape，打开大图前暂收父dialog，关闭后恢复。
- 预览复用现有图片缩放、鼠标轴心和防误关闭逻辑，参考既有YARL VideoSlide比例适配方案，不安装新包。卡片/详情媒体绝对定位在稳定比例框内，避免内在尺寸撑破grid；旧图片缩略图比例不符时回退现有预览接口。没有浏览器证据，不能断言原截图的裁切只有一个原因；不批量重建旧封面。
- 大图用Fetch流读取真实字节，总长可信才显示百分比；没有总长显示读取量，完成传输后仍区分解码。关闭/切换/重试中止旧请求并释放Blob；跨域或超64MB缓冲限制改浏览器原生读取，不造进度。原图像素与预览像素不混淆，尺寸仅在档位提示中展示。
- 隐藏视频卡管理入口、详情直达及相关跳转，保留生成流程必要归属选择/创建，不删除卡数据。只保留模板工作台导航，旧图片入口保留兼容跳转；按账号恢复最近类别/条目，显式链接优先。清除入口复用现有页面控件。
- GPT-6 Luna XHigh内部执行线程完成导航、后端、图库、预览和资产部分；主控完成模块UI、图号关联、隐私判断及整合。线程归属记录一度混淆，已纠正并冻结收口，没有因此发布重叠版本。功能/浏览器/付费生成均不执行，仅统一发布必需检查；最终交用户手动验收。
- 发布前核对远端仓库为PUBLIC，本轮四张用户原始截图含私密提示词，因此只本地归档并Git忽略，不进入源包；未改变仓库权限或重写历史。历史已公开文件不在本轮回收范围，不能承诺历史副本撤销。

#### 发布回执（2026-10-01）

- 已部署v0.29.0，源码`07ace35bf6bd80ceab7079b3fbc8cb39211b8a02`，BUILD_ID `xTV61MMDXN797AjCO62oH`。入口：[资产](https://sd2.youdooart.com/assets)、[模板工作台](https://sd2.youdooart.com/template-studio)。[38文件统一差异](https://github.com/goukiyang/seedance-api-debugger/compare/b08a00a21fd813cc0c5afdb68b986a596e401368...07ace35bf6bd80ceab7079b3fbc8cb39211b8a02)。资料和回执后续提交不再升级版本或重启。
- `git diff --check`通过；统一TypeScript检查首次发现任务页三处JSX括号错误，修正后汇总4处Set展开及2处正则标记与旧编译目标不兼容，一并改为兼容写法后通过。服务器首候选Lint发现3个保留变量名`module`，未切换，统一改名后同版本重建成功。最终候选`NEXT_DIST_DIR=.next-prod-candidate npm run build`退出0，保留既有img/CSS等非阻断警告。没有降低编译规则，没有新增依赖或数据库迁移。
- 本机请求公网release=0.29.0；服务器源站/公网config及login=200，来源server-42-193；四服务active，运行媒体三个软链接保持。模板chunk `app/template-studio/page-8fce2aac3c8b9580.js`、预览chunk `9382-7d9c7bdeccba988a.js`、资产chunk `app/assets/page-ac646cbf8d1d79be.js`、资产CSS `c1433d02cf72f1df.css`公网200且SHA-256与运行构建一致。重启后第一次健康探测早于端口就绪，随后有界重试通过；未回滚。
- Git：实现提交`2ab9c4b`及兼容修正`07ace35`已推送当前分支。回退标签`rollback/2026-10-01-before-template-ui`已推送，指向旧运行版0.28.0/697e2c3。源包两端SHA-256一致`8a8b7df481f2372cff12ec2f1696c5fc003fa39b41444f7c49dac566c5657ae6`，用户原始反馈图不在归档中。服务器`/srv/video-api-debugger/backups/template-ui-07ace35bf6bd80ceab7079b3fbc8cb39211b8a02`保留旧source/live-build及完整性通过的DB快照；构建使用快照，不写生产数据。回退仅切代码/构建，不整库覆盖。发布窗口开始、失败重建、完成均已登记。
- 版本来源仍为package.json，现有ReleaseNotice提供自动发现、稍后提醒去重和账户页手动重查；本轮摘要更新，无自动强刷。未用浏览器验收旧客户端弹窗或页面交互，所有功能效果待用户手动验收。上传进度条“删除”尚未确认是取消移除上传还是隐藏进度，所以该部分原样保留；大图真实读取进度已上线。
- 手验重点：固定图备注随拖动准确编号、固定+临时总数与历史复现；共享模块普通账号不泄漏上下文；私人图集创建/加入/选回；右侧详情与竖/方媒体、缩放与关闭返回；已点赞收藏红色常显、鼠标和键盘尺寸提示；模板上次类别/位置和旧图片入口。未付费生成、未做业务回归或浏览器验收。
- 守门员：涉及现有共享上下文的保密收紧，静态核对列表/模块/任务/素材返回，不扩大权限。曾误把缺失侧栏理解为左侧及执行线程归属映射混淆，已纠正、记录既有误判日志，错误左导航改动未发布。资料含提示词的公开发布风险已通过本地归档/Git忽略处理。

| 文件组 | 本轮作用 |
|---|---|
| `src/app/image-studio/studio.tsx`、`studio.module.css`、`reference-grid.tsx` | 卡片位置、固定图/备注、图号、排序、紧凑上传菜单与模块编辑保护 |
| `src/lib/image-studio/fixed-references.ts`、`modules.ts`、`presets.ts`、`tasks.ts`、`src/app/api/image-studio/template-assets/[assetId]/route.ts` | 固定图存储、事务修订、共享复制、历史快照、发送顺序与上下文保密 |
| `src/components/UploadedImagePicker.tsx`、`UploadedImagePickerAlbums.tsx`、`UploadedImagePickerAlbums.module.css`、`src/app/api/assets/history/route.ts` | 私人图集、有限ID查询、分页选择、嵌套弹窗返回 |
| `src/components/ZoomableImagePreview.tsx`/`.module.css`、`MediaPreview.tsx`/`.module.css`、`src/lib/hooks/use-image-read-progress.ts` | 安全标题、居中对比、真实读取、尺寸提示、原生读取回退 |
| `src/components/content-reactions/ContentReactions.tsx`、`reactions.module.css`、`ContentCollections.tsx` | 红色浮层、选中常显、收藏媒体不裁切 |
| `src/app/assets/page.tsx`、`assets.module.css` | 恢复右侧详情，比例容器、老图片封面回退，原导航不动 |
| `src/lib/navigation.ts`、`src/components/template-studio/TemplateStudioShell.tsx`、`src/app/image-studio/page.tsx` | 统一入口、账号隔离恢复、旧地址兼容 |
| `src/app/projects/[id]/page.tsx`、`video-cards/[cardId]/page.tsx`、`src/app/tasks/[id]/page.tsx`、`src/app/approvals/page.tsx`、`src/components/generate/GeneratePageClient.tsx`、`src/components/templates/TemplateGenerateClient.tsx`、`src/lib/notifications/display.ts` | 隐藏视频卡管理和直达，保留生成归属和原数据 |
| `package.json`、`package-lock.json`、`src/lib/release.ts`、`.gitignore`、`docs/materials/index.md`、`tasks/todo.md` | 版本/升级摘要、敏感截图本地归档与完整交接 |
