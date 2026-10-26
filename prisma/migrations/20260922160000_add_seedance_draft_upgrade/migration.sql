ALTER TABLE "VideoTask" ADD COLUMN "is_draft" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "VideoTask" ADD COLUMN "provider_draft_task_id" TEXT;
ALTER TABLE "VideoTask" ADD COLUMN "draft_upgrade_mode" TEXT;
ALTER TABLE "VideoTask" ADD COLUMN "source_draft_task_id" TEXT;
ALTER TABLE "VideoTask" ADD COLUMN "draft_contract_version" TEXT;

PRAGMA foreign_keys=OFF;
CREATE TABLE "new_VideoTask" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "generation_mode" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "source_type" TEXT NOT NULL DEFAULT 'web',
    "source_label" TEXT,
    "source_request_id" TEXT,
    "source_metadata_json" TEXT,
    "ratio" TEXT,
    "duration" INTEGER,
    "resolution" TEXT,
    "seed" INTEGER,
    "generate_audio" BOOLEAN NOT NULL DEFAULT true,
    "return_last_frame" BOOLEAN NOT NULL DEFAULT false,
    "watermark" BOOLEAN NOT NULL DEFAULT false,
    "reference_image_urls" TEXT,
    "reference_video_urls" TEXT,
    "reference_audio_urls" TEXT,
    "first_frame_url" TEXT,
    "last_frame_url" TEXT,
    "frame_image_urls" TEXT,
    "callback_url" TEXT,
    "execution_expires_after" INTEGER,
    "local_status" TEXT NOT NULL DEFAULT 'draft',
    "provider_task_id" TEXT,
    "is_draft" BOOLEAN NOT NULL DEFAULT false,
    "provider_draft_task_id" TEXT,
    "draft_upgrade_mode" TEXT,
    "source_draft_task_id" TEXT,
    "draft_contract_version" TEXT,
    "provider_status" TEXT,
    "result_video_url" TEXT,
    "result_last_frame_url" TEXT,
    "local_video_path" TEXT,
    "public_video_url" TEXT,
    "public_video_storage_provider" TEXT,
    "public_video_storage_key" TEXT,
    "public_video_file_size" INTEGER,
    "public_video_cached_at" DATETIME,
    "delivery_status" TEXT,
    "delivery_queued_at" DATETIME,
    "delivery_started_at" DATETIME,
    "delivery_completed_at" DATETIME,
    "delivery_attempts" INTEGER,
    "delivery_error" TEXT,
    "raw_create_response" TEXT,
    "raw_status_response" TEXT,
    "error_message" TEXT,
    "error_code" TEXT,
    "reference_album_ids" TEXT,
    "reference_image_ids" TEXT,
    "params_json" TEXT,
    "reference_images_json" TEXT,
    "provider_payload_json" TEXT,
    "workspace_id" TEXT,
    "snapshot_id" TEXT,
    "user_id" TEXT,
    "owner_user_id" TEXT,
    "project_id" TEXT,
    "video_card_id" TEXT,
    "video_branch_id" TEXT,
    "template_id" TEXT,
    "agent_run_id" TEXT,
    "visibility" TEXT NOT NULL DEFAULT 'project',
    "version_role" TEXT NOT NULL DEFAULT 'normal',
    "selected_agent_plan_key" TEXT,
    "agent_prompt_snapshot" TEXT,
    "final_prompt_snapshot" TEXT,
    "prompt_user_edited" BOOLEAN NOT NULL DEFAULT false,
    "retention_status" TEXT NOT NULL DEFAULT 'active',
    "user_deleted_at" DATETIME,
    "user_deleted_by" TEXT,
    "admin_hidden_at" DATETIME,
    "admin_hidden_by" TEXT,
    "restored_at" DATETIME,
    "restored_by" TEXT,
    "delete_reason" TEXT,
    "estimated_cost" REAL,
    "actual_cost" REAL,
    "frozen_cost" REAL,
    "refund_amount" REAL,
    "credit_freeze_snapshot" TEXT,
    "pricing_snapshot" TEXT,
    "pricing_rule_id" TEXT,
    "idempotency_key" TEXT,
    "billing_scope" TEXT NOT NULL DEFAULT 'user',
    "billing_account_id" TEXT,
    "provider_cost_status" TEXT NOT NULL DEFAULT 'not_recorded',
    "provider_cost_snapshot" TEXT,
    "provider_cost_currency" TEXT,
    "provider_estimated_amount_minor" INTEGER,
    "provider_rule_amount_minor" INTEGER,
    "provider_official_amount_minor" INTEGER,
    "provider_final_amount_minor" INTEGER,
    "provider_official_amount_micros" INTEGER,
    "provider_final_amount_micros" INTEGER,
    "provider_billing_status" TEXT,
    "provider_billing_time" DATETIME,
    "provider_usage_snapshot" TEXT,
    "provider_client_request_id" TEXT,
    "provider_cost_confirmed_at" DATETIME,
    "provider_cost_reconciled_at" DATETIME,
    "cost_allocation_status" TEXT NOT NULL DEFAULT 'allocated',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "completed_at" DATETIME,
    CONSTRAINT "VideoTask_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "Workspace" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "VideoTask_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "VideoTask_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "VideoTask_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "Project" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "VideoTask_video_card_id_fkey" FOREIGN KEY ("video_card_id") REFERENCES "VideoCard" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "VideoTask_video_branch_id_fkey" FOREIGN KEY ("video_branch_id") REFERENCES "VideoBranch" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "VideoTask_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "GenerationTemplate" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "VideoTask_source_draft_task_id_fkey" FOREIGN KEY ("source_draft_task_id") REFERENCES "VideoTask" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

INSERT INTO "new_VideoTask" SELECT
    "id", "provider", "model", "generation_mode", "prompt", "source_type", "source_label", "source_request_id", "source_metadata_json",
    "ratio", "duration", "resolution", "seed", "generate_audio", "return_last_frame", "watermark", "reference_image_urls", "reference_video_urls", "reference_audio_urls", "first_frame_url", "last_frame_url", "frame_image_urls", "callback_url", "execution_expires_after", "local_status", "provider_task_id", "is_draft", "provider_draft_task_id", "draft_upgrade_mode", "source_draft_task_id", "draft_contract_version", "provider_status", "result_video_url", "result_last_frame_url", "local_video_path", "public_video_url", "public_video_storage_provider", "public_video_storage_key", "public_video_file_size", "public_video_cached_at", "delivery_status", "delivery_queued_at", "delivery_started_at", "delivery_completed_at", "delivery_attempts", "delivery_error", "raw_create_response", "raw_status_response", "error_message", "error_code", "reference_album_ids", "reference_image_ids", "params_json", "reference_images_json", "provider_payload_json", "workspace_id", "snapshot_id", "user_id", "owner_user_id", "project_id", "video_card_id", "video_branch_id", "template_id", "agent_run_id", "visibility", "version_role", "selected_agent_plan_key", "agent_prompt_snapshot", "final_prompt_snapshot", "prompt_user_edited", "retention_status", "user_deleted_at", "user_deleted_by", "admin_hidden_at", "admin_hidden_by", "restored_at", "restored_by", "delete_reason", "estimated_cost", "actual_cost", "frozen_cost", "refund_amount", "credit_freeze_snapshot", "pricing_snapshot", "pricing_rule_id", "idempotency_key", "billing_scope", "billing_account_id", "provider_cost_status", "provider_cost_snapshot", "provider_cost_currency", "provider_estimated_amount_minor", "provider_rule_amount_minor", "provider_official_amount_minor", "provider_final_amount_minor", "provider_official_amount_micros", "provider_final_amount_micros", "provider_billing_status", "provider_billing_time", "provider_usage_snapshot", "provider_client_request_id", "provider_cost_confirmed_at", "provider_cost_reconciled_at", "cost_allocation_status", "created_at", "updated_at", "completed_at"
  FROM "VideoTask";
DROP TABLE "VideoTask";
ALTER TABLE "new_VideoTask" RENAME TO "VideoTask";

CREATE UNIQUE INDEX "VideoTask_snapshot_id_key" ON "VideoTask"("snapshot_id");
CREATE UNIQUE INDEX "VideoTask_user_id_idempotency_key_key" ON "VideoTask"("user_id", "idempotency_key");
CREATE INDEX "VideoTask_user_id_idx" ON "VideoTask"("user_id");
CREATE INDEX "VideoTask_owner_user_id_idx" ON "VideoTask"("owner_user_id");
CREATE INDEX "VideoTask_project_id_idx" ON "VideoTask"("project_id");
CREATE INDEX "VideoTask_video_card_id_idx" ON "VideoTask"("video_card_id");
CREATE INDEX "VideoTask_video_branch_id_idx" ON "VideoTask"("video_branch_id");
CREATE INDEX "VideoTask_template_id_idx" ON "VideoTask"("template_id");
CREATE INDEX "VideoTask_agent_run_id_idx" ON "VideoTask"("agent_run_id");
CREATE INDEX "VideoTask_version_role_idx" ON "VideoTask"("version_role");
CREATE INDEX "VideoTask_source_type_idx" ON "VideoTask"("source_type");
CREATE INDEX "VideoTask_source_request_id_idx" ON "VideoTask"("source_request_id");
CREATE INDEX "VideoTask_local_status_idx" ON "VideoTask"("local_status");
CREATE INDEX "VideoTask_provider_task_id_idx" ON "VideoTask"("provider_task_id");
CREATE INDEX "VideoTask_public_video_storage_provider_public_video_storage_key_idx" ON "VideoTask"("public_video_storage_provider", "public_video_storage_key");
CREATE INDEX "VideoTask_delivery_status_idx" ON "VideoTask"("delivery_status");
CREATE INDEX "VideoTask_delivery_completed_at_idx" ON "VideoTask"("delivery_completed_at");
CREATE INDEX "VideoTask_provider_client_request_id_idx" ON "VideoTask"("provider_client_request_id");
CREATE INDEX "VideoTask_provider_cost_status_idx" ON "VideoTask"("provider_cost_status");
CREATE INDEX "VideoTask_retention_status_idx" ON "VideoTask"("retention_status");
CREATE INDEX "VideoTask_user_deleted_at_idx" ON "VideoTask"("user_deleted_at");
CREATE INDEX "VideoTask_provider_draft_task_id_idx" ON "VideoTask"("provider_draft_task_id");
CREATE INDEX "VideoTask_source_draft_task_id_idx" ON "VideoTask"("source_draft_task_id");
CREATE INDEX "VideoTask_is_draft_idx" ON "VideoTask"("is_draft");
PRAGMA foreign_keys=ON;
