CREATE TABLE "ImageStudioTask" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "batch_id" TEXT NOT NULL,
  "owner_id" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "prompt" TEXT NOT NULL,
  "context" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "model" TEXT NOT NULL,
  "reference_ids" TEXT NOT NULL,
  "unit_credits" REAL NOT NULL,
  "freeze_snapshot" TEXT,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "lease_token" TEXT,
  "lease_until" DATETIME,
  "asset_id" TEXT,
  "error" TEXT,
  "usage_json" TEXT,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL,
  "finished_at" DATETIME
);
CREATE INDEX "ImageStudioTask_owner_id_created_at_idx" ON "ImageStudioTask"("owner_id", "created_at");
CREATE INDEX "ImageStudioTask_status_created_at_idx" ON "ImageStudioTask"("status", "created_at");
CREATE INDEX "ImageStudioTask_batch_id_owner_id_idx" ON "ImageStudioTask"("batch_id", "owner_id");
