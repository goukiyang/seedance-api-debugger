CREATE TABLE "ImageStudioPreset" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "owner_id" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "group_name" TEXT NOT NULL DEFAULT '未分组',
  "prompt" TEXT NOT NULL DEFAULT '',
  "context" TEXT NOT NULL DEFAULT '',
  "model" TEXT NOT NULL,
  "quality" TEXT NOT NULL DEFAULT 'auto',
  "count" INTEGER NOT NULL DEFAULT 1,
  "aspect_ratio" TEXT NOT NULL DEFAULT 'auto',
  "banner_asset_id" TEXT,
  "reference_ids" TEXT NOT NULL DEFAULT '[]',
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "ImageStudioPreset_scope_created_at_idx" ON "ImageStudioPreset"("scope", "created_at");
CREATE INDEX "ImageStudioPreset_owner_id_scope_created_at_idx" ON "ImageStudioPreset"("owner_id", "scope", "created_at");
