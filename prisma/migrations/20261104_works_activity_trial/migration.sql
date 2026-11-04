-- Additional facts for Works. No changes to old rows, media, or operation receipts.
CREATE TABLE "WorkView" (
  "work_id" TEXT NOT NULL,
  "viewer_id" TEXT NOT NULL,
  "count" INTEGER NOT NULL,
  "last_viewed_ms" BIGINT NOT NULL,
  PRIMARY KEY ("work_id","viewer_id")
);

-- Count completed method preparations via the original idempotent receipts.
CREATE INDEX "WorkOperation_successful_method_work_idx" ON "WorkOperation" (
  (CASE WHEN json_valid(result_json) THEN json_extract(result_json, '$.workId') END)
) WHERE (CASE WHEN json_valid(result_json) THEN json_extract(result_json, '$.kind') END) IN ('image-template','video-template');

CREATE TABLE "WorkRecommendationTrial" (
  "viewer_id" TEXT NOT NULL,
  "work_id" TEXT NOT NULL,
  "media_version_id" TEXT NOT NULL,
  "evidence_work_id" TEXT NOT NULL,
  "evidence_media_version_id" TEXT NOT NULL,
  "rule_version" INTEGER NOT NULL,
  "score" INTEGER NOT NULL,
  PRIMARY KEY ("viewer_id","work_id")
);
