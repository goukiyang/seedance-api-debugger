-- CreateTable
CREATE TABLE "VideoCard" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "project_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "objective" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "owner_user_id" TEXT,
    "platform" TEXT,
    "ratio" TEXT,
    "duration" INTEGER,
    "target_resolution" TEXT,
    "budget_credits" REAL,
    "budget_currency" TEXT DEFAULT 'credits',
    "current_best_task_id" TEXT,
    "final_task_id" TEXT,
    "is_fallback" BOOLEAN NOT NULL DEFAULT false,
    "created_by" TEXT NOT NULL,
    "sealed_at" DATETIME,
    "sealed_by" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VideoCard_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "VideoCard_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "VideoCard_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "VideoCard_sealed_by_fkey" FOREIGN KEY ("sealed_by") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "VideoCard_current_best_task_id_fkey" FOREIGN KEY ("current_best_task_id") REFERENCES "VideoTask" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "VideoCard_final_task_id_fkey" FOREIGN KEY ("final_task_id") REFERENCES "VideoTask" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- AlterTable
ALTER TABLE "VideoTask" ADD COLUMN "video_card_id" TEXT;
ALTER TABLE "VideoTask" ADD COLUMN "version_role" TEXT NOT NULL DEFAULT 'normal';

-- CreateIndex
CREATE INDEX "VideoCard_project_id_idx" ON "VideoCard"("project_id");
CREATE INDEX "VideoCard_status_idx" ON "VideoCard"("status");
CREATE INDEX "VideoCard_owner_user_id_idx" ON "VideoCard"("owner_user_id");
CREATE INDEX "VideoCard_created_by_idx" ON "VideoCard"("created_by");
CREATE INDEX "VideoCard_current_best_task_id_idx" ON "VideoCard"("current_best_task_id");
CREATE INDEX "VideoCard_final_task_id_idx" ON "VideoCard"("final_task_id");
CREATE INDEX "VideoCard_is_fallback_idx" ON "VideoCard"("is_fallback");
CREATE INDEX "VideoTask_video_card_id_idx" ON "VideoTask"("video_card_id");
CREATE INDEX "VideoTask_version_role_idx" ON "VideoTask"("version_role");
