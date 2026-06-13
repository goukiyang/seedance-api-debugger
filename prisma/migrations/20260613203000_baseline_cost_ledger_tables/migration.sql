-- Baseline migration for cost ledger tables that already exist in the
-- current SQLite database and Prisma schema. Use IF NOT EXISTS so existing
-- deployments can mark this migration without rebuilding historical data.

CREATE TABLE IF NOT EXISTS "ProviderApiRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "task_id" TEXT,
    "user_id" TEXT,
    "project_id" TEXT,
    "provider_name" TEXT NOT NULL,
    "provider_account_id" TEXT,
    "endpoint" TEXT NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'POST',
    "idempotency_key" TEXT,
    "provider_request_id" TEXT,
    "provider_task_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "http_status" INTEGER,
    "error_code" TEXT,
    "error_message" TEXT,
    "request_hash" TEXT,
    "response_summary_json" TEXT,
    "started_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProviderApiRequest_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "VideoTask" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ProviderApiRequest_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ProviderApiRequest_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "Project" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "ProviderApiRequest_task_id_idx" ON "ProviderApiRequest"("task_id");
CREATE INDEX IF NOT EXISTS "ProviderApiRequest_user_id_idx" ON "ProviderApiRequest"("user_id");
CREATE INDEX IF NOT EXISTS "ProviderApiRequest_project_id_idx" ON "ProviderApiRequest"("project_id");
CREATE INDEX IF NOT EXISTS "ProviderApiRequest_provider_name_idx" ON "ProviderApiRequest"("provider_name");
CREATE INDEX IF NOT EXISTS "ProviderApiRequest_provider_task_id_idx" ON "ProviderApiRequest"("provider_task_id");
CREATE INDEX IF NOT EXISTS "ProviderApiRequest_status_idx" ON "ProviderApiRequest"("status");
CREATE INDEX IF NOT EXISTS "ProviderApiRequest_created_at_idx" ON "ProviderApiRequest"("created_at");

CREATE TABLE IF NOT EXISTS "CostLedger" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source_type" TEXT NOT NULL,
    "source_id" TEXT,
    "task_id" TEXT,
    "user_id" TEXT,
    "project_id" TEXT,
    "provider_request_id" TEXT,
    "provider_name" TEXT NOT NULL,
    "provider_account_id" TEXT,
    "provider_task_id" TEXT,
    "event_type" TEXT NOT NULL,
    "amount_minor" INTEGER,
    "currency" TEXT,
    "amount_micros" INTEGER,
    "usage_quantity" REAL,
    "usage_unit" TEXT,
    "cost_source" TEXT NOT NULL,
    "confidence" TEXT NOT NULL,
    "pricing_rule_id" TEXT,
    "pricing_snapshot" TEXT,
    "official_charge_id" TEXT,
    "reason" TEXT,
    "idempotency_key" TEXT,
    "occurred_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CostLedger_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "VideoTask" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CostLedger_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CostLedger_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "Project" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CostLedger_provider_request_id_fkey" FOREIGN KEY ("provider_request_id") REFERENCES "ProviderApiRequest" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "CostLedger_idempotency_key_key" ON "CostLedger"("idempotency_key");
CREATE INDEX IF NOT EXISTS "CostLedger_source_type_source_id_idx" ON "CostLedger"("source_type", "source_id");
CREATE INDEX IF NOT EXISTS "CostLedger_task_id_idx" ON "CostLedger"("task_id");
CREATE INDEX IF NOT EXISTS "CostLedger_user_id_idx" ON "CostLedger"("user_id");
CREATE INDEX IF NOT EXISTS "CostLedger_project_id_idx" ON "CostLedger"("project_id");
CREATE INDEX IF NOT EXISTS "CostLedger_provider_request_id_idx" ON "CostLedger"("provider_request_id");
CREATE INDEX IF NOT EXISTS "CostLedger_provider_name_idx" ON "CostLedger"("provider_name");
CREATE INDEX IF NOT EXISTS "CostLedger_provider_task_id_idx" ON "CostLedger"("provider_task_id");
CREATE INDEX IF NOT EXISTS "CostLedger_event_type_idx" ON "CostLedger"("event_type");
CREATE INDEX IF NOT EXISTS "CostLedger_confidence_idx" ON "CostLedger"("confidence");
CREATE INDEX IF NOT EXISTS "CostLedger_occurred_at_idx" ON "CostLedger"("occurred_at");
CREATE INDEX IF NOT EXISTS "CostLedger_created_at_idx" ON "CostLedger"("created_at");

CREATE TABLE IF NOT EXISTS "CostAllocation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ledger_id" TEXT NOT NULL,
    "allocation_type" TEXT NOT NULL,
    "allocation_id" TEXT NOT NULL,
    "task_id" TEXT,
    "user_id" TEXT,
    "project_id" TEXT,
    "amount_minor" INTEGER,
    "amount_micros" INTEGER,
    "currency" TEXT,
    "usage_quantity" REAL,
    "usage_unit" TEXT,
    "reason" TEXT,
    "rule_id" TEXT,
    "created_by" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CostAllocation_ledger_id_fkey" FOREIGN KEY ("ledger_id") REFERENCES "CostLedger" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CostAllocation_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "VideoTask" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CostAllocation_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CostAllocation_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "Project" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "CostAllocation_ledger_id_idx" ON "CostAllocation"("ledger_id");
CREATE INDEX IF NOT EXISTS "CostAllocation_allocation_type_allocation_id_idx" ON "CostAllocation"("allocation_type", "allocation_id");
CREATE INDEX IF NOT EXISTS "CostAllocation_task_id_idx" ON "CostAllocation"("task_id");
CREATE INDEX IF NOT EXISTS "CostAllocation_user_id_idx" ON "CostAllocation"("user_id");
CREATE INDEX IF NOT EXISTS "CostAllocation_project_id_idx" ON "CostAllocation"("project_id");
CREATE INDEX IF NOT EXISTS "CostAllocation_created_at_idx" ON "CostAllocation"("created_at");

CREATE TABLE IF NOT EXISTS "ProviderAccountSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider_name" TEXT NOT NULL DEFAULT 'seedance',
    "provider_account_id" TEXT,
    "balance_kind" TEXT NOT NULL DEFAULT 'prepaid',
    "amount_decimal" TEXT,
    "amount_minor" INTEGER,
    "currency" TEXT,
    "quota_amount" REAL,
    "quota_unit" TEXT,
    "source" TEXT NOT NULL DEFAULT 'provider_api',
    "status" TEXT NOT NULL DEFAULT 'synced',
    "raw_snapshot" TEXT,
    "note" TEXT,
    "error_message" TEXT,
    "fetched_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "ProviderAccountSnapshot_provider_name_idx" ON "ProviderAccountSnapshot"("provider_name");
CREATE INDEX IF NOT EXISTS "ProviderAccountSnapshot_provider_account_id_idx" ON "ProviderAccountSnapshot"("provider_account_id");
CREATE INDEX IF NOT EXISTS "ProviderAccountSnapshot_status_idx" ON "ProviderAccountSnapshot"("status");
CREATE INDEX IF NOT EXISTS "ProviderAccountSnapshot_source_idx" ON "ProviderAccountSnapshot"("source");
CREATE INDEX IF NOT EXISTS "ProviderAccountSnapshot_fetched_at_idx" ON "ProviderAccountSnapshot"("fetched_at");
CREATE INDEX IF NOT EXISTS "ProviderAccountSnapshot_created_at_idx" ON "ProviderAccountSnapshot"("created_at");
