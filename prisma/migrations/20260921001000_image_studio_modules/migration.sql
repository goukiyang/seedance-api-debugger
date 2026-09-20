CREATE TABLE "ImageStudioModule" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "owner_id" TEXT NOT NULL,
  "name" TEXT NOT NULL DEFAULT '未命名模块',
  "prompt" TEXT NOT NULL DEFAULT '',
  "context" TEXT NOT NULL DEFAULT '',
  "count" INTEGER NOT NULL DEFAULT 1,
  "reference_ids" TEXT NOT NULL DEFAULT '[]',
  "revision" INTEGER NOT NULL DEFAULT 0,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL
);
CREATE INDEX "ImageStudioModule_owner_id_created_at_idx" ON "ImageStudioModule"("owner_id", "created_at");
ALTER TABLE "ImageStudioTask" ADD COLUMN "module_id" TEXT;
CREATE INDEX "ImageStudioTask_owner_id_module_id_created_at_idx" ON "ImageStudioTask"("owner_id", "module_id", "created_at");
