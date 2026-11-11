-- Additive only: do not rewrite historical recipes, media state or existing tables.
CREATE TABLE "CharacterFusionCategory" (
 "id" TEXT NOT NULL PRIMARY KEY, "stable_id" TEXT NOT NULL, "scope_key" TEXT NOT NULL,
 "scope" TEXT NOT NULL, "owner_id" TEXT NOT NULL, "definition_json" TEXT NOT NULL,
 "version" TEXT NOT NULL, "enabled" BOOLEAN NOT NULL DEFAULT true,
 "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" DATETIME NOT NULL,
 CONSTRAINT "CharacterFusionCategory_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TABLE "CharacterFusionTerm" (
 "id" TEXT NOT NULL PRIMARY KEY, "stable_id" TEXT NOT NULL, "scope_key" TEXT NOT NULL,
 "scope" TEXT NOT NULL, "owner_id" TEXT NOT NULL, "category_id" TEXT NOT NULL, "category_record_id" TEXT,
 "definition_json" TEXT NOT NULL, "version" TEXT NOT NULL, "enabled" BOOLEAN NOT NULL DEFAULT true,
 "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" DATETIME NOT NULL,
 CONSTRAINT "CharacterFusionTerm_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "CharacterFusionTerm_category_record_id_fkey" FOREIGN KEY ("category_record_id") REFERENCES "CharacterFusionCategory" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TABLE "CharacterFusionWorkspace" (
 "id" TEXT NOT NULL PRIMARY KEY, "owner_id" TEXT NOT NULL, "name" TEXT NOT NULL,
 "state_json" TEXT NOT NULL, "version" INTEGER NOT NULL DEFAULT 1, "archived" BOOLEAN NOT NULL DEFAULT false,
 "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" DATETIME NOT NULL,
 CONSTRAINT "CharacterFusionWorkspace_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TABLE "CharacterFusionResult" (
 "id" TEXT NOT NULL PRIMARY KEY, "workspace_id" TEXT NOT NULL, "row_id" TEXT NOT NULL,
 "position" INTEGER NOT NULL, "version" INTEGER NOT NULL DEFAULT 1, "row_json" TEXT NOT NULL,
 "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" DATETIME NOT NULL,
 CONSTRAINT "CharacterFusionResult_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "CharacterFusionWorkspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TABLE "CharacterFusionOperation" (
 "id" TEXT NOT NULL PRIMARY KEY, "owner_id" TEXT NOT NULL, "op_id" TEXT NOT NULL,
 "workspace_id" TEXT, "target_kind" TEXT NOT NULL, "fingerprint" TEXT NOT NULL,
 "status" TEXT NOT NULL DEFAULT 'committed', "before_version" INTEGER NOT NULL DEFAULT 0,
 "after_version" INTEGER NOT NULL DEFAULT 0, "result_json" TEXT NOT NULL, "undo_json" TEXT,
 "undone_by" TEXT, "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "CharacterFusionOperation_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "CharacterFusionOperation_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "CharacterFusionWorkspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CharacterFusionCategory_scope_key_stable_id_key" ON "CharacterFusionCategory"("scope_key", "stable_id");
CREATE INDEX "CharacterFusionCategory_owner_id_updated_at_idx" ON "CharacterFusionCategory"("owner_id", "updated_at");
CREATE INDEX "CharacterFusionCategory_scope_enabled_idx" ON "CharacterFusionCategory"("scope", "enabled");
CREATE UNIQUE INDEX "CharacterFusionTerm_scope_key_stable_id_key" ON "CharacterFusionTerm"("scope_key", "stable_id");
CREATE INDEX "CharacterFusionTerm_category_id_enabled_idx" ON "CharacterFusionTerm"("category_id", "enabled");
CREATE INDEX "CharacterFusionTerm_owner_id_updated_at_idx" ON "CharacterFusionTerm"("owner_id", "updated_at");
CREATE INDEX "CharacterFusionTerm_scope_enabled_idx" ON "CharacterFusionTerm"("scope", "enabled");
CREATE INDEX "CharacterFusionWorkspace_owner_id_archived_updated_at_idx" ON "CharacterFusionWorkspace"("owner_id", "archived", "updated_at");
CREATE UNIQUE INDEX "CharacterFusionResult_workspace_id_row_id_key" ON "CharacterFusionResult"("workspace_id", "row_id");
CREATE INDEX "CharacterFusionResult_workspace_id_position_idx" ON "CharacterFusionResult"("workspace_id", "position");
CREATE UNIQUE INDEX "CharacterFusionOperation_owner_id_op_id_key" ON "CharacterFusionOperation"("owner_id", "op_id");
CREATE INDEX "CharacterFusionOperation_workspace_id_created_at_idx" ON "CharacterFusionOperation"("workspace_id", "created_at");
CREATE INDEX "CharacterFusionOperation_owner_id_target_kind_created_at_idx" ON "CharacterFusionOperation"("owner_id", "target_kind", "created_at");
