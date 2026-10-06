# 收藏与点赞合并

工单版本：1.1.0；日期：2026-10-06（Asia/Shanghai）；项目：SD2视频创作平台（video-api-debugger）；最后更新：2026-10-06 22:23（Asia/Shanghai）；已部署v0.49.0，待用户手动验收。

用户原话：“帮我把收藏跟点赞都合并为一个功能，且用链接的ui和动效”。指定参考为 https://bencho.dev/blocks/like?c=like&theme=dark 。本轮明确实施与常规聚焦Git、回退保护发布，不恢复已中止抠图/上下文粘贴任务，不实施尚在讨论的大图对比，也不猜测此前分享/置顶按钮位置。

| 编号 | 任务 | 完成标准 | 状态 |
|---|---|---|---|
| LIKE1 | 合并收藏与点赞 | 一个按钮承接两者，旧记录仍可找到 | 已完成实现与部署；真实旧记录、取消/撤销及跨页效果待用户手验 |
| LIKE2 | 采用参考交互 | 按钮样式、点击反馈和动效对应链接 | 已完成源码接入与发布；视觉/触屏/减少动态效果待用户手验 |
| LIKE3 | 发布交付 | 构建通过、可回退上线、版本可核对 | 已完成：构建、来源/BUILD、公网JS/CSS字节及回退点均有证据 |

## 已定目标与边界

- 唯一动作采用心形“喜欢”，统一找回入口为“我的喜欢”；本人的历史点赞或收藏都保留并合并显示，同一内容去重，不直接删除一类记录，也不要求先批量迁移。
- 公开计数不得将历史私人收藏转为公开。历史E1/E2记录明确收藏不公开人数/用户；本人的激活状态和本人列表可读两类并集，公共计数保持原公开点赞口径，不发布收藏者名单、私人收藏统计或补写旧收藏为公开赞。统一新动作只由用户主动触发，服务端沿用既有账号/内容访问校验，不扩大公开范围。
- 合并不是只删一个按钮：共享反应控件、模板标题、卡片激活角标、收藏/点赞找回页、素材库相关筛选和文案需按实际引用闭环；旧URL/接口和读取字段尽量兼容。原公开分享独立保留，不改为置顶或静默公开素材。
- 持续激活标记不因鼠标离开消失；普通页面切换、历史恢复和初次加载不重播粒子。保存中与已成功分开，失败保留有效状态并允许重试；真实数字以服务端回执为准，不照抄演示的固定起始数或每次机械加减1。
- 不安装/升级依赖，不改数据库结构、权限、登录、付费、Provider或生成链路；不读取密钥、cookie、生产数据库，未获授权的费用、扩权及生产覆盖停止对应操作。保留原用户设置、筛选与现场恢复，账号与内容权限隔离。

## 参考与接入方法

已从该页HTML定位并读取当前公开应用及组件snippet模块：应用 `https://bencho.dev/assets/index-BfIRTxkq.js`，样式 `https://bencho.dev/assets/index-C2Q6UHIR.css`，snippet `https://bencho.dev/assets/blocks-DFA3nK03.js`。通过项目已有TypeScript解析器只读取like对象的tsx/css字符串，不执行下载的JavaScript。

默认参考：44px按钮、19px心形/2.3描边、圆角22px、暗色中性底，激活红色 `#e5484d`；按下缩至0.95。Bloom依次为红色圆盘展开到紫色细环、7组双粒子散开、心形回到正常大小；心形760ms、圆环560ms、粒子620ms加200ms延迟。计数以每位为单位上下滚动420ms，变动的数字才转，右侧位起每位40ms错开，千分位不滚。取消不播放绽放。演示外框240×130不带入产品，卡片/标题紧凑位置采用同一共享控件的紧凑适配，不新增展示面板。

公开snippet依赖framer-motion和lucide-react；本站已用lucide，建议复用原Heart图标与CSS关键帧，并以原生React/CSS适配数字滚动，不为一个按钮装新动画包。采用用户指定的弹性落点，非泛化动效；保留键盘、触控、focus-visible和减少动态偏好，减少动态时粒子及数字滚动均关闭。参考站全局提示音不随此按钮引入。

官方许可页 https://bencho.dev/licence 及当前应用中的许可组件明确MIT，Copyright (c) 2026 Lorenzo Cabra；标准许可条款已提取归档。实质复制部分随交付代码保留版权与许可。网站商标、授权照片与字体不在可转授代码范围，本轮不取它们。

证据界限：curl取得HTML及实际公开组件源码；web工具打开like页不可读；IAB新建页30秒超时并重置，创建结果未知，不重复新建或接管用户页签；独立BrowserSkill当前无已连接浏览器。未取得浏览器画面/点击过程，不称参考已视觉验收。产品按项目规则默认用户手动验收，不自动执行SD2功能、浏览器/DOM/截图、收费生成或业务API验收；构建、版本、服务与公网静态产物核对属于发布检查，不替代功能验收。

## 正式资料与相关旧记录

资料目录：`/Volumes/Data/Projects/video-api-debugger/docs/materials/2026-10-06-unified-likes/reference/`。

| 文件 | 用途与校验 |
|---|---|
| bencho-like-page.html | 原参考页HTML；11276字节，可读、与本次读取内容一致 |
| Like.reference.tsx | 从公开snippet结构化提取的原Like组件；6626字节，保留原文，可读 |
| Like.reference.css | 原Like样式/关键帧；4892字节，保留原文，可读 |
| LICENSE.bencho.txt | 官方当前应用显示的完整MIT文本；1078字节，可读 |
| reference-manifest.json | 来源URL、日期、默认参数、依赖、证据缺口及上述关键源的SHA-256 |

相关已有原图：[模板标题旧点赞/收藏布局反馈](../../docs/materials/2026-10-05-template-title-favorites/codex-clipboard-d2a7827a-f62f-46fa-b4f2-8f16c99e452b.png)，原件私有，仅作历史要求与布局背景；沿用已登记PNG可读/310×113证据，不冒称新效果图，不公开Git或部署。旧收藏同行与激活角标要求见[历史FAV1及E1/E2原文](2026-10-02-feedback-primary-navigation.md#fav1模板标题与收藏闭环2026-10-05)，只替代其中两类动作分开的产品规则，隐私、同行位置与激活常显继续有效。

开工运行来源已核：2026-10-06 21:58:28（Asia/Shanghai）服务器v0.48.0，提交 `ecbbc3258f4e89958f5bf55b2eae975904503b1d`，BUILD `F2D7ZkKByROZ0JjfpqvaX`，web active。参考资料非实际发布产物；发布前由执行负责人重新核对来源、候选与回退，不部署正式根的旧混合分支。

## 后续手动验收要点

只赞、只收藏、两者同时存在及未操作的旧记录均能正确显示与找回；统一点击与取消同步各入口且失败不假成功；公开人数不泄露历史私人收藏、同一公开点赞不重复计数；初次加载不绽放，主动激活按参考动效，取消数字方向正确，减少动态不滚动；手机/键盘可操作，卡片角标常显、标题同行；原收藏/点赞URL、素材筛选和刷新恢复可达；旧客户端可发现新版本、稍后不反复打断、刷新保留草稿。真实效果交用户验收，不以实现或发布检查判通过。

## 本轮实现与发布计划

- 实现区：`/Users/gouki-youdoo/.codex/worktrees/cutout-validation-paste-20261006/video-api-debugger`，该managed工作区实际已创建、干净，复用为新分支`codex/unified-likes-20261006`；不恢复原中止任务。基于`c14b48d`，比已发布`ecbbc32`只多4份工程记录；正式根旧src不改、不部署。
- 最小工作包：共享反应服务 → 共享喜欢控件及列表/选择器/模板/画布适配 → 一次版本与统一构建/静态Review → 聚焦push、rollback tag、候选发布与正式记录。没有可用内部派工工具或可核对的整树空位，由唯一实现负责人执行；不创建侧栏任务、不派审核线程。
- 数据兼容：既有`ContentReaction`按用户/内容唯一；读`liked OR favorited`，每条只计一次，本人分类数也来自同一并集。记录按两类时间较晚者排序，不相加计数、不bulk迁移、不删除原表或事件流水。原始两字段保留，以便精确识别旧仅收藏。
- 隐私兼容：`likeCount`继续只查询`liked=true`；原反应接口需登录且内容仍可访问才返回人数，媒体权限校验原样复用。旧`favorite`写入仍只写私密收藏，防止旧客户端意外公开；新版`like`主动开关在一次事务中写两字段，并保留版本冲突和重复请求保护。取消旧仅收藏不机械减人数；撤销恢复旧仅收藏时走私密旧动作，不补公开点赞。
- UI接入：44px/22px圆角、19px/2.3心形、中性暗底、红色`#e5484d`；共享原Bloom关键帧和7组双粒子，成功回执后只在主动控件播放，取消无burst。计数采用真实回执、只变动位滚动、减少动态同时禁用心形/粒子/数字；被动刷新不滚动。初始化未知人数显示占位，不伪造0；模板标题与画布紧凑入口不显示人数。公开分享保留原功能。撤销使用点击前真实两字段，写入忙碌或未确认时不假报撤销成功。
- 兼容入口：原`view=favorites`和`view=likes`都到唯一“我的喜欢”；保留已有账号隔离筛选、预览与滚动命名空间，另一类筛选作为缺省读取回退，不覆盖历史偏好；素材选择器/画布风格库查询也读并集。复用既有ReleaseNotice及版本源，只更新本次摘要；已发布v0.49.0，package-lock只同步两处版本元信息，无依赖变更。
- 统一发布检查：候选`NEXT_DIST_DIR=.next-prod-candidate npm run build`（内置编译/lint/types）、`git diff --check`、静态源码Review及编译产物核验；服务来源/BUILD锁、公网release/config/login、真实JS/CSS字节校验。画布静态路径需登录，不借凭据或绕权限取证；服务器文件哈希及公共Next静态产物证明发布，实际画布效果待手验。
- 守门员等价核对：目标为已授权工程实现及正式服务器发布；UI主流程影响，项目手动验收约束优先，不自动业务验收。关键风险是私密收藏不得转公开、旧src覆盖生产、密钥/上传/DB保护与可回退切换。停止条件为来源漂移、构建/产物失败、发布窗口冲突、磁盘保护不足、费用/权限/数据越界。主管本轮公开计数归类误判：有，已登记全局误判记录并修正，无生产副作用。

## 实际文件与改动

应用共23份文件，仅限本任务；统一diff为[源码diff](../../docs/materials/2026-10-06-unified-likes/source.diff)，从`c14b48d`到发布提交`9adbaa2`，不含正式根脏改。

| 文件 | 核心改动 |
|---|---|
| `src/lib/content-reactions/service.ts` | 本人并集列表、较晚时间排序、事务开关两字段；旧favorite仍私密；公开count不变 |
| `src/lib/content-reactions/types.ts` | 明确原始双字段和公开count隐私边界 |
| `src/lib/content-reactions/http.ts` | 故障文案统一为喜欢 |
| `src/components/content-reactions/ContentReactions.tsx` | 唯一喜欢动作、真实成功反馈、主动动画门槛、点击前状态回传 |
| `src/components/content-reactions/LikeButton.tsx` | Bencho造型、Bloom、真实按位滚动、公开人数提示与占位 |
| `src/components/content-reactions/reactions.module.css` | 旧双按钮样式退出，保留激活角标/错误/忙碌及减少动态 |
| `src/components/content-reactions/ContentCollections.tsx` | 我的喜欢、旧筛选兼容、仅收藏的私密撤销和真实确认 |
| `src/components/content-reactions/TemplateFavoriteTitle.tsx` | 标题同行控件沿用，传递点击前原始状态用于撤销 |
| `src/app/assets/page.tsx` | 单一列表入口，旧赞过/收藏链接与保存视图兼容 |
| `src/app/api/assets/picker/route.ts` | 本人素材喜欢筛选查询并集，不改访问权限 |
| `src/components/ResourceLibraryPicker.tsx` | 我的喜欢入口与开关后的列表刷新 |
| `src/app/image-studio/studio.tsx` | 手机/桌面模板入口统一心形与我的喜欢文案 |
| `src/components/template-studio/TemplateStudioShell.tsx` | 模板工作台喜欢找回入口 |
| `src/app/api/tools/ultimate-canvas/styles/route.ts` | 当前用户风格喜欢并集状态 |
| `public/tools/ultimate-canvas/canvas-styles.js` | 新动作写like，原始状态按OR读取 |
| `public/tools/ultimate-canvas/style-gallery.js` | 我的喜欢、成功后Bloom、取消不绽放且不先假激活 |
| `public/tools/ultimate-canvas/style-gallery.css` | 退出原30px单图标样式，接同源共享造型 |
| `public/tools/ultimate-canvas/index.html` | 加载共享喜欢样式，升级相关静态资源缓存标记 |
| `public/tools/ultimate-canvas/like-button.css` | React/画布共同使用原参考关键帧与造型；减少动态禁用粒子/数字 |
| `public/tools/ultimate-canvas/like-button.LICENSE.txt` | 随复制代码提供完整MIT许可及原版权 |
| `src/lib/release.ts` | 更新提醒摘要说明本次合并和旧收藏仍私密 |
| `package.json` | 唯一版本升0.49.0，不改依赖/脚本 |
| `package-lock.json` | 仅两处版本元信息同步，不改依赖锁定 |

正式记录为本工单、根AGENTS运行来源、固定todo、资料索引与本目录的参考/发布证据；源包与回退包及完整构建日志只留本地归档，不公开Git/部署。旧PNG只引用原件，未复制进新源包。

## 统一Verify与Review结果

2026-10-06 22:22（Asia/Shanghai）发布完成。`v0.49.0`，应用提交`9adbaa2d77798c05d9e8a463337e7feccbe1e66a`，BUILD `qm5JfAJ6THxzn3X5MOiUZ`；[我的喜欢](https://sd2.youdooart.com/assets?view=favorites)。上线状态：已部署，待用户手动验收。

实际检查：

- `git diff --check`及`git diff --cached --check`通过；两份画布JS的`node --check`和部署脚本`bash -n`通过。结构化比较package/lock移除版本元信息后与原版完全一致，证明无依赖/脚本变更。
- 纯记录收尾的差异检查排除`source.diff`原始补丁文件：其空白上下文行必须保留单个空格，Git将补丁本身作为新增文件检查时会报尾随空格；不是应用源码空白错误，不篡改原始补丁。其余记录差异检查通过。
- 服务器`NEXT_DIST_DIR=.next-prod-candidate npm run build`成功，内置编译、lint、类型检查与86个静态页面生成完成。日志有既有全局样式、img与Hook提示，没有编译/类型阻塞；未扩范围整改。
- 源包/回退包SHA核验通过；上线前851、上线后854份关键源码/配置/本轮静态文件与对应提交匹配。候选与运行产物均含喜欢文案、公开count提示、Bloom CSS和减少动态分支；两者BUILD一致。
- `git push -u origin codex/unified-likes-20261006`和rollback tag推送成功，`git ls-remote --heads/--tags`确认应用提交及回退标签远端可见。
- 服务器`.deployed-commit`、`.next-prod/BUILD_ID`、`systemctl is-active sd2-gray.service sd2-image-studio.service`正确；本机端口3302的`/api/config`为HTTP200有效JSON，未保存内容。worker PID保持不变，三条持久目录symlink原样保留。
- worker未重启证据：`deploy.sh`第43行保存切换前MainPID，第93行要求切换后严格相等，第95行仅在该核对成功后输出`SWITCH_OK ... worker_retained=true`；实际切换成功，`delivery.json`记录`workerRetained=true`。未额外重启worker或扩测。
- 公网`/api/release`版本正确，`/api/config`和`/login`均200，来源`X-SD2-Origin: server-42-193`正确。两份关键JS与一份Bloom CSS均200且SHA与候选/运行字节相同。画布静态路径307到登录，原访问保护未变；未取登录后画布字节或交互。
- 单次整批静态Review对照源diff、原参考、兼容/隐私要求和构建证据；发现的撤销前状态、被动数字重播及忙碌误报均同批修正后再统一构建。未派独立审核、未做功能/DOM/截图、收费生成或业务API验收；这些不标通过。
- 本次版本提醒沿用现有ReleaseNotice；摘要原文：“点赞和收藏合并为一个‘喜欢’按钮，原有记录统一到‘我的喜欢’；旧收藏保留且仍私密，不加入公开喜欢人数。点击喜欢采用新的心形绽放反馈。”旧客户端提醒/稍后/刷新保留草稿的真实效果仍待用户手验。
- 所用本轮SSH、构建、切换、归档及Git命令会话均已结束，无遗留构建/部署任务；没有开启浏览器会话或派生工作线程。线上web与worker作为正式服务继续运行，不列为待结束会话。

证据：[候选清单](../../docs/materials/2026-10-06-unified-likes/candidate.json)、[运行清单](../../docs/materials/2026-10-06-unified-likes/runtime.json)、[公网检查](../../docs/materials/2026-10-06-unified-likes/public.json)、[服务/回退清单](../../docs/materials/2026-10-06-unified-likes/delivery.json)、[本地完整构建日志](../../docs/materials/2026-10-06-unified-likes/build-server.log)、[源码diff](../../docs/materials/2026-10-06-unified-likes/source.diff)。部署窗口start/renew/finish均实际执行并登记版本账本；服务器文件锁与来源/BUILD比对在构建和切换前均执行。

回退保护：远端`rollback/2026-10-06-before-unified-likes-v0.49.0`指向`ecbbc3258f4e89958f5bf55b2eae975904503b1d`；旧BUILD `F2D7ZkKByROZ0JjfpqvaX`保存在`/srv/video-api-debugger/app/.next-prod-prev-likes-9adbaa2d7779`，旧源码保存在`/srv/video-api-debugger/releases/ecbbc3258f4e89958f5bf55b2eae975904503b1d-likes-rollback-source`。失败切换脚本恢复旧源码、旧静态入口与旧构建，不恢复整库、不删除新旧反应记录；此次无需触发回退，未模拟回退。

没有已知构建或发布阻塞；余项仅为上述手验和超大个人列表的既有限制。部署门禁仍是文件锁/来源比对，不声称已建立普通账号不可绕过的物理门禁。未越界；没有迁移、生产DB读写、付费或权限扩大。守门员finish等价核对：目标/来源/产物/Git/回退与证据一致，真实结果缺口为已明确安排的用户手验；本轮主管归类误判有（已纠正、已登记、无生产副作用）。
