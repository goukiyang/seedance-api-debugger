-- Guard-only correction. No old rows are updated and no holds are backfilled.
-- A compatible ordinary completion may append exactly one receipt tied to its
-- original legacy freeze. All other unrecognized task writers remain blocked.
BEGIN IMMEDIATE;
DROP TRIGGER IF EXISTS audit_hold_personal_writer_guard;
CREATE TRIGGER audit_hold_personal_writer_guard BEFORE INSERT ON CreditLedger
WHEN NEW.type IN ('task_freeze','task_success_deduct','task_failed_refund','task_billing_release')
  AND NOT EXISTS (SELECT 1 FROM CreditHold h WHERE h.business_id=NEW.related_task_id
    AND h.payer_type='user' AND h.payer_id=NEW.user_id
    AND (NEW.idempotency_key IN ('hold:'||h.id||':open','hold:'||h.id||':capture','hold:'||h.id||':release')
      OR NEW.idempotency_key LIKE 'hold:'||h.id||':increase:%'))
  AND NOT (NEW.type <> 'task_freeze'
    AND COALESCE(NEW.idempotency_key,'')='legacy-inflight:'||COALESCE(NEW.related_task_id,'')||':settle'
    AND NOT EXISTS (SELECT 1 FROM CreditHold WHERE business_id=NEW.related_task_id)
    AND EXISTS (SELECT 1 FROM CreditLedger f WHERE f.id=json_extract(NEW.metadata_json,'$.legacy_freeze_ledger_id')
      AND f.related_task_id=NEW.related_task_id AND f.user_id=NEW.user_id AND f.type='task_freeze'
      AND COALESCE(f.idempotency_key,'') NOT LIKE 'hold:%')
    AND NOT EXISTS (SELECT 1 FROM CreditLedger s WHERE s.related_task_id=NEW.related_task_id
      AND s.type IN ('task_success_deduct','task_failed_refund','task_billing_release')))
BEGIN SELECT RAISE(ABORT,'AUD_BILLING_INCOMPATIBLE_CREDIT_WRITER'); END;
DROP TRIGGER IF EXISTS audit_hold_project_writer_guard;
CREATE TRIGGER audit_hold_project_writer_guard BEFORE INSERT ON ProjectBudgetLedger
WHEN NEW.type IN ('task_freeze','task_success_deduct','task_failed_refund')
  AND NOT EXISTS (SELECT 1 FROM CreditHold h WHERE h.business_id=NEW.related_task_id
    AND h.payer_type='project' AND h.payer_id=NEW.project_id
    AND NEW.idempotency_key IN ('hold:'||h.id||':open','hold:'||h.id||':capture','hold:'||h.id||':release'))
  AND NOT (NEW.type <> 'task_freeze'
    AND COALESCE(NEW.idempotency_key,'')='legacy-inflight:'||COALESCE(NEW.related_task_id,'')||':settle'
    AND NOT EXISTS (SELECT 1 FROM CreditHold WHERE business_id=NEW.related_task_id)
    AND EXISTS (SELECT 1 FROM ProjectBudgetLedger f WHERE f.id=json_extract(NEW.metadata_json,'$.legacy_freeze_ledger_id')
      AND f.related_task_id=NEW.related_task_id AND f.project_id=NEW.project_id AND f.account_id=NEW.account_id
      AND f.type='task_freeze' AND COALESCE(f.idempotency_key,'') NOT LIKE 'hold:%')
    AND NOT EXISTS (SELECT 1 FROM ProjectBudgetLedger s WHERE s.related_task_id=NEW.related_task_id
      AND s.type IN ('task_success_deduct','task_failed_refund')))
BEGIN SELECT RAISE(ABORT,'AUD_BILLING_INCOMPATIBLE_PROJECT_WRITER'); END;
COMMIT;
