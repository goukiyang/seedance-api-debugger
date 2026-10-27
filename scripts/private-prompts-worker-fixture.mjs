import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export async function checkPrivateWorkerFailures({ root, ts, db, crypto, task }) {
  function actualFunction(file, name, dependencies) {
    const ast = ts.createSourceFile(file, fs.readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true);
    const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
    assert.ok(node, `Actual worker function missing: ${name}`);
    const output = ts.transpileModule(node.getText(ast), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    return new Function('exports', ...Object.keys(dependencies), `${output}\nreturn ${name};`)({}, ...Object.values(dependencies));
  }
  const forbidden = () => { throw new Error('Unexpected settlement or external operation'); };
  const privateFailure = () => { throw new crypto.PrivatePromptError(); };
  let sends = 0, deferred = 0;
  const dependencies = {
    prisma: db, PrivatePromptError: crypto.PrivatePromptError, STUDIO_EXECUTION_MS: 300000,
    workerProviderErrorRecorder: () => ({}), studioTaskState: (_task, state) => state,
    publicPricingTaskState: state => state, finishStudioTask: forbidden,
    readRetainedStudioDimensionOriginal: async () => null,
    transformPrivateImageTask: value => value, safeImageChannelSnapshot: () => null,
    isPricingImageTask: () => false,
    getImageGenerationSettingsForModel: async () => ({ provider: 'musk', base_url: 'https://fixture.invalid', api_key: 'synthetic' }),
    isStudioImageGenerationProvider: () => true, isImageGenerationApiReady: () => true,
    assertStudioPostAuthorization: async () => {}, privateImageTaskOrigins: () => [],
    assertPrivateStudioDestination: () => {}, beginStudioRequest: async () => {},
    deferStudioAsyncRecovery: async (value, code, preserve) => {
      assert.equal(value.id, task.id); assert.equal(preserve, true); assert.equal(code, new crypto.PrivatePromptError().code); deferred++;
    },
  };
  const native = actualFunction('src/lib/image-studio/worker.ts', 'executeStudioTask', dependencies);
  const before = await db.imageStudioTask.update({ where: { id: task.id }, data: {
    status: 'running', lease_token: 'private-failure-lease', lease_until: new Date(Date.now() + 60000),
  } });
  const plaintextTask = { ...before, prompt: 'synthetic-input', context: 'synthetic-context', snapshot_json: '{}', reference_ids: '[]' };
  await native(plaintextTask, async () => { sends++; privateFailure(); });
  assert.equal(sends, 1);
  const after = await db.imageStudioTask.findUniqueOrThrow({ where: { id: task.id } });
  assert.equal(after.status, 'uncertain'); assert.equal(after.lease_token, null);
  for (const field of ['id', 'prompt', 'context', 'snapshot_json', 'unit_credits', 'gateway_request_id', 'fingerprint'])
    assert.equal(after[field], before[field]);
  for (const recovering of [false, true]) {
    const current = await db.imageStudioTask.update({ where: { id: task.id }, data: {
      status: recovering ? 'uncertain' : 'channel_running', lease_token: 'private-failure-lease', lease_until: new Date(Date.now() + 60000),
    } });
    const channel = actualFunction('src/lib/image-studio/worker.ts', 'executeChannelStudioTask', {
      ...dependencies, readRetainedStudioDimensionOriginal: privateFailure,
    });
    await channel(current, forbidden, undefined, { state: 'pending', requestId: 'original-only' });
    const result = await db.imageStudioTask.findUniqueOrThrow({ where: { id: task.id } });
    assert.equal(result.status, 'uncertain');
    assert.equal(result.unit_credits, before.unit_credits);
  }
  assert.equal(deferred, 1); assert.equal(await db.creditLedger.count(), 0);

  for (const phase of ['before-send', 'transport', 'output-filter']) {
    let calls = 0;
    const run = { id: 'synthetic-run', owner_user_id: 'author', draft_id: 'synthetic-draft', snapshot_json: '{}',
      status: 'running', delivery_state: 'not_sent', lease_token: 'lease' };
    const original = { ...run };
    const process = actualFunction('src/lib/template-studio/worker.ts', 'processStudioPromptOnce', {
      prisma: db, claimStudioRun: async () => ({ run, token: 'lease' }),
      projectWorkerSessionUser: owner => ({ ...owner, account_type: 'internal' }), requireStudioUser: () => {},
      parseWorkerSnapshot: () => ({ assets: [], input: { values: {}, draftPrompt: 'ordinary-input' }, parameters: {} }),
      ensureStudioSnapshotSourceStillUsable: async () => {}, authorizeStudioAssets: async () => {},
      TEMPLATE_STUDIO_TEXT_ENABLED_KEY: 'synthetic-enabled', getMuskApiSettings: async () => ({ default_model: 'synthetic' }),
      textFeatureEnabled: () => true, isMuskApiReady: () => true, privateVideoRunOrigins: () => [],
      assertPrivateMuskSend: phase === 'before-send' ? privateFailure : () => {},
      updateRun: async (_id, _token, where, data) => {
        assert.equal(_id, run.id); assert.equal(_token, 'lease');
        if (where.delivery_state !== undefined) assert.equal(run.delivery_state, where.delivery_state);
        Object.assign(run, data); return { count: 1 };
      },
      createMuskChatCompletion: async () => {
        calls++; if (phase === 'transport') privateFailure(); return { content: 'synthetic-output', usage: {} };
      },
      LEASE_MS: 60000, MUSK_TIMEOUT_MS: 60000, workerSafeUsage: value => value, outputPrompt: value => value,
      containsPrivateContext: privateFailure, isPrivatePromptError: crypto.isPrivatePromptError, markTerminal: forbidden,
    });
    assert.equal(await process(), true);
    assert.equal(calls, phase === 'before-send' ? 0 : 1);
    assert.equal(run.status, phase === 'before-send' ? 'queued' : 'uncertain');
    assert.equal(run.delivery_state, phase === 'before-send' ? 'not_sent' : 'unknown');
    assert.equal(run.lease_token, null);
    for (const field of ['id', 'owner_user_id', 'draft_id', 'snapshot_json']) assert.equal(run[field], original[field]);
  }
}
