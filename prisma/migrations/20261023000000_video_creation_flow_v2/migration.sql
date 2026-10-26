-- Expand only; existing values are copied unchanged when widening the batch CHECK. Not applied by implementation/build.
PRAGMA foreign_keys=OFF;
BEGIN IMMEDIATE;
ALTER TABLE "VideoTask" ADD COLUMN "creation_intent_id" TEXT REFERENCES "VideoCreationIntent"("id") ON DELETE RESTRICT;
ALTER TABLE "VideoTask" ADD COLUMN "creation_contract_version" INTEGER;
ALTER TABLE "VideoTask" ADD COLUMN "derived_from_task_id" TEXT REFERENCES "VideoTask"("id") ON DELETE RESTRICT;
ALTER TABLE "VideoTask" ADD COLUMN "derivation_kind" TEXT;
ALTER TABLE "VideoTask" ADD COLUMN "lineage_root_task_id" TEXT REFERENCES "VideoTask"("id") ON DELETE RESTRICT;
CREATE TABLE "VideoCreationIntent" (
 "id" TEXT NOT NULL PRIMARY KEY, "owner_id" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT,
 "request_id" TEXT NOT NULL, "contract_version" INTEGER NOT NULL DEFAULT 2, "revision" INTEGER NOT NULL DEFAULT 1,
 "action" TEXT NOT NULL, "entry" TEXT NOT NULL,
 "project_id" TEXT NOT NULL REFERENCES "Project"("id") ON DELETE RESTRICT,
 "legacy_card_id" TEXT REFERENCES "VideoCard"("id") ON DELETE RESTRICT,
 "parent_task_id" TEXT REFERENCES "VideoTask"("id") ON DELETE RESTRICT,
 "baseline_task_id" TEXT REFERENCES "VideoTask"("id") ON DELETE RESTRICT, "batch_id" TEXT,
 "count" INTEGER NOT NULL DEFAULT 1, "payer_kind" TEXT NOT NULL, "payer_account_id" TEXT NOT NULL,
 "input_hash" TEXT NOT NULL, "spec_json" TEXT NOT NULL, "pricing_revision" TEXT,
 "quote_business_hash" TEXT NOT NULL, "state" TEXT NOT NULL DEFAULT 'prepared',
 "accepted_task_id" TEXT REFERENCES "VideoTask"("id") ON DELETE RESTRICT,
 "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "VideoCreationIntent_owner_id_request_id_key" ON "VideoCreationIntent"("owner_id","request_id");
CREATE UNIQUE INDEX "VideoCreationIntent_batch_id_key" ON "VideoCreationIntent"("batch_id");
CREATE INDEX "VideoCreationIntent_project_id_state_created_at_idx" ON "VideoCreationIntent"("project_id","state","created_at");
CREATE INDEX "VideoTask_creation_intent_id_idx" ON "VideoTask"("creation_intent_id");
CREATE INDEX "VideoTask_lineage_root_task_id_created_at_id_idx" ON "VideoTask"("lineage_root_task_id","created_at","id");
CREATE INDEX "VideoTask_derived_from_task_id_idx" ON "VideoTask"("derived_from_task_id");
CREATE TABLE "VideoDeliverySelection" (
 "id" TEXT NOT NULL PRIMARY KEY, "project_id" TEXT NOT NULL REFERENCES "Project"("id") ON DELETE RESTRICT,
 "lineage_root_task_id" TEXT NOT NULL REFERENCES "VideoTask"("id") ON DELETE RESTRICT,
 "owner_id" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT,
 "selected_task_id" TEXT REFERENCES "VideoTask"("id") ON DELETE RESTRICT, "state" TEXT NOT NULL DEFAULT 'open',
 "revision" INTEGER NOT NULL DEFAULT 0, "selected_by" TEXT, "locked_by" TEXT, "locked_at" DATETIME,
 "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "VideoDeliverySelection_project_id_lineage_root_task_id_key" ON "VideoDeliverySelection"("project_id","lineage_root_task_id");
CREATE INDEX "VideoDeliverySelection_owner_id_updated_at_idx" ON "VideoDeliverySelection"("owner_id","updated_at");
-- SQLite cannot widen the existing CHECK(contract_version = 1) with ADD COLUMN.
-- Copy every existing value unchanged; child FK keeps the original final table name.

CREATE TABLE "new_CanvasVideoBatch" (
 "id" TEXT NOT NULL PRIMARY KEY, "owner_user_id" TEXT NOT NULL, "document_id" TEXT NOT NULL,
 "node_id" TEXT NOT NULL, "project_id" TEXT NOT NULL, "video_card_id" TEXT, "video_branch_id" TEXT,
 "client_request_id" TEXT NOT NULL, "request_hash" TEXT NOT NULL, "count" INTEGER NOT NULL CHECK ("count" IN (2,4)),
 "contract_version" INTEGER NOT NULL DEFAULT 1 CHECK ("contract_version" IN (1,2)),
 "creation_intent_id" TEXT REFERENCES "VideoCreationIntent"("id") ON DELETE RESTRICT,
 "authorization_round" INTEGER NOT NULL DEFAULT 1, "frozen_input_json" TEXT NOT NULL,
 "authorized_total" INTEGER NOT NULL CHECK ("authorized_total">=0),
 "admitted_total" INTEGER NOT NULL DEFAULT 0 CHECK ("admitted_total">=0 AND "admitted_total"<="authorized_total"),
 "active_node_key" TEXT, "state" TEXT NOT NULL DEFAULT 'prepared', "revision" INTEGER NOT NULL DEFAULT 1,
 "operations_json" TEXT NOT NULL DEFAULT '{}', "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" DATETIME NOT NULL
);
INSERT INTO "new_CanvasVideoBatch" ("id","owner_user_id","document_id","node_id","project_id","video_card_id","video_branch_id","client_request_id","request_hash","count","contract_version","frozen_input_json","authorized_total","admitted_total","active_node_key","state","revision","operations_json","created_at","updated_at")
 SELECT "id","owner_user_id","document_id","node_id","project_id","video_card_id","video_branch_id","client_request_id","request_hash","count","contract_version","frozen_input_json","authorized_total","admitted_total","active_node_key","state","revision","operations_json","created_at","updated_at" FROM "CanvasVideoBatch";
DROP TABLE "CanvasVideoBatch";
ALTER TABLE "new_CanvasVideoBatch" RENAME TO "CanvasVideoBatch";
CREATE UNIQUE INDEX "CanvasVideoBatch_active_node_key_key" ON "CanvasVideoBatch"("active_node_key");
CREATE UNIQUE INDEX "CanvasVideoBatch_owner_user_id_client_request_id_key" ON "CanvasVideoBatch"("owner_user_id","client_request_id");
CREATE INDEX "CanvasVideoBatch_owner_user_id_document_id_node_id_created_at_id_idx" ON "CanvasVideoBatch"("owner_user_id","document_id","node_id","created_at","id");
CREATE INDEX "CanvasVideoBatch_document_id_idx" ON "CanvasVideoBatch"("document_id");

ALTER TABLE "CanvasVideoBatchChild" ADD COLUMN "intent_spec_revision" INTEGER;
ALTER TABLE "CanvasVideoBatchChild" ADD COLUMN "authorization_revision" INTEGER;
ALTER TABLE "CanvasVideoBatchChild" ADD COLUMN "approval_record_id" TEXT;
ALTER TABLE "CanvasVideoBatchChild" ADD COLUMN "approval_scope_hash" TEXT;
ALTER TABLE "ApprovalRecord" ADD COLUMN "creation_intent_id" TEXT REFERENCES "VideoCreationIntent"("id") ON DELETE RESTRICT;
ALTER TABLE "ApprovalRecord" ADD COLUMN "intent_revision" INTEGER;
ALTER TABLE "ApprovalRecord" ADD COLUMN "scope_hash" TEXT;
ALTER TABLE "ApprovalRecord" ADD COLUMN "billing_scope" TEXT;
ALTER TABLE "ApprovalRecord" ADD COLUMN "billing_account_id" TEXT;
ALTER TABLE "ApprovalRecord" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "ApprovalRecord" ADD COLUMN "authorized_cost_cents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ApprovalRecord" ADD COLUMN "used_cost_cents" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX "ApprovalRecord_creation_intent_id_intent_revision_idx" ON "ApprovalRecord"("creation_intent_id","intent_revision");
ALTER TABLE "ApprovalUsage" ADD COLUMN "creation_intent_id" TEXT REFERENCES "VideoCreationIntent"("id") ON DELETE RESTRICT;
ALTER TABLE "ApprovalUsage" ADD COLUMN "intent_revision" INTEGER;
ALTER TABLE "ApprovalUsage" ADD COLUMN "authorization_revision" INTEGER;
ALTER TABLE "ApprovalUsage" ADD COLUMN "child_key" TEXT;
ALTER TABLE "ApprovalUsage" ADD COLUMN "authorized_cost_cents" INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX "ApprovalUsage_approval_id_creation_intent_id_child_key_key" ON "ApprovalUsage"("approval_id","creation_intent_id","child_key");

COMMIT;
PRAGMA foreign_key_check;
PRAGMA foreign_keys=ON;
