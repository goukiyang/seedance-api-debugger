import assert from 'node:assert/strict';
import { allowsUnconfirmedGeminiProParameters } from '../src/lib/integrations/image-generation-channel';

let assertions = 0;
for (const [model, price] of [
  ['gemini-nano-banana-2.1', 0.6],
  ['gemini-3-pro-image-preview', 0.7],
] as const) {
  const capability = { enabled: true, protocol: 'gemini_native', billingMode: 'fixed', fixedPoints: price };
  for (const fixedPoints of [0, price, 5]) {
    assert.equal(allowsUnconfirmedGeminiProParameters(model, { ...capability, fixedPoints }), true);
    assertions++;
  }
  for (const fixedPoints of [null, undefined, -0.1, NaN, Infinity]) {
    assert.equal(allowsUnconfirmedGeminiProParameters(model, { ...capability, fixedPoints }), false);
    assertions++;
  }
  for (const changed of [{ enabled: false }, { protocol: 'openai_images' }, { billingMode: 'actual' }]) {
    assert.equal(allowsUnconfirmedGeminiProParameters(model, { ...capability, ...changed }), false);
    assertions++;
  }
}
assert.equal(allowsUnconfirmedGeminiProParameters('gemini-3.1-flash-image-preview', {
  enabled: true, protocol: 'gemini_native', billingMode: 'fixed', fixedPoints: 0.6,
}), false);
console.log(`PASS native fractional pricing: ${assertions + 1} assertions`);
