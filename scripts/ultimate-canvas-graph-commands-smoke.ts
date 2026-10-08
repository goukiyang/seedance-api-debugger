import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { CanvasEngine } = require('../public/tools/ultimate-canvas/canvas-engine.js');
const { createCanvasCommands } = require('../public/tools/ultimate-canvas/canvas-commands.js');
const { groupSelected, ungroupSelected, listGroups } = require('../public/tools/ultimate-canvas/canvas-groups.js');
const { computeMinimapModel } = require('../public/tools/ultimate-canvas/canvas-minimap.js');

const TOOLFLOW_CONNECTIONS: Record<string, Set<string>> = {
  'flow-input': new Set(['flow-template', 'flow-select', 'flow-confirm', 'flow-output']),
  'flow-template': new Set(['flow-template', 'flow-select', 'flow-confirm', 'flow-output']),
  'flow-select': new Set(['flow-template', 'flow-select', 'flow-confirm', 'flow-output']),
  'flow-confirm': new Set(['flow-template', 'flow-select', 'flow-confirm', 'flow-output']),
  'flow-output': new Set(),
};

class FakeCanvasEngine {
  nodes = new Map<string, any>();
  connections: Array<{ from: string; to: string }> = [];
  selectedNodeIds = new Set<string>();
  selectedNodeId: string | null = null;
  nextNodeId = 1;
  planSplits: any = null;
  geometryEvents: any[] = [];

  getSelectedNodeIds() { return Array.from(this.selectedNodeIds); }

  selectNodes(ids: string[], primaryId: string | null) {
    this.selectedNodeIds = new Set(ids.filter(id => this.nodes.has(id)));
    this.selectedNodeId = primaryId && this.selectedNodeIds.has(primaryId) ? primaryId : Array.from(this.selectedNodeIds).at(-1) || null;
  }

  addNodeForCommand(type: string, x: number, y: number, data: Record<string, any>) {
    const id = String(data.id || `node-${this.nextNodeId++}`);
    if (this.nodes.has(id)) return null;
    const copy = { ...data };
    delete copy.id;
    this.nodes.set(id, { id, type, x, y, data: copy });
    const match = id.match(/^node-(\d+)$/);
    if (match) this.nextNodeId = Math.max(this.nextNodeId, Number(match[1]) + 1);
    return id;
  }

  connectNodesForCommand(from: string, to: string) {
    if (!this.nodes.has(from) || !this.nodes.has(to)) return false;
    if (CanvasEngine.prototype._connectionValidationError.call(this, from, to)) return false;
    this.connections.push({ from, to });
    return true;
  }

  applyCommandSnapshot(snapshot: any) {
    if (!Array.isArray(snapshot.nodes) || !Array.isArray(snapshot.connections)) return false;
    const beforeIds = new Set(this.nodes.keys());
    const nextNodes = new Map<string, any>(snapshot.nodes.map((node: any): [string, any] => [node.id, { ...node, data: { ...(node.data || {}) } }]));
    const nextIds = new Set(nextNodes.keys());
    for (const edge of snapshot.connections) {
      if (CanvasEngine.prototype._connectionValidationError.call({ nodes: nextNodes, connections: snapshot.connections.filter((item: any) => item !== edge) }, edge.from, edge.to)) return false;
    }
    this.nodes = nextNodes;
    this.connections = snapshot.connections.map((edge: any) => ({ from: edge.from, to: edge.to }));
    this.planSplits = snapshot.planSplits || null;
    this.nextNodeId = Math.max(this.nextNodeId, snapshot.nextNodeId || 1);
    const afterIds = new Set(this.nodes.keys());
    return {
      removedNodeIds: Array.from(beforeIds).filter(id => !afterIds.has(id)),
      addedNodeIds: Array.from(afterIds).filter(id => !beforeIds.has(id)),
      changedNodeIds: [],
    };
  }

  _notifyCanvasGeometryChanged(kind: string, details: any = {}) {
    this.geometryEvents.push({ kind, ...details });
  }
}

function selectionCopyAndHistorySmoke() {
  const engine = new FakeCanvasEngine();
  engine.nodes.set('asset-node', { id: 'asset-node', type: 'image', x: 10, y: 20, data: {
    source: 'asset', assetId: 'asset-42', referenceImageId: 'ref-42', originalUrl: 'https://media.invalid/original.png',
  } });
  engine.nodes.set('image-node', { id: 'image-node', type: 'image', x: 300, y: 20, data: {
    prompt: 'keep the original reference', referenceImageIds: ['ref-42'], taskId: 'paid-task-1',
    generationPayload: { kind: 'image', requestId: 'request-1' }, generationResult: { assetId: 'generated-1' },
    generationStatus: 'succeeded', imageUrl: 'https://media.invalid/generated.png', assetId: 'generated-1',
  } });
  engine.nodes.set('video-node', { id: 'video-node', type: 'video', x: 600, y: 20, data: { prompt: 'outside selected subgraph' } });
  engine.connections = [
    { from: 'asset-node', to: 'image-node' },
    { from: 'image-node', to: 'video-node' },
  ];
  engine.selectedNodeIds = new Set(['asset-node', 'image-node']);
  const commands = createCanvasCommands(engine);
  const copied = commands.duplicateSelection();
  assert.equal(copied.ok, true);
  assert.equal(copied.createdIds.length, 2);
  assert.equal(engine.connections.length, 3, 'only the internal selected-subgraph edge is copied');
  const copiedAsset = engine.nodes.get(copied.idMap['asset-node']);
  const copiedImage = engine.nodes.get(copied.idMap['image-node']);
  assert.equal(copiedAsset.data.assetId, 'asset-42', 'asset copies retain the original asset ID, not file bytes');
  assert.equal(copiedAsset.data.referenceImageId, 'ref-42');
  assert.equal(copiedAsset.data.originalUrl, undefined, 'ephemeral media URLs are not duplicated');
  assert.deepEqual(copiedImage.data.referenceImageIds, ['ref-42']);
  assert.equal(copiedImage.data.taskId, undefined);
  assert.equal(copiedImage.data.generationPayload, undefined);
  assert.equal(copiedImage.data.generationResult, undefined);
  assert.equal(copiedImage.data.generationStatus, undefined);
  assert.equal(copiedImage.data.assetId, undefined, 'generated output identity is not copied into a new node');

  assert.ok(commands.undo());
  assert.equal(engine.nodes.has(copied.createdIds[0]), false);
  assert.ok(commands.redo());
  assert.equal(engine.nodes.has(copied.createdIds[0]), true);
}

function runtimeTruthAndRecoverySmoke() {
  const engine = new FakeCanvasEngine();
  const video = { id: 'video-1', type: 'video', x: 0, y: 0, data: {
    prompt: 'before edit', taskId: 'task-9', generationStatus: 'running', frozenCost: 180,
    videoSubmission: {
      state: 'accepted', requestId: 'request-9', taskId: 'task-9', userId: 'user-1', documentId: 'doc-1',
      input: { prompt: 'before edit', model: 'video-model', duration: 5 },
      generationPayload: { nodeId: 'video-1', kind: 'video', requestId: 'request-9', settings: { model: 'video-model' } },
    },
    videoHistory: [{ taskId: 'task-9', status: 'running' }],
  } };
  engine.nodes.set(video.id, video);
  const commands = createCanvasCommands(engine);
  const edit = commands.begin('提示词');
  video.data.prompt = 'after edit';
  commands.commit(edit);
  video.data.generationStatus = 'succeeded';
  video.data.frozenCost = 180;
  video.data.videoHistory = [{ taskId: 'task-9', status: 'succeeded' }];
  engine.nodes.set('provider-result', { id: 'provider-result', type: 'image', x: 20, y: 20,
    data: { generationStatus: 'succeeded', taskId: 'new-paid-result' } });
  assert.ok(commands.undo());
  assert.equal(engine.nodes.get('video-1').data.prompt, 'before edit');
  assert.equal(engine.nodes.get('video-1').data.generationStatus, 'succeeded', 'undo keeps current task truth');
  assert.equal(engine.nodes.get('video-1').data.frozenCost, 180, 'undo cannot roll back the frozen charge');
  assert.equal(engine.nodes.get('video-1').data.videoSubmission.state, 'accepted');
  assert.equal(engine.nodes.get('provider-result').data.taskId, 'new-paid-result', 'unrelated Provider result nodes survive undo');
  assert.ok(commands.redo());
  assert.equal(engine.nodes.get('video-1').data.prompt, 'after edit');
  assert.equal(engine.nodes.get('video-1').data.generationStatus, 'succeeded');

  const remove = commands.begin('删除节点');
  engine.nodes.delete('video-1');
  engine.connections = [];
  commands.commit(remove);
  assert.ok(commands.undo());
  const restored = engine.nodes.get('video-1').data;
  assert.equal(restored.videoSubmission.state, 'unconfirmed', 'restored request must be reconciled, not resent');
  assert.equal(restored.videoSubmission.requestId, 'request-9');
  assert.equal(restored.videoSubmission.generationPayload.nodeId, 'video-1');
  assert.equal(restored.generationStatus, 'unconfirmed', 'historical task status is not replayed');
}

function allRuntimeKindsSmoke() {
  for (const type of ['image', 'audio', 'text', 'script', 'video']) {
    const engine = new FakeCanvasEngine();
    engine.nodes.set('a', { id: 'a', type, x: 0, y: 0, data: { prompt: 'before', status: 'running',
      state: 'pending', result: { old: true }, generatedText: 'old', storyRequest: { state: 'pending' } } });
    const commands = createCanvasCommands(engine);
    const token = commands.begin('edit');
    engine.nodes.get('a').data.prompt = 'after';
    commands.commit(token);
    Object.assign(engine.nodes.get('a').data, { status: 'done', state: 'complete', result: { fresh: true },
      generatedText: 'fresh', storyRequest: { state: 'unconfirmed' } });
    assert.equal(commands.checkpoint('provider'), false, 'provider state alone is not an edit');
    commands.undo();
    assert.equal(engine.nodes.get('a').data.status, 'done');
    assert.deepEqual(engine.nodes.get('a').data.result, { fresh: true });
    assert.equal(engine.nodes.get('a').data.generatedText, 'fresh');
    assert.equal(engine.nodes.get('a').data.storyRequest.state, 'unconfirmed');
    const remove = commands.begin('remove');
    engine.nodes.delete('a'); commands.commit(remove); commands.undo();
    assert.equal(engine.nodes.get('a').data.generatedText, undefined);
    assert.equal(engine.nodes.get('a').data.result, undefined);
    assert.equal(engine.nodes.get('a').data.generationStatus, 'unconfirmed');
    assert.equal(engine.nodes.get('a').data.storyRequest.state, 'unconfirmed');
  }
}
allRuntimeKindsSmoke();

function groupAndBoundedHistorySmoke() {
  const engine = new FakeCanvasEngine();
  engine.nodes.set('a', { id: 'a', type: 'text', x: 0, y: 0, data: { prompt: 'A' } });
  engine.nodes.set('b', { id: 'b', type: 'image', x: 40, y: 0, data: { prompt: 'B' } });
  engine.selectedNodeIds = new Set(['a', 'b']);
  const commands = createCanvasCommands(engine, { maxEntries: 2, maxBytes: 32 * 1024 });
  const grouped = groupSelected(engine, commands, { id: 'group-smoke', name: '镜头组' });
  assert.equal(grouped.ok, true);
  assert.deepEqual(listGroups(engine), [{ id: 'group-smoke', name: '镜头组', nodeIds: ['a', 'b'] }]);
  assert.ok(commands.undo());
  assert.equal(listGroups(engine).length, 0);
  assert.ok(commands.redo());
  assert.equal(ungroupSelected(engine, commands).ok, true);
  assert.equal(listGroups(engine).length, 0);

  for (const [id, prompt] of [['a', 'one'], ['b', 'two'], ['a', 'three']] as const) {
    const token = commands.begin('编辑提示词');
    engine.nodes.get(id).data.prompt = prompt;
    commands.commit(token);
  }
  assert.equal(commands.getState().undoCount, 2, 'history retains no more than the configured entry bound');
  assert.ok(commands.undo());
  assert.ok(commands.undo());
  assert.equal(commands.undo(), false, 'older history is trimmed at the bound');
}

function typedEdgesAndMinimapSmoke() {
  const nodes = new Map([
    ['a', { id: 'a', type: 'flow-template' }],
    ['b', { id: 'b', type: 'flow-select' }],
    ['c', { id: 'c', type: 'flow-output' }],
  ]);
  const validator = CanvasEngine.prototype._connectionValidationError;
  const edges = [{ from: 'a', to: 'b' }];
  assert.equal(validator.call({ nodes, connections: edges }, 'b', 'a')?.reason, 'toolflow-cycle');
  assert.equal(validator.call({ nodes, connections: edges }, 'c', 'a')?.reason, 'incompatible-toolflow-edge');
  assert.equal(validator.call({ nodes, connections: edges }, 'a', 'c'), null);

  const model = computeMinimapModel({
    width: 240, height: 140, padding: 12,
    nodes: [{ id: 'a', type: 'flow-template', x: 1000, y: 800, width: 360, height: 260 }],
    viewport: { scale: 1, offsetX: -1000, offsetY: -800 },
    viewportSize: { width: 600, height: 420 },
  });
  assert.ok(model.mapScale > 0);
  assert.ok(model.nodes[0].drawWidth > 0 && model.nodes[0].drawHeight > 0);
  assert.ok(model.viewport.width > 0 && model.viewport.height > 0, 'minimap models the live viewport');
}

function integrationContractSmoke() {
  const engineSource = readFileSync('public/tools/ultimate-canvas/canvas-engine.js', 'utf8');
  assert.ok(engineSource.includes('getSelectedNodeIds()'));
  assert.ok(engineSource.includes('addNodeForCommand('));
  assert.ok(engineSource.includes('connectNodesForCommand('));
  assert.ok(engineSource.includes('applyCommandSnapshot('));
  assert.ok(engineSource.includes('centerAt(x, y)'));
  assert.ok(engineSource.includes('TOOLFLOW_CONNECTIONS'));
}

function main() {
  const moving: any = new FakeCanvasEngine();
  moving.nodes.set('a', { id: 'a', type: 'text', x: 100, y: 20, data: { canvasGroup: { id: 'g' } } });
  moving.nodes.set('b', { id: 'b', type: 'image', x: 200, y: 70, data: { canvasGroup: { id: 'g' } } });
  CanvasEngine.prototype._selectDragNodes.call(moving, 'a');
  assert.deepEqual(moving.getSelectedNodeIds(), ['a', 'b']);
  Object.assign(moving, { scale: 1, isDraggingNode: true, dragNode: { dataset: { nodeId: 'a' }, style: {} },
    dragStartX: 0, dragStartY: 0, nodeStartX: 100, nodeStartY: 20, _updateConnections() {} });
  const oldDocument = globalThis.document, oldCss = globalThis.CSS;
  Object.assign(globalThis, { document: { querySelector: () => ({ style: {} }) }, CSS: { escape: (id: string) => id } });
  try { CanvasEngine.prototype._onMouseMove.call(moving, { clientX: 40, clientY: 15 }); }
  finally { Object.assign(globalThis, { document: oldDocument, CSS: oldCss }); }
  assert.equal(moving.nodes.get('a').x, 140);
  assert.equal(moving.nodes.get('b').x, 240);
  assert.equal(moving.nodes.get('b').y, 85);
  selectionCopyAndHistorySmoke();
  runtimeTruthAndRecoverySmoke();
  groupAndBoundedHistorySmoke();
  typedEdgesAndMinimapSmoke();
  integrationContractSmoke();
  console.log('ultimate canvas graph commands smoke passed');
}

main();
