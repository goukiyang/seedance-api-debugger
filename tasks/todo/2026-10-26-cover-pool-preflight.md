# COVER-POOL 全部封面共享池前置工单

日期：2026-10-26；工单 v1.0.0 / R01。项目：video-api-debugger。必要前置已完成；业务实施未开始，未部署，功能待用户手验。

正式根：`/Volumes/Data/Projects/video-api-debugger`。已核读源码：`/Users/gouki-youdoo/.codex/worktrees/cover-hd-autopair/video-api-debugger`，`56ad02196504336d83f0f65cf00dd0c2dd79d476`，应用v0.105.31。正式根有大量既有改动，不可直接当候选源码；实施时只复核此后变化，不从旧分支整文件覆盖。

## 1. 目标与范围

在原网站上改好“全部封面”：更容易找到入口，能排序、认作者、点赞、收藏。保留原导航、深色薄荷绿主题、侧栏分类和响应式网格；真实桌面参考五列，不硬锁所有宽度五列。

| 编号 | 任务内容 | 完成标准 | 当前状态 |
|---|---|---|---|
| COVER-POOL | 全部封面共享池前置工单 | 基于原站与 R03，完成需求拆解、源码及开源方案核对、接口与兼容设计、实施和手验清单，并附正式资料 | 已完成前置；实施未开始 |

用户已明确：全部封面置顶、增加排序、作者头像姓名常显、悬停点赞收藏、底栏仅一行左标题右作者。本轮要求“详细拆解方案。如果要新增的内容，尽量找开源方案。做前置工单”，本轮只做前置，不写业务代码、不部署、不自动派审核或收费测试。

首版推荐把作者搜索/点击筛选、“我的收藏”和现场恢复一同做好，使新增操作有回找入口。这是本单具体建议，不声称已另获实施授权。用途标签系统、关注作者、7日热门、收藏分组改造、评论私信、个性推荐与新快速预览弹窗不纳入首版。

### 1.1 随单附件

正式根 `docs/materials/2026-10-26-cover-pool-preview/`。以下均已查看，复用此前原件/复制一致性证据。附件本地私有保存，不随Git源码外传。

| 附件 | 用途与替代关系 |
|---|---|
| [actual-site-v0.105.31-r02.png](../../docs/materials/2026-10-26-cover-pool-preview/actual-site-v0.105.31-r02.png) | 原网站真实截图，主题/结构依据；非本次功能验收 |
| [exec-591e1e34-39ab-4f88-a295-f47a8d22d1ca.png](../../docs/materials/2026-10-26-cover-pool-preview/exec-591e1e34-39ab-4f88-a295-f47a8d22d1ca.png) | 最新R03单行底栏，主设计参考；作者为演示数据 |
| [exec-dc093f13-0258-4958-a321-2bb60a5cd89d.png](../../docs/materials/2026-10-26-cover-pool-preview/exec-dc093f13-0258-4958-a321-2bb60a5cd89d.png) | R02原站局部调整，底栏被R03替代 |
| [exec-1f51c52c-30b6-458e-807f-e5f4b6360528.png](../../docs/materials/2026-10-26-cover-pool-preview/exec-1f51c52c-30b6-458e-807f-e5f4b6360528.png) | 已否定R01，仅保历史，不作实施依据 |

图中示意身份、数量、文字不定义生产数据。R03与本单明确口径不一致时按用户后续要求及本单执行，不另建网站。

## 2. 已完成的源码调查

以下路径相对上述实际源码根；已读实现，不只是搜索摘要。

| 文件/函数 | 已确认现状与修改目标 |
|---|---|
| `src/app/image-studio/studio.tsx`，naturalNavigation/navigation，约960–1005、1180及1387起 | 本人目录与共享来源合并、原分组条目顺序；桌面入口在侧栏底部、手机在分组后。移动两端入口，保原打开目标与隐藏语义 |
| `src/app/image-studio/ModuleGallery.tsx`、`.module.css` | 原76px多信息底栏，整卡打开层覆盖全卡。改单行；互动/作者/更多为独立上层命中，不嵌套按钮、不误进工作台 |
| `module-gallery-state.ts`、`useModuleGalleryState.ts` | 仅recent/directory和all/mine/shared，名称/分组搜索；按账号/页签保存，近期最多1000条。扩枚举及迁移，保旧选择 |
| `src/components/useResultPages.ts` | 复用现有分页：12–24张，完整行及宽屏三行目标，不造另一套控件 |
| `src/app/image-studio/use-shared-studio.ts`、`src/lib/image-studio/shared-contract.ts` | 共享目录100项分页但客户端累计全目录，每项解析完整定义和固定封面；版本含依赖。增加轻量查询，旧编辑器接口不变 |
| `src/lib/image-studio/modules.ts`、`template-author.ts` | 本人目录和作者解析已有；真实作者依据source/publisher绑定，不是工作区所有者或管理员。提取批量安全投影 |
| `src/lib/content-reactions/service.ts` setReaction/listReactions，`types.ts`、`content.ts` | like会同时写liked/favorited；两种列表action均OR查询。新页面不能直接挂旧接口冒独立点赞/收藏 |
| `src/components/content-reactions/ContentReactions.tsx` | 单按钮状态为liked OR favorited；复用原请求、版本冲突、pending和广播机制，新增独立协议 |
| `prisma/schema.prisma` ImageStudioModule/Preset及ContentReaction/Event | 有created_at/updated_at，无可靠首次发布时间；反应已有两列、时间、版本、原请求唯一约束及计数索引。无需加表或迁移历史 |

特殊对象保持：失效来源的本人工作区仍保原历史入口；未绑定不可用共享项沿旧规则排除；侧栏隐藏不等于全部封面删除；虚拟默认工作区不能因为浏览而写数据库。

## 3. 页面交互方案

### 3.1 入口与卡片

- 桌面全部封面成为侧栏内容区第一入口，位于分类前；手机移到分组选择前。复用原点击/选中/路由，不增全站导航。
- 顶部一组紧凑控件：原搜索、全部/我的/共享/我的收藏、排序；不加统计说明行。
- 封面保持正方形外框和完整contain；缺图沿原占位。底栏36px作为实现起点，仅一行左标题、右16–18px头像与作者名；作者区最多约45%，标题可压缩省略，不换行撑高。长文本完整值可聚焦/悬停查看，手机沿原详情可读。
- 身份确认才显示真实姓名头像；无头像用现有默认头像；无法证明时“作者未知”，不编造。点击已知作者设置筛选，不进入账号资料，不带出邮箱/飞书ID等。
- 不常显共享徽标、分类、最近使用时间；数据和原详情/菜单能力保留。必要失效状态不能因精简被隐藏。
- 点赞心形、收藏书签独立一组，和原更多位于封面角落、避开主体。hover/focus-within显示，选中常显，无悬停设备默认可见；图标小而命中至少32px，保可访问名称和aria-pressed。
- 点赞显示真实数量，不显示他人收藏人数/名单；未知计数不可冒0。更多沿原锚点、边界避让、Esc及焦点返回，不另造弹窗；点封面仍进原工作台。普通状态不加红字，选中心形沿既有红心语义。

### 3.2 排序、搜索与保存

| 显示名 | 真实依据 | 并列/缺值 |
|---|---|---|
| 最新创建 | 来源created_at，独立本地工作区自身created_at | 缺值置后，目录顺序/key兜底；不能叫最新发布 |
| 最近更新 | 来源updated_at，独立本地工作区自身updated_at | 不混访问/点赞/部署时间；不承诺仅内容编辑时间 |
| 最多点赞 | 同一合法key下liked=true数量 | 再创建时间/key；不数favorited |
| 最近使用 | 原本人主动打开与本人受理任务的现有合并口径 | 本地沿1000条上限，无记录按目录顺序 |
| 名称 | 服务端统一中文名称比较 | 稳定key兜底，同名不合并 |
| 原目录顺序 | 现有分组/条目顺序 | 未登记新条目沿原自然规则补尾 |

无已存偏好首次默认最新创建；已有recent/directory原样恢复，不强制改。重置回新默认并保原清本人本地近期记录语义。搜索扩为名称、原分组、已知作者显示名，不搜私有提示词、不新增用途标签系统。

我的收藏严格favorited=true；原“我的喜欢”保旧联合语义。作者点击后顶部仅出现一枚可清除条件，不另常显作者大列表。作者、范围、搜索与排序可组合；我的/共享按真实归属及共享状态，非管理员可编辑能力。改变条件回第一页；从工作台返回恢复筛选、页及可见对象位置。按账号与页签隔离，旧账号迟到响应不得落入新账号。

## 4. 大池查询与安全身份

新增 `src/lib/image-studio/gallery.ts`、`src/app/api/image-studio/gallery/query/route.ts`，只读 `POST /api/image-studio/gallery/query`。POST只承载本人的本机排序提示，不写业务数据，沿既有鉴权/同源/no-store/错误封装。

请求：`{query,scope,authorKey?,sort,page,pageSize,catalogRevision?,recentHints?,directoryOrder?}`。query限160字符；pageSize12–24并按列数整行。recentHints沿1000条有效非未来时间；directoryOrder用既有分组/条目结构，最多256KiB，整体请求最多512KiB；超限明确错误，不默默截断目录。提示只影响本人排序，key必须与服务器授权集合求交，不当权限或公开热度依据。

响应：`{items,total,page,pageSize,catalogRevision,capabilities:{independentReactions:true}}`。item含安全的key/navigationTarget/title/groupName/author/mine/shared/createdAt/updatedAt/cover/reaction/availability/originalActions。author仅显示信息、已核身份过滤key及known状态；reaction为本人两列/version及公开likeCount。不得投影提示词、参考素材、联系方式、费用或无权原件URL；封面沿原受保护URL与版本。

处理顺序：核新鲜账号 → 批量读本人目录和合法共享源 → 原归档/删除/绑定/依赖/可用性 → 完整授权集合 → 筛选 → 排序 → 分页 → 当前页封面与操作投影。total是筛选后完整数量，不能先取24再筛选；只加载当前页媒体，不下载整池原图。

首版采用完整轻量元数据加当前页媒体，不承诺百万条全SQL游标。复用readSharedStudioSnapshot/sharedDependencyState及现有生命周期判断；为源、publisher绑定、删除/归档设置、依赖资产、作者及反应建立单次查询的批量上下文，已有判断器从此上下文读取，避免每卡重复读定义/作者API。不能用is_shared单字段替代原权限和依赖规则，也不能另写宽松分支。此处需新增批量reader接线，但无需新存储层。

共享原件与已确认live/publisher工作区统一用 `image_template:<presetId>` 反应key；打开仍走本人已有工作区/原显式选用流程，浏览不创建工作区。独立本地工作区用 `image_module:<id>`。legacy复制按原对象保留，未知绑定不合并；旧module key票数不迁移、不相加，不承诺合并历史不同对象。虚拟默认项无耐久对象时不能互动，也不能偷偷落库。

失效源的本人历史入口沿原导航记忆保留；失权不能继续展示受保护封面或公开统计；作者证明失败显示未知。收藏不扩阅读/生成权限，取消本人旧标记沿原安全规则保留。未绑定且不可用的共享项在分页前排除，不能用占位把旧不可见项开放出来。

catalogRevision覆盖筛选/排序字段、权限/源/依赖、本人反应版本及排序提示指纹；最多点赞排序包含计数变化。同一查询翻页传该版本；409保筛选锚点，最多一次自动重取同页/最近合法页，仍变化则提示刷新，不无限重试。失权立即清对应对象和缓存；普通网络失败保当前合法页面和重试，不冒空目录。

全部封面模式不再驱动use-shared-studio累计全量重目录。侧栏所需全目录消费相同轻量导航投影，进入具体模板才读完整定义。不能同时保留旧全量重加载抵消本次改进。保最近使用与手动排序，不因搬到服务端丢本机偏好。

## 5. 独立点赞收藏协议与历史兼容

新增 `src/app/api/content-reactions/independent/route.ts`，PUT只接受 `protocol:2` 及本单模板/工作区类型；复用reactionUser、内容解析、原请求表及CAS版本保护。旧路由语义不变，未知协议拒绝，不降级旧like接口。

| 操作 | 只修改 | 必须保留 |
|---|---|---|
| 点赞/取消 | liked、liked_at、version | favorited与favorited_at |
| 收藏/取消 | favorited、favorited_at、version | liked与liked_at |

新指纹加入命名空间 `['independent-v2',key,action,active,expectedVersion]`，v1原指纹不变。请求ID继续账号唯一，同号不同协议/内容拒绝，同号同内容回查原事件，不重复写。写事务重核账号、对象可见性/绑定与版本，并同事务记事件；必要共享reader扩事务client，不能仅依赖事务前权限检查。

新增 `GalleryReactionButtons.tsx`：复用状态/广播但pending区分协议，同一对象两个按钮串行。提交只锁本卡互动，其他卡可浏览。未知结果保原requestId/动作/expectedVersion且按账号持久恢复，通过同独立路由GET（requestId+目标key，仅本人）核原回执；无回执不冒拒绝，可以同号同内容重试，不换号。成功后更新真实两列；409明确冲突读新状态、不自动重放，用户主动再点才新动作。退出页面不冒取消发送，切号隔离及迟到结果保护保留。

历史两列都true继续双选，不猜原意。旧页面/缓存旧客户端仍可能同时改两列；新页按广播/刷新绘真实状态，本单保证新页面独立，不冒全站旧页面已独立。新接口不可用禁新增互动而保浏览，绝不回落旧写接口。原我的喜欢联合列表继续存在，新我的收藏专用严格favorited过滤。

不加表、不回填、不改费用、不触发生成。代码回退保DB与事件，旧UI可能仍显示联合按钮；回执须说明此边界，不用恢复数据库撤销新收藏。

## 6. 开源核读与选型

2026-10-26通过GitHub连接已读以下官方源码与LICENSE；未安装或运行，不把示例当项目验证。此前仅查到的React Virtuoso不作本次已读实现证据。

| 已读实现 | 价值/成本 | 选定用法 |
|---|---|---|
| [Immich AlbumsList.svelte](https://github.com/immich-app/immich/blob/main/web/src/lib/components/album-page/AlbumsList.svelte) 1–140行 | 本人/共享相册合并、搜索与分组排序；Svelte，与React直接接入成本高；[AGPL-3.0](https://github.com/immich-app/immich/blob/main/LICENSE) | 参考组织方式，不复制组件、不引入相册服务 |
| [Radix DropdownMenu](https://github.com/radix-ui/primitives/blob/main/packages/react/dropdown-menu/src/dropdown-menu.tsx) 40–140行 | 受控触发、ARIA、键盘/指针；[MIT](https://github.com/radix-ui/primitives/blob/main/LICENSE)，React可适配；项目已有context-menu但非dropdown-menu | 首版沿原选择器/菜单；确需新菜单能力才增加对应包，避免另造不完整键盘实现 |
| [TanStack Virtual infinite-scroll](https://github.com/TanStack/virtual/blob/main/examples/react/infinite-scroll/src/main.tsx) 1–160行 | overscan、末项加载与可视渲染；[MIT](https://github.com/TanStack/virtual/blob/main/LICENSE)，列表示例仍需网格/高度/恢复适配 | 首版不引入，现有12–24张分页足够 |
| 本项目useResultPages、template-author、ContentReaction/Event | 已对接身份、历史和原请求，适配成本最低 | 直接复用，补安全批量投影及独立协议 |

推荐新增外部依赖数为0。身份/权限/历史协议没有可直接替换的通用库；应沿项目实现，不拿相册或点赞演示替代业务合同。

## 7. 已就绪实施包

| 包 | 修改落点/产物 | 完成标准 | 状态 |
|---|---|---|---|
| CP01 | gallery/query route；shared-contract/template-author/modules批量上下文 | 全集合合法筛选排序、身份归并及当前页投影，保失效历史入口 | 待实施 |
| CP02 | reaction service/types、independent route、GalleryReactionButtons | 独立两列、原号恢复、版本/账号保护，v1不变 | 待实施 |
| CP03 | ModuleGallery/css、studio.tsx/use-shared-studio加载门 | 两端入口置顶，R03单行底栏、作者互动、完整图和原操作 | 待实施 |
| CP04 | module-gallery-state/useModuleGalleryState及原分页接线 | 六排序、作者查询/过滤、严格收藏及状态迁移恢复 | 待实施 |
| CP05 | 统一构建/必要发布检查、Git与回执 | 聚焦提交推送；有有效发布授权再保护部署；交用户手验 | 待实施 |

顺序：CP01/CP02先定共享DTO和协议，CP03/CP04接线，整批统一构建检查与集中修正，最后CP05。无需另建侧栏线程或自动派审查；调查、设计、选型已在本单完成，不转交接手者重做。

Git Plan：未来从当时有效运行源及已确认待合入改动建立 `codex/cover-pool-implementation-*` 聚焦分支，复用合适干净工作区，不能上传正式根旧脏源码。服务端合同和前端接线可分两笔，整体验证后推既有origin。只退代码不退DB/配置/媒体/回执，独立接口能力门防新客户端误写旧路由。本轮文档不升级应用版本或重启。

## 8. 验证与用户手验

本轮为L1文档/只读取证；未来含权限及反应写入，按L3关注。遵循项目用户手验：Codex不主动浏览器、自动功能回归、收费生成或独立审核；保发布必需构建内置检查、版本一致性、服务健康、公网可达与回退点。

候选沿 `npm run build`（含现有prebuild及类型检查）。不执行 `test:api`、`db:push` 或生产批量更新。以下由用户手验，后续另获专项测试授权仅测对应范围；构建健康不能代勾功能通过。

| 编号 | 检查对象 | 通过标准 |
|---|---|---|
| A01 | 原/image-studio桌面/手机 | 全部封面置顶，原分类与工作台仍可达 |
| A02 | R03卡片、长标题/名字/无头像 | 底栏一行，标题左作者右，完整图，无身份不造作者 |
| A03 | 鼠标/键盘/触摸 | 互动/作者不误开工作台，原封面点击正常，更多可达 |
| A04 | 点赞收藏四种组合 | 各只改自身，刷新持久，公开数量只算liked |
| A05 | 历史联合记录/旧页面 | 未批改旧值，新页同步真实状态，旧行为仍可用 |
| A06 | 两页以上/同名/同分/无日期 | 排序覆盖完整授权集合，稳定次序，真实总数 |
| A07 | 作者/范围/收藏/搜索组合 | 交集正确，空列表与网络失败不同，可清除条件 |
| A08 | 返回/刷新/页签/切号 | 状态及位置恢复，旧偏好保留，无串号迟到写入 |
| A09 | 创建者/同事/管理员/撤回 | 作者有真实来源，管理员不冒本人，收藏不扩权限 |
| A10 | 超时/同号重试/版本冲突 | 原号恢复不双写，无回执不冒拒绝、不自动换号 |
| A11 | 原封面编辑/删除/旧喜欢/副本 | 原能力确认保留，旧key不误合并，虚拟项不偷落库 |
| A12 | 大池/目录同时更新/程序回退 | 只当前页媒体，无全量重定义；有限恢复，新接口失效不误写旧路由 |

若后续授权性能核对，用隔离合成目录查看每页最多24项和媒体请求数，作者/计数批量读取；不外传同事数据、不预先承诺毫秒收益。本轮未运行真实互动、并发或大规模验证。

## 9. 前置对账与停止条件

| 必要前置 | 状态/证据 |
|---|---|
| 真实页面/有效设计 | 已完成：v0.105.31截图、R03及用户纠正；R01废止 |
| 源码/数据/上下游调查 | 已完成：§2实读，确认like连写与缺首次发布时间 |
| 开源/复用选型 | 已完成：§6源码/LICENSE，首版现有分页、零新依赖 |
| 身份/权限/异常/历史/回退设计 | 已完成：§3–5及§7，保原请求及本地顺序，不移历史 |
| 交付前体验闭合 | 已完成设计复核：找入口→筛选→认作者→互动→原工作台→返回；错误保现场，功能可达 |
| 修改地图/依赖/验收材料 | 已完成：CP01–05、A01–12及附件；非已实施 |
| schema迁移/新账户或服务 | 不适用：复用现有表和服务 |

未决必要前置阻塞：无。首版增补为明确推荐方案，交付不构成实施确认。用户后续明确按此单实施即可执行，不需再次选库/设计。

停止条件：无法保源身份或权限；需重写历史/迁移反应；无法阻止新协议回落旧写；旧脏源码混入候选；构建/核心健康失败。只停受影响动作并报告证据，不能默删功能或降低权限。上线依届时具体有效授权，本单不授予生产启停/切版。

守门员：原页面局部增强前置，无跨项目操作、无新站、无生产写入；本轮无新增分类误判。效果与规模仍需后续证据；不把已完成设计说成已通过功能验收。

### 发给执行对话的内容

```text
全部封面共享池原站改进
项目：video-api-debugger
正式路径：/Volumes/Data/Projects/video-api-debugger
工单：/Volumes/Data/Projects/video-api-debugger/tasks/todo/2026-10-26-cover-pool-preflight.md（v1.0.0/R01）
实施CP01–CP05：入口置顶，R03单行标题作者底栏，六种排序、作者搜索过滤和我的收藏，独立点赞收藏，完整授权目录分页及现场恢复。保原权限/历史/请求/操作。
先核对§2来源之后的变化，按§7先做服务端合同，再接前端，整批统一构建和发布必需检查。默认用户手验，不自动浏览器/功能回归/收费生成或独立审核；生产发布须有当时有效具体授权。
附件位于正式根docs/materials/2026-10-26-cover-pool-preview/：actual-site-v0.105.31-r02.png是真实原站；exec-591e1e34-39ab-4f88-a295-f47a8d22d1ca.png是最新R03单行底栏，作者为示例。R01不作设计依据。附件仅本地私有使用，不随Git上传。
按§9停止条件保护历史和来源。回执列CP01–CP05、提交/推送/部署事实和入口；A01–A12交用户手验，不以构建成功冒功能通过。
```
