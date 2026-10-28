import assert from 'node:assert/strict';
import { createMultiviewReferenceRecipe, resizeMultiviewReference, clampReferencePlacement, referencePixelGeometry, referenceDividerSegments } from '../src/lib/video/multiview-reference-layout';
import { defaultMultiviewWorkRecipe, parseMultiviewWorkRecipe, multiviewWorkContentSignature, multiviewWorkDimensions } from '../src/lib/video/multiview-work-contract';
import type { MultiviewInfo } from '../src/lib/video/multiview-contract';

const info: MultiviewInfo = { taskId: 'engineering-source', sourceVersion: 'a'.repeat(64), width: 720, height: 1280, duration: 5,
  timestamps: Array.from({ length: 100 }, (_, index) => index / 20) };
const slots = Array.from({ length: 4 }, (_, index) => ({ id: `shot-${index}`, frame: index * 20, name: '', manual: false }));
const outputs = [{ width: 1920, height: 1080, background: '#d6dbdf' }, { width: 1080, height: 1920, background: '#d6dbdf' }, { width: 1536, height: 1536, background: '#d6dbdf' }];
for (const count of [2, 3, 4]) for (const output of outputs) {
  const recipe = createMultiviewReferenceRecipe(info, slots.slice(0, count), output);
  assert.ok(parseMultiviewWorkRecipe(recipe, info), `${count} shots could not be read`);
  const geometry = referencePixelGeometry(recipe, info);
  assert.deepEqual(multiviewWorkDimensions(info, recipe), { width: output.width, height: output.height });
  for (const image of geometry.placements) {
    const panel = geometry.panels.find(item => item.slotId === image.slotId)!;
    assert.ok(image.x >= panel.x && image.y >= panel.y && image.x + image.width <= panel.x + panel.width && image.y + image.height <= panel.y + panel.height, 'image escaped its shot');
    assert.ok(Math.abs(image.width / image.height - info.width / info.height) < .01, 'source ratio changed');
  }
  const disabled = { ...recipe, divider: { ...recipe.divider, enabled: false } };
  assert.deepEqual(referencePixelGeometry(disabled, info), geometry, 'divider switch changed geometry');
  assert.notEqual(multiviewWorkContentSignature(recipe), multiviewWorkContentSignature(disabled), 'divider switch did not invalidate content');
  const altered = { ...recipe, placements: recipe.placements.map(item => ({ ...item })) };
  altered.placements[0] = clampReferencePlacement({ ...altered.placements[0], x: 500, y: -500, width: .2 }, recipe.panels[0], info, output);
  assert.deepEqual(altered.panels, recipe.panels, 'moving a subject moved shot boundaries');
  assert.deepEqual(altered.placements.slice(1), recipe.placements.slice(1), 'moving one subject rearranged other shots');
  const roundTrip = resizeMultiviewReference(resizeMultiviewReference(recipe, info, outputs[(outputs.indexOf(output) + 1) % outputs.length]), info, output);
  for (let i = 0; i < recipe.placements.length; i++) for (const key of ['x', 'y', 'width', 'height'] as const) {
    assert.ok(Math.abs(roundTrip.placements[i][key] - recipe.placements[i][key]) < .000001, 'ratio round trip cumulatively shrank or moved a subject');
  }
}
const two = createMultiviewReferenceRecipe(info, slots.slice(0, 2), outputs[0]);
assert.deepEqual(referenceDividerSegments(two), [{ x1: .5, y1: 0, x2: .5, y2: 1 }], 'two shots do not have one full-height middle line');
const four = createMultiviewReferenceRecipe(info, slots, outputs[0]);
assert.equal(referenceDividerSegments(four).length, 2, 'four shots have duplicate crossing strokes');
assert.equal(parseMultiviewWorkRecipe({ ...two, sourceVersion: 'b'.repeat(64) }, info), null, 'foreign source version accepted');
assert.equal(parseMultiviewWorkRecipe({ ...two, panels: [null, null] }, info), null, 'malformed panel accepted');
assert.equal(parseMultiviewWorkRecipe({ ...two, placements: [{ ...two.placements[0], x: NaN }, two.placements[1]] }, info), null, 'non-finite placement accepted');
assert.equal(parseMultiviewWorkRecipe({ ...two, panels: [two.panels[0], { ...two.panels[1], x: 0 }] }, info), null, 'overlapping shots accepted');
assert.equal(parseMultiviewWorkRecipe({ ...two, placements: [{ ...two.placements[0], x: .75 }, two.placements[1]] }, info), null, 'subject crossed its shot');
assert.equal(parseMultiviewWorkRecipe({ ...two, output: { ...two.output, width: 16384, height: 16384 } }, info), null, 'pixel limit bypassed');
assert.equal(parseMultiviewWorkRecipe({ ...two, divider: { ...two.divider, color: 'url(https://invalid)' } }, info), null, 'untrusted divider color accepted');
assert.equal(parseMultiviewWorkRecipe({ ...two, schema: 2 }, info), null, 'two-shot reference converted to legacy recipe');
const old = defaultMultiviewWorkRecipe(info);
assert.ok(parseMultiviewWorkRecipe(old, info), 'old eight-frame recipe no longer reads');
assert.equal(parseMultiviewWorkRecipe({ ...old, slots: slots.slice(0, 2) }, info), null, 'legacy 3/4/8 invariant was relaxed');
console.log('multiview reference geometry/contracts: 9 ratio/count cases and source/geometry/schema boundaries passed');
