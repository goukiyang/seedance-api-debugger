export const IMAGE_BILLING_VERSION = 'cost02-v1';
export const IMAGE_POINTS_PER_USD = 35;

export type ImageBillingContract = {
  version: typeof IMAGE_BILLING_VERSION;
  mode: 'fixed' | 'actual';
  pointsPerUsd: number;
  multiplier: 1;
  rounding: 'half_up_cent';
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
};

export function creditsToCents(value: number) {
  if (!Number.isFinite(value) || value < 0 || value > 10_000_000
    || Math.abs(value * 100 - Math.round(value * 100)) > 0.00001) throw new Error('Invalid credit precision');
  return Math.round(value * 100);
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
    if (contract.version !== IMAGE_BILLING_VERSION || !['fixed', 'actual'].includes(contract.mode)
      || contract.multiplier !== 1 || contract.rounding !== 'half_up_cent'
      || !/^[a-f0-9]{64}$/.test(contract.scope) || typeof contract.model !== 'string'
      || !/^[a-f0-9]{64}$/.test(contract.specification)
      || contract.pointsPerUsd !== IMAGE_POINTS_PER_USD
      || !['legacy_fixed', 'confirmed_p90', 'provider_rule', 'scope_model_history', 'exact_spec_sparse'].includes(contract.estimateSource)
      || typeof contract.estimateVersion !== 'string'
      || !Number.isFinite(Date.parse(contract.issuedAt)) || !Number.isFinite(Date.parse(contract.expiresAt))
      || Date.parse(contract.expiresAt) <= Date.parse(contract.issuedAt)
      || contract.mode === 'actual' && (!contract.deadline || !Number.isFinite(Date.parse(contract.deadline))
        || Date.parse(contract.deadline) <= Date.parse(contract.expiresAt))) return null;
    creditsToCents(contract.authorizedCredits);
    return contract;
  } catch { return null; }
}

export function imageBillingView(task: { owner_id: string; billing_status: string; actual_amount_micros: number | null;
  actual_credits: number | null; billing_contract_json: string | null }, viewerId: string, isAdmin: boolean): ImageBillingView | null {
  if (!isAdmin && task.owner_id !== viewerId) return null;
  const contract = parseImageBillingContract(task.billing_contract_json);
  const status = task.billing_status.startsWith('channel_') ? task.billing_status.slice('channel_'.length) : task.billing_status;
  return { status, mode: contract?.mode ?? null, pollUntil: contract?.mode === 'actual' ? contract.deadline : null, amountMicros: task.actual_amount_micros,
    chargedCredits: task.actual_credits, pointsPerUsd: contract?.mode === 'actual' ? contract.pointsPerUsd : null };
}

export function imageBillingPending(view: ImageBillingView | null | undefined, now = Date.now()) {
  return !!view?.pollUntil && Date.parse(view.pollUntil) > now
    && ['awaiting_response', 'pending', 'reconciling'].includes(view.status);
}

export function imageBillingLabel(view: ImageBillingView) {
  if (view.status === 'confirmed' && view.mode === 'fixed'
    && view.chargedCredits !== null && Number.isFinite(view.chargedCredits) && view.chargedCredits >= 0) {
    return `固定 ${view.chargedCredits.toFixed(2)} 点 · 供应商费用未核实`;
  }
  if (view.amountMicros !== null && view.chargedCredits !== null) {
    const dollars = (view.amountMicros / 1_000_000).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
    return `$${dollars} · ${view.chargedCredits.toFixed(2)}点`;
  }
  if (['awaiting_response', 'pending', 'reconciling'].includes(view.status)) return '费用核对中';
  if (['conflict', 'over_limit', 'manual', 'deadline_expired'].includes(view.status)) return '费用待核对';
  return '未对账';
}
