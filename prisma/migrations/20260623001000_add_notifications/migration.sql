-- The local dev database already had this table from prior notification planning.
-- Keep the migration idempotent so fresh checkouts get the same shape without
-- breaking existing databases.
CREATE TABLE IF NOT EXISTS "Notification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'in_app',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "target_user_id" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "project_id" TEXT,
    "video_card_id" TEXT,
    "approval_id" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "metadata_json" TEXT,
    "sent_at" DATETIME,
    "read_at" DATETIME,
    "error_message" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "Notification_target_user_id_fkey" FOREIGN KEY ("target_user_id") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Notification_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Notification_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Notification_video_card_id_fkey" FOREIGN KEY ("video_card_id") REFERENCES "VideoCard" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Notification_approval_id_fkey" FOREIGN KEY ("approval_id") REFERENCES "ApprovalRecord" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "Notification_target_user_id_idx" ON "Notification"("target_user_id");
CREATE INDEX IF NOT EXISTS "Notification_actor_user_id_idx" ON "Notification"("actor_user_id");
CREATE INDEX IF NOT EXISTS "Notification_project_id_idx" ON "Notification"("project_id");
CREATE INDEX IF NOT EXISTS "Notification_video_card_id_idx" ON "Notification"("video_card_id");
CREATE INDEX IF NOT EXISTS "Notification_approval_id_idx" ON "Notification"("approval_id");
CREATE INDEX IF NOT EXISTS "Notification_type_idx" ON "Notification"("type");
CREATE INDEX IF NOT EXISTS "Notification_status_idx" ON "Notification"("status");
CREATE INDEX IF NOT EXISTS "Notification_created_at_idx" ON "Notification"("created_at");
