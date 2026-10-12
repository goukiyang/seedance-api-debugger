CREATE TABLE "CanvasRoleRunControl" (
  "run_id" TEXT NOT NULL PRIMARY KEY,
  "workflow_id" TEXT NOT NULL,
  "schema" TEXT NOT NULL DEFAULT 'role.collaboration.v2',
  "mode" TEXT NOT NULL DEFAULT 'manual',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "active_grant_id" TEXT,
  "pause_reason" TEXT,
  "current_manifest_event_id" TEXT,
  "acceptance_event_id" TEXT,
  "next_wake_at" DATETIME,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL,
  CONSTRAINT "CanvasRoleRunControl_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "CanvasRoleTaskRun" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "CanvasRoleAuthorization" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "run_id" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "requirements_revision" INTEGER NOT NULL,
  "consent_event_id" TEXT NOT NULL,
  "snapshot_json" TEXT NOT NULL,
  "snapshot_digest" TEXT NOT NULL,
  "granted_by" TEXT NOT NULL,
  "granted_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" DATETIME NOT NULL,
  CONSTRAINT "CanvasRoleAuthorization_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "CanvasRoleTaskRun" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CanvasRoleAuthorization_consent_event_id_fkey" FOREIGN KEY ("consent_event_id") REFERENCES "CanvasRoleEvent" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "CanvasRoleDispatch" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "run_id" TEXT NOT NULL,
  "work_id" TEXT,
  "grant_id" TEXT,
  "attempt_id" TEXT,
  "requirements_revision" INTEGER NOT NULL,
  "lease_epoch" INTEGER NOT NULL DEFAULT 0,
  "action" TEXT NOT NULL,
  "target_key" TEXT NOT NULL,
  "dedupe_key" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'queued',
  "payload_json" TEXT NOT NULL,
  "lease_owner" TEXT,
  "lease_token" TEXT,
  "last_error" TEXT,
  "lease_until" DATETIME,
  "due_at" DATETIME NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL,
  CONSTRAINT "CanvasRoleDispatch_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "CanvasRoleTaskRun" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CanvasRoleDispatch_work_id_fkey" FOREIGN KEY ("work_id") REFERENCES "CanvasRoleWork" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CanvasRoleDispatch_grant_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "CanvasRoleAuthorization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CanvasRoleDispatch_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "CanvasRoleAttempt" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "CanvasRoleQuestion" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "run_id" TEXT NOT NULL,
  "from_work_id" TEXT NOT NULL,
  "target_work_id" TEXT,
  "source_attempt_id" TEXT,
  "requirements_revision" INTEGER NOT NULL,
  "exchange_count" INTEGER NOT NULL DEFAULT 0,
  "no_progress_count" INTEGER NOT NULL DEFAULT 0,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "question_digest" TEXT NOT NULL,
  "input_digest" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',
  "body_json" TEXT NOT NULL,
  "blocking" BOOLEAN NOT NULL DEFAULT true,
  "answer_event_id" TEXT,
  "resolution_event_id" TEXT,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL,
  CONSTRAINT "CanvasRoleQuestion_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "CanvasRoleTaskRun" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CanvasRoleQuestion_from_work_id_fkey" FOREIGN KEY ("from_work_id") REFERENCES "CanvasRoleWork" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CanvasRoleQuestion_target_work_id_fkey" FOREIGN KEY ("target_work_id") REFERENCES "CanvasRoleWork" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CanvasRoleQuestion_source_attempt_id_fkey" FOREIGN KEY ("source_attempt_id") REFERENCES "CanvasRoleAttempt" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "CanvasRoleMediaBinding" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "run_id" TEXT NOT NULL,
  "work_id" TEXT NOT NULL,
  "requirements_revision" INTEGER NOT NULL,
  "batch_ordinal" INTEGER NOT NULL,
  "reserved_points" INTEGER NOT NULL,
  "settlement_applied" BOOLEAN NOT NULL DEFAULT false,
  "settled_points" INTEGER,
  "input_digest" TEXT NOT NULL,
  "context_digest" TEXT NOT NULL,
  "generation_node_id" TEXT NOT NULL,
  "output_slot_id" TEXT NOT NULL,
  "source_kind" TEXT NOT NULL,
  "source_task_id" TEXT NOT NULL,
  "source_request_id" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "fee_state" TEXT NOT NULL,
  "original_refs_json" TEXT NOT NULL DEFAULT '[]',
  "receipt_json" TEXT NOT NULL DEFAULT '{}',
  "next_check_at" DATETIME,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL,
  CONSTRAINT "CanvasRoleMediaBinding_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "CanvasRoleTaskRun" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CanvasRoleMediaBinding_work_id_fkey" FOREIGN KEY ("work_id") REFERENCES "CanvasRoleWork" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "CanvasRoleWorkflowTemplate" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "owner_user_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "current_version" INTEGER NOT NULL DEFAULT 1,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL
);

CREATE TABLE "CanvasRoleWorkflowTemplateVersion" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "template_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "schema" TEXT NOT NULL DEFAULT 'role.workflow-template.v2',
  "content_digest" TEXT NOT NULL,
  "snapshot_json" TEXT NOT NULL,
  "provenance_json" TEXT NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CanvasRoleWorkflowTemplateVersion_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "CanvasRoleWorkflowTemplate" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "CanvasRoleRunControl_workflow_id_updated_at_run_id_idx" ON "CanvasRoleRunControl"("workflow_id", "updated_at", "run_id");
CREATE INDEX "CanvasRoleRunControl_mode_next_wake_at_run_id_idx" ON "CanvasRoleRunControl"("mode", "next_wake_at", "run_id");
CREATE UNIQUE INDEX "CanvasRoleAuthorization_consent_event_id_key" ON "CanvasRoleAuthorization"("consent_event_id");
CREATE UNIQUE INDEX "CanvasRoleAuthorization_run_id_sequence_key" ON "CanvasRoleAuthorization"("run_id", "sequence");
CREATE UNIQUE INDEX "CanvasRoleDispatch_attempt_id_key" ON "CanvasRoleDispatch"("attempt_id");
CREATE UNIQUE INDEX "CanvasRoleDispatch_run_id_dedupe_key_key" ON "CanvasRoleDispatch"("run_id", "dedupe_key");
CREATE INDEX "CanvasRoleDispatch_state_due_at_id_idx" ON "CanvasRoleDispatch"("state", "due_at", "id");
CREATE INDEX "CanvasRoleDispatch_run_id_state_requirements_revision_idx" ON "CanvasRoleDispatch"("run_id", "state", "requirements_revision");
CREATE UNIQUE INDEX "CanvasRoleQuestion_run_id_requirements_revision_from_work_id_input_digest_question_digest_key" ON "CanvasRoleQuestion"("run_id", "requirements_revision", "from_work_id", "input_digest", "question_digest");
CREATE INDEX "CanvasRoleQuestion_run_id_status_updated_at_id_idx" ON "CanvasRoleQuestion"("run_id", "status", "updated_at", "id");
CREATE INDEX "CanvasRoleQuestion_target_work_id_status_updated_at_id_idx" ON "CanvasRoleQuestion"("target_work_id", "status", "updated_at", "id");
CREATE UNIQUE INDEX "CanvasRoleMediaBinding_source_kind_source_task_id_key" ON "CanvasRoleMediaBinding"("source_kind", "source_task_id");
CREATE UNIQUE INDEX "CanvasRoleMediaBinding_work_id_source_request_id_batch_ordinal_key" ON "CanvasRoleMediaBinding"("work_id", "source_request_id", "batch_ordinal");
CREATE INDEX "CanvasRoleMediaBinding_run_id_state_updated_at_id_idx" ON "CanvasRoleMediaBinding"("run_id", "state", "updated_at", "id");
CREATE INDEX "CanvasRoleMediaBinding_state_next_check_at_id_idx" ON "CanvasRoleMediaBinding"("state", "next_check_at", "id");
CREATE INDEX "CanvasRoleWorkflowTemplate_owner_user_id_status_updated_at_id_idx" ON "CanvasRoleWorkflowTemplate"("owner_user_id", "status", "updated_at", "id");
CREATE UNIQUE INDEX "CanvasRoleWorkflowTemplateVersion_template_id_version_key" ON "CanvasRoleWorkflowTemplateVersion"("template_id", "version");
