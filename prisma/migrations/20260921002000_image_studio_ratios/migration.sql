ALTER TABLE "ImageStudioModule" ADD COLUMN "aspect_ratio" TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE "ImageStudioTask" ADD COLUMN "aspect_ratio" TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE "ImageStudioTask" ADD COLUMN "output_size" TEXT;
ALTER TABLE "ImageStudioTask" ADD COLUMN "deleted_at" DATETIME;
