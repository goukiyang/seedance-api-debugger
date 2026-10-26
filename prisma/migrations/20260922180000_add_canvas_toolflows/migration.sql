CREATE TABLE "ToolFlow" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "owner_id" TEXT NOT NULL,
  "project_id" TEXT,
  "name" TEXT NOT NULL,
  "visibility" TEXT NOT NULL DEFAULT 'private',
  "status" TEXT NOT NULL DEFAULT 'draft',
  "version" INTEGER NOT NULL DEFAULT 1,
  "graph_json" TEXT NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ToolFlow_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ToolFlow_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "Project" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "ToolFlowRun" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "flow_id" TEXT NOT NULL,
  "owner_id" TEXT NOT NULL,
  "flow_version" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "current_node_id" TEXT,
  "snapshot_json" TEXT NOT NULL,
  "estimated_credits" REAL,
  "frozen_credits" REAL,
  "actual_credits" REAL,
  "error" TEXT,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at" DATETIME,
  "finished_at" DATETIME,
  "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ToolFlowRun_flow_id_fkey" FOREIGN KEY ("flow_id") REFERENCES "ToolFlow" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ToolFlowRun_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "ToolFlowNodeRun" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "run_id" TEXT NOT NULL,
  "node_id" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "input_asset_ids" TEXT NOT NULL DEFAULT '[]',
  "output_asset_ids" TEXT NOT NULL DEFAULT '[]',
  "selected_asset_ids" TEXT NOT NULL DEFAULT '[]',
  "result_json" TEXT,
  "error" TEXT,
  "started_at" DATETIME,
  "finished_at" DATETIME,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ToolFlowNodeRun_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "ToolFlowRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ToolFlowNodeRun_run_id_node_id_key" ON "ToolFlowNodeRun"("run_id", "node_id");
CREATE INDEX "ToolFlow_owner_id_updated_at_idx" ON "ToolFlow"("owner_id", "updated_at");
CREATE INDEX "ToolFlow_project_id_status_idx" ON "ToolFlow"("project_id", "status");
CREATE INDEX "ToolFlow_visibility_status_idx" ON "ToolFlow"("visibility", "status");
CREATE INDEX "ToolFlowRun_owner_id_created_at_idx" ON "ToolFlowRun"("owner_id", "created_at");
CREATE INDEX "ToolFlowRun_flow_id_flow_version_idx" ON "ToolFlowRun"("flow_id", "flow_version");
CREATE INDEX "ToolFlowRun_status_updated_at_idx" ON "ToolFlowRun"("status", "updated_at");
CREATE INDEX "ToolFlowNodeRun_run_id_status_idx" ON "ToolFlowNodeRun"("run_id", "status");
