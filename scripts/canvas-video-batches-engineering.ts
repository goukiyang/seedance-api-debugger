import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SessionUser } from '../src/lib/auth/session';

// Lead-only whole-batch engineering check. No live database, provider, HTTP or media calls.
async function main() {
  const scratch = path.resolve('.role-tests');
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(path.join(scratch, 'canvas-video-batches-'));
  process.env.DATABASE_URL = `file:${path.join(directory, 'synthetic.db')}`;
  process.env.SESSION_SECRET = 'synthetic-canvas-video-batch-secret-not-production';
  process.env.SEEDANCE_API_KEY = 'synthetic-not-a-provider-key';
  process.env.CANVAS_VIDEO_BATCH_CREATE_ENABLED = '1';
  const isolatedEnv: NodeJS.ProcessEnv = { NODE_ENV: 'test', DATABASE_URL: process.env.DATABASE_URL,
    PRISMA_GENERATE_SKIP_AUTOINSTALL: '1', NEXT_TELEMETRY_DISABLED: '1' };
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ']) if (process.env[key]) isolatedEnv[key] = process.env[key];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Network forbidden in isolated batch engineering'); };
  execFileSync(process.execPath, [path.resolve('node_modules/prisma/build/index.js'), 'db', 'push', '--skip-generate',
    '--schema', path.resolve('prisma/schema.prisma')], { cwd: directory, env: isolatedEnv, stdio: 'pipe', timeout: 120000 });
  const { prisma } = await import('../src/lib/prisma');
  const batches = await import('../src/lib/canvas-video-batches');
  const guards = await import('../src/lib/canvas-video-batches-guards');
  const contract = await import('../src/lib/canvas-video-batch-contract');
  const documents = await import('../src/lib/canvas-documents');
  const { allocateTaskCredits } = await import('../src/lib/credits/policy');
  const { creditsFromCents, creditCents, sumCredits } = await import('../src/lib/credits/precision');
  const checks: Array<{ name: string; passed: boolean; error?: string }> = [];
  const check = async (name: string, action: () => unknown | Promise<unknown>) => {
    try { await action(); checks.push({ name, passed: true }); console.log(`PASS ${name}`); }
    catch (error) { checks.push({ name, passed: false, error: error instanceof Error ? error.message : 'Unknown error' }); console.error(`FAIL ${name}: ${checks.at(-1)?.error}`); }
  };
  const owner: SessionUser = { id: 'cvb-owner', name: 'Synthetic owner', username: 'cvb-owner', email: 'cvb-owner@invalid.test',
    role: 'admin', account_type: 'internal', status: 'active', user_profile: 'other', feature_profile_id: null, expires_at: null };
  const outsider: SessionUser = { ...owner, id: 'cvb-outsider', username: 'cvb-outsider', email: 'cvb-outsider@invalid.test' };
  const rejects = (code: string) => (error: unknown) => error instanceof guards.CanvasVideoBatchError && error.code === code;
  for (const user of [owner, outsider]) await prisma.user.create({ data: { id: user.id, name: user.name, username: user.username,
    email: user.email, password_hash: 'synthetic-not-a-login-hash', role: user.role, account_type: user.account_type } });
  await prisma.creditAccount.create({ data: { user_id: owner.id, balance: 10000000 } });
  const project = await prisma.project.create({ data: { id: 'cvb-project', name: 'Synthetic canvas video project', type: 'personal',
    owner_user_id: owner.id, created_by: owner.id } });
  const card = await prisma.videoCard.create({ data: { id: 'cvb-card', project_id: project.id, title: 'Synthetic card', created_by: owner.id } });
  const model = 'dreamina-seedance-2-0-260128';
  async function fixture(count = 2) {
    const documentId = `canvas-${randomUUID()}`, nodeId = `node-${randomUUID()}`;
    const graph = { schema: 'ultimate_canvas.v1', schemaVersion: 2, context: { project_id: project.id },
      canvas: { version: 1, nodes: [{ id: nodeId, type: 'video', x: 0, y: 0, data: { title: 'Synthetic video',
        videoSettings: { count, provider: 'seedance', model }, prompt: 'Synthetic independent scene' } }], connections: [] } };
    await prisma.canvasDocument.create({ data: { id: documentId, owner_user_id: owner.id, project_id: project.id,
      title: 'Synthetic batch canvas', schema_version: 2, protocol_version: 2, document_json: JSON.stringify(graph) } });
    const body = { contract_version: 1, request_id: randomUUID(), document_id: documentId, node_id: nodeId, count,
      input: { provider: 'seedance', model, project_id: project.id, video_card_id: card.id, video_branch_id: null,
        generation_mode: 'all_in_one_reference', prompt: 'Synthetic independent scene', ratio: '16:9', duration: 5,
        resolution: '720p', seed: 42, generate_audio: false, return_last_frame: false, watermark: false, draft: false,
        reference_image_ids: [], reference_video_urls: [], client_name: 'ultimate_canvas',
        source_metadata: { source: 'ultimate_canvas', canvas_document_id: documentId, canvas_node_id: nodeId } } };
    const quote = await batches.quoteCanvasVideoBatch(owner, { ...body, action: 'quote' });
    return { body, quote, documentId, nodeId, graph };
  }
  async function prepared(count = 2) {
    const f = await fixture(count);
    const result = await batches.prepareCanvasVideoBatch(owner, { ...f.body, action: 'prepare', quote_token: f.quote.quote_token });
    return { ...f, batch: result.batch };
  }
  async function admit(child: { create_body: Record<string, unknown> }, amount?: number, failAfterReserve = false) {
    const restored = await guards.restoreCanvasVideoBatchCreate(owner, child.create_body, 'ordinary');
    if (restored.existingTask) return restored.existingTask;
    const input = restored.body;
    const maximum = Number(input.max_estimated_cost);
    return prisma.$transaction(async db => {
      await guards.assertCanvasVideoAdmission(db, owner, input, restored.admission,
        { projectId: project.id, videoCardId: card.id, branchId: null, amount: amount ?? maximum });
      const task = await db.videoTask.create({ data: { provider: 'seedance', model, prompt: String(input.prompt),
        generation_mode: 'all_in_one_reference', user_id: owner.id, owner_user_id: owner.id, project_id: project.id, video_card_id: card.id,
        source_request_id: String(input.source_request_id), source_metadata_json: JSON.stringify(input.source_metadata),
        idempotency_key: String(input.idempotency_key), local_status: 'submitted', estimated_cost: amount ?? maximum, frozen_cost: amount ?? maximum } });
      if ((amount ?? maximum) > 0) {
        const freeze = await allocateTaskCredits(db, owner, amount ?? maximum, task.id);
        await db.creditLedger.create({ data: { user_id: owner.id, type: 'task_freeze', amount: -(amount ?? maximum),
          balance_before: freeze.balance_before, balance_after: freeze.balance_after,
          frozen_before: freeze.frozen_before, frozen_after: freeze.frozen_after, related_task_id: task.id,
          operator_id: owner.id, reason: 'Synthetic original child freeze' } });
      }
      if (failAfterReserve) throw new Error('Synthetic transaction abort');
      await guards.bindCanvasVideoBatchTask(db, restored.admission, task.id, amount ?? maximum);
      return task;
    });
  }
  try {
    await check('W5 migration is additive and retains existing document/task/ledger rows', async () => {
      const before = { users: await prisma.user.count(), projects: await prisma.project.count(), cards: await prisma.videoCard.count(),
        documents: await prisma.canvasDocument.count(), tasks: await prisma.videoTask.count(), ledger: await prisma.creditLedger.count() };
      await prisma.$executeRawUnsafe('DROP TABLE "CanvasVideoBatchChild"');
      await prisma.$executeRawUnsafe('DROP TABLE "CanvasVideoBatch"');
      execFileSync(process.execPath, [path.resolve('node_modules/prisma/build/index.js'), 'db', 'execute',
        '--file', path.resolve('prisma/migrations/20261021180000_canvas_video_batches/migration.sql'),
        '--url', process.env.DATABASE_URL!], { cwd: directory, env: isolatedEnv, stdio: 'pipe', timeout: 120000 });
      assert.deepEqual({ users: await prisma.user.count(), projects: await prisma.project.count(), cards: await prisma.videoCard.count(),
        documents: await prisma.canvasDocument.count(), tasks: await prisma.videoTask.count(), ledger: await prisma.creditLedger.count() }, before);
      assert.equal(await prisma.canvasVideoBatch.count(), 0);
    });
    await check('W5 count 1 unchanged, 2/4 only, no parent reserve, exact per-child quote sum', async () => {
      assert.equal(contract.canvasVideoCount(undefined), 1);
      for (const bad of [0, 3, 5, '2', null]) assert.throws(() => contract.canvasVideoCount(bad));
      const tasks = await prisma.videoTask.count(), ledger = await prisma.creditLedger.count();
      const f = await prepared(4);
      assert.equal(f.batch.children.length, 4);
      assert.equal(f.batch.dispatch_limit, 1);
      assert.equal(new Set(f.batch.children.map(child => child.idempotency_key)).size, 4);
      assert.equal(f.batch.authorized_total, sumCredits(f.batch.children.map(child => child.authorized_maximum)));
      assert.equal(await prisma.videoTask.count(), tasks); assert.equal(await prisma.creditLedger.count(), ledger);
      assert.equal((await prisma.canvasDocument.findUniqueOrThrow({ where: { id: f.documentId } })).schema_version, 2);
      const replay = await batches.prepareCanvasVideoBatch(owner, { ...f.body, quote_token: 'expired-or-unavailable' });
      assert.equal(replay.batch.id, f.batch.id);
      await assert.rejects(batches.prepareCanvasVideoBatch(owner, { ...f.body, input: { ...f.body.input, seed: 43 }, quote_token: f.quote.quote_token }), rejects('canvas_video_batch_payload_mismatch'));
    });
    await check('W5 frozen restoration ignores caller edits and cross-owner/cross-route admissions', async () => {
      const f = await prepared();
      const restored = await guards.restoreCanvasVideoBatchCreate(owner, { ...f.batch.children[0].create_body, prompt: 'tampered', model: 'other', max_estimated_cost: 0 }, 'ordinary');
      assert.equal(restored.body.prompt, f.body.input.prompt); assert.equal(restored.body.seed, 42);
      assert.notEqual(restored.body.max_estimated_cost, 0);
      await assert.rejects(guards.restoreCanvasVideoBatchCreate(outsider, f.batch.children[0].create_body, 'ordinary'));
      await assert.rejects(guards.restoreCanvasVideoBatchCreate(owner, f.batch.children[0].create_body, 'ip'));
      await assert.rejects(guards.restoreCanvasVideoBatchCreate(owner, { idempotency_key: f.batch.children[0].idempotency_key }, 'ordinary'));
      const missing = await batches.queryCanvasVideoBatches(owner, new URLSearchParams({ request_id: randomUUID() }));
      assert.equal(missing.state, 'unconfirmed'); assert.equal(missing.batch, null);
    });
    await check('W5 independent Task/fee transactions, atomic failure rollback, no repeated reserve', async () => {
      const f = await prepared();
      const before = { tasks: await prisma.videoTask.count(), ledger: await prisma.creditLedger.count(),
        frozen: (await prisma.creditAccount.findUniqueOrThrow({ where: { user_id: owner.id } })).frozen_credits };
      await assert.rejects(admit(f.batch.children[0], undefined, true));
      assert.equal(await prisma.videoTask.count(), before.tasks); assert.equal(await prisma.creditLedger.count(), before.ledger);
      assert.equal((await batches.readCanvasVideoBatch(owner, f.batch.id)).batch.admitted_total, 0);
      const first = await admit(f.batch.children[0]), second = await admit(f.batch.children[1]);
      assert.notEqual(first.id, second.id);
      assert.equal((await admit(f.batch.children[0])).id, first.id);
      assert.equal(await prisma.videoTask.count(), before.tasks + 2); assert.equal(await prisma.creditLedger.count(), before.ledger + 2);
      const view = (await batches.readCanvasVideoBatch(owner, f.batch.id)).batch;
      assert.equal(view.admitted_total, view.authorized_total);
      assert.equal(view.state, 'unconfirmed');
      assert.equal((await prisma.creditAccount.findUniqueOrThrow({ where: { user_id: owner.id } })).frozen_credits,
        sumCredits([before.frozen, view.authorized_total]));
    });
    await check('W5 parent/child ceilings are atomic, old single cannot bypass active node slot', async () => {
      const f = await prepared();
      await assert.rejects(admit(f.batch.children[0], f.batch.children[0].authorized_maximum + 1), rejects('canvas_video_batch_ceiling'));
      await prisma.canvasVideoBatch.update({ where: { id: f.batch.id }, data: { authorized_total: creditCents(f.batch.children[0].authorized_maximum) } });
      await admit(f.batch.children[0]);
      await assert.rejects(admit(f.batch.children[1]), rejects('canvas_video_batch_ceiling'));
      await assert.rejects(prisma.$transaction(db => guards.assertCanvasVideoAdmission(db, owner,
        { ...f.body.input, canvas_document_id: f.documentId, canvas_node_id: f.nodeId, required_capabilities: [contract.CANVAS_VIDEO_BATCH_CAPABILITY], idempotency_key: randomUUID() }, null,
        { projectId: project.id, videoCardId: card.id, branchId: null, amount: 1 })), rejects('canvas_video_batch_active'));
    });
    await check('W5 concurrent duplicate child has one durable Task and one fee reserve', async () => {
      const f = await prepared();
      const before = { tasks: await prisma.videoTask.count(), ledger: await prisma.creditLedger.count() };
      const outcomes = await Promise.allSettled([admit(f.batch.children[0]), admit(f.batch.children[0])]);
      assert.ok(outcomes.some(outcome => outcome.status === 'fulfilled'));
      assert.equal(await prisma.videoTask.count(), before.tasks + 1);
      assert.equal(await prisma.creditLedger.count(), before.ledger + 1);
      const original = await guards.restoreCanvasVideoBatchCreate(owner, f.batch.children[0].create_body, 'ordinary');
      assert.ok(original.existingTask);
      assert.equal((await batches.readCanvasVideoBatch(owner, f.batch.id)).batch.admitted_total, f.batch.children[0].authorized_maximum);
    });
    await check('W5 stop original operation receipt, absent stays unknown, late admission fenced', async () => {
      const f = await prepared();
      const first = await admit(f.batch.children[0]);
      const alreadyLoaded = await guards.restoreCanvasVideoBatchCreate(owner, f.batch.children[1].create_body, 'ordinary');
      const operationId = randomUUID();
      const view = (await batches.readCanvasVideoBatch(owner, f.batch.id)).batch;
      await batches.mutateCanvasVideoBatch(owner, f.batch.id, { action: 'stop', operation_id: operationId, revision: view.revision });
      const applied = await batches.readCanvasVideoBatch(owner, f.batch.id, operationId);
      assert.equal(applied.operation?.state, 'applied'); assert.equal(applied.batch.children[0].task_id, first.id);
      assert.equal(applied.batch.children[1].state, 'cancelled');
      assert.equal((await batches.readCanvasVideoBatch(owner, f.batch.id, randomUUID())).operation?.state, 'unconfirmed');
      await assert.rejects(guards.restoreCanvasVideoBatchCreate(owner, f.batch.children[1].create_body, 'ordinary'), rejects('canvas_video_batch_child_sealed'));
      await assert.rejects(prisma.$transaction(db => guards.assertCanvasVideoAdmission(db, owner, alreadyLoaded.body,
        alreadyLoaded.admission, { projectId: project.id, videoCardId: card.id, branchId: null,
          amount: f.batch.children[1].authorized_maximum })), rejects('canvas_video_batch_child_changed'));
      assert.equal((await guards.restoreCanvasVideoBatchCreate(owner, f.batch.children[0].create_body, 'ordinary')).existingTask?.id, first.id);
      const history = await batches.queryCanvasVideoBatches(owner, new URLSearchParams({ document_id: f.documentId, node_id: f.nodeId }));
      assert.ok('batches' in history && history.batches?.some(batch => batch.id === f.batch.id));
      assert.equal(JSON.stringify(applied).includes('pricing_token'), false);
      assert.equal(JSON.stringify(applied).includes('quote_token'), false);
    });
    await check('W5 quote expiry/reauthorize keeps IDs, fingerprint, explicit operation and originals', async () => {
      const f = await prepared();
      const late = await guards.restoreCanvasVideoBatchCreate(owner, f.batch.children[0].create_body, 'ordinary');
      await prisma.canvasVideoBatchChild.updateMany({ where: { batch_id: f.batch.id }, data: { quote_expires_at: new Date(0) } });
      await assert.rejects(guards.restoreCanvasVideoBatchCreate(owner, f.batch.children[0].create_body, 'ordinary'), rejects('canvas_video_batch_requote_required'));
      const quote = await batches.quoteCanvasVideoBatch(owner, { action: 'quote', batch_id: f.batch.id });
      const op = randomUUID();
      const current = (await batches.readCanvasVideoBatch(owner, f.batch.id)).batch;
      const updated = await batches.mutateCanvasVideoBatch(owner, f.batch.id, { action: 'reauthorize', operation_id: op,
        revision: current.revision, quote_token: quote.quote_token });
      assert.equal(updated.operation?.state, 'applied');
      assert.deepEqual(updated.batch.children.map(child => child.request_id), f.batch.children.map(child => child.request_id));
      await assert.rejects(guards.restoreCanvasVideoBatchCreate(owner, f.batch.children[0].create_body, 'ordinary'), rejects('canvas_video_batch_child_changed'));
      assert.ok((await guards.restoreCanvasVideoBatchCreate(owner, updated.batch.children[0].create_body, 'ordinary')).admission);
      await assert.rejects(prisma.$transaction(db => guards.assertCanvasVideoAdmission(db, owner, late.body,
        late.admission, { projectId: project.id, videoCardId: card.id, branchId: null,
          amount: f.batch.children[0].authorized_maximum })), rejects('canvas_video_batch_child_changed'));
      await guards.recordCanvasVideoBatchRejection(owner, late.admission, 400, { code: 'late_failure' });
      assert.equal((await batches.readCanvasVideoBatch(owner, f.batch.id)).batch.children[0].state, 'prepared');
    });
    await check('W5 used-document capability persists after stop, copy strips runtime/count remains', async () => {
      const f = await prepared();
      await batches.mutateCanvasVideoBatch(owner, f.batch.id, { action: 'stop', operation_id: randomUUID(), revision: f.batch.revision });
      const doc = await prisma.canvasDocument.findUniqueOrThrow({ where: { id: f.documentId } });
      const body = { document_id: doc.id, base_revision: doc.revision, protocol_version: 2, mutation_id: randomUUID(), document_json: doc.document_json };
      await assert.rejects(documents.mutateCanvasDocument(owner, body, 'POST'), rejects('canvas_video_batch_capability_required'));
      await assert.rejects(documents.mutateCanvasDocument(owner, { ...body, action: 'rename', title: 'Old client' }, 'PATCH'), rejects('canvas_video_batch_capability_required'));
      const copied = await documents.mutateCanvasDocument(owner, { ...body, action: 'duplicate', required_capabilities: [contract.CANVAS_VIDEO_BATCH_CAPABILITY] }, 'PATCH');
      const copy = await prisma.canvasDocument.findUniqueOrThrow({ where: { id: copied.document.id } });
      assert.equal(JSON.parse(copy.document_json).canvas.nodes[0].data.videoSettings.count, 2);
      assert.equal(await prisma.canvasVideoBatch.count({ where: { document_id: copy.id } }), 0);
      await assert.rejects(documents.mutateCanvasDocument(owner, { ...body, action: 'archive', mutation_id: randomUUID() }, 'PATCH'), rejects('canvas_video_batch_capability_required'));
      const originalSave = { ...body, mutation_id: randomUUID() };
      const capabilities = [contract.CANVAS_VIDEO_BATCH_CAPABILITY];
      const saved = await documents.mutateCanvasDocument(owner, originalSave, 'POST', capabilities);
      const replayed = await documents.mutateCanvasDocument(owner, originalSave, 'POST', capabilities);
      assert.equal(replayed.document.revision, saved.document.revision);
      assert.equal(replayed.replayed, true, 'Transport capability keeps original mutation bytes and receipt');
      await assert.rejects(documents.mutateCanvasDocument(owner, originalSave, 'POST'), rejects('canvas_video_batch_capability_required'));
    });
    await check('W5 node removal/archive seals only unstarted and cannot undo fees/history', async () => {
      const f = await prepared();
      const task = await admit(f.batch.children[0]);
      const doc = await prisma.canvasDocument.findUniqueOrThrow({ where: { id: f.documentId } });
      const withoutNode = { ...f.graph, canvas: { ...f.graph.canvas, nodes: [] } };
      await documents.mutateCanvasDocument(owner, { document_id: doc.id, protocol_version: 2, mutation_id: randomUUID(), base_revision: doc.revision,
        required_capabilities: [contract.CANVAS_VIDEO_BATCH_CAPABILITY], document_json: JSON.stringify(withoutNode) }, 'POST');
      const view = (await batches.readCanvasVideoBatch(owner, f.batch.id)).batch;
      assert.equal(view.children[0].task_id, task.id); assert.equal(view.children[1].state, 'cancelled');
      assert.equal((await prisma.videoTask.findUniqueOrThrow({ where: { id: task.id } })).local_status, 'submitted');
      const latest = await prisma.canvasDocument.findUniqueOrThrow({ where: { id: doc.id } });
      await documents.mutateCanvasDocument(owner, { document_id: doc.id, protocol_version: 2, mutation_id: randomUUID(), base_revision: latest.revision,
        required_capabilities: [contract.CANVAS_VIDEO_BATCH_CAPABILITY], action: 'archive' }, 'PATCH');
      assert.equal((await batches.readCanvasVideoBatch(owner, f.batch.id)).batch.children[0].task_id, task.id);
    });
    await check('W5 fresh project/card gate and guard keep query/dedupe/stop enabled', async () => {
      const f = await prepared();
      await prisma.videoCard.update({ where: { id: card.id }, data: { status: 'sealed' } });
      await assert.rejects(admit(f.batch.children[0]));
      await prisma.videoCard.update({ where: { id: card.id }, data: { status: 'active' } });
      process.env.CANVAS_VIDEO_BATCH_CREATE_ENABLED = '0';
      await assert.rejects(guards.restoreCanvasVideoBatchCreate(owner, f.batch.children[0].create_body, 'ordinary'), rejects('canvas_video_batch_guard'));
      assert.equal((await batches.readCanvasVideoBatch(owner, f.batch.id)).batch.id, f.batch.id);
      await batches.mutateCanvasVideoBatch(owner, f.batch.id, { action: 'stop', operation_id: randomUUID(), revision: f.batch.revision });
      process.env.CANVAS_VIDEO_BATCH_CREATE_ENABLED = '1';
    });
    await check('W5 actual ordinary/IP create paths retain original reserve, receipt, pricing and usage engines', () => {
      for (const filename of ['src/app/api/tasks/create/route.ts', 'src/app/api/ip/tasks/create/route.ts']) {
        const source = readFileSync(path.resolve(filename), 'utf8');
        assert.ok(source.indexOf('restoreCanvasVideoBatchCreate(user') < source.indexOf('const body = restoredBatch.body'));
        const tx = source.indexOf('const result = await prisma.$transaction');
        const gate = source.indexOf('await assertCanvasVideoAdmission(tx', tx);
        const create = source.indexOf('await tx.videoTask.create', tx);
        const bind = source.indexOf('await bindCanvasVideoBatchTask(tx', tx);
        assert.ok(tx > 0 && gate > tx && gate < create && bind > create);
        for (const token of ['assertProjectActiveInTransaction(tx', 'assertVideoPricingAcceptance(priceQuote',
          'consumeApprovalForTask(tx', 'allocateTaskCredits(tx', 'allocateProjectTaskBudget(tx', 'recordUsageAttribution(tx', 'assertCanvasVideoBatchDedupe(user']) assert.ok(source.includes(token), `${filename}: ${token}`);
      }
      const migration = readFileSync(path.resolve('prisma/migrations/20261021180000_canvas_video_batches/migration.sql'), 'utf8');
      assert.equal(/(?:^|;)\s*(?:UPDATE\b|DELETE\s+FROM\b|DROP\s+TABLE\b|ALTER\s+TABLE\b)/i.test(migration), false);
      assert.equal(creditsFromCents(creditCents(0.1)), 0.1);
    });
  } finally {
    globalThis.fetch = realFetch;
    await prisma.$disconnect();
  }
  console.log(JSON.stringify({ scope: 'isolated synthetic engineering only', directory, checks }, null, 2));
  if (checks.some(check => !check.passed)) process.exitCode = 1;
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Engineering setup failed'); process.exitCode = 1; });
