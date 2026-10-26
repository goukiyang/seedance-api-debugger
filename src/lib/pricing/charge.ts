import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { PRICING_POLICY_KEY, type PricingAdminIdentity } from './admin-contract';
import { resolvePricingCharge } from './policy';
import { normalizeDecimal } from './math';
import { assertPricingImageConsumerReady } from './runtime';
import { frozenPricingCredits, PricingChargeError, type FrozenPricingCharge } from './frozen-charge';

export { frozenPricingCredits, frozenPricingReservation, parseFrozenPricingCharge, PricingChargeError } from './frozen-charge';
export type { FrozenPricingCharge } from './frozen-charge';
type Client = Prisma.TransactionClient | typeof prisma;

export async function quotePricingCharge(identity: PricingAdminIdentity, quantity: string, client: Client = prisma) {
  if (!await client.platformSetting.findUnique({ where: { key: PRICING_POLICY_KEY }, select: { id: true } })) return null;
  const resolved = await resolvePricingCharge(identity, client);
  if (!resolved) return null;
  const row = resolved.row;
  if (row.mode === 'unset') throw new PricingChargeError('当前收费规则尚未设置');
  if (!row.enabled || row.availability !== 'ready' || row.confirmation === 'needs_review') {
    throw new PricingChargeError(row.unavailableReason || '该收费依据需要重新核实，原任务保持原合同');
  }
  const normalizedQuantity = normalizeDecimal(quantity, { min: '0', max: '10000000', maxScale: 8, allowZero: false });
  if (identity.kind === 'image') await assertPricingImageConsumerReady(client);
  const charge: FrozenPricingCharge = {
    schema: 'pricing-charge-v1', revision: resolved.revision, ruleId: resolved.ruleId, identity,
    binding: resolved.binding, basisKind: row.basisKind, mode: row.mode, baseCny: row.baseCny,
    pointsPerCny: row.currentPointsPerCny, exchangeRate: row.exchangeRate,
    legacyUnitCredits: row.currentUnitCredits, legacyRounding: row.legacyRounding,
    quantity: normalizedQuantity, issuedAt: new Date().toISOString(),
    rounding: row.mode === 'legacy_fixed' || row.mode === 'legacy_actual' ? 'legacy' : 'half_up_tenth',
  };
  const computed = identity.billingMode === 'actual' && row.mode !== 'free' ? null : frozenPricingCredits(charge);
  return { charge, ...computed, credits: computed?.credits ?? null };
}

/** Creation only; accepted tasks and late children retain their frozen parent charge. */
export async function assertNewPricingCharge(charge: FrozenPricingCharge, expectedRevision: unknown, client: Client = prisma) {
  if (expectedRevision !== charge.revision) throw new PricingChargeError();
  const current = await resolvePricingCharge(charge.identity, client);
  if (!current || current.revision !== charge.revision || current.ruleId !== charge.ruleId
    || JSON.stringify(current.binding) !== JSON.stringify(charge.binding)) throw new PricingChargeError();
  if (charge.identity.kind === 'image') await assertPricingImageConsumerReady(client);
}
