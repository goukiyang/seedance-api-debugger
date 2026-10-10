const DEFAULT_USD_TO_CNY_RATE = 7;
const configuredUsdToCnyRate = () => {
  const raw = process.env.NEXT_PUBLIC_USD_CNY_RATE;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_USD_TO_CNY_RATE;
};

export const USD_TO_CNY_RATE = configuredUsdToCnyRate();
export const CNY_CONVERSION_UNAVAILABLE = '缺少人民币换算依据';
export const MONEY_AMOUNT_UNAVAILABLE = '金额不可用';

const cnyFormatter = new Intl.NumberFormat('zh-CN', {
  style: 'currency',
  currency: 'CNY',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function normalizeCurrency(currency?: string | null) {
  return currency?.trim().toUpperCase() || '';
}

function resolveUsdToCnyRate(rate?: number | null) {
  if (rate === undefined) return USD_TO_CNY_RATE;
  return typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? rate : null;
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

export function currencyAmountToCny(value: number, currency?: string | null, rate?: number | null) {
  if (!Number.isFinite(value)) return null;
  const normalized = normalizeCurrency(currency);
  if (normalized === 'CNY') return value;
  if (normalized !== 'USD') return null;

  const exchangeRate = resolveUsdToCnyRate(rate);
  if (exchangeRate === null) return null;
  const converted = value * exchangeRate;
  return Number.isFinite(converted) ? converted : null;
}

export function usdToCny(value: number, rate?: number | null) {
  return currencyAmountToCny(value, 'USD', rate);
}

export function usdToCnyRateText(rate?: number | null) {
  const exchangeRate = resolveUsdToCnyRate(rate);
  if (exchangeRate === null) return '人民币换算汇率未配置';
  return `${formatCnyAmount(exchangeRate)} / 美元`;
}

export function formatCnyAmount(value: number) {
  if (!Number.isFinite(value)) return MONEY_AMOUNT_UNAVAILABLE;
  return cnyFormatter.format(value).replace('￥', '¥');
}

export function formatCurrencyAmount(value: number, currency?: string | null, digits = 2, rate?: number | null) {
  void digits;
  return formatCurrencyAmountWithFixedCny(value, currency, rate);
}

export function formatCnyAmountFixed(value: number) {
  return formatCnyAmount(value);
}

export function formatCurrencyAmountWithFixedCny(value: number, currency?: string | null, rate?: number | null) {
  if (!Number.isFinite(value)) return MONEY_AMOUNT_UNAVAILABLE;
  const converted = currencyAmountToCny(value, currency, rate);
  if (converted !== null) return formatCnyAmountFixed(converted);

  const normalized = normalizeCurrency(currency);
  if (normalized === 'USD' && resolveUsdToCnyRate(rate) !== null) return MONEY_AMOUNT_UNAVAILABLE;
  return CNY_CONVERSION_UNAVAILABLE;
}

export function formatAmountMinorWithCny(amount: number | null | undefined, currency?: string | null, rate?: number | null) {
  if (amount === null || amount === undefined) return '待官方确认';
  return formatCurrencyAmount(amount / 100, currency, 2, rate);
}

export function formatAmountMicrosWithCny(amount: number | null | undefined, currency?: string | null, rate?: number | null) {
  if (amount === null || amount === undefined) return '待官方确认';
  return formatCurrencyAmount(amount / 1_000_000, currency, 2, rate);
}

export function formatAmountMinorWithFixedCny(amount: number | null | undefined, currency?: string | null, rate?: number | null) {
  if (amount === null || amount === undefined) return '待官方确认';
  return formatCurrencyAmountWithFixedCny(amount / 100, currency, rate);
}

export function formatAmountMicrosWithFixedCny(amount: number | null | undefined, currency?: string | null, rate?: number | null) {
  if (amount === null || amount === undefined) return '待官方确认';
  return formatCurrencyAmountWithFixedCny(amount / 1_000_000, currency, rate);
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

export function formatUsdCnyEstimateFromInput(amount: string, currency: string, rate?: number | null) {
  if (normalizeCurrency(currency) !== 'USD') return '';
  const normalizedAmount = amount.trim().replace(/[,，]/g, '');
  if (!normalizedAmount) return '';
  const value = Number(normalizedAmount);
  if (!Number.isFinite(value) || value < 0) return MONEY_AMOUNT_UNAVAILABLE;
  if (value === 0) return formatCnyAmount(0);

  const estimate = formatCurrencyAmountWithFixedCny(value, 'USD', rate);
  if (!estimate.startsWith('¥')) return estimate;
  return `约 ${estimate}，按 ${usdToCnyRateText(rate)}`;
}

export function amountMinorToCnyEstimate(amount: number | null | undefined, currency?: string | null, rate?: number | null) {
  if (amount === null || amount === undefined) return '';
  return formatCurrencyAmountWithFixedCny(amount / 100, currency, rate);
}

export function amountMicrosToCnyEstimate(amount: number | null | undefined, currency?: string | null, rate?: number | null) {
  if (amount === null || amount === undefined) return '';
  return formatCurrencyAmountWithFixedCny(amount / 1_000_000, currency, rate);
}

export function costAmountToCnyEstimate(input: {
  amount_minor?: number | null;
  amount_micros?: number | null;
  currency?: string | null;
  rate?: number | null;
}) {
  if (input.amount_micros !== null && input.amount_micros !== undefined) {
    return amountMicrosToCnyEstimate(input.amount_micros, input.currency, input.rate);
  }
  return amountMinorToCnyEstimate(input.amount_minor, input.currency, input.rate);
}
