# V1.2 剩余模块落地 Todo

## 当前入口

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
| B11 | 视频模板上下文入口 | 可设置、保存并用于视频提示词，自动部署 | 已完成代码排查，尚未实现或部署 |

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
