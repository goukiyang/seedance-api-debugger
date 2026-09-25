-- Additive only: snapshots stay unchanged; access is owner-only for old and new canvases.
ALTER TABLE "CanvasDocument" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CanvasDocument" ADD COLUMN "schema_version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "CanvasDocument" ADD COLUMN "protocol_version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "CanvasDocument" ADD COLUMN "access_scope" TEXT NOT NULL DEFAULT 'private';
ALTER TABLE "CanvasDocument" ADD COLUMN "legacy_document_json" TEXT;

CREATE TABLE "CanvasDocumentRevision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "document_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "schema_version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "document_json" TEXT NOT NULL,
    "active_generation_node_id" TEXT,
    "resource_refs_json" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CanvasDocumentRevision_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "CanvasDocument" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CanvasDocumentRevision_document_id_revision_key" ON "CanvasDocumentRevision"("document_id", "revision");

CREATE TABLE "CanvasDocumentMutation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "actor_user_id" TEXT NOT NULL,
    "mutation_id" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "response_json" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CanvasDocumentMutation_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "CanvasDocument" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CanvasDocumentMutation_actor_user_id_mutation_id_key" ON "CanvasDocumentMutation"("actor_user_id", "mutation_id");
CREATE INDEX "CanvasDocumentMutation_document_id_idx" ON "CanvasDocumentMutation"("document_id");
CREATE INDEX "CanvasDocumentMutation_created_at_idx" ON "CanvasDocumentMutation"("created_at");
CREATE INDEX "CanvasDocument_owner_user_id_project_id_status_updated_at_id_idx" ON "CanvasDocument"("owner_user_id", "project_id", "status", "updated_at", "id");
