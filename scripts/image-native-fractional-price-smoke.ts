import assert from 'node:assert/strict';
import { allowsUnconfirmedGeminiProParameters, imageApiGroupModelMissingRequirements } from '../src/lib/integrations/image-generation-channel';

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

let readinessAssertions = 0;
for (const model of ['gemini-nano-banana-2.1', 'gemini-3-pro-image-preview']) {
  const configured = { model, enabled: true, providerSupported: true, baseUrlConfigured: true, apiKeyConfigured: true,
    protocol: 'gemini_native' as const, billingMode: 'fixed' as const, fixedPoints: 0.6,
    qualities: null, resolutions: null, ratios: ['1:1'], maxReferences: null };
  assert.deepEqual(imageApiGroupModelMissingRequirements(configured), []);
  readinessAssertions++;
  const explicitLimits = imageApiGroupModelMissingRequirements({ ...configured, qualities: [], resolutions: [], maxReferences: -1 });
  assert.deepEqual(explicitLimits, ['尚未确认支持的图片质量', '尚未确认支持的分辨率', '尚未确认参考图上限']);
  readinessAssertions++;
  for (const [field, message] of [['apiKeyConfigured', '尚未配置 API Key'], ['baseUrlConfigured', '尚未配置 API 地址']] as const) {
    assert.ok(imageApiGroupModelMissingRequirements({ ...configured, [field]: false }).includes(message));
    readinessAssertions++;
  }
  assert.ok(imageApiGroupModelMissingRequirements({ ...configured, enabled: false }).includes('尚未确认支持的图片质量'));
  readinessAssertions++;
  for (const other of ['gemini-3.1-flash-image-preview', 'gpt-image-2']) {
    assert.ok(imageApiGroupModelMissingRequirements({ ...configured, model: other }).includes('尚未确认支持的图片质量'));
    readinessAssertions++;
  }
  for (const fixedPoints of [null, -0.1, Infinity, NaN]) {
    assert.ok(imageApiGroupModelMissingRequirements({ ...configured, fixedPoints }).includes('固定点数未填写或无效，明确免费时请填写 0'));
    readinessAssertions++;
  }
}
console.log(`PASS API group readiness: ${readinessAssertions} assertions; no provider calls`);
