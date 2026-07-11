import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const interactions = require('../public/tools/ultimate-canvas/generation-node-interactions.js');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function context(runtime: any) {
  return {
    epoch: runtime.contextEpoch,
    projectId: runtime.selectedProjectId,
    videoCardId: runtime.selectedVideoCardId,
    documentId: runtime.documentId,
    nodeId: runtime.node.id,
    node: runtime.node,
  };
}

async function documentMetadataChangeSmoke() {
  const node: any = { id: 'video-node', type: 'video', data: { generationStatus: 'submitted' } };
  const runtime: any = {
    contextEpoch: 3,
    selectedProjectId: 'project-a',
    selectedVideoCardId: 'card-a',
    documentId: null,
    node,
  };
  const captured = interactions.captureGenerationContext(context(runtime));
  const response = deferred<any>();
  const applied: string[] = [];
  const polling: string[] = [];
  const saves: string[] = [];
  let finallyCalls = 0;

  const submission = interactions.runGuardedGenerationResponse({
    response: response.promise,
    captured,
    current: () => context(runtime),
    onSuccess: (result: any) => {
      node.data.taskId = result.taskId;
      node.data.generationStatus = 'running';
      applied.push(result.taskId);
      polling.push(result.taskId);
      saves.push('video_generation');
    },
    onFinally: () => { finallyCalls += 1; },
  });

  runtime.documentId = 'created-document';
  response.resolve({ taskId: 'valid-task' });
  const outcome = await submission;

  assert.equal(outcome.stale, false, 'document ID creation is metadata, not a context replacement');
  assert.deepEqual(applied, ['valid-task'], 'valid response applies exactly once');
  assert.deepEqual(polling, ['valid-task'], 'valid response registers polling once');
  assert.deepEqual(saves, ['video_generation'], 'valid response schedules one save');
  assert.equal(finallyCalls, 1, 'valid response cleanup runs exactly once');
}

async function cardSwitchCleanupSmoke() {
  const node: any = { id: 'same-node', type: 'video', data: { generationStatus: 'submitted' } };
  const runtime: any = {
    contextEpoch: 9,
    selectedProjectId: 'project-a',
    selectedVideoCardId: 'card-a',
    documentId: 'document-a',
    node,
  };
  const captured = interactions.captureGenerationContext(context(runtime));
  const response = deferred<any>();
  const applied: string[] = [];
  let loading = true;
  let finallyCalls = 0;
  const transientStatus = {
    textContent: '正在提交生成请求',
    removed: false,
    remove() { this.removed = true; },
  };
  const capturedElement = {
    isConnected: true,
    querySelector: () => transientStatus,
  };

  const submission = interactions.runGuardedGenerationResponse({
    response: response.promise,
    captured,
    current: () => context(runtime),
    onSuccess: (result: any) => {
      node.data.taskId = result.taskId;
      applied.push(result.taskId);
    },
    onFinally: ({ stale }: any) => {
      finallyCalls += 1;
      interactions.cleanupGenerationSubmission({
        stale,
        node,
        nodeElement: capturedElement,
        clearLoading: () => { loading = false; },
      });
    },
  });

  runtime.contextEpoch += 1;
  runtime.selectedVideoCardId = 'card-b';
  response.resolve({ taskId: 'stale-task' });
  const outcome = await submission;

  assert.equal(outcome.stale, true);
  assert.deepEqual(applied, [], 'card-switch response cannot attach a stale task/result');
  assert.equal(finallyCalls, 1, 'stale response cleanup still runs exactly once');
  assert.equal(loading, false, 'captured loading state is cleared');
  assert.equal(transientStatus.removed, true, 'captured transient status is cleared while detached');
  assert.equal(node.data.generationStatus, 'idle', 'pre-response submitting state is cleared');
  assert.equal(node.data.taskId, undefined, 'cleanup never attaches the stale task');
}

async function replacementNodeSmoke() {
  const originalNode: any = { id: 'same-node', type: 'video', data: { generationStatus: 'submitted' } };
  const replacementNode = { id: 'same-node', type: 'video', data: {} };
  const runtime: any = {
    contextEpoch: 12,
    selectedProjectId: 'project-a',
    selectedVideoCardId: 'card-a',
    documentId: 'document-a',
    node: originalNode,
  };
  const captured = interactions.captureGenerationContext(context(runtime));
  const response = deferred<any>();
  const mutations: string[] = [];
  let detachedCleanup = 0;
  let detachedLoading = true;
  const detachedStatus = {
    textContent: '正在提交生成请求',
    removed: false,
    remove() { this.removed = true; },
  };
  const detachedElement = { isConnected: false, querySelector: () => detachedStatus };
  const submission = interactions.runGuardedGenerationResponse({
    response: response.promise,
    captured,
    current: () => context(runtime),
    onSuccess: (result: any) => mutations.push(result.taskId),
    onFinally: ({ stale }: any) => {
      detachedCleanup += 1;
      interactions.cleanupGenerationSubmission({
        stale,
        node: originalNode,
        nodeElement: detachedElement,
        clearLoading: () => { detachedLoading = false; },
      });
    },
  });
  runtime.contextEpoch += 1;
  runtime.node = replacementNode;
  response.resolve({ taskId: 'detached-task' });
  const outcome = await submission;
  assert.equal(outcome.stale, true);
  assert.deepEqual(replacementNode.data, {});
  assert.deepEqual(mutations, []);
  assert.equal(detachedCleanup, 1, 'cleanup is safe even after the original node is detached');
  assert.equal(detachedLoading, false);
  assert.equal(detachedStatus.removed, true);
}

async function main() {
  await documentMetadataChangeSmoke();
  await cardSwitchCleanupSmoke();
  await replacementNodeSmoke();

  const appSource = readFileSync('public/tools/ultimate-canvas/app.js', 'utf8');
  assert.ok(appSource.includes('contextEpoch'), 'runtime owns a generation context epoch');
  assert.ok(appSource.includes('captureGenerationContext'), 'submission captures generation identity');
  assert.ok(appSource.includes('runGuardedGenerationResponse'), 'submission consumes the executable guard');
  assert.ok(appSource.includes('cleanupGenerationSubmission'), 'app consumes the executable cleanup contract');
  assert.ok(appSource.includes('invalidateGenerationContext'), 'context replacement invalidates in-flight generation');

  console.log('ultimate canvas generation lifecycle smoke passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
