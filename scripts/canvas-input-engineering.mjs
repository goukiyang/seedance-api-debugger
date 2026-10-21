import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// Offline only: synthetic DOM and nodes, no application, database, network, or real deletion.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceFile = 'public/tools/ultimate-canvas/canvas-engine.js';
const source = fs.readFileSync(path.join(root, sourceFile), 'utf8');
const checks = [];

class EventSurface {
  handlers = new Map();
  addEventListener(type, callback, options = false) {
    const handlers = this.handlers.get(type) || [];
    handlers.push({ callback, capture: options === true || options?.capture === true });
    this.handlers.set(type, handlers);
  }
  invoke(type, event, capture) {
    for (const handler of this.handlers.get(type) || []) {
      if (handler.capture !== capture) continue;
      handler.callback(event);
      if (event.immediateStopped) break;
    }
  }
}

class ElementFixture extends EventSurface {
  constructor(tag, document) {
    super();
    this.tagName = tag.toUpperCase();
    this.document = document;
    this.attributes = new Map();
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.classes = new Set();
    this.captures = new Set();
    this.classList = {
      add: (...values) => values.forEach(value => this.classes.add(value)),
      remove: (...values) => values.forEach(value => this.classes.delete(value)),
      contains: value => this.classes.has(value),
      toggle: (value, force = !this.classes.has(value)) => {
        if (force) this.classes.add(value); else this.classes.delete(value);
        return force;
      },
    };
  }
  set className(value) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); }
  get className() { return [...this.classes].join(' '); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  hasAttribute(name) { return this.attributes.has(name); }
  getAttribute(name) {
    if (name === 'class') return this.className;
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      return this.dataset[key] ?? this.attributes.get(name) ?? null;
    }
    return this.attributes.get(name) ?? null;
  }
  get isContentEditable() {
    const value = this.getAttribute('contenteditable');
    if (value !== null) return value !== 'false';
    return Boolean(this.parentElement?.isContentEditable);
  }
  matchesOne(selector) {
    const tag = selector.match(/^[a-z][\w-]*/i)?.[0];
    if (tag && this.tagName !== tag.toUpperCase()) return false;
    for (const [, name] of selector.matchAll(/\.([\w-]+)/g)) {
      if (!this.classes.has(name)) return false;
    }
    for (const [, name, value] of selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
      const actual = this.getAttribute(name);
      if (actual === null || (value !== undefined && value !== actual)) return false;
    }
    return true;
  }
  matches(selector) { return selector.split(',').some(part => this.matchesOne(part.trim())); }
  closest(selector) {
    for (let element = this; element; element = element.parentElement) {
      if (element.matches(selector)) return element;
    }
    return null;
  }
  querySelectorAll(selector) {
    const result = [];
    for (const child of this.children) {
      if (child.matches(selector)) result.push(child);
      result.push(...child.querySelectorAll(selector));
    }
    return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  appendChild(element) { element.parentElement = this; this.children.push(element); return element; }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
    this.parentElement = null;
  }
  contains(element) { return element === this || this.children.some(child => child.contains(element)); }
  focus() { this.document.activeElement = this; }
  getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }; }
  getClientRects() { return this.closest('[hidden], .hidden') ? [] : [this.getBoundingClientRect()]; }
  setPointerCapture(id) { this.captures.add(id); }
  hasPointerCapture(id) { return this.captures.has(id); }
  releasePointerCapture(id) { this.captures.delete(id); }
}

function fixture() {
  const window = new EventSurface();
  const document = new EventSurface();
  document.body = new ElementFixture('body', document);
  document.activeElement = document.body;
  document.hidden = false;
  document.createElement = tag => {
    const element = document.nextElement || new ElementFixture(tag, document);
    document.nextElement = null;
    return element;
  };
  document.createElementNS = (_, tag) => document.createElement(tag);
  document.querySelectorAll = selector => document.body.querySelectorAll(selector);
  document.querySelector = selector => document.querySelectorAll(selector)[0] || null;
  document.getElementById = id => {
    const search = element => element.getAttribute('id') === id ? element
      : element.children.map(search).find(Boolean) || null;
    return search(document.body);
  };
  window.getComputedStyle = element => ({ visibility: element.style.visibility || 'visible' });
  window.UltimateCanvasIcons = () => '';
  const make = (tag, parent = document.body, attributes = {}) => {
    const element = new ElementFixture(tag, document);
    for (const [key, value] of Object.entries(attributes)) {
      if (key === 'class') element.className = value; else element.setAttribute(key, value);
    }
    parent.appendChild(element);
    return element;
  };
  const workspace = make('div');
  const container = make('div', workspace, { id: 'container' });
  const canvas = make('div', container, { id: 'canvas' });
  make('svg', container, { id: 'svg' });
  const marquee = make('div', container, { id: 'selection-marquee', class: 'hidden' });
  const module = { exports: {} };
  vm.runInNewContext(source, {
    window, document, module, CSS: { escape: value => value },
    requestAnimationFrame: () => { throw new Error('Unexpected animation scheduling'); },
  }, { filename: sourceFile });
  const engine = new module.exports.CanvasEngine('container', 'canvas', 'svg');
  const effects = { deletes: [], geometry: [], saves: 0, references: 0, connections: 0, selected: 0 };
  engine.deleteNode = id => effects.deletes.push(id);
  engine._createConnection = () => { effects.connections++; };
  engine._updateConnections = () => {};
  engine.onCanvasGeometryChanged = value => effects.geometry.push(value);
  engine.onNodeSelected = () => { effects.selected++; };
  // Match app.js's existing mouseup save wrapper, without invoking any persistence.
  const mouseup = engine._onMouseUp.bind(engine);
  engine._onMouseUp = event => {
    const dragging = engine.isDraggingNode;
    mouseup(event);
    if (dragging) effects.saves++;
  };
  engine._icon = () => '';
  engine._label = () => 'Synthetic node';
  engine._body = () => '';
  engine._propsPanel = () => '';

  function node(type = 'image', id = 'node-fixture') {
    const wrap = new ElementFixture('div', document);
    const label = make('div', wrap, { class: 'node-label' });
    const card = make('div', wrap, { class: 'node-card' });
    const body = make('div', card, { class: 'node-body' });
    make('div', card, { class: 'node-connector input' });
    make('div', card, { class: 'node-connector output' });
    const data = { id, type, x: 20, y: 40, data: { authoredText: 'Retained fixture input' } };
    engine.nodes.set(id, data);
    // The declared DOM tree is a fixture, not an HTML parser or a real browser.
    document.nextElement = wrap;
    assert.equal(engine._buildNode(data), wrap);
    canvas.appendChild(wrap);
    return { id, wrap, label, card, body, data };
  }

  function dispatch(target, type, properties = {}) {
    const event = {
      target, button: 0, detail: 1, clientX: 10, clientY: 20,
      defaultPrevented: false, propagationStopped: false, immediateStopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
      stopImmediatePropagation() { this.immediateStopped = true; this.propagationStopped = true; },
      ...properties,
    };
    const route = [];
    for (let current = target; current; current = current.parentElement) route.push(current);
    if (target !== window) {
      if (!route.includes(document)) route.push(document);
      route.push(window);
    }
    for (const surface of [...route].reverse()) {
      surface.invoke(type, event, true);
      if (event.propagationStopped) return event;
    }
    for (const surface of route) {
      surface.invoke(type, event, false);
      if (event.propagationStopped) break;
    }
    return event;
  }
  const key = (value, type = 'keydown') => dispatch(document.activeElement, type, { key: value });
  return { window, document, engine, effects, workspace, container, canvas, marquee, make, node, dispatch, key };
}

function check(name, run) {
  run();
  checks.push({ name, passed: true });
}

check('stale-input-focus-returns-on-blank-and-node-surface', () => {
  for (const surface of ['canvas', 'label', 'card']) {
    const f = fixture();
    const node = f.node();
    const input = f.make('textarea');
    input.value = 'Keep this input';
    input.focus();
    f.engine.selectNode(node.id);
    f.key(' '); f.key('Delete');
    assert.equal(f.engine.isSpacePressed, false);
    assert.equal(f.effects.deletes.length, 0);
    f.dispatch(surface === 'canvas' ? f.canvas : node[surface], 'mousedown');
    f.dispatch(f.window, 'mouseup');
    assert.equal(f.document.activeElement, f.container);
    f.engine.selectNode(node.id);
    f.key(' ');
    assert.equal(f.engine.isSpacePressed, true);
    f.key(' ', 'keyup'); f.key('Delete');
    assert.deepEqual(f.effects.deletes, [node.id]);
    assert.equal(f.engine.nodes.has(node.id), true, 'Deletion is a spy only');
    assert.equal(input.value, 'Keep this input');
  }
});

for (const type of ['image', 'role']) {
  for (const surface of ['label', 'card']) {
    check(`space-pan-priority-${type}-${surface}`, () => {
      const f = fixture();
      const node = f.node(type);
      const selected = f.node('image', 'node-selected');
      f.engine.selectNode(selected.id);
      const beforeSelected = f.effects.selected;
      f.engine.onReferenceNodePick = () => { f.effects.references++; return true; };
      f.key(' ');
      const down = f.dispatch(node[surface], 'mousedown', { shiftKey: true, ctrlKey: true });
      assert.equal(down.defaultPrevented, true);
      assert.equal(f.engine.isPanning, true);
      assert.equal(f.engine.isDraggingNode, false);
      assert.equal(f.engine.selectedNodeId, selected.id);
      assert.equal(f.effects.selected, beforeSelected);
      assert.equal(f.effects.references, 0);
      f.dispatch(f.window, 'mousemove', { clientX: 50, clientY: 80 });
      assert.equal(f.engine.offsetX, 40);
      assert.equal(f.engine.offsetY, 60);
      assert.equal(node.data.x, 20);
      assert.equal(node.data.y, 40);
      f.dispatch(f.window, 'mouseup');
      f.dispatch(node[surface], 'click');
      assert.equal(f.effects.saves, 0);
      assert.equal(f.effects.connections, 0);
      assert.equal(f.effects.geometry.length, 0);
      assert.equal(f.engine.selectedNodeId, selected.id);
    });
  }
}

for (const surface of ['label', 'card']) {
  check(`ordinary-node-drag-retained-${surface}`, () => {
    const f = fixture();
    const node = f.node();
    f.dispatch(node[surface], 'mousedown');
    assert.equal(f.engine.isDraggingNode, true);
    f.dispatch(f.window, 'mousemove', { clientX: 50, clientY: 80 });
    f.dispatch(f.window, 'mouseup');
    assert.equal(node.data.x, 60);
    assert.equal(node.data.y, 100);
    assert.equal(f.effects.saves, 1);
    assert.equal(f.effects.geometry[0]?.kind, 'node-move');
  });
}

check('ordinary-selection-reference-and-middle-right-pan-retained', () => {
  const f = fixture();
  const node = f.node();
  f.dispatch(node.card, 'mousedown', { shiftKey: true });
  assert.equal(f.engine.selectedNodeIds.has(node.id), true);
  assert.equal(f.engine.isDraggingNode, false);
  f.engine.onReferenceNodePick = () => { f.effects.references++; return true; };
  f.dispatch(node.card, 'mousedown');
  assert.equal(f.effects.references, 1);
  assert.equal(f.engine.isDraggingNode, false);
  for (const button of [1, 2]) {
    f.dispatch(node.label, 'mousedown', { button });
    assert.equal(f.engine.isPanning, true);
    f.dispatch(f.window, 'mouseup', { button });
  }
});

check('interactive-edit-media-and-popover-targets-own-input', () => {
  const targets = [
    ['input'], ['textarea'], ['select'], ['button'], ['a'], ['video'], ['audio'],
    ['div', { contenteditable: 'true' }], ['div', { contenteditable: 'plaintext-only' }],
    ['div', { contenteditable: 'false' }],
    ['div', { role: 'button' }], ['div', { role: 'link' }], ['div', { role: 'dialog' }],
    ['div', { class: 'generation-popover' }], ['div', { 'data-canvas-media-preview': '' }],
  ];
  for (const [tag, attributes = {}] of targets) {
    const f = fixture();
    const node = f.node();
    f.engine.selectNode(node.id);
    const control = f.make(tag, node.body, attributes);
    control.focus();
    f.key(' '); f.key('Delete'); f.key('Backspace');
    assert.equal(f.engine.isSpacePressed, false, tag);
    assert.equal(f.effects.deletes.length, 0, tag);
    f.engine.isSpacePressed = true;
    f.dispatch(control, 'mousedown');
    assert.equal(f.document.activeElement, control, tag);
    assert.equal(f.engine.isPanning, false, tag);
    assert.equal(f.engine.isDraggingNode, false, tag);
  }
});

check('native-dialog-aria-modal-readonly-busy-and-inert-block-canvas-input', () => {
  for (const mode of ['dialog', 'aria-modal', 'readonly', 'busy', 'inert']) {
    const f = fixture();
    const node = f.node();
    f.engine.selectNode(node.id);
    if (mode === 'dialog') f.make('dialog', f.document.body, { open: '' });
    if (mode === 'aria-modal') f.make('section', f.document.body, { 'aria-modal': 'true' });
    if (mode === 'readonly') f.document.body.classList.add('canvas-document-readonly');
    if (mode === 'busy') f.document.body.classList.add('canvas-document-busy');
    if (mode === 'inert') f.workspace.setAttribute('inert', '');
    f.key(' '); f.key('Delete');
    assert.equal(f.effects.deletes.length, 0, mode);
    assert.equal(f.engine.isSpacePressed, false, mode);
    f.engine.isSpacePressed = true;
    f.dispatch(node.label, 'mousedown');
    assert.equal(f.engine.isPanning, false, mode);
    assert.equal(f.engine.isDraggingNode, false, mode);
    assert.equal(f.document.activeElement, f.document.body, mode);
  }
});

check('hidden-modal-does-not-disable-canvas', () => {
  for (const mode of ['hidden', 'class', 'visibility']) {
    const f = fixture();
    const modal = f.make('section', f.document.body, { 'aria-modal': 'true' });
    if (mode === 'hidden') modal.setAttribute('hidden', '');
    if (mode === 'class') modal.classList.add('hidden');
    if (mode === 'visibility') modal.style.visibility = 'hidden';
    f.key(' ');
    assert.equal(f.engine.isSpacePressed, true, mode);
  }
});

for (const interruption of ['blur', 'pagehide', 'hidden', 'pointercancel', 'Escape', 'busy-before-mouseup']) {
  check(`interruption-clears-only-transient-gestures-${interruption}`, () => {
    const f = fixture();
    const node = f.node();
    const member = f.node('image', 'node-member');
    f.engine.selectNodes([node.id, member.id], node.id);
    const inputBefore = JSON.stringify(node.data.data);
    f.dispatch(node.label, 'mousedown');
    f.dispatch(f.window, 'mousemove', { clientX: 50, clientY: 80 });
    assert.notEqual(node.data.x, 20);
    f.engine.isSpacePressed = f.engine.isPanning = f.engine.isSelecting = true;
    f.engine.isDrawingConnection = true;
    f.engine.connectionStartConnector = node.card.querySelector('.node-connector');
    const line = f.make('path', f.engine.svg);
    f.engine.tempConnectionLine = line;
    f.marquee.classList.remove('hidden');
    f.engine.container.style.cursor = 'grabbing';
    if (interruption === 'hidden') {
      f.document.hidden = true;
      f.dispatch(f.document, 'visibilitychange');
    } else if (interruption === 'Escape') {
      f.key('Escape');
    } else if (interruption === 'busy-before-mouseup') {
      f.document.body.classList.add('canvas-document-busy');
    } else {
      f.dispatch(f.window, interruption);
    }
    f.dispatch(f.window, 'mouseup');
    for (const flag of ['isSpacePressed', 'isPanning', 'isSelecting', 'isDraggingNode', 'isDrawingConnection']) {
      assert.equal(f.engine[flag], false, flag);
    }
    assert.equal(f.engine.dragNode, null);
    assert.equal(f.engine.dragNodeStarts, null);
    assert.equal(f.engine.tempConnectionLine, null);
    assert.equal(f.engine.connectionStartConnector, null);
    assert.equal(f.engine.container.style.cursor, 'default');
    assert.equal(node.wrap.classList.contains('dragging'), false);
    assert.equal(f.marquee.classList.contains('hidden'), true);
    assert.equal(line.parentElement, null);
    assert.equal(node.data.x, 20);
    assert.equal(member.data.x, 20);
    assert.equal(JSON.stringify(node.data.data), inputBefore);
    assert.deepEqual([...f.engine.selectedNodeIds], [node.id, member.id]);
    assert.equal(f.engine.nodes.size, 2);
    assert.equal(f.effects.deletes.length, 0);
    assert.equal(f.effects.connections, 0);
    assert.equal(f.effects.geometry.length, 0);
    assert.equal(f.effects.saves, 0);
  });
}

for (const interruption of ['pointercancel', 'lostpointercapture', 'blur']) {
  check(`touch-drag-cancel-is-not-mouseup-${interruption}`, () => {
    const f = fixture();
    const node = f.node('role');
    f.dispatch(node.label, 'pointerdown', { pointerId: 7, pointerType: 'touch' });
    assert.equal(node.label.hasPointerCapture(7), true);
    f.dispatch(node.label, 'pointermove', { pointerId: 7, clientX: 50, clientY: 80 });
    f.dispatch(interruption === 'blur' ? f.window : node.label, interruption, { pointerId: 7 });
    f.dispatch(node.label, 'pointerup', { pointerId: 7 });
    assert.equal(f.engine.nodeDragPointer, null);
    assert.equal(f.engine.isDraggingNode, false);
    assert.equal(node.label.hasPointerCapture(7), false);
    assert.equal(node.data.x, 20);
    assert.equal(f.effects.saves, 0);
    assert.equal(f.effects.geometry.length, 0);
  });
}

check('cancel-does-not-overwrite-replaced-or-updated-node-state', () => {
  for (const mode of ['replacement', 'same-object-update']) {
    const f = fixture();
    const node = f.node();
    f.dispatch(node.label, 'mousedown');
    f.dispatch(f.window, 'mousemove', { clientX: 50, clientY: 80 });
    const current = mode === 'replacement' ? { ...node.data } : node.data;
    current.x = 700; current.y = 800;
    f.engine.nodes.set(node.id, current);
    f.dispatch(f.window, 'blur');
    assert.equal(current.x, 700);
    assert.equal(current.y, 800);
    assert.equal(f.effects.saves, 0);
  }
});

const result = {
  schema: 1,
  suite: 'canvas-input-engineering',
  source: { file: sourceFile, sha256: createHash('sha256').update(source).digest('hex') },
  checks,
  limits: ['synthetic-DOM-only', 'no-browser-acceptance', 'no-menu-delete-root-cause-claim'],
};
if (process.argv[2]) {
  const destination = path.resolve(process.argv[2]);
  const actualRoot = fs.realpathSync(root);
  assert.ok(destination.startsWith(path.join(actualRoot, '.role-tests') + path.sep));
  const sources = [sourceFile, 'scripts/canvas-input-engineering.mjs',
    'public/tools/ultimate-canvas/app.js', 'public/tools/ultimate-canvas/index.html'];
  fs.writeFileSync(destination, JSON.stringify({ schema: 'canvas-input-engineering.v1', completed: true, synthetic: true,
    checks: checks.map(check => check.name),
    sourceSha256: Object.fromEntries(sources.map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')])),
    applicationDatabaseOpened: false, forbiddenCalls: 0, paidRequests: 0, browserRuns: 0,
    scope: result.limits.join('; '), result }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log('CANVAS_INPUT_ENGINEERING_RECEIPT=' + destination);
} else process.stdout.write(JSON.stringify(result, null, 2) + '\n');
