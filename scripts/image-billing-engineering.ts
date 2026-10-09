import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

async function main() {
  const url = process.env.DATABASE_URL || '';
  const filename = url.startsWith('file:') ? fileURLToPath(url) : '';
  assert.equal(process.env.COST02_ISOLATED_ENGINEERING, '1');
  assert.equal(path.basename(filename), 'cost02-isolated.db');
  assert.ok(filename.startsWith('/Volumes/Data/Projects/video-api-debugger/docs/materials/2026-10-08-image-actual-billing/isolated/'));
  globalThis.fetch = async () => { throw new Error('Network prohibited in isolated engineering checks'); };
  const { prisma } = await import('../src/lib/prisma');
  const { billedCredits, imageBillingView, parseImageBillingContract } = await import('../src/lib/image-studio/billing-contract');
  const { fixedImageBillingContract, supplierHistoryEstimate } = await import('../src/lib/image-studio/billing-quote');
  const { parseImageSupplierBills, matchImageSupplierCharge } = await import('../src/lib/image-studio/billing-provider');
  const { settleImageSupplierCharge } = await import('../src/lib/image-studio/billing');
  const { settleTaskCredits } = await import('../src/lib/credits/policy');
  const { saveImageBillingIntent, imageBillingReady } = await import('../src/lib/image-studio/billing-readiness');
  const { consumeImageQuote, imageQuoteKey } = await import('../src/lib/image-studio/billing-quote-store');
  const { assertStudioPostAuthorization } = await import('../src/lib/image-studio/worker');
  const { createToolFlowQuoteProof, assertToolFlowQuoteProof, validateSubmittedToolFlowQuote, toolFlowQuoteCookieName } = await import('../src/lib/tools/toolflow-runtime');
  const results: string[] = [];
  const scope = 'a'.repeat(64), model = 'gemini-3.1-flash-image-preview', specification = 'b'.repeat(64);
  const at = new Date();
  const bill = (id: string, amountMicros = 100000) => ({ requestId: id, model, amountMicros, occurredAt: at,
    quota: amountMicros / 2, promptTokens: null, completionTokens: null, type: 2 });
  const contract = (credits: number, mode: 'fixed' | 'actual' = 'actual', now = Date.now()) => ({
    ...fixedImageBillingContract({ scope, model, credits, specification }, now), mode,
    ...(mode === 'actual' ? { deadline: new Date(now + 48 * 3600000).toISOString(), estimateSource: 'provider_rule' as const } : {}) });
  try {
    assert.equal(await prisma.user.count(), 0, 'Only a fresh empty isolated database is accepted');
    assert.equal(billedCredits(48000), 1.68);
    assert.equal(billedCredits(100), 0);
    assert.equal(billedCredits(200), 0.01);
    assert.throws(() => billedCredits(-1));
    assert.throws(() => billedCredits(0.1));
    assert.equal(parseImageBillingContract(JSON.stringify({ ...contract(5), pointsPerUsd: 36 })), null);
    results.push('currency_precision_and_contract');
    const rows = parseImageSupplierBills({ success: true, data: [
      { id: 123, request_id: 'post-1', model_name: model, type: 2, quota: 24000, created_at: Math.floor(Date.now() / 1000) },
      { id: 'post-2', model_name: model, type: 2, quota: 24000, created_at: Math.floor(Date.now() / 1000) },
      { request_id: 'bad', model_name: model, type: 2, quota: -1, created_at: Math.floor(Date.now() / 1000) },
    ] });
    assert.equal(rows.length, 2);
    assert.equal(matchImageSupplierCharge(rows, '123', model).state, 'missing');
    assert.equal(matchImageSupplierCharge(rows, 'post-1', model).state, 'matched');
    assert.equal(matchImageSupplierCharge(rows, 'bad', model).state, 'conflict');
    assert.equal(matchImageSupplierCharge([...rows, { ...rows[0], type: 6 }], 'post-1', model).state, 'conflict');
    assert.equal(matchImageSupplierCharge(rows, 'post-1', 'other-model').state, 'conflict');
    results.push('exact_identity_not_display_id_or_refund');
    const history = Array.from({ length: 3 }, (_, index) => ({ ...bill(`history-${index}`, 48000),
      parameters: { model_price: 0.03, group_ratio: 1.6, model_ratio: 0, completion_ratio: 0 } }));
    assert.equal(supplierHistoryEstimate(history, model, { inputCharacters: 100000, referencePixels: 0 })?.credits, 2);
    assert.equal(supplierHistoryEstimate([...history, { ...history[0], type: 6 }], model, { inputCharacters: 1, referencePixels: 0 }), null);
    assert.equal(supplierHistoryEstimate(history, 'unknown', { inputCharacters: 1, referencePixels: 0 }), null);
    results.push('scope_model_fixed_call_estimate');

    const task = async (cap: number, options: { mode?: 'fixed' | 'actual'; expired?: boolean; status?: string; requestId?: string; frozen?: number } = {}) => {
      const id = randomUUID(), owner = randomUUID();
      await prisma.user.create({ data: { id: owner, name: 'isolated-fixture', username: owner, email: `${owner}@invalid.example`, password_hash: 'not-a-login' } });
      await prisma.creditAccount.create({ data: { user_id: owner, balance: 100, frozen_credits: options.frozen ?? cap } });
      const snapshot = contract(cap, options.mode, options.expired ? Date.now() - 49 * 3600000 : Date.now());
      const created = await prisma.imageStudioTask.create({ data: { id, owner_id: owner, batch_id: id, ordinal: 1,
        fingerprint: id, prompt: 'isolated fixture', context: '', revision: 0, model, reference_ids: '[]', unit_credits: cap,
        freeze_snapshot: JSON.stringify([{ source_type: 'balance', amount: cap }]), status: options.status || 'succeeded',
        billing_mode: snapshot.mode, billing_status: 'pending', billing_scope: scope, billing_contract_json: JSON.stringify(snapshot),
        gateway_request_id: options.requestId || id, billing_deadline: snapshot.deadline ? new Date(snapshot.deadline) : null,
        ...(snapshot.mode === 'fixed' ? { actual_credits: cap, billing_settled_at: at } : {}),
      } });
      return created;
    };
    const successful = await task(5);
    assert.equal(await settleImageSupplierCharge(successful.id, bill(successful.gateway_request_id!)), true);
    assert.equal(await settleImageSupplierCharge(successful.id, bill(successful.gateway_request_id!)), false);
    const account = await prisma.creditAccount.findUniqueOrThrow({ where: { user_id: successful.owner_id } });
    assert.equal(account.balance, 96.5); assert.equal(account.frozen_credits, 0); assert.equal(account.total_used, 3.5);
    assert.equal(await prisma.creditLedger.count({ where: { related_task_id: successful.id } }), 1);
    const cash = await prisma.costLedger.findFirstOrThrow({ where: { image_task_id: successful.id } });
    assert.equal(cash.task_id, null); assert.equal(cash.amount_micros, 100000);
    assert.equal(await prisma.costAllocation.count({ where: { image_task_id: successful.id } }), 1);
    assert.equal(imageBillingView(await prisma.imageStudioTask.findUniqueOrThrow({ where: { id: successful.id } }), 'unrelated', false), null);
    results.push('partial_consume_release_idempotency_and_privacy');
    for (const expired of [false, true]) {
      const item = await task(expired ? 5 : 2, { expired });
      await settleImageSupplierCharge(item.id, bill(item.gateway_request_id!));
      const row = await prisma.imageStudioTask.findUniqueOrThrow({ where: { id: item.id } });
      const balance = await prisma.creditAccount.findUniqueOrThrow({ where: { user_id: item.owner_id } });
      assert.equal(row.actual_credits, 0); assert.equal(balance.balance, 100); assert.equal(balance.frozen_credits, 0);
      assert.equal(row.billing_status, expired ? 'deadline_expired' : 'over_limit');
    }
    results.push('over_cap_and_late_no_charge');
    const failed = await task(5, { status: 'failed', frozen: 0 });
    await settleImageSupplierCharge(failed.id, bill(failed.gateway_request_id!));
    assert.equal((await prisma.imageStudioTask.findUniqueOrThrow({ where: { id: failed.id } })).billing_status, 'provider_loss');
    assert.equal((await prisma.creditAccount.findUniqueOrThrow({ where: { user_id: failed.owner_id } })).balance, 100);
    const fixed = await task(5, { mode: 'fixed', frozen: 0 });
    await settleImageSupplierCharge(fixed.id, bill(fixed.gateway_request_id!, 48000));
    assert.equal((await prisma.imageStudioTask.findUniqueOrThrow({ where: { id: fixed.id } })).actual_credits, 5);
    assert.equal(await prisma.creditLedger.count({ where: { related_task_id: fixed.id } }), 0);
    results.push('failure_cash_loss_and_fixed_no_rebilling');
    const duplicateA = await task(5, { requestId: 'duplicate' });
    await task(5, { requestId: 'duplicate' });
    assert.equal(await settleImageSupplierCharge(duplicateA.id, bill('duplicate')), false);
    assert.equal((await prisma.imageStudioTask.findUniqueOrThrow({ where: { id: duplicateA.id } })).billing_status, 'conflict');
    results.push('cross_task_identity_conflict');
    const bucketTask = await task(5, { frozen: 0 });
    const bucket = await prisma.creditBucket.create({ data: { user_id: bucketTask.owner_id, source_type: 'daily_quota',
      amount_total: 5, amount_remaining: 0, frozen_amount: 5, expires_at: new Date(Date.now() - 1000), status: 'expired' } });
    const settlement = await prisma.$transaction(tx => settleTaskCredits(tx, { taskId: bucketTask.id, userId: bucketTask.owner_id,
      terminalStatus: 'succeeded', frozenAmount: 5, actualCost: 3.5,
      freezeSnapshot: JSON.stringify([{ source_type: 'daily_quota', bucket_id: bucket.id, amount: 5 }]) }));
    assert.equal(settlement.expiredClosedAmount, 1.5);
    const afterBucket = await prisma.creditBucket.findUniqueOrThrow({ where: { id: bucket.id } });
    assert.equal(afterBucket.amount_remaining, 0); assert.equal(afterBucket.frozen_amount, 0);
    results.push('expired_original_source_not_revived');
    await saveImageBillingIntent(true, 0, successful.owner_id);
    assert.equal((await imageBillingReady(scope, model)).ready, true);
    assert.equal((await imageBillingReady('c'.repeat(64), model)).ready, false);
    const quoteId = randomUUID(), quoteContract = contract(5);
    await prisma.platformSetting.create({ data: { key: imageQuoteKey(successful.owner_id, quoteId), value_json: JSON.stringify({
      owner: successful.owner_id, count: 1, fingerprint: specification, intentRevision: 1, contract: quoteContract }) } });
    const consume = { owner: successful.owner_id, id: quoteId, count: 1, fingerprint: specification, specification, scope, model };
    await assert.rejects(prisma.$transaction(tx => consumeImageQuote(tx, { ...consume, count: 2 })));
    await assert.rejects(prisma.$transaction(tx => consumeImageQuote(tx, { ...consume, owner: fixed.owner_id })));
    await prisma.$transaction(tx => consumeImageQuote(tx, consume));
    await assert.rejects(prisma.$transaction(tx => consumeImageQuote(tx, consume)));
    results.push('per_scope_model_readiness_quote_owner_count_cas');
    const awaiting = await task(5, { status: 'running' });
    const authorized = await prisma.imageStudioTask.update({ where: { id: awaiting.id }, data: {
      lease_token: 'isolated-lease', lease_until: new Date(Date.now() + 60000), gateway_request_id: null, billing_status: 'awaiting_response' } });
    await assertStudioPostAuthorization(authorized);
    await prisma.imageStudioTask.update({ where: { id: awaiting.id }, data: { billing_settled_at: at } });
    await assert.rejects(assertStudioPostAuthorization(authorized));
    await prisma.imageStudioTask.update({ where: { id: awaiting.id }, data: { billing_settled_at: null, billing_deadline: new Date(Date.now() - 1000) } });
    await assert.rejects(assertStudioPostAuthorization(authorized));
    results.push('final_post_gate_stops_released_or_expired_authorization');
    const flowQuote = { flowId: 'isolated-flow-a', flowVersion: 1, settingsRevision: 1, estimatedCredits: 5,
      expiresAt: new Date(Date.now() + 60000).toISOString(), billingMode: 'fixed' as const,
      steps: [{ nodeId: 'template-a', templateId: null, moduleId: 'module-a', templateVersion: null,
        model, count: 1, unitCredits: 5, estimatedCredits: 5, status: 'fixed' as const }] };
    const proof = createToolFlowQuoteProof(successful.owner_id, flowQuote);
    assertToolFlowQuoteProof(successful.owner_id, flowQuote, proof);
    assert.throws(() => assertToolFlowQuoteProof(fixed.owner_id, flowQuote, proof));
    assert.throws(() => assertToolFlowQuoteProof(successful.owner_id, { ...flowQuote, expiresAt: new Date(Date.now() + 120000).toISOString() }, proof));
    assert.notEqual(toolFlowQuoteCookieName(flowQuote.flowId, flowQuote.expiresAt), toolFlowQuoteCookieName('isolated-flow-b', flowQuote.expiresAt));
    assert.equal(validateSubmittedToolFlowQuote(flowQuote, flowQuote).billingMode, 'fixed');
    assert.throws(() => validateSubmittedToolFlowQuote({ ...flowQuote, flowVersion: 2 }, flowQuote));
    assert.throws(() => validateSubmittedToolFlowQuote({ ...flowQuote, estimatedCredits: 0 }, flowQuote));
    assert.throws(() => validateSubmittedToolFlowQuote({ ...flowQuote, expiresAt: new Date(Date.now() - 1).toISOString() }, flowQuote));
    results.push('toolflow_signed_owner_expiry_version_amount_and_concurrent_cookie_identity');
    console.log(JSON.stringify({ isolated: true, network: 'prohibited', checks: results, count: results.length }));
  } finally { await prisma.$disconnect(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
