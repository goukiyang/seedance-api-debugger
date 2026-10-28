import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { createMultiviewReferenceRecipe, clampReferencePlacement, moveReferencePlacements, scaleReferencePlacements, referencePixelGeometry,
  type ReferenceLayout, type ReferenceScaleCorner } from '../src/lib/video/multiview-reference-layout';
import type { MultiviewReferenceRecipe } from '../src/lib/video/multiview-work-contract';
import type { MultiviewInfo } from '../src/lib/video/multiview-contract';

const info: MultiviewInfo = { taskId: 'gesture-source', sourceVersion: 'a'.repeat(64), width: 720, height: 1280, duration: 5,
  timestamps: Array.from({ length: 100 }, (_, index) => index / 20) };
const slots = Array.from({ length: 4 }, (_, index) => ({ id: `shot-${index}`, frame: index * 20, name: '', manual: false }));
const outputs = [{ width: 1920, height: 1080, background: '#d6dbdf' }, { width: 1080, height: 1920, background: '#d6dbdf' }, { width: 1536, height: 1536, background: '#d6dbdf' }];
const close = (a: number, b: number, message = 'geometry differs') => assert.ok(Math.abs(a - b) < 1e-9, `${message}: ${a} / ${b}`);
const same = (a: unknown, b: unknown) => assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
function composed(count = 3, output = outputs[0], layout?: ReferenceLayout) {
  const recipe = createMultiviewReferenceRecipe(info, slots.slice(0, count), { ...output, layout });
  for (const [index, slot] of Array.from(recipe.slots.entries())) {
    recipe.placements = scaleReferencePlacements(recipe, slot.id, .48 + index * .08);
    const panel = recipe.panels[index];
    recipe.placements = moveReferencePlacements(recipe, slot.id, panel.width * .02 * index, -panel.height * .015 * index);
  }
  return recipe;
}
function within(recipe: MultiviewReferenceRecipe) {
  for (const image of recipe.placements) {
    const panel = recipe.panels.find(item => item.slotId === image.slotId)!;
    assert.ok(image.x >= panel.x - 1e-9 && image.y >= panel.y - 1e-9
      && image.x + image.width <= panel.x + panel.width + 1e-9 && image.y + image.height <= panel.y + panel.height + 1e-9, 'subject crossed its fixed shot');
    assert.ok(image.width > 0 && image.height > 0);
    close(image.width * recipe.output.width / (image.height * recipe.output.height), info.width / info.height, 'subject was stretched');
  }
}
let geometryCases = 0;
for (const count of [2, 3, 4]) for (const output of outputs) {
  const layouts: ReferenceLayout[] = count === 2 ? ['horizontal', 'vertical'] : count === 3 ? ['large-left', 'large-top', 'equal'] : ['grid'];
  for (const layout of layouts) {
    const original = composed(count, output, layout), selected = original.slots[0].id;
    const moved = { ...original, placements: moveReferencePlacements(original, selected, 999, 999, true) };
    within(moved); same(moved.panels, original.panels); same(moved.divider, original.divider);
    const expectedX = Math.min(...original.placements.map((p, i) => (original.panels[i].x + original.panels[i].width - p.width - p.x) / original.panels[i].width));
    const expectedY = Math.min(...original.placements.map((p, i) => (original.panels[i].y + original.panels[i].height - p.height - p.y) / original.panels[i].height));
    for (const [index, image] of Array.from(moved.placements.entries())) {
      close((image.x - original.placements[index].x) / original.panels[index].width, expectedX, 'group X movement diverged');
      close((image.y - original.placements[index].y) / original.panels[index].height, expectedY, 'group Y movement diverged');
    }
    const single = moveReferencePlacements(original, selected, .01, .01);
    same(single.slice(1), original.placements.slice(1));
    for (const corner of ['center', 'nw', 'ne', 'sw', 'se'] as const) {
      const scaled = { ...original, placements: scaleReferencePlacements(original, selected, 999, corner, true) };
      within(scaled); same(scaled.panels, original.panels); same(scaled.divider, original.divider);
      const factor = scaled.placements[0].width / original.placements[0].width;
      const ax = corner === 'center' ? .5 : corner.includes('w') ? 1 : 0, ay = corner === 'center' ? .5 : corner.includes('n') ? 1 : 0;
      for (const [index, image] of Array.from(scaled.placements.entries())) {
        const before = original.placements[index];
        close(image.width / before.width, factor, 'group scale diverged');
        close(image.height / before.height, factor, 'group scale stretched');
        close(image.x + image.width * ax, before.x + before.width * ax, 'image scale anchor moved');
        close(image.y + image.height * ay, before.y + before.height * ay, 'image scale anchor moved');
      }
      const pixels = referencePixelGeometry(scaled, info);
      same(pixels.panels, referencePixelGeometry(original, info).panels);
      assert.equal(pixels.placements.length, count, 'output lost a shot');
    }
    within({ ...original, placements: scaleReferencePlacements(original, selected, -99, 'center', true) });
    same(scaleReferencePlacements(original, selected, .5).slice(1), original.placements.slice(1));
    const blocked = { ...original, placements: original.placements.map((p, i) => i ? p : clampReferencePlacement({ ...p, width: 1, x: 0, y: 0 }, original.panels[0], info, original.output)) };
    const panel = blocked.panels[0], first = blocked.placements[0];
    const axis = Math.abs(first.width - panel.width) < 1e-9 ? 'x' : 'y';
    const stopped = moveReferencePlacements(blocked, selected, axis === 'x' ? .1 : 0, axis === 'y' ? .1 : 0, true);
    same(stopped, blocked.placements); // One full side constrains the whole group, never only that image.
    geometryCases++;
  }
}

// Run the actual component's gesture functions, without mounting React or opening a browser.
// This proves its undo/cancel transaction wiring; visual behaviour remains user acceptance.
const filename = path.resolve('src/app/multiview/MultiviewReferenceComposer.tsx');
const source = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'MultiviewReferenceComposer');
assert.ok(component?.body);
const names = ['edit', 'start', 'moving', 'releaseDrag', 'cancelDrag', 'finish', 'adjust', 'finishNumericGesture'];
const functions = component.body.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && Boolean(node.name && names.includes(node.name.text)));
assert.equal(functions.length, names.length);
const printer = ts.createPrinter();
const code = ts.transpileModule(functions.map(fn => printer.printNode(ts.EmitHint.Unspecified, fn, source)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText + `\nglobalThis.handlers = {${names.join(',')}};`;
function gestureContext(synchronized: boolean) {
  const initial = composed(), state = { history: [] as MultiviewReferenceRecipe[], future: [] as MultiviewReferenceRecipe[], selected: initial.slots[0].id,
    dragging: false, captured: false, prevented: 0 };
  const recipeRef = { current: initial };
  const target = { setPointerCapture: () => { state.captured = true; }, hasPointerCapture: () => state.captured,
    releasePointerCapture: () => { state.captured = false; } };
  const context = vm.createContext({ JSON, Math, recipeRef, selected: initial.slots[0].id, drag: { current: null }, numericGesture: { current: null },
    busy: false, hydrated: true, syncAdjust: synchronized, canvas: { current: { getBoundingClientRect: () => ({ width: 1000, height: 600 }) } },
    valid: () => true, setSelected: (id: string) => { state.selected = id; }, setDragging: (value: boolean) => { state.dragging = value; },
    setHistory: (update: (value: MultiviewReferenceRecipe[]) => MultiviewReferenceRecipe[]) => { state.history = update(state.history); },
    setFuture: (value: MultiviewReferenceRecipe[]) => { state.future = value; }, setRecipe: () => {}, setMessage: () => {},
    moveReferencePlacements, scaleReferencePlacements,
  });
  vm.runInContext(code, context, { filename });
  const handlers = context.handlers as Record<string, (...args: unknown[]) => void>;
  const event = (x = 100, y = 100, pointerId = 7) => ({ button: 0, pointerId, clientX: x, clientY: y, currentTarget: target,
    preventDefault: () => { state.prevented++; }, stopPropagation: () => {} });
  return { initial, state, recipeRef, context, handlers, event };
}
let gestureCases = 0;
for (const synchronized of [false, true]) {
  const { initial, state, recipeRef, handlers: h, event } = gestureContext(synchronized);
  h.start(event(), initial.slots[0].id, 'move');
  for (let i = 1; i <= 3; i++) h.moving(event(100 + i * 8, 100 + i * 5));
  assert.equal(state.history.length, 0, 'pointer moves polluted undo history');
  h.finish(event(124, 115)); h.finish(event(124, 115));
  assert.equal(state.history.length, 1, 'one pointer gesture must add exactly one undo');
  assert.equal(state.captured, false); assert.equal(state.dragging, false);
  if (!synchronized) same(recipeRef.current.placements.slice(1), initial.placements.slice(1));
  else assert.ok(recipeRef.current.placements.every((p, i) => p.x !== initial.placements[i].x));
  h.edit(state.history[0], false); same(recipeRef.current.placements, initial.placements);
  const cancelled = gestureContext(synchronized);
  cancelled.handlers.start(cancelled.event(), initial.slots[0].id, 'move');
  cancelled.handlers.moving(cancelled.event(130, 120)); cancelled.handlers.finish(cancelled.event(), true);
  same(cancelled.recipeRef.current.placements, cancelled.initial.placements); assert.equal(cancelled.state.history.length, 0);
  assert.equal(cancelled.state.captured, false); assert.equal(cancelled.state.dragging, false);
  const keyboardCancelled = gestureContext(synchronized);
  keyboardCancelled.handlers.start(keyboardCancelled.event(), initial.slots[0].id, 'move');
  keyboardCancelled.handlers.moving(keyboardCancelled.event(130, 120)); keyboardCancelled.handlers.cancelDrag();
  same(keyboardCancelled.recipeRef.current.placements, keyboardCancelled.initial.placements);
  assert.equal(keyboardCancelled.state.history.length, 0);
  const idle = gestureContext(synchronized);
  idle.handlers.start(idle.event(), initial.slots[0].id, 'move'); idle.handlers.finish(idle.event());
  assert.equal(idle.state.history.length, 0, 'a click must not create a fake undo');
  const precise = gestureContext(synchronized); precise.context.numericGesture.current = precise.initial;
  precise.handlers.adjust({ x: precise.initial.placements[0].x + .01 }, false);
  precise.handlers.adjust({ x: precise.initial.placements[0].x + .02 }, false); precise.handlers.finishNumericGesture();
  assert.equal(precise.state.history.length, 1); assert.ok(precise.state.history[0], 'numeric undo captured a cleared ref');
  precise.handlers.edit(precise.state.history[0], false); same(precise.recipeRef.current.placements, precise.initial.placements);
  for (const corner of ['nw', 'ne', 'sw', 'se'] as ReferenceScaleCorner[]) {
    const scaled = gestureContext(synchronized);
    scaled.handlers.start(scaled.event(), initial.slots[0].id, 'scale', corner);
    scaled.handlers.moving(scaled.event(100 + (corner.includes('w') ? -12 : 12), 100 + (corner.includes('n') ? -12 : 12)));
    scaled.handlers.finish(scaled.event()); assert.equal(scaled.state.history.length, 1); within(scaled.recipeRef.current);
  }
  gestureCases++;
}
console.log(`multiview reference gestures: ${geometryCases} layout/ratio cases and ${gestureCases} independent/synchronized handler transactions passed`);
