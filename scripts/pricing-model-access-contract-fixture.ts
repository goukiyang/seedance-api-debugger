import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../src/lib/prisma';
import { MODEL_ACCESS_KEY, parseModelAccessSettings } from '../src/lib/pricing/model-availability-contract';
import { assertSupplementaryModelEnabled, getModelAccessOperation, readModelAccessSettings, saveModelAccessSettings } from '../src/lib/pricing/model-access.server';
import { inspectDescription, resolveDescription, type DescriptionStore } from '../src/lib/avatar-random/description-parser';

export async function runPricingModelAccessFixture() {
  const id = `model-access-fixture-${randomUUID()}`, actor = { id };
  const before = await prisma.platformSetting.findUnique({ where: { key: MODEL_ACCESS_KEY } });
  const pricingBefore = await prisma.platformSetting.findUnique({ where: { key: 'pricing_policy_v1' } });
  await prisma.user.create({ data: { id, name: id, username: id, email: `${id}@fixture.invalid`,
    password_hash: 'not-a-login-credential', role: 'admin', status: 'active' } });
  try {
    if (before) await prisma.platformSetting.delete({ where: { key: MODEL_ACCESS_KEY } });
    const initial = await readModelAccessSettings();
    assert.deepEqual(initial, parseModelAccessSettings(null));
    assert.equal(await prisma.platformSetting.findUnique({ where: { key: MODEL_ACCESS_KEY } }), null, 'reads must not write defaults');
    const requestId = `close-${randomUUID()}`;
    const input = { requestId, revision: initial.revision, settings: { ...initial, models: [
      { kind: 'text', model: 'gpt-6-sol', enabled: false }, { kind: 'cutout', model: 'all', enabled: false },
    ] } };
    const saved = await saveModelAccessSettings(actor, input);
    assert.equal(saved.operation.state, 'succeeded');
    assert.notEqual(saved.operation.settings?.revision, initial.revision);
    await assert.rejects(() => assertSupplementaryModelEnabled('text', 'gpt-6-sol'), /费率页关闭/);
    await assert.rejects(() => assertSupplementaryModelEnabled('cutout', 'sam2'), /费率页关闭/);
    await assertSupplementaryModelEnabled('text', 'gpt-6-astra');
    for (const state of [null, 'failed', 'unknown'] as const) {
      const raw = state && JSON.stringify({ version: 2, requestId: randomUUID(), state, createdAt: new Date().toISOString(), cost: 'unknown' });
      let writes = 0, calls = 0, admissions = 0;
      const store: DescriptionStore = { readCache: async () => null, readAttempt: async () => raw,
        createAttempt: async () => { writes++; return true; }, replaceAttempt: async () => { writes++; return true; },
        saveResponse: async () => { writes++; }, readResponse: async () => null, complete: async () => { writes++; return true; } };
      const status = await inspectDescription('一位穿蓝色外套的人物', store);
      const request = resolveDescription('一位穿蓝色外套的人物', { approved: true, retryToken: status.retryToken }, store,
        async () => { calls++; throw new Error('Model must not be called'); },
        async () => { admissions++; await assertSupplementaryModelEnabled('text', 'gpt-6-sol'); });
      await assert.rejects(() => request, state === 'unknown' ? /./ : /费率页关闭/);
      assert.equal(writes, 0); assert.equal(calls, 0);
      assert.equal(admissions, state === 'unknown' ? 0 : 1, 'old unknown stays read-only; first and explicit new retry share admission');
    }
    assert.deepEqual(await saveModelAccessSettings(actor, input), saved, 'same request must replay the durable operation');
    assert.deepEqual((await getModelAccessOperation(actor, requestId)).operation, saved.operation);
    assert.equal((await getModelAccessOperation(actor, `missing-${randomUUID()}`)).operation.state, 'unknown');
    await assert.rejects(() => saveModelAccessSettings(actor, { ...input, settings: { ...input.settings, models: [] } }), /同一保存编号/);
    const staleId = `stale-${randomUUID()}`;
    const stale = await saveModelAccessSettings(actor, { ...input, requestId: staleId });
    assert.equal(stale.operation.state, 'rejected', 'stale CAS cannot overwrite another save');
    assert.equal((await getModelAccessOperation(actor, staleId)).operation.state, 'rejected');
    const current = await readModelAccessSettings();
    assert.deepEqual(current, saved.operation.settings);
    const reopened = await saveModelAccessSettings(actor, { requestId: `open-${randomUUID()}`, revision: current.revision,
      settings: { ...current, models: [{ kind: 'text', model: 'gpt-6-sol', enabled: true }, { kind: 'cutout', model: 'all', enabled: true }] } });
    assert.equal(reopened.operation.state, 'succeeded');
    await assertSupplementaryModelEnabled('text', 'gpt-6-sol');
    await assertSupplementaryModelEnabled('cutout', 'sam2');
    assert.deepEqual((await getModelAccessOperation(actor, requestId)).operation, saved.operation, 'later changes cannot rewrite an original receipt');
    await prisma.user.update({ where: { id }, data: { role: 'user' } });
    await assert.rejects(() => saveModelAccessSettings(actor, { ...input, requestId: `revoked-${randomUUID()}` }), /管理员权限已失效/);
    assert.deepEqual(await prisma.platformSetting.findUnique({ where: { key: 'pricing_policy_v1' } }), pricingBefore,
      'supplementary switches must not change numeric prices or existing pricing rules');
    return { fixture: 'pricing-model-access', completed: true, modelCalls: 0, productionWrites: 0,
      evidence: ['Actual isolated SQLite CAS/replay/original receipt/disabled admission/re-enable/revoked admin/price preservation',
        'Actual parser first/approved-retry admission rejects before intent or call; original unknown does not invoke admission'] };
  } finally {
    await prisma.operationLog.deleteMany({ where: { operator_id: id } });
    await prisma.platformSetting.deleteMany({ where: { key: MODEL_ACCESS_KEY } });
    if (before) await prisma.platformSetting.create({ data: before });
    await prisma.user.delete({ where: { id } });
  }
}
