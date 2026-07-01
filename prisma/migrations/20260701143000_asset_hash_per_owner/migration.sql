DROP INDEX IF EXISTS "Asset_hash_key";

CREATE INDEX IF NOT EXISTS "Asset_hash_idx" ON "Asset"("hash");

CREATE UNIQUE INDEX IF NOT EXISTS "Asset_owner_id_hash_key" ON "Asset"("owner_id", "hash");
