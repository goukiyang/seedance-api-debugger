CREATE TABLE "WorkRecommendationEvent" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "event_key" TEXT NOT NULL,
  "work_id" TEXT NOT NULL,
  "media_version_id" TEXT NOT NULL,
  "actor_id" TEXT NOT NULL,
  "purpose_key" TEXT NOT NULL,
  "chain_key" TEXT NOT NULL,
  "fact_key" TEXT NOT NULL,
  "signal" TEXT,
  "slot_key" TEXT,
  "evidence_work_id" TEXT,
  "evidence_media_version_id" TEXT,
  "occurred_at" DATETIME NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "WorkRecommendationEvent_event_key_key" ON "WorkRecommendationEvent"("event_key");
CREATE INDEX "WorkRecommendationEvent_work_id_media_version_id_occurred_at_id_idx" ON "WorkRecommendationEvent"("work_id", "media_version_id", "occurred_at", "id");
CREATE INDEX "WorkRecommendationEvent_actor_id_purpose_key_slot_key_occurred_at_id_idx" ON "WorkRecommendationEvent"("actor_id", "purpose_key", "slot_key", "occurred_at", "id");
CREATE INDEX "WorkRecommendationEvent_evidence_work_id_idx" ON "WorkRecommendationEvent"("evidence_work_id");
CREATE TABLE "WorkRecommendationJob" (
  "work_id" TEXT NOT NULL PRIMARY KEY,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "viewer_cursor" TEXT NOT NULL DEFAULT '',
  "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "WorkRecommendationJob_updated_at_work_id_idx" ON "WorkRecommendationJob"("updated_at", "work_id");
CREATE TABLE "WorkRecommendationResult" (
  "viewer_id" TEXT NOT NULL,
  "work_id" TEXT NOT NULL,
  "media_version_id" TEXT NOT NULL,
  "work_revision" INTEGER NOT NULL,
  "rule_version" INTEGER NOT NULL,
  "qualified" BOOLEAN NOT NULL DEFAULT false,
  "qualified_at" DATETIME,
  "history_from" DATETIME,
  "score" INTEGER NOT NULL DEFAULT 0,
  "evidence_json" TEXT NOT NULL DEFAULT '[]',
  "evaluated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("viewer_id", "work_id")
);
CREATE INDEX "WorkRecommendationResult_viewer_id_qualified_rule_version_work_id_idx" ON "WorkRecommendationResult"("viewer_id", "qualified", "rule_version", "work_id");
CREATE INDEX "WorkContext_indexed_at_work_id_idx" ON "WorkContext"("indexed_at", "work_id");
