-- AlterTable
ALTER TABLE "Project" ADD COLUMN "work_audience" TEXT;

-- CreateTable
CREATE TABLE "Work" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source_kind" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "output_role" TEXT NOT NULL DEFAULT 'output',
    "author_id" TEXT NOT NULL,
    "project_id" TEXT,
    "title" TEXT NOT NULL,
    "medium" TEXT NOT NULL,
    "current_version_id" TEXT,
    "audience" TEXT NOT NULL DEFAULT 'source',
    "discoverable" BOOLEAN NOT NULL DEFAULT true,
    "withdrawn_at" DATETIME,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "completed_at" DATETIME NOT NULL,
    "admitted_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WorkMediaVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "work_id" TEXT NOT NULL,
    "source_revision" TEXT NOT NULL,
    "policy_id" TEXT,
    "asset_id" TEXT,
    "video_task_id" TEXT,
    "content_hash" TEXT,
    "source_url" TEXT,
    "source_updated_at" DATETIME,
    "width" INTEGER,
    "height" INTEGER,
    "duration" REAL,
    "thumbnail_url" TEXT,
    "preview_url" TEXT,
    "preview_status" TEXT NOT NULL DEFAULT 'pending',
    "preview_hash" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkMediaVersion_work_id_fkey" FOREIGN KEY ("work_id") REFERENCES "Work" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WorkSourcePolicy" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source_kind" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "operation_id" TEXT NOT NULL DEFAULT 'initial',
    "owner_id" TEXT NOT NULL,
    "project_id" TEXT,
    "audience" TEXT NOT NULL,
    "captured_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "WorkRegistrationJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source_kind" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "source_revision" TEXT NOT NULL,
    "source_updated_at" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "run_after" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_token" TEXT,
    "lease_until" DATETIME,
    "error_code" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WorkDiscoveryCheckpoint" (
    "source_kind" TEXT NOT NULL PRIMARY KEY,
    "cursor_at" DATETIME,
    "cursor_id" TEXT,
    "upper_at" DATETIME,
    "cycles" INTEGER NOT NULL DEFAULT 0,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WorkPersonalState" (
    "owner_id" TEXT NOT NULL,
    "work_id" TEXT NOT NULL,
    "liked" BOOLEAN NOT NULL DEFAULT false,
    "favorited" BOOLEAN NOT NULL DEFAULT false,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,

    PRIMARY KEY ("owner_id", "work_id"),
    CONSTRAINT "WorkPersonalState_work_id_fkey" FOREIGN KEY ("work_id") REFERENCES "Work" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WorkCollection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "owner_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "removed_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WorkCollectionItem" (
    "collection_id" TEXT NOT NULL,
    "work_id" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("collection_id", "work_id"),
    CONSTRAINT "WorkCollectionItem_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "WorkCollection" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "WorkCollectionItem_work_id_fkey" FOREIGN KEY ("work_id") REFERENCES "Work" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WorkOperation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "owner_id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "result_json" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "Work_discoverable_completed_at_id_idx" ON "Work"("discoverable", "completed_at", "id");

-- CreateIndex
CREATE INDEX "Work_author_id_completed_at_id_idx" ON "Work"("author_id", "completed_at", "id");

-- CreateIndex
CREATE INDEX "Work_project_id_completed_at_id_idx" ON "Work"("project_id", "completed_at", "id");

-- CreateIndex
CREATE INDEX "Work_admitted_at_idx" ON "Work"("admitted_at");

-- CreateIndex
CREATE UNIQUE INDEX "Work_source_kind_source_id_output_role_key" ON "Work"("source_kind", "source_id", "output_role");

-- CreateIndex
CREATE INDEX "WorkMediaVersion_asset_id_idx" ON "WorkMediaVersion"("asset_id");

-- CreateIndex
CREATE INDEX "WorkMediaVersion_preview_status_created_at_id_idx" ON "WorkMediaVersion"("preview_status", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WorkMediaVersion_work_id_source_revision_key" ON "WorkMediaVersion"("work_id", "source_revision");

-- CreateIndex
CREATE INDEX "WorkSourcePolicy_project_id_captured_at_idx" ON "WorkSourcePolicy"("project_id", "captured_at");

-- CreateIndex
CREATE UNIQUE INDEX "WorkSourcePolicy_source_kind_source_id_operation_id_key" ON "WorkSourcePolicy"("source_kind", "source_id", "operation_id");

-- CreateIndex
CREATE INDEX "WorkRegistrationJob_source_kind_status_run_after_id_idx" ON "WorkRegistrationJob"("source_kind", "status", "run_after", "id");

-- CreateIndex
CREATE INDEX "WorkRegistrationJob_status_lease_until_idx" ON "WorkRegistrationJob"("status", "lease_until");

-- CreateIndex
CREATE UNIQUE INDEX "WorkRegistrationJob_source_kind_source_id_source_revision_key" ON "WorkRegistrationJob"("source_kind", "source_id", "source_revision");

-- CreateIndex
CREATE INDEX "WorkPersonalState_owner_id_favorited_work_id_idx" ON "WorkPersonalState"("owner_id", "favorited", "work_id");

-- CreateIndex
CREATE INDEX "WorkPersonalState_owner_id_hidden_work_id_idx" ON "WorkPersonalState"("owner_id", "hidden", "work_id");

-- CreateIndex
CREATE INDEX "WorkPersonalState_work_id_liked_idx" ON "WorkPersonalState"("work_id", "liked");

-- CreateIndex
CREATE INDEX "WorkCollection_owner_id_removed_at_created_at_id_idx" ON "WorkCollection"("owner_id", "removed_at", "created_at", "id");

-- CreateIndex
CREATE INDEX "WorkCollectionItem_work_id_collection_id_idx" ON "WorkCollectionItem"("work_id", "collection_id");

-- CreateIndex
CREATE INDEX "WorkOperation_owner_id_created_at_idx" ON "WorkOperation"("owner_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "WorkOperation_owner_id_request_id_key" ON "WorkOperation"("owner_id", "request_id");

-- CreateIndex
CREATE INDEX "VideoTask_updated_at_id_idx" ON "VideoTask"("updated_at", "id");

-- CreateIndex
CREATE INDEX "ImageStudioTask_updated_at_id_idx" ON "ImageStudioTask"("updated_at", "id");

-- CreateIndex
CREATE INDEX "MultiviewWork_updated_at_id_idx" ON "MultiviewWork"("updated_at", "id");

