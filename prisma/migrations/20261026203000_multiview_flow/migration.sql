ALTER TABLE "MultiviewWork" ADD COLUMN "source_id" TEXT;
ALTER TABLE "MultiviewWork" ADD COLUMN "save_state" TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE "MultiviewWork" ADD COLUMN "write_epoch" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX "MultiviewWork_owner_id_source_id_idx" ON "MultiviewWork"("owner_id", "source_id");

CREATE TABLE "MultiviewSource" (
  "id" TEXT NOT NULL PRIMARY KEY, "owner_id" TEXT NOT NULL, "origin_task_id" TEXT NOT NULL,
  "source_version" TEXT NOT NULL, "info_json" TEXT NOT NULL, "file_path" TEXT NOT NULL,
  "file_sha256" TEXT NOT NULL, "file_bytes" INTEGER NOT NULL,
  "can_reshare" BOOLEAN NOT NULL DEFAULT false, "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "MultiviewSource_owner_id_created_at_idx" ON "MultiviewSource"("owner_id", "created_at");
CREATE TABLE "MultiviewShare" (
  "id" TEXT NOT NULL PRIMARY KEY, "owner_id" TEXT NOT NULL, "work_id" TEXT NOT NULL,
  "revision" INTEGER NOT NULL, "source_task_id" TEXT NOT NULL, "source_id" TEXT,
  "source_version" TEXT NOT NULL, "title" TEXT NOT NULL, "recipe_json" TEXT NOT NULL,
  "info_json" TEXT NOT NULL, "manifest_json" TEXT NOT NULL, "revoked_at" DATETIME,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "MultiviewShare_owner_id_work_id_revision_idx" ON "MultiviewShare"("owner_id", "work_id", "revision");
CREATE TABLE "MultiviewShareRecipient" (
  "id" TEXT NOT NULL PRIMARY KEY, "share_id" TEXT NOT NULL, "user_id" TEXT NOT NULL,
  "generation" TEXT NOT NULL, "revoked_at" DATETIME, "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MultiviewShareRecipient_share_id_fkey" FOREIGN KEY ("share_id") REFERENCES "MultiviewShare"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "MultiviewShareRecipient_share_id_user_id_key" ON "MultiviewShareRecipient"("share_id", "user_id");
CREATE INDEX "MultiviewShareRecipient_user_id_revoked_at_idx" ON "MultiviewShareRecipient"("user_id", "revoked_at");
CREATE TABLE "MultiviewShareMutation" (
  "id" TEXT NOT NULL PRIMARY KEY, "actor_id" TEXT NOT NULL, "mutation_id" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL, "request_json" TEXT NOT NULL, "action" TEXT NOT NULL, "state" TEXT NOT NULL,
  "receipt_json" TEXT, "staging_path" TEXT, "attempts" INTEGER NOT NULL DEFAULT 0,
  "lease_until" DATETIME, "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "MultiviewShareMutation_actor_id_mutation_id_key" ON "MultiviewShareMutation"("actor_id", "mutation_id");
CREATE INDEX "MultiviewShareMutation_state_updated_at_idx" ON "MultiviewShareMutation"("state", "updated_at");

-- Old clients can still query their durable receipts. Old writers cannot
-- create new intents or overwrite recipes using the pre-flow contract.
CREATE TRIGGER "multiview_flow_insert_writer" BEFORE INSERT ON "MultiviewWork"
WHEN NEW.schema_version < 2
BEGIN SELECT RAISE(ABORT, 'MULTIVIEW_FLOW_WRITER_REQUIRED'); END;
CREATE TRIGGER "multiview_flow_update_writer" BEFORE UPDATE ON "MultiviewWork"
WHEN NEW.revision != OLD.revision AND (NEW.schema_version < 2 OR NEW.write_epoch <= OLD.write_epoch)
BEGIN SELECT RAISE(ABORT, 'MULTIVIEW_FLOW_WRITER_REQUIRED'); END;
