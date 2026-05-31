const DEFAULT_USD_TO_CNY_RATE = 7.2;

function configuredUsdToCnyRate() {
  const raw = process.env.NEXT_PUBLIC_USD_CNY_RATE;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_USD_TO_CNY_RATE;
}

export const USD_TO_CNY_RATE = configuredUsdToCnyRate();

function trimFixed(value: number, digits: number) {
  return value.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
}

function formatMoney(value: number, digits: number) {
  return digits <= 2 ? value.toFixed(digits) : trimFixed(value, digits);
}

function cnyDigits(value: number) {
  const abs = Math.abs(value);
  if (abs > 0 && abs < 0.01) return 6;
  if (abs > 0 && abs < 1) return 4;
  return 2;
}

function normalizeCurrency(currency?: string | null) {
  return currency?.trim().toUpperCase() || '';
}

export function usdToCny(value: number) {
  return value * USD_TO_CNY_RATE;
}

export function usdToCnyRateText() {
  return `1 USD ≈ ¥${trimFixed(USD_TO_CNY_RATE, 2)}`;
}

export function formatCnyAmount(value: number) {
  const digits = cnyDigits(value);
  return `¥${formatMoney(value, digits)}`;
}

export function formatCurrencyAmount(value: number, currency?: string | null, digits = 2) {
  const normalized = normalizeCurrency(currency);
  const text = formatMoney(value, digits);

  if (normalized === 'USD') {
    return `$${text} USD（约 ${formatCnyAmount(usdToCny(value))}）`;
  }
  if (normalized === 'CNY') {
    return `¥${text}`;
  }
  return normalized ? `${text} ${normalized}` : text;
}

export function formatCnyAmountFixed(value: number) {
  return `¥${value.toFixed(2)}`;
}

export function formatCurrencyAmountWithFixedCny(value: number, currency?: string | null) {
  const normalized = normalizeCurrency(currency);
  const text = value.toFixed(2);

  if (normalized === 'USD') {
    return `$${text} USD（约 ${formatCnyAmountFixed(usdToCny(value))}）`;
  }
  if (normalized === 'CNY') {
    return `¥${text}`;
  }
  return normalized ? `${text} ${normalized}` : text;
}

export function formatAmountMinorWithCny(amount: number | null | undefined, currency?: string | null) {
  if (amount === null || amount === undefined) return '待官方确认';
  return formatCurrencyAmount(amount / 100, currency, 2);
}

export function formatAmountMicrosWithCny(amount: number | null | undefined, currency?: string | null) {
  if (amount === null || amount === undefined) return '待官方确认';
  return formatCurrencyAmount(amount / 1_000_000, currency, 6);
}

export function formatAmountMinorWithFixedCny(amount: number | null | undefined, currency?: string | null) {
  if (amount === null || amount === undefined) return '待官方确认';
  return formatCurrencyAmountWithFixedCny(amount / 100, currency);
}

export function formatAmountMicrosWithFixedCny(amount: number | null | undefined, currency?: string | null) {
  if (amount === null || amount === undefined) return '待官方确认';
  return formatCurrencyAmountWithFixedCny(amount / 1_000_000, currency);
}

export function formatUsdCnyEstimateFromInput(amount: string, currency: string) {
  if (normalizeCurrency(currency) !== 'USD') return '';
  const normalizedAmount = amount.trim().replace(/[,，]/g, '');
  if (!normalizedAmount) return '';
  const value = Number(normalizedAmount);
  if (!Number.isFinite(value) || value < 0) return '';
  return `约 ${formatCnyAmount(usdToCny(value))}，按 ${usdToCnyRateText()}`;
}

export function amountMinorToCnyEstimate(amount: number | null | undefined, currency?: string | null) {
  if (amount === null || amount === undefined) return '';
  if (normalizeCurrency(currency) !== 'USD') return '';
  return formatCnyAmount(usdToCny(amount / 100));
}

export function amountMicrosToCnyEstimate(amount: number | null | undefined, currency?: string | null) {
  if (amount === null || amount === undefined) return '';
  if (normalizeCurrency(currency) !== 'USD') return '';
  return formatCnyAmount(usdToCny(amount / 1_000_000));
}

export function costAmountToCnyEstimate(input: {
  amount_minor?: number | null;
  amount_micros?: number | null;
  currency?: string | null;
}) {
  if (input.amount_micros !== null && input.amount_micros !== undefined) {
    return amountMicrosToCnyEstimate(input.amount_micros, input.currency);
  }
  return amountMinorToCnyEstimate(input.amount_minor, input.currency);
}
