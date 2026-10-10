import {
  amountMicrosToCnyEstimate,
  formatAmountMicrosWithFixedCny,
  formatAmountMinorWithFixedCny,
  formatCnyAmountFixed,
  formatProviderUsdCharge,
  usdToCny,
} from '../src/lib/costs/currency';

function assertEqual(actual: string | null, expected: string, label: string) {
  if (actual !== expected) {
    throw new Error(`${label}: expected "${expected}", got "${actual}"`);
  }
}

function assertIncludes(actual: string | null, expected: string, label: string) {
  if (!actual?.includes(expected)) {
    throw new Error(`${label}: expected "${actual}" to include "${expected}"`);
  }
}

const converted = usdToCny(0.354466);
if (converted === null) throw new Error('Configured USD display conversion unavailable');
const usdMicrosText = formatCnyAmountFixed(converted);

assertEqual(formatAmountMicrosWithFixedCny(354466, 'USD'), usdMicrosText, 'USD micros displayed in CNY only');
assertEqual(
  formatProviderUsdCharge({
    provider_cost_currency: 'USD',
    provider_official_amount_micros: 354466,
  }),
  usdMicrosText,
  'provider charge displayed in CNY only',
);
assertEqual(formatAmountMinorWithFixedCny(237, 'CNY'), '¥2.37', 'CNY minor fixed amount');
assertEqual(formatAmountMinorWithFixedCny(null, 'USD'), '待官方确认', 'null amount fallback');
assertIncludes(formatAmountMicrosWithFixedCny(1, 'USD'), '¥', 'tiny USD retains RMB-only formatting');
assertEqual(formatAmountMicrosWithFixedCny(0, 'CNY'), '¥0.00', 'known zero is valid');
assertEqual(
  amountMicrosToCnyEstimate(354466, 'USD'),
  usdMicrosText,
  'export CNY estimate is fixed',
);
assertEqual(amountMicrosToCnyEstimate(354466, 'CNY'), '¥0.35', 'CNY original amount is not converted');

console.log('[currency-format-smoke] passed');
