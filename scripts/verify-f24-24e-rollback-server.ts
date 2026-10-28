import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import type { SessionUser } from '../src/lib/auth/session';

const match = /^file:(\/tmp\/f24-24e-rollback-[A-Za-z0-9]+\/proof\.db)$/.exec(process.env.DATABASE_URL || '');
if (process.platform !== 'linux' || process.env.NODE_ENV !== 'test' || process.env.F24_ROLLBACK_SYNTHETIC !== '1'
  || !match || realpathSync(match[1]) !== match[1] || realpathSync(path.dirname(match[1])) !== path.dirname(match[1])) {
  throw Error('Linux fresh /tmp/f24-24e-rollback-*/proof.db synthetic proof only');
}
let phase = 'imports';
async function main() {
  const { prisma } = await import('../src/lib/prisma');
  const { canvasDetail, mutateCanvasDocument } = await import('../src/lib/canvas-documents');
  const { assertCanvasGenerationRollbackSafe } = await import('../src/lib/canvas-reference-rollback');
  const { assertCanvasVideoAdmission } = await import('../src/lib/canvas-video-batches-guards');
  const { resolveVideoPricingContext } = await import('../src/lib/pricing/video-context');
  const paused = (error: unknown) => (error as { status: number }).status === 426;
  try {
    phase = 'fresh_database';
    const databases = await prisma.$queryRawUnsafe<Array<{ name: string; file: string }>>('PRAGMA database_list');
    assert.equal(databases.find(row => row.name === 'main')?.file, match![1]);
    assert.equal(await prisma.user.count(), 0); assert.equal(await prisma.videoTask.count(), 0);
    const user = await prisma.user.create({ data: { id: 'rollback-user', name: 'Synthetic', username: 'rollback-synthetic', email: 'rollback@invalid.example',
      password_hash: 'synthetic-no-login', account_type: 'internal', feature_profile_id: 'internal_email_authorized',
      role: 'user', status: 'active', user_profile: 'core_video' } }) as SessionUser;
    await prisma.creditAccount.create({ data: { user_id: user.id, balance: 1234 } });
    const project = await prisma.project.create({ data: { id: 'rollback-project', name: 'Synthetic', owner_user_id: user.id, created_by: user.id, type: 'personal' } });
    const graph = { schema: 'ultimate_canvas.v1', schemaVersion: 2, context: { project_id: project.id, video_card_id: null },
      canvas: { nodes: [{ id: 'node', type: 'video', x: 0, y: 0, data: {} }], connections: [] } };
    const doc = await prisma.canvasDocument.create({ data: { id: 'rollback-document', owner_user_id: user.id, project_id: project.id,
      title: 'Synthetic', schema_version: 2, protocol_version: 2, revision: 1, document_json: JSON.stringify(graph) } });
    const unknown = await prisma.videoTask.create({ data: { id: 'rollback-unknown', provider: 'seedance', model: 'seedance_2.0', generation_mode: 'all_in_one_reference',
      prompt: 'synthetic-original', owner_user_id: user.id, user_id: user.id, project_id: project.id, local_status: 'submitted', idempotency_key: 'rollback-original-unknown',
      error_code: 'SUBMISSION_UNCONFIRMED', frozen_cost: 0 } });
    const moneyAndUnknown = async () => ({ accounts: await prisma.creditAccount.findMany(), ledgers: await prisma.creditLedger.findMany(),
      unknown: await prisma.videoTask.findUniqueOrThrow({ where: { id: unknown.id } }) });
    const before = await moneyAndUnknown();
    phase = 'old_no_field_read_write';
    assert.equal(canvasDetail(doc).document_json, doc.document_json);
    const originalSave = { document_id: doc.id, project_id: project.id, protocol_version: 2, base_revision: 1,
      mutation_id: 'rollback-original-save', document_json: JSON.stringify(graph) };
    await mutateCanvasDocument(user, originalSave, 'POST');
    await assertCanvasGenerationRollbackSafe(user.id, { canvas_document_id: doc.id }, prisma);
    phase = 'synthetic_new_version_persisted_fields';
    // Test setup represents the already-persisted new version, not rollback program data migration.
    const marked = { ...graph, canvasReferenceVersion: 1, requiredCapabilities: ['canvas.references.v1'],
      canvas: { ...graph.canvas, nodes: [{ ...graph.canvas.nodes[0], data: { canvas_references: { version: 1, items: [] } } }] } };
    const exactJson = ' \n' + JSON.stringify(marked, null, 2) + '\n';
    let saved = await prisma.canvasDocument.update({ where: { id: doc.id }, data: { document_json: exactJson } });
    phase = 'lossless_read_and_original_mutation_replay';
    assert.equal(canvasDetail(saved).document_json, exactJson);
    const replay = await mutateCanvasDocument(user, originalSave, 'POST');
    assert.equal('replayed' in replay && replay.replayed, true);
    assert.equal((await prisma.canvasDocument.findUniqueOrThrow({ where: { id: doc.id } })).document_json, exactJson);
    phase = 'lossless_metadata';
    for (const action of ['rename', 'archive', 'restore']) {
      await mutateCanvasDocument(user, { action, document_id: doc.id, protocol_version: 2, base_revision: saved.revision,
        mutation_id: 'rollback-' + action, document_json: JSON.stringify(graph), ...(action === 'rename' ? { title: 'Renamed' } : {}) }, 'PATCH');
      saved = await prisma.canvasDocument.findUniqueOrThrow({ where: { id: doc.id } });
      assert.equal(saved.document_json, exactJson); assert.equal(saved.status, action === 'archive' ? 'archived' : 'active');
    }
    phase = 'rewrite_pause_before_allocation';
    const beforeRows = { documents: await prisma.canvasDocument.count(), revisions: await prisma.canvasDocumentRevision.count() };
    for (const action of ['duplicate', 'restore_revision']) await assert.rejects(() => mutateCanvasDocument(user, { action, document_id: doc.id,
      protocol_version: 2, base_revision: saved.revision, mutation_id: 'rollback-denied-' + action, target_revision: 1 }, 'PATCH'), paused);
    await assert.rejects(() => mutateCanvasDocument(user, { ...originalSave, base_revision: saved.revision, mutation_id: 'rollback-drop-fields' }, 'POST'), paused);
    await assert.rejects(() => mutateCanvasDocument(user, { ...originalSave, document_id: undefined, base_revision: 0,
      document_json: JSON.stringify(marked), mutation_id: 'rollback-newfields-create' }, 'POST'), paused);
    assert.deepEqual({ documents: await prisma.canvasDocument.count(), revisions: await prisma.canvasDocumentRevision.count() }, beforeRows);
    phase = 'generation_quote_and_child_admission_pause';
    const body = { canvas_document_id: doc.id, canvas_node_id: 'node', project_id: project.id, provider: 'seedance', model: 'seedance_2.0', duration: 5, resolution: '480p' };
    await assert.rejects(() => assertCanvasGenerationRollbackSafe(user.id, body, prisma), paused);
    await assert.rejects(() => prisma.$transaction(tx => resolveVideoPricingContext(user, body, 'create', tx)), paused);
    await assert.rejects(() => prisma.$transaction(tx => assertCanvasVideoAdmission(tx, user, body, null,
      { projectId: project.id, videoCardId: null, branchId: null, amount: 5 })), paused);
    await assert.rejects(() => assertCanvasGenerationRollbackSafe(user.id, { canvas_references: { version: 1, items: [] } }, prisma), paused);
    phase = 'unchanged_unknown_and_money';
    assert.deepEqual(await moneyAndUnknown(), before); assert.equal(await prisma.videoTask.count(), 1);
    assert.equal((await prisma.canvasDocument.findUniqueOrThrow({ where: { id: doc.id } })).document_json, exactJson);
    console.log(JSON.stringify({ proof: 'derived-24e-canvas-rollback', phase: 'complete', actualPrisma: true, providerCalls: 0,
      realMedia: false, httpOrFullAdmissionProof: false }));
  } finally { await prisma.$disconnect(); }
}
main().catch(error => { console.error(JSON.stringify({ proof: 'derived-24e-canvas-rollback', phase, name: error?.name,
  code: error?.code, message: error instanceof Error ? error.message : 'unknown' })); process.exitCode = 1; });
