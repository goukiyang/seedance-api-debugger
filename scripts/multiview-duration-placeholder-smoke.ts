import assert from 'node:assert/strict';
import { applyMultiviewDuration, composeMultiviewGenerationPrompt, MULTIVIEW_ROTATION_PRESET, renderMultiviewDurationPlaceholders as render,
  type MultiviewRotationPreset } from '../src/lib/video/multiview-generation-contract';

const t = '前{{前段}}秒转身，后{{后段}}秒回正，共{{时长}}秒。';
assert.equal(render(t, 8), '前4秒转身，后4秒回正，共8秒。');
assert.equal(render(t, 9), '前4.5秒转身，后4.5秒回正，共9秒。');
assert.equal(render('前4秒、后4秒', 12), '前4秒、后4秒', 'placeholders only');

// The timing clause is always appended, so a template with no seconds still follows the chosen duration.
assert.match(applyMultiviewDuration('水平旋转一圈，再向前翻转一圈。', 8), /总时长8秒：第0–4秒完成第一段动作，第4–8秒完成第二段动作/);
assert.match(applyMultiviewDuration('水平旋转一圈，再向前翻转一圈。', 15), /总时长15秒：第0–7.5秒完成第一段动作，第7.5–15秒/);

const preset = { id: MULTIVIEW_ROTATION_PRESET.id, version: '1.0.0', prompt: '水平旋转一圈。' } as MultiviewRotationPreset;
const sent = composeMultiviewGenerationPrompt('细节', '1.0.0', preset, 10);
assert.ok(sent.valid && sent.prompt.startsWith('水平旋转一圈。\n\n【时长控制】视频总时长10秒') && sent.prompt.endsWith('细节'));
assert.equal(composeMultiviewGenerationPrompt('细节', '1.0.0', preset, 10, false).prompt.includes('时长控制'), false, 'legacy retry wording');
const check = composeMultiviewGenerationPrompt('', '1.0.0', preset);
assert.ok(check.valid && check.characters > sent.characters - '\n\n补充要求'.length - 40, 'checks reserve the clause');
console.log('multiview duration smoke: ok');
