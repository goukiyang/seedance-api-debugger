-- Migration: add_asset_dedupe_fields
-- Add fields for asset deduplication (file_hash, storage_provider, storage_key)
-- Add indexes for fast lookups

BEGIN;

ALTER TABLE "SeedanceAsset" ADD COLUMN "file_hash" TEXT;
ALTER TABLE "SeedanceAsset" ADD COLUMN "storage_provider" TEXT;
ALTER TABLE "SeedanceAsset" ADD COLUMN "storage_key" TEXT;

CREATE INDEX IF NOT EXISTS "SeedanceAsset_file_hash_idx" ON "SeedanceAsset"("file_hash");
CREATE INDEX IF NOT EXISTS "SeedanceAsset_original_url_idx" ON "SeedanceAsset"("original_url");
CREATE INDEX IF NOT EXISTS "SeedanceAsset_storage_provider_key_idx" ON "SeedanceAsset"("storage_provider", "storage_key");

COMMIT;
