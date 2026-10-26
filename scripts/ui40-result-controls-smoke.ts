import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

type Element = { type: any; props: any };
const read = (file: string) => readFileSync(file, 'utf8');
const jsx = (type: any, props: any): Element => ({ type, props: props || {} });
function all(value: any): Element[] {
  if (Array.isArray(value)) return value.flatMap(all);
  if (!value || typeof value !== 'object' || !value.props) return [];
  return [value, ...all(value.props.children)];
}
function load(file: string, initial: any[] = [], stubs: Record<string, any> = {}) {
  const states = initial.slice(); let cursor = 0;
  const hooks = {
    useState(value: any) { const index = cursor++; if (!(index in states)) states[index] = value; return [states[index], (next: any) => { states[index] = typeof next === 'function' ? next(states[index]) : next; }]; },
    useRef: (current: any) => ({ current }), useCallback: (fn: any) => fn, useEffect() {},
  };
  const exports: any = {};
  const code = ts.transpileModule(read(file), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const context: any = { exports, Map, Set, setTimeout, clearTimeout, document: { activeElement: null }, HTMLElement: class {}, requestAnimationFrame: (fn: any) => fn(),
    require(name: string) {
      if (name === 'react') return hooks;
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'fragment' };
      if (name.endsWith('.css')) return { default: new Proxy({}, { get: (_, key) => key }) };
      return stubs[name] || new Proxy({}, { get: (_, key) => String(key) });
    } };
  runInNewContext(code, context);
  return { exports, states, context, render(fn: any, props: any) { cursor = 0; return fn(props); } };
}

const cover = load('src/components/ResultImageCover.tsx');
const events: string[] = [];
const props = { src: '/owned-preview', alt: 'result', selected: true, applied: true,
  onSelect: () => events.push('select'), onViewed: () => events.push('viewed'), onPreview: () => events.push('preview') };
let tree = cover.render(cover.exports.ResultImageCover, props);
const click = (detail: number) => ({ detail, stopPropagation() { events.push('stop'); }, currentTarget: { querySelector: () => ({ complete: true, naturalWidth: 900 }) } });
tree.props.onClick(click(1));
assert.deepEqual(events, ['stop', 'select', 'viewed', 'preview']);
events.length = 0; tree.props.onClick(click(0));
assert.deepEqual(events, ['stop', 'select', 'viewed', 'preview'], 'native keyboard click uses the same ordered callback');
events.length = 0; tree.props.onClick(click(2)); assert.deepEqual(events, ['stop'], 'second rapid click does not reopen/select');
assert.equal(tree.props.onDoubleClick, undefined);
assert.equal(tree.props['aria-describedby'], undefined);
assert.ok(!all(tree).some(node => node.props.role === 'tooltip'));
const img = all(tree).find(node => node.type === 'img')!; img.props.onError();
tree = cover.render(cover.exports.ResultImageCover, props);
events.length = 0; tree.props.onClick(); assert.deepEqual(events, [], 'failed read only resets the read attempt, never selects or previews');
assert.match(tree.props['aria-label'], /重试读取/);
console.log('PASS cover actual click, keyboard click, repeated click and failed-read callbacks');

const item = { id: 'one', label: 'image', status: 'ready', media: { src: '/original', thumbnailSrc: '/preview', contentKey: 'asset:owned' }, download() {} };
let selected = 0, previewed = 0;
const results = load('src/components/GeneratedImageResults.tsx', [], {
  './ResultImageCover': { ResultImageCover: 'cover' }, './ZoomableImagePreview': { ZoomableImagePreview: 'zoom' },
  './content-reactions/ContentReactions': { default: 'reactions' },
  './useResultPages': { useResultPages: () => ({ pageItems: [item], gridRef: { current: null }, goToId() {}, start: 0, page: 1, pages: 1, capacity: 6 }) },
});
const resultProps = { items: [item], scope: 'test', onSelect: () => selected++, onPreviewChange: (value: any) => { if (value) previewed++; },
  renderDelete: () => jsx('button', { title: 'Delete' }), renderActions: () => jsx('button', { title: 'Restore' }), renderPrimaryActions: () => jsx('button', { title: 'Save person' }) };
tree = results.render(results.exports.GeneratedImageResults, resultProps);
const nodes = all(tree), coverNode = nodes.find(node => node.type === 'cover')!;
coverNode.props.onSelect(); coverNode.props.onPreview();
assert.equal(selected, 1, 'cover preview must not call selection twice'); assert.equal(previewed, 1);
assert.equal(nodes.find(node => node.type === 'reactions')!.props.parentControlled, true);
for (const title of ['Delete', 'Restore']) {
  const target = nodes.find(node => node.type === 'button' && node.props.title === title)!;
  assert.ok(nodes.some(node => node.props['data-result-secondary'] !== undefined && all(node).includes(target)), `${title} shares the parent's reveal gate`);
}
const primary = nodes.find(node => node.type === 'button' && node.props.title === 'Save person')!;
assert.ok(!nodes.some(node => node.props['data-result-secondary'] !== undefined && all(node).includes(primary)), 'primary operation is not hidden by hover');
const actions = nodes.find(node => node.props.className === 'actions')!;
let stopped = 0; actions.props.onClick({ stopPropagation() { stopped++; } }); actions.props.onPointerDown({ stopPropagation() { stopped++; } }); assert.equal(stopped, 2);
tree = results.render(results.exports.GeneratedImageResults, resultProps);
assert.equal(all(tree).find(node => node.type === 'zoom')!.props.src, '/original', 'preview keeps original, not thumbnail');
console.log('PASS actual shared result tree selects once, delegates reveal, reserves delete and keeps primary visible/original preview');

const sheet = load('src/app/tools/avatar-studio/sheet-preview.tsx', [{ src: '/sheet', width: 800, height: 800 }, { width: 300, height: 300 }], {
  '@/lib/avatar-random/layout': { avatarSheetSize: () => 2, avatarCellLabel: (_: any, index: number) => `${index + 1}` },
  '@/lib/avatar-random/sheet-geometry': { containImageSize: () => ({ width: 300, height: 300 }) },
});
const cells: number[] = []; let opened = 0;
tree = sheet.render(sheet.exports.AvatarSheetPreview, { src: '/sheet', layout: '2x2', index: 0, overlay: true, onSelect: (index: number) => cells.push(index), onPreview: () => opened++ });
const cell = all(tree).filter(node => node.type === 'button')[2];
cell.props.onClick({ detail: 1, stopPropagation() {} }); assert.deepEqual(cells, [2]); assert.equal(opened, 1);
cell.props.onClick({ detail: 2, stopPropagation() {} }); assert.equal(opened, 1);
cell.props.onClick({ detail: 0, stopPropagation() {} }); assert.deepEqual(cells, [2, 2]); assert.equal(opened, 2);
cell.props.onKeyDown({ key: 'ArrowLeft', preventDefault() {} }); assert.deepEqual(cells, [2, 2, 1]); assert.equal(opened, 2, 'arrow moves selection without opening');
assert.equal(cell.props.onDoubleClick, undefined);
console.log('PASS actual Avatar cell selection precedes preview; keyboard and arrows retain their distinct roles');

const reactions = load('src/components/content-reactions/ContentReactions.tsx', [], {
  '@/lib/context/AppSessionContext': { useAppSession: () => ({ user: { id: 'owner' } }) }, './LikeButton': { default: 'like' }, './ImageShareButton': { default: 'share' },
});
runInNewContext("update('owner','asset:owned',{state:{key:'asset:owned',available:true,liked:true,version:1,likeCount:12}})", reactions.context);
for (const parentControlled of [false, true]) {
  tree = reactions.render(reactions.exports.default, { contentKey: 'asset:owned', overlay: true, parentControlled });
  assert.match(tree.props.className, parentControlled ? /parentOverlayControls/ : /overlayControls/);
  const like = all(tree).find(node => node.type === 'like')!; assert.equal(like.props.active, true); assert.equal(like.props.count, 12);
  assert.equal(all(tree).some(node => node.props['data-result-secondary'] !== undefined), parentControlled, 'parent reveal is opt-in, other likes keep self visibility');
}
const css = read('src/components/GeneratedImageResults.module.css');
assert.match(css, /@media \(hover: hover\) and \(pointer: fine\)/);
assert.match(css, /\.card \[data-result-secondary\] \{ opacity: 0; pointer-events: none/);
assert.match(css, /\.card:focus-within \[data-result-secondary\]/);
assert.match(css, /\.deleteSlot \{[^}]*right: 8px; bottom: 8px/);
assert.match(css, /\.deleteSlot button \{[^}]*width: 32px; height: 32px/);
assert.match(css, /\.actions \{ min-height: 32px/);
assert.match(read('src/components/ResultImageCover.module.css'), /\.applied \{[^}]*right: 8px; top: 8px/);
const avatar = read('src/app/tools/avatar-studio/studio.tsx');
assert.match(avatar, /renderDelete=\{\(\{record\}\) => !record.deletedAt/);
assert.match(avatar, /downloadAvatarCell\(item.media!\.src,avatarLayout\(plan\),index\)/);
assert.match(read('src/app/cutout/page.tsx'), /matchingOriginal\?\.src/);
assert.ok(!read('src/app/cutout/page.tsx').includes('renderDelete='));
console.log('PASS scoped liked reveal, stable 32px delete/footer and preserved original crop/cutout no-delete contract; visual/manual acceptance not run');
