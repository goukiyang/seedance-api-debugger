import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildRatioPickerGroups } from '../src/app/image-studio/ratio-picker-groups';
import { STUDIO_RATIOS } from '../src/lib/image-studio/ratios';

// Offline display/value contracts only. Actual layout, focus and custom editing
// remain subject to user acceptance; this fixture sends no business requests.
const expected = [
  ['1:1', '16:9', '9:16', '4:3', '3:4'],
  ['5:4', '3:2', '2:1', '21:9', '3:1', '4:1'],
  ['4:5', '2:3', '1:2', '9:21', '1:3'],
];
const groups = buildRatioPickerGroups([], '16:9');
assert.deepEqual(groups.map(group => group.id), ['auto', 'common', 'landscape', 'portrait', 'custom']);
assert.deepEqual(groups.map(group => group.title), [null, '常用', '其他横向', '其他竖向', '自定义']);
assert.deepEqual(groups[0].rows, [{ label: '自动（跟随原图）', ratio: 'auto', removable: false }]);
assert.deepEqual(groups.slice(1, 4).map(group => group.rows.map(row => row.ratio)), expected);
assert.deepEqual(groups.slice(1, 4).map(group => group.rows.map(row => row.label)), expected);
const standardRows = groups.slice(1, 4).flatMap(group => group.rows);
assert.equal(standardRows.length, 16);
assert.equal(new Set(standardRows.map(row => row.ratio)).size, 16);
assert.deepEqual(standardRows.map(row => row.ratio).sort(), STUDIO_RATIOS.slice().sort());
assert.ok(standardRows.every(row => !row.removable));
assert.equal(groups.flatMap(group => group.rows).filter(row => row.ratio === '16:9').length, 1);
assert.deepEqual(groups[4].rows, []);
const numericRatio = (ratio: string) => { const [width, height] = ratio.split(':').map(Number); return width / height; };
expected.slice(1).forEach((ratios, groupIndex) => {
  ratios.slice(1).forEach((ratio, index) => {
    assert.ok(groupIndex === 0 ? numericRatio(ratio) > numericRatio(ratios[index]) : numericRatio(ratio) < numericRatio(ratios[index]));
  });
});

const custom = ['5:3', '10:6', 'auto', '21:9', '7:3', '7:5', 'invalid', '0:1', '2:5', '7:5'];
const originalCustom = custom.slice();
const customGroups = buildRatioPickerGroups(custom, '5:3');
assert.deepEqual(customGroups[4].rows, [
  { label: '5:3', ratio: '5:3', removable: true },
  { label: '7:5', ratio: '7:5', removable: true },
  { label: '2:5', ratio: '2:5', removable: true },
]);
assert.deepEqual(custom, originalCustom, 'sorting must not rewrite saved custom values');
assert.equal(customGroups.flatMap(group => group.rows).filter(row => row.ratio === 'auto').length, 1);
assert.equal(customGroups.flatMap(group => group.rows).filter(row => row.ratio === '21:9').length, 1);
assert.deepEqual(buildRatioPickerGroups(custom, 'auto')[4].rows, customGroups[4].rows);
assert.deepEqual(buildRatioPickerGroups(custom, '11:7')[4].rows.slice(-1), [
  { label: '11:7（当前参数）', ratio: '11:7', removable: false },
]);
assert.deepEqual(buildRatioPickerGroups([], '32:18')[4].rows, [
  { label: '32:18（当前参数）', ratio: '32:18', removable: false },
], 'historical current parameter must keep its exact spelling');
assert.deepEqual(buildRatioPickerGroups(['10:6'], '10:6')[4].rows, [
  { label: '5:3', ratio: '5:3', removable: true },
  { label: '10:6（当前参数）', ratio: '10:6', removable: false },
]);

const root = resolve(process.argv[2] || process.cwd());
const picker = readFileSync(resolve(root, 'src/app/image-studio/ratio-picker.tsx'), 'utf8');
const css = readFileSync(resolve(root, 'src/app/image-studio/studio.module.css'), 'utf8');
assert.ok(picker.includes('const groups = buildRatioPickerGroups(custom, value)'));
assert.ok(picker.includes('groups.map(group =>'));
assert.ok(picker.includes('group.rows.map(renderRatioRow)'));
assert.ok(picker.indexOf('group.rows.map(renderRatioRow)') < picker.indexOf("group.id === 'custom'"), 'other-ratio action follows custom rows');
assert.ok(picker.includes("querySelectorAll<HTMLButtonElement>('[data-ratio-option]:not(:disabled)')"), 'arrow keys follow DOM order across groups');
assert.ok(picker.includes("'[data-ratio-option][aria-pressed=\"true\"]'"), 'opening focuses the current choice');
assert.ok(picker.includes('selected?.focus({ preventScroll: true })'));
assert.ok(picker.includes('menu.current.scrollTop +='), 'current choice stays in view when the menu scrolls');
assert.ok(picker.includes('aria-pressed={!other && value === ratio}'));
assert.ok(picker.includes('disabled={disabled || busy} onClick={() => select(ratio)}'));
assert.ok(picker.includes('onChange(ratio);'));
assert.ok(picker.includes('await onCustom(ratio, true)'));
assert.ok(picker.includes('if (await onCustom(ratio, false)) select(ratio)'));
assert.ok(picker.includes('onEditing(other)'));
assert.match(css, /\.ratioGroups\s*\{[^}]*display:\s*grid/);
assert.match(css, /\.ratioCards\s*\{[^}]*grid-template-columns:\s*repeat\(5,/);
assert.match(css, /@media\s*\(max-width:\s*420px\)\s*\{\s*\.ratioCards\s*\{[^}]*repeat\(4,/);
assert.match(css, /\.ratioAuto\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/);
assert.doesNotMatch(css, /\.ratio(?:Groups|Group|Cards|CardWrap)\s*\{[^}]*(?:grid-auto-flow|order)\s*:/, 'CSS must not reorder the DOM flow');
console.log('ratio picker group/value contracts passed (offline; no browser acceptance)');
