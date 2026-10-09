import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { imageBillingScope } from './billing-scope';
import { getImageGenerationSettingsForModel } from '@/lib/integrations/image-generation';
import { IMAGE_STUDIO_MODELS } from './model-catalog';

const KEY = 'image_actual_billing_intent_v1';
const proofKey = (scope: string, model: string) => `image_billing_proof_v1:${scope}:${model}`;
type Store = Pick<Prisma.TransactionClient, 'platformSetting'>;

export async function imageBillingIntent(store: Store = prisma) {
  const row = await store.platformSetting.findUnique({ where: { key: KEY } });
  if (!row) return { enabled: false, revision: 0 };
  const value = JSON.parse(row.value_json);
  if (typeof value.enabled !== 'boolean' || !Number.isSafeInteger(value.revision)) throw new Error('Invalid billing intent');
  return { enabled: value.enabled as boolean, revision: value.revision as number };
}

export async function saveImageBillingIntent(enabled: boolean, revision: number, owner: string) {
  return prisma.$transaction(async tx => {
    const current = await imageBillingIntent(tx);
    if (current.revision !== revision) return null;
    const next = { enabled, revision: revision + 1 };
    await tx.platformSetting.upsert({ where: { key: KEY }, create: { key: KEY, value_json: JSON.stringify(next), updated_by: owner },
      update: { value_json: JSON.stringify(next), updated_by: owner } });
    return next;
  });
}

// Only the exact reconciler can create this proof. No admin/API accepts a
// request id or a claimed PASS supplied by a client.
export async function recordImageBillingProof(tx: Store, input: { scope: string; model: string; taskId: string; ledgerId: string }) {
  const key = proofKey(input.scope, input.model);
  await tx.platformSetting.upsert({ where: { key },
    create: { key, value_json: JSON.stringify({ ...input, verifiedAt: new Date().toISOString(), match: 'generation_post_header_exact_bill' }) },
    update: { value_json: JSON.stringify({ ...input, verifiedAt: new Date().toISOString(), match: 'generation_post_header_exact_bill' }) } });
}

export async function imageBillingReady(scope: string, model: string, store: Store = prisma) {
  const intent = await imageBillingIntent(store);
  const row = await store.platformSetting.findUnique({ where: { key: proofKey(scope, model) } });
  let exactPostBill = false;
  if (row) {
    const proof = JSON.parse(row.value_json);
    const age = Date.now() - Date.parse(proof.verifiedAt);
    exactPostBill = proof.scope === scope && proof.model === model
      && proof.match === 'generation_post_header_exact_bill' && age >= 0 && age < 7 * 86400000;
  }
  return { intentEnabled: intent.enabled, intentRevision: intent.revision, exactPostBill,
    ready: intent.enabled && exactPostBill };
}

export async function imageBillingReadinessPayload() {
  const intent = await imageBillingIntent();
  const models = Object.fromEntries(await Promise.all(IMAGE_STUDIO_MODELS.map(async model => {
    const settings = await getImageGenerationSettingsForModel(model);
    if (settings.provider !== 'musk' || !settings.api_key) return [model, { exactPostBill: false, ready: false }];
    const result = await imageBillingReady(imageBillingScope(settings), model);
    return [model, { exactPostBill: result.exactPostBill, ready: result.ready,
      priceRuleRequired: true, reason: !intent.enabled ? 'intent_off' : !result.exactPostBill ? 'post_bill_unverified' : 'fresh_quote_required' }];
  })));
  return { ...intent, models, pointsPerUsd: 35, multiplier: 1, creditPrecision: 0.01,
    policy: 'only_new_explicit_valid_quotes', legacyRebilling: false };
}
