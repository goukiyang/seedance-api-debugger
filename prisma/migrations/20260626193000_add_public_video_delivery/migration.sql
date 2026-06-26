ALTER TABLE "VideoTask" ADD COLUMN "public_video_url" TEXT;
ALTER TABLE "VideoTask" ADD COLUMN "public_video_storage_provider" TEXT;
ALTER TABLE "VideoTask" ADD COLUMN "public_video_storage_key" TEXT;
ALTER TABLE "VideoTask" ADD COLUMN "public_video_file_size" INTEGER;
ALTER TABLE "VideoTask" ADD COLUMN "public_video_cached_at" DATETIME;

CREATE INDEX "VideoTask_public_video_storage_provider_public_video_storage_key_idx"
ON "VideoTask" ("public_video_storage_provider", "public_video_storage_key");
