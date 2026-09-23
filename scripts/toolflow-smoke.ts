import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateToolFlowGraph } from '../src/lib/tools/toolflow';

const graph = {
  version: 1,
  nodes: [
    { id: 'input', type: 'flow-input', data: {} },
    { id: 'template-a', type: 'flow-template', data: { prompt: 'a' } },
    { id: 'select', type: 'flow-select', data: {} },
    { id: 'confirm', type: 'flow-confirm', data: {} },
    { id: 'output', type: 'flow-output', data: {} },
  ],
  connections: [
    { from: 'input', to: 'template-a' },
    { from: 'template-a', to: 'select' },
    { from: 'select', to: 'confirm' },
    { from: 'confirm', to: 'output' },
  ],
};

assert.equal(validateToolFlowGraph(graph).nodes.length, 5);
assert.equal(validateToolFlowGraph({ ...graph, nodes: graph.nodes.map(node => node.id === 'template-a' ? { ...node, data: { source: 'system', model: 'gpt-image-2' } } : node) }).nodes.length, 5);
assert.throws(() => validateToolFlowGraph({ ...graph, connections: [...graph.connections, { from: 'output', to: 'input' }] }), /不兼容|循环/);
assert.throws(() => validateToolFlowGraph({ ...graph, connections: [{ from: 'input', to: 'template-a' }, { from: 'template-a', to: 'select' }, { from: 'select', to: 'confirm' }, { from: 'confirm', to: 'output' }, { from: 'select', to: 'template-a' }] }), /循环/);
assert.throws(() => validateToolFlowGraph({ ...graph, nodes: graph.nodes.map(node => node.id === 'template-a' ? { ...node, data: {} } : node) }), /提示词/);

const runtime = readFileSync(new URL('../src/lib/tools/toolflow-runtime.ts', import.meta.url), 'utf8');
const worker = readFileSync(new URL('../src/lib/image-studio/worker.ts', import.meta.url), 'utf8');
const workflow = readFileSync(new URL('../public/tools/ultimate-canvas/toolflow-workflow.js', import.meta.url), 'utf8');
const canvasEngine = readFileSync(new URL('../public/tools/ultimate-canvas/canvas-engine.js', import.meta.url), 'utf8');
assert.match(runtime, /snapshot_json/);
assert.match(runtime, /tool_flow_run_id/);
assert.match(runtime, /settleTaskCredits/);
assert.match(worker, /completeToolFlowTask/);
assert.match(workflow, /\/api\/image-studio\/modules/);
assert.match(workflow, /moduleId/);
assert.match(workflow, /data-toolflow-node-template-select/);
assert.match(workflow, /data-toolflow-input-file/);
assert.match(canvasEngine, /connection-line:not\(\.temp\)/);
assert.match(canvasEngine, /connection-delete-control/);

console.log('toolflow smoke passed');
