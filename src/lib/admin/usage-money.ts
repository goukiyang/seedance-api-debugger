import { USD_TO_CNY_RATE } from '@/lib/costs/currency';
import type { UsageMoney } from './usage-types';

// No Number arithmetic on totals. Conversion happens once after integer summing.
export function usageInteger(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return Number.isSafeInteger(value) ? BigInt(value) : null;
  return typeof value === 'string' && /^-?\d+$/.test(value) ? BigInt(value) : null;
}

export function usageDecimalUnits(value: unknown, precision: number): bigint | null {
  if (value === null || value === undefined || typeof value === 'number' && !Number.isFinite(value)) return null;
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(value));
  if (!match) return null;
  const exponent = Number(match[4] || 0);
  if (Math.abs(exponent) > 100) return null;
  const fraction = match[3] || '';
  const digits = BigInt(match[2] + fraction);
  const scale = precision + exponent - fraction.length;
  // Float sources have at most cent precision; tolerate their binary encoding
  // noise only at the integer boundary, without adding floats row by row.
  const divisor = scale < 0 ? BigInt('1' + '0'.repeat(-scale)) : BigInt(1);
  const units = scale >= 0 ? digits * BigInt('1' + '0'.repeat(scale)) : (digits + divisor / BigInt(2)) / divisor;
  return match[1] ? -units : units;
}

export function usageUnitsText(value: bigint, precision = 2): string {
  const negative = value < BigInt(0);
  const digits = (negative ? -value : value).toString().padStart(precision + 1, '0');
  if (!precision) return `${negative ? '-' : ''}${digits}`;
  const fraction = digits.slice(-precision).replace(/0+$/, '');
  return `${negative ? '-' : ''}${digits.slice(0, -precision)}${fraction ? `.${fraction}` : ''}`;
}

export function usageMoneyTotals(values: Iterable<UsageMoney>): UsageMoney[] {
  const totals = new Map<string, bigint>();
  for (const value of Array.from(values)) {
    const units = usageInteger(value.amountMicros);
    if (units === null) throw new Error('Usage money precision invalid');
    totals.set(value.currency, (totals.get(value.currency) ?? BigInt(0)) + units);
  }
  return Array.from(totals).sort(([a], [b]) => a.localeCompare(b)).map(([currency, amount]) => ({ currency, amountMicros: amount.toString() }));
}

export const usageExchangeRate = { USD_CNY: String(USD_TO_CNY_RATE), source: '站内现用美元展示汇率（默认 1 USD = 7 CNY）；仅用于展示换算，不作为供应商账单证明' };

export function usageCnyMicros(values: UsageMoney[]): string | null {
  if (!values.length) return null;
  const rate = usageDecimalUnits(usageExchangeRate.USD_CNY, 12);
  if (rate === null || rate <= BigInt(0) || values.some(value => !['CNY', 'USD'].includes(value.currency))) return null;
  let numerator = BigInt(0);
  const scale = BigInt('1000000000000');
  for (const value of values) {
    const units = usageInteger(value.amountMicros);
    if (units === null) return null;
    numerator += units * (value.currency === 'USD' ? rate : scale);
  }
  const sign = numerator < BigInt(0) ? -BigInt(1) : BigInt(1);
  return (sign * ((numerator * sign + scale / BigInt(2)) / scale)).toString();
}

export function usageCnyDisplay(value: string | null): string | null {
  const micros = usageInteger(value);
  if (micros === null) return null;
  const negative = micros < BigInt(0);
  const cents = ((negative ? -micros : micros) + BigInt(5000)) / BigInt(10000);
  const digits = cents.toString().padStart(3, '0');
  return `${negative && cents !== BigInt(0) ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`;
}
