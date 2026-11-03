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
