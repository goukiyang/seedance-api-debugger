import assert from 'node:assert/strict';
import { parseModelAccessSettings, pricingModelAvailable, projectPricingModelAvailability,
  supplementaryModelEnabled, type PricingModelAvailability } from '../src/lib/pricing/model-availability-contract';

const base = { kind: 'image' as const, channelId: 'channel-one', modelId: 'image-one', billingMode: 'fixed' as const, unit: 'image' as const };
const scope = (id: string, specifications: Record<string, string>, available: boolean) => ({ id, identity: { ...base, specifications }, available });
const snapshot: PricingModelAvailability = { revision: 'test', supplementary: parseModelAccessSettings(null), rows: [
  scope('generic', {}, true), scope('closed-4k', { resolution: '4K' }, false), scope('open-2k', { resolution: '2K' }, true),
] };
assert.equal(pricingModelAvailable(snapshot, 'image', 'image-one', { resolution: '4K' }), false, 'exact closed scope must shadow generic open price');
assert.equal(pricingModelAvailable(snapshot, 'image', 'image-one', { resolution: '2K' }), true);
assert.equal(pricingModelAvailable(snapshot, 'image', 'image-one'), true, 'another open specification keeps model visible');
assert.equal(pricingModelAvailable(snapshot, 'image', 'image-one', {}, 'other-channel'), false);
assert.equal(pricingModelAvailable(null, 'image', 'image-one'), false, 'failed/unloaded state is not an enabled catalog');
assert.equal(pricingModelAvailable(snapshot, 'text', ''), false, 'no model selection cannot inherit an enabled switch');
assert.equal(pricingModelAvailable({ ...snapshot, rows: snapshot.rows.map(row => ({ ...row, available: false })) }, 'image', 'image-one'), false);
assert.equal(pricingModelAvailable(snapshot, 'image', 'unconfigured-model'), false);
const projected = projectPricingModelAvailability([
  { id: 'closed', identity: { ...base, specifications: {} }, pricingEnabled: false, mode: 'free', enabled: true, availability: 'ready' },
  { id: 'unset', identity: { ...base, modelId: 'unset', specifications: {} }, mode: 'unset', enabled: true, availability: 'ready' },
], 'revision', snapshot.supplementary);
assert.equal(projected.rows.some(row => row.available), false, 'closed is not free, missing prices stay unavailable');
assert.equal(supplementaryModelEnabled(snapshot.supplementary, 'text', 'gpt-6-sol'), true, 'existing billing contract is inherited');
const settings = parseModelAccessSettings(JSON.stringify({ version: 1, revision: 'changed', models: [
  { kind: 'text', model: 'gpt-6-sol', enabled: false }, { kind: 'cutout', model: 'all', enabled: false },
] }));
assert.equal(supplementaryModelEnabled(settings, 'text', 'gpt-6-sol'), false);
assert.equal(supplementaryModelEnabled(settings, 'text', 'gpt-6-astra'), true);
assert.equal(supplementaryModelEnabled(settings, 'cutout', 'sam2'), false);
assert.equal(supplementaryModelEnabled(settings, 'cutout', 'auto'), false);
assert.throws(() => parseModelAccessSettings('{broken'));
assert.throws(() => parseModelAccessSettings(JSON.stringify({ ...settings, models: [...settings.models, settings.models[0]] })));
assert.throws(() => parseModelAccessSettings(JSON.stringify({ ...settings, models: [{ kind: 'text', model: 'gpt-6-sol', enabled: 'false' }] })));
console.log('Model availability: 17 pricing-scope, supplementary, and corrupt-input assertions passed; no network or model calls');
