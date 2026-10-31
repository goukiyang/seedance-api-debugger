export type RetryScope = {
  provider: string; protocol: string; endpoint: string; model: string;
  channel: string; revision: string; credential: string;
};
export type RetryFailure = {
  phase: 'create' | 'status'; httpStatus: number | null; code: string | null;
  providerTaskId?: string; retryAfterMs?: number;
};
export type RetryRule = {
  id: string; version: string; scope: Omit<RetryScope, 'credential'>;
  phase: RetryFailure['phase']; httpStatus: number; code: string;
  terminal: true; noCharge: true; evidence: string;
};

// Only supplier-confirmed, exact execution/fee contracts belong here. HTTP
// statuses and customer-facing messages are not free-generation contracts.
export const RETRY_RULES: readonly RetryRule[] = [];
export const RETRY_POLICY_VERSION = 'safe-generation-retry.v1';
export const RETRY_CONFIG_KEY = 'safe-generation-retry:config:v1';
export const RETRY_TASK_PREFIX = 'safe-generation-retry:task:v1:';

export function retryFailure(body: unknown, httpStatus: number | null, phase: RetryFailure['phase'] = 'create', retryAfter?: string | null): RetryFailure {
  const data = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const error = data.error && typeof data.error === 'object' ? data.error as Record<string, unknown> : {};
  const code = error.code ?? data.code;
  const seconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : 0;
  return { phase, httpStatus, code: typeof code === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(code) ? code : null,
    ...(seconds > 0 ? { retryAfterMs: Math.min(seconds * 1000, 24 * 3600_000) } : {}) };
}

export function matchingRetryRule(scope: RetryScope, failure: RetryFailure, frozenIds: string[], enabledIds: string[], rules = RETRY_RULES) {
  return rules.find(rule => frozenIds.includes(`${rule.id}@${rule.version}`) && enabledIds.includes(rule.id)
    && rule.terminal === true && rule.noCharge === true && rule.evidence.startsWith('https://')
    && rule.phase === failure.phase && rule.httpStatus === failure.httpStatus && rule.code === failure.code
    && Object.entries(rule.scope).every(([key, value]) => scope[key as keyof RetryScope] === value));
}
