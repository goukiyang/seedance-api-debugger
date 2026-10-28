-- CreateTable
CREATE TABLE "LocalImageCredential" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "profile_ids_json" TEXT NOT NULL,
    "project_id" TEXT,
    "expires_at" DATETIME NOT NULL,
    "revoked_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "LocalImageMachine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "session_id" TEXT,
    "state" TEXT NOT NULL DEFAULT 'offline',
    "capabilities_json" TEXT NOT NULL DEFAULT '[]',
    "last_seen" DATETIME,
    "sequence" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "LocalImageRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "owner_id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "profile_id" TEXT NOT NULL,
    "project_id" TEXT,
    "assignment_json" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "LocalImageAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "task_id" TEXT NOT NULL,
    "worker_id" TEXT NOT NULL,
    "active_worker_id" TEXT,
    "session_id" TEXT NOT NULL,
    "epoch" INTEGER NOT NULL DEFAULT 1,
    "phase" TEXT NOT NULL,
    "start_granted" BOOLEAN NOT NULL DEFAULT false,
    "lease_until" DATETIME NOT NULL,
    "heartbeat_sequence" INTEGER NOT NULL DEFAULT 0,
    "event_sequence" INTEGER NOT NULL DEFAULT 0,
    "prompt_id" TEXT,
    "terminal_receipt_json" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "LocalImageOperation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scope" TEXT NOT NULL,
    "operation_id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "receipt_json" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "LocalImageOutput" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "attempt_id" TEXT NOT NULL,
    "output_id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "raw_sha256" TEXT NOT NULL,
    "delivered_sha256" TEXT NOT NULL,
    "file_path" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Additive only: retain the existing task table, rows and indexes.
ALTER TABLE "ImageStudioTask" ADD COLUMN "execution_backend" TEXT NOT NULL DEFAULT 'cloud';

-- CreateIndex
CREATE UNIQUE INDEX "LocalImageRequest_task_id_key" ON "LocalImageRequest"("task_id");

-- CreateIndex
CREATE UNIQUE INDEX "LocalImageRequest_owner_id_request_id_key" ON "LocalImageRequest"("owner_id", "request_id");

-- CreateIndex
CREATE UNIQUE INDEX "LocalImageAttempt_task_id_key" ON "LocalImageAttempt"("task_id");

-- CreateIndex
CREATE UNIQUE INDEX "LocalImageAttempt_active_worker_id_key" ON "LocalImageAttempt"("active_worker_id");

-- CreateIndex
CREATE UNIQUE INDEX "LocalImageOperation_scope_operation_id_key" ON "LocalImageOperation"("scope", "operation_id");

-- CreateIndex
CREATE UNIQUE INDEX "LocalImageOutput_asset_id_key" ON "LocalImageOutput"("asset_id");

-- CreateIndex
CREATE UNIQUE INDEX "LocalImageOutput_attempt_id_output_id_key" ON "LocalImageOutput"("attempt_id", "output_id");
