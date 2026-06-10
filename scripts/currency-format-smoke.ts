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

const usdMicrosText = `$0.35 USD（约 ${formatCnyAmountFixed(usdToCny(0.354466))}）`;

assertEqual(formatAmountMicrosWithFixedCny(354466, 'USD'), usdMicrosText, 'USD micros fixed dual currency');
assertEqual(
  formatProviderUsdCharge({
    provider_cost_currency: 'USD',
    provider_official_amount_micros: 354466,
  }),
  usdMicrosText,
  'provider charge uses dual currency',
);
assertEqual(formatAmountMinorWithFixedCny(237, 'CNY'), '¥2.37', 'CNY minor fixed amount');
assertEqual(formatAmountMinorWithFixedCny(null, 'USD'), '待官方确认', 'null amount fallback');
assertIncludes(formatAmountMicrosWithFixedCny(1, 'USD'), '< $0.01 USD（约', 'tiny USD does not display as zero');
assertEqual(
  amountMicrosToCnyEstimate(354466, 'USD'),
  formatCnyAmountFixed(usdToCny(0.354466)),
  'export CNY estimate is fixed',
);
assertEqual(amountMicrosToCnyEstimate(354466, 'CNY'), '', 'CNY original amount has no repeated estimate');

console.log('[currency-format-smoke] passed');
