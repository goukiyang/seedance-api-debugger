import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const { CanvasEngine } = require('../public/tools/ultimate-canvas/canvas-engine.js');
const interactions = require('../public/tools/ultimate-canvas/generation-node-interactions.js');
const app = readFileSync('public/tools/ultimate-canvas/app.js', 'utf8');
function functions(names: string[]) {
  const ast = ts.createSourceFile('app.js', app, ts.ScriptTarget.Latest, true);
  const found = new Map<string, string>();
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text)) found.set(node.name.text, node.getText(ast));
    ts.forEachChild(node, visit);
  }
  visit(ast);
  names.forEach(name => assert.ok(found.has(name), name));
  return ts.transpileModule(Array.from(found.values()).join('\n') + names.map(name => `;this.${name}=${name}`).join(''),
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}

// Only the DOM operations used by the real node builder are mocked, not its audio markup.
class Element {
  innerHTML = ''; dataset: Record<string, string> = {}; style: Record<string, string> = {};
  children: Element[] = []; hidden = false; textContent = ''; offsetWidth = 350; offsetHeight = 112;
  listeners: Record<string, (event: any) => void> = {};
  parts = new Map<string, Element>();
  classList = { add() {}, remove() {}, toggle() {} };
  appendChild(child: Element) { this.children.push(child); return child; }
  addEventListener(name: string, callback: (event: any) => void) { this.listeners[name] = callback; }
  remove() {}
  querySelector(selector: string): Element | null {
    const token = selector === '[data-generation-result-region]' ? 'data-generation-result-region'
      : selector === '.node-card' ? 'class="node-card"' : selector === '.node-label' ? 'class="node-label"' : null;
    if (!token || !this.innerHTML.includes(token)) return null;
    if (!this.parts.has(selector)) this.parts.set(selector, new Element());
    return this.parts.get(selector)!;
  }
  querySelectorAll() { return []; }
}

async function main() {
  const views = new Map<string, Element>();
  const document: any = { createElement: () => new Element(), getElementById: () => null,
    querySelector: (selector: string) => views.get(selector.match(/data-node-id="([^"]+)"/)?.[1] || '') || null };
  const globals: any = globalThis;
  const previous = { document: globals.document, window: globals.window, CSS: globals.CSS };
  let selections = 0;
  const engine: any = Object.create(CanvasEngine.prototype);
  Object.assign(engine, { nodes: new Map(), connections: [], selectedNodeIds: new Set(), nextNodeId: 1,
    scale: 2, offsetX: 91, offsetY: -40, planSplits: {},
    canvas: { appendChild(view: Element) { views.set(view.dataset.nodeId, view); },
      querySelectorAll: () => Array.from(views.values()) }, svg: { querySelectorAll: () => [] },
    _notifyCanvasGeometryChanged() {}, _applyTransform() {}, _updateZoom() {}, _updateConnections() {},
    _deselectAll() {}, _selectNode() { selections++; } });
  globals.document = document; globals.window = { UltimateCanvasIcons: () => '' }; globals.CSS = { escape: (v: string) => v };
  try {
    engine.addNode('audio', -25, 80, { id: 'audio', title: 'Imported audio', source: 'upload', assetId: 'owned-audio',
      originalUrl: 'https://untrusted.invalid/raw', autoplay: true }, { select: false });
    const vm: any = { engine, document, CSS: globals.CSS, escapeHtml: (value: string) => value.replace(/"/g, '&quot;'),
      window: { UltimateCanvasGenerationInteractions: interactions }, renderGenerationNodeControls() {},
      syncImageResultActionsTrigger() {}, syncVideoTaskActionsTrigger() {}, setNodeGenerationStatus() {}, videoStageLabel() {},
      pollVideoTask() { throw new Error('imported audio must not create or poll a task'); } };
    runInNewContext(functions(['decorateGeneratedNode', 'hydrateNodeViews']), vm);
    vm.hydrateNodeViews();
    const assertAudioView = () => {
      const region = views.get('audio')!.querySelector('[data-generation-result-region]');
      assert.ok(region, 'actual _buildNode/_body audio structure must contain the decoration region');
      assert.match(region.innerHTML, /<audio\b[^>]*\bcontrols\b[^>]*preload="metadata"/);
      assert.match(region.innerHTML, /src="\/api\/content-reactions\/media\?key=asset%3Aowned-audio&amp;variant=preview"|src="\/api\/content-reactions\/media\?key=asset%3Aowned-audio&variant=preview"/);
      assert.doesNotMatch(region.innerHTML, /autoplay|untrusted\.invalid|<video\b/);
      assert.equal(engine.nodes.get('audio').data.generationStatus, undefined);
      const previousSelections = selections;
      const event = { button: 0, target: { closest: (s: string) => s.split(',').some(x => x.trim() === 'audio') ? {} : null },
        preventDefault() { throw new Error('native controls must remain usable'); }, stopPropagation() {} };
      views.get('audio')!.querySelector('.node-card')!.listeners.mousedown(event);
      views.get('audio')!.listeners.mousedown(event);
      assert.equal(selections, previousSelections, 'audio controls must not select the node, unlike normal restoration');
      assert.notEqual(engine.isDraggingNode, true);
    };
    assertAudioView();
    const saved = JSON.parse(JSON.stringify(engine.serialize()));
    views.clear(); engine.restore(saved); vm.hydrateNodeViews(); assertAudioView();
    assert.deepEqual([engine.scale, engine.offsetX, engine.offsetY], [2, 91, -40]);
    assert.deepEqual([engine.nodes.get('audio').x, engine.nodes.get('audio').y], [-25, 80]);
    process.stdout.write('PASS R1 actual audio builder + protected hydrate + serialize/restore, controls do not drag, no task or autoplay\n');
  } finally {
    globals.document = previous.document; globals.window = previous.window; globals.CSS = previous.CSS;
  }

  const rows: Element[] = [], sizes = new Map<string, number>(), calls: any[] = [], made: any[] = [];
  let counter = 0, context = 'original', firstFailed = false, tray: Element | null = null;
  const files = [{ name: 'wide.png', type: 'image/png' }, { name: 'tall.mp4', type: 'video/mp4' }, { name: 'sound.mp3', type: 'audio/mpeg' }];
  const queue: any = { CSS: { escape: (v: string) => v }, crypto: { randomUUID: () => `id-${++counter}` },
    graphEditAllowed: () => true, uploadContextKey: () => context, showCanvasNotice() {}, window: { UltimateCanvasIcons: () => '' },
    engine: { nodes: new Map(), scale: 0.5, offsetX: 17, offsetY: -29 },
    document: { querySelector: (selector: string) => selector === '[data-canvas-upload-tray]' ? tray
      : { offsetWidth: sizes.get(selector.match(/data-node-id="([^"]+)"/)?.[1] || '') || 0 },
      createElement: (tag: string) => { const el = new Element(); if (tag === 'div') rows.push(el); return el; },
      body: { appendChild: (el: Element) => { tray = el; } } },
    uploadCanvasFile: async (file: any, _: string, nodeId: string, __: unknown, requestId: string) => {
      calls.push({ file: file.name, nodeId, requestId });
      if (file.name === 'wide.png' && !firstFailed) { firstFailed = true; throw new Error('explicit file refusal'); }
      if (file.name === 'tall.mp4') { queue.engine.scale = 3; queue.engine.offsetX = 999; queue.engine.offsetY = -500; }
      return { asset: { fileName: file.name, width: 99999, height: 99999 } };
    },
    createUploadedNode: (result: any, x: number, y: number, _: unknown, nodeId: string) => {
      queue.engine.nodes.set(nodeId, { id: nodeId, x, y });
      const width = result.asset.fileName === 'wide.png' ? 1400 : result.asset.fileName === 'tall.mp4' ? 710 : 350;
      sizes.set(nodeId, width); made.push({ id: nodeId, x, y, width });
    } };
  runInNewContext(functions(['canvasUploadPosition', 'queueCanvasFiles']), queue);
  queue.queueCanvasFiles(files, -120, 75);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(made.length, 2); assert.equal(made[0].x, -120); assert.equal(made[0].y, 75);
  assert.equal(made[1].x, made[0].x + 710 + 40); assert.equal(made[1].y, 75);
  const failedRow = rows[1]; assert.equal(failedRow.children[2].hidden, false);
  failedRow.children[2].listeners.click({});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(made.length, 3); assert.equal(made[2].x, made[1].x + 350 + 40);
  assert.deepEqual(calls[0], calls[3], 'retry retains original file/request/node identity');
  assert.deepEqual(made.slice(0, 2).map(x => [x.x, x.y]), [[-120, 75], [630, 75]], 'success positions are never repacked');
  const before = JSON.stringify(made);
  failedRow.children[2].listeners.click({});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(JSON.stringify(made), before, 'already-created retry does not create or move a duplicate');
  assert.deepEqual([queue.engine.scale, queue.engine.offsetX, queue.engine.offsetY], [3, 999, -500], 'upload completion does not restore/steal changed viewport');
  const ids = made.map(x => x.id);
  const position = queue.canvasUploadPosition(ids, -120, 75);
  assert.equal(position.x, made[2].x + 1400 + 40); assert.equal(position.y, 75);
  made.forEach((a, i) => made.slice(i + 1).forEach(b => assert.ok(b.x >= a.x + a.width + 40)));
  queue.engine.nodes.delete(made[2].id);
  assert.equal(queue.canvasUploadPosition(ids, -120, 75).x, made[1].x + 350 + 40, 'removed nodes do not reserve stale space');
  context = 'other-document'; failedRow.children[2].listeners.click({});
  const callCount = calls.length; await new Promise(resolve => setImmediate(resolve)); assert.equal(calls.length, callCount);
  process.stdout.write('PASS R2 actual sequential queue/DOM-width placement, negative origin, mixed sizes, partial failure/retry identity, success preservation and changed viewport\n');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
