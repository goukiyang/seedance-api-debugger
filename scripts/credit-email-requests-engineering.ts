import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'sd2-email-credit-engineering-'));
  const db = join(dir, 'test.db');
  Object.assign(process.env, { DATABASE_URL: `file:${db}`, CREDIT_REQUESTS_ENABLED: 'true',
    CREDIT_REQUEST_APPROVER_ID: 'test-admin', FEISHU_APP_ID: 'test-app', FEISHU_APP_SECRET: 'test-only',
    FEISHU_ALLOWED_TENANT_KEY: 'test-tenant', CREDIT_CALLBACK_MODE: 'relay-v1' });
  const sql = execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'diff', '--from-empty',
    '--to-schema-datamodel', 'prisma/schema.prisma', '--script'], { encoding: 'utf8', env: process.env });
  execFileSync('sqlite3', [db], { input: sql });
  const { prisma } = await import('../src/lib/prisma');
  const { submitCreditRequest, handleCreditDecision, listCreditRequests } = await import('../src/lib/credits/requests');
  const { processCreditDeliveries } = await import('../src/lib/credits/request-delivery');
  const { submitMultiview1080pRequest } = await import('../src/lib/video/multiview-1080p-approval');
  const originalFetch = globalThis.fetch;
  const recipients: string[] = [];
  globalThis.fetch = async (url, init) => {
    assert.ok(String(url).startsWith('https://open.feishu.cn/open-apis/'));
    if (String(url).includes('/im/')) {
      const payload = JSON.parse(String(init?.body));
      assert.ok(payload.receive_id && payload.uuid); recipients.push(payload.receive_id);
    }
    return new Response(JSON.stringify({ code: 0, tenant_access_token: 'test-token', data: { message_id: 'test-message' } }));
  };
  try {
    const add = (id: string, balance = 0, options: { status?: string; expires_at?: Date; account_type?: string;
      feishu_open_id?: string; feishu_tenant_key?: string } = {}) => prisma.user.create({ data: {
      id, username: id, name: id, email: `${id}@example.invalid`, password_hash: 'not-a-login',
      account_type: 'external', role: id === 'test-admin' ? 'admin' : 'user', ...options,
      credit_account: { create: { balance } },
    } });
    await add('test-admin', 0, { account_type: 'internal', feishu_open_id: 'open-admin', feishu_tenant_key: 'test-tenant' });
    for (const id of ['email', 'rejected', 'withdrawn', 'changed', 'stranger']) await add(id);
    await add('rich', 500); await add('disabled', 0, { status: 'disabled' });
    await add('expired', 0, { expires_at: new Date(0) });
    await add('wrong-tenant', 0, { account_type: 'internal', feishu_open_id: 'open-other', feishu_tenant_key: 'other' });
    await add('feishu', 0, { account_type: 'internal', feishu_open_id: 'open-user', feishu_tenant_key: 'test-tenant' });
    for (const id of ['disabled', 'expired', 'wrong-tenant']) await assert.rejects(submitCreditRequest(id, 'test'), /不可用|公司飞书/);
    await assert.rejects(submitCreditRequest('rich', 'test'), /少于/);
    await assert.rejects(submitCreditRequest('email', ' '), /用途/);
    const request = await submitCreditRequest('email', 'email user purpose');
    assert.equal(request.applicant_open_id, ''); assert.equal(request.tenant_key, 'test-tenant');
    assert.equal((await submitCreditRequest('email', 'duplicate')).id, request.id);
    assert.equal(await prisma.creditRequest.count({ where: { user_id: 'email' } }), 1);
    assert.equal((await processCreditDeliveries()).processed, 1);
    assert.deepEqual(recipients, ['open-admin'], 'Email request approval goes to the real configured approver');
    await assert.rejects(handleCreditDecision({ requestId: request.id, actorId: 'stranger', action: 'prepare', amount: 2000 }), /无权/);
    await assert.rejects(handleCreditDecision({ requestId: request.id, openId: 'open-admin', nonce: 'wrong', action: 'prepare', amount: 2000 }), /无权/);
    const prepared = await handleCreditDecision({ requestId: request.id, openId: 'open-admin', nonce: request.nonce, action: 'prepare', amount: 2000 });
    await handleCreditDecision({ requestId: request.id, openId: 'open-admin', nonce: request.nonce, action: 'confirm', confirmationNonce: prepared.confirmationNonce });
    await handleCreditDecision({ requestId: request.id, actorId: 'test-admin', action: 'confirm', confirmationNonce: prepared.confirmationNonce });
    assert.equal((await prisma.creditAccount.findUniqueOrThrow({ where: { user_id: 'email' } })).balance, 2000);
    assert.equal(await prisma.creditLedger.count({ where: { idempotency_key: `credit_request:${request.id}` } }), 1);
    assert.equal(await prisma.notification.count({ where: { target_user_id: 'email', type: 'credit_request_result' } }), 1);
    assert.equal(await prisma.creditRequestDelivery.count({ where: { request_id: request.id, kind: 'result' } }), 0);
    assert.equal((await listCreditRequests('email')).requests[0].status, 'approved');
    assert.equal((await listCreditRequests('stranger')).requests.length, 0);
    const rejected = await submitCreditRequest('rejected', 'rejection');
    await handleCreditDecision({ requestId: rejected.id, actorId: 'test-admin', action: 'reject', reason: 'test reason' });
    assert.equal((await listCreditRequests('rejected')).requests[0].decision_reason, 'test reason');
    const withdrawn = await submitCreditRequest('withdrawn', 'withdrawal');
    await handleCreditDecision({ requestId: withdrawn.id, actorId: 'withdrawn', action: 'withdraw' });
    assert.equal((await listCreditRequests('withdrawn')).pendingRequest, null);
    const changed = await submitCreditRequest('changed', 'approver identity protection');
    await prisma.user.update({ where: { id: 'test-admin' }, data: { feishu_open_id: 'changed-admin' } });
    await assert.rejects(handleCreditDecision({ requestId: changed.id, actorId: 'test-admin', action: 'prepare', amount: 2000 }), /身份发生变更/);
    await prisma.user.update({ where: { id: 'test-admin' }, data: { feishu_open_id: 'open-admin' } });
    await assert.rejects(submitMultiview1080pRequest('email', 'no implicit 1080p access'), /公司飞书/);
    const feishu = await submitCreditRequest('feishu', 'original Feishu path');
    const grant = await handleCreditDecision({ requestId: feishu.id, actorId: 'test-admin', action: 'prepare', amount: 2000 });
    await handleCreditDecision({ requestId: feishu.id, actorId: 'test-admin', action: 'confirm', confirmationNonce: grant.confirmationNonce });
    assert.equal(await prisma.creditRequestDelivery.count({ where: { request_id: feishu.id, kind: 'result' } }), 1);
    assert.ok(readFileSync('src/components/ComposerTopbar.tsx', 'utf8').includes('{user && <CreditRequestDialog />}'));
    assert.ok(!readFileSync('src/components/CreditRequestDialog.tsx', 'utf8').includes('user.feishu'));
    console.log(JSON.stringify({ completed: true, synthetic: true, currentSchema: true, isolatedDatabase: true,
      checks: ['email submit/pending', 'admin approval delivery', 'signed identity/nonce', 'one grant/ledger', 'site result without empty Feishu delivery',
        'history/privacy', 'reject/withdraw', 'threshold/status/expiry', 'approver change', 'foreign tenant blocked', '1080p unchanged', 'Feishu result unchanged', 'topbar existing entry'],
      productionWrites: 0, providerCalls: 0, browserRuns: 0 }));
  } finally { globalThis.fetch = originalFetch; await prisma.$disconnect(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
