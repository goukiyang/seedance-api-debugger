import { createHash } from 'node:crypto';
import { IMAGE_BILLING_VERSION, IMAGE_POINTS_PER_USD,
  billedCredits, creditsToCents, type ImageBillingContract } from './billing-contract';
import type { ImageSupplierCharge } from './billing-provider';

export function imageSpecification(input: { model: string; quality: string; outputSize?: string | null;
  aspectRatio: string; referenceCount: number; inputCharacters: number; inputDigest?: string }) {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

// Only precisely paired bills from the same complete specification may enter
// calibration. Unpaired historical candidates are not accepted here.
export function conservativeImageEstimate(samples: Array<{ amountMicros: number; exact: boolean; specification: string }>,
  specification: string, providerUpperBoundMicros?: number) {
  const amounts = samples.filter(sample => sample.exact && sample.specification === specification
    && Number.isSafeInteger(sample.amountMicros) && sample.amountMicros >= 0).map(sample => sample.amountMicros).sort((a, b) => a - b);
  if (amounts.length >= 10) {
    const p90 = amounts[Math.ceil(amounts.length * 0.9) - 1];
    return { credits: Math.ceil(billedCredits(Math.ceil(p90 * 1.1))), source: 'confirmed_p90' as const,
      samples: amounts.length, calibrated: false };
  }
  if (providerUpperBoundMicros !== undefined && Number.isSafeInteger(providerUpperBoundMicros) && providerUpperBoundMicros >= 0) {
    return { credits: Math.ceil(billedCredits(providerUpperBoundMicros)), source: 'provider_rule' as const,
      samples: amounts.length, calibrated: false };
  }
  return null;
}

export function fixedImageBillingContract(input: { scope: string; model: string; credits: number; specification: string }, now = Date.now()): ImageBillingContract {
  creditsToCents(input.credits);
  return { version: IMAGE_BILLING_VERSION, mode: 'fixed', pointsPerUsd: IMAGE_POINTS_PER_USD,
    multiplier: 1, rounding: 'half_up_cent', authorizedCredits: input.credits, scope: input.scope,
    model: input.model, specification: input.specification, issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(), deadline: null, estimateSource: 'legacy_fixed', estimateVersion: 'legacy-fixed-v1' };
}

export function supplierHistoryEstimate(rows: ImageSupplierCharge[], model: string,
  input: { inputCharacters: number; referencePixels: number }, now = Date.now()) {
  const refunded = new Set(rows.filter(row => row.type === 6).map(row => row.requestId));
  const fixedCall = model.startsWith('gemini-');
  const recent = rows.filter(row => row.type === 2 && row.model === model && row.amountMicros >= 0
    && !refunded.has(row.requestId) && row.occurredAt.getTime() >= now - (fixedCall ? 30 : 7) * 86400000
    && row.occurredAt.getTime() <= now).sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime()).slice(0, 100);
  if (recent.length < 3 || now - recent[0].occurredAt.getTime() > (fixedCall ? 7 : 1) * 86400000) return null;
  const params = recent.slice(0, 3).map(row => row.parameters);
  if (model.startsWith('gemini-') && params.every(p => p && typeof p.model_price === 'number' && p.model_price >= 0
    && typeof p.group_ratio === 'number' && p.group_ratio >= 0 && p.model_ratio === 0
    && p.completion_ratio === 0 && p.model_price === params[0]?.model_price && p.group_ratio === params[0]?.group_ratio)) {
    const micros = Math.ceil(params[0]!.model_price! * params[0]!.group_ratio! * 1000000);
    if (!recent.slice(0, 3).every(row => Math.abs(row.amountMicros - micros) <= 2)) return null;
    return { credits: Math.ceil(billedCredits(Math.ceil(micros * 1.1))), source: 'provider_rule' as const,
      samples: recent.length, confidence: 'provider_parameter' as const, calibrated: false, amountMicros: micros,
      assumption: 'single_request_count_one', version: 'wallet-fixed-call-v1' };
  }
  if (!model.startsWith('gpt-image-') || !Number.isFinite(input.inputCharacters) || input.inputCharacters < 0
    || !Number.isFinite(input.referencePixels) || input.referencePixels < 0) return null;
  const rates = params.map(p => p && typeof p.model_ratio === 'number' && p.model_ratio >= 0
    && typeof p.group_ratio === 'number' && p.group_ratio >= 0 ? p.model_ratio * p.group_ratio * 2 : null);
  if (rates.some(rate => rate === null)) return null;
  const amounts = recent.map(row => row.amountMicros).sort((a, b) => a - b);
  const p90 = amounts[Math.ceil(amounts.length * 0.9) - 1];
  // A broad fallback over whole requests, not a per-image or same-size training
  // sample. Character/pixel allowances are deliberately heuristic, not bounds.
  const inputAllowance = Math.ceil((input.inputCharacters * 2 + input.referencePixels / 256)
    * Math.max(...rates as number[]) * Math.max(1, ...params.map(p => p?.image_ratio || 1)));
  const micros = Math.ceil(p90 * (recent.length >= 10 ? 1.35 : 1.75) + inputAllowance);
  if (micros > 2_000_000_000) return null;
  return { credits: Math.ceil(billedCredits(micros)), source: 'scope_model_history' as const,
    samples: recent.length, confidence: 'low' as const, calibrated: false, amountMicros: micros,
    assumption: 'whole_request_unknown_output_specification', version: 'wallet-history-wide-v1' };
}
