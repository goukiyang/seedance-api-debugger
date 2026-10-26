import { formatAmountMicrosWithFixedCny } from '../costs/currency';
import { creditCents } from '../credits/precision';
import { frozenPricingCredits, parseFrozenPricingCharge, type FrozenPricingCharge } from '../pricing/frozen-charge';
import { publicPricingBillingState } from './pricing-state';

export const IMAGE_BILLING_VERSION = 'cost02-v1';
export const IMAGE_POINTS_PER_USD = 35;
export const PRICING_IMAGE_BILLING_VERSION = 'pricing-image-v1';

export type ImageBillingContract = {
  version: typeof IMAGE_BILLING_VERSION | typeof PRICING_IMAGE_BILLING_VERSION;
  mode: 'fixed' | 'actual';
  pointsPerUsd: number;
  multiplier: 1;
  rounding: 'half_up_cent' | 'half_up_tenth';
  pricing?: FrozenPricingCharge;
  authorizedCredits: number;
  scope: string;
  model: string;
  specification: string;
  issuedAt: string;
  expiresAt: string;
  deadline: string | null;
  estimateSource: 'legacy_fixed' | 'confirmed_p90' | 'provider_rule' | 'scope_model_history' | 'exact_spec_sparse';
  estimateVersion: string;
};

export type ImageBillingView = {
  status: string;
  mode?: 'fixed' | 'actual' | null;
  pollUntil?: string | null;
  amountMicros: number | null;
  chargedCredits: number | null;
  pointsPerUsd: number | null;
  pointsPerCny?: string | null;
  exchangeRate?: string | null;
  creditPrecision?: 0.01 | 0.1;
};

export function creditsToCents(value: number) {
  if (value < 0 || value > 10_000_000) throw new Error('Invalid credit precision');
  return creditCents(value);
}

export function billedCredits(amountMicros: number, pointsPerUsd = IMAGE_POINTS_PER_USD) {
  if (!Number.isSafeInteger(amountMicros) || amountMicros < 0 || amountMicros > 2_000_000_000
    || !Number.isInteger(pointsPerUsd) || pointsPerUsd <= 0 || pointsPerUsd > 10000) throw new Error('Invalid billing amount');
  return Number((BigInt(amountMicros) * BigInt(pointsPerUsd) + BigInt(5000)) / BigInt(10000)) / 100;
}

export function parseImageBillingContract(value: string | null | undefined): ImageBillingContract | null {
  if (!value) return null;
  try {
    const contract = JSON.parse(value) as ImageBillingContract;
    const legacy = contract.version === IMAGE_BILLING_VERSION;
    if (!legacy && contract.version !== PRICING_IMAGE_BILLING_VERSION) return null;
    if (!['fixed', 'actual'].includes(contract.mode)
      || contract.multiplier !== 1 || contract.rounding !== (legacy || contract.pricing?.mode === 'legacy_actual' ? 'half_up_cent' : 'half_up_tenth')
      || !/^[a-f0-9]{64}$/.test(contract.scope) || typeof contract.model !== 'string'
      || !/^[a-f0-9]{64}$/.test(contract.specification)
      || legacy && contract.pointsPerUsd !== IMAGE_POINTS_PER_USD
      || !['legacy_fixed', 'confirmed_p90', 'provider_rule', 'scope_model_history', 'exact_spec_sparse'].includes(contract.estimateSource)
      || typeof contract.estimateVersion !== 'string'
      || !Number.isFinite(Date.parse(contract.issuedAt)) || !Number.isFinite(Date.parse(contract.expiresAt))
      || Date.parse(contract.expiresAt) <= Date.parse(contract.issuedAt)
      || contract.mode === 'actual' && (!contract.deadline || !Number.isFinite(Date.parse(contract.deadline))
        || Date.parse(contract.deadline) <= Date.parse(contract.expiresAt))) return null;
    creditsToCents(contract.authorizedCredits);
    if (!legacy) {
      const pricing = parseFrozenPricingCharge(contract.pricing);
      if (!pricing || pricing.identity.kind !== 'image' || pricing.identity.modelId !== contract.model
        || pricing.identity.billingMode !== contract.mode || pricing.quantity !== '1'
        || contract.authorizedCredits > 100000 || !['legacy_fixed', 'legacy_actual'].includes(pricing.mode) && creditsToCents(contract.authorizedCredits) % 10 !== 0
        || contract.mode === 'fixed' && frozenPricingCredits(pricing).credits !== contract.authorizedCredits) return null;
      contract.pricing = pricing;
    }
    return contract;
  } catch { return null; }
}

export function billedImageContractCredits(contract: ImageBillingContract, amountMicros: number) {
  return contract.version === IMAGE_BILLING_VERSION ? billedCredits(amountMicros, contract.pointsPerUsd)
    : contract.pricing ? frozenPricingCredits(contract.pricing, amountMicros, 'USD').credits
      : (() => { throw new Error('Frozen pricing contract missing'); })();
}

export function imageBillingView(task: { owner_id: string; billing_status: string; actual_amount_micros: number | null;
  actual_credits: number | null; billing_contract_json: string | null }, viewerId: string, isAdmin: boolean): ImageBillingView | null {
  if (!isAdmin && task.owner_id !== viewerId) return null;
  const contract = parseImageBillingContract(task.billing_contract_json);
  const billingStatus = publicPricingBillingState(task.billing_status);
  const status = billingStatus.startsWith('channel_') ? billingStatus.slice('channel_'.length) : billingStatus;
  return { status, mode: contract?.mode ?? null, pollUntil: contract?.mode === 'actual' ? contract.deadline : null, amountMicros: task.actual_amount_micros,
    chargedCredits: task.actual_credits, pointsPerUsd: contract?.mode === 'actual' && contract.version === IMAGE_BILLING_VERSION ? contract.pointsPerUsd : null,
    pointsPerCny: contract?.pricing?.pointsPerCny, exchangeRate: contract?.pricing?.exchangeRate?.rate,
    creditPrecision: contract?.version === PRICING_IMAGE_BILLING_VERSION && !['legacy_fixed', 'legacy_actual'].includes(contract.pricing?.mode || '') ? 0.1 : 0.01 };
}

export function imageBillingPending(view: ImageBillingView | null | undefined, now = Date.now()) {
  return !!view?.pollUntil && Date.parse(view.pollUntil) > now
    && ['awaiting_response', 'pending', 'reconciling'].includes(view.status);
}

export function imageBillingLabel(view: ImageBillingView) {
  if (view.status === 'confirmed' && view.mode === 'fixed'
    && view.chargedCredits !== null && Number.isFinite(view.chargedCredits) && view.chargedCredits >= 0) {
    return `固定 ${view.chargedCredits.toFixed(view.creditPrecision === 0.1 ? 1 : 2)} 点 · 供应商费用未核实`;
  }
  if (view.status === 'confirmed') {
    if (view.amountMicros !== null && Number.isFinite(view.amountMicros) && view.amountMicros >= 0
      && view.chargedCredits !== null && Number.isFinite(view.chargedCredits) && view.chargedCredits >= 0) {
      return `${formatAmountMicrosWithFixedCny(view.amountMicros, 'USD')} · ${view.chargedCredits.toFixed(view.creditPrecision === 0.1 ? 1 : 2)}点`;
    }
    return '费用待核对';
  }
  if (['awaiting_response', 'pending', 'reconciling'].includes(view.status)) return '费用核对中';
  if (['conflict', 'over_limit', 'manual', 'deadline_expired'].includes(view.status)) return '费用待核对';
  return '费用待核对';
}
