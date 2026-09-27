CREATE TABLE "AnimationDocument" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "project_id" TEXT NOT NULL,
    "owner_user_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "sequence_json" TEXT NOT NULL,
    "review_status" TEXT NOT NULL DEFAULT 'unsubmitted',
    "review_revision" INTEGER,
    "review_note" TEXT NOT NULL DEFAULT '',
    "game_status" TEXT NOT NULL DEFAULT 'unverified',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);
CREATE INDEX "AnimationDocument_project_id_status_updated_at_id_idx" ON "AnimationDocument"("project_id", "status", "updated_at", "id");
CREATE INDEX "AnimationDocument_owner_user_id_updated_at_idx" ON "AnimationDocument"("owner_user_id", "updated_at");

CREATE TABLE "AnimationRevision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "document_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "sequence_json" TEXT NOT NULL,
    "actor_user_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT 'edit',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "AnimationRevision_document_id_revision_key" ON "AnimationRevision"("document_id", "revision");
CREATE INDEX "AnimationRevision_document_id_created_at_idx" ON "AnimationRevision"("document_id", "created_at");

CREATE TABLE "AnimationFile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "document_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "blob_key" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "AnimationFile_blob_key_key" ON "AnimationFile"("blob_key");
CREATE UNIQUE INDEX "AnimationFile_document_id_role_sha256_key" ON "AnimationFile"("document_id", "role", "sha256");
CREATE INDEX "AnimationFile_project_id_document_id_role_idx" ON "AnimationFile"("project_id", "document_id", "role");
CREATE INDEX "AnimationFile_document_id_created_at_idx" ON "AnimationFile"("document_id", "created_at");

CREATE TABLE "AnimationJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "document_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "actor_user_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "revision" INTEGER NOT NULL,
    "parameters_json" TEXT NOT NULL,
    "parameters_hash" TEXT NOT NULL,
    "stage" TEXT NOT NULL DEFAULT 'queued',
    "error_code" TEXT,
    "error_message" TEXT,
    "result_json" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "lease_token" TEXT,
    "lease_expires_at" DATETIME,
    "heartbeat_at" DATETIME,
    "queue_reserved" BOOLEAN NOT NULL DEFAULT false,
    "reserved_storage_bytes" BIGINT NOT NULL DEFAULT 0,
    "timeout_at" DATETIME NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);
CREATE INDEX "AnimationJob_status_created_at_id_idx" ON "AnimationJob"("status", "created_at", "id");
CREATE INDEX "AnimationJob_document_id_created_at_idx" ON "AnimationJob"("document_id", "created_at");
CREATE INDEX "AnimationJob_project_id_status_idx" ON "AnimationJob"("project_id", "status");
CREATE INDEX "AnimationJob_lease_expires_at_idx" ON "AnimationJob"("lease_expires_at");

CREATE TABLE "AnimationExport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "document_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "mode" TEXT NOT NULL,
    "blob_key" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "entry_count" INTEGER NOT NULL,
    "total_ticks" INTEGER NOT NULL,
    "warnings_json" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "AnimationExport_job_id_key" ON "AnimationExport"("job_id");
CREATE UNIQUE INDEX "AnimationExport_blob_key_key" ON "AnimationExport"("blob_key");
CREATE INDEX "AnimationExport_document_id_revision_created_at_idx" ON "AnimationExport"("document_id", "revision", "created_at");
CREATE INDEX "AnimationExport_project_id_created_at_idx" ON "AnimationExport"("project_id", "created_at");

CREATE TABLE "AnimationRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "actor_user_id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "document_id" TEXT,
    "response_json" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "AnimationRequest_actor_user_id_request_id_key" ON "AnimationRequest"("actor_user_id", "request_id");
CREATE INDEX "AnimationRequest_document_id_created_at_idx" ON "AnimationRequest"("document_id", "created_at");
CREATE INDEX "AnimationRequest_created_at_idx" ON "AnimationRequest"("created_at");

CREATE TABLE "AnimationQueueState" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "active_count" INTEGER NOT NULL DEFAULT 0,
    "reserved_storage_bytes" BIGINT NOT NULL DEFAULT 0,
    "worker_token" TEXT,
    "worker_lease_expires_at" DATETIME,
    "updated_at" DATETIME NOT NULL
);

CREATE TABLE "AnimationUploadState" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "active_count" INTEGER NOT NULL DEFAULT 0,
    "reserved_storage_bytes" BIGINT NOT NULL DEFAULT 0,
    "updated_at" DATETIME NOT NULL
);

CREATE TABLE "AnimationUploadReservation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reserved_bytes" BIGINT NOT NULL,
    "expires_at" DATETIME NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "AnimationUploadReservation_expires_at_idx" ON "AnimationUploadReservation"("expires_at");
