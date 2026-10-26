export type DecimalOptions = { maxScale?: number; min?: string; max?: string; allowZero?: boolean; maxLength?: number };
type Decimal = { coefficient: bigint; scale: number };
const ZERO = BigInt(0), ONE = BigInt(1), TEN = BigInt(10);

export class PricingNumberError extends Error {
  readonly status = 400;
  readonly code = 'pricing_number_invalid';
  constructor(message = '请输入范围内的普通十进制数，不使用负数、指数或多余小数位') { super(message); }
}

function power(scale: number) {
  if (!Number.isSafeInteger(scale) || scale < 0 || scale > 256) throw new PricingNumberError('计算精度超过安全范围');
  let result = ONE;
  for (let index = 0; index < scale; index++) result *= TEN;
  return result;
}

function parse(value: unknown, maxLength = 512): Decimal {
  if (typeof value !== 'string' || !value.length || value.length > maxLength || !/^\d+(?:\.\d+)?$/.test(value)) throw new PricingNumberError();
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > 128) throw new PricingNumberError();
  return { coefficient: BigInt(whole + fraction), scale: fraction.length };
}

function format(coefficient: bigint, scale: number) {
  if (coefficient < ZERO || coefficient.toString().length > 512) throw new PricingNumberError('计算结果超过安全范围');
  if (coefficient === ZERO) return '0';
  const digits = coefficient.toString().padStart(scale + 1, '0');
  if (!scale) return digits;
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/0+$/, '').replace(/\.$/, '');
}

export function compareDecimal(left: string, right: string): number {
  const a = parse(left), b = parse(right), scale = Math.max(a.scale, b.scale);
  const x = a.coefficient * power(scale - a.scale), y = b.coefficient * power(scale - b.scale);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function normalizeDecimal(value: unknown, options: DecimalOptions = {}) {
  const decimal = parse(value, options.maxLength ?? 32);
  if (decimal.scale > (options.maxScale ?? 8) || options.allowZero === false && decimal.coefficient === ZERO) throw new PricingNumberError();
  const result = format(decimal.coefficient, decimal.scale);
  if (options.min !== undefined && compareDecimal(result, options.min) < 0
    || options.max !== undefined && compareDecimal(result, options.max) > 0) throw new PricingNumberError('数值超出允许范围，未自动调整');
  return result;
}

export function multiplyDecimal(values: readonly string[]) {
  if (!values.length || values.length > 2000) throw new PricingNumberError();
  let coefficient = ONE, scale = 0;
  for (const value of values) {
    const next = parse(value);
    coefficient *= next.coefficient; scale += next.scale;
    if (scale > 128 || coefficient.toString().length > 512) throw new PricingNumberError('计算结果超过安全范围');
  }
  return format(coefficient, scale);
}

export function sumDecimal(values: readonly string[]) {
  if (values.length > 2000) throw new PricingNumberError();
  const parsed = values.map(value => parse(value));
  const scale = parsed.reduce((maximum, value) => Math.max(maximum, value.scale), 0);
  return format(parsed.reduce((sum, value) => sum + value.coefficient * power(scale - value.scale), ZERO), scale);
}

export function subtractDecimal(left: string, right: string) {
  const a = parse(left), b = parse(right), scale = Math.max(a.scale, b.scale);
  const coefficient = a.coefficient * power(scale - a.scale) - b.coefficient * power(scale - b.scale);
  if (coefficient < ZERO) throw new PricingNumberError('计算结果不能为负数');
  return format(coefficient, scale);
}

export function roundDecimal(value: string, scale: number, mode: 'half_up' | 'ceil') {
  if (!Number.isSafeInteger(scale) || scale < 0 || scale > 16 || !['half_up', 'ceil'].includes(mode)) throw new PricingNumberError();
  const decimal = parse(value);
  if (decimal.scale <= scale) return format(decimal.coefficient, decimal.scale);
  const divisor = power(decimal.scale - scale), quotient = decimal.coefficient / divisor, remainder = decimal.coefficient % divisor;
  const up = mode === 'ceil' ? remainder > ZERO : remainder * BigInt(2) >= divisor;
  return format(quotient + (up ? ONE : ZERO), scale);
}

export function divideDecimal(numerator: string, denominator: string, scale = 8) {
  if (!Number.isSafeInteger(scale) || scale < 0 || scale > 16) throw new PricingNumberError();
  const a = parse(numerator), b = parse(denominator);
  if (b.coefficient === ZERO) throw new PricingNumberError('不能除以零');
  const top = a.coefficient * power(b.scale + scale), bottom = b.coefficient * power(a.scale);
  const quotient = top / bottom, remainder = top % bottom;
  return format(quotient + (remainder * BigInt(2) >= bottom ? ONE : ZERO), scale);
}

export function fixedPricingCredits(baseCny: string, pointsPerCny: string, quantity: string) {
  normalizeDecimal(baseCny, { min: '0', max: '1000000', maxScale: 8, allowZero: false });
  normalizeDecimal(pointsPerCny, { min: '0.1', max: '10000', maxScale: 1 });
  normalizeDecimal(quantity, { min: '0', max: '10000000', maxScale: 8, allowZero: false });
  const exactCredits = multiplyDecimal([baseCny, pointsPerCny, quantity]);
  const credits = roundDecimal(exactCredits, 1, 'half_up');
  if (compareDecimal(credits, '10000000') > 0) throw new PricingNumberError('收费超出单任务上限');
  return { credits, exactCredits, roundedToZero: credits === '0' && exactCredits !== '0' };
}
