# Team works catalog

The initial preview is restricted to one existing internal account configured privately as `WORKS_PREVIEW_USER_ID`. An unset value closes the preview. The page, all catalog APIs and media, project audience controls and navigation enforce this scope; the client receives only a display capability. The compatible recovery build retains the same gate. Existing project/source permissions and frozen sharing policies are unchanged.

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
