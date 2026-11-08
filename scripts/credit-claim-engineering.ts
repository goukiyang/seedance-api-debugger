import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mock } from 'node:test';
import type { ClaimCampaignConfig } from '../src/lib/credits/claim-types';

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'sd2-credit-claim-engineering-'));
  const db = join(dir, 'test.db');
  process.env.DATABASE_URL = `file:${db}`;
  const sql = execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', 'prisma/schema.prisma', '--script'], { encoding: 'utf8', env: process.env });
  execFileSync('sqlite3', [db], { input: sql });
  const resolver = require('node:module') as { _resolveFilename: (...args: unknown[]) => string };
  const originalResolve = resolver._resolveFilename;
  const marker = require.resolve('next/dist/compiled/server-only/empty.js');
  mock.method(resolver, '_resolveFilename', (...args: unknown[]) => args[0] === 'server-only' ? marker : originalResolve.apply(resolver, args));
  mock.method(globalThis, 'fetch', () => { throw new Error('No network permitted in this isolated engineering check'); });
  const { prisma } = await import('../src/lib/prisma');
  const { saveClaimCampaign, claimCampaignCredits, listClaimCampaigns, readClaimOperation } = await import('../src/lib/credits/claim-campaigns');
  const { checkClaimActor, readClaimBody } = await import('../src/lib/credits/claim-http');
  const { NextRequest } = await import('next/server');
  const active = (): ClaimCampaignConfig => ({ name: 'Synthetic only', amount: 20.15, enabled: true, audience: 'all', startsAt: new Date(Date.now() - 60000).toISOString(), endsAt: new Date(Date.now() + 3600000).toISOString() });
  const create = (config = active()) => saveClaimCampaign('admin', { id: randomUUID(), expectedRevision: 0, operationId: randomUUID(), config });
  try {
    for (const id of ['admin', 'email', 'feishu', 'another', 'disabled', 'expired', 'rollback']) await prisma.user.create({ data: {
      id, username: id, name: id, email: `${id}@example.invalid`, password_hash: 'not-a-login', role: id === 'admin' ? 'admin' : 'user',
      account_type: id === 'email' ? 'external' : 'internal', status: id === 'disabled' ? 'disabled' : 'active', expires_at: id === 'expired' ? new Date(0) : null,
      credit_account: { create: { balance: 10.25, frozen_credits: 2, monthly_used: 3, total_used: 4 } },
    } });
    assert.equal((await listClaimCampaigns('email')).campaigns.length, 0);
    assert.equal(await prisma.creditLedger.count(), 0, 'Reading never grants');
    await assert.rejects(saveClaimCampaign('email', { id: randomUUID(), expectedRevision: 0, operationId: randomUUID(), config: active() }), /管理员/);
    for (const patch of [{ amount: 0 }, { amount: 1.001 }, { endsAt: new Date(0).toISOString() }]) await assert.rejects(create({ ...active(), ...patch }));
    const campaign = await create();
    const input = { campaignId: campaign.id, expectedRevision: campaign.revision, amount: 999999, userId: 'admin' };
    const first = await claimCampaignCredits('email', input);
    assert.equal(first.receipt.amount, 20.15, 'Server amount, not forged request amount');
    assert.equal(first.receipt.userId, 'email', 'Actor, not forged target');
    assert.equal(first.receipt.balanceAfter, 30.4);
    assert.equal((await claimCampaignCredits('email', input)).receipt.ledgerId, first.receipt.ledgerId);
    const concurrent = await Promise.all([claimCampaignCredits('feishu', input), claimCampaignCredits('feishu', input)]);
    assert.equal(concurrent[0].receipt.ledgerId, concurrent[1].receipt.ledgerId);
    assert.equal(await prisma.creditLedger.count(), 2);
    const account = await prisma.creditAccount.findUniqueOrThrow({ where: { user_id: 'email' } });
    assert.deepEqual([account.balance, account.frozen_credits, account.monthly_used, account.total_used], [30.4, 2, 3, 4]);
    assert.equal((await listClaimCampaigns('another')).campaigns[0].receipt, null, 'Receipt isolation');
    assert.equal((await listClaimCampaigns('admin', true)).campaigns[0].claimedCount, 2);
    for (const id of ['disabled', 'expired']) {
      await assert.rejects(claimCampaignCredits(id, input), /不可用/);
      await assert.rejects(listClaimCampaigns(id), /不可用/);
    }
    const op = { id: campaign.id, expectedRevision: campaign.revision, operationId: randomUUID(), config: { ...active(), amount: 40 } };
    const edited = await saveClaimCampaign('admin', op);
    assert.equal((await saveClaimCampaign('admin', op)).revision, edited.revision);
    assert.equal((await readClaimOperation('admin', op.operationId)).campaign?.revision, edited.revision);
    await assert.rejects(saveClaimCampaign('admin', { ...op, config: { ...op.config, amount: 90 } }), /编号/);
    await assert.rejects(saveClaimCampaign('admin', { ...op, operationId: randomUUID() }), /其它页面更新/);
    await assert.rejects(claimCampaignCredits('another', input), /设置已变化/);
    const next = await claimCampaignCredits('another', { campaignId: campaign.id, expectedRevision: edited.revision });
    assert.equal(next.receipt.amount, 40);
    assert.equal((await claimCampaignCredits('email', input)).receipt.amount, 20.15, 'Old receipt immutable after editing');
    const paused = await saveClaimCampaign('admin', { id: campaign.id, expectedRevision: edited.revision, operationId: randomUUID(), config: { ...edited, enabled: false } });
    assert.equal((await claimCampaignCredits('email', input)).receipt.ledgerId, first.receipt.ledgerId, 'Replays after pause do not grant again');
    await assert.rejects(claimCampaignCredits('rollback', { campaignId: paused.id, expectedRevision: paused.revision }), /暂停/);
    for (const config of [{ ...active(), startsAt: new Date(Date.now() + 60000).toISOString() }, { ...active(), startsAt: new Date(0).toISOString(), endsAt: new Date(1000).toISOString() }]) {
      const row = await create(config);
      await assert.rejects(claimCampaignCredits('rollback', { campaignId: row.id, expectedRevision: row.revision }), /尚未到|已结束/);
    }
    const internal = await create({ ...active(), audience: 'internal' });
    assert.equal((await listClaimCampaigns('email', false, internal.id)).campaigns.length, 0);
    await assert.rejects(claimCampaignCredits('email', { campaignId: internal.id, expectedRevision: internal.revision }), /范围/);
    const rollback = await create();
    const rollbackKey = `credit_claim_receipt_v1:${rollback.id}:rollback`;
    await prisma.$executeRawUnsafe(`CREATE TRIGGER claim_ledger_failure BEFORE INSERT ON CreditLedger WHEN NEW.user_id = 'rollback' BEGIN SELECT RAISE(ABORT, 'synthetic ledger failure'); END`);
    await assert.rejects(claimCampaignCredits('rollback', { campaignId: rollback.id, expectedRevision: rollback.revision }));
    assert.equal(await prisma.platformSetting.findUnique({ where: { key: rollbackKey } }), null);
    assert.equal((await prisma.creditAccount.findUniqueOrThrow({ where: { user_id: 'rollback' } })).balance, 10.25);
    assert.equal(await prisma.creditLedger.count({ where: { user_id: 'rollback' } }), 0);
    await prisma.$executeRawUnsafe('DROP TRIGGER claim_ledger_failure');
    assert.equal((await claimCampaignCredits('rollback', { campaignId: rollback.id, expectedRevision: rollback.revision })).receipt.amount, 20.15);
    const request = (owner: string, origin = 'https://example.invalid', body = '{}') => new NextRequest('https://example.invalid/api/me/credit-claims', { method: 'POST', headers: { origin, host: 'example.invalid', 'Content-Type': 'application/json', 'x-app-session-user': owner }, body });
    assert.throws(() => checkClaimActor(request('email'), 'another', true), /账号已变化/);
    await assert.rejects(readClaimBody(request('email', 'https://foreign.invalid'), 'email'), /来源/);
    await assert.rejects(readClaimBody(request('email', undefined, 'x'.repeat(8193)), 'email'), /请求过大/);
    await assert.rejects(readClaimBody(request('email', undefined, '{'), 'email'), /内容无效/);
    assert.deepEqual(await readClaimBody(request('email'), 'email'), {});
    for (const file of ['src/app/api/me/credit-claims/route.ts', 'src/app/api/admin/credits/claims/route.ts']) assert.match(readFileSync(file, 'utf8'), /getSessionUser|getAdminUser/);
    assert.match(readFileSync('src/lib/navigation.ts', 'utf8'), /\/points\/claim/);
    console.log(JSON.stringify({ completed: true, currentSchema: true, isolatedDatabase: true, checks: ['no auto grant', 'admin-only settings', 'amount/time validation', 'server amount/actor', 'exact precision', 'duplicate/concurrent one grant', 'unchanged frozen/monthly', 'receipt privacy', 'disabled/expired', 'save replay/CAS', 'edited amount/immutable history', 'pause/replay', 'start/end', 'audience', 'ledger failure atomic rollback', 'account switch/origin/body bounds', 'authenticated routes/entry'], productionWrites: 0, providerCalls: 0, browserRuns: 0 }));
  } finally { mock.restoreAll(); await prisma.$disconnect(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
