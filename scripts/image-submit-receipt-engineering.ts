import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import http from 'node:http';
import https from 'node:https';
import { mock } from 'node:test';
import ts from 'typescript';
import type { SessionUser } from '@/lib/auth/session';
import type { AvatarCandidate } from '@/lib/avatar-random/types';

/** Actual isolated SQLite, production admission/fence functions and API handlers. No supplier calls. */
async function main() {
  const root = fs.realpathSync(process.cwd()), startedAt = new Date().toISOString();
  const scratch = path.join(root, '.role-tests'); fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
  assert.ok(fs.lstatSync(scratch).isDirectory() && !fs.lstatSync(scratch).isSymbolicLink());
  const previousUmask = process.umask(0o077), directory = fs.mkdtempSync(path.join(scratch, 'image-submit-receipt-'));
  const databasePath = path.join(directory, 'synthetic.db'), schemaPath = path.join(directory, 'schema.prisma');
  const generatedClientPath = path.join(directory, 'generated-client');
  const schema = fs.readFileSync(path.join(root, 'prisma/schema.prisma'), 'utf8').replace(
    /generator client \{/, `generator client {\n  output = ${JSON.stringify(generatedClientPath)}`);
  fs.writeFileSync(schemaPath, schema, { mode: 0o600 });
  assert.equal(Reflect.get(globalThis, 'prisma'), undefined, 'The fixture must start before a real database client is loaded');
  process.env.DATABASE_URL = `file:${databasePath}`; Object.assign(process.env, { NODE_ENV: 'test', PRIVATE_PROMPTS_MIN_STATE: 'legacy-read' });
  delete process.env.PRIVATE_PROMPTS_POLICY_FILE; delete process.env.IMAGE_STUDIO_REQUEST_CLOSE_ENABLED;
  Reflect.set(globalThis, 'AsyncLocalStorage', AsyncLocalStorage);
  const require = createRequire(import.meta.url), prismaPackage = require.resolve('prisma/package.json');
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', DATABASE_URL: process.env.DATABASE_URL, PRISMA_GENERATE_SKIP_AUTOINSTALL: '1', CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1' };
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ']) if (process.env[name]) env[name] = process.env[name];
  const schemaLog = execFileSync(process.execPath, [path.join(path.dirname(prismaPackage), 'build/index.js'), 'db', 'push', '--skip-generate', '--schema', schemaPath],
    { cwd: directory, env, encoding: 'utf8', timeout: 120000 });
  fs.writeFileSync(path.join(directory, 'schema.log'), schemaLog, { mode: 0o600 });
  const generationLog = execFileSync(process.execPath, [path.join(path.dirname(prismaPackage), 'build/index.js'), 'generate', '--schema', schemaPath],
    { cwd: directory, env, encoding: 'utf8', timeout: 120000 });
  fs.writeFileSync(path.join(directory, 'client-generation.log'), generationLog, { mode: 0o600 });
  const { PrismaClient } = require(generatedClientPath) as typeof import('@prisma/client'); const db = new PrismaClient();
  let failEvidenceRead = false, externalCalls = 0;
  const client = db.$extends({ query: { creditLedger: { async findFirst({ args, query }) {
    if (failEvidenceRead) throw new Error('Synthetic evidence read unavailable');
    return query(args);
  } } } });
  Reflect.set(globalThis, 'prisma', client);
  const blockNetwork = () => { externalCalls++; throw new Error('External network/generation prohibited by this isolated fixture'); };
  mock.method(globalThis, 'fetch', blockNetwork); mock.method(http, 'request', blockNetwork); mock.method(http, 'get', blockNetwork);
  mock.method(https, 'request', blockNetwork); mock.method(https, 'get', blockNetwork);
  const NodeModule = require('node:module') as { _load: (id: string, ...rest: unknown[]) => unknown };
  const originalLoad = NodeModule._load;
  // Node CLI executes server helpers directly; the product's browser-only import guard is irrelevant here.
  NodeModule._load = function (id: string, ...rest: unknown[]) { return id === 'server-only' ? {} : originalLoad.call(this, id, ...rest); };
  const checks: string[] = [];
  const check = (name: string) => { checks.push(name); console.error('[image-submit-receipt-fixture]', JSON.stringify({ synthetic: true, check: name })); };
  try {
    const receipts = require(path.join(root, 'src/lib/image-studio/submit-receipts.server.ts')) as typeof import('@/lib/image-studio/submit-receipts.server');
    const tasks = require(path.join(root, 'src/lib/image-studio/tasks.ts')) as typeof import('@/lib/image-studio/tasks');
    const batches = require(path.join(root, 'src/lib/image-studio/batches.ts')) as typeof import('@/lib/image-studio/batches');
    const sync = require(path.join(root, 'src/lib/image-studio/synchronous-admission.ts')) as typeof import('@/lib/image-studio/synchronous-admission');
    const privatePrompts = require(path.join(root, 'src/lib/security/private-prompts.server.ts')) as typeof import('@/lib/security/private-prompts.server');
    const { NextRequest } = require('next/server') as typeof import('next/server');
    const owner = 'submit-receipt-synthetic-owner', other = 'submit-receipt-synthetic-other';
    const user = { id: owner, name: 'Synthetic owner', username: owner, email: `${owner}@fixture.invalid`, role: 'admin', status: 'active', account_type: 'internal', user_profile: 'default', feature_profile_id: null, expires_at: null } as SessionUser;
    for (const id of [owner, other]) await db.user.create({ data: { id, name: id, username: id, email: `${id}@fixture.invalid`, password_hash: 'synthetic-not-a-login', role: 'admin', account_type: 'internal' } });
    const hash = (id: string, account = owner) => createHash('sha256').update(`${account}:${id}`).digest('hex');
    const key = receipts.studioSubmitReceiptKey;
    const request = (suffix: string) => `synthetic-${suffix}-${randomUUID()}`;
    const taskData = (requestId: string, ordinal = 0, moduleId: string | null = null) => ({
      id: `${hash(requestId)}-${ordinal}`, batch_id: hash(requestId), owner_id: owner, module_id: moduleId, ordinal: ordinal + 1,
      fingerprint: 'synthetic-original-fingerprint', prompt: 'synthetic-personal', context: '', revision: 0, model: 'gemini-nano-banana-2.1',
      reference_ids: '[]', unit_credits: 0, snapshot_json: JSON.stringify({ sourcePresetId: null, moduleId, prompt: 'synthetic-personal' }), status: 'queued',
    });
    let activeUser: SessionUser | null = user;
    function apiSource<T>(relative: string, overrides: Record<string, unknown> = {}): T {
      const file = path.join(root, relative), code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
      } }).outputText;
      const module = { exports: {} };
      const load = (id: string) => {
        if (id === '@/lib/auth/session') return { getSession: async () => activeUser };
        if (Object.hasOwn(overrides, id)) return overrides[id];
        return require(id.startsWith('@/') ? path.join(root, 'src', id.slice(2)) : id.startsWith('.') ? path.resolve(path.dirname(file), id) : id);
      };
      const run = vm.runInThisContext(`(function(require,module,exports,__filename,__dirname){${code}\n})`, { filename: file });
      run(load, module, module.exports, file, path.dirname(file));
      return module.exports as T;
    }
    const taskApi = apiSource<typeof import('@/app/api/image-studio/tasks/route')>('src/app/api/image-studio/tasks/route.ts');
    const batchApi = apiSource<typeof import('@/app/api/image-studio/batches/route')>('src/app/api/image-studio/batches/route.ts');
    const requestApi = apiSource<typeof import('@/app/api/image-studio/requests/route')>('src/app/api/image-studio/requests/route.ts');
    const post = (url: string, body: unknown, headers: Record<string, string> = {}) => new NextRequest(`https://fixture.invalid${url}`, { method: 'POST', headers: { 'content-type': 'application/json', host: '127.0.0.1:3302', 'x-forwarded-host': 'fixture.invalid', origin: 'https://fixture.invalid', ...headers }, body: JSON.stringify(body) });

    const unknown = request('unknown');
    assert.equal((await receipts.readStudioSubmitReceipt(owner, unknown)).state, 'unknown');
    assert.equal(await db.platformSetting.count({ where: { key: key(owner, unknown) } }), 0);
    check('empty_query_stays_unknown_without_writing_receipt');

    for (const [index, prompt] of ['ppenc:v1:synthetic-not-a-secret', JSON.stringify({ format: 'private-prompt.v1', ciphertext: 'synthetic' }), { format: 'private-prompt.v1', ciphertext: 'synthetic-object' }].entries()) {
      const id = request(`encrypted-${index}`);
      const response = await taskApi.POST(post('/api/image-studio/tasks', { requestId: id, prompt, personalPrompt: prompt }));
      const payload = await response.json();
      assert.equal(response.status, 400); assert.equal(payload.code, 'PERSONAL_PROMPT_ENCRYPTED'); assert.equal(payload.requestId, id);
      assert.equal(payload.receipt?.schema, 'image.submit-receipt.v1'); assert.equal(payload.receipt?.requestId, id); assert.equal(payload.receipt?.state, 'rejected'); assert.equal(payload.receipt?.stage, 'input');
      const durable = await db.platformSetting.findUniqueOrThrow({ where: { key: key(owner, id) } });
      const stored = JSON.parse(durable.value_json);
      assert.equal(stored.schema, 'image.submit-receipt.v1'); assert.equal(stored.account, owner); assert.equal(stored.code, 'PERSONAL_PROMPT_ENCRYPTED');
      assert.ok(!durable.value_json.includes('ppenc:') && !durable.value_json.includes('ciphertext'));
      assert.equal((await receipts.readStudioSubmitReceipt(owner, id)).state, 'rejected');
      await assert.rejects(() => receipts.assertStudioRequestWritable(db, owner, id), (error: unknown) => error instanceof receipts.StudioSubmitReceiptError);
    }
    check('encrypted_string_and_json_envelopes_have_matching_durable_rejection_without_body');

    const genericId = request('http-only'), genericError = Object.assign(new Error('Synthetic status alone'), { status: 409 });
    const genericApi = apiSource<typeof taskApi>('src/app/api/image-studio/tasks/route.ts', { '@/lib/image-studio/tasks': { ...tasks, submitStudioBatch: async () => { throw genericError; } } });
    const genericResponse = await genericApi.POST(post('/api/image-studio/tasks', { requestId: genericId, prompt: 'safe' }));
    const generic = await genericResponse.json(); assert.equal(genericResponse.status, 409); assert.equal(generic.requestId, genericId); assert.equal(generic.receipt, undefined); assert.equal(generic.submitted, undefined);
    assert.equal((await receipts.readStudioSubmitReceipt(owner, genericId)).state, 'unknown');
    check('generic_http_status_cannot_manufacture_nonacceptance');

    const privateId = request('private-stage'), privateError = new privatePrompts.PrivatePromptError(); receipts.markStudioSubmitFailure(privateError, 'private-snapshot');
    const privateApi = apiSource<typeof taskApi>('src/app/api/image-studio/tasks/route.ts', { '@/lib/image-studio/tasks': { ...tasks, submitStudioBatch: async () => { throw privateError; } } });
    const privateResponse = await privateApi.POST(post('/api/image-studio/tasks', { requestId: privateId, prompt: 'safe' }));
    const privateFailure = await privateResponse.json(); assert.equal(privateResponse.status, 503); assert.equal(privateFailure.receipt?.state, 'rejected'); assert.equal(privateFailure.receipt?.code, 'PRIVATE_PROMPT_UNAVAILABLE'); assert.equal(privateFailure.receipt?.stage, 'private-snapshot');
    check('real_private_error_code_and_stage_survive_without_plaintext');

    const acceptedId = request('accepted'), moduleId = '11111111-1111-4111-8111-111111111111';
    const original = await db.imageStudioTask.create({ data: taskData(acceptedId, 0, moduleId) });
    const ack = await tasks.submitStudioBatch(owner, { requestId: acceptedId, moduleId, prompt: 'ppenc:v1:synthetic-invalid-input', revision: -123, count: 500 });
    assert.equal(ack, hash(acceptedId));
    assert.equal((await receipts.closeStudioSubmission(owner, acceptedId)).state, 'accepted');
    assert.equal(await receipts.rejectStudioSubmission(owner, acceptedId, { code: 'PERSONAL_PROMPT_ENCRYPTED', stage: 'input' }), null);
    await assert.rejects(() => tasks.submitStudioBatch(owner, { requestId: acceptedId, moduleId: '22222222-2222-4222-8222-222222222222' }), /其他目标/);
    await assert.rejects(() => tasks.submitStudioBatch(owner, { requestId: acceptedId, prompt: 'synthetic-new-input', count: 1, revision: 0, referenceIds: [] },
      { candidates: [{ prompt: 'synthetic-avatar' } as AvatarCandidate] }), /其他请求/);
    assert.deepEqual((await receipts.readStudioSubmitReceipt(owner, acceptedId)).taskIds, [original.id]);
    assert.equal(await db.platformSetting.count({ where: { key: key(owner, acceptedId) } }), 0);
    check('accepted_original_precedes_new_input_checks_and_preserves_target_fingerprint_guards');

    const closedId = request('closed'); assert.equal((await receipts.closeStudioSubmission(owner, closedId)).state, 'closed');
    await assert.rejects(() => tasks.submitStudioBatch(owner, { requestId: closedId, prompt: 'late-normal-writer' }), (error: unknown) => error instanceof receipts.StudioSubmitReceiptError);
    await assert.rejects(() => batches.createStudioBatch(owner, { requestId: closedId, prompt: 'late-parent-writer' }), (error: unknown) => error instanceof receipts.StudioSubmitReceiptError);
    await assert.rejects(() => db.$transaction(tx => sync.createSynchronousImageAdmission(tx, { ownerId: owner, requestId: closedId, fingerprint: 'synthetic-sync', count: 1, model: 'synthetic', scope: 'synthetic' })), (error: unknown) => error instanceof receipts.StudioSubmitReceiptError);
    await assert.rejects(() => db.$transaction(async tx => { await receipts.assertStudioRequestWritable(tx, owner, closedId); await tx.imageStudioTask.create({ data: taskData(closedId) }); }), (error: unknown) => error instanceof receipts.StudioSubmitReceiptError);
    assert.equal(await db.imageStudioTask.count({ where: { batch_id: hash(closedId) } }), 0);
    assert.equal(await db.platformSetting.count({ where: { key: `image_sync_request_v1:${owner}:${closedId}` } }), 0);
    check('closed_original_blocks_normal_parent_same_transaction_and_real_synchronous_writers');

    const lateBatchId = request('late-batch'); await receipts.closeStudioSubmission(owner, lateBatchId);
    const parent = { version: 1, id: hash(lateBatchId), requestId: lateBatchId, ownerId: owner, moduleId, moduleName: 'Synthetic', state: 'ready', note: '', createdAt: new Date().toISOString(), total: 1, prepared: 1, budget: 0, committedCredits: 0, unitCredits: 0, input: {}, items: [{ ordinal: 1, sourceName: 'Synthetic', taskId: null, attempt: 0, prepared: true, cancelled: false }] };
    await db.platformSetting.create({ data: { key: `studio_batch_v1:${owner}:${parent.id}`, value_json: JSON.stringify(parent) } });
    await batches.dispatchStudioBatches();
    const blocked = JSON.parse((await db.platformSetting.findUniqueOrThrow({ where: { key: `studio_batch_v1:${owner}:${parent.id}` } })).value_json);
    assert.equal(blocked.state, 'blocked'); assert.equal(await db.imageStudioTask.count({ where: { batch_id: parent.id } }), 0);
    assert.equal(await db.creditLedger.count(), 0);
    check('real_batch_dispatch_final_writer_obeys_terminal_fence');

    for (const prefix of ['studio_batch_v1:', 'studio_channel_batch_v1:', 'studio_pricing_batch_v1:']) {
      const id = request('parent-evidence'), batchId = hash(id);
      await db.platformSetting.create({ data: { key: `${prefix}${owner}:${batchId}`, value_json: JSON.stringify({ ...parent, id: batchId, requestId: id, state: 'paused' }) } });
      const found = await receipts.closeStudioSubmission(owner, id); assert.equal(found.state, 'accepted'); assert.equal(found.batchId, batchId); assert.equal(await db.platformSetting.count({ where: { key: key(owner, id) } }), 0);
    }
    const syncId = request('sync-evidence'); await db.$transaction(tx => sync.createSynchronousImageAdmission(tx, { ownerId: owner, requestId: syncId, fingerprint: 'synthetic-existing', count: 1, model: 'synthetic', scope: 'synthetic' }));
    assert.equal((await receipts.closeStudioSubmission(owner, syncId)).state, 'accepted');
    check('all_real_batch_parent_formats_and_synchronous_admission_prevent_false_close');

    const feeId = request('fee-evidence'); await db.creditLedger.create({ data: { user_id: owner, type: 'task_freeze', amount: -1, balance_before: 1, balance_after: 0, related_task_id: `rate-${hash(feeId)}-0`, idempotency_key: `image-studio:freeze:rate-${hash(feeId)}-0` } });
    assert.equal((await receipts.closeStudioSubmission(owner, feeId)).state, 'unknown'); assert.equal(await db.platformSetting.count({ where: { key: key(owner, feeId) } }), 0);
    const orphanId = request('prepared-evidence'); await db.platformSetting.create({ data: { key: `studio_pricing_batch_item_v1:${hash(orphanId)}:1`, value_json: JSON.stringify({ owner_id: owner, batch_id: hash(orphanId) }) } });
    assert.equal((await receipts.closeStudioSubmission(owner, orphanId)).state, 'unknown');
    const partialId = request('partial'); await db.imageStudioTask.create({ data: taskData(partialId, 2) });
    assert.equal((await receipts.closeStudioSubmission(owner, partialId)).state, 'accepted');
    assert.equal(await receipts.rejectStudioSubmission(owner, partialId, { code: 'IMAGE_SUBMIT_REJECTED', stage: 'task-insert' }), null);
    check('fee_or_prepared_uncertainty_and_partial_acceptance_are_never_rejected_or_closed');

    const batchRejectId = request('batch-reject'), batchResponse = await batchApi.POST(post('/api/image-studio/batches', { requestId: batchRejectId, prompt: 'ppenc:v1:synthetic-batch' }));
    const batchFailure = await batchResponse.json(); assert.equal(batchResponse.status, 400); assert.equal(batchFailure.requestId, batchRejectId); assert.equal(batchFailure.receipt?.schema, 'image.submit-receipt.v1'); assert.equal(batchFailure.receipt?.state, 'rejected');
    const priceId = request('price-confirmation');
    const pricingApi = apiSource<typeof taskApi>('src/app/api/image-studio/tasks/route.ts', { '@/lib/image-studio/billing-quote-service': {
      submitStudioWithCurrentPricing: async () => ({ confirmationRequired: true, requestId: priceId, acceptedCount: 0, submitted: false, quote: { unitCredits: 5 } }), logImagePricingFailure: () => {},
    } });
    const priceResponse = await pricingApi.POST(post('/api/image-studio/tasks', { requestId: priceId, currentFixedPricing: true }));
    assert.equal((await priceResponse.json()).confirmationRequired, true); assert.equal((await receipts.readStudioSubmitReceipt(owner, priceId)).state, 'unknown');
    check('real_batch_api_projects_durable_rejection_and_price_confirmation_is_not_failure');

    assert.equal((await receipts.readStudioSubmitReceipt(other, closedId)).state, 'unknown');
    activeUser = { ...user, id: other };
    const isolated = await requestApi.GET(new NextRequest(`https://fixture.invalid/api/image-studio/requests?requestId=${encodeURIComponent(closedId)}`));
    assert.equal((await isolated.json()).state, 'unknown'); activeUser = user;
    const closeApiId = request('close-api'); const closeResponse = await requestApi.POST(post('/api/image-studio/requests', { requestId: closeApiId, action: 'close' }));
    assert.equal((await closeResponse.json()).state, 'closed');
    const crossId = request('cross-site'); const cross = await requestApi.POST(post('/api/image-studio/requests', { requestId: crossId, action: 'close' }, { 'sec-fetch-site': 'cross-site' }));
    assert.equal(cross.status, 403); assert.equal((await receipts.readStudioSubmitReceipt(owner, crossId)).state, 'unknown');
    check('request_api_account_isolation_forwarded_host_and_cross_site_protection');

    process.env.IMAGE_STUDIO_REQUEST_CLOSE_ENABLED = '0';
    const disabledId = request('disabled'); await assert.rejects(() => receipts.closeStudioSubmission(owner, disabledId), (error: unknown) => error instanceof receipts.StudioSubmitReceiptError && error.code === 'IMAGE_SUBMIT_CLOSE_DISABLED');
    assert.equal((await receipts.readStudioSubmitReceipt(owner, closedId)).state, 'closed');
    await assert.rejects(() => receipts.assertStudioRequestWritable(db, owner, closedId));
    const stillRejectId = request('guard-reject'); assert.equal((await receipts.rejectStudioSubmission(owner, stillRejectId, { code: 'PERSONAL_PROMPT_ENCRYPTED', stage: 'input' }))?.state, 'rejected');
    delete process.env.IMAGE_STUDIO_REQUEST_CLOSE_ENABLED;
    check('close_capability_gate_preserves_reads_rejections_and_late_writer_fence');

    const brokenId = request('evidence-unavailable'); failEvidenceRead = true;
    await assert.rejects(() => receipts.closeStudioSubmission(owner, brokenId));
    await assert.rejects(() => receipts.rejectStudioSubmission(owner, brokenId, { code: 'IMAGE_SUBMIT_REJECTED', stage: 'input' }));
    const unavailable = await requestApi.GET(new NextRequest(`https://fixture.invalid/api/image-studio/requests?requestId=${encodeURIComponent(brokenId)}`));
    const unavailableBody = await unavailable.json(); assert.equal(unavailable.status, 503); assert.equal(unavailableBody.schema, 'image.submit-receipt.v1'); assert.equal(unavailableBody.state, 'unknown');
    failEvidenceRead = false; assert.equal(await db.platformSetting.count({ where: { key: key(owner, brokenId) } }), 0);
    check('database_evidence_failure_never_grants_nonacceptance_or_close');

    assert.equal(externalCalls, 0);
    const files = ['src/lib/image-studio/tasks.ts', 'src/lib/image-studio/batches.ts', 'src/lib/image-studio/synchronous-admission.ts', 'src/lib/image-studio/submit-receipts.server.ts', 'src/app/api/image-studio/tasks/route.ts', 'src/app/api/image-studio/batches/route.ts', 'src/app/api/image-studio/requests/route.ts', 'src/lib/image-studio/personal-prompt.ts', 'src/lib/image-studio/personal-prompt.server.ts', 'scripts/image-submit-receipt-engineering.ts'];
    const evidence = { synthetic: true, startedAt, finishedAt: new Date().toISOString(), databasePath, externalCalls, checks,
      sourceSha256: Object.fromEntries(files.map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')])) };
    fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ checks: checks.length, externalCalls, evidence: path.join(directory, 'evidence.json') }));
  } finally {
    mock.restoreAll(); NodeModule._load = originalLoad; await db.$disconnect(); Reflect.deleteProperty(globalThis, 'prisma'); process.umask(previousUmask);
  }
}
void main().catch(error => { console.error(error instanceof Error ? error.stack : error); process.exitCode = 1; });
