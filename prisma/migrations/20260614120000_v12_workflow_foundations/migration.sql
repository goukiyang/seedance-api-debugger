-- V1.2 workflow foundations: approval usage, video branches, Feishu drafts,
-- review cards, notifications, and video-card delivery metadata.

ALTER TABLE "VideoTask" ADD COLUMN "video_branch_id" TEXT;

ALTER TABLE "VideoCard" ADD COLUMN "original_ratio" TEXT;
ALTER TABLE "VideoCard" ADD COLUMN "ratio_locked" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "VideoCard" ADD COLUMN "ratio_change_reason" TEXT;
ALTER TABLE "VideoCard" ADD COLUMN "delivery_specs_json" TEXT;
ALTER TABLE "VideoCard" ADD COLUMN "merged_into_card_id" TEXT;
ALTER TABLE "VideoCard" ADD COLUMN "merged_at" DATETIME;
ALTER TABLE "VideoCard" ADD COLUMN "merge_reason" TEXT;

ALTER TABLE "ProjectBudgetAccount" ADD COLUMN "freeze_reason" TEXT;
ALTER TABLE "ProjectBudgetAccount" ADD COLUMN "reconciliation_status" TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE "ProjectBudgetAccount" ADD COLUMN "threshold_notified_json" TEXT;

ALTER TABLE "ApprovalRecord" ADD COLUMN "usage_limit" INTEGER;
ALTER TABLE "ApprovalRecord" ADD COLUMN "used_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ApprovalRecord" ADD COLUMN "effect_status" TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE "ApprovalRecord" ADD COLUMN "effect_error" TEXT;

CREATE TABLE "VideoBranch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "video_card_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'exploring',
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "promoted_card_id" TEXT,
    "merged_into_branch_id" TEXT,
    "created_by" TEXT NOT NULL,
    "closed_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VideoBranch_video_card_id_fkey" FOREIGN KEY ("video_card_id") REFERENCES "VideoCard" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "ApprovalUsage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "approval_id" TEXT NOT NULL,
    "task_id" TEXT,
    "user_id" TEXT NOT NULL,
    "amount" INTEGER NOT NULL DEFAULT 1,
    "metadata_json" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ApprovalUsage_approval_id_fkey" FOREIGN KEY ("approval_id") REFERENCES "ApprovalRecord" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ApprovalUsage_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "VideoTask" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ApprovalUsage_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "FeishuRequirement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "app_token" TEXT NOT NULL,
    "table_id" TEXT NOT NULL,
    "record_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "record_type" TEXT NOT NULL DEFAULT 'project',
    "sync_status" TEXT NOT NULL DEFAULT 'draft',
    "raw_fields_json" TEXT NOT NULL,
    "project_draft_json" TEXT,
    "video_cards_json" TEXT,
    "created_project_id" TEXT,
    "error_message" TEXT,
    "last_synced_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FeishuRequirement_created_project_id_fkey" FOREIGN KEY ("created_project_id") REFERENCES "Project" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "ReviewCard" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "project_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "summary_json" TEXT NOT NULL,
    "total_credits" REAL NOT NULL DEFAULT 0,
    "total_amount_micros" INTEGER,
    "currency" TEXT,
    "video_card_count" INTEGER NOT NULL DEFAULT 0,
    "final_task_count" INTEGER NOT NULL DEFAULT 0,
    "failure_rate" REAL NOT NULL DEFAULT 0,
    "budget_suggestion_credits" REAL,
    "budget_suggestion_reason" TEXT,
    "admin_note" TEXT,
    "generated_by" TEXT,
    "generated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReviewCard_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ReviewCard_generated_by_fkey" FOREIGN KEY ("generated_by") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "Notification" (
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
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Notification_target_user_id_fkey" FOREIGN KEY ("target_user_id") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Notification_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Notification_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Notification_video_card_id_fkey" FOREIGN KEY ("video_card_id") REFERENCES "VideoCard" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Notification_approval_id_fkey" FOREIGN KEY ("approval_id") REFERENCES "ApprovalRecord" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "VideoTask_video_branch_id_idx" ON "VideoTask" ("video_branch_id");
CREATE INDEX "VideoCard_merged_into_card_id_idx" ON "VideoCard" ("merged_into_card_id");

CREATE INDEX "VideoBranch_video_card_id_idx" ON "VideoBranch" ("video_card_id");
CREATE INDEX "VideoBranch_status_idx" ON "VideoBranch" ("status");
CREATE INDEX "VideoBranch_is_primary_idx" ON "VideoBranch" ("is_primary");
CREATE INDEX "VideoBranch_promoted_card_id_idx" ON "VideoBranch" ("promoted_card_id");

CREATE UNIQUE INDEX "ApprovalUsage_approval_id_task_id_key" ON "ApprovalUsage" ("approval_id", "task_id");
CREATE INDEX "ApprovalUsage_approval_id_idx" ON "ApprovalUsage" ("approval_id");
CREATE INDEX "ApprovalUsage_task_id_idx" ON "ApprovalUsage" ("task_id");
CREATE INDEX "ApprovalUsage_user_id_idx" ON "ApprovalUsage" ("user_id");

CREATE UNIQUE INDEX "FeishuRequirement_idempotency_key_key" ON "FeishuRequirement" ("idempotency_key");
CREATE UNIQUE INDEX "FeishuRequirement_app_token_table_id_record_id_key" ON "FeishuRequirement" ("app_token", "table_id", "record_id");
CREATE INDEX "FeishuRequirement_sync_status_idx" ON "FeishuRequirement" ("sync_status");
CREATE INDEX "FeishuRequirement_created_project_id_idx" ON "FeishuRequirement" ("created_project_id");

CREATE INDEX "ReviewCard_project_id_idx" ON "ReviewCard" ("project_id");
CREATE INDEX "ReviewCard_status_idx" ON "ReviewCard" ("status");
CREATE INDEX "ReviewCard_generated_at_idx" ON "ReviewCard" ("generated_at");

CREATE INDEX "Notification_target_user_id_idx" ON "Notification" ("target_user_id");
CREATE INDEX "Notification_actor_user_id_idx" ON "Notification" ("actor_user_id");
CREATE INDEX "Notification_project_id_idx" ON "Notification" ("project_id");
CREATE INDEX "Notification_video_card_id_idx" ON "Notification" ("video_card_id");
CREATE INDEX "Notification_approval_id_idx" ON "Notification" ("approval_id");
CREATE INDEX "Notification_type_idx" ON "Notification" ("type");
CREATE INDEX "Notification_status_idx" ON "Notification" ("status");
CREATE INDEX "Notification_created_at_idx" ON "Notification" ("created_at");
