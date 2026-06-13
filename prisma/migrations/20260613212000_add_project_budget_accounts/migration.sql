-- Project budget accounts and ledgers for public-project billing.
CREATE TABLE "ProjectBudgetAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "project_id" TEXT NOT NULL,
    "budget_credits" REAL NOT NULL DEFAULT 0,
    "used_credits" REAL NOT NULL DEFAULT 0,
    "frozen_credits" REAL NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'credits',
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_by" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProjectBudgetAccount_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "ProjectBudgetLedger" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "project_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amount" REAL NOT NULL,
    "budget_before" REAL NOT NULL,
    "budget_after" REAL NOT NULL,
    "used_before" REAL NOT NULL,
    "used_after" REAL NOT NULL,
    "frozen_before" REAL NOT NULL,
    "frozen_after" REAL NOT NULL,
    "related_task_id" TEXT,
    "operator_id" TEXT,
    "reason" TEXT,
    "idempotency_key" TEXT,
    "metadata_json" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProjectBudgetLedger_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProjectBudgetLedger_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ProjectBudgetAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ProjectBudgetAccount_project_id_key" ON "ProjectBudgetAccount" ("project_id");
CREATE INDEX "ProjectBudgetAccount_project_id_idx" ON "ProjectBudgetAccount" ("project_id");
CREATE INDEX "ProjectBudgetAccount_status_idx" ON "ProjectBudgetAccount" ("status");

CREATE INDEX "ProjectBudgetLedger_project_id_idx" ON "ProjectBudgetLedger" ("project_id");
CREATE INDEX "ProjectBudgetLedger_account_id_idx" ON "ProjectBudgetLedger" ("account_id");
CREATE INDEX "ProjectBudgetLedger_type_idx" ON "ProjectBudgetLedger" ("type");
CREATE INDEX "ProjectBudgetLedger_related_task_id_idx" ON "ProjectBudgetLedger" ("related_task_id");
CREATE INDEX "ProjectBudgetLedger_operator_id_idx" ON "ProjectBudgetLedger" ("operator_id");
CREATE INDEX "ProjectBudgetLedger_created_at_idx" ON "ProjectBudgetLedger" ("created_at");
CREATE UNIQUE INDEX "ProjectBudgetLedger_idempotency_key_key" ON "ProjectBudgetLedger" ("idempotency_key");
CREATE INDEX "ProjectBudgetLedger_idempotency_key_idx" ON "ProjectBudgetLedger" ("idempotency_key");
