import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const preview = readFileSync(new URL('../src/components/ZoomableImagePreview.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/components/ZoomableImagePreview.module.css', import.meta.url), 'utf8');
const comparison = readFileSync(new URL('../src/lib/media/image-comparison.ts', import.meta.url), 'utf8');

for (const kind of ['permission', 'deleted', 'identity-version-change', 'transient', 'cancelled']) {
  assert.ok(comparison.includes(`'${kind}'`), `comparison failure kind missing: ${kind}`);
}
assert.match(comparison, /localStorage\.getItem\(key\) !== expected\.storageSnapshot[\s\S]{0,160}localStorage\.removeItem\(key\)/,
  'invalid selection cleanup must compare the exact stored value before removal');

const restore = preview.slice(preview.indexOf('const saved = readComparisonSelection'), preview.indexOf('const incomingIdentity'));
assert.match(restore, /if \(!saved\.enabled\)[\s\S]{0,240}kind: 'dormant'[\s\S]{0,80}return;/,
  'a disabled saved comparison must remain dormant without background resolution');
assert.ok(restore.indexOf("if (!saved.enabled)") < restore.indexOf('resolveStoredComparison(saved, false'),
  'disabled comparison handling must precede background resolution');
assert.match(preview, /selection\.context === config\.selectionContext && selection\.phase === 'writable'/,
  'selection persistence must wait for the resolved scene guard');
assert.match(preview, /expectedAction !== undefined && userAction\.current !== expectedAction/,
  'stale image requests must not apply after a newer user action');
assert.ok(preview.includes('clearComparisonSelectionIfUnchanged(owner, selectionAnchor, saved)'),
  'confirmed invalid recovery must use compare-and-clear');
assert.ok(preview.includes('comparisonResolveRequest.current?.abort()'),
  'comparison recovery must remain cancellable');
assert.ok(preview.includes('title="\u5173\u95ed\u5bf9\u6bd4\u63d0\u793a"'),
  'active comparison failure must provide a close control');
assert.ok(!preview.includes('\u4e0a\u6b21\u5bf9\u6bd4\u56fe\u5df2\u5931\u6548\uff0c\u8bf7\u91cd\u65b0\u9009\u62e9'),
  'legacy persistent comparison error must not return');

assert.match(css, /\.compareFrame \{[^}]*inset: 0;[^}]*gap: 0;/,
  'the full viewport image stage must not retain an inset or gap');
assert.match(css, /\.comparePane \{[^}]*border: 0;/, 'image panes must not retain card borders');
assert.match(css, /\.compareHorizontal::after \{[^}]*width: 1px;/, 'left/right comparison needs one vertical 1px divider');
assert.match(css, /\.compareVertical::after \{[^}]*height: 1px;/, 'top/bottom comparison needs one horizontal 1px divider');
assert.match(css, /\.singleFrame::after \{ display: none; \}/, 'single image view must not render a divider');
assert.match(css, /\.compareImage \{[^}]*max-width: 100%;[^}]*max-height: 100%;[^}]*object-fit: contain;/,
  'single and comparison images must contain within the real pane');
assert.ok(!preview.includes('frame.width - 24') && !preview.includes('frame.height - 24'),
  'fit geometry must use the real pane dimensions without the removed padding');

console.log('W10/W11 static source contract passed');
