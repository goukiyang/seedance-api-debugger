ALTER TABLE "ImageStudioModule" ADD COLUMN "model" TEXT;
ALTER TABLE "ImageStudioModule" ADD COLUMN "prices_json" TEXT;
ALTER TABLE "ImageStudioModule" ADD COLUMN "reproduce_task_id" TEXT;
ALTER TABLE "ImageStudioTask" ADD COLUMN "snapshot_json" TEXT;
