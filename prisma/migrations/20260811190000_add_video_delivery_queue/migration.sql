ALTER TABLE "VideoTask" ADD COLUMN "delivery_status" TEXT;
ALTER TABLE "VideoTask" ADD COLUMN "delivery_queued_at" DATETIME;
ALTER TABLE "VideoTask" ADD COLUMN "delivery_started_at" DATETIME;
ALTER TABLE "VideoTask" ADD COLUMN "delivery_completed_at" DATETIME;
ALTER TABLE "VideoTask" ADD COLUMN "delivery_attempts" INTEGER;
ALTER TABLE "VideoTask" ADD COLUMN "delivery_error" TEXT;

CREATE TABLE "VideoDeliveryJob" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "task_id" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "priority" INTEGER NOT NULL DEFAULT 0,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 5,
  "run_after" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "locked_at" DATETIME,
  "locked_by" TEXT,
  "last_error" TEXT,
  "payload_json" TEXT,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" DATETIME,
  CONSTRAINT "VideoDeliveryJob_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "VideoTask" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "VideoDeliveryJob_task_id_key" ON "VideoDeliveryJob"("task_id");
CREATE INDEX "VideoDeliveryJob_status_run_after_priority_idx" ON "VideoDeliveryJob"("status", "run_after", "priority");
CREATE INDEX "VideoDeliveryJob_locked_at_idx" ON "VideoDeliveryJob"("locked_at");
CREATE INDEX "VideoDeliveryJob_completed_at_idx" ON "VideoDeliveryJob"("completed_at");
CREATE INDEX "VideoTask_delivery_status_idx" ON "VideoTask"("delivery_status");
CREATE INDEX "VideoTask_delivery_completed_at_idx" ON "VideoTask"("delivery_completed_at");
