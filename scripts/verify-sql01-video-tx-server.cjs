// Lead-only real SQLite proof. No existing database, media or provider access.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
let phase = 'guard';
const diagnosticClasses = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AssertionError', 'AuthError', 'PublicApiError',
  'VideoPricingContextError', 'PricingChargeError', 'StudioError', 'StudioValidationError', 'PrivatePromptError', 'PrivatePromptAccessError', 'PrivateDraftConflict',
  'PrismaClientKnownRequestError', 'PrismaClientInitializationError', 'PrismaClientValidationError']);
const diagnosticCodes = new Set(['INVALID', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'UNAVAILABLE', 'UNAUTHENTICATED',
  'PRIVATE_PROMPT_UNAVAILABLE', 'PRIVATE_PROMPT_ACCESS_DENIED', 'pricing_context_invalid', 'pricing_context_changed', 'ERR_ASSERTION']);
const diagnosticMessages = new Set([
  '账号当前不可用', '外部账号无权访问视频模板工作台。', '模板要求不能为空', '项目不存在', '无权在此项目中生成内容', '视频卡不存在', '视频卡不属于当前项目',
  '视频卡已封板或归档，不能继续生成', '运行快照无法读取', '运行记录不存在或无权访问', '只有已完成的运行记录可以提交生成',
  '模板已归档或撤销，不能提交生成', '模板不存在或无权访问', '模板不存在或已撤销', '模板版本不可用，请回工作台重新确认',
  '模板内容已变化，请回工作台重新确认', '这条记录没有可安全使用的文案，请重新整理', '素材不存在、已停用或无权使用', '无权使用此素材',
  '素材存储地址不受信任，无法安全读取', '素材文件当前不可读取，请重新选择或上传', '模板报价缺少最终素材', '模板报价素材无效',
  '模板报价素材重复', '模板原素材角色已变化，请重新准备', '模板报价槽位与已保存来源不符', '模板报价槽位数量超出原限制',
  '模板报价缺少必填素材，未按无参考视频计价', '模板参考视频已失效', '报价范围或有效期已变化，请保留输入重新报价；尚未生成',
  '私密设置暂不可用，原输入和请求编号已保留；请稍后重试或联系维护人员', 'sql01_fixture_network_prohibited',
]);
function diagnosticProperty(value, key) {
  try {
    for (let at = value, depth = 0; at && depth < 3; at = Object.getPrototypeOf(at), depth++) {
      const descriptor = Object.getOwnPropertyDescriptor(at, key);
      if (descriptor) return Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
    }
  } catch { /* Diagnostic serialization must not invoke getters or expose arbitrary values. */ }
}
function safeVideoFixtureError(error, depth = 0, seen = new Set()) {
  if (!error || typeof error !== 'object') return { className: 'NonError', message: '[redacted non-error cause]' };
  if (seen.has(error) || depth > 2) return { className: 'TruncatedCause' };
  seen.add(error);
  const constructor = diagnosticProperty(error, 'constructor'), type = typeof constructor === 'function' ? diagnosticProperty(constructor, 'name') : undefined;
  const name = diagnosticProperty(error, 'name'), code = diagnosticProperty(error, 'code'), status = diagnosticProperty(error, 'status');
  const message = diagnosticProperty(error, 'message'), cause = diagnosticProperty(error, 'cause');
  return { className: diagnosticClasses.has(type) ? type : 'OtherError', name: diagnosticClasses.has(name) ? name : 'OtherError',
    code: typeof code === 'string' && (/^P\d{4}$/.test(code) || diagnosticCodes.has(code)) ? code : null,
    status: Number.isInteger(status) && status >= 400 && status <= 599 ? status : null,
    message: diagnosticMessages.has(message) ? message : '[redacted non-allowlisted message]',
    messageLength: typeof message === 'string' ? Math.min(message.length, 16384) : 0,
    ...(cause !== undefined ? { cause: safeVideoFixtureError(cause, depth + 1, seen) } : {}) };
}
exports.safeVideoFixtureError = safeVideoFixtureError;
async function main() {
  assert.equal(process.platform, 'linux'); assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(process.env.SD2_DATABASE_MODE, 'writer'); assert.equal(process.env.AUD_SQL01_VIDEO_SERVER, '1');
  assert.equal(Reflect.get(globalThis, Symbol.for('video-api.database-client.v1')), undefined);
  const root = path.resolve(__dirname, '..'), directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sql01-video-'));
  const file = path.join(directory, 'synthetic.db'); assert.equal(fs.existsSync(file), false);
  fs.writeFileSync(file, '', { flag: 'wx', mode: 0o600 });
  process.env.DATABASE_URL = 'file:' + file;
  process.env.FEISHU_FEEDBACK_ENABLED = 'false'; process.env.CHECKPOINT_DISABLE = '1';
  process.env.SESSION_SECRET = randomBytes(48).toString('hex');
  process.env.MEDIA_DATA_ROOT = path.join(directory, 'unused-media-root');
  globalThis.AsyncLocalStorage = require('node:async_hooks').AsyncLocalStorage;
  let forbidden = 0, prisma;
  const denied = () => { forbidden++; throw Error('sql01_fixture_network_prohibited'); };
  globalThis.fetch = denied;
  for (const module of ['node:http', 'node:https']) { require(module).request = denied; require(module).get = denied; }
  try {
    phase = 'fresh_synthetic_schema';
    const target = await require('@prisma/get-platform').getBinaryTargetForCurrentPlatform();
    const engine = path.join(path.dirname(require.resolve('@prisma/engines')), '..', 'schema-engine-' + target);
    assert.ok(fs.existsSync(engine), 'installed schema engine required; no downloads');
    execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'db', 'push', '--skip-generate', '--schema', path.join(root, 'prisma/schema.prisma')],
      { cwd: directory, env: { ...process.env, PRISMA_SCHEMA_ENGINE_BINARY: engine, PRISMA_GENERATE_SKIP_AUTOINSTALL: '1' }, timeout: 120000, stdio: 'pipe' });
    require('./server-runtime.cjs');
    ({ prisma } = require('../src/lib/prisma.ts'));
    const main = await prisma.$queryRawUnsafe('PRAGMA database_list');
    assert.equal(fs.realpathSync(main.find(row => row.name === 'main').file), file);
    const factory = require('../src/lib/database/client.ts');
    assert.equal(factory.databaseClientState().clientsConstructed, 1); assert.equal(factory.databaseClientState().sqliteConnectionLimit, 1);
    phase = 'synthetic_seed';
    for (const id of ['actor', 'project-owner', 'source-owner']) await prisma.user.create({ data: {
      id, username: 'sql01-' + id, name: id, email: id + '@synthetic.invalid', password_hash: 'synthetic-unusable',
      role: 'user', account_type: 'internal', feature_profile_id: 'internal_email_authorized', status: 'active',
    } });
    await prisma.project.create({ data: { id: 'project', name: 'Synthetic project', type: 'team', status: 'active', owner_user_id: 'project-owner', created_by: 'project-owner' } });
    await prisma.projectMember.create({ data: { project_id: 'project', user_id: 'actor', role: 'editor', status: 'active', joined_by: 'project-owner' } });
    await prisma.videoCard.create({ data: { id: 'card', project_id: 'project', title: 'Synthetic card', owner_user_id: 'actor', created_by: 'actor', status: 'active' } });
    await prisma.asset.create({ data: { id: 'video', owner_id: 'source-owner', type: 'video', status: 'active',
      original_url: 'https://synthetic.invalid/never-read.mp4', file_name: 'synthetic.mp4', file_size: 12, hash: 'synthetic-hash', mime_type: 'video/mp4' } });
    await prisma.referenceAlbum.create({ data: { id: 'album', name: 'Synthetic', owner_user_id: 'source-owner', album_type: 'private', visibility: 'private', status: 'active' } });
    await prisma.albumShare.create({ data: { id: 'grant', album_id: 'album', grantee_type: 'project', grantee_id: 'project', created_by: 'source-owner',
      permissions_json: JSON.stringify({ view: true, use: true }) } });
    await prisma.referenceImage.create({ data: { id: 'reference', album_id: 'album', asset_id: 'video', owner_user_id: 'source-owner', url: 'https://synthetic.invalid/never-read.mp4', status: 'active', source_type: 'upload' } });
    const { normalizeRecipe } = require('../src/lib/template-studio/validation.ts');
    const recipe = normalizeRecipe({ instruction: 'Synthetic public video requirement', fields: [], assetSlots: [{ key: 'video', label: 'Video', role: 'reference', types: ['video'], required: true, maxItems: 1 }], defaultParameters: {} });
    await prisma.videoStudioTemplate.create({ data: { id: 'template', owner_user_id: 'actor', name: 'Synthetic', status: 'published', visibility: 'shared', recipe_json: JSON.stringify(recipe) } });
    await prisma.videoStudioTemplateVersion.create({ data: { id: 'version', template_id: 'template', version_number: 1, name: 'Synthetic', group_name: 'Synthetic', recipe_json: JSON.stringify(recipe), created_by: 'actor' } });
    await prisma.videoStudioTemplate.update({ where: { id: 'template' }, data: { published_version_id: 'version' } });
    const inputs = [{ assetId: 'video', type: 'video', role: 'reference', slotKey: 'video' }];
    const snapshot = { owner: { userId: 'actor', username: 'sql01-actor', displayName: 'Actor', avatarUrl: null, accountType: 'internal' },
      input: { name: 'Synthetic', groupName: '', values: {}, draftPrompt: 'Synthetic public input' }, prompt: 'Synthetic public input',
      recipe, parameters: {}, assets: inputs,
      templateVersion: { templateId: 'template', templateSource: 'studio', versionId: 'version', sourceRevision: 'studio:1' } };
    await prisma.videoStudioDraft.create({ data: { id: 'studio-draft', owner_user_id: 'actor', name: 'Synthetic', prompt: 'Synthetic public input', assets_json: JSON.stringify(inputs) } });
    await prisma.videoStudioRun.create({ data: { id: 'run', owner_user_id: 'actor', draft_id: 'studio-draft', request_id: 'original-run', request_fingerprint: 'original-frozen',
      source: 'studio', mode: 'direct', status: 'succeeded', snapshot_json: JSON.stringify(snapshot), prompt: 'Synthetic public input' } });
    const model = require('../src/lib/provider/seedance-models.ts').SEEDANCE_2_5_MODEL_ID;
    await prisma.videoTask.create({ data: { id: 'draft', provider: 'seedance', model, generation_mode: 'all_in_one_reference', prompt: 'Synthetic draft',
      owner_user_id: 'actor', user_id: 'actor', project_id: 'project', video_card_id: 'card', local_status: 'succeeded', is_draft: true,
      provider_draft_task_id: 'original-provider-draft', duration: 5, ratio: '16:9', resolution: '480p', reference_video_urls: '[]' } });
    await prisma.videoTask.create({ data: { id: 'unknown', provider: 'seedance', model, generation_mode: 'all_in_one_reference', prompt: 'Keep original',
      owner_user_id: 'actor', user_id: 'actor', local_status: 'unknown', idempotency_key: 'original-unknown', provider_task_id: 'original-provider-id',
      frozen_cost: 5, estimated_cost: 5, credit_freeze_snapshot: 'original-frozen-snapshot' } });
    await prisma.creditAccount.create({ data: { user_id: 'actor', balance: 95, frozen_credits: 5 } });
    const session = require('../src/lib/auth/session.ts'), { requestAsyncStorage } = require('./fixtures/next-request-context.ts');
    const token = await session.createSession('actor');
    const headers = new Headers({ cookie: session.SESSION_COOKIE + '=' + token });
    const pricing = require('../src/lib/pricing/video-context.ts');
    const quotes = require('../src/lib/pricing/video.ts');
    const permissions = require('../src/lib/projects/permissions.ts');
    const { runCreatePrefix, sources } = require('./sql01-video-fixture.cjs');
    const modelId = model;
    const body = { project_id: 'project', video_card_id: 'card', provider: 'seedance', model: modelId, duration: 5, resolution: '480p', ratio: '16:9',
      template_studio_run_id: 'run', template_studio_assets: inputs };
    const controls = { tasks: 'videoTask', holds: 'creditHold', wallets: 'creditAccount', ledger: 'creditLedger', budgets: 'projectBudgetAccount',
      budgetLedger: 'projectBudgetLedger', approvals: 'approvalRecord', usage: 'approvalUsage', providerRequests: 'providerApiRequest', receipts: 'platformSetting' };
    const protectedRows = async () => Object.fromEntries(await Promise.all(Object.entries(controls).map(async ([key, model]) => [key, await prisma[model].findMany()])));
    const baseline = await protectedRows(), timings = [];
    const contextInTx = async (input, operation = 'create') => requestAsyncStorage.run({ headers }, async () => {
      const actor = await session.getSession(); assert.equal(actor.id, 'actor');
      const start = performance.now();
      const result = await prisma.$transaction(tx => pricing.resolveVideoPricingContext(actor, input, operation, tx));
      const elapsed = performance.now() - start; assert.ok(elapsed < 4000, 'single-connection context must not wait for its own transaction timeout'); timings.push(Math.round(elapsed));
      return result;
    });
    phase = 'actual_context_template_assets_and_cookie';
    const context = await contextInTx(body); assert.equal(context.referenceVideoCount, 1);
    const signature = pricing.issueVideoPricingCredential(context, null, 5);
    assert.doesNotThrow(() => pricing.verifyVideoPricingCredential(signature, context, null, 5));
    phase = 'actual_create_transaction_prefixes';
    for (let i = 0; i < sources.length; i++) await requestAsyncStorage.run({ headers }, async () => {
      const user = await session.getSession(), draft = await prisma.videoTask.findUniqueOrThrow({ where: { id: 'draft' } });
      const inputBody = i ? { ...pricing.savedVideoPricingContextInput(draft, true), model: modelId } : body;
      const mode = i ? 'draft_upgrade' : 'create';
      const fresh = await prisma.$transaction(tx => pricing.resolveVideoPricingContext(user, inputBody, mode, tx));
      const priceQuote = await quotes.quoteVideoPricing({ provider: 'seedance', model: modelId, duration: 5, resolution: i ? '1080p' : '480p', context: fresh });
      const pricingToken = pricing.issueVideoPricingCredential(fresh, priceQuote.revision, priceQuote.pricing.estimatedCost);
      const project = await prisma.project.findUniqueOrThrow({ where: { id: 'project' } });
      const bindings = { user, input: { user, pricingQuoteToken: pricingToken, pricingRevision: null }, body: { ...body, pricing_quote_token: pricingToken },
        creationBody: {}, requestClaim: null, idempotencyKey: null, project, videoCardId: 'card', videoBranch: null, draft: { ...draft, model: modelId },
        priceQuote, requestedProvider: 'seedance', H3_VIDEO_PROVIDER: 'h3', selectedModel: modelId, resolution: '480p', duration: 5, draftRequested: false,
        requireScopeCredential: true, needsPricingCredential: true, multiviewGeneration: null, multiviewRecipe: null, multiviewSystemReference: null,
        canvasAdmission: null, estimatedCost: priceQuote.pricing.estimatedCost,
        ...pricing, assertProjectActiveInTransaction: permissions.assertProjectActiveInTransaction,
        assertMultiviewRequestFence: require('../src/lib/video/multiview-request-receipt.ts').assertMultiviewRequestFence,
        assertLegacyCreationSourceLocks: require('../src/lib/creation/lineage.ts').assertLegacyCreationSourceLocks,
        assertCanvasVideoAdmission: require('../src/lib/canvas-video-batches-guards.ts').assertCanvasVideoAdmission,
        assertVideoPricingAcceptance: quotes.assertVideoPricingAcceptance,
      };
      const start = performance.now();
      assert.equal(await prisma.$transaction(tx => runCreatePrefix(sources[i], bindings, tx)), 'checked-before-any-write');
      assert.ok(performance.now() - start < 4000, 'actual transaction prefix cannot reenter global Prisma');
    });
    phase = 'actual_canvas_admission_same_connection';
    const canvas = require('../src/lib/canvas-video-batches-guards.ts');
    await prisma.canvasDocument.create({ data: { id: 'document', owner_user_id: 'actor', project_id: 'project',
      title: 'Synthetic SQL01', document_json: JSON.stringify({ canvas: { nodes: [{ id: 'node' }] } }) } });
    const canvasBody = { provider: 'h3', canvas_document_id: 'document', canvas_node_id: 'node', idempotency_key: 'canvas-child' };
    const routeFingerprint = await canvas.canvasVideoRouteFingerprint(canvasBody.provider);
    await prisma.canvasVideoBatch.create({ data: { id: 'batch', owner_user_id: 'actor', document_id: 'document', node_id: 'node',
      project_id: 'project', video_card_id: 'card', client_request_id: 'synthetic-batch-request', request_hash: 'synthetic-hash',
      count: 1, frozen_input_json: JSON.stringify(canvasBody), authorized_total: 1000,
      active_node_key: canvas.canvasBatchHash(['actor', 'document', 'node']) } });
    await prisma.canvasVideoBatchChild.create({ data: { id: 'child', batch_id: 'batch', ordinal: 0, request_id: 'synthetic-child-request',
      idempotency_key: 'canvas-child', business_fingerprint: 'synthetic-business', route_fingerprint: routeFingerprint,
      frozen_input_json: JSON.stringify(canvasBody), authorized_maximum: 1000, quote_expires_at: new Date(Date.now() + 60000) } });
    const admission = { reference: { batch_id: 'batch', child_id: 'child', contract_version: 1, child_revision: 1 },
      childRevision: 1, fingerprint: 'synthetic-business' };
    await requestAsyncStorage.run({ headers }, async () => {
      const actor = await session.getSession(), start = performance.now();
      await assert.rejects(prisma.$transaction(async tx => {
        await canvas.assertCanvasVideoAdmission(tx, actor, canvasBody, admission,
          { projectId: 'project', videoCardId: 'card', branchId: null, amount: 1 });
        assert.equal((await tx.canvasVideoBatch.findUniqueOrThrow({ where: { id: 'batch' } })).admitted_total, 100);
        throw Error('synthetic-canvas-rollback');
      }), /synthetic-canvas-rollback/);
      assert.ok(performance.now() - start < 4000, 'canvas route check must not wait on global connection');
      assert.equal((await prisma.canvasVideoBatch.findUniqueOrThrow({ where: { id: 'batch' } })).admitted_total, 0);
      await assert.rejects(prisma.$transaction(tx => canvas.assertCanvasVideoAdmission(tx, actor,
        { ...canvasBody, canvas_node_id: 'other-node' }, admission,
        { projectId: 'project', videoCardId: 'card', branchId: null, amount: 1 })), error => error.status === 409);
    });
    phase = 'fresh_authority_negatives';
    await prisma.projectMember.update({ where: { project_id_user_id: { project_id: 'project', user_id: 'actor' } }, data: { status: 'revoked' } });
    await assert.rejects(contextInTx(body), error => error.status === 403);
    await prisma.projectMember.update({ where: { project_id_user_id: { project_id: 'project', user_id: 'actor' } }, data: { status: 'active' } });
    await prisma.videoCard.update({ where: { id: 'card' }, data: { status: 'sealed' } });
    await assert.rejects(contextInTx(body), error => error.status === 403);
    await prisma.videoCard.update({ where: { id: 'card' }, data: { status: 'active' } });
    await prisma.albumShare.update({ where: { id: 'grant' }, data: { permissions_json: JSON.stringify({ view: true, use: false }) } });
    await assert.rejects(contextInTx(body), error => error.status === 403);
    await prisma.albumShare.update({ where: { id: 'grant' }, data: { permissions_json: JSON.stringify({ view: true, use: true }) } });
    await prisma.videoStudioTemplate.update({ where: { id: 'template' }, data: { status: 'archived' } });
    await assert.rejects(contextInTx(body), error => error.status === 409);
    phase = 'no_submission_or_money_mutation';
    assert.deepEqual(await protectedRows(), baseline); assert.equal(forbidden, 0);
    assert.equal(fs.existsSync(process.env.MEDIA_DATA_ROOT), false, 'no media file preflight ran inside the write transaction');
    assert.equal(factory.databaseClientState().clientsConstructed, 1); assert.equal(factory.databaseClientState().sqliteConnectionLimit, 1);
    console.log(JSON.stringify({ syntheticOnly: true, actualPrisma: true, nextCookieSession: true, contextMs: timings,
      createAndDraftPrefixes: 2, canvasAdmissionAndRollback: true, projectCardTemplateAndAssetNegatives: true, protectedRowsUnchanged: true, externalRequests: forbidden }));
  } finally { if (prisma) await prisma.$disconnect(); fs.rmSync(directory, { recursive: true, force: true }); }
}
if (require.main === module) void main().catch(error => {
  console.error(JSON.stringify({ error: 'sql01_video_native_proof_failed', phase, ...safeVideoFixtureError(error) })); process.exitCode = 1;
});
