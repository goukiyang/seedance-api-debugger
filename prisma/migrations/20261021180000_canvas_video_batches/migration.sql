-- Additive only: no existing document/task/ledger rows are rewritten.
CREATE TABLE "CanvasVideoBatch" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "owner_user_id" TEXT NOT NULL,
  "document_id" TEXT NOT NULL,
  "node_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "video_card_id" TEXT,
  "video_branch_id" TEXT,
  "client_request_id" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "count" INTEGER NOT NULL CHECK ("count" IN (2, 4)),
  "contract_version" INTEGER NOT NULL DEFAULT 1 CHECK ("contract_version" = 1),
  "frozen_input_json" TEXT NOT NULL,
  "authorized_total" INTEGER NOT NULL CHECK ("authorized_total" >= 0),
  "admitted_total" INTEGER NOT NULL DEFAULT 0 CHECK ("admitted_total" >= 0 AND "admitted_total" <= "authorized_total"),
  "active_node_key" TEXT,
  "state" TEXT NOT NULL DEFAULT 'prepared',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "operations_json" TEXT NOT NULL DEFAULT '{}',
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL
);
CREATE TABLE "CanvasVideoBatchChild" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "batch_id" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL CHECK ("ordinal" BETWEEN 1 AND 4),
  "request_id" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "business_fingerprint" TEXT NOT NULL,
  "route_fingerprint" TEXT NOT NULL,
  "frozen_input_json" TEXT NOT NULL,
  "authorized_maximum" INTEGER NOT NULL CHECK ("authorized_maximum" >= 0),
  "quote_revision" TEXT,
  "quote_token" TEXT,
  "quote_expires_at" DATETIME NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'prepared',
  "task_id" TEXT,
  "admitted_amount" INTEGER NOT NULL DEFAULT 0 CHECK ("admitted_amount" >= 0 AND "admitted_amount" <= "authorized_maximum"),
  "rejection_receipt" TEXT,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL,
  CONSTRAINT "CanvasVideoBatchChild_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "CanvasVideoBatch" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CanvasVideoBatch_active_node_key_key" ON "CanvasVideoBatch"("active_node_key");
CREATE UNIQUE INDEX "CanvasVideoBatch_owner_user_id_client_request_id_key" ON "CanvasVideoBatch"("owner_user_id", "client_request_id");
CREATE INDEX "CanvasVideoBatch_owner_user_id_document_id_node_id_created_at_id_idx" ON "CanvasVideoBatch"("owner_user_id", "document_id", "node_id", "created_at", "id");
CREATE INDEX "CanvasVideoBatch_document_id_idx" ON "CanvasVideoBatch"("document_id");
CREATE UNIQUE INDEX "CanvasVideoBatchChild_request_id_key" ON "CanvasVideoBatchChild"("request_id");
CREATE UNIQUE INDEX "CanvasVideoBatchChild_idempotency_key_key" ON "CanvasVideoBatchChild"("idempotency_key");
CREATE UNIQUE INDEX "CanvasVideoBatchChild_task_id_key" ON "CanvasVideoBatchChild"("task_id");
CREATE UNIQUE INDEX "CanvasVideoBatchChild_batch_id_ordinal_key" ON "CanvasVideoBatchChild"("batch_id", "ordinal");
CREATE INDEX "CanvasVideoBatchChild_batch_id_state_idx" ON "CanvasVideoBatchChild"("batch_id", "state");
