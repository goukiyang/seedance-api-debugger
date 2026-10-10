import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SessionUser } from '../src/lib/auth/session';
import { INTERNAL_EMAIL_FEATURE_PROFILE_ID } from '../src/lib/users/profiles';

// Always start from empty synthetic storage; never inherit a caller's database or network.
async function main() {
  const scratch = path.resolve('.role-tests');
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(path.join(scratch, 'role-c1-'));
  process.env.DATABASE_URL = `file:${path.join(directory, 'synthetic.db')}`;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Network forbidden in isolated role test'); };
  execFileSync(process.execPath, [path.resolve('node_modules/prisma/build/index.js'), 'db', 'push', '--skip-generate', '--schema', path.resolve('prisma/schema.prisma')],
    { env: process.env, stdio: 'pipe' });
  const { prisma } = await import('../src/lib/prisma');
  const roles = await import('../src/lib/canvas-roles/repository');
  const work = await import('../src/lib/canvas-roles/work');
  const execute = await import('../src/lib/canvas-roles/execution');
  const provider = await import('../src/lib/canvas-roles/text-provider');
  const media = await import('../src/lib/canvas-roles/media');
  const { joinRole } = await import('../src/lib/canvas-roles/join');
  const documents = await import('../src/lib/canvas-documents');
  const types = await import('../src/lib/canvas-roles/types');
  const checks: Array<{ name: string; passed: boolean; error?: string }> = [];
  const rv09Only = process.argv.includes('--rv09');
  const check = async (name: string, action: () => Promise<unknown> | unknown) => {
    if (rv09Only && !name.startsWith('RV09 ')) return;
    try { await action(); checks.push({ name, passed: true }); console.log(`PASS ${name}`); }
    catch (error) { checks.push({ name, passed: false, error: error instanceof Error ? error.message : String(error) }); console.error(`FAIL ${name}: ${checks.at(-1)?.error}`); }
  };
  const owner: SessionUser = { id: 'role-test-owner', name: 'Synthetic owner', username: 'role-test-owner', email: 'owner@invalid.test',
    role: 'user', account_type: 'internal', status: 'active', user_profile: 'other', feature_profile_id: INTERNAL_EMAIL_FEATURE_PROFILE_ID, expires_at: null };
  const outsider = { ...owner, id: 'role-test-outsider', username: 'role-test-outsider', email: 'outsider@invalid.test' };
  const mutation = () => randomUUID();
  const rejectCode = (code: string) => (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
  const snapshot = (name = 'Synthetic role', kind = 'person') => ({ schema: 'role.v1', name,
    responsibilities: 'Write an independently verifiable answer', delivery: 'Text and evidence', criteria: 'Evidence matches input', boundary: 'No external action',
    executor: kind === 'person' ? { kind, userId: owner.id } : { kind, model: 'gpt-5.5' }, tools: kind === 'ai' ? ['text'] : ['manual'], requiredItems: ['evidence'] });
  for (const user of [owner, outsider]) {
    await prisma.user.create({ data: { id: user.id, name: user.name, username: user.username, email: user.email,
      feature_profile_id: user.feature_profile_id, password_hash: 'synthetic-not-a-login-hash' } });
    await prisma.creditAccount.create({ data: { user_id: user.id, balance: 100 } });
  }
  await prisma.project.create({ data: { id: 'role-test-project', name: 'Synthetic project', type: 'personal', owner_user_id: owner.id, created_by: owner.id } });
  async function fixture(kinds = ['person', 'person', 'person']) {
    const documentId = `canvas-${mutation()}`;
    await prisma.canvasDocument.create({ data: { id: documentId, title: 'Synthetic canvas', owner_user_id: owner.id, project_id: 'role-test-project',
      schema_version: 2, protocol_version: 2, document_json: JSON.stringify({ schema: 'ultimate_canvas.v1', schemaVersion: 2,
        context: { project_id: 'role-test-project' }, canvas: { nodes: [{ id: 'source-text', type: 'text', x: 0, y: 0, data: { title: 'Synthetic material', authoredText: 'A trustworthy seed' } }], connections: [] } }) } });
    const nodes = [];
    for (let i = 0; i < kinds.length; i++) {
      const kind = kinds[i];
      const saved: any = await roles.createRole(owner, { mutation_id: mutation(), snapshot: snapshot(`Role ${i}`, kind) });
      const document = await prisma.canvasDocument.findUniqueOrThrow({ where: { id: documentId } });
      const joined: any = await joinRole(owner, { mutation_id: mutation(), document_id: documentId, document_revision: document.revision,
        definition_id: saved.role.id, version: 1, position: { x: i * 350, y: 100 }, pending_connection: null });
      nodes.push({ id: joined.nodeId, definitionId: saved.role.id });
    }
    const req: any = { goal: 'Synthetic parallel collaboration', criteria: 'All required deliverables', endpoint: 'owner_result', decisionOwnerId: owner.id,
      materialNodes: ['source-text'], finalNodeId: nodes.at(-1)!.id, participants: nodes.map(n => ({ nodeId: n.id,
        participation: 'required', reviewerNodeId: null, confirmRequired: false, ownerMaySubmit: false, ownerMayReview: false, dependencies: [] })) };
    return { documentId, nodes, req };
  }
  async function start(f: Awaited<ReturnType<typeof fixture>>, extras: Record<string, unknown> = {}) {
    const document = await prisma.canvasDocument.findUniqueOrThrow({ where: { id: f.documentId } });
    return await work.createTaskRun(owner, { mutation_id: mutation(), document_id: f.documentId, document_revision: document.revision,
      requirements: f.req, max_rounds: 4, ...extras }) as any;
  }
  async function action(workId: string, name: string, extras: Record<string, unknown> = {}) {
    const detail = await work.readWork(owner, workId);
    return work.actOnWork(owner, workId, { mutation_id: mutation(), base_revision: detail.work.revision,
      requirements_revision: detail.work.requirements_revision, action: name, ...extras });
  }
  async function deliver(workId: string) {
    await action(workId, 'accept');
    const detail = await work.readWork(owner, workId);
    return action(workId, 'submit', { text: 'Synthetic result', items: { evidence: 'Synthetic reference' }, input_digest: detail.input_digest });
  }
  async function update(f: Awaited<ReturnType<typeof fixture>>, runId: string, extra: Record<string, unknown> = {}) {
    const document = await prisma.canvasDocument.findUniqueOrThrow({ where: { id: f.documentId } });
    const run = await prisma.canvasRoleTaskRun.findUniqueOrThrow({ where: { id: runId } });
    return await work.updateTaskRun(owner, runId, { mutation_id: mutation(), base_revision: run.revision,
      document_revision: document.revision, requirements: f.req, ...extra }) as any;
  }
  try {
    await check('Library permanent receipt, immutable version, archive/copy isolation', async () => {
      const payload = { mutation_id: mutation(), snapshot: snapshot() };
      const saved: any = await roles.createRole(owner, payload);
      const replay: any = await roles.createRole(owner, payload);
      assert.equal(replay.role.id, saved.role.id);
      await assert.rejects(roles.createRole(owner, { ...payload, snapshot: snapshot('Other') }), rejectCode('mutation_conflict'));
      await assert.rejects(roles.getRole(outsider, saved.role.id), rejectCode('role_not_found'));
      const edited: any = await roles.editRole(owner, saved.role.id, { mutation_id: mutation(), base_revision: 1, base_version: 1, action: 'edit', snapshot: snapshot('Version two') });
      assert.equal(edited.role.current_version, 2);
      assert.equal((await roles.getRole(owner, saved.role.id, 1)).version.snapshot.name, payload.snapshot.name);
      await assert.rejects(roles.editRole(owner, saved.role.id, { mutation_id: mutation(), base_revision: 1, base_version: 1, action: 'edit', snapshot: snapshot() }), rejectCode('revision_conflict'));
      await roles.editRole(owner, saved.role.id, { mutation_id: mutation(), base_revision: 2, base_version: 2, action: 'archive' });
      assert.equal((await roles.listRoles(owner, new URLSearchParams({ status: 'archived' }))).roles.length, 1);
      await roles.editRole(owner, saved.role.id, { mutation_id: mutation(), base_revision: 3, base_version: 2, action: 'restore' });
      await prisma.canvasRoleMutationReceipt.updateMany({ where: { owner_user_id: owner.id }, data: { created_at: new Date('2000-01-01') } });
      assert.equal((await roles.roleReceipt(owner, payload.mutation_id)).role.id, saved.role.id);
    });
    await check('Role joins once; schema3 prevents old read/save/duplicate/restore', async () => {
      const f = await fixture(['person']);
      const doc = await prisma.canvasDocument.findUniqueOrThrow({ where: { id: f.documentId } });
      assert.equal(doc.schema_version, 3);
      assert.equal(JSON.parse(doc.document_json).canvas.nodes.filter((n: any) => n.type === 'role').length, 1);
      assert.throws(() => documents.canvasDetail(doc), (e: any) => e.status === 426);
      assert.ok(documents.canvasDetail(doc, ['role.v1']));
      const body = { protocol_version: 2, mutation_id: mutation(), base_revision: doc.revision, document_id: doc.id, document_json: doc.document_json };
      await assert.rejects(documents.mutateCanvasDocument(owner, body, 'POST'), (e: any) => e.status === 426);
      for (const name of ['duplicate', 'restore_revision']) await assert.rejects(documents.mutateCanvasDocument(owner,
        { ...body, mutation_id: mutation(), action: name, target_revision: 1 }, 'PATCH'), (e: any) => e.status === 426);
      await roles.editRole(owner, f.nodes[0].definitionId, { mutation_id: mutation(), base_revision: 1, base_version: 1, action: 'archive' });
      await assert.rejects(joinRole(owner, { mutation_id: mutation(), document_id: doc.id, document_revision: doc.revision,
        definition_id: f.nodes[0].definitionId, version: 1 }), rejectCode('role_archived'));
      const copy: any = await documents.mutateCanvasDocument(owner, { ...body, mutation_id: mutation(), action: 'duplicate', required_capabilities: ['role.v1'] }, 'PATCH');
      const copied = await prisma.canvasDocument.findUniqueOrThrow({ where: { id: copy.document.id } });
      const copiedNode = JSON.parse(copied.document_json).canvas.nodes.find((n: any) => n.type === 'role');
      assert.notEqual(copiedNode.id, f.nodes[0].id);
      assert.equal(copiedNode.data.roleConfig.definitionId, f.nodes[0].definitionId);
      assert.equal(await prisma.canvasRoleWork.count({ where: { run: { document_id: copied.id } } }), 0);
      const graph = JSON.parse(doc.document_json); graph.canvas.nodes = graph.canvas.nodes.filter((n: any) => n.type !== 'role'); graph.canvas.selectedNodeId = null;
      await documents.mutateCanvasDocument(owner, { ...body, mutation_id: mutation(), document_json: JSON.stringify(graph), required_capabilities: ['role.v1'] }, 'POST');
      const removed = await prisma.canvasDocument.findUniqueOrThrow({ where: { id: doc.id } });
      assert.equal(removed.schema_version, 3);
      await documents.mutateCanvasDocument(owner, { ...body, mutation_id: mutation(), base_revision: removed.revision,
        action: 'restore_revision', target_revision: doc.revision, required_capabilities: ['role.v1'] }, 'PATCH');
      const restored = await prisma.canvasDocument.findUniqueOrThrow({ where: { id: doc.id } });
      assert.equal(JSON.parse(restored.document_json).canvas.nodes.filter((n: any) => n.type === 'role').length, 1);
      assert.equal(await prisma.canvasRoleWork.count({ where: { run: { document_id: doc.id } } }), 0);
    });
    await check('Parallel required collection, exact reviews, confirmation and atomic handoff', async () => {
      const f = await fixture();
      f.req.participants[0].reviewerNodeId = f.nodes[1].id as any;
      f.req.participants[0].confirmRequired = true;
      f.req.participants[2].dependencies = [{ nodeId: f.nodes[0].id, required: true }, { nodeId: f.nodes[1].id, required: true }] as any;
      const run = await start(f), [a, b, c] = run.works;
      await assert.rejects(action(c.id, 'accept'), rejectCode('materials_missing'));
      await deliver(a.id);
      const d = await work.readWork(owner, a.id);
      await assert.rejects(action(a.id, 'approve', { delivery_id: 'wrong', input_digest: d.input_digest }), rejectCode('delivery_conflict'));
      await action(a.id, 'approve', { delivery_id: d.work.current_delivery_id, input_digest: d.input_digest });
      assert.equal((await work.readWork(owner, a.id)).work.phase, 'confirmation');
      await assert.rejects(action(a.id, 'approve', { delivery_id: d.work.current_delivery_id, input_digest: d.input_digest }), rejectCode('phase_conflict'));
      await action(a.id, 'confirm', { delivery_id: d.work.current_delivery_id, input_digest: d.input_digest });
      await action(c.id, 'reject', { reason: 'Need all branches' });
      await assert.rejects(action(c.id, 'accept'), rejectCode('materials_missing'));
      await deliver(b.id); await deliver(c.id);
      assert.equal((await work.readWork(owner, c.id)).run.status, 'delivered');
      assert.equal(await prisma.canvasRoleHandoff.count({ where: { target_work_id: c.id } }), 2);
      assert.equal(await prisma.canvasRoleEvent.count({ where: { role_task_run_id: run.run.id, kind: 'owner_result_available' } }), 1);
      const revised: any = await action(a.id, 'revise');
      assert.equal(revised.successor.phase, 'revision');
      assert.equal((await work.readWork(owner, c.id)).work.phase, 'superseded');
      assert.equal((await work.readWork(owner, b.id)).work.phase, 'delivered');
      assert.equal((await work.readWork(owner, a.id)).run.status, 'active');
      const history = await work.readWork(owner, revised.successor.id);
      assert.ok(history.node_work_history.some(w => w.id === a.id));
      assert.equal((await work.readWork(owner, a.id)).summary.is_current_work, false);
      await assert.rejects(action(a.id, 'revise'), rejectCode('work_superseded'));
    });
    await check('Task revisions apply limits without resetting old fees or adopting old approvals', async () => {
      const f = await fixture(['person']); const run = await start(f, { budget_points_limit: 1.25, budget_usd_micros_limit: 10000, max_calls: 2 });
      await prisma.canvasRoleTaskRun.update({ where: { id: run.run.id }, data: { settled_points: 25, settled_usd_micros: 5000, call_count: 1 } });
      const doc = await prisma.canvasDocument.findUniqueOrThrow({ where: { id: f.documentId } });
      const actual = await prisma.canvasRoleTaskRun.findUniqueOrThrow({ where: { id: run.run.id } });
      const payload = { mutation_id: mutation(), base_revision: actual.revision, document_revision: doc.revision, requirements: f.req,
        budget_points_limit: 2.35, budget_usd_micros_limit: 20000, max_calls: 3 };
      const updated: any = await work.updateTaskRun(owner, actual.id, payload);
      assert.equal(updated.run.budget_points_limit, 2.35); assert.equal(updated.run.max_calls, 3);
      assert.equal(updated.run.settled_points, 0.25); assert.equal(updated.run.call_count, 1);
      assert.equal(updated.run.requirements_revision, 1);
      assert.equal(updated.works[0].id, run.works[0].id);
      await action(run.works[0].id, 'accept');
      await assert.rejects(work.updateTaskRun(owner, actual.id, { ...payload, mutation_id: mutation(), base_revision: updated.run.revision, budget_points_limit: 0.01 }), rejectCode('budget_conflict'));
    });
    await check('RV01 Explicitly cleared authored material never revives generated text; old digest invalidates', async () => {
      const f = await fixture(['person']), run = await start(f);
      const document = await prisma.canvasDocument.findUniqueOrThrow({ where: { id: f.documentId } });
      const graph = JSON.parse(document.document_json);
      graph.canvas.nodes[0].data.authoredText = ''; graph.canvas.nodes[0].data.generatedText = 'A trustworthy seed';
      await documents.mutateCanvasDocument(owner, { mutation_id: mutation(), document_id: document.id, protocol_version: 2,
        base_revision: document.revision, document_json: JSON.stringify(graph), required_capabilities: ['role.v1'] }, 'POST');
      await assert.rejects(action(run.works[0].id, 'accept'), rejectCode('materials_changed'));
      const limits = await update(f, run.run.id, { update_kind: 'limits', max_calls: 2 });
      assert.equal(limits.run.requirements_revision, 1); assert.equal(limits.works[0].id, run.works[0].id);
      assert.equal(limits.requirements.materials[0].text, 'A trustworthy seed');
      await assert.rejects(action(run.works[0].id, 'accept'), rejectCode('materials_changed'));
      const updated = await update(f, run.run.id, { refresh_materials: true });
      assert.equal(updated.requirements.materials[0].text, ''); assert.equal(updated.run.requirements_revision, 2);
      await action(updated.works[0].id, 'accept');
    });
    await check('RV03 Limits retain completed work IDs/versions; content change preserves independent source and cumulative rounds', async () => {
      const f = await fixture(['person', 'person']); f.req.participants[1].confirmRequired = true;
      const run = await start(f);
      await deliver(run.works[0].id); await deliver(run.works[1].id);
      const toConfirm = await work.readWork(owner, run.works[1].id);
      await action(run.works[1].id, 'confirm', { delivery_id: toConfirm.work.current_delivery_id, input_digest: toConfirm.input_digest });
      const original = await work.readWork(owner, run.works[1].id);
      const limits = await update(f, run.run.id, { update_kind: 'limits', max_calls: 3, budget_points_limit: 2.5 });
      assert.equal(limits.run.requirements_revision, 1); assert.equal(limits.run.status, 'delivered');
      assert.deepEqual(limits.works.map((w: any) => w.id).sort(), run.works.map((w: any) => w.id).sort());
      f.req.participants[0].confirmRequired = true;
      const changed = await update(f, run.run.id);
      const a = changed.works.find((w: any) => w.node_id === f.nodes[0].id), b = changed.works.find((w: any) => w.node_id === f.nodes[1].id);
      assert.equal(a.round, 2); assert.equal(b.round, 1); assert.equal(b.phase, 'delivered');
      const carried = await work.readWork(owner, b.id);
      assert.equal(JSON.parse(carried.deliveries[0].content_json).retainedFrom.deliveryId, original.work.current_delivery_id);
      assert.equal(await prisma.canvasRoleEvent.count({ where: { work_id: b.id, kind: { in: ['approve', 'confirm'] } } }), 0);
      assert.equal((await work.readWork(owner, run.works[1].id)).work.phase, 'delivered');
      f.req.criteria = 'A changed global criterion'; const global = await update(f, run.run.id);
      assert.equal(global.works.find((w: any) => w.node_id === f.nodes[0].id).round, 3);
      f.req.goal = 'Another actual content change'; await update(f, run.run.id);
      f.req.goal = 'Must not reset the round cap'; await assert.rejects(update(f, run.run.id), rejectCode('round_limit'));
    });
    await check('RV04 Upgraded role has owner task repair outlet but historical execution remains denied', async () => {
      const f = await fixture(['person']), run = await start(f);
      await roles.editRole(owner, f.nodes[0].definitionId, { mutation_id: mutation(), base_revision: 1, base_version: 1,
        action: 'edit', snapshot: snapshot('Updated role') });
      const document = await prisma.canvasDocument.findUniqueOrThrow({ where: { id: f.documentId } }); const graph = JSON.parse(document.document_json);
      graph.canvas.nodes.find((n: any) => n.id === f.nodes[0].id).data.roleConfig.version = 2;
      await documents.mutateCanvasDocument(owner, { mutation_id: mutation(), document_id: document.id, protocol_version: 2,
        base_revision: document.revision, document_json: JSON.stringify(graph), required_capabilities: ['role.v1'] }, 'POST');
      const stale = await work.readWork(owner, run.works[0].id);
      assert.equal(stale.summary.action_available, false); assert.equal(stale.summary.task_update_available, true);
      await assert.rejects(action(run.works[0].id, 'accept'), rejectCode('role_version_changed'));
      const repaired = await update(f, run.run.id);
      assert.equal(JSON.parse(repaired.works[0].snapshot_json).version, 2); assert.equal(repaired.works[0].round, 2);
      assert.equal((await work.readWork(owner, run.works[0].id)).summary.task_update_available, false);
      await assert.rejects(action(run.works[0].id, 'accept'), rejectCode('revision_conflict'));
      await action(repaired.works[0].id, 'accept');
    });
    await check('RV05 Direct delivery return seeds exact original text/items, not stale draft', async () => {
      const f = await fixture(['person', 'person']); f.req.participants[0].reviewerNodeId = f.nodes[1].id;
      const run = await start(f), id = run.works[0].id; await action(id, 'accept'); await action(id, 'draft', { text: 'Stale draft' });
      const d = await work.readWork(owner, id);
      await action(id, 'submit', { text: 'Exact original', items: { evidence: 'Exact item' }, input_digest: d.input_digest });
      const submitted = await work.readWork(owner, id);
      const returned: any = await action(id, 'return', { opinion: 'Fix evidence item', delivery_id: submitted.work.current_delivery_id, input_digest: submitted.input_digest });
      const revision = await work.readWork(owner, returned.successor.id);
      assert.equal(revision.draft_content.text, 'Exact original'); assert.equal(revision.draft_content.items.evidence, 'Exact item');
      assert.equal(revision.revision_source.deliveryId, submitted.work.current_delivery_id); assert.equal(revision.revision_source.readonly, true);
      assert.equal(revision.revision_source.opinion, 'Fix evidence item');
    });
    await check('RV06 Fixed image/video/file originals, original return and permission/change rejection use identities only', async () => {
      const f = await fixture(['person', 'person']); f.req.participants[0].reviewerNodeId = f.nodes[1].id;
      const refs = [];
      for (const type of ['image', 'video']) {
        const id = 'synthetic-asset-' + mutation();
        await prisma.asset.create({ data: { id, owner_id: owner.id, type, file_name: 'Synthetic.' + type,
          mime_type: type + (type === 'image' ? '/png' : '/mp4'),
          original_url: '/uploads/assets/' + id, file_size: 1, hash: mutation() } });
        refs.push({ id, nodeId: 'synthetic-node-' + type, type });
      }
      const document = await prisma.canvasDocument.findUniqueOrThrow({ where: { id: f.documentId } }); const graph = JSON.parse(document.document_json);
      refs.forEach(ref => graph.canvas.nodes.push({ id: ref.nodeId, type: ref.type, x: 0, y: 600, data: { assetId: ref.id, title: 'Synthetic original' } }));
      refs.push({ id: '', nodeId: 'synthetic-node-file', type: 'file' });
      graph.canvas.nodes.push({ id: 'synthetic-node-file', type: 'script', x: 0, y: 900, data: { title: 'Synthetic text file', authoredText: 'Fixed original file body' } });
      await documents.mutateCanvasDocument(owner, { mutation_id: mutation(), document_id: document.id, protocol_version: 2,
        base_revision: document.revision, document_json: JSON.stringify(graph), required_capabilities: ['role.v1'] }, 'POST');
      const run = await start(f), id = run.works[0].id; await action(id, 'accept');
      const d = await work.readWork(owner, id);
      await action(id, 'submit', { text: '', items: { evidence: 'Fixed originals' }, attachments: refs.map(ref => ({ nodeId: ref.nodeId })), input_digest: d.input_digest });
      const submitted = await work.readWork(owner, id), delivery = submitted.deliveries[0], content = JSON.parse(delivery.content_json);
      assert.deepEqual(content.attachments.map((ref: any) => ref.type), ['image', 'video', 'file']);
      assert.ok(content.attachments.every((ref: any) => ref.sourceDigest && !ref.url));
      const fileSource = await media.deliveryAttachmentSource(owner, delivery.id, 2);
      assert.equal('content' in fileSource.snapshot ? fileSource.snapshot.content : null, 'Fixed original file body');
      await assert.rejects(media.deliveryAttachmentSource(outsider, delivery.id, 0), rejectCode('role_task_not_found'));
      const returned: any = await action(id, 'return', { opinion: 'Review fixed file', delivery_id: delivery.id, input_digest: submitted.input_digest });
      const revision = await work.readWork(owner, returned.successor.id);
      assert.equal(revision.draft_content.attachments[2].selection.sourceDeliveryId, delivery.id);
      await action(returned.successor.id, 'submit', { text: '', items: { evidence: 'Original file corrected text' },
        attachments: revision.draft_content.attachments.map((ref: any) => ref.selection), input_digest: revision.input_digest });
      const privateBinding = 'studio_fixed_references_v1:synthetic-' + mutation();
      await prisma.platformSetting.create({ data: { key: privateBinding,
        value_json: JSON.stringify({ ownerId: outsider.id, references: [{ assetId: refs[0].id }] }) } });
      await assert.rejects(media.deliveryAttachmentSource(owner, delivery.id, 0), rejectCode('material_unavailable'));
      await prisma.platformSetting.delete({ where: { key: privateBinding } });
      const sharedAlbum = await prisma.referenceAlbum.create({ data: { owner_user_id: outsider.id, name: 'Synthetic use-only album' } });
      await prisma.albumShare.create({ data: { album_id: sharedAlbum.id, grantee_type: 'user', grantee_id: owner.id, created_by: outsider.id,
        permissions_json: JSON.stringify({ view: true, use: true, download: false }) } });
      const sharedImage = await prisma.referenceImage.create({ data: { album_id: sharedAlbum.id, owner_user_id: outsider.id,
        asset_id: refs[0].id, url: '/uploads/assets/' + refs[0].id, thumbnail_url: '/uploads/assets/synthetic-thumbnail' } });
      const sharedSource = await media.originalIdentity(prisma, owner, { referenceImageId: sharedImage.id });
      assert.equal(sharedSource.url, `/api/reference-images/${sharedImage.id}/content?variant=original`);
      assert.equal(await (await import('../src/lib/reference-albums/permissions')).canDownloadOriginal(owner,
        await (await import('../src/lib/reference-albums/permissions')).assertCanUseReferenceImage(owner, sharedImage.id)), false);
      await prisma.asset.update({ where: { id: refs[0].id }, data: { original_url: '/uploads/assets/different-original' } });
      await assert.rejects(media.deliveryAttachmentSource(owner, delivery.id, 0), rejectCode('original_changed'));
      await prisma.asset.update({ where: { id: refs[1].id }, data: { status: 'deleted' } });
      await assert.rejects(media.deliveryAttachmentSource(owner, delivery.id, 1), (e: any) => e.status === 403);
      await assert.rejects(action(returned.successor.id, 'approve', { delivery_id: (await work.readWork(owner, returned.successor.id)).work.current_delivery_id,
        input_digest: revision.input_digest }), rejectCode('original_changed'));
    });
    await check('RV08 Thirty-one original attempts paginate separately and exact detail rejects wrong owner/cursor', async () => {
      const f = await fixture(['person', 'person']), run = await start(f), id = run.works[0].id;
      const ids = [];
      for (let i = 0; i < 31; i++) {
        const attemptId = mutation(); ids.push(attemptId);
        await prisma.canvasRoleAttempt.create({ data: { id: attemptId, work_id: id, round: 1, purpose: 'review', attempt: i + 1,
          request_id: mutation(), state: 'succeeded', fee_state: 'confirmed', settlement_applied: true,
          reserved_points: 0, reserved_usd_micros: 0, settled_points: 0, settled_usd_micros: 0,
          input_snapshot_json: '{}', quote_json: '{}', provider_scope: 'synthetic', result_json: JSON.stringify({ content: { text: 'Original ' + i, items: {} } }),
          started_at: new Date(Date.now() + i * 1000) } });
      }
      const first = await work.readWork(owner, id); assert.equal(first.attempts.length, 30); assert.ok(first.next_attempt_cursor);
      const next = await work.readWork(owner, id, new URLSearchParams({ attempt_cursor: first.next_attempt_cursor! }));
      assert.equal(next.attempts.length, 1); assert.equal(next.attempts[0].id, ids[0]); assert.equal(next.next_attempt_cursor, null);
      assert.equal(next.next_work_cursor, first.next_work_cursor); assert.equal(next.next_cursor, first.next_cursor);
      assert.ok(first.attempts.every((a: any) => !a.result_json && !a.quote_json && !a.input_snapshot_json && a.result_available));
      const original = await work.readRoleAttempt(owner, ids[0]); assert.match(original.attempt.result_json!, /Original 0/);
      await assert.rejects(work.readRoleAttempt(outsider, ids[0]), rejectCode('role_task_not_found'));
      await assert.rejects(work.readWork(owner, run.works[1].id, new URLSearchParams({ attempt_cursor: ids[0] })), rejectCode('invalid_role'));
      await assert.rejects(work.readWork(owner, id, new URLSearchParams({ work_cursor: ids[0] })), rejectCode('invalid_role'));
    });
    await check('Current account revocation, colleague gate and task-scoped history isolation', async () => {
      const f = await fixture(['person']); const run = await start(f);
      await assert.rejects(work.readWork(outsider, run.works[0].id), rejectCode('role_task_not_found'));
      assert.throws(() => types.roleSnapshot({ ...snapshot(), executor: { kind: 'person', userId: outsider.id } }, owner.id), rejectCode('cross_person_pending'));
      await prisma.user.update({ where: { id: owner.id }, data: { status: 'disabled' } });
      await assert.rejects(work.readWork(owner, run.works[0].id), rejectCode('account_unavailable'));
      await assert.rejects(roles.createRole(owner, { mutation_id: mutation(), snapshot: snapshot() }), rejectCode('account_unavailable'));
      await prisma.user.update({ where: { id: owner.id }, data: { status: 'active' } });
      await work.readWork(owner, run.works[0].id);
      await prisma.user.update({ where: { id: owner.id }, data: { password_hash: 'synthetic-password-rotated' } });
      await assert.rejects(work.readWork(owner, run.works[0].id), rejectCode('account_unavailable'));
      await prisma.user.update({ where: { id: owner.id }, data: { password_hash: 'synthetic-not-a-login-hash' } });
      const other = await start(f);
      await action(run.works[0].id, 'message', { text: 'Private task message', to_node_id: f.nodes[0].id });
      assert.ok(!(await work.readWork(owner, other.works[0].id)).events.some(e => e.kind === 'message'));
    });
    await check('Live Feishu identity revocation blocks a previously internal request', async () => {
      const identity = { user_id: 'synthetic-feishu', open_id: null, union_id: null, tenant_key: null,
        employee_no: null, department_ids: [], last_sync_at: null };
      const bound: SessionUser = { ...owner, id: 'synthetic-feishu-owner', username: 'synthetic-feishu-owner',
        email: 'feishu@invalid.test', feature_profile_id: null, feishu: identity };
      await prisma.user.create({ data: { id: bound.id, username: bound.username, name: bound.name, email: bound.email,
        password_hash: 'synthetic', feishu_user_id: identity.user_id } });
      const role: any = await roles.createRole(bound, { mutation_id: mutation(), snapshot: { ...snapshot(), executor: { kind: 'person', userId: bound.id } } });
      await prisma.user.update({ where: { id: bound.id }, data: { feishu_user_id: null } });
      await assert.rejects(roles.getRole(bound, role.role.id), rejectCode('account_unavailable'));
    });
    await check('No text pricing evidence means no completion POST and no reservation', async () => {
      const f = await fixture(['ai']); const run = await start(f, { budget_points_limit: 10, budget_usd_micros_limit: 100000, max_calls: 2 });
      await action(run.works[0].id, 'accept');
      const d = await work.readWork(owner, run.works[0].id);
      assert.equal(d.execution.enabled, false);
      await assert.rejects(execute.executeWork(owner, d.work.id, { mutation_id: mutation(), base_revision: d.work.revision,
        requirements_revision: 1, purpose: 'work', quote_id: 'fake', max_output_tokens: 100 }), (e: any) => /provider_unavailable|billing_contract_pending/.test(e.code));
      assert.equal(await prisma.canvasRoleAttempt.count({ where: { work_id: run.works[0].id } }), 0);
    });
    const testSettings = { enabled: true, base_url: 'https://api.muskapis.com/', default_model: 'gpt-5.5', api_key: 'SYNTHETIC-NOT-A-REAL-KEY' };
    const contract = { version: 'role-text.v1', scope: provider.textScope(testSettings), model: 'gpt-5.5', source: 'https://api.muskapis.com/synthetic-test-only',
      expiresAt: new Date(Date.now() + 3600000).toISOString(), reserveUsdMicros: 50000, reservePointCents: 500, pointsPerUsd: 100,
      maxInputBytes: 100000, maxOutputTokens: 500, receiptSource: 'header_request_id', quoteProof: '0'.repeat(64), receiptProof: '0'.repeat(64) };
    await prisma.platformSetting.create({ data: { key: 'musk_api_v1', value_json: JSON.stringify(testSettings) } });
    await prisma.platformSetting.create({ data: { key: provider.TEXT_BILLING_KEY, value_json: JSON.stringify({ contracts: [contract] }) } });
    let postCount = 0; let timeout = false; let billQuota = 1000; let invalidate: (() => Promise<void>) | null = null;
    let postBarrier: (() => Promise<void>) | null = null; const frozenInputs: any[] = [];
    globalThis.fetch = async (url, init) => {
      const address = String(url);
      if (address === 'https://api.muskapis.com/v1/chat/completions' && init?.method === 'POST') {
        postCount++;
        frozenInputs.push(JSON.parse(JSON.parse(String(init.body)).messages.at(-1).content));
        if (postBarrier) await postBarrier();
        if (timeout) throw new Error('Synthetic transport uncertainty');
        if (invalidate) await invalidate();
        return new Response(JSON.stringify({ model: 'gpt-5.5', usage: { prompt_tokens: 10, completion_tokens: 20 },
          choices: [{ message: { content: JSON.stringify({ text: 'Synthetic AI result', items: { evidence: 'Synthetic evidence' } }) } }] }),
          { headers: { 'x-request-id': `synthetic-bill-${postCount}` } });
      }
      if (address.endsWith('/api/status')) return new Response(JSON.stringify({ data: { quota_per_unit: 500000, quota_display_type: 'USD' } }));
      if (address.endsWith('/api/log/token')) return new Response(JSON.stringify({ success: true, data: Array.from({ length: postCount }, (_, i) => ({
        request_id: `synthetic-bill-${i + 1}`, type: 2, model_name: 'gpt-5.5', quota: billQuota, created_at: Math.floor(Date.now() / 1000), prompt_tokens: 10, completion_tokens: 20 })) }));
      throw new Error(`Unexpected network address in synthetic adapter: ${new URL(address).pathname}`);
    };
    const aiCall = async (id: string, mutationId = mutation()) => {
      const d = await work.readWork(owner, id); const q: any = d.execution;
      return execute.executeWork(owner, id, { mutation_id: mutationId, base_revision: d.work.revision, requirements_revision: d.work.requirements_revision,
        purpose: 'work', quote_id: q.quote_id, max_output_tokens: q.max_output_tokens });
    };
    await check('Synthetic exact text receipt charges once and cannot replay execution', async () => {
      const f = await fixture(['ai']); const run = await start(f, { budget_points_limit: 5, budget_usd_micros_limit: 50000, max_calls: 1 });
      await action(run.works[0].id, 'accept'); const d = await work.readWork(owner, run.works[0].id); const q: any = d.execution;
      const payload = { mutation_id: mutation(), base_revision: d.work.revision, requirements_revision: 1, purpose: 'work', quote_id: q.quote_id, max_output_tokens: q.max_output_tokens };
      const before = postCount; const result: any = await execute.executeWork(owner, d.work.id, payload);
      assert.equal(result.state, 'succeeded');
      await execute.executeWork(owner, d.work.id, payload); await execute.reconcileAttempt(owner, result.attemptId);
      assert.equal(postCount, before + 1);
      assert.equal(await prisma.creditLedger.count({ where: { idempotency_key: `role-settle:${result.attemptId}` } }), 1);
      const actual = await work.readWork(owner, d.work.id);
      assert.equal(actual.run.reserved_points, 0); assert.equal(actual.run.settled_points, 0.2);
      assert.equal(actual.run.settled_usd_micros, 2000); assert.equal(actual.work.phase, 'delivered');
    });
    await check('RV02/RV05 AI work/review freeze addressed conversations and exact returned original with opinions', async () => {
      const f = await fixture(['ai', 'ai', 'person']); f.req.participants[0].reviewerNodeId = f.nodes[1].id;
      f.req.participants[0].ownerMayReview = true;
      const run = await start(f, { budget_points_limit: 20, budget_usd_micros_limit: 200000, max_calls: 4 }), id = run.works[0].id;
      await action(id, 'accept');
      await action(run.works[2].id, 'message', { text: 'Private other person', to_node_id: f.nodes[2].id });
      await action(id, 'message', { text: 'For actual author', to_node_id: f.nodes[0].id, category: 'question' });
      await action(run.works[1].id, 'message', { text: 'Only reviewer instruction', to_node_id: f.nodes[1].id });
      const quoted = await work.readWork(owner, id), beforeQuoteChange = postCount;
      await action(run.works[2].id, 'message', { text: 'Updated answer for author', to_node_id: f.nodes[0].id });
      await assert.rejects(execute.executeWork(owner, id, { mutation_id: mutation(), base_revision: quoted.work.revision,
        requirements_revision: 1, purpose: 'work', quote_id: quoted.execution.purposes.work.quote_id,
        max_output_tokens: quoted.execution.purposes.work.max_output_tokens }), rejectCode('quote_changed'));
      assert.equal(postCount, beforeQuoteChange);
      await aiCall(id);
      const input = frozenInputs.at(-1); assert.equal(input.context.recipientNodeId, f.nodes[0].id);
      assert.deepEqual(input.context.conversations.map((m: any) => m.text), ['For actual author', 'Updated answer for author']);
      let detail = await work.readWork(owner, id); const q: any = detail.execution.purposes.review;
      await execute.executeWork(owner, id, { mutation_id: mutation(), base_revision: detail.work.revision,
        requirements_revision: 1, purpose: 'review', quote_id: q.quote_id, max_output_tokens: q.max_output_tokens });
      const reviewInput = frozenInputs.at(-1); assert.equal(reviewInput.context.recipientNodeId, f.nodes[1].id);
      assert.deepEqual(reviewInput.context.conversations.map((m: any) => m.text), ['Only reviewer instruction']);
      assert.equal(reviewInput.reviewDelivery.id, detail.work.current_delivery_id); assert.equal(reviewInput.reviewIsRecommendationOnly, true);
      detail = await work.readWork(owner, id);
      const returned: any = await action(id, 'return', { owner_proxy: true, delivery_id: detail.work.current_delivery_id,
        input_digest: detail.input_digest, opinion: 'Change exact evidence' });
      const revision = await work.readWork(owner, returned.successor.id);
      assert.equal(revision.draft_content.text, 'Synthetic AI result'); assert.equal(revision.draft_content.items.evidence, 'Synthetic evidence');
      await aiCall(returned.successor.id);
      assert.equal(frozenInputs.at(-1).context.revisionSource.deliveryId, detail.work.current_delivery_id);
      assert.equal(frozenInputs.at(-1).context.revisionOpinion, 'Change exact evidence');
      assert.equal(frozenInputs.at(-1).currentDraft.items.evidence, 'Synthetic evidence');
    });
    for (const scenario of ['unchanged', 'deleted', 'upgraded']) {
      await check(`RV09 Review executor ${scenario}: exact adoption and original bill without replay`, async () => {
        const f = await fixture(['person', 'ai']); f.req.participants[0].reviewerNodeId = f.nodes[1].id;
        const run = await start(f, { budget_points_limit: 10, budget_usd_micros_limit: 100000, max_calls: 2 });
        const id = run.works[0].id, reviewerId = run.works[1].id;
        await deliver(id);
        const beforeDetail = await work.readWork(owner, id), q: any = beforeDetail.execution.purposes.review;
        assert.equal(q.enabled, true);
        const authorBefore = await prisma.canvasRoleWork.findUniqueOrThrow({ where: { id } });
        const reviewerBefore = await prisma.canvasRoleWork.findUniqueOrThrow({ where: { id: reviewerId } });
        const payload = { mutation_id: mutation(), base_revision: beforeDetail.work.revision, requirements_revision: 1,
          purpose: 'review', quote_id: q.quote_id, max_output_tokens: q.max_output_tokens };
        const beforePost = postCount;
        invalidate = scenario === 'unchanged' ? null : async () => {
          if (scenario === 'upgraded') {
            await roles.editRole(owner, f.nodes[1].definitionId, { mutation_id: mutation(), base_revision: 1,
              base_version: 1, action: 'edit', snapshot: snapshot('Reviewer version two', 'ai') });
          }
          const doc = await prisma.canvasDocument.findUniqueOrThrow({ where: { id: f.documentId } });
          const graph = JSON.parse(doc.document_json);
          if (scenario === 'deleted') graph.canvas.nodes = graph.canvas.nodes.filter((n: any) => n.id !== f.nodes[1].id);
          else graph.canvas.nodes.find((n: any) => n.id === f.nodes[1].id).data.roleConfig.version = 2;
          await prisma.canvasDocument.update({ where: { id: doc.id }, data: { document_json: JSON.stringify(graph), revision: { increment: 1 } } });
        };
        let result: any;
        try { result = await execute.executeWork(owner, id, payload); } finally { invalidate = null; }
        assert.equal(result.state, scenario === 'unchanged' ? 'succeeded' : 'not_adopted');
        assert.equal(result.resend, false);
        const original = await prisma.canvasRoleAttempt.findUniqueOrThrow({ where: { id: result.attemptId } });
        assert.equal(original.work_id, id); assert.equal(original.purpose, 'review');
        assert.ok(original.provider_reference); assert.match(original.result_json!, /Synthetic AI result/);
        const quote = JSON.parse(original.quote_json), input = JSON.parse(original.input_snapshot_json);
        assert.deepEqual(quote.executorIdentity, { workId: reviewerId, nodeId: f.nodes[1].id,
          roleVersionId: reviewerBefore.role_version_id, definitionId: f.nodes[1].definitionId, version: 1,
          roleDigest: types.digest(JSON.parse(reviewerBefore.snapshot_json).role) });
        assert.equal(input.context.recipientNodeId, f.nodes[1].id);
        assert.equal(types.digest(input.role), quote.executorIdentity.roleDigest);
        assert.deepEqual(await prisma.canvasRoleWork.findUniqueOrThrow({ where: { id } }), authorBefore);
        const recommendations = await prisma.canvasRoleEvent.findMany({ where: { work_id: id, kind: 'ai_review_recommendation' } });
        assert.equal(recommendations.length, scenario === 'unchanged' ? 1 : 0);
        if (recommendations.length) {
          const recommendation = JSON.parse(recommendations[0].detail_json);
          assert.equal(recommendation.attemptId, result.attemptId); assert.equal(recommendation.authorityGranted, false);
          assert.equal(recommendation.content.text, 'Synthetic AI result');
        }
        assert.equal(await prisma.canvasRoleEvent.count({ where: { work_id: id, kind: 'message' } }), 0);
        await execute.reconcileAttempt(owner, original.id);
        await execute.reconcileAttempt(owner, original.id);
        const settled = await prisma.canvasRoleAttempt.findUniqueOrThrow({ where: { id: original.id } });
        assert.equal(settled.state, result.state); assert.equal(settled.fee_state, 'confirmed');
        assert.equal(settled.settlement_applied, true); assert.equal(settled.settled_points, 20);
        assert.equal(settled.settled_usd_micros, 2000);
        const actualRun = await prisma.canvasRoleTaskRun.findUniqueOrThrow({ where: { id: run.run.id } });
        assert.equal(actualRun.reserved_points, 0); assert.equal(actualRun.reserved_usd_micros, 0);
        assert.equal(actualRun.settled_points, 20); assert.equal(actualRun.settled_usd_micros, 2000); assert.equal(actualRun.call_count, 1);
        assert.equal(await prisma.creditLedger.count({ where: { idempotency_key: `role-settle:${original.id}`, type: 'task_success_deduct' } }), 1);
        assert.equal(await prisma.creditLedger.count({ where: { related_task_id: `role-attempt:${original.id}`, type: 'task_billing_release' } }), 0);
        await execute.executeWork(owner, id, payload);
        assert.equal(postCount, beforePost + 1); assert.equal(await prisma.canvasRoleAttempt.count({ where: { work_id: id } }), 1);
      });
    }
    await check('RV07 Late result after other-page pause remains reviewable only after task resume, without resend', async () => {
      const f = await fixture(['ai', 'person']); f.req.participants[0].reviewerNodeId = f.nodes[1].id;
      const run = await start(f, { budget_points_limit: 5, budget_usd_micros_limit: 50000, max_calls: 1 }), id = run.works[0].id;
      await action(id, 'accept'); const before = postCount;
      invalidate = async () => { await action(run.works[1].id, 'pause'); };
      try { assert.equal((await aiCall(id)).state, 'succeeded'); } finally { invalidate = null; }
      const late = await work.readWork(owner, id); assert.equal(late.work.phase, 'review'); assert.equal(late.run.paused, true);
      assert.equal(late.summary.task_control_available, true);
      await assert.rejects(action(id, 'approve', { delivery_id: late.work.current_delivery_id, input_digest: late.input_digest }), rejectCode('task_paused'));
      await action(id, 'resume');
      await action(id, 'approve', { delivery_id: late.work.current_delivery_id, input_digest: late.input_digest });
      assert.equal(postCount, before + 1); assert.equal(await prisma.canvasRoleAttempt.count({ where: { work_id: id } }), 1);
    });
    await check('Synthetic paid late result retained even when node adoption is invalidated', async () => {
      const f = await fixture(['ai']); const run = await start(f, { budget_points_limit: 10, budget_usd_micros_limit: 100000, max_calls: 2 });
      await action(run.works[0].id, 'accept');
      invalidate = async () => {
        const doc = await prisma.canvasDocument.findUniqueOrThrow({ where: { id: f.documentId } }); const graph = JSON.parse(doc.document_json);
        graph.canvas.nodes = graph.canvas.nodes.filter((n: any) => n.id !== f.nodes[0].id);
        await prisma.canvasDocument.update({ where: { id: doc.id }, data: { document_json: JSON.stringify(graph), revision: { increment: 1 } } });
      };
      const result: any = await aiCall(run.works[0].id); invalidate = null;
      assert.equal(result.state, 'not_adopted');
      const attempt = await prisma.canvasRoleAttempt.findUniqueOrThrow({ where: { id: result.attemptId } });
      assert.ok(attempt.provider_reference); assert.match(attempt.result_json!, /Synthetic AI result/);
      const quote = JSON.parse(attempt.quote_json); quote.contract.expiresAt = new Date(Date.now() - 1).toISOString();
      await prisma.canvasRoleAttempt.update({ where: { id: attempt.id }, data: { quote_json: JSON.stringify(quote) } });
      await execute.reconcileAttempt(owner, attempt.id);
      const settled = await prisma.canvasRoleAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
      assert.equal(settled.fee_state, 'confirmed'); assert.equal(settled.settled_points, 20);
      assert.equal((await work.readWork(owner, run.works[0].id)).run.settled_points, 0.2);
      assert.equal(await prisma.canvasRoleDelivery.count({ where: { work_id: run.works[0].id } }), 0);
    });
    await check('Parallel branches share atomic reserve and cannot exceed one task budget', async () => {
      const f = await fixture(['ai', 'ai']); const run = await start(f, { budget_points_limit: 5, budget_usd_micros_limit: 50000, max_calls: 2 });
      await action(run.works[0].id, 'accept'); await action(run.works[1].id, 'accept');
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const held = new Promise<void>(resolve => { release = resolve; });
      postBarrier = async () => { entered(); await held; };
      const first = aiCall(run.works[0].id);
      try {
        await Promise.race([started, first.then(() => { throw new Error('Synthetic sender ended before entering its POST'); })]);
        await assert.rejects(aiCall(run.works[1].id), rejectCode('budget_exceeded'));
        const actual = await prisma.canvasRoleTaskRun.findUniqueOrThrow({ where: { id: run.run.id } });
        assert.equal(actual.reserved_points, 500); assert.equal(actual.call_count, 1);
      } finally { postBarrier = null; release(); await first; }
    });
    await check('Exact over-reserve bill holds authorization without refund, extra deduction or resend', async () => {
      const f = await fixture(['ai']); const run = await start(f, { budget_points_limit: 10, budget_usd_micros_limit: 100000, max_calls: 2 });
      await action(run.works[0].id, 'accept'); billQuota = 30000;
      try {
        const result: any = await aiCall(run.works[0].id); const before = postCount;
        const receipt = await execute.reconcileAttempt(owner, result.attemptId);
        assert.equal(receipt.fee_state, 'authorization_required');
        assert.equal(postCount, before);
        const current = await prisma.canvasRoleAttempt.findUniqueOrThrow({ where: { id: result.attemptId } });
        assert.equal(current.settlement_applied, false); assert.match(current.settlement_receipt!, /60000/);
        assert.equal((await work.readWork(owner, run.works[0].id)).run.reserved_points, 5);
        assert.equal(await prisma.creditLedger.count({ where: { idempotency_key: `role-settle:${result.attemptId}` } }), 0);
        const document = await prisma.canvasDocument.findUniqueOrThrow({ where: { id: f.documentId } });
        const currentRun = await prisma.canvasRoleTaskRun.findUniqueOrThrow({ where: { id: run.run.id } });
        await assert.rejects(work.updateTaskRun(owner, run.run.id, { mutation_id: mutation(), base_revision: currentRun.revision,
          document_revision: document.revision, requirements: f.req }), rejectCode('attempt_unresolved'));
      } finally { billQuota = 1000; }
    });
    await check('Synthetic unknown transport keeps reserve and forbids second attempt', async () => {
      const f = await fixture(['ai']); const run = await start(f, { budget_points_limit: 10, budget_usd_micros_limit: 100000, max_calls: 2 });
      await action(run.works[0].id, 'accept'); timeout = true;
      const result: any = await aiCall(run.works[0].id); timeout = false;
      assert.equal(result.state, 'unknown'); const before = postCount;
      await assert.rejects(aiCall(run.works[0].id), rejectCode('attempt_unresolved'));
      await execute.reconcileAttempt(owner, result.attemptId);
      assert.equal(postCount, before);
      assert.equal((await work.readWork(owner, run.works[0].id)).run.reserved_points, 5);
    });
    await check('Old account deletion unaffected by new FK; orphan role access fails closed', async () => {
      const deletionUser = { ...outsider, id: 'role-test-delete', username: 'role-test-delete', email: 'delete@invalid.test' };
      await prisma.user.create({ data: { id: deletionUser.id, name: deletionUser.name, username: deletionUser.username, email: deletionUser.email,
        feature_profile_id: deletionUser.feature_profile_id, password_hash: 'synthetic' } });
      const saved: any = await roles.createRole(deletionUser, { mutation_id: mutation(), snapshot: { ...snapshot(), executor: { kind: 'person', userId: deletionUser.id } } });
      await prisma.user.delete({ where: { id: deletionUser.id } });
      assert.ok(await prisma.canvasRoleDefinition.findUnique({ where: { id: saved.role.id } }));
      await assert.rejects(roles.getRole(deletionUser, saved.role.id), rejectCode('account_unavailable'));
    });
    await check('Required item safety, material DAG and decimal units', () => {
      assert.equal(types.pointCents(1.23), 123); assert.throws(() => types.pointCents(1.234));
      assert.throws(() => types.roleSnapshot({ ...snapshot(), requiredItems: ['same', 'same'] }, owner.id));
      assert.equal(provider.cashToPointCents(2000, 100), 20);
      assert.equal(provider.parseTextContract({ ...contract, scope: 'changed' }, contract.scope, 'gpt-5.5'), null);
    });
  } finally {
    globalThis.fetch = realFetch;
    await prisma.$disconnect();
    writeFileSync(path.join(directory, 'receipt.json'), JSON.stringify({ syntheticOnly: true, realProviderCalls: 0, productionWrites: 0,
      scope: rv09Only ? 'RV09 actual review executor adoption and unchanged-review regression only' : 'Full isolated role contract batch', checks }, null, 2), { mode: 0o600 });
    console.log(`Evidence: ${path.join(directory, 'receipt.json')}`);
  }
  if (!checks.length || checks.some(c => !c.passed)) process.exitCode = 1;
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
