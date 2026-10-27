-- Additive only. No historical financial rows are changed or imported.
-- Execute only after all writers/readers use the compatible program. Never roll
-- back to an unaware writer once holds exist; program rollback keeps this DB.
BEGIN IMMEDIATE;
ALTER TABLE "VideoTask" ADD COLUMN "state_version" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "VideoTask" ADD COLUMN "last_provider_refresh_at" DATETIME;
CREATE TABLE "CreditHold" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "business_type" TEXT NOT NULL,
  "business_id" TEXT NOT NULL,
  "payer_type" TEXT NOT NULL,
  "payer_id" TEXT NOT NULL,
  "operator_id" TEXT,
  "amount" REAL NOT NULL CHECK (amount >= 0),
  "freeze_snapshot" TEXT NOT NULL,
  "opening_receipt" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'held' CHECK (state IN ('held','captured','released','expired_closed','review')),
  "actual_cost" REAL NOT NULL DEFAULT 0,
  "refunded_amount" REAL NOT NULL DEFAULT 0,
  "expired_closed_amount" REAL NOT NULL DEFAULT 0,
  "settlement_receipt" TEXT,
  "review_reason" TEXT,
  "version" INTEGER NOT NULL DEFAULT 0,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL,
  "settled_at" DATETIME,
  "review_notified_at" DATETIME
);
CREATE UNIQUE INDEX "CreditHold_business_type_business_id_key" ON "CreditHold"("business_type","business_id");
CREATE INDEX "CreditHold_payer_type_payer_id_state_idx" ON "CreditHold"("payer_type","payer_id","state");
CREATE INDEX "CreditHold_state_created_at_idx" ON "CreditHold"("state","created_at");
-- Duplicate non-null keys deliberately abort the transaction. Do not dedupe or
-- rewrite a ledger to make migration pass: report the duplicate keys to the lead.
CREATE UNIQUE INDEX "CreditLedger_idempotency_key_key" ON "CreditLedger"("idempotency_key");
DROP INDEX IF EXISTS "CreditLedger_idempotency_key_idx";
CREATE TRIGGER "audit_hold_video_writer_guard" BEFORE UPDATE OF local_status ON VideoTask
WHEN NEW.local_status <> OLD.local_status
  AND EXISTS (SELECT 1 FROM CreditHold WHERE business_type IN ('video','enhance') AND business_id=OLD.id)
  AND (NEW.state_version <> OLD.state_version + 1 OR OLD.local_status IN ('succeeded','failed','cancelled'))
BEGIN SELECT RAISE(ABORT,'AUD_BILLING_INCOMPATIBLE_VIDEO_WRITER'); END;
CREATE TRIGGER "audit_hold_personal_writer_guard" BEFORE INSERT ON CreditLedger
WHEN NEW.type IN ('task_freeze','task_success_deduct','task_failed_refund','task_billing_release')
  AND NOT EXISTS (SELECT 1 FROM CreditHold h WHERE h.business_id=NEW.related_task_id
    AND h.payer_type='user' AND h.payer_id=NEW.user_id
    AND (NEW.idempotency_key IN ('hold:'||h.id||':open','hold:'||h.id||':capture','hold:'||h.id||':release')
      OR NEW.idempotency_key LIKE 'hold:'||h.id||':increase:%'))
BEGIN SELECT RAISE(ABORT,'AUD_BILLING_INCOMPATIBLE_CREDIT_WRITER'); END;
CREATE TRIGGER "audit_hold_project_writer_guard" BEFORE INSERT ON ProjectBudgetLedger
WHEN NEW.type IN ('task_freeze','task_success_deduct','task_failed_refund')
  AND NOT EXISTS (SELECT 1 FROM CreditHold h WHERE h.business_id=NEW.related_task_id
    AND h.payer_type='project' AND h.payer_id=NEW.project_id
    AND NEW.idempotency_key IN ('hold:'||h.id||':open','hold:'||h.id||':capture','hold:'||h.id||':release'))
BEGIN SELECT RAISE(ABORT,'AUD_BILLING_INCOMPATIBLE_PROJECT_WRITER'); END;
COMMIT;
