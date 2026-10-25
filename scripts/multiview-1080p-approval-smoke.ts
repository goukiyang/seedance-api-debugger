import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

// Rules (owner, 2026-10-25): every 1080p needs one approval; the approver is exempt; only the approver decides;
// an unused approval lapses after 24h; a used approval is never returned.
async function main() {
  const db = join(mkdtempSync(join(tmpdir(), 'sd2-mv1080p-')), 'test.db');
  Object.assign(process.env, { DATABASE_URL: `file:${db}`, CREDIT_REQUESTS_ENABLED: 'true', CREDIT_REQUEST_APPROVER_ID: 'boss',
    FEISHU_APP_ID: 'app', FEISHU_APP_SECRET: 'test-only', FEISHU_ALLOWED_TENANT_KEY: 'tenant', CREDIT_CALLBACK_MODE: 'relay-v1' });
  const sql = execFileSync(resolve('node_modules/.bin/prisma'), ['migrate', 'diff', '--from-empty', '--to-schema-datamodel', 'prisma/schema.prisma', '--script'], { encoding: 'utf8' });
  execFileSync('sqlite3', [db], { input: sql });
  const { prisma } = await import('../src/lib/prisma');
  const mv = await import('../src/lib/video/multiview-1080p-approval');
  const { handleCreditDecision } = await import('../src/lib/credits/requests');
  for (const [id, role] of [['boss', 'admin'], ['other-admin', 'admin'], ['user', 'user']]) {
    await prisma.user.create({ data: { id, username: id, name: id, email: `${id}@example.invalid`, password_hash: 'x', role,
      feishu_open_id: `open-${id}`, feishu_tenant_key: 'tenant', credit_account: { create: { balance: 0 } } } });
  }
  const consume = (userId: string, key: string) => prisma.$transaction(tx => mv.consumeMultiview1080pApproval(tx, userId, key));
  // Exempt: the approver needs nothing; another admin is not exempt.
  assert.equal(await mv.hasMultiview1080pApproval('boss'), true);
  assert.equal(await consume('boss', 'k0'), null);
  assert.equal(await mv.hasMultiview1080pApproval('other-admin'), false);
  await assert.rejects(mv.submitMultiview1080pRequest('boss', 'x'), /无需申请/);
  // No approval → no generation.
  assert.equal(await consume('user', 'k1'), false);
  const request = await mv.submitMultiview1080pRequest('user', '提案');
  assert.equal((await mv.submitMultiview1080pRequest('user', 'again')).id, request.id, 'one pending request at a time');
  assert.equal((await mv.readMultiview1080pState('user')).state, 'pending');
  assert.equal(await prisma.creditRequestDelivery.count({ where: { request_id: request.id, kind: 'approval' } }), 1);
  // Only the configured approver may decide; a wrong Feishu identity or nonce is refused.
  await assert.rejects(handleCreditDecision({ requestId: request.id, actorId: 'other-admin', action: 'approve_1080p' }), /无权/);
  await assert.rejects(handleCreditDecision({ requestId: request.id, openId: 'open-other-admin', nonce: request.nonce, action: 'approve_1080p' }), /无权/);
  await assert.rejects(handleCreditDecision({ requestId: request.id, openId: 'open-boss', nonce: 'wrong', action: 'approve_1080p' }), /无权/);
  await assert.rejects(handleCreditDecision({ requestId: request.id, actorId: 'boss', action: 'prepare', amount: 2000 }), /不支持/);
  await handleCreditDecision({ requestId: request.id, openId: 'open-boss', nonce: request.nonce, action: 'approve_1080p' });
  assert.equal((await mv.readMultiview1080pState('user')).state, 'approved');
  // One approval = one generation; concurrent uses claim it once; it is not returned afterwards.
  const uses = await Promise.allSettled([consume('user', 'a'), consume('user', 'b'), consume('user', 'c')]);
  assert.equal(uses.filter(item => item.status === 'fulfilled' && typeof item.value === 'string').length, 1);
  assert.equal(await consume('user', 'd'), false, 'reuse rejected');
  assert.equal((await mv.readMultiview1080pState('user')).state, 'none');
  // A rolled-back creation keeps the approval unused.
  const second = await mv.submitMultiview1080pRequest('user', '再来一次').catch(async () => {
    await prisma.creditRequest.updateMany({ where: { user_id: 'user' }, data: { created_at: new Date(Date.now() - 120_000) } });
    return mv.submitMultiview1080pRequest('user', '再来一次');
  });
  await handleCreditDecision({ requestId: second.id, actorId: 'boss', action: 'approve_1080p' });
  await assert.rejects(prisma.$transaction(async tx => { await mv.consumeMultiview1080pApproval(tx, 'user', 'e'); throw new Error('create failed'); }), /create failed/);
  assert.equal(await mv.hasMultiview1080pApproval('user'), true);
  // Creation failed before generation started: the approval comes back.
  const usedId = await consume('user', 'g');
  assert.equal(typeof usedId, 'string');
  assert.equal(await mv.hasMultiview1080pApproval('user'), false);
  await prisma.$transaction(tx => mv.restoreMultiview1080pApproval(tx, 'user', 'g'));
  assert.equal(await mv.hasMultiview1080pApproval('user'), true);
  // Unused approval lapses after 24h.
  await prisma.creditRequest.update({ where: { id: second.id }, data: { expires_at: new Date(Date.now() - 1) } });
  assert.equal(await consume('user', 'f'), false);
  // A pending request older than 24h cannot be approved any more.
  await prisma.creditRequest.updateMany({ where: { user_id: 'user' }, data: { created_at: new Date(Date.now() - 120_000) } });
  const stale = await mv.submitMultiview1080pRequest('user', '过期测试');
  await prisma.creditRequest.update({ where: { id: stale.id }, data: { created_at: new Date(Date.now() - 25 * 3600_000) } });
  const late = await handleCreditDecision({ requestId: stale.id, actorId: 'boss', action: 'approve_1080p' });
  assert.match(late.message, /作废/);
  assert.equal(await mv.hasMultiview1080pApproval('user'), false);
  // Credit request listings never show 1080p requests.
  const { listCreditRequests } = await import('../src/lib/credits/requests');
  assert.equal((await listCreditRequests('boss')).requests.length, 0);
  await prisma.$disconnect();
  console.log('multiview 1080p approval smoke: ok');
}
main().catch(error => { console.error(error); process.exit(1); });
