const PREFIX = 'rate_';
const PRIVATE_STATES = new Set(['queued', 'running', 'channel_queued', 'channel_running', 'uncertain']);

/** Durable isolation, not a display flag: old workers cannot claim these states. */
export function pricingTaskState(status: string, adopted: boolean) {
  const publicStatus = status.startsWith(PREFIX) ? status.slice(PREFIX.length) : status;
  return adopted && PRIVATE_STATES.has(publicStatus) ? `${PREFIX}${publicStatus}` : publicStatus;
}

export function isPricingImageTask(task: { id?: string; billing_contract_json?: string | null }) {
  if (task.id?.startsWith('rate-')) return true;
  if (!task.billing_contract_json) return false;
  try { return JSON.parse(task.billing_contract_json).version === 'pricing-image-v1'; }
  catch { return false; }
}

export function studioTaskState(task: { id?: string; billing_contract_json?: string | null; status?: string }, status: string) {
  return pricingTaskState(status, isPricingImageTask(task) || Boolean(task.status?.startsWith(PREFIX)));
}

export function publicPricingTaskState(status: string) {
  return status.startsWith(PREFIX) && PRIVATE_STATES.has(status.slice(PREFIX.length)) ? status.slice(PREFIX.length) : status;
}

export function studioTaskStates(statuses: readonly string[]) {
  return Array.from(new Set(statuses.flatMap(status => [status, pricingTaskState(status, true)])));
}

export function studioBillingState(task: { id?: string; billing_contract_json?: string | null }, status: string) {
  return isPricingImageTask(task) ? `${PREFIX}${status.replace(/^rate_/, '')}` : status;
}

export function publicPricingBillingState(status: string) {
  return status.startsWith(PREFIX) ? status.slice(PREFIX.length) : status;
}

export const PRICING_BATCH_PREFIX = 'studio_pricing_batch_v1:';
export const PRICING_BATCH_ITEM_PREFIX = 'studio_pricing_batch_item_v1:';
export const PRICING_ASYNC_PREFIX = 'studio_pricing_async_recovery_v1:';
