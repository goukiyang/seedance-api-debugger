import assert from 'node:assert/strict';
import { buildStudioPoseVariations, STUDIO_POSE_VARIATION_MARKER } from '../src/lib/image-studio/pose-variation';

const personal = '只保留一个角色，俯视镜头，并做出一些有挑战又酷的pose';
const template = `${STUDIO_POSE_VARIATION_MARKER}\n保留身份、干净背景，人物直视镜头。`;
assert.equal(buildStudioPoseVariations('原模板普通提示词', personal, 'request-a', 3), undefined);
assert.equal(buildStudioPoseVariations(undefined, personal, 'request-a', 3), undefined);
for (let count = 1; count <= 8; count++) {
  const prompts = buildStudioPoseVariations(template, personal, 'request-a', count)!;
  assert.equal(prompts.length, count);
  const states = prompts.map(prompt => prompt.split('本张动作分配：\n')[1].split('：')[0]);
  assert.equal(new Set(states).size, count, 'Each accepted child gets a distinct body-state family');
  assert.deepEqual(prompts, buildStudioPoseVariations(template, personal, 'request-a', count), 'Same request recovery never redraws');
  for (const prompt of prompts) {
    assert.ok(!prompt.includes(STUDIO_POSE_VARIATION_MARKER));
    assert.ok(prompt.startsWith('保留身份、干净背景，人物直视镜头。'));
    assert.ok(prompt.endsWith(`本次个人要求：\n${personal}`));
    assert.ok(prompt.includes('用户本次明确指定的动作优先'));
    assert.ok(prompt.includes('若主体是商品，忽略人体动作分配'));
  }
}
const orders = Array.from({ length: 16 }, (_, index) => JSON.stringify(buildStudioPoseVariations(template, personal, `new-request-${index}`, 3)));
assert.ok(new Set(orders).size > 1, 'New requests can select different families and order');
const explicit = '人物静止站立，双手放下';
assert.ok(buildStudioPoseVariations(template, explicit, 'request-b', 3)!.every(prompt => prompt.endsWith(explicit)));
console.log(JSON.stringify({ passed: true, checks: ['unmarked-unchanged', 'count1-through8-unique', 'same-request-stable',
  'new-request-varies', 'personal-instructions-last', 'product-scope', 'marker-not-sent'] }));
