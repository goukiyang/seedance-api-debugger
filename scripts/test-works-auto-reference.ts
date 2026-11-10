import assert from 'node:assert/strict';
import { Prisma, type PrismaClient, type Work, type WorkMediaVersion, type ImageStudioTask, type Asset } from '@prisma/client';
import type { SessionUser } from '../src/lib/auth/session';
import { bindWorkMethodOrigin, freezeImageWorkMethodUse, freezeWorkMethodUse, workMethodOriginKey, workMethodUseKey } from '../src/lib/works/method-reference';
import { ensureAutomaticWorkDiscovery, mutateWorkEditorial, WORK_EDITORIAL_PREFIX,
  WORK_AUTOMATIC_DISCOVERY_PREFIX, workAutomaticDiscoveryKey, workEditorialCte } from '../src/lib/works/editorial';
import { indexWorkContext } from '../src/lib/works/context-index';
import { collectRecommendationSourcePass } from '../src/lib/works/recommendation-sources';
import { processWorkRecommendations } from '../src/lib/works/recommendation-worker';
import { readWorkPage } from '../src/lib/works/query';
import { workVideoSourceRevision } from '../src/lib/works/source-revision';

type Image = { work: Work; media: WorkMediaVersion; task: ImageStudioTask; asset: Asset };

/** Extends the existing isolated, network-denied Works fixture. No real account or task is touched. */
export async function runAutoReferenceEngineering(db: PrismaClient, owner: SessionUser, colleague: SessionUser,
  createImage: (suffix: string, audience?: 'source' | 'team' | 'project' | 'private', completedAt?: Date, creator?: SessionUser) => Promise<Image>) {
  const fresh = await createImage('auto-exposure'), secret = await createImage('auto-exposure-secret', 'private');
  const old = await createImage('auto-exposure-old', 'team', new Date(Date.now() - 8 * 86400000));
  await readWorkPage(colleague, new URLSearchParams({ scope: 'discoveries', q: 'auto-exposure' }), db);
  assert.equal(await db.platformSetting.count({ where: { key: workAutomaticDiscoveryKey(fresh.work) } }), 0,
    'Opening the page must not prepare exposure state');
  for (const item of [fresh, secret, old]) await ensureAutomaticWorkDiscovery(db, { ...item.work, current_version_id: item.media.id });
  assert.equal(await db.platformSetting.count({ where: { key: workAutomaticDiscoveryKey(old.work) } }), 0);
  const discoveries = await readWorkPage(colleague, new URLSearchParams({ scope: 'discoveries', q: 'auto-exposure' }), db);
  assert.deepEqual(discoveries.items.map(item => item.id), [fresh.work.id], 'Automatic exposure preserves the private source boundary');
  const automatic = await db.platformSetting.findUniqueOrThrow({ where: { key: workAutomaticDiscoveryKey(fresh.work) } });
  assert.equal(JSON.parse(automatic.value_json).nominatedAt, fresh.work.completed_at.getTime(), 'Repair cannot reset a work to brand new');
  await mutateWorkEditorial(owner, fresh.work.id, { viewerId: owner.id, requestId: 'auto-exposure-withdrawal',
    action: 'nominate', active: false, expectedVersion: 0, expectedMediaVersion: fresh.media.id });
  await ensureAutomaticWorkDiscovery(db, { ...fresh.work, current_version_id: fresh.media.id });
  assert.equal(JSON.parse((await db.platformSetting.findUniqueOrThrow({ where: { key: WORK_EDITORIAL_PREFIX + fresh.work.id } })).value_json).nominated, false);
  assert.equal((await readWorkPage(colleague, new URLSearchParams({ scope: 'discoveries', q: 'auto-exposure' }), db)).items.length, 0);
  const pending = await createImage('automatic-preview-late');
  await db.workMediaVersion.update({ where: { id: pending.media.id }, data: { preview_status: 'pending' } });
  await ensureAutomaticWorkDiscovery(db, { ...pending.work, current_version_id: pending.media.id });
  assert.equal(await db.platformSetting.count({ where: { key: workAutomaticDiscoveryKey(pending.work) } }), 0);
  await db.workMediaVersion.update({ where: { id: pending.media.id }, data: { preview_status: 'ready' } });
  await ensureAutomaticWorkDiscovery(db, { ...pending.work, current_version_id: pending.media.id });
  assert.equal(await db.platformSetting.count({ where: { key: workAutomaticDiscoveryKey(pending.work) } }), 1);
  await db.$executeRaw(Prisma.sql`WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM n WHERE value<5000)
    INSERT INTO PlatformSetting(id,key,value_json,created_at,updated_at)
    SELECT 'synthetic-expired-auto-'||value,${WORK_AUTOMATIC_DISCOVERY_PREFIX + '2020-01-01T00:00:00.000Z:old-'}||value,
      ${automatic.value_json},${new Date()},${new Date()} FROM n`);
  const plan = await db.$queryRaw<Array<{ detail: string }>>(Prisma.sql`EXPLAIN QUERY PLAN
    WITH ${workEditorialCte(new Date(), true)} SELECT work_id FROM editorial`);
  assert.ok(plan.filter(row => /SEARCH PlatformSetting.*key>\? AND key<\?/.test(row.detail)).length >= 2,
    'Both explicit and recent automatic admissions must use indexed key ranges');
  assert.ok(!plan.some(row => /SCAN PlatformSetting/.test(row.detail)), 'Expired automatic history must not become a full settings scan');
  const afterHistory = await readWorkPage(colleague, new URLSearchParams({ scope: 'discoveries', q: 'automatic-preview-late' }), db);
  assert.deepEqual(afterHistory.items.map(item => item.id), [pending.work.id]);

  const source = await createImage('method-learning-source'), output = await createImage('method-learning-output', 'team', undefined, colleague);
  const origin = { ownerId: colleague.id, kind: 'image' as const, scopeId: 'synthetic-method-workspace', workId: source.work.id,
    mediaVersion: source.media.id, templateId: 'synthetic-learning-template', templateVersion: 'v1', templateToken: 'synthetic-definition-token' };
  await bindWorkMethodOrigin(db, origin);
  const task = await db.imageStudioTask.update({ where: { id: output.task.id }, data: { module_id: origin.scopeId,
    source_preset_id: origin.templateId, reference_ids: '[]', snapshot_json: JSON.stringify({ sourcePresetId: origin.templateId,
      sharedSourceRevision: origin.templateVersion, sharedLive: { definitionToken: origin.templateToken } }) } });
  await assert.rejects(db.$transaction(async tx => { await freezeImageWorkMethodUse(tx, task); throw new Error('synthetic rollback'); }), /synthetic rollback/);
  assert.equal(await db.platformSetting.count({ where: { key: workMethodUseKey('image', task.batch_id) } }), 0);
  await db.$transaction(tx => freezeImageWorkMethodUse(tx, task));
  assert.equal(await db.workRecommendationEvent.count({ where: { work_id: source.work.id, signal: 'method' } }), 0,
    'Clicking or accepting is not yet a successful adoption');
  await db.$transaction(tx => indexWorkContext(tx, output.work, output.media.id));
  const collect = async () => {
    for (let index = 0; index < 60; index++) {
      await collectRecommendationSourcePass(() => false, db);
      await processWorkRecommendations(() => false, db);
      if (await db.workRecommendationResult.findFirst({ where: { viewer_id: colleague.id, work_id: source.work.id, qualified: true } })) return;
    }
    assert.fail('Successful method use did not reach the precomputed recommendation result');
  };
  await collect();
  assert.equal(await db.workRecommendationEvent.count({ where: { work_id: source.work.id, signal: 'method' } }), 1);
  assert.equal((await db.workRecommendationResult.findUniqueOrThrow({ where: { viewer_id_work_id: { viewer_id: colleague.id, work_id: source.work.id } } })).score, 1);
  await collectRecommendationSourcePass(() => false, db);
  assert.equal(await db.workRecommendationEvent.count({ where: { work_id: source.work.id, signal: 'method' } }), 1, 'Background replay deduplicates an adoption');
  const later = { ...task, batch_id: 'unrelated-later-batch' };
  await db.$transaction(tx => freezeImageWorkMethodUse(tx, later));
  assert.equal(await db.platformSetting.count({ where: { key: workMethodUseKey('image', later.batch_id) } }), 0, 'A successful first use does not credit later unrelated generations');

  const retryOrigin = { ...origin, scopeId: 'synthetic-retry-workspace' };
  await bindWorkMethodOrigin(db, retryOrigin);
  const failed = await db.imageStudioTask.create({ data: { ...task, id: 'synthetic-reference-failed', module_id: retryOrigin.scopeId,
    batch_id: 'synthetic-reference-failed-batch', asset_id: null, status: 'uncertain' } });
  await db.$transaction(tx => freezeImageWorkMethodUse(tx, failed));
  const retry = { ...failed, batch_id: 'synthetic-reference-retry-batch' };
  await db.$transaction(tx => freezeImageWorkMethodUse(tx, retry));
  assert.equal(await db.platformSetting.count({ where: { key: workMethodUseKey('image', retry.batch_id) } }), 0);
  await db.imageStudioTask.update({ where: { id: failed.id }, data: { status: 'failed' } });
  await db.$transaction(tx => freezeImageWorkMethodUse(tx, retry));
  assert.equal(await db.platformSetting.count({ where: { key: workMethodUseKey('image', retry.batch_id) } }), 1, 'A known unsuccessful attempt can retry without another reference click');
  const before = (await db.platformSetting.findUniqueOrThrow({ where: { key: workMethodOriginKey('image', retryOrigin.scopeId) } })).value_json;
  await freezeWorkMethodUse(db, { ownerId: owner.id, kind: 'image', scopeId: retryOrigin.scopeId, requestId: 'wrong-actor',
    templateId: origin.templateId, templateVersion: origin.templateVersion, templateToken: origin.templateToken });
  assert.equal((await db.platformSetting.findUniqueOrThrow({ where: { key: workMethodOriginKey('image', retryOrigin.scopeId) } })).value_json, before);
  const parentOrigin = { ...origin, scopeId: 'synthetic-parent-workspace' };
  await bindWorkMethodOrigin(db, parentOrigin);
  await db.$transaction(async tx => {
    await freezeImageWorkMethodUse(tx, { ...task, module_id: parentOrigin.scopeId, batch_id: 'synthetic-child-a' }, 'synthetic-parent-batch');
    await freezeImageWorkMethodUse(tx, { ...task, module_id: parentOrigin.scopeId, batch_id: 'synthetic-child-b' }, 'synthetic-parent-batch');
  });
  assert.equal(await db.platformSetting.count({ where: { key: { in: [workMethodUseKey('image', 'synthetic-child-a'), workMethodUseKey('image', 'synthetic-child-b')] } } }), 2);
  const changedOrigin = { ...origin, scopeId: 'synthetic-changed-template' };
  await bindWorkMethodOrigin(db, changedOrigin);
  await freezeWorkMethodUse(db, { ownerId: colleague.id, kind: 'image', scopeId: changedOrigin.scopeId, requestId: 'changed-template-request',
    templateId: origin.templateId, templateVersion: origin.templateVersion, templateToken: 'different-definition' });
  assert.equal(await db.platformSetting.count({ where: { key: workMethodUseKey('image', 'changed-template-request') } }), 0);

  const videoOrigin = { ...origin, kind: 'video' as const, scopeId: 'synthetic-video-method-draft', templateToken: null };
  await bindWorkMethodOrigin(db, videoOrigin);
  const completedAt = new Date();
  const video = await db.videoTask.create({ data: { id: 'synthetic-method-video-output', provider: 'synthetic', model: 'synthetic', generation_mode: 'text-to-video',
    prompt: 'Synthetic', user_id: colleague.id, owner_user_id: colleague.id, project_id: output.work.project_id, local_status: 'succeeded',
    local_video_path: '/videos/synthetic-method-output.mp4', delivery_completed_at: completedAt,
    template_studio_snapshot_json: JSON.stringify({ sourceSnapshot: { templateVersion: { templateSource: 'studio',
      templateId: origin.templateId, sourceRevision: origin.templateVersion } } }) } });
  const policy = await db.workSourcePolicy.create({ data: { source_kind: 'video_task', source_id: video.id,
    owner_id: colleague.id, project_id: output.work.project_id, audience: 'team' } });
  const videoWork = await db.work.create({ data: { source_kind: 'video_task', source_id: video.id, author_id: colleague.id,
    project_id: output.work.project_id, medium: 'video', title: 'Synthetic method video', audience: 'team', completed_at: completedAt } });
  const videoMedia = await db.workMediaVersion.create({ data: { work_id: videoWork.id,
    source_revision: workVideoSourceRevision(video.local_video_path!, completedAt, video.public_video_file_size), policy_id: policy.id,
    video_task_id: video.id, source_url: video.local_video_path, source_updated_at: completedAt } });
  await db.work.update({ where: { id: videoWork.id }, data: { current_version_id: videoMedia.id } });
  await db.$transaction(async tx => {
    await freezeWorkMethodUse(tx, { ownerId: colleague.id, kind: 'video', scopeId: videoOrigin.scopeId,
      requestId: video.id, templateId: origin.templateId, templateVersion: origin.templateVersion });
    await indexWorkContext(tx, videoWork, videoMedia.id);
  });
  for (let index = 0; index < 40; index++) {
    await collectRecommendationSourcePass(() => false, db);
    if (await db.workRecommendationEvent.findFirst({ where: { evidence_work_id: videoWork.id, signal: 'method' } })) break;
  }
  assert.equal(await db.workRecommendationEvent.count({ where: { evidence_work_id: videoWork.id, signal: 'method' } }), 1,
    'A real successful video, rather than a prompt-only run, supplies method evidence');
  for (let index = 0; index < 40; index++) {
    await processWorkRecommendations(() => false, db);
    const result = await db.workRecommendationResult.findUnique({ where: { viewer_id_work_id: { viewer_id: colleague.id, work_id: source.work.id } } });
    if (result?.evidence_json.includes(videoWork.id)) { assert.equal(result.score, 1); break; }
    if (index === 39) assert.fail('Video method evidence was not included in background evaluation');
  }
  const visible = await readWorkPage(colleague, new URLSearchParams({ scope: 'recommended', q: 'method-learning-source' }), db);
  assert.ok(visible.items.some(item => item.id === source.work.id));
  assert.equal(visible.items[0].reuse, null, 'A learning endorsement grants no original-image use permission');
  await db.work.update({ where: { id: source.work.id }, data: { withdrawn_at: new Date() } });
  assert.equal((await readWorkPage(colleague, new URLSearchParams({ scope: 'recommended', q: 'method-learning-source' }), db)).items.length, 0);
  return { automaticExposure: true, completionTimePreserved: true, withdrawalPreserved: true, sourceAclPreserved: true,
    atomicClaimRollback: true, imageAndVideoSuccessfulMethodUse: true, sameActorCountedOnce: true,
    noOriginalInputRequired: true, unknownRequestNotReassigned: true, failedRetryWithoutExtraClick: true, laterUnrelatedRequestExcluded: true,
    preparedParentChildrenPreserved: true, changedTemplateNotAttributed: true, readyCoversOnly: true, pageOpenPrecomputation: false,
    expiredHistoryUsesKeyRange: true };
}
