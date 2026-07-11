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

function videoCapability() {
  return interactions.normalizeCapabilities('video', {
    enabled: true,
    interaction: {
      modes: ['text-to-video'],
      ratios: ['16:9'],
      durations: [5],
      resolutions: ['720p'],
      max_reference_images: 9,
    },
  });
}

function readiness(node: any, transientPending = false) {
  return interactions.generationInteractionReadiness(
    'video', videoCapability(), node.data, 0, 'text-to-video', { transientPending },
  );
}

async function staleFlushRestoreSmoke() {
  const node: any = { id: 'video-node', type: 'video', data: { prompt: 'shot', generationStatus: 'idle' } };
  const runtime: any = {
    contextEpoch: 4,
    selectedProjectId: 'project-a',
    selectedVideoCardId: 'card-a',
    documentId: 'document-a',
    node,
  };
  const tracker = interactions.createGenerationSubmissionTracker();
  const captured = interactions.captureGenerationContext(context(runtime));
  const entry = { captured };
  assert.equal(tracker.start(node.id, entry), true);
  assert.equal(readiness(node, tracker.has(node.id)).ready, false, 'transient ownership blocks a duplicate submit');

  let loading = true;
  const response = deferred<any>();
  const applied: string[] = [];
  const submission = interactions.runGuardedGenerationResponse({
    response: response.promise,
    captured,
    current: () => context(runtime),
    onSuccess: (result: any) => {
      node.data = { ...node.data, taskId: result.taskId, generationStatus: 'submitted' };
      applied.push(result.taskId);
    },
    onFinally: ({ stale }: any) => {
      interactions.cleanupGenerationSubmission({
        stale,
        node,
        clearLoading: () => { loading = false; },
      });
      tracker.finish(node.id, entry);
    },
  });

  const flushedSnapshot = JSON.stringify(node);
  const flushedData = JSON.parse(flushedSnapshot).data;
  assert.equal(flushedData.generationStatus, 'idle', 'pre-response snapshot has no durable submitted state');
  assert.equal(flushedData.taskId, undefined);

  runtime.contextEpoch += 1;
  runtime.selectedVideoCardId = 'card-b';
  response.resolve({ taskId: 'stale-task' });
  const outcome = await submission;
  assert.equal(outcome.stale, true);
  assert.deepEqual(applied, [], 'stale response never attaches a task/result');
  assert.equal(loading, false, 'stale response clears captured transient loading');
  assert.equal(tracker.has(node.id), false);

  const restoredNode = JSON.parse(flushedSnapshot);
  const recovered = interactions.recoverTasklessNonterminalVideoNode(restoredNode);
  assert.equal(recovered, false, 'clean transient snapshot needs no durable recovery');
  assert.equal(restoredNode.data.generationStatus, 'idle');
  assert.equal(readiness(restoredNode).ready, true, 'restored flushed snapshot can submit again');
}

async function currentResponseOwnershipSmoke() {
  const node: any = { id: 'current-video', type: 'video', data: { generationStatus: 'idle' } };
  const runtime: any = {
    contextEpoch: 8,
    selectedProjectId: 'project-a',
    selectedVideoCardId: 'card-a',
    documentId: null,
    node,
  };
  const tracker = interactions.createGenerationSubmissionTracker();
  const captured = interactions.captureGenerationContext(context(runtime));
  const entry = { captured };
  tracker.start(node.id, entry);
  const response = deferred<any>();
  const polling: string[] = [];
  const saves: string[] = [];
  let finallyCalls = 0;

  const submission = interactions.runGuardedGenerationResponse({
    response: response.promise,
    captured,
    current: () => context(runtime),
    onSuccess: (result: any) => {
      node.data = {
        ...node.data,
        taskId: result.taskId,
        generationStatus: result.status,
        generationResult: result,
      };
      polling.push(result.taskId);
      saves.push('video_generation');
    },
    onFinally: () => {
      finallyCalls += 1;
      tracker.finish(node.id, entry);
    },
  });

  assert.equal(JSON.parse(JSON.stringify(node)).data.generationStatus, 'idle');
  runtime.documentId = 'created-document';
  response.resolve({ taskId: 'current-task', status: 'submitted' });
  const outcome = await submission;

  assert.equal(outcome.stale, false);
  assert.equal(node.data.taskId, 'current-task');
  assert.equal(node.data.generationStatus, 'submitted');
  assert.deepEqual(polling, ['current-task']);
  assert.deepEqual(saves, ['video_generation']);
  assert.equal(finallyCalls, 1);
  assert.equal(tracker.has(node.id), false);
  assert.equal(readiness(node).ready, false, 'task-owned nonterminal response blocks duplicate paid submission');
}

function restoreRecoverySmoke() {
  const legacy: any = {
    id: 'legacy-video',
    type: 'video',
    data: {
      generationStatus: 'submitted',
      generationError: 'stale loading marker',
      generationResult: { status: 'submitted' },
    },
  };
  assert.equal(interactions.nodeHasNonterminalVideoTask(legacy), false, 'taskless legacy status has no ownership');
  assert.equal(interactions.recoverTasklessNonterminalVideoNode(legacy), true);
  assert.equal(legacy.data.generationStatus, 'idle');
  assert.equal(legacy.data.generationError, undefined);
  assert.equal(legacy.data.generationResult, undefined);
  assert.equal(readiness(legacy).ready, true);
  assert.equal(interactions.recoverTasklessNonterminalVideoNode(legacy), false, 'recovery is one-shot and cannot save-loop');

  const legitimate: any = {
    id: 'running-video',
    type: 'video',
    data: { taskId: 'running-task', generationStatus: 'running' },
  };
  const polled: string[] = [];
  assert.equal(interactions.recoverTasklessNonterminalVideoNode(legitimate), false);
  assert.equal(interactions.nodeHasNonterminalVideoTask(legitimate), true);
  if (interactions.nodeHasNonterminalVideoTask(legitimate)) polled.push(legitimate.data.taskId);
  assert.deepEqual(polled, ['running-task'], 'legitimate restored task remains pollable');
  assert.equal(readiness(legitimate).ready, false, 'legitimate restored running task remains blocked');
}

async function trackerInvalidationSmoke() {
  const tracker = interactions.createGenerationSubmissionTracker();
  const node: any = { id: 'node-1', type: 'video', data: { generationStatus: 'idle' } };
  const runtime: any = {
    contextEpoch: 20,
    selectedProjectId: 'project-a',
    selectedVideoCardId: 'card-a',
    documentId: 'document-a',
    node,
  };
  let oldLoading = true;
  let oldCleanupCalls = 0;
  let oldFinallyCalls = 0;
  const oldCaptured = interactions.captureGenerationContext(context(runtime));
  const oldEntry = {
    captured: oldCaptured,
    kind: 'video',
    release() {
      oldCleanupCalls += 1;
      oldLoading = false;
    },
  };
  assert.equal(tracker.start('node-1', oldEntry), true);

  const oldResponse = deferred<any>();
  const oldSubmission = interactions.runGuardedGenerationResponse({
    response: oldResponse.promise,
    captured: oldCaptured,
    current: () => context(runtime),
    onSuccess: () => assert.fail('old response must be stale'),
    onFinally: () => {
      oldFinallyCalls += 1;
      if (tracker.finish('node-1', oldEntry)) oldEntry.release();
    },
  });

  runtime.contextEpoch += 1;
  runtime.selectedVideoCardId = 'card-b';
  assert.equal(tracker.releaseAll((entry: any) => entry.release()), 1, 'invalidation releases old context entries');
  assert.equal(oldLoading, false, 'old captured loading UI is cleared during invalidation');
  assert.equal(oldCleanupCalls, 1);
  assert.equal(tracker.has('node-1'), false);

  const newEntry = { captured: interactions.captureGenerationContext(context(runtime)), kind: 'video' };
  assert.equal(tracker.start('node-1', newEntry), true, 'same-ID submission starts immediately in new context');
  oldResponse.resolve({ taskId: 'stale-old-task' });
  const oldOutcome = await oldSubmission;
  assert.equal(oldOutcome.stale, true);
  assert.equal(oldFinallyCalls, 1);
  assert.equal(oldCleanupCalls, 1, 'old finally cannot clear replacement UI a second time');
  assert.equal(tracker.get('node-1'), newEntry, 'old finish cannot remove newer same-ID ownership');
  assert.equal(tracker.finish('node-1', oldEntry), false);
  assert.equal(tracker.finish('node-1', newEntry), true, 'new finish removes only the new entry');
  assert.equal(tracker.has('node-1'), false);

  const releasedKinds: string[] = [];
  for (const kind of ['image', 'video']) {
    tracker.start(`${kind}-node`, { kind });
  }
  assert.equal(tracker.releaseAll((entry: any) => releasedKinds.push(entry.kind)), 2);
  assert.deepEqual(releasedKinds.sort(), ['image', 'video'], 'invalidation covers image and video transient submissions');
}

async function main() {
  await staleFlushRestoreSmoke();
  await currentResponseOwnershipSmoke();
  restoreRecoverySmoke();
  await trackerInvalidationSmoke();

  const appSource = readFileSync('public/tools/ultimate-canvas/app.js', 'utf8');
  const submitSource = appSource.slice(
    appSource.indexOf('async function submitNodeGeneration'),
    appSource.indexOf("document.addEventListener('click', (e) =>", appSource.indexOf('async function submitNodeGeneration')),
  );
  const hydrateSource = appSource.slice(
    appSource.indexOf('function hydrateNodeViews'),
    appSource.indexOf('async function loadCanvasDocument'),
  );
  const invalidateSource = appSource.slice(
    appSource.indexOf('function invalidateGenerationContext'),
    appSource.indexOf('function requestCanvasConfirmation'),
  );
  assert.ok(appSource.includes('createGenerationSubmissionTracker'), 'app uses transient submission ownership');
  assert.ok(appSource.includes('recoverTasklessNonterminalVideoNode'), 'hydrate uses executable legacy recovery');
  assert.ok(appSource.includes("scheduleCanvasSave('recover_taskless_video_status')"), 'recovery persists through the save queue');
  assert.ok(hydrateSource.includes('return recoveredTasklessVideoStatus;'), 'hydrate reports whether durable recovery occurred');
  assert.ok(!submitSource.includes('return recoveredTasklessVideoStatus;'), 'submission does not leak hydration state');
  assert.ok(!submitSource.includes("generationStatus: 'submitted'"), 'pre-response submit never writes durable submitted state');
  assert.ok(invalidateSource.includes('releaseAll'), 'context invalidation releases transient ownership');
  assert.ok(submitSource.includes("['image', 'video'].includes(payload.kind)"), 'image and video submissions both use transient ownership');

  console.log('ultimate canvas generation lifecycle smoke passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
