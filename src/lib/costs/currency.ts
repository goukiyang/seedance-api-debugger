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

function formatFixedMoneyWithFloor(value: number, prefix = '', suffix = '') {
  const abs = Math.abs(value);
  if (value !== 0 && abs < 0.01) {
    const floor = `${prefix}0.01${suffix}`;
    return value < 0 ? `> -${floor}` : `< ${floor}`;
  }
  return `${prefix}${value.toFixed(2)}${suffix}`;
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

export type ProviderUsdChargeInput = {
  provider_cost_currency?: string | null;
  provider_final_amount_micros?: number | null;
  provider_official_amount_micros?: number | null;
  provider_final_amount_minor?: number | null;
  provider_official_amount_minor?: number | null;
  provider_actual_cost?: number | null;
  provider_actual_cost_currency?: string | null;
};

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
  return formatFixedMoneyWithFloor(value, '¥');
}

export function formatCurrencyAmountWithFixedCny(value: number, currency?: string | null) {
  const normalized = normalizeCurrency(currency);

  if (normalized === 'USD') {
    return `${formatFixedMoneyWithFloor(value, '$', ' USD')}（约 ${formatCnyAmountFixed(usdToCny(value))}）`;
  }
  if (normalized === 'CNY') {
    return formatCnyAmountFixed(value);
  }
  const text = formatFixedMoneyWithFloor(value);
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

export function formatProviderUsdCharge(input: ProviderUsdChargeInput): string | null {
  const currency = normalizeCurrency(input.provider_cost_currency || input.provider_actual_cost_currency);
  if (currency !== 'USD') return null;

  const amountMicros = input.provider_final_amount_micros ?? input.provider_official_amount_micros;
  if (amountMicros !== null && amountMicros !== undefined) {
    return formatCurrencyAmountWithFixedCny(amountMicros / 1_000_000, currency);
  }

  const amountMinor = input.provider_final_amount_minor ?? input.provider_official_amount_minor;
  if (amountMinor !== null && amountMinor !== undefined) {
    return formatCurrencyAmountWithFixedCny(amountMinor / 100, currency);
  }

  if (input.provider_actual_cost !== null && input.provider_actual_cost !== undefined) {
    return formatCurrencyAmountWithFixedCny(input.provider_actual_cost, currency);
  }

  return null;
}

export function formatUsdCnyEstimateFromInput(amount: string, currency: string) {
  if (normalizeCurrency(currency) !== 'USD') return '';
  const normalizedAmount = amount.trim().replace(/[,，]/g, '');
  if (!normalizedAmount) return '';
  const value = Number(normalizedAmount);
  if (!Number.isFinite(value) || value < 0) return '';
  return `约 ${formatCnyAmountFixed(usdToCny(value))}，按 ${usdToCnyRateText()}`;
}

export function amountMinorToCnyEstimate(amount: number | null | undefined, currency?: string | null) {
  if (amount === null || amount === undefined) return '';
  if (normalizeCurrency(currency) !== 'USD') return '';
  return formatCnyAmountFixed(usdToCny(amount / 100));
}

export function amountMicrosToCnyEstimate(amount: number | null | undefined, currency?: string | null) {
  if (amount === null || amount === undefined) return '';
  if (normalizeCurrency(currency) !== 'USD') return '';
  return formatCnyAmountFixed(usdToCny(amount / 1_000_000));
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
