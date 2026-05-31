-- Track which integration created a video generation task.
ALTER TABLE "VideoTask" ADD COLUMN "source_type" TEXT NOT NULL DEFAULT 'web';
ALTER TABLE "VideoTask" ADD COLUMN "source_label" TEXT;
ALTER TABLE "VideoTask" ADD COLUMN "source_request_id" TEXT;
ALTER TABLE "VideoTask" ADD COLUMN "source_metadata_json" TEXT;

CREATE INDEX "VideoTask_source_type_idx" ON "VideoTask"("source_type");
CREATE INDEX "VideoTask_source_request_id_idx" ON "VideoTask"("source_request_id");
