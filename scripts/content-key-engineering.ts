import assert from 'node:assert/strict';
import { tryContentKeyParts } from '../src/lib/content-reactions/key';
import { CONTENT_TYPES } from '../src/lib/content-reactions/types';

const defaultPreset = 'image_template:module-source:default-cmpipakyk001nmt1wx4t7wxzg';
assert.deepEqual(tryContentKeyParts(defaultPreset), {
  key: defaultPreset, type: 'image_template', id: 'module-source:default-cmpipakyk001nmt1wx4t7wxzg',
});
const allowed = [
  'image_template:module-source:default-other',
  'image_template:module-source:default-user_1',
  'image_template:module-source:11111111-1111-4111-8111-111111111111',
  'image_module:default-other',
  'image_template:' + 'a'.repeat(165),
  ...CONTENT_TYPES.map(type => `${type}:existing-id_1`),
];
for (const key of allowed) assert.equal(tryContentKeyParts(key)?.key, key, key);
const rejected: unknown[] = [
  'image_template:module-source:default-',
  'image_template:module-source:default-other:extra',
  'image_template:module-source:default-../other',
  'image_template:module-source:default-other/extra',
  'image_template:module-source:default-other extra',
  'image_template:module-source:unrecognized',
  'image_template:module-source:11111111-1111-1111-8111-111111111111',
  'asset:module-source:default-other',
  'video_template:module-source:default-other',
  'unknown:ordinary-id',
  'image_template:' + 'a'.repeat(166),
  'image_template:', '', null, undefined, {}, 1,
];
for (const key of rejected) assert.equal(tryContentKeyParts(key), null, String(key));
console.log(JSON.stringify({ passed: true, checks: 1 + allowed.length + rejected.length,
  actualSource: true, synthetic: true, productionWrites: 0, networkCalls: 0 }));
