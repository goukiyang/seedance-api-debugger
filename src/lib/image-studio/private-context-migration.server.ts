import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { validContextVersion } from './context-version';
import { privateOrigin, privatePromptIndex, privatePromptPolicy, isStoredPrivatePrompt, openPrivatePrompt,
  sealPrivatePrompt, PrivatePromptError } from '@/lib/security/private-prompts.server';

type IndexPair = {
  oldKey: string; newKey: string; forward: string; forwardUpdatedAt: Date;
  reverseKey: string; reverseBefore: string; reverseAfter: string; reverseUpdatedAt: Date;
};
type IndexPlan = { inventoryId: string; policyRevision: string; pairs: IndexPair[]; unchangedPairs: number; digest: string };
const prepared = new WeakMap<IndexPlan, string>();
const fail = (): never => { throw new PrivatePromptError(); };

export async function preparePrivateContextIndexMigration(db: PrismaClient, inventoryId: string, keys: string[]) {
  const policy = privatePromptPolicy(), origin = privateOrigin('context-index', 'studio-context-version');
  if (!policy || !origin || !/^[A-Za-z0-9_.:-]{1,240}$/.test(inventoryId)
    || keys.length > 1000 || new Set(keys).size !== keys.length
    || keys.some(key => !/^studio_context_hash_v1:[a-f0-9]{64}$/.test(key))) return fail();
  const pairs: IndexPair[] = [];
  let unchangedPairs = 0;
  const codes = new Set<string>();
  for (const key of keys) {
    const hash = key.slice('studio_context_hash_v1:'.length);
    const newKey = `studio_context_hash_v2:${privatePromptIndex('studio-context-hash', hash)}`;
    const oldForward = await db.platformSetting.findUnique({ where: { key } });
    const migratedForward = await db.platformSetting.findUnique({ where: { key: newKey } });
    if (oldForward && migratedForward) return fail();
    const forward = oldForward || migratedForward;
    if (!forward) return fail();
    const value = JSON.parse(forward.value_json);
    if (!validContextVersion(value.code) || codes.has(value.code)) return fail();
    codes.add(value.code);
    const reverseKey = `studio_context_code_v1:${value.code}`;
    const reverse = await db.platformSetting.findUnique({ where: { key: reverseKey } });
    if (!reverse) return fail();
    const reverseValue = JSON.parse(reverse.value_json);
    const binding = { kind: 'context-index', id: value.code, field: 'hash', origins: [origin] };
    const existing = reverseValue.hash;
    const plain = isStoredPrivatePrompt(existing) ? openPrivatePrompt(existing, binding) : existing;
    if (plain !== hash) return fail();
    if (migratedForward) {
      if (!isStoredPrivatePrompt(existing)) return fail();
      unchangedPairs++; continue;
    }
    const encrypted = isStoredPrivatePrompt(existing) ? existing : sealPrivatePrompt(hash, binding);
    if (openPrivatePrompt(encrypted, binding) !== hash) return fail();
    pairs.push({ oldKey: key, newKey, forward: forward.value_json, forwardUpdatedAt: forward.updated_at,
      reverseKey, reverseBefore: reverse.value_json,
      reverseAfter: JSON.stringify({ ...reverseValue, hash: encrypted }), reverseUpdatedAt: reverse.updated_at });
  }
  const content = { inventoryId, policyRevision: policy.revision, pairs, unchangedPairs };
  const plan = { ...content, digest: privatePromptIndex('context-index-migration', JSON.stringify({
    inventoryId, policyRevision: policy.revision, bodyKeyId: policy.keys.body.active, unchangedPairs,
    pairs: pairs.map(({ reverseAfter: _encrypted, ...source }) => source),
  })) };
  prepared.set(plan, JSON.stringify(plan));
  return plan;
}

export async function executePrivateContextIndexMigration(db: PrismaClient, plan: IndexPlan,
  authorization: { inventoryId: string; digest: string; restoreId: string }) {
  const policy = privatePromptPolicy();
  if (prepared.get(plan) !== JSON.stringify(plan) || !policy || policy.state !== 'encrypted-write'
    || policy.revision !== plan.policyRevision || authorization.digest !== plan.digest
    || authorization.inventoryId !== plan.inventoryId || policy.activation?.inventoryId !== plan.inventoryId
    || policy.activation.restoreId !== authorization.restoreId) return fail();
  const pairs = structuredClone(plan.pairs);
  await db.$transaction(async tx => {
    for (const pair of pairs) {
      const reverseCount = await tx.$executeRawUnsafe(
        'UPDATE "PlatformSetting" SET "value_json" = ? WHERE "key" = ? AND "value_json" = ? AND "updated_at" = ?',
        pair.reverseAfter, pair.reverseKey, pair.reverseBefore, pair.reverseUpdatedAt);
      if (reverseCount !== 1) return fail();
      const forwardCount = await tx.$executeRawUnsafe(
        'UPDATE "PlatformSetting" SET "key" = ? WHERE "key" = ? AND "value_json" = ? AND "updated_at" = ?',
        pair.newKey, pair.oldKey, pair.forward, pair.forwardUpdatedAt);
      if (forwardCount !== 1) return fail();
    }
    const current = privatePromptPolicy();
    if (current?.revision !== policy.revision || current.state !== policy.state
      || current.activation?.writerFenceId !== policy.activation?.writerFenceId) return fail();
  }, { maxWait: 5000, timeout: 30000 });
  return { inventoryId: plan.inventoryId, digest: plan.digest, changedPairs: pairs.length };
}
