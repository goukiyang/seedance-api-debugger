-- Additive purpose isolation. Apply only after the protected release drains all existing writers.
ALTER TABLE "VideoStudioDraft" ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'studio';
ALTER TABLE "VideoStudioRun" ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'studio';
CREATE INDEX "VideoStudioDraft_owner_user_id_purpose_updated_at_idx" ON "VideoStudioDraft"("owner_user_id", "purpose", "updated_at");
CREATE INDEX "VideoStudioRun_owner_user_id_purpose_created_at_idx" ON "VideoStudioRun"("owner_user_id", "purpose", "created_at");
