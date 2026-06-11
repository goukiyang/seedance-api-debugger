-- Add soft visibility state for uploaded asset history.
ALTER TABLE "Asset" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'active';

CREATE INDEX "Asset_owner_id_type_status_created_at_idx" ON "Asset"("owner_id", "type", "status", "created_at");
CREATE INDEX "Asset_status_idx" ON "Asset"("status");
