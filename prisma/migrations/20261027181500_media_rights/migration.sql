ALTER TABLE "SeedanceAsset" ADD COLUMN "owner_id" TEXT;
ALTER TABLE "SeedanceAsset" ADD COLUMN "ownership_status" TEXT NOT NULL DEFAULT 'quarantined';
CREATE INDEX "SeedanceAsset_owner_id_ownership_status_local_status_idx" ON "SeedanceAsset"("owner_id", "ownership_status", "local_status");
ALTER TABLE "ReferenceImage" ADD COLUMN "rights_ceiling" TEXT;
