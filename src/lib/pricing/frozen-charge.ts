import type { PricingAdminIdentity, PricingAdminExchange, PricingAdminMode } from './admin-contract';
import { PublicApiError } from '@/lib/http/public-error';
import { compareDecimal, divideDecimal, multiplyDecimal, normalizeDecimal, roundDecimal, sumDecimal } from './math';
import { creditCents } from '@/lib/credits/precision';

export type FrozenPricingCharge = {
  schema: 'pricing-charge-v1';
  revision: string;
  ruleId: string;
  identity: PricingAdminIdentity;
  binding: { configRevision: string; billingPrincipalId: string | null; credentialVersion: string; configFingerprint: string };
  basisKind: 'site_base_cny' | 'supplier_cost_cny';
  mode: PricingAdminMode;
  baseCny: string | null;
  pointsPerCny: string | null;
  exchangeRate: PricingAdminExchange | null;
  legacyUnitCredits: string | null;
  legacyRounding: 'ceil_task' | 'fixed_unit' | 'half_up_cent' | null;
  quantity: string;
  issuedAt: string;
  rounding: 'half_up_tenth' | 'legacy';
};

export class PricingChargeError extends PublicApiError {
  readonly status = 409;
  readonly code = 'pricing_quote_changed';
  constructor(message = '收费规则已变化，请重新获取报价；参数和素材已保留，未重新提交') { super(message, 409, 'pricing_quote_changed'); }
}

function decimalNumber(value: string, maximum = '10000000') {
  normalizeDecimal(value, { min: '0', max: maximum, maxScale: 8, allowZero: true });
  const number = Number(value);
  try { return creditCents(number) / 100; }
  catch { throw new PricingChargeError('点数精度或范围无效，未受理'); }
}

export function frozenPricingCredits(charge: FrozenPricingCharge, amountMicros?: number, sourceCurrency: 'USD' | 'CNY' = 'USD') {
  let exact: string;
  if (charge.mode === 'free') exact = '0';
  else if (charge.mode === 'legacy_actual') {
    if (sourceCurrency !== 'USD' || !Number.isSafeInteger(amountMicros) || Number(amountMicros) < 0 || Number(amountMicros) > 2000000000) throw new PricingChargeError('旧实际账单身份无效');
    exact = multiplyDecimal([divideDecimal(String(amountMicros), '1000000', 6), '35']);
    return { credits: decimalNumber(roundDecimal(exact, 2, 'half_up')), exactCredits: exact, roundedToZero: false };
  }
  else if (charge.mode === 'legacy_fixed') {
    if (charge.legacyUnitCredits === null) throw new PricingChargeError('旧固定价格缺失，未受理');
    exact = multiplyDecimal([charge.legacyUnitCredits, charge.quantity]);
    const result = charge.legacyRounding === 'ceil_task' ? roundDecimal(exact, 0, 'ceil') : exact;
    return { credits: decimalNumber(result), exactCredits: exact, roundedToZero: result === '0' && compareDecimal(exact, '0') > 0 };
  } else if (charge.identity.billingMode === 'actual') {
    if (!Number.isSafeInteger(amountMicros) || Number(amountMicros) < 0 || Number(amountMicros) > 2_000_000_000
      || !charge.exchangeRate || charge.exchangeRate.sourceCurrency !== sourceCurrency
      || !charge.pointsPerCny) throw new PricingChargeError('实际账单或冻结换算合同缺失，未结算');
    exact = multiplyDecimal([divideDecimal(String(amountMicros), '1000000', 6), charge.exchangeRate.rate, charge.pointsPerCny]);
  } else {
    if (!charge.baseCny || !charge.pointsPerCny) throw new PricingChargeError('该项缺少已确认基价或费率，未受理');
    exact = multiplyDecimal([charge.baseCny, charge.pointsPerCny, charge.quantity]);
  }
  const rounded = roundDecimal(exact, 1, 'half_up');
  return { credits: decimalNumber(rounded, charge.identity.kind === 'image' ? '100000' : '10000000'),
    exactCredits: exact, roundedToZero: compareDecimal(rounded, '0') === 0 && compareDecimal(exact, '0') > 0 };
}

/** The original trusted estimate remains an authorization bound, never a supplier bill or base price. */
export function frozenPricingReservation(charge: FrozenPricingCharge, originalAuthorizedCredits: number) {
  if (charge.mode === 'legacy_actual') return decimalNumber(String(originalAuthorizedCredits), '100000');
  if (charge.identity.billingMode !== 'actual' || charge.mode === 'free') return frozenPricingCredits(charge).credits;
  if (!charge.exchangeRate || charge.exchangeRate.sourceCurrency !== 'USD' || !charge.pointsPerCny) throw new PricingChargeError('原预估为美元口径，实际费用换算依据尚未确认');
  const original = normalizeDecimal(String(originalAuthorizedCredits), { min: '0', max: '100000', maxScale: 2, allowZero: true });
  const usdBound = divideDecimal(original, '35', 12);
  // Ceil the division before conversion so a finite decimal never weakens the original bound.
  const paddedUsdBound = compareDecimal(multiplyDecimal([usdBound, '35']), original) < 0
    ? sumDecimal([usdBound, '0.000000000001']) : usdBound;
  const converted = roundDecimal(multiplyDecimal([paddedUsdBound, charge.exchangeRate.rate, charge.pointsPerCny]), 1, 'ceil');
  return decimalNumber(converted, '100000');
}

export function parseFrozenPricingCharge(value: unknown): FrozenPricingCharge | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const charge = value as FrozenPricingCharge;
    if (charge.schema !== 'pricing-charge-v1' || typeof charge.revision !== 'string' || !charge.revision
      || typeof charge.ruleId !== 'string' || !charge.ruleId || !charge.identity || !charge.binding
      || !['follow', 'custom', 'free', 'legacy_fixed', 'legacy_actual'].includes(charge.mode)
      || !['half_up_tenth', 'legacy'].includes(charge.rounding)
      || !Number.isFinite(Date.parse(charge.issuedAt))
      || typeof charge.binding.configFingerprint !== 'string' || !charge.binding.configFingerprint) return null;
    const identity = charge.identity;
    if (!['video', 'image', 'enhance', 'h3'].includes(identity.kind) || !['fixed', 'actual'].includes(identity.billingMode)
      || identity.unit !== (identity.kind === 'image' ? 'image' : 'second')
      || [identity.channelId, identity.modelId, charge.binding.configRevision, charge.binding.credentialVersion]
        .some(value => typeof value !== 'string' || !value || value.length > 256)
      || charge.binding.billingPrincipalId !== null && (typeof charge.binding.billingPrincipalId !== 'string' || !charge.binding.billingPrincipalId)
      || !identity.specifications || typeof identity.specifications !== 'object' || Array.isArray(identity.specifications)
      || Object.entries(identity.specifications).some(([key, value]) => !key || key.length > 80 || typeof value !== 'string' || value.length > 256)
      || !['site_base_cny', 'supplier_cost_cny'].includes(charge.basisKind)) return null;
    const legacy = charge.mode === 'legacy_fixed' || charge.mode === 'legacy_actual';
    if (charge.rounding !== (legacy ? 'legacy' : 'half_up_tenth')) return null;
    if (charge.mode === 'legacy_fixed') {
      if (identity.billingMode !== 'fixed' || !['ceil_task', 'fixed_unit'].includes(charge.legacyRounding || '')) return null;
      normalizeDecimal(charge.legacyUnitCredits, { min: '0', max: '10000000', maxScale: 2, allowZero: true });
    }
    if (charge.mode === 'legacy_actual' && (identity.billingMode !== 'actual' || charge.legacyRounding !== 'half_up_cent')) return null;
    normalizeDecimal(charge.quantity, { min: '0', max: '10000000', maxScale: 8, allowZero: false });
    if (!['free', 'legacy_fixed', 'legacy_actual'].includes(charge.mode)) {
      normalizeDecimal(charge.pointsPerCny, { min: '0.1', max: '10000', maxScale: 1 });
      if (charge.identity.billingMode === 'actual') {
        const exchange = charge.exchangeRate;
        if (!exchange || exchange.targetCurrency !== 'CNY' || exchange.direction !== 'CNY_per_source_unit'
          || !['USD', 'CNY'].includes(exchange.sourceCurrency) || !exchange.source?.reference
          || !Number.isFinite(Date.parse(exchange.confirmedAt)) || !Number.isFinite(Date.parse(exchange.effectiveFrom))
          || Date.parse(exchange.effectiveFrom) > Date.parse(charge.issuedAt)) return null;
        normalizeDecimal(exchange.rate, { min: '0.00000001', max: '10000', maxScale: 8 });
        if (exchange.sourceCurrency === 'CNY' && compareDecimal(exchange.rate, '1') !== 0) return null;
      } else normalizeDecimal(charge.baseCny, { min: '0', max: '1000000', maxScale: 8, allowZero: false });
    }
    return charge;
  } catch { return null; }
}
