export const CREDIT_REQUEST_THRESHOLD = 500;
export const CREDIT_GRANT_AMOUNTS = [2000, 5000, 10000] as const;

export function validGrantAmount(amount: unknown): amount is number {
  return typeof amount === 'number' && CREDIT_GRANT_AMOUNTS.some((value) => value === amount);
}

export function canRequestCredits(available: number) {
  return Number.isFinite(available) && available >= 0 && available < CREDIT_REQUEST_THRESHOLD;
}

export class CreditRequestError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

// 3D multiview 1080p: every use needs the configured approver's Feishu approval; the approver is exempt.
export const MULTIVIEW_1080P_KIND = 'multiview_1080p';
export const MULTIVIEW_1080P_TTL_MS = 24 * 3600_000; // pending and approved-but-unused both lapse after 24h
