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
