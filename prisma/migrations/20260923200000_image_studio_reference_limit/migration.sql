ALTER TABLE "ImageStudioModule" ADD COLUMN "reference_limit" INTEGER NOT NULL DEFAULT 10;
ALTER TABLE "ImageStudioPreset" ADD COLUMN "reference_limit" INTEGER NOT NULL DEFAULT 10;
