'use strict';

// Run separately from builds, on Linux, against a newly owned synthetic database only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fixture = require('./fixtures/fb2322-video-tx.cjs');

let phase = 'guard', directory, prisma, externalAttempts = 0;
const result = { fixture: 'fb2322-video-tx', syntheticOnly: true, timings: [], passed: [], externalRequests: 0 };
const root = fs.realpathSync(path.join(__dirname, '..'));
const originalCwd = process.cwd();
const inside = (parent, file) => file === parent || file.startsWith(parent + path.sep);
function write(file, value) { fs.writeFileSync(file, Buffer.isBuffer(value) ? value : JSON.stringify(value), { flag: 'wx', mode: 0o600 }); }
function denyNetwork() {
  const deny = () => { externalAttempts++; throw Error('fb2322_network_prohibited'); };
  globalThis.fetch = deny;
  for (const name of ['node:http', 'node:https']) { require(name).get = deny; require(name).request = deny; }
  for (const name of ['node:net', 'node:tls']) { require(name).connect = deny; require(name).createConnection = deny; }
}
async function snapshot() {
  const tables = await prisma.$queryRawUnsafe("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  const projection = {};
  for (const { name } of tables) {
    assert.match(name, /^[A-Za-z_][A-Za-z0-9_]*$/);
    projection[name] = await prisma.$queryRawUnsafe(`SELECT * FROM "${name}" ORDER BY rowid`);
  }
  return projection;
}
async function main() {
  assert.equal(process.platform, 'linux', 'Linux-only native fixture; do not run Prisma on the local workstation');
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(process.env.AUD_FB2322_SYNTHETIC_SERVER, '1');
  assert.equal(globalThis.prisma, undefined, 'existing database client must not be loaded before the fence');
  assert.deepEqual(fixture.sourceViolations(root), [], 'integrate application db propagation before native validation');
  const parent = fs.realpathSync(process.env.AUD_FB2322_TMP_PARENT || '/tmp');
  assert.equal(inside(root, parent), false, 'private fixture keys must not inherit application-cwd TMPDIR');
  directory = fs.realpathSync(fs.mkdtempSync(path.join(parent, 'fb2322-synthetic-')));
  fs.chmodSync(directory, 0o700);
  const runtimeDirectory = path.join(directory, 'runtime');
  fs.mkdirSync(runtimeDirectory, { mode: 0o700 });
  const databaseFile = path.join(directory, 'synthetic.db');
  assert.equal(fs.existsSync(databaseFile), false);
  write(databaseFile, Buffer.alloc(0));
  for (const key of Object.keys(process.env)) if (key.startsWith('PRIVATE_PROMPTS_')) delete process.env[key];
  Object.assign(process.env, { DATABASE_URL: `file:${databaseFile}`, SESSION_SECRET: randomBytes(48).toString('hex'),
    PRIVATE_PROMPTS_FIXTURE_ROOT: directory, PRIVATE_PROMPTS_POLICY_FILE: path.join(directory, 'policy.json'),
    PRIVATE_PROMPTS_MIN_STATE: 'encrypted-write', PRIVATE_PROMPTS_CONSUMER_ID: 'fb2322',
    PRIVATE_PROMPTS_RUNTIME_REVISION: 'b9cb9a73899cada0915675026896ac21210029a3', FEISHU_FEEDBACK_ENABLED: 'false' });
  delete process.env.R2_PUBLIC_BASE_URL; delete process.env.TOS_PUBLIC_BASE_URL;
  const policy = { schema: 'private-prompt-policy.v1', revision: 'fb2322-synthetic', state: 'encrypted-write', minimumReader: 1,
    identities: [{ userId: 'actor', tenant: 'synthetic-tenant', subject: 'synthetic-subject' }],
    origins: [{ kind: 'video-template', id: 'template', ownerId: 'actor' }],
    authorKinds: [{ ownerId: 'actor', kinds: ['video-template'] }], destinations: [], consumers: ['fb2322'],
    activation: { inventoryId: 'fb2322-inventory', restoreId: 'fb2322-restore', writerFenceId: 'fb2322-fence', attestationFile: path.join(directory, 'consumers.json') },
    keys: Object.fromEntries(['body', 'index', 'backup'].map(domain => {
      const file = path.join(directory, `${domain}.key`); write(file, randomBytes(32));
      return [domain, { active: domain, files: { [domain]: file } }];
    })) };
  write(process.env.PRIVATE_PROMPTS_POLICY_FILE, policy);
  write(policy.activation.attestationFile, { schema: 'private-prompt-consumers.v1', policyRevision: policy.revision,
    inventoryId: policy.activation.inventoryId, restoreId: policy.activation.restoreId, writerFenceId: policy.activation.writerFenceId,
    consumers: [{ id: 'fb2322', reader: 1, permissionContract: 1, sourceRevision: process.env.PRIVATE_PROMPTS_RUNTIME_REVISION }] });
  denyNetwork();
  phase = 'fresh_schema';
  const platform = await require('@prisma/get-platform').getBinaryTargetForCurrentPlatform();
  const engine = path.join(path.dirname(require.resolve('@prisma/engines/package.json')), `schema-engine-${platform}`);
  assert.ok(fs.existsSync(engine), 'installed schema engine required; no engine download');
  try {
    const output = execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'db', 'push', '--skip-generate', '--schema', path.join(root, 'prisma/schema.prisma')],
      { cwd: directory, env: { ...process.env, PRISMA_SCHEMA_ENGINE_BINARY: engine, PRISMA_GENERATE_SKIP_AUTOINSTALL: '1' }, timeout: 120000, stdio: 'pipe' });
    fs.writeFileSync(path.join(directory, 'schema.stdout.log'), output, { mode: 0o600 });
  } catch (error) {
    for (const name of ['stdout', 'stderr']) if (Buffer.isBuffer(error[name])) fs.writeFileSync(path.join(directory, `schema.${name}.log`), error[name], { mode: 0o600 });
    throw error;
  }
  // b9's asset path and private-key policy are real. Use only newly written fixture bytes outside app cwd.
  fs.mkdirSync(path.join(runtimeDirectory, 'public/uploads/fb2322'), { recursive: true, mode: 0o700 });
  const syntheticMediaFile = path.join(runtimeDirectory, 'public/uploads/fb2322/readable.mp4');
  fs.writeFileSync(syntheticMediaFile, 'synthetic-readable-file-not-a-decoded-video', { flag: 'wx', mode: 0o600 });
  // b9 deliberately rejects policy/key paths under cwd, including a synthetic cwd.
  process.chdir(runtimeDirectory);
  globalThis.AsyncLocalStorage = require('node:async_hooks').AsyncLocalStorage;
  require('./server-runtime.cjs');
  prisma = require('../src/lib/prisma.ts').prisma;
  await prisma.$connect();
  const mainDatabase = (await prisma.$queryRawUnsafe('PRAGMA database_list')).find(item => item.name === 'main');
  assert.equal(fs.realpathSync(mainDatabase.file), databaseFile);
  assert.equal(fs.statSync(databaseFile).nlink, 1);
  assert.ok(Object.values(await snapshot()).every(rows => rows.length === 0), 'all tables initially empty');
  phase = 'synthetic_seed';
  for (const id of ['actor', 'owner', 'source-owner']) await prisma.user.create({ data: {
    id, name: 'Synthetic ' + id, username: 'fb2322-' + id, email: `${id}@synthetic.invalid`, password_hash: 'synthetic-not-a-password',
    role: 'user', account_type: 'internal', status: 'active', user_profile: 'other', feature_profile_id: 'internal_email_authorized' } });
  await prisma.project.create({ data: { id: 'project', name: 'Synthetic team', type: 'team', owner_user_id: 'owner', created_by: 'owner', status: 'active' } });
  await prisma.projectMember.create({ data: { project_id: 'project', user_id: 'actor', role: 'editor', status: 'active', joined_by: 'owner' } });
  await prisma.videoCard.create({ data: { id: 'card', project_id: 'project', title: 'Synthetic card', owner_user_id: 'actor', created_by: 'actor', status: 'active' } });
  const mediaUrl = '/uploads/fb2322/readable.mp4';
  await prisma.asset.create({ data: { id: 'video', owner_id: 'source-owner', type: 'video', status: 'active', original_url: mediaUrl, file_name: 'synthetic.mp4', mime_type: 'video/mp4', file_size: fs.statSync(syntheticMediaFile).size, hash: 'fixture-version-a' } });
  await prisma.referenceAlbum.create({ data: { id: 'album', name: 'Synthetic private album', owner_user_id: 'source-owner', album_type: 'private', status: 'active', visibility: 'private' } });
  await prisma.albumShare.create({ data: { id: 'grant', album_id: 'album', grantee_type: 'project', grantee_id: 'project', permissions_json: JSON.stringify({ view: true, use: true }), created_by: 'source-owner' } });
  await prisma.referenceImage.create({ data: { id: 'reference', album_id: 'album', asset_id: 'video', owner_user_id: 'source-owner', status: 'active', url: mediaUrl, source_type: 'upload' } });
  const validation = require('../src/lib/template-studio/validation.ts');
  const storage = require('../src/lib/template-studio/private-storage.server.ts');
  const recipe = validation.normalizeRecipe({ instruction: 'Synthetic confidential fixture direction', fields: [],
    assetSlots: [{ key: 'video', label: 'Video', role: 'reference', types: ['video'], required: true, maxItems: 1 }], defaultParameters: {} });
  const origins = storage.videoTemplateOrigins('template', 'actor');
  const recipeText = storage.writePrivateVideoRecipe(recipe, 'video-template', 'template', origins);
  const versionText = storage.writePrivateVideoRecipe(recipe, 'video-template-version', 'version', origins);
  assert.ok(!recipeText.includes(recipe.instruction), 'fixture uses real encrypted template storage');
  await prisma.videoStudioTemplate.create({ data: { id: 'template', owner_user_id: 'actor', name: 'Synthetic template', status: 'published', visibility: 'shared', recipe_json: recipeText } });
  await prisma.videoStudioTemplateVersion.create({ data: { id: 'version', template_id: 'template', version_number: 1, name: 'Synthetic template', group_name: 'Synthetic', recipe_json: versionText, created_by: 'actor' } });
  await prisma.videoStudioTemplate.update({ where: { id: 'template' }, data: { published_version_id: 'version' } });
  const inputs = [{ assetId: 'video', role: 'reference', type: 'video', slotKey: 'video' }];
  const runSnapshot = { owner: { userId: 'actor', username: 'fb2322-actor', displayName: 'Synthetic actor', accountType: 'internal' },
    input: { name: 'Synthetic', groupName: '', values: {}, draftPrompt: 'Synthetic public input' }, prompt: 'Synthetic public input',
    recipe, parameters: {}, assets: inputs, templateVersion: { templateId: 'template', templateSource: 'studio', versionId: 'version', sourceRevision: 'studio:1' } };
  await prisma.videoStudioDraft.create({ data: { id: 'studio-draft', owner_user_id: 'actor', name: 'Synthetic', prompt: 'Synthetic public input', assets_json: JSON.stringify(inputs) } });
  const encodedRun = storage.transformPrivateVideoRun(runSnapshot, 'run', 'studio-draft', true);
  await prisma.videoStudioRun.create({ data: { id: 'run', owner_user_id: 'actor', draft_id: 'studio-draft', request_id: 'synthetic-run', request_fingerprint: 'synthetic-fingerprint', source: 'studio', mode: 'direct', status: 'succeeded', snapshot_json: JSON.stringify(encodedRun), prompt: 'Synthetic public input' } });
  const model = require('../src/lib/provider/seedance-models.ts').SEEDANCE_2_5_MODEL_ID;
  await prisma.videoTask.create({ data: { id: 'draft', provider: 'seedance', model, generation_mode: 'all_in_one_reference', prompt: 'Synthetic draft',
    user_id: 'actor', owner_user_id: 'actor', project_id: 'project', video_card_id: 'card', local_status: 'succeeded', is_draft: true,
    provider_draft_task_id: 'synthetic-provider-draft', reference_video_urls: '[]', ratio: '16:9', duration: 5, resolution: '480p' } });
  await prisma.videoTask.create({ data: { id: 'unknown', provider: 'seedance', model, generation_mode: 'all_in_one_reference', prompt: 'Synthetic unknown receipt',
    user_id: 'actor', owner_user_id: 'actor', local_status: 'submitted', idempotency_key: 'synthetic-original-unknown', provider_task_id: 'synthetic-original-provider', estimated_cost: 5, frozen_cost: 5 } });
  await prisma.creditAccount.create({ data: { user_id: 'actor', balance: 95, frozen_credits: 5 } });

  const session = require('../src/lib/auth/session.ts');
  const identity = require('../src/lib/security/private-prompt-identity.server.ts');
  const templates = require('../src/lib/template-studio/templates.ts');
  const { requestContext } = require('./fixtures/fb2322-request-context.cjs');
  const token = await session.createSession('actor');
  const proof = identity.signVerifiedFeishuIdentity({ userId: 'actor', role: 'user', tenant: 'synthetic-tenant', subject: 'synthetic-subject' }, token);
  assert.ok(proof, 'real synthetic policy-bound proof required');
  const headers = new Headers({ cookie: `${session.SESSION_COOKIE}=${token}; ${identity.PRIVATE_IDENTITY_COOKIE}=${proof}` });
  const asActor = work => requestContext(headers, async () => {
    const actor = await session.getSession(); assert.equal(actor?.id, 'actor');
    assert.equal(identity.privatePromptCapabilities(actor, origins).canReadPrivatePrompt, true);
    return work(actor);
  });
  await asActor(async actor => {
    assert.equal(identity.privatePromptCapabilities({ ...actor }, origins).canReadPrivatePrompt, false, 'plain DB/projected user cannot borrow HTTP proof');
    const view = await templates.getStudioTemplate(actor, 'template', 'studio', true);
    assert.equal(view.template.recipe.instruction, recipe.instruction, 'real private editor remains authorized only by its signed request context');
  });
  await requestContext(new Headers({ cookie: `${session.SESSION_COOKIE}=${token}` }), async () => {
    const actor = await session.getSession(); assert.equal(actor.id, 'actor');
    assert.equal(identity.privatePromptCapabilities(actor, origins).canReadPrivatePrompt, false, 'ordinary signed login is not private verified identity');
    await assert.rejects(templates.getStudioTemplate(actor, 'template', 'studio', true), error => error.status === 403);
  });
  result.passed.push('real-b9-signed-request-and-private-identity-negatives');
  const pricing = require('../src/lib/pricing/video-context.ts');
  const quotes = require('../src/lib/pricing/video.ts');
  const permissions = require('../src/lib/projects/permissions.ts');
  const body = { project_id: 'project', video_card_id: 'card', provider: 'seedance', model, duration: 5, ratio: '16:9', resolution: '480p', template_studio_run_id: 'run', template_studio_assets: inputs };
  const ordinary = { project_id: 'project', provider: 'seedance', model, duration: 5, ratio: '16:9', resolution: '480p' };
  const baseline = await snapshot();
  let activeTransaction = false, escaped = [], mediaReads = 0;
  const fsPromises = require('node:fs/promises');
  for (const name of ['realpath', 'stat', 'open']) {
    const original = fsPromises[name];
    fsPromises[name] = function (file, ...args) {
      if (typeof file === 'string' && inside(path.join(runtimeDirectory, 'public'), path.resolve(file))) {
        mediaReads++;
        if (activeTransaction) throw Error('fb2322_transaction_media_io_prohibited');
      }
      return original.call(this, file, ...args);
    };
  }
  prisma.$use(async (params, next) => {
    if (activeTransaction && params.runInTransaction !== true) escaped.push({ model: params.model || 'raw', action: params.action });
    return next(params);
  });
  const checkedTx = async (label, work) => {
    const start = performance.now(); escaped = [];
    try {
      return await prisma.$transaction(async tx => {
        activeTransaction = true;
        try { return await work(tx); } finally { activeTransaction = false; }
      });
    } finally {
      const elapsed = Math.round(performance.now() - start);
      result.timings.push({ label, ms: elapsed });
      assert.ok(elapsed < 4000, `${label}: default transaction must finish below 4000ms, no timeout/pool changes`);
      assert.deepEqual(escaped, [], `${label}: DB calls inside callback must remain on its actual tx (including auth/source permission)`);
    }
  };
  const unchanged = async () => { assert.deepEqual(await snapshot(), baseline, 'all synthetic tables and unknown/financial snapshots unchanged'); assert.equal(externalAttempts, 0); };
  const rejected = async (label, mutate, input, status) => asActor(async actor => {
    phase = label;
    await assert.rejects(checkedTx(label, async tx => {
      await tx.platformSetting.create({ data: { key: 'synthetic-rollback-canary', value_json: '{}', updated_by: 'actor' } });
      await mutate(tx);
      await pricing.resolveVideoPricingContext(actor, input, 'create', tx);
      assert.fail('fb2322_expected_permission_rejection');
    }), error => error.status === status);
    await unchanged(); result.passed.push(label);
  });
  phase = 'same_tx_ordinary_and_template';
  await asActor(async actor => {
    const before = mediaReads;
    await pricing.resolveVideoPricingContext(actor, body);
    assert.ok(mediaReads > before, 'default db caller retains real b9 physical asset preflight');
    const preparedReads = mediaReads;
    for (const input of [ordinary, body, { ...ordinary, project_id: undefined, video_card_id: 'card' }]) {
      const context = await checkedTx('context-' + (input.template_studio_run_id ? 'template' : input.project_id ? 'ordinary' : 'card-project-lookup'),
        tx => pricing.resolveVideoPricingContext(actor, input, 'create', tx));
      assert.equal(context.projectId, 'project');
      assert.equal(context.referenceVideoCount, input.template_studio_run_id ? 1 : 0);
    }
    const sourceAccess = await checkedTx('generation-use-template-access', tx => templates.getStudioTemplateUseAccess(actor, 'template', 'studio', tx));
    assert.deepEqual(Object.keys(sourceAccess).sort(), ['canManage', 'updatedAt']);
    assert.equal(sourceAccess.canManage, true);
    assert.equal(mediaReads, preparedReads, 'supplied db template path repeats DB authority, not physical media preflight');
    // A project created only in this transaction cannot be read by a global connection.
    const rollback = new Error('fb2322_positive_rollback');
    await assert.rejects(checkedTx('transaction-only-project', async tx => {
      await tx.project.create({ data: { id: 'tx-only-project', name: 'Synthetic transient project', type: 'personal', status: 'active', owner_user_id: 'actor', created_by: 'actor' } });
      const context = await pricing.resolveVideoPricingContext(actor, { ...ordinary, project_id: 'tx-only-project' }, 'create', tx);
      assert.equal(context.projectId, 'tx-only-project');
      await tx.project.findUniqueOrThrow({ where: { id: 'tx-only-project' } });
      throw rollback;
    }), error => error === rollback);
  });
  await unchanged(); result.passed.push('ordinary-template-card-and-transaction-only-project');
  await rejected('fresh-project-permission-revoked', tx => tx.projectMember.update({ where: { project_id_user_id: { project_id: 'project', user_id: 'actor' } }, data: { status: 'revoked' } }), ordinary, 403);
  await rejected('fresh-project-unavailable', tx => tx.project.update({ where: { id: 'project' }, data: { status: 'deleted' } }), ordinary, 404);
  await rejected('fresh-card-sealed', tx => tx.videoCard.update({ where: { id: 'card' }, data: { status: 'sealed' } }), body, 403);
  await rejected('fresh-template-archived', tx => tx.videoStudioTemplate.update({ where: { id: 'template' }, data: { status: 'archived' } }), body, 409);
  await rejected('fresh-template-no-longer-shared', tx => tx.videoStudioTemplate.update({ where: { id: 'template' }, data: { owner_user_id: 'source-owner', visibility: 'private' } }), body, 404);
  await rejected('fresh-source-grant-revoked', tx => tx.albumShare.update({ where: { id: 'grant' }, data: { permissions_json: JSON.stringify({ view: true, use: false }) } }), body, 403);
  await rejected('fresh-material-disabled', tx => tx.asset.update({ where: { id: 'video' }, data: { status: 'deleted' } }), body, 403);
  await rejected('fresh-material-wrong-type', tx => tx.asset.update({ where: { id: 'video' }, data: { type: 'audio' } }), body, 403);
  phase = 'actual_create_and_draft_prefixes';
  const project = await prisma.project.findUniqueOrThrow({ where: { id: 'project' } });
  const draft = await prisma.videoTask.findUniqueOrThrow({ where: { id: 'draft' } });
  for (const [index, file] of fixture.callers.entries()) await asActor(async actor => {
    const operation = index ? 'draft_upgrade' : 'create';
    const inputBody = index ? pricing.savedVideoPricingContextInput(draft, true) : body;
    const context = await pricing.resolveVideoPricingContext(actor, inputBody, operation);
    const quote = await quotes.quoteVideoPricing({ provider: 'seedance', model, duration: 5, resolution: index ? '1080p' : '480p', context });
    const credential = pricing.issueVideoPricingCredential(context, quote.revision, quote.pricing.estimatedCost);
    const bindings = { user: actor, input: { user: actor, pricingQuoteToken: credential, pricingRevision: quote.revision },
      body: { ...inputBody, pricing_quote_token: credential, pricing_revision: quote.revision }, project, videoCardId: 'card', videoBranch: null,
      creationBody: {}, draft, priceQuote: quote, requireScopeCredential: true, needsPricingCredential: true,
      idempotencyKey: 'synthetic-current-request', requestClaim: null, canvasAdmission: null, estimatedCost: quote.pricing.estimatedCost,
      requestedProvider: 'seedance', H3_VIDEO_PROVIDER: 'h3', selectedModel: model, resolution: '480p', duration: 5, draftRequested: false,
      multiviewGeneration: null, multiviewRecipe: null, multiviewSystemReference: null,
      ...pricing, assertVideoPricingAcceptance: quotes.assertVideoPricingAcceptance,
      assertProjectActiveInTransaction: permissions.assertProjectActiveInTransaction,
      assertMultiviewRequestFence: require('../src/lib/video/multiview-request-receipt.ts').assertMultiviewRequestFence,
      assertLegacyCreationSourceLocks: require('../src/lib/creation/lineage.ts').assertLegacyCreationSourceLocks,
      assertCanvasVideoAdmission: require('../src/lib/canvas-video-batches-guards.ts').assertCanvasVideoAdmission,
      DraftUpgradeError: require('../src/lib/tasks/seedance-draft-upgrade.ts').DraftUpgradeError };
    assert.equal(await checkedTx('actual-prefix-' + operation, tx => fixture.runPrefix(root, file, bindings, tx)), 'checked-before-task-write');
    await unchanged();
    for (const negative of ['permission-revoked', 'project-unavailable', 'quote-context-changed']) {
      const expectedStatus = negative === 'quote-context-changed' ? 409 : 403;
      await assert.rejects(checkedTx('actual-prefix-' + operation + '-' + negative, async tx => {
        await tx.platformSetting.create({ data: { key: 'synthetic-prefix-canary', value_json: '{}', updated_by: 'actor' } });
        if (negative === 'permission-revoked') await tx.projectMember.update({ where: { project_id_user_id: { project_id: 'project', user_id: 'actor' } }, data: { status: 'revoked' } });
        if (negative === 'project-unavailable') await tx.project.update({ where: { id: 'project' }, data: { status: 'archived' } });
        const changed = negative !== 'quote-context-changed' ? bindings : index
          ? bindings : { ...bindings, duration: 6 };
        if (negative === 'quote-context-changed' && index) await tx.videoTask.update({ where: { id: draft.id }, data: { duration: 6 } });
        await fixture.runPrefix(root, file, changed, tx);
        assert.fail('fb2322_expected_prefix_rejection');
      }), error => error.status === expectedStatus);
      await unchanged();
    }
    result.passed.push('actual-' + operation + '-prefix-and-fresh-permission-project-quote-negatives');
  });
  phase = 'template_material_quote_version_change';
  await asActor(async actor => {
    const quoted = await pricing.resolveVideoPricingContext(actor, body);
    const credential = pricing.issueVideoPricingCredential(quoted, null, 5);
    await assert.rejects(checkedTx('template-material-quote-changed', async tx => {
      await tx.asset.update({ where: { id: 'video' }, data: { hash: 'fixture-version-b' } });
      const fresh = await pricing.resolveVideoPricingContext(actor, body, 'create', tx);
      assert.notEqual(fresh.fingerprint, quoted.fingerprint);
      pricing.verifyVideoPricingCredential(credential, fresh, null, 5);
    }), error => error.status === 409);
  });
  await unchanged(); result.passed.push('material-version-quote-context-change-and-full-rollback');
  result.externalRequests = externalAttempts;
  result.sourceSha256 = Object.fromEntries([...fixture.callers, fixture.pricingFile].map(file => [file, fixture.sha(fs.readFileSync(path.join(root, file)))]));
  result.prefixSha256 = Object.fromEntries(fixture.callers.map(file => [file, fixture.prefix(root, file).prefixSha256]));
  result.actualPrisma = true; result.poolAndTimeoutUnmodified = true; result.allSyntheticRowsUnchanged = true;
  result.defaultPhysicalPreflightPreserved = true; result.transactionMediaPreparationForbidden = true;
  result.privateEditorIdentityPreserved = true;
  result.scope = 'actual pre-write transaction prefixes, not full POST/provider/admission/billing execution';
  write(path.join(directory, 'result.json'), result);
  console.log(JSON.stringify({ ...result, evidenceDirectory: directory }));
}
if (require.main === module) void main().catch(error => {
  const failure = { fixture: 'fb2322-video-tx', phase, ...fixture.safeError(error), externalAttempts,
    completed: result.passed, timings: result.timings, evidenceDirectory: directory || null };
  if (directory) fs.writeFileSync(path.join(directory, 'failure.json'), JSON.stringify(failure), { mode: 0o600 });
  console.error(JSON.stringify(failure)); process.exitCode = 1;
}).finally(async () => { if (prisma) await prisma.$disconnect(); process.chdir(originalCwd); });
