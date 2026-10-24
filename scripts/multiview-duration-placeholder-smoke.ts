import assert from 'node:assert/strict';
import { renderMultiviewDurationPlaceholders as render } from '../src/lib/video/multiview-generation-contract';

const t = '前{{前段}}秒转身，后{{后段}}秒回正，共{{时长}}秒。';
assert.equal(render(t, 8), '前4秒转身，后4秒回正，共8秒。');
assert.equal(render(t, 9), '前4.5秒转身，后4.5秒回正，共9秒。');
assert.equal(render(t, 15), '前7.5秒转身，后7.5秒回正，共15秒。');
assert.equal(render('前4秒、后4秒', 12), '前4秒、后4秒', 'templates without placeholders are unchanged');
console.log('multiview duration placeholder smoke: ok');
