import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { canRequestCredits, validGrantAmount } from '../src/lib/credits/request-rules';
import { verifyCreditCallback } from '../src/lib/feishu/credit-callback';

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'sd2-credit-test-'));
  const db = join(dir, 'test.db');
  process.env.DATABASE_URL = `file:${db}`;
  process.env.CREDIT_REQUESTS_ENABLED = 'true';
  process.env.CREDIT_REQUEST_APPROVER_ID = 'test-admin';
  process.env.FEISHU_APP_ID = 'test-app';
  process.env.FEISHU_APP_SECRET = 'test-only';
  process.env.FEISHU_ALLOWED_TENANT_KEY = 'test-tenant';
  process.env.FEISHU_CREDIT_ENCRYPT_KEY = 'test-encrypt';
  process.env.FEISHU_CREDIT_VERIFICATION_TOKEN = 'test-token';
  const baseline = join(dir, 'baseline.prisma');
  const oldSchema = execFileSync('git', ['show', '9d690e206084ca0fa3472aee5ceb3e05adcecbeb:prisma/schema.prisma'], { encoding: 'utf8' });
  writeFileSync(baseline, oldSchema);
  const schemaSql = execFileSync(resolve('node_modules/.bin/prisma'), ['migrate', 'diff', '--from-empty', '--to-schema-datamodel', baseline, '--script'], { encoding: 'utf8', env: process.env });
  execFileSync('sqlite3', [db], { input: schemaSql });
  execFileSync('sqlite3', [db], { input: readFileSync('prisma/migrations/20260915120000_credit_requests/migration.sql', 'utf8') });
  const { prisma } = await import('../src/lib/prisma');
  const { submitCreditRequest, handleCreditDecision, listCreditRequests } = await import('../src/lib/credits/requests');
  const { processCreditDeliveries } = await import('../src/lib/credits/request-delivery');
  const originalFetch = globalThis.fetch;
  try {
    assert(canRequestCredits(499.99)); assert(!canRequestCredits(500)); assert(!canRequestCredits(NaN));
    assert(validGrantAmount(2000)); assert(!validGrantAmount('2000')); assert(!validGrantAmount(2001));
    for (const [id, role, balance] of [['test-admin', 'admin', 0], ['test-user', 'user', 499], ['test-rich', 'user', 500], ['test-deny', 'user', 0], ['test-withdraw', 'user', 0]]) {
      await prisma.user.create({ data: { id: String(id), username: String(id), name: String(id), email: `${id}@example.invalid`, password_hash: 'not-a-login', role: String(role),
        feishu_open_id: `open-${id}`, feishu_tenant_key: 'test-tenant', credit_account: { create: { balance: Number(balance) } } } });
    }
    await assert.rejects(submitCreditRequest('test-rich', 'test'), /少于/);
    const results = await Promise.allSettled(Array.from({ length: 3 }, () => submitCreditRequest('test-user', 'test purpose')));
    assert(results.some((result) => result.status === 'fulfilled'));
    assert.equal(await prisma.creditRequest.count({ where: { user_id: 'test-user' } }), 1);
    const request = await prisma.creditRequest.findFirstOrThrow({ where: { user_id: 'test-user' } });
    assert.equal((await submitCreditRequest('test-user', 'retry purpose')).id, request.id);
    await assert.rejects(handleCreditDecision({ requestId: request.id, actorId: 'test-rich', action: 'prepare', amount: 2000 }), /无权/);
    await assert.rejects(handleCreditDecision({ requestId: request.id, openId: request.approver_open_id, nonce: 'wrong', action: 'prepare', amount: 2000 }), /无权/);
    await assert.rejects(handleCreditDecision({ requestId: request.id, actorId: 'test-admin', action: 'prepare', amount: 123 }), /有效/);
    await assert.rejects(handleCreditDecision({ requestId: request.id, actorId: 'test-admin', action: 'confirm', confirmationNonce: 'missing' }), /过期/);
    await prisma.creditAccount.update({ where: { user_id: 'test-user' }, data: { balance: { increment: 200 } } });
    const prepared = await handleCreditDecision({ requestId: request.id, actorId: 'test-admin', action: 'prepare', amount: 2000 });
    assert.equal(prepared.available, 699);
    await Promise.allSettled(Array.from({ length: 3 }, () => handleCreditDecision({ requestId: request.id, actorId: 'test-admin', action: 'confirm', confirmationNonce: prepared.confirmationNonce })));
    assert.equal((await prisma.creditAccount.findUniqueOrThrow({ where: { user_id: 'test-user' } })).balance, 2699);
    assert.equal(await prisma.creditLedger.count({ where: { idempotency_key: `credit_request:${request.id}` } }), 1);
    assert.equal(await prisma.creditRequestDelivery.count({ where: { request_id: request.id, kind: 'result' } }), 1);
    await handleCreditDecision({ requestId: request.id, actorId: 'test-admin', action: 'confirm', confirmationNonce: prepared.confirmationNonce });
    const rejected = await submitCreditRequest('test-deny', 'test rejection');
    await handleCreditDecision({ requestId: rejected.id, actorId: 'test-admin', action: 'reject', reason: 'test reason' });
    assert.equal((await prisma.creditAccount.findUniqueOrThrow({ where: { user_id: 'test-deny' } })).balance, 0);
    const withdrawn = await submitCreditRequest('test-withdraw', 'test withdraw');
    process.env.CREDIT_REQUESTS_ENABLED = 'false';
    const disabledList = await listCreditRequests('test-withdraw');
    assert.equal(disabledList.enabled, false);
    assert.equal(disabledList.pendingRequest?.id, withdrawn.id);
    await handleCreditDecision({ requestId: withdrawn.id, actorId: 'test-withdraw', action: 'withdraw' });
    process.env.CREDIT_REQUESTS_ENABLED = 'true';
    assert.equal((await prisma.creditRequest.findUniqueOrThrow({ where: { id: withdrawn.id } })).pending_key, null);
    assert((await listCreditRequests('test-user')).requests.every((item) => item.user_id === 'test-user'));
    for (let index = 0; index < 31; index++) await prisma.creditRequest.create({ data: {
      user_id: 'test-deny', approver_id: 'test-admin', status: 'rejected', purpose: 'pagination test', available_at_submit: 0,
      nonce: `test-${index}`, applicant_open_id: 'open-test-deny', approver_open_id: 'open-test-admin', tenant_key: 'test-tenant', app_id: 'test-app',
    } });
    const first = await listCreditRequests('test-deny');
    assert.equal(first.requests.length, 30); assert(first.nextCursor);
    const second = await listCreditRequests('test-deny', first.nextCursor!);
    assert.equal(second.requests.length, 2);
    assert(!second.requests.some((item) => first.requests.some((row) => row.id === item.id)));
    globalThis.fetch = async () => { throw new Error('network down'); };
    await processCreditDeliveries();
    assert(await prisma.creditRequestDelivery.count({ where: { status: 'retry' } }));
    assert.equal(await prisma.creditLedger.count({ where: { user_id: 'test-user' } }), 1);
    await prisma.creditRequestDelivery.updateMany({ where: { status: 'retry' }, data: { next_attempt: new Date(0) } });
    globalThis.fetch = async (url, options) => {
      if (String(url).includes('/im/')) assert(JSON.parse(String(options?.body)).uuid);
      return new Response(JSON.stringify({ code: 0, tenant_access_token: 'test-token', data: { message_id: 'test-message' } }), { status: 200 });
    };
    await processCreditDeliveries();
    assert.equal(await prisma.creditRequestDelivery.count({ where: { status: 'retry' } }), 0);
    const config = { encryptKey: 'test-encrypt', verificationToken: 'test-token', appId: 'test-app', tenantKey: 'test-tenant' };
    const event = { header: { event_type: 'card.action.trigger', app_id: config.appId, tenant_key: config.tenantKey, token: config.verificationToken }, event: { action: {} } };
    const sign = (raw: string, timestamp = String(Math.floor(Date.now() / 1000))) => new Headers({ 'x-lark-request-timestamp': timestamp, 'x-lark-request-nonce': 'nonce',
      'x-lark-signature': createHash('sha256').update(timestamp + 'nonce' + config.encryptKey + raw).digest('hex') });
    const raw = JSON.stringify(event);
    assert(verifyCreditCallback(raw, sign(raw), config).event);
    assert.throws(() => verifyCreditCallback(raw + ' ', sign(raw), config));
    assert.throws(() => verifyCreditCallback(raw, sign(raw, '1000000000'), config));
    assert.throws(() => verifyCreditCallback(raw, sign(raw), { ...config, tenantKey: 'other' }));
    const iv = randomBytes(16); const cipher = createCipheriv('aes-256-cbc', createHash('sha256').update(config.encryptKey).digest(), iv);
    const encrypted = JSON.stringify({ encrypt: Buffer.concat([iv, cipher.update(raw), cipher.final()]).toString('base64') });
    assert(verifyCreditCallback(encrypted, sign(encrypted), config).event);
    console.log('PASS: migration, threshold, unique pending, concurrency, authorization, current balance, one grant, rejection, disabled history/withdrawal, pagination, privacy, retry, signature, encryption');
  } finally { globalThis.fetch = originalFetch; await prisma.$disconnect(); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
