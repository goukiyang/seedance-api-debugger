-- Additive only. Previous readers ignore this table; existing data is untouched.
CREATE TABLE "CharacterAsset" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "owner_id" TEXT NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'volcengine_ark',
  "asset_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "group_id" TEXT,
  "project_name" TEXT,
  "notes" TEXT,
  "thumbnail_reference_image_id" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision" > 0),
  "deleted_at" DATETIME,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL,
  CONSTRAINT "CharacterAsset_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CharacterAsset_owner_id_provider_asset_id_key" ON "CharacterAsset"("owner_id", "provider", "asset_id");
CREATE INDEX "CharacterAsset_owner_id_deleted_at_updated_at_idx" ON "CharacterAsset"("owner_id", "deleted_at", "updated_at");
