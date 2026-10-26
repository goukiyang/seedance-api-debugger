-- Additive only. Apply under the project's backed-up deployment transaction;
-- never replace existing application tables or use db push in production.
CREATE TABLE "MultiviewWork" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "owner_id" TEXT NOT NULL,
  "source_task_id" TEXT NOT NULL,
  "project_id" TEXT,
  "video_card_id" TEXT,
  "base_key" TEXT,
  "branch_key" TEXT,
  "parent_work_id" TEXT,
  "title" TEXT NOT NULL DEFAULT '3D多视图作品',
  "schema_version" INTEGER NOT NULL DEFAULT 1,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "source_version" TEXT,
  "source_info_json" TEXT,
  "draft_revision" INTEGER NOT NULL DEFAULT 0,
  "recipe_json" TEXT,
  "recipe_hash" TEXT,
  "ready_revision" INTEGER,
  "ready_recipe_json" TEXT,
  "ready_manifest_json" TEXT,
  "status" TEXT NOT NULL DEFAULT 'waiting_source',
  "removed_at" DATETIME,
  "lease_token" TEXT,
  "lease_until" DATETIME,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_error" TEXT,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "MultiviewWork_owner_id_source_task_id_base_key_key" ON "MultiviewWork"("owner_id", "source_task_id", "base_key");
CREATE UNIQUE INDEX "MultiviewWork_owner_id_branch_key_key" ON "MultiviewWork"("owner_id", "branch_key");
CREATE INDEX "MultiviewWork_owner_id_removed_at_updated_at_id_idx" ON "MultiviewWork"("owner_id", "removed_at", "updated_at", "id");
CREATE INDEX "MultiviewWork_status_next_attempt_at_lease_until_idx" ON "MultiviewWork"("status", "next_attempt_at", "lease_until");

CREATE TABLE "MultiviewWorkMutation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "actor_id" TEXT NOT NULL,
  "mutation_id" TEXT NOT NULL,
  "work_id" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "base_revision" INTEGER,
  "action" TEXT NOT NULL,
  "receipt_json" TEXT NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MultiviewWorkMutation_work_id_fkey" FOREIGN KEY ("work_id") REFERENCES "MultiviewWork"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "MultiviewWorkMutation_actor_id_mutation_id_key" ON "MultiviewWorkMutation"("actor_id", "mutation_id");
CREATE INDEX "MultiviewWorkMutation_work_id_created_at_idx" ON "MultiviewWorkMutation"("work_id", "created_at");
