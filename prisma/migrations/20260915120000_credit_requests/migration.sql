CREATE TABLE "CreditRequest" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "user_id" TEXT NOT NULL,
  "approver_id" TEXT NOT NULL,
  "pending_key" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "purpose" TEXT NOT NULL,
  "available_at_submit" REAL NOT NULL,
  "amount" INTEGER,
  "decision_reason" TEXT,
  "nonce" TEXT NOT NULL,
  "proposed_amount" INTEGER,
  "confirmation_nonce" TEXT,
  "confirmation_until" DATETIME,
  "applicant_open_id" TEXT NOT NULL,
  "approver_open_id" TEXT NOT NULL,
  "tenant_key" TEXT NOT NULL,
  "app_id" TEXT NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decided_at" DATETIME,
  "updated_at" DATETIME NOT NULL,
  CONSTRAINT "CreditRequest_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CreditRequest_approver_id_fkey" FOREIGN KEY ("approver_id") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CreditRequest_pending_key_key" ON "CreditRequest"("pending_key");
CREATE INDEX "CreditRequest_user_id_created_at_idx" ON "CreditRequest"("user_id", "created_at");
CREATE INDEX "CreditRequest_approver_id_status_created_at_idx" ON "CreditRequest"("approver_id", "status", "created_at");
CREATE TABLE "CreditRequestDelivery" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "request_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "payload_json" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "next_attempt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lease_until" DATETIME,
  "lease_token" TEXT,
  "error_code" TEXT,
  "sent_at" DATETIME,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CreditRequestDelivery_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "CreditRequest" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CreditRequestDelivery_request_id_kind_key" ON "CreditRequestDelivery"("request_id", "kind");
CREATE INDEX "CreditRequestDelivery_status_next_attempt_idx" ON "CreditRequestDelivery"("status", "next_attempt");
