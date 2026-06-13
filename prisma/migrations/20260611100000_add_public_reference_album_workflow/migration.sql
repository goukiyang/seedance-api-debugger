-- Public reference album workflow.
-- Adds a first-stage public folder model and review queue without changing
-- existing personal/project album ownership or historical image references.

ALTER TABLE "ReferenceAlbum" ADD COLUMN "public_folder_id" TEXT;

CREATE TABLE "ReferenceAlbumFolder" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "scope" TEXT NOT NULL DEFAULT 'public',
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'active',
  "created_by" TEXT,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL
);

CREATE TABLE "PublicAlbumSubmission" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "source_album_id" TEXT NOT NULL,
  "target_album_id" TEXT,
  "public_folder_id" TEXT,
  "submitted_by_user_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "submit_note" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "review_note" TEXT,
  "reviewed_by_user_id" TEXT,
  "reviewed_at" DATETIME,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL,
  CONSTRAINT "PublicAlbumSubmission_public_folder_id_fkey" FOREIGN KEY ("public_folder_id") REFERENCES "ReferenceAlbumFolder" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "ReferenceAlbum_public_folder_id_idx" ON "ReferenceAlbum"("public_folder_id");

CREATE INDEX "ReferenceAlbumFolder_scope_idx" ON "ReferenceAlbumFolder"("scope");
CREATE INDEX "ReferenceAlbumFolder_status_idx" ON "ReferenceAlbumFolder"("status");
CREATE INDEX "ReferenceAlbumFolder_sort_order_idx" ON "ReferenceAlbumFolder"("sort_order");

CREATE INDEX "PublicAlbumSubmission_source_album_id_idx" ON "PublicAlbumSubmission"("source_album_id");
CREATE INDEX "PublicAlbumSubmission_target_album_id_idx" ON "PublicAlbumSubmission"("target_album_id");
CREATE INDEX "PublicAlbumSubmission_public_folder_id_idx" ON "PublicAlbumSubmission"("public_folder_id");
CREATE INDEX "PublicAlbumSubmission_submitted_by_user_id_idx" ON "PublicAlbumSubmission"("submitted_by_user_id");
CREATE INDEX "PublicAlbumSubmission_status_idx" ON "PublicAlbumSubmission"("status");
