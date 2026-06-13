CREATE TABLE "ApprovalRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "project_id" TEXT,
    "video_card_id" TEXT,
    "task_id" TEXT,
    "requester_user_id" TEXT NOT NULL,
    "approver_user_id" TEXT,
    "reason" TEXT,
    "decision_reason" TEXT,
    "scope_json" TEXT,
    "requested_payload_json" TEXT,
    "approved_at" DATETIME,
    "rejected_at" DATETIME,
    "expires_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ApprovalRecord_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "Project" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ApprovalRecord_video_card_id_fkey" FOREIGN KEY ("video_card_id") REFERENCES "VideoCard" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ApprovalRecord_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "VideoTask" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ApprovalRecord_requester_user_id_fkey" FOREIGN KEY ("requester_user_id") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ApprovalRecord_approver_user_id_fkey" FOREIGN KEY ("approver_user_id") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "ApprovalRecord_type_idx" ON "ApprovalRecord" ("type");
CREATE INDEX "ApprovalRecord_status_idx" ON "ApprovalRecord" ("status");
CREATE INDEX "ApprovalRecord_project_id_idx" ON "ApprovalRecord" ("project_id");
CREATE INDEX "ApprovalRecord_video_card_id_idx" ON "ApprovalRecord" ("video_card_id");
CREATE INDEX "ApprovalRecord_task_id_idx" ON "ApprovalRecord" ("task_id");
CREATE INDEX "ApprovalRecord_requester_user_id_idx" ON "ApprovalRecord" ("requester_user_id");
CREATE INDEX "ApprovalRecord_approver_user_id_idx" ON "ApprovalRecord" ("approver_user_id");
CREATE INDEX "ApprovalRecord_expires_at_idx" ON "ApprovalRecord" ("expires_at");
CREATE INDEX "ApprovalRecord_created_at_idx" ON "ApprovalRecord" ("created_at");
