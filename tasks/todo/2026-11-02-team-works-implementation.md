# Team works catalog

Historical initial rollout (superseded by WORKS-FEISHU01 and WORKS-REC02 below): the preview was restricted to one existing internal account configured privately as `WORKS_PREVIEW_USER_ID`. An unset value closes the preview. The page, all catalog APIs and media, project audience controls and navigation enforce this scope; the client receives only a display capability. The compatible recovery build retains the same gate. Existing project/source permissions and frozen sharing policies are unchanged.

The works page combines completed images, saved videos and explicitly saved multiview collages. Uploads enter the catalog only after their owner explicitly adds them. Input references and intermediate frames are not automatically published.

The catalog stores output references and small display fields. Logical work IDs remain stable when a saved collage receives a complete new revision. A current version is selected atomically; an older operation cannot silently switch to another file. Favorites and collections reference the logical work, and never duplicate or delete the source media.

Project audience settings apply to new source operations. Existing projects without a setting keep their source permissions. New ordinary team projects default to an internal preview audience, project-only and personal scopes remain distinct, and old requests do not gain a new audience when they finish late. A wider setting affects future operations; a narrower setting and current membership are checked when reading existing shares. Only the actual project or source owner can change its sharing controls.

Preview access is separate from original download and reference use. Cards use stored thumbnails, posters and bounded background video previews. Opening a detail may read the exact original when the viewer already has that permission. Preview-only viewers receive a derivative. Media reads do not generate images or run encoders, and private task inputs, recipes and billing fields are absent from the catalog response.

Queries apply current permissions before a bounded keyset page, without an exact total. A signed query window supports forward, backward and anchor reads. The client keeps at most six pages, supports explicit refresh for new works and isolates saved position and pending operation IDs by account.

Collection, personal-state and sharing mutations use version checks and durable request receipts. An uncertain write is resolved by reading its original receipt. Hiding, excluding and withdrawing remain separate actions; background reconciliation cannot restore them. Old content-reaction records are unchanged.

Operational commands use the existing project environment:

```sh
node --import tsx scripts/process-works.ts --once
node --import tsx scripts/process-works.ts pause
node --import tsx scripts/process-works.ts resume
node --import tsx scripts/process-works.ts activate-policy
```

Policy activation is explicit and does not backfill grants. Registration can pause while original generation and media remain available. Preview work uses the existing single media consumer. The new tables belong in the normal consistent database backup: collections, personal state, policies, withdrawal state and receipts are not reconstructed by rescanning source tasks. Program rollback retains these tables and source files.

The offline works engineering fixture is included in the existing prebuild gate. It uses synthetic SQLite data and denies network calls. Functional, visual and performance acceptance remain manual; passing schema, type or build checks does not represent those results.

The additive migration is `prisma/migrations/20261102_team_works_catalog/migration.sql`. It adds one nullable project field, nine Work tables and their indexes, including three source-discovery indexes. The engineering fixture starts from the frozen 0.128.0 schema, preserves existing project and request-receipt rows, and executes this exact SQL before testing the new catalog. Production deployment applies the reviewed SQL through the existing release procedure; it does not use `prisma db push`.

## Contextual detail and learning

The list retains its chronological pages and all existing personal scopes. A selected work opens as a page within `/works?work=...`; related navigation adds browser history entries and returning to the list restores its account-specific anchor and focus. The main image or video keeps its full aspect ratio. A detail page stops list previews; video comparison is an explicit, muted dual-player mode with one optional audio source and source release on exit.

Trusted candidates appear as expandable groups **in the detail page**. An ordinary image submission is grouped only by its actual owner, batch and input fingerprint. Specialized batches and unknown historical submissions remain separate. Source and derived groups use stored input/output identities, and template groups use module, ID and actual source version. Related queries apply current permissions before a bounded candidate window and page; hidden or inaccessible works supply no thumbnail, label or count. Private favorites do not rank team recommendations. The main list has no new AI or popularity score.

The method projection contains only allowed settings and source attribution. A supported current image preset or video studio template can prepare a new personal workspace or draft through a durable operation receipt. This does not edit another draft, publish, generate or charge. Image method workspaces retain an exact revision and dependency-token pin; a changed source is rejected during later read, quote and execution. Unsupported private image workspaces and legacy video templates offer only the reference capability that is actually available. Private prompts, system reference images, provider payloads and billing records are not projected. Delivery labels come only from an actual `VideoDeliverySelection` and retain the original task permission boundary.

Authors may voluntarily save one experience note. Authorized viewers may ask and answer questions, with a video time point only when its real duration is known. Edits use the author's identity, media version, revision and original operation receipt. An author may explicitly link a personal practice work; this is a voluntary declaration, not an inferred execution lineage or adoption score. Both endpoints remain subject to current media and access permissions.

`prisma/migrations/20261103_works_learning/migration.sql` adds four tables: `WorkContext`, `WorkSourceLink`, `WorkLearningEntry` and `WorkDerivedLink`. It does not rewrite source tasks, requests, balances, existing Work tables or sharing policies. Context metadata is filled by bounded background checkpoints. Learning records, links, original receipts and method pins are persistent business data and remain on program rollback. A compatible reader must retain the method-pin rejection in `resolveSharedStudioModule`; the unmodified prior program is insufficient for those new workspaces.

The existing media service and cross-release flock remain in use. Completion processing and preview processing have independent loops but share one heavy-media slot. Only an actual selected completion can yield an in-progress local preview; cleanup and lease handling finish before completion processing acquires the slot. A yielded preview keeps its original job, refunds the local attempt and waits at least one minute before retry. Continuous completion load can postpone a long preview; an authorized original remains available in detail. This does not resend a generation request or change its charge.

Detail and comparison GETs are read-only. A user may explicitly prepare the selected lightweight preview through a version-bound POST; historical catalog scans do not bulk-transcode old videos. Existing queued registrations are consumed before source discovery, with durable turns across image, video and collage sources. A failed discovery window cannot prevent other source windows or ready jobs from progressing. The old record that first triggered a discovery failure has not been identified by source inspection alone.

The existing offline Works engineering gate covers the additive SQL, original receipts, access/version intersections, learning records and media-slot yielding. `scripts/works-method-pin-engineering.ts` provides the same synthetic pin check for a compatible reader. These are engineering checks, not browser, media-quality, performance or functional acceptance. Final functional and visual acceptance remains manual.


## WORKS-FEISHU01: Open the square to internal Feishu users (2026-11-06)

User explicitly requested opening the square to Feishu users. The current online baseline is c2dc71893e0bd6f8f5c7a4b15781182b551d571c / 0.134.5. The old single-account gate controls the home/sidebar, auth/me capability, page, and every Works API. The product gate now accepts internal Feishu identities from the configured tenant, while retaining the existing exact preview account. External accounts and internal-labelled email accounts without a Feishu identity do not gain entry.

Recommendation shadow/diagnostic shares that old gate, so its two call sites now use a separate exact-account predicate. Opening the product must not expand its background scan to every member. Work visibility, source/project intersections, source withdrawal, private content, original download and all mutation/receipt permissions stay on the existing ACL. There is no schema change, migration, data backfill, automatic publication, generation, billing or price write.

Candidate 0.134.6 adds identity/tenant/navigation assertions and verifies that an ordinary Feishu viewer is rejected before any recommendation DB scan. The existing synthetic Works fixture also retains the original source ACL, withdrawal, download and per-account tests. The current 3234d55db60d74f57eaadd03612dbdf7b7d8faae compatible recovery build can read unchanged data contracts; the old single-account entry is an acceptable program rollback. Do not restore old databases or pricing snapshots.

Status: implemented; necessary engineering checks and protected release pending. Functional acceptance remains manual under project rules; no browser or real generation test is scheduled by this request. Entry: https://sd2.youdooart.com/works . The earlier video-reuse manual acceptance and real Image 2.6 channel/pricing prerequisites remain open.


## WORKS-REC02: Background recommendation for internal Feishu users (2026-11-08)

This implementation supersedes the earlier single-account recommendation experiment above. Existing internal Feishu rollout and every source/project/media/recipe ACL remain authoritative. The normal single Works consumer records exact successful input/output use, accepted finishing steps and proven same-slot replacement or explicit version use. Real full-size copy and complete single original/HD transfer are deduplicated per actor and media; a CDN redirect records zero-point intent. Pending evidence from a newly completed source binds only after normal catalog admission and never publishes an asset itself. Missing historical actions are not fabricated.

The three additive tables contain immutable deduplicated evidence, sparse resumable jobs and per-viewer materialized verdicts. Rule 2 keeps +1 (weak cap 3), +6, +8, upgrade-to-12, −6 and −4, with same-use overlap resolved conservatively. Ambiguous template/project/canvas use by one actor cannot invent independent purposes. First qualification requires current score 12; below 8 exits. Only a real same-rule/media qualification history permits the 8–11 buffer. The retained history anchor survives a computed exit so late valid business events can correct it. Ordinary reruns, failed output and accidental opening are zero evidence.

Normal ticks prioritize the live context high-water mark, seek historical contexts in bounded batches and project event-backed works for at most 32 viewers per continuation. Generation and page reads never start scoring. The compact existing scope selector adds “推荐”; response data contains no score or explanation. Current work and contributing evidence permissions, versions, withdrawal and personal hidden states gate stored results immediately. Keyset windows, grouping after filters, return anchors and removal of invalid cached items remain bounded.

The exact additive SQL is `prisma/migrations/20261108_works_recommendation/migration.sql`: three tables and seven explicit indexes. It does not rewrite old requests, prices, ledgers or sharing policies. Production requires the existing natural writer drain, consistent backup and checked additive migration procedure; program recovery preserves new tables and source media.

Engineering evidence: isolated synthetic SQLite run `works-y2tBM6` completed 13 Works groups and 40 existing HD VM checks, with network denied, zero production writes, zero paid calls and zero browser runs. It covers first-low-score rejection, late evidence after exit, positive/negative reselection, real frozen source inputs, copy/complete-stream deduplication, incomplete/HEAD/redirect zero points, pre-admission image/video evidence, private evidence separation, multi-Feishu background preparation and recommended keyset/ACL reads without event replay or request writes. At the observed synthetic scale (2827 catalog works and 29 eligible people), the recommendation read was 144 ms in that isolated run; this is not a real browser performance acceptance. Focused type checks and final candidate build status are recorded in the release follow-up.

CodeGraph preparation and context query for this exact worktree timed out. Relevant source and call sites were checked directly; index synchronization is not claimed. Current status: implementation dd4acdcc9 committed and pushed; isolated engineering and focused types (31 changed TS/TSX files, Next ambient declarations) passed. Release 0.137.0 (application source 9207ebe0ce48a7605011b55d16282394941e24c3, BUILD _Sz4vFnV4E2oNSCz6S9zg) inherits 0.136.0 and existing release-tool corrections and was deployed with healthy service closure at 2026-11-08T19:25:47Z. Final native/pricing and full Next/types/lint passed. User manual acceptance remains pending.


Release closure: `/data/video-api-debugger/release-staging/works-recommendation-20261108/attempt02` contains exact source/build/permission-pair and migration receipts. The initial migration transaction rolled back because the release checker omitted SQLite’s automatically created `sqlite_sequence`; the program recovered to the existing compatible guard without restoring data. The second attempt added only that conditional internal object to the expected set, executed the actual migration core against the protected backup in isolation, and reused all 1514 main and 1491 guard compiled files at their original build times. No application source, SQL, native gate or build was changed or repeated. At 19:22:50Z, three recommendation tables and seven explicit indexes were added; existing schema and row counts remained unchanged. The exact SQL SHA256 is `2fb315831a1fe37f66f8ce0ea573bfa8ecbbc95fd7ff1eabdb4ee78045c9806c`.

Six startup gates, seven services, four timers, local/public health, 33 compiled resources with matching bytes, two protected-resource login redirects and GET3/POST2 anonymous 401 checks completed. Pricing fields retained their full-row fingerprint. Normal background checkpoints progressed without opening a page (evidence 1→4, result rows 1→3 at 19:25:47Z); none was qualified yet. These early rows belong only to viewers allowed by the original permissions, not an assertion that every historical work or member has already been backfilled. Historical actions lacking evidence remain unknown.

The compatible guard remains `bbeb854c82e47650ba3ea703f1918800af96881b` / BUILD `bQTt2tX_GFRrdmNPmYcpf`. Recovery switches program/configuration only and retains the derived tables, media, receipts and billing history. Successors must inherit the successful migration record, never apply the CREATE SQL again or treat schema as unchanged relative to the older guard. The release-check lesson is to account for SQLite-owned internal schema objects in the same protected migration proof, before production. No new out-of-scope issue was added.

## WORKS-REC03: 精选与真实复用推荐（2026-11-08 用户批准推进）

### 现状与批准范围

核对实际运行 v0.138.3 / `2239a1eaaa8e91bf53cb7e6f18a99a4c5a1cb1ed`：默认 scope=all，成功成品收录不走评分；推荐另由 Rule 2 筛选。UTC 11月9日01:34:15 一致快照为目录2,837件、评分47件全部8分/未入选、推荐合格0件，134条信号全是作者自用 input，后台44项待处理。此快照不冒全历史已算，也不能凭结果旧时间认定后台停跑（evaluated_at 只在实质变化时更新）。原目录仍受源/项目/媒体权限约束，不等于全员公开。

用户批准精选兜底、少量新作曝光、真实复用排序。本轮同时覆盖首页和 /works，保历史、原件、权限与已有操作；不接奖励、积分、生成、价格或账本。

### 实施合同

1. 页面默认“推荐”，常显“推荐 / 全部作品 / 我的作品”；收藏、隐藏和管理保留。明确链接和本人后续选择优先，按账号恢复现场。旧 API 无 scope 兼容全部目录，新页面明确发送推荐 scope，后端独立筛选。
2. 管理员在作品详情原管理菜单设为/取消精选；作者提交/撤下本人新作候选。只绑定当前媒体版本与原分享范围，不扩源、项目、模板或原件权限，不代选或批量精选历史作品。
3. 复用 PlatformSetting 的 `works-editorial:v1:<workId>` 存独立版本、mediaVersion、authorId、精选/提名及时间。沿 fresh actor + WorkOperation 同事务回执和 CAS；未知只查原请求。无需 DDL，不改 Work 或财务历史。
4. 社区 Rule 3 要求近30天至少一位其他同事真实成功 input/retained。本人使用、打开、拿取、点赞不单独入选；同一人跨用途只算一个人。同用途有当前已证替换/新版取代时保守撤下该用途认可，重新选用可恢复。无旧8–11分缓冲、不沿用 Rule 2 结果，旧原始证据和纯评分函数保留，缺历史证据不补造。
5. 推荐读只用后台物化结果及当前版本/权限证明，开页不算分、不建任务。排序先分散作者（每轮最多2件），再按精选、有效复用人数、完成时间和ID；同批筛选后只留一个代表。签名游标包含排序边界，旧推荐窗口明确失效，普通目录/收藏窗口不改。
6. 新作独立显示“新作发现”，最多4件，同作者/同批限一个，当前媒体首次提名起7天；重复开关不刷新首次时间。它不是精选或社区达标，不用全部目录补空白。常规推荐24件主结果搭配至多4件新作，约20%仅为初期展示预算，不承诺每屏或无限列表固定比例。新作读取同一后端 ACL 与筛选。
7. 首版不做 AI 审美打分、新推荐平台、自动奖励或重写账本；精选冷启动由管理员实际选择，不以生产测试数据填充。

### 进展和保护

- 隔离分支 `codex/works-curated-feed-20261109` 基于已核现网源，正式根原脏改保留。CodeGraph 本树准备及 WorkActions/processWorkRecommendations/projectWorkCards 结构查询成功，关键链路回源码核对。
- 实现中：推荐与精选/提名后端、默认页签、独立新作区、排序游标和必要构建内置断言。尚未完成构建、Git推送和部署，不以文档或实现存在冒上线。
- 共享影响：query/card projection 为列表、详情和首页共用；新增配置不扩大这些读取者权限，菜单与卡片使用同一当前版本。独立配置、回执同事务，不新增表或共用财务状态。
- 沿项目约定仅做必要工程/发布检查，真实多人和界面效果由用户手验；不自动浏览器、收费生成或对生产作品做精选测试。恢复版须保新配置 reader 和原权限，只回程序、不回数据。

## SIDEBAR-COLLAPSE01: Shared icon rail (2026-11-08)

The shared WorkspaceSidebar now offers an explicit desktop collapse/expand button. Its existing 200 px column becomes a 64 px icon rail while the same page grid releases space to the content. Menu destinations, access filters, current-section highlighting and stored return links remain unchanged. Icon links retain accessible names and hover titles; account/help links stay available and the expanded group is preserved. The existing mobile menu remains in effect at 940 px and below. The safe display preference is initialized and stored separately per confirmed account and synchronized across tabs, without changing data or other workspace preferences. No new dependency, schema, business request, generation or pricing change is introduced.

Baseline: actual 2239a1eaaa8e91bf53cb7e6f18a99a4c5a1cb1ed / 0.138.3; inherited the shared-save, image-kind label and process-wide SQLite writer fixes. Status: implemented, engineering and protected release pending; real browser, mobile and cross-page acceptance remains manual. No out-of-scope discovery added.


## WORKS-AUTO01：自动曝光与一键参考成功归因（2026-11-09 用户授权实施）

范围：按用户本轮明确授权补齐两条链路；保原作品/项目/原图/模板权限，不新增用户操作，打开页面只读后台已准备结果。以实际 ec3758865 / v0.139.6 建独立 `codex/works-auto-discovery-20261109`，候选版本0.140.0；生产同时有已冻结 d943 /139.7 的读性能与HD批，按其发布/健康回执继承后再封最终源，不争用构建/切换窗口，保当前 gpt-chat-catalog-20261109-01 策略。

1. 新成品在现有后台登记/预览完成处自动登记新作曝光；封面ready后才展示，最多4件、同作者/同批去重，沿真实完成时间7天窗口。既有作者主动停止、移出广场、撤回和当前版本/权限均保持；旧作品修复回扫不重置完成时间，不恢复作者已停止的新作。
2. 可信的一键参考操作在同一原WorkOperation事务中，为新建的本人图片工作区/视频草稿绑定来源。原图片正常受理、图片父批实际子任务受理、视频实际创建处，在原接受事务中冻结本次来源；报价/仅打开/整理提示词不算成功采用。只接本次接受的任务/批次，未知、在途或已成功不改绑；普通已明确全部失败可自然重试，父批原组内子项/重试保持。
3. 已成功成品经后台目录/安全上下文收录后，幂等形成method采用事件；Rule4预计算合并原媒体采用和方法采用，同一其他同事只计一人。作者自用不算社区认可；证据和原作仍按各viewer当前ACL、隐藏和媒体版本过滤，预览/推荐不授原件或私有配方权限。旧接受请求无来源证据不猜测回填；保当前30天窗口与原扣回逻辑。
4. 复用现有新作卡、操作回执与样式，补模板/工具超链接、图内一键参考、作者头像靠右；桌面悬停/键盘聚焦显示操作，触屏可直接操作。没有新增确认或发布步骤。

实现源首提交4b036657afc7993832be91d6f531db46025e7f8a已推送；封面ready衔接补丁沿同分支接续。无Prisma schema、依赖、费用或供应商调用变化，仅新增稀疏PlatformSetting来源/接受凭据，现有后台队列完成计算，读取接口不评分。架构判断已依据真实调用链记录并复用；CodeGraph工具当前未暴露，定向核对实际源码，未冒索引更新。

工程：本机Prisma旧生成接口导致首次隔离检查缺模型，已按当前schema重新生成；后续13组Works纯工程检查通过、原7项评分单测通过，0生产写/0真实模型/0收费/0浏览器。两个新增检查和触屏样式在首次通过后补入，最终候选原生构建将按实际新源覆盖；本机全仓类型扫描未完成，已停止，不冒类型通过。真实多人、手机和浏览器功能仍待用户手验。当前未构建最终Linux候选、未发布0.140.0，不把已推源冒线上生效。本轮新发现均在本任务范围，未扩改其它模块。


### WORKS-AUTO01 增长收口与最终候选边界（2026-11-09）

自动曝光不再写入人工精选前缀：改用 `works-discovery-auto:v1:<ISO完成时间>:<workId>`，沿既有唯一key索引只取7天窗口，人工选择仍以原 `works-editorial:v1:<workId>` 当前媒体/作者记录优先；展示版本只用人工CAS版本，自动曝光本身不制造用户编辑冲突。正式推荐查询不扫描自动候选，卡片仅为已返回作品点取自动/人工各一键。无新表、索引、清理服务或源权限迁移。

本机最新13组工程已通过，原证 `.role-tests/works-BDb1Eo/receipt.json`；含5000条过期自动曝光记录的真实SQLite EXPLAIN，两个命名空间均走key范围索引、无PlatformSetting全扫；成功图片/视频方法采用、同人去重、原件/证据权限、失败/未知/后续无关请求和停止展示保持。发现新作卡忙态接口实际为string数组，已修正并完成20个改动入口及其依赖的严格类型检查（含标准next-env）；触屏按钮选择器优先级也已补齐，CSS解析通过。CSS与忙态补缺发生在后端原证之后，原时间和结果保留，最终Linux候选补齐真实构建输入绑定，不重复无变检查冒新证。

同项目LANG01仅接79b26精确两UI文件，不接其旧基线或版本；两SHA已与16:18:54Z服务器types/lint原证逐字节核同，最终公共产物证明涵盖角色融合页。140功能范围已经锁定，只继承前一批实际健康源后封最终source，不插入未发布的独立输入合同。15的1397仍未正式交窗，候选已有后继，不能把历史d943或未绿6a当实际线上；9已同意取消独立1398，其两UI随140同批，2已同意输入合同排在140健康后继并保留两个真实任务接受处的freezeImageWorkMethodUse接点。

当前代码均已聚焦推送、未发布；后续保当前GPT目录策略和实际相容guard，复制当次健康前序的固定控制/恢复入口，不并行Next或切换，不改运行中发布工具，不回生产数据。实际页面与多人效果仍由用户手动验收。


### WORKS-AUTO01 发布收口：v0.140.0（2026-11-09）

**已修改、聚焦提交推送并保护部署；待用户手动验收。** 最终发布源 `3c660ec24c75e6a51c338a115fd5fbf0a2c4733b`，BUILD `nOkZjjM7FnbrDLJisYnEe`；完整继承实际健康前置 E91/0.139.7，不继承早期失败候选。原单上方的等待发布状态由本节接续，历史记录不改写。入口 `/works` 与创作首页既有广场区保持。

- 自动曝光：新作品沿既有登记/预览就绪事务和有界后台修复进入新作区；实际完成时间7天窗口、封面ready、限量与作者/批次去重保持。自动记录按日期key范围读取，人工停止优先且回扫不恢复，正式推荐不扫描自动历史。无新表/索引/清理服务、无额外用户动作。
- 方法归因：可信“一键参考”只绑定本人新草稿；图片普通/父批真实受理事务及视频任务真实创建事务冻结来源，只有目录接纳的成功图片/视频才产生幂等method证据。报价、仅点击、失败、未知和后续无关请求不冒成功；原件/模板/证据及同事身份权限继续鲜核，自己使用不当其他同事认可。既有加减分保持，后台Rule4更新结果，页面GET不准备或计算评分；无法证实的旧点击不补造归因。
- 工程收口：最终Linux源完整Next构建（包含全类型与lint）于18:36:38Z通过，build-exit=0。首次Linux门的17组native和15组linked已通过，唯一失败为旧恢复VM漏接 `freezeImageWorkMethodUse`；已导入真实实现并补源指纹，保留原断言，未用noop。attempt02核原验证器、源字节、原时间和原回执，只重跑该1项并通过，覆盖17组native/16组linked全部；新源30组计价门通过。此前7项纯评分、13组作品工程及5000过期曝光EXPLAIN原证复用，无变检查未冒新时间。
- 发布收口：18:38:05Z公网49项构建资源、4个匿名401、6项实际启动检查通过；18:38:36Z七服务同源、四timer在跑、发布控制器0。价格两键所有字段SHA `d03c539d74a31b5e2a6a0305724b1b9f193e0ade878370898c7632d1bdc96539` 前后相同；既有飞书/数据链接、rollout源码与私有策略不变，GPT模型目录保留。原writer自然退出后做一致数据库备份，仅只读核继承迁移，无DDL、无业务数据恢复或覆盖；兼容恢复版仍674/qb5原字节，恢复入口只切程序。后继2的新输入合同须另制兼容恢复版，本次未合入或提前启用该合同。
- 后台观测：18:38:37Z只读已有状态，自动曝光记录5条；reference origin/use均0。没有模拟同事点击或实际生成，后续真实参考并成功产出后才积累归因；该观测不代替用户功能验收。同包LANG01两UI保持79b原字节，沿其原16:18:54Z专项证据及本次完整构建；未扩大角色融合范围。

发布汇总原证：[WORKS-AUTO01-release-summary.json](../../docs/materials/2026-11-02-team-works-research/auto-discovery-20261109/WORKS-AUTO01-release-summary.json)。服务器完整阶段 `/data/video-api-debugger/release-staging/works-auto-discovery-20261109/attempt02`，首次失败原证留attempt01；真实浏览器/触屏体验、同事成功参考实际链路仍用户手验，不以构建/健康冒验收。本会话结构查询工具不可用，定向核源码/调用点，未声称源码索引已更新。本轮未新增范围外线索；本次授权的自动曝光与成功归因已完成实施；接续为用户手验及真实业务自然积累，不代表其他原工单均已关闭。
