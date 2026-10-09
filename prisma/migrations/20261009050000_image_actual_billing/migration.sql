-- Additive only: do not rebuild tables, rewrite historical charges or add
-- uniqueness to the historical credit ledger.
ALTER TABLE "ImageStudioTask" ADD COLUMN "billing_mode" TEXT NOT NULL DEFAULT 'fixed';
ALTER TABLE "ImageStudioTask" ADD COLUMN "billing_status" TEXT NOT NULL DEFAULT 'legacy_unknown';
ALTER TABLE "ImageStudioTask" ADD COLUMN "billing_scope" TEXT;
ALTER TABLE "ImageStudioTask" ADD COLUMN "billing_contract_json" TEXT;
ALTER TABLE "ImageStudioTask" ADD COLUMN "gateway_request_id" TEXT;
ALTER TABLE "ImageStudioTask" ADD COLUMN "actual_amount_micros" INTEGER;
ALTER TABLE "ImageStudioTask" ADD COLUMN "actual_credits" REAL;
ALTER TABLE "ImageStudioTask" ADD COLUMN "billing_deadline" DATETIME;
ALTER TABLE "ImageStudioTask" ADD COLUMN "billing_next_check_at" DATETIME;
ALTER TABLE "ImageStudioTask" ADD COLUMN "billing_attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ImageStudioTask" ADD COLUMN "billing_settled_at" DATETIME;
ALTER TABLE "CostLedger" ADD COLUMN "image_task_id" TEXT REFERENCES "ImageStudioTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CostAllocation" ADD COLUMN "image_task_id" TEXT REFERENCES "ImageStudioTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "ImageStudioTask_billing_status_billing_next_check_at_idx" ON "ImageStudioTask"("billing_status", "billing_next_check_at");
CREATE INDEX "ImageStudioTask_billing_scope_gateway_request_id_idx" ON "ImageStudioTask"("billing_scope", "gateway_request_id");
CREATE INDEX "CostLedger_image_task_id_idx" ON "CostLedger"("image_task_id");
CREATE INDEX "CostAllocation_image_task_id_idx" ON "CostAllocation"("image_task_id");
