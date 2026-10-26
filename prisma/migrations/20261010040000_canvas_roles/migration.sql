-- CreateTable
CREATE TABLE "CanvasRoleDefinition" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "owner_user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "current_version" INTEGER NOT NULL DEFAULT 1,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CanvasRoleVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "definition_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "schema" TEXT NOT NULL DEFAULT 'role.v1',
    "snapshot_json" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CanvasRoleVersion_definition_id_fkey" FOREIGN KEY ("definition_id") REFERENCES "CanvasRoleDefinition" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CanvasRoleTaskRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "owner_user_id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "requirements_revision" INTEGER NOT NULL DEFAULT 1,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'active',
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "budget_points_limit" INTEGER,
    "budget_usd_micros_limit" INTEGER,
    "reserved_points" INTEGER NOT NULL DEFAULT 0,
    "reserved_usd_micros" INTEGER NOT NULL DEFAULT 0,
    "settled_points" INTEGER NOT NULL DEFAULT 0,
    "settled_usd_micros" INTEGER NOT NULL DEFAULT 0,
    "max_calls" INTEGER,
    "call_count" INTEGER NOT NULL DEFAULT 0,
    "max_rounds" INTEGER NOT NULL,
    "wait_limit_seconds" INTEGER,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CanvasRoleTaskRevision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "role_task_run_id" TEXT NOT NULL,
    "requirements_revision" INTEGER NOT NULL,
    "snapshot_json" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CanvasRoleTaskRevision_role_task_run_id_fkey" FOREIGN KEY ("role_task_run_id") REFERENCES "CanvasRoleTaskRun" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CanvasRoleWork" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "role_task_run_id" TEXT NOT NULL,
    "requirements_revision" INTEGER NOT NULL,
    "node_id" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "role_version_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "phase" TEXT NOT NULL DEFAULT 'offered',
    "executor_user_id" TEXT,
    "reviewer_node_id" TEXT,
    "confirm_required" BOOLEAN NOT NULL DEFAULT false,
    "snapshot_json" TEXT NOT NULL,
    "inputs_json" TEXT NOT NULL DEFAULT '[]',
    "draft_text" TEXT NOT NULL DEFAULT '',
    "current_delivery_id" TEXT,
    "wait_reason" TEXT,
    "wait_since" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "CanvasRoleWork_role_task_run_id_fkey" FOREIGN KEY ("role_task_run_id") REFERENCES "CanvasRoleTaskRun" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CanvasRoleWork_role_version_id_fkey" FOREIGN KEY ("role_version_id") REFERENCES "CanvasRoleVersion" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CanvasRoleDelivery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "work_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "requirements_revision" INTEGER NOT NULL,
    "content_json" TEXT NOT NULL,
    "input_digest" TEXT NOT NULL,
    "submitted_by" TEXT NOT NULL,
    "submission_kind" TEXT NOT NULL,
    "supersedes_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CanvasRoleDelivery_work_id_fkey" FOREIGN KEY ("work_id") REFERENCES "CanvasRoleWork" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CanvasRoleEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "role_task_run_id" TEXT NOT NULL,
    "requirements_revision" INTEGER NOT NULL,
    "work_id" TEXT,
    "actor_user_id" TEXT NOT NULL,
    "actor_kind" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "delivery_id" TEXT,
    "from_node_id" TEXT,
    "to_node_id" TEXT,
    "detail_json" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CanvasRoleEvent_role_task_run_id_fkey" FOREIGN KEY ("role_task_run_id") REFERENCES "CanvasRoleTaskRun" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CanvasRoleAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "work_id" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "purpose" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "request_id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "input_snapshot_json" TEXT NOT NULL,
    "quote_json" TEXT NOT NULL,
    "reserved_points" INTEGER NOT NULL,
    "reserved_usd_micros" INTEGER NOT NULL,
    "fee_state" TEXT NOT NULL,
    "provider_scope" TEXT,
    "provider_reference" TEXT,
    "result_json" TEXT,
    "settled_points" INTEGER,
    "settled_usd_micros" INTEGER,
    "settlement_receipt" TEXT,
    "settlement_applied" BOOLEAN NOT NULL DEFAULT false,
    "started_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" DATETIME,
    CONSTRAINT "CanvasRoleAttempt_work_id_fkey" FOREIGN KEY ("work_id") REFERENCES "CanvasRoleWork" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CanvasRoleHandoff" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "role_task_run_id" TEXT NOT NULL,
    "requirements_revision" INTEGER NOT NULL,
    "source_work_id" TEXT NOT NULL,
    "source_delivery_id" TEXT NOT NULL,
    "target_work_id" TEXT NOT NULL,
    "bundle_json" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "CanvasRoleMutationReceipt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "owner_user_id" TEXT NOT NULL,
    "mutation_id" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "object_id" TEXT NOT NULL,
    "response_json" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "CanvasRoleDefinition_owner_user_id_status_updated_at_id_idx" ON "CanvasRoleDefinition"("owner_user_id", "status", "updated_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CanvasRoleVersion_definition_id_version_key" ON "CanvasRoleVersion"("definition_id", "version");

-- CreateIndex
CREATE INDEX "CanvasRoleTaskRun_owner_user_id_document_id_updated_at_id_idx" ON "CanvasRoleTaskRun"("owner_user_id", "document_id", "updated_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CanvasRoleTaskRevision_role_task_run_id_requirements_revision_key" ON "CanvasRoleTaskRevision"("role_task_run_id", "requirements_revision");

-- CreateIndex
CREATE INDEX "CanvasRoleWork_role_task_run_id_phase_updated_at_id_idx" ON "CanvasRoleWork"("role_task_run_id", "phase", "updated_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CanvasRoleWork_role_task_run_id_requirements_revision_node_id_round_key" ON "CanvasRoleWork"("role_task_run_id", "requirements_revision", "node_id", "round");

-- CreateIndex
CREATE UNIQUE INDEX "CanvasRoleDelivery_work_id_version_key" ON "CanvasRoleDelivery"("work_id", "version");

-- CreateIndex
CREATE INDEX "CanvasRoleEvent_role_task_run_id_created_at_id_idx" ON "CanvasRoleEvent"("role_task_run_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "CanvasRoleEvent_work_id_created_at_id_idx" ON "CanvasRoleEvent"("work_id", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CanvasRoleAttempt_request_id_key" ON "CanvasRoleAttempt"("request_id");

-- CreateIndex
CREATE UNIQUE INDEX "CanvasRoleAttempt_work_id_round_purpose_attempt_key" ON "CanvasRoleAttempt"("work_id", "round", "purpose", "attempt");

-- CreateIndex
CREATE UNIQUE INDEX "CanvasRoleAttempt_provider_scope_provider_reference_key" ON "CanvasRoleAttempt"("provider_scope", "provider_reference");

-- CreateIndex
CREATE INDEX "CanvasRoleHandoff_role_task_run_id_target_work_id_idx" ON "CanvasRoleHandoff"("role_task_run_id", "target_work_id");

-- CreateIndex
CREATE UNIQUE INDEX "CanvasRoleHandoff_source_delivery_id_target_work_id_requirements_revision_key" ON "CanvasRoleHandoff"("source_delivery_id", "target_work_id", "requirements_revision");

-- CreateIndex
CREATE UNIQUE INDEX "CanvasRoleMutationReceipt_owner_user_id_mutation_id_key" ON "CanvasRoleMutationReceipt"("owner_user_id", "mutation_id");

