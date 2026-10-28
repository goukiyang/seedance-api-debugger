import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import type { SessionUser } from '../src/lib/auth/session';

// Lead-only native proof. Never opens an application database or calls a provider.
const url = process.env.DATABASE_URL || '';
const match = /^file:(\/tmp\/f24-canvas-[A-Za-z0-9]+\/proof\.db)$/.exec(url);
if (process.platform !== 'linux' || process.env.F24_SYNTHETIC_PROOF !== '1' || process.env.NODE_ENV !== 'test'
  || !match || realpathSync(match[1]) !== match[1] || realpathSync(path.dirname(match[1])) !== path.dirname(match[1])) {
  throw Error('Linux fresh /tmp/f24-canvas-*/proof.db synthetic proof only');
}
let phase = 'imports';
async function main() {
  const { prisma } = await import('../src/lib/prisma');
  const { resolveCanvasReferenceInputs, applyCanvasReferenceInputs } = await import('../src/lib/canvas-reference-inputs');
  const { canvasWorkspaceKey, resolveCanvasWorkspaceScope, readLegacyCanvasWorkspace, writeCanvasWorkspace } = await import('../src/lib/canvas-workspace');
  const { canvasDetail, mutateCanvasDocument } = await import('../src/lib/canvas-documents');
  const { resolveVideoPricingContext } = await import('../src/lib/pricing/video-context');
  const { quoteVideoPricing } = await import('../src/lib/pricing/video');
  const { prepareVideoCreationIntent, acceptVideoCreationIntent } = await import('../src/lib/creation/intents');
  const { SEEDANCE_2_0_MODEL_ID } = await import('../src/lib/provider/seedance-models');
  const caps = ['role.v1', 'role.workflow.v1', 'role.collaboration.v2', 'canvas_video_batch_v1', 'canvas.references.v1'];
  try {
    phase = 'fresh_database';
    const databases = await prisma.$queryRawUnsafe<Array<{ name: string; file: string }>>('PRAGMA database_list');
    assert.equal(databases.find(row => row.name === 'main')?.file, match![1]);
    assert.equal(await prisma.user.count(), 0); assert.equal(await prisma.videoTask.count(), 0);
    const row = await prisma.user.create({ data: { id: 'f24-user', name: 'Synthetic', username: 'f24-synthetic', email: 'synthetic@invalid.example',
      password_hash: 'synthetic-no-login', account_type: 'internal', feature_profile_id: 'internal_email_authorized',
      status: 'active', role: 'user', user_profile: 'core_video' } });
    const user = row as SessionUser;
    await prisma.creditAccount.create({ data: { user_id: user.id, balance: 1234 } });
    const project = await prisma.project.create({ data: { id: 'f24-project', name: 'Synthetic', owner_user_id: user.id, created_by: user.id, type: 'personal' } });
    const graph = { schema: 'ultimate_canvas.v1', schemaVersion: 2, context: { project_id: project.id, video_card_id: null },
      canvas: { nodes: [{ id: 'target', type: 'video', x: 0, y: 0, data: {} as Record<string, unknown> }], connections: [] } };
    const doc = await prisma.canvasDocument.create({ data: { id: 'f24-document', owner_user_id: user.id, project_id: project.id,
      title: 'Synthetic', schema_version: 2, protocol_version: 2, revision: 1, document_json: JSON.stringify(graph) } });
    const assets = [];
    for (const kind of ['image', 'video', 'audio']) assets.push(await prisma.asset.create({ data: { id: 'f24-' + kind, owner_id: user.id, type: kind,
      original_url: 'https://synthetic.invalid/' + kind, file_name: kind, mime_type: kind + '/synthetic', file_size: 10, hash: kind.padEnd(64, 'a') } }));
    const unknown = await prisma.videoTask.create({ data: { id: 'f24-unknown', provider: 'seedance', model: SEEDANCE_2_0_MODEL_ID, generation_mode: 'all_in_one_reference',
      prompt: 'synthetic-original', owner_user_id: user.id, user_id: user.id, project_id: project.id, local_status: 'submitted',
      idempotency_key: 'f24-original-unknown', error_code: 'SUBMISSION_UNCONFIRMED', frozen_cost: 0 } });
    const balances = async () => ({ accounts: await prisma.creditAccount.findMany(), ledgers: await prisma.creditLedger.findMany(),
      unknown: await prisma.videoTask.findUniqueOrThrow({ where: { id: unknown.id } }) });
    const before = await balances();
    phase = 'actual_old_no_field_read_write';
    assert.equal(canvasDetail(doc).document_json, doc.document_json);
    await mutateCanvasDocument(user, { document_id: doc.id, project_id: project.id, protocol_version: 2,
      base_revision: doc.revision, mutation_id: 'f24-old-save', document_json: JSON.stringify(graph) }, 'POST');
    const oldSaved = await prisma.canvasDocument.findUniqueOrThrow({ where: { id: doc.id } });
    assert.equal(JSON.parse(oldSaved.document_json).canvasReferenceVersion, undefined);
    const body = { provider: 'seedance', model: SEEDANCE_2_0_MODEL_ID, generation_mode: 'all_in_one_reference', project_id: project.id, video_card_id: null,
      canvas_document_id: doc.id, canvas_node_id: 'target', canvas_references: { version: 1, items: assets.map(asset => ({ kind: asset.type, role: 'reference', assetId: asset.id })) },
      required_capabilities: caps, prompt: 'synthetic', resolution: '480p', duration: 5, ratio: '16:9', draft: false };
    phase = 'actual_tx_quote_rollback';
    let canonical: Record<string, unknown> = body;
    await assert.rejects(() => prisma.$transaction(async tx => {
      const resolved = await resolveCanvasReferenceInputs(user, body, tx, { target: 'video' });
      canonical = applyCanvasReferenceInputs(body, resolved);
      const context = await resolveVideoPricingContext(user, canonical, 'create', tx);
      const quote = await quoteVideoPricing({ provider: 'seedance', model: body.model, resolution: body.resolution, duration: body.duration, context }, tx);
      assert.equal(context.referenceVideoCount, 1); assert.ok(Number.isFinite(quote.pricing.estimatedCost));
      assert.deepEqual(resolved!.references.items.map(item => item.kind), ['image', 'video', 'audio']);
      const scope = await resolveCanvasWorkspaceScope(user, { projectId: project.id, documentId: doc.id }, tx);
      assert.ok((await writeCanvasWorkspace(scope, tx)).id);
      throw Error('f24_intentional_rollback');
    }), /f24_intentional_rollback/);
    assert.deepEqual(await balances(), before);
    phase = 'actual_version_authority_negatives';
    await prisma.asset.update({ where: { id: assets[0].id }, data: { hash: 'b'.repeat(64) } });
    await assert.rejects(() => prisma.$transaction(tx => resolveCanvasReferenceInputs(user, canonical, tx)), error => (error as { status: number }).status === 409);
    await prisma.asset.update({ where: { id: assets[0].id }, data: { hash: assets[0].hash } });
    await prisma.project.update({ where: { id: project.id }, data: { status: 'archived' } });
    await assert.rejects(() => prisma.$transaction(tx => resolveCanvasReferenceInputs(user, canonical, tx)));
    await prisma.project.update({ where: { id: project.id }, data: { status: 'active' } });
    await assert.rejects(() => resolveCanvasWorkspaceScope({ ...user, id: 'other' }, { projectId: project.id, documentId: doc.id }));
    phase = 'actual_explicit_identity_contract';
    const source = await prisma.videoTask.create({ data: { id: 'f24-valid-source', provider: 'seedance', model: SEEDANCE_2_0_MODEL_ID,
      generation_mode: 'all_in_one_reference', prompt: 'synthetic-source', user_id: user.id, owner_user_id: user.id, project_id: project.id,
      local_status: 'succeeded', public_video_url: assets[1].original_url } });
    const sourceInput = (items: unknown[]) => ({ ...body, canvas_references: { version: 1, items } });
    const taskOnly = { kind: 'video', role: 'reference', taskId: source.id };
    await assert.rejects(() => prisma.$transaction(tx => resolveCanvasReferenceInputs(user,
      sourceInput([{ ...taskOnly, assetId: 'f24-nonexistent-asset' }]), tx)), error => (error as { status: number }).status === 403);
    const taskResult = await prisma.$transaction(tx => resolveCanvasReferenceInputs(user, sourceInput([taskOnly]), tx));
    assert.equal(taskResult!.references.items[0].taskId, source.id);
    assert.equal(taskResult!.references.items[0].assetId, undefined);
    const matching = { ...taskOnly, assetId: assets[1].id };
    assert.equal((await prisma.$transaction(tx => resolveCanvasReferenceInputs(user, sourceInput([matching]), tx)))!.references.items[0].assetId, assets[1].id);
    await assert.rejects(() => prisma.$transaction(tx => resolveCanvasReferenceInputs(user,
      sourceInput([{ ...matching, taskId: 'f24-nonexistent-task' }]), tx)), error => (error as { status: number }).status === 403);
    const album = await prisma.referenceAlbum.create({ data: { name: 'Synthetic', owner_user_id: user.id } });
    const reference = await prisma.referenceImage.create({ data: { album_id: album.id, owner_user_id: user.id, asset_id: assets[0].id, url: assets[0].original_url } });
    const imageReference = { kind: 'image', role: 'reference', assetId: assets[0].id, referenceImageId: reference.id };
    assert.equal((await prisma.$transaction(tx => resolveCanvasReferenceInputs(user, sourceInput([imageReference]), tx)))!.references.items[0].referenceImageId, reference.id);
    await assert.rejects(() => prisma.$transaction(tx => resolveCanvasReferenceInputs(user,
      sourceInput([{ ...imageReference, referenceImageId: 'f24-nonexistent-reference' }]), tx)), error => (error as { status: number }).status === 404);
    phase = 'actual_fresh_actor_expiry';
    const priorScope = await resolveCanvasWorkspaceScope(user, { projectId: project.id, documentId: doc.id });
    await prisma.user.update({ where: { id: user.id }, data: { expires_at: new Date(0) } });
    for (const purpose of ['read', 'upload', 'generate'] as const) await assert.rejects(() => prisma.$transaction(tx => resolveCanvasWorkspaceScope(user,
      { projectId: project.id, documentId: doc.id, purpose }, tx)), error => (error as { status: number }).status === 403);
    await assert.rejects(() => prisma.$transaction(tx => resolveCanvasReferenceInputs(user, canonical, tx, { scope: priorScope })), error => (error as { status: number }).status === 403);
    await prisma.user.update({ where: { id: user.id }, data: { expires_at: null } });
    assert.deepEqual(await balances(), before);
    phase = 'actual_document_sticky_reader_copy_replay';
    graph.canvas.nodes[0].data.canvas_references = canonical.canvas_references;
    const saveBody = { document_id: doc.id, project_id: project.id, protocol_version: 2, base_revision: oldSaved.revision, mutation_id: 'f24-save', document_json: JSON.stringify(graph) };
    await mutateCanvasDocument(user, saveBody, 'POST', caps);
    let saved = await prisma.canvasDocument.findUniqueOrThrow({ where: { id: doc.id } });
    assert.equal(canvasDetail(saved).document_json, saved.document_json);
    assert.equal(canvasDetail(saved).reference_capability!.client_supported, false);
    assert.deepEqual(await prisma.canvasDocument.findUniqueOrThrow({ where: { id: doc.id } }), saved);
    assert.equal(canvasDetail(saved, caps).workspace_context!.workspace_key, canvasWorkspaceKey(user.id, project.id, doc.id));
    for (const action of ['duplicate', 'restore_revision']) await assert.rejects(() => mutateCanvasDocument(user,
      { action, document_id: doc.id, protocol_version: 2, base_revision: saved.revision, mutation_id: 'old-' + action, title: 'old-reader' }, 'PATCH'), error => (error as { status: number }).status === 426);
    await assert.rejects(() => mutateCanvasDocument(user, { ...saveBody, mutation_id: 'old-drop-fields', base_revision: saved.revision,
      document_json: JSON.stringify({ ...graph, canvas: { ...graph.canvas, nodes: [] } }) }, 'POST'), error => (error as { status: number }).status === 426);
    const originalJson = saved.document_json;
    for (const action of ['rename', 'archive', 'restore']) {
      await mutateCanvasDocument(user, { action, document_id: doc.id, protocol_version: 2, base_revision: saved.revision,
        mutation_id: 'lossless-' + action, ...(action === 'rename' ? { title: 'Synthetic renamed' } : {}) }, 'PATCH');
      saved = await prisma.canvasDocument.findUniqueOrThrow({ where: { id: doc.id } });
      assert.equal(saved.document_json, originalJson);
      assert.equal(saved.status, action === 'archive' ? 'archived' : 'active');
    }
    await assert.rejects(() => mutateCanvasDocument(user, { action: 'rename', document_id: doc.id, protocol_version: 2,
      mutation_id: 'metadata-stale', base_revision: saved.revision - 1, title: 'stale' }, 'PATCH'), error => (error as { code: string }).code === 'revision_conflict');
    const replayed = await mutateCanvasDocument(user, saveBody, 'POST');
    assert.equal('replayed' in replayed && replayed.replayed, true); assert.equal(await prisma.canvasDocument.count(), 1);
    assert.equal((await prisma.canvasDocument.findUniqueOrThrow({ where: { id: doc.id } })).revision, saved.revision);
    await assert.rejects(() => resolveCanvasReferenceInputs(user, { ...canonical, required_capabilities: [] }), error => (error as { status: number }).status === 426);
    const duplicate = await mutateCanvasDocument(user, { action: 'duplicate', document_id: doc.id, protocol_version: 2,
      base_revision: saved.revision, mutation_id: 'f24-copy', required_capabilities: caps }, 'PATCH', caps);
    const copied = await prisma.canvasDocument.findUniqueOrThrow({ where: { id: duplicate.document.id } });
    assert.deepEqual(JSON.parse(copied.document_json).canvas.nodes[0].data.canvas_references, canonical.canvas_references);
    graph.canvas.nodes[0].data.canvas_references = { version: 1, items: [] };
    await mutateCanvasDocument(user, { ...saveBody, mutation_id: 'f24-clear', base_revision: saved.revision, document_json: JSON.stringify(graph) }, 'POST', caps);
    saved = await prisma.canvasDocument.findUniqueOrThrow({ where: { id: doc.id } });
    assert.equal(JSON.parse(saved.document_json).canvasReferenceVersion, 1);
    phase = 'actual_legacy_lookup_no_allocation';
    const scope = await resolveCanvasWorkspaceScope(user, { projectId: project.id, documentId: doc.id });
    assert.equal(await readLegacyCanvasWorkspace(scope, 'target'), null); assert.equal(await prisma.workspace.count(), 0);
    phase = 'actual_intent_freeze_rollback';
    const prepared = await prepareVideoCreationIntent(user, { ...canonical, action: 'generate', entry: 'canvas', count: 1, request_id: 'f24-prepare' });
    assert.deepEqual(prepared.spec!.input.canvas_references, canonical.canvas_references);
    const taskCount = await prisma.videoTask.count();
    await assert.rejects(() => prisma.$transaction(async tx => {
      const task = await tx.videoTask.create({ data: { provider: 'seedance', model: body.model, generation_mode: body.generation_mode, prompt: 'synthetic',
        user_id: user.id, owner_user_id: user.id, project_id: project.id, params_json: JSON.stringify({ canvas_references: canonical.canvas_references }) } });
      await acceptVideoCreationIntent(tx, user, { ...canonical, creation_contract_version: 2, intent_id: prepared.id, intent_revision: prepared.revision,
        idempotency_key: prepared.request_id }, { taskId: task.id, cost: prepared.quote!.estimated_cost, pricingRevision: prepared.quote!.pricing_revision });
      const frozen = await tx.videoTask.findUniqueOrThrow({ where: { id: task.id } });
      assert.deepEqual(JSON.parse(frozen.params_json!).canvas_references, canonical.canvas_references);
      throw Error('f24_intentional_rollback');
    }), /f24_intentional_rollback/);
    assert.equal(await prisma.videoTask.count(), taskCount); assert.deepEqual(await balances(), before);
    console.log(JSON.stringify({ proof: 'f24-native-helpers', phase: 'complete', actualPrisma: true, providerCalls: 0, realMedia: false,
      httpIdentityOrRouteProof: false, scope: 'fresh synthetic owner/document/rights/quote/intent/frozen rollback/reader compatibility' }));
  } finally { await prisma.$disconnect(); }
}
main().catch(error => { console.error(JSON.stringify({ proof: 'f24-native-helpers', phase, name: error?.name,
  code: error?.code, message: error instanceof Error ? error.message : 'unknown' })); process.exitCode = 1; });
