CREATE TABLE "UsageAttribution" (
  "source_kind" TEXT NOT NULL,
  "source_id" TEXT NOT NULL,
  "actor_user_id" TEXT,
  "owner_user_id" TEXT,
  "billing_subject_type" TEXT,
  "billing_subject_id" TEXT,
  "project_id" TEXT,
  "occurred_at" DATETIME NOT NULL,
  "context_version" INTEGER NOT NULL DEFAULT 1,
  "parent_source_kind" TEXT,
  "parent_source_id" TEXT,
  "context_origin" TEXT NOT NULL,
  PRIMARY KEY ("source_kind", "source_id")
);
CREATE INDEX "UsageAttribution_owner_user_id_occurred_at_idx" ON "UsageAttribution"("owner_user_id", "occurred_at");
CREATE INDEX "UsageAttribution_project_id_occurred_at_idx" ON "UsageAttribution"("project_id", "occurred_at");
CREATE INDEX "UsageAttribution_occurred_at_idx" ON "UsageAttribution"("occurred_at");
