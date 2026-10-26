export class CreditPrecisionError extends Error {
  constructor() { super('原点数精度或范围无法确认，已停止本次账务操作；原账本未重算'); }
}

/** Four floating-point ulps, capped at 1e-5 of one cent. This is not a rounding allowance. */
export function creditCents(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new CreditPrecisionError();
  const scaled = value * 100, nearest = Math.round(scaled);
  const noise = Math.min(0.00001, Number.EPSILON * Math.max(1, Math.abs(scaled), Math.abs(value) * 100) * 4);
  if (!Number.isSafeInteger(nearest) || nearest === 0 && value !== 0 || Math.abs(scaled - nearest) > noise) throw new CreditPrecisionError();
  return Object.is(nearest, -0) ? 0 : nearest;
}

export function creditsFromCents(value: number): number {
  if (!Number.isSafeInteger(value)) throw new CreditPrecisionError();
  const amount = value / 100;
  if (creditCents(amount) !== value) throw new CreditPrecisionError();
  return amount;
}

function safe(value: number) {
  if (!Number.isSafeInteger(value)) throw new CreditPrecisionError();
  return value;
}
export function addCredits(left: number, right: number) { return creditsFromCents(safe(creditCents(left) + creditCents(right))); }
export function subtractCredits(left: number, right: number) { return creditsFromCents(safe(creditCents(left) - creditCents(right))); }
export function sumCredits(values: readonly number[]) { return creditsFromCents(values.reduce((sum, value) => safe(sum + creditCents(value)), 0)); }
export function normalizeCredits(value: number) { return creditsFromCents(creditCents(value)); }
export function assertCreditWriteback<T extends object>(written: T, expected: Partial<Record<keyof T, number>>) {
  for (const key of Object.keys(expected) as Array<keyof T>) {
    if (creditCents(written[key] as number) !== creditCents(expected[key]!)) throw new CreditPrecisionError();
  }
}
