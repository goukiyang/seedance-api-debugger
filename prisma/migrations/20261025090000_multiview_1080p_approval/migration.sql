-- Additive only: existing rows become kind 'credits'; older releases keep working.
ALTER TABLE "CreditRequest" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'credits';
ALTER TABLE "CreditRequest" ADD COLUMN "expires_at" DATETIME;
ALTER TABLE "CreditRequest" ADD COLUMN "used_at" DATETIME;
ALTER TABLE "CreditRequest" ADD COLUMN "used_request_key" TEXT;
CREATE INDEX "CreditRequest_user_id_kind_status_idx" ON "CreditRequest"("user_id", "kind", "status");
