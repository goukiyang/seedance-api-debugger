import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const interactions = require('../public/tools/ultimate-canvas/generation-node-interactions.js');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function main() {
  const originalNode = { id: 'same-node', type: 'video', data: {} };
  const replacementNode = { id: 'same-node', type: 'video', data: {} };
  const runtime: any = {
    contextEpoch: 7,
    selectedProjectId: 'project-a',
    selectedVideoCardId: 'card-a',
    documentId: 'document-a',
    node: originalNode,
  };
  const captured = interactions.captureGenerationContext({
    epoch: runtime.contextEpoch,
    projectId: runtime.selectedProjectId,
    videoCardId: runtime.selectedVideoCardId,
    documentId: runtime.documentId,
    nodeId: originalNode.id,
    node: originalNode,
  });
  const response = deferred<any>();
  const mutations: string[] = [];
  const polling: string[] = [];
  const saves: string[] = [];

  const submission = interactions.runGuardedGenerationResponse({
    response: response.promise,
    captured,
    current: () => ({
      epoch: runtime.contextEpoch,
      projectId: runtime.selectedProjectId,
      videoCardId: runtime.selectedVideoCardId,
      documentId: runtime.documentId,
      nodeId: runtime.node.id,
      node: runtime.node,
    }),
    onSuccess: (result: any) => {
      runtime.node.data.taskId = result.taskId;
      mutations.push(result.taskId);
      polling.push(result.taskId);
      saves.push('video_generation');
    },
  });

  runtime.contextEpoch += 1;
  runtime.selectedProjectId = 'project-b';
  runtime.selectedVideoCardId = 'card-b';
  runtime.documentId = 'document-b';
  runtime.node = replacementNode;
  response.resolve({ taskId: 'backend-task-a' });

  const outcome = await submission;
  assert.equal(outcome.stale, true);
  assert.deepEqual(replacementNode.data, {}, 'stale response cannot mutate replacement node with same ID');
  assert.deepEqual(mutations, [], 'stale response performs zero result mutation/decorations');
  assert.deepEqual(polling, [], 'stale response performs zero polling registration');
  assert.deepEqual(saves, [], 'stale response performs zero save scheduling');

  const appSource = readFileSync('public/tools/ultimate-canvas/app.js', 'utf8');
  assert.ok(appSource.includes('contextEpoch'), 'runtime owns a generation context epoch');
  assert.ok(appSource.includes('captureGenerationContext'), 'submission captures all generation identities');
  assert.ok(appSource.includes('runGuardedGenerationResponse'), 'submission consumes the executable guard');
  assert.ok(appSource.includes('invalidateGenerationContext'), 'context replacement invalidates in-flight generation');

  console.log('ultimate canvas generation lifecycle smoke passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
