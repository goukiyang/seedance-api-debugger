import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import { templateUsageCounts } from '../src/lib/template-studio/usage-counts';

export async function verifyTemplateUsageCounts(db: PrismaClient, owner: string, other: string, moduleId: string) {
  const source = 'gallery-preset-5';
  await db.imageStudioTask.createMany({ data: [
    ['usage-image-1', owner, 'same-batch', moduleId, 1],
    ['usage-image-2', owner, 'same-batch', moduleId, 2],
    ['usage-image-3', other, 'same-batch', 'other-private-module', 1],
    ['usage-image-4', owner, 'second-batch', moduleId, 1],
  ].map(([id, user, batch, module, ordinal]) => ({ id: String(id), owner_id: String(user), batch_id: String(batch),
    module_id: String(module), source_preset_id: source, ordinal: Number(ordinal), fingerprint: 'synthetic', prompt: 'synthetic',
    context: '', revision: 1, model: 'gpt-image-2', reference_ids: '[]', unit_credits: 0,
    status: 'failed', deleted_at: id === 'usage-image-4' ? new Date() : null })) });
  const draftId = 'usage-draft-a', otherDraft = 'usage-draft-other';
  await db.videoStudioDraft.createMany({ data: [
    { id: draftId, owner_user_id: owner, name: 'Synthetic draft', template_source: 'studio', source_template_id: 'usage-studio-b' },
    { id: otherDraft, owner_user_id: other, name: 'Other draft' },
  ] });
  const snapshot = JSON.stringify({ prompt: 'ppencv1:synthetic-private-field', templateVersion: { templateId: 'usage-studio-a', templateSource: 'studio' } });
  await db.videoStudioRun.createMany({ data: [
    { id: 'usage-run-a', owner_user_id: owner, draft_id: draftId, request_id: 'usage-request-a', request_fingerprint: 'synthetic', source: 'studio', mode: 'direct', snapshot_json: snapshot },
    { id: 'usage-run-preparation', owner_user_id: owner, draft_id: draftId, request_id: 'usage-request-plan', request_fingerprint: 'synthetic', source: 'studio', mode: 'llm', snapshot_json: snapshot },
    { id: 'usage-run-malformed', owner_user_id: owner, draft_id: draftId, request_id: 'usage-request-malformed', request_fingerprint: 'synthetic', source: 'studio', mode: 'direct', snapshot_json: '{broken' },
    { id: 'usage-run-other', owner_user_id: other, draft_id: otherDraft, request_id: 'usage-request-other', request_fingerprint: 'synthetic', source: 'blank', mode: 'direct', snapshot_json: '{}' },
  ] });
  await db.generationTemplate.create({ data: { id: 'usage-legacy', template_key: 'usage-legacy', name: 'Synthetic legacy', created_by: owner } });
  await db.videoTask.createMany({ data: [
    { id: 'usage-video-1', template_studio_run_id: 'usage-run-a' },
    { id: 'usage-video-2', template_studio_run_id: 'usage-run-malformed' },
    { id: 'usage-video-other', template_studio_run_id: 'usage-run-other' },
    { id: 'usage-video-legacy-1', template_id: 'usage-legacy', local_status: 'failed' },
    { id: 'usage-video-legacy-2', template_id: 'usage-legacy' },
  ].map(row => ({ provider: 'synthetic', model: 'synthetic', generation_mode: 'synthetic', prompt: 'synthetic', owner_user_id: owner, user_id: owner, ...row })) });
  const keys = [`image_template:${source}`, `image_module:${moduleId}`, 'image_module:other-private-module',
    'video_template:usage-studio-a', 'video_template:usage-studio-b', `video_draft:${draftId}`, `video_draft:${otherDraft}`, 'legacy_template:usage-legacy'];
  const before = [await db.imageStudioTask.count(), await db.videoTask.count(), await db.videoStudioRun.count()];
  let readQueries = 0;
  const countedDb = { $queryRaw: (query: any) => { readQueries++; return db.$queryRaw(query); } };
  const counts = await templateUsageCounts(countedDb as any, owner, keys);
  assert.equal(readQueries, 1);
  assert.deepEqual(keys.map(key => counts.get(key)), [3, 2, 0, 1, 0, 2, 0, 2]);
  const repeat = await templateUsageCounts(db, owner, keys);
  assert.deepEqual(Array.from(repeat), Array.from(counts));
  assert.deepEqual([await db.imageStudioTask.count(), await db.videoTask.count(), await db.videoStudioRun.count()], before);
  let queries = 0;
  const unavailable = await templateUsageCounts({ $queryRaw: async () => { queries++; throw new Error('synthetic unavailable'); } } as any, owner, keys);
  assert.equal(queries, 1); assert.ok(Array.from(unavailable.values()).every(value => value === null));
  return { sharedBatchDeduplicated: true, privateOwnerIsolation: true, frozenVideoIdentity: true,
    preparationNotCounted: true, malformedSnapshotExcluded: true, hiddenAndFailedUseRetained: true,
    repeatedReadDoesNotWrite: true, oneBatchedQuery: true, unavailableIsNotZero: true };
}
