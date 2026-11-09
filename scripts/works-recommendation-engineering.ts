import assert from 'node:assert/strict';
import type { PrismaClient, Work, WorkMediaVersion, ImageStudioTask, Asset } from '@prisma/client';
import type { SessionUser } from '../src/lib/auth/session';
import { appendRecommendationEvent, enqueueWorkRecommendation, recordRecommendationEvidence, observeWorkDownload,
  recordOriginalAssetTake, bindPendingRecommendationTakes, recordVideoTaskTake, observeVideoTaskDownload } from '../src/lib/works/recommendation-events';
import { processWorkRecommendations } from '../src/lib/works/recommendation-worker';
import { readWorkPage } from '../src/lib/works/query';
import { indexWorkContext } from '../src/lib/works/context-index';
import { workVideoSourceRevision } from '../src/lib/works/source-revision';
import { mutateWorkEditorial, WORK_EDITORIAL_PREFIX } from '../src/lib/works/editorial';

type Image = { work: Work; media: WorkMediaVersion; task: ImageStudioTask; asset: Asset };

/** Runs only in the existing isolated, network-blocked Works engineering database. */
export async function runRecommendationEngineering(db: PrismaClient, owner: SessionUser, colleague: SessionUser, admin: SessionUser,
  createImage: (suffix: string, audience?: 'source' | 'team' | 'project' | 'private', completedAt?: Date, creator?: SessionUser) => Promise<Image>,
  statements: Array<{ query: string; params: string }>) {
  const started = performance.now();
  const feishuOwner: SessionUser = { ...owner, feishu: { user_id: 'fixture-owner', open_id: null, union_id: null,
    tenant_key: 'synthetic-tenant', employee_no: null, department_ids: [], last_sync_at: null } };
  const source = await createImage('rec-real-source'), target = await createImage('rec-real-target', 'team', undefined, admin);
  await db.imageStudioTask.update({ where: { id: target.task.id }, data: {
    reference_ids: JSON.stringify([source.asset.id]), snapshot_json: JSON.stringify({
      referencePolicy: { primaryIds: [source.asset.id] }, primaryReferenceImages: [{ id: source.asset.id }],
    }),
  } });
  await db.$transaction(tx => indexWorkContext(tx, target.work, target.media.id));
  const drain = async () => {
    for (let index = 0; index < 80; index++) {
      await processWorkRecommendations(() => false, db);
      if (!await db.workRecommendationJob.count()) return;
    }
    assert.fail('Recommendation queue did not drain its isolated work');
  };
  // A source seek can need several pages before it reaches this newly indexed target.
  for (let index = 0; index < 20; index++) {
    await processWorkRecommendations(() => false, db);
    if (await db.workRecommendationEvent.findFirst({ where: { work_id: source.work.id, signal: 'input' } })) break;
  }
  const result = (viewer = owner) => db.workRecommendationResult.findUnique({ where: { viewer_id_work_id: { viewer_id: viewer.id, work_id: source.work.id } } });
  await drain();
  assert.equal((await result())?.score, 1, 'A successful frozen primary use by another colleague counts one person');
  await recordRecommendationEvidence(owner, source.work.id, { viewerId: owner.id, mediaVersion: source.media.id, kind: 'copy' });
  await recordRecommendationEvidence(owner, source.work.id, { viewerId: owner.id, mediaVersion: source.media.id, kind: 'copy' });
  await drain();
  assert.equal((await result())?.score, 1, 'Author copies do not change community endorsement');
  await recordRecommendationEvidence(admin, source.work.id, { viewerId: admin.id, mediaVersion: source.media.id, kind: 'copy' });
  await drain();
  assert.equal((await result())?.score, 1); assert.equal((await result())?.qualified, true);
  assert.equal((await result(colleague))?.qualified, true, 'A second internal Feishu user receives a precomputed verdict without a trial ID');
  assert.equal(await db.workRecommendationResult.count({ where: { work_id: source.work.id, viewer_id: 'unapproved' } }), 0);
  const beforeRead = statements.length;
  const page = await readWorkPage(colleague, new URLSearchParams({ scope: 'recommended' }), db);
  assert.ok(page.items.some(work => work.id === source.work.id));
  assert.ok(!JSON.stringify(page).includes('score') && !JSON.stringify(page).includes('evidence_json'));
  assert.ok(!statements.slice(beforeRead).some(row => /\b(?:FROM|JOIN)\s+["`]?WorkRecommendationEvent\b|^\s*(?:INSERT|UPDATE|DELETE)\b/i.test(row.query)), 'A recommendation GET neither replays events nor creates jobs');
  await db.work.update({ where: { id: target.work.id }, data: { withdrawn_at: new Date(), revision: { increment: 1 } } });
  assert.ok(!(await readWorkPage(colleague, new URLSearchParams({ scope: 'recommended' }), db)).items.some(work => work.id === source.work.id), 'Evidence withdrawal blocks the old recommendation immediately, without waiting for scoring');
  assert.deepEqual((await readWorkPage(colleague, new URLSearchParams({ scope: 'recommended', check: source.work.id }), db)).omittedIds, [source.work.id]);
  await enqueueWorkRecommendation(db, source.work.id); await drain();
  assert.equal((await result())?.score, 0); assert.equal((await result())?.qualified, false, 'Downloads alone cannot replace withdrawn successful-use evidence');

  const selected = await createImage('rec-slot-selected'), alternate = await createImage('rec-slot-alternate');
  const first = await createImage('rec-slot-first'), second = await createImage('rec-slot-second'), returned = await createImage('rec-slot-return');
  const purpose = `canvas:${owner.id}:document:node`, base = Date.now() - 30_000;
  const use = (image: Image, output: Image, order: number, signal: 'input' | 'retained' = 'input') => db.$transaction(tx => appendRecommendationEvent(tx, {
    key: `rec-slot-${order}`, work: image.work.id, version: image.media.id, actor: admin.id, purpose, chain: purpose,
    fact: `rec-input-${order}`, slot: 'first', signal, evidence: { id: output.work.id, version: output.media.id }, at: new Date(base + order),
  }));
  await use(selected, first, 1, 'retained'); await drain();
  const selectedState = () => db.workRecommendationResult.findUnique({ where: { viewer_id_work_id: { viewer_id: owner.id, work_id: selected.work.id } } });
  assert.equal((await selectedState())?.score, 1); assert.equal((await selectedState())?.qualified, true);
  await use(alternate, second, 2); await drain();
  assert.equal((await selectedState())?.score, 0); assert.equal((await selectedState())?.qualified, false, 'A confirmed replacement removes that active endorsement');
  await use(selected, returned, 3); await drain();
  assert.equal((await selectedState())?.score, 1); assert.equal((await selectedState())?.qualified, true, 'Successful reselection restores the active endorsement');
  await use(selected, returned, 3); await drain(); assert.equal((await selectedState())?.score, 1);

  const nodeA = await createImage('rec-node-A'), nodeB = await createImage('rec-node-B');
  const document = await db.canvasDocument.create({ data: { owner_user_id: owner.id, project_id: nodeA.work.project_id,
    title: 'Synthetic real input slot', document_json: JSON.stringify({ nodes: [{ id: 'node' }] }) } });
  const album = await db.referenceAlbum.create({ data: { owner_user_id: owner.id, name: 'Synthetic node inputs' } });
  const videoOutcome = async (id: string, input: Image, parent?: string) => {
    const reference = await db.referenceImage.create({ data: { album_id: album.id, owner_user_id: owner.id, asset_id: input.asset.id, url: input.asset.original_url } });
    const completedAt = new Date();
    const task = await db.videoTask.create({ data: { id, provider: 'synthetic', model: 'synthetic', generation_mode: 'image-to-video', prompt: 'Synthetic',
      user_id: owner.id, owner_user_id: owner.id, project_id: nodeA.work.project_id, local_status: 'succeeded', local_video_path: `/videos/${id}.mp4`,
      delivery_completed_at: completedAt, first_frame_url: input.asset.original_url, reference_image_ids: JSON.stringify([reference.id]),
      source_metadata_json: JSON.stringify({ source: 'ultimate_canvas', canvas_document_id: document.id, canvas_node_id: 'node' }), lineage_root_task_id: parent,
    } });
    const policy = await db.workSourcePolicy.create({ data: { source_kind: 'video_task', source_id: task.id, owner_id: owner.id, project_id: nodeA.work.project_id, audience: 'team' } });
    const work = await db.work.create({ data: { source_kind: 'video_task', source_id: task.id, author_id: owner.id, project_id: nodeA.work.project_id,
      medium: 'video', title: 'Synthetic video outcome', audience: 'team', completed_at: completedAt } });
    const media = await db.workMediaVersion.create({ data: { work_id: work.id, source_revision: workVideoSourceRevision(task.local_video_path!, completedAt, task.public_video_file_size), policy_id: policy.id, video_task_id: task.id,
      source_url: task.local_video_path, source_updated_at: completedAt } });
    await db.work.update({ where: { id: work.id }, data: { current_version_id: media.id } });
    await db.$transaction(tx => indexWorkContext(tx, work, media.id));
    return { work, media, task };
  };
  const sourcePass = async (evidenceId: string) => {
    for (let index = 0; index < 30; index++) {
      await processWorkRecommendations(() => false, db);
      if (await db.workRecommendationEvent.findFirst({ where: { evidence_work_id: evidenceId, slot_key: 'first' } })) return;
    }
    assert.fail('Real frozen canvas input was not collected');
  };
  const firstVideo = await videoOutcome('rec-node-video-1', nodeA);
  await sourcePass(firstVideo.work.id); await drain();
  await recordRecommendationEvidence(admin, nodeA.work.id, { viewerId: admin.id, mediaVersion: nodeA.media.id, kind: 'copy' }); await drain();
  const nodeState = () => db.workRecommendationResult.findUnique({ where: { viewer_id_work_id: { viewer_id: owner.id, work_id: nodeA.work.id } } });
  assert.equal((await nodeState())?.score, 0);
  const swappedVideo = await videoOutcome('rec-node-video-2', nodeB);
  await sourcePass(swappedVideo.work.id); await drain();
  assert.equal((await nodeState())?.score, 0, 'The author canvas workflow remains recorded but is not a community vote');
  const reselectedVideo = await videoOutcome('rec-node-video-3', nodeA);
  await sourcePass(reselectedVideo.work.id); await drain();
  assert.equal((await nodeState())?.score, 0);
  await db.$transaction(tx => appendRecommendationEvent(tx, { key: 'rec-node-ambiguous-use', work: nodeA.work.id, version: nodeA.media.id,
    actor: owner.id, purpose: `actor:${owner.id}`, chain: `actor:${owner.id}`, fact: 'rec-node-ambiguous-use', signal: 'input',
    evidence: { id: returned.work.id, version: returned.media.id }, at: new Date() })); await drain();
  assert.equal((await nodeState())?.score, 0, 'Moving author workflows does not invent another supporter');

  const purposeVersion = `actor:${owner.id}`;
  const versionUse = async (entry: Awaited<ReturnType<typeof videoOutcome>>, proof: Image, key: string) => db.$transaction(tx => appendRecommendationEvent(tx, {
    key, work: entry.work.id, version: entry.media.id, actor: admin.id, purpose: purposeVersion, chain: purposeVersion,
    fact: key, signal: 'retained', evidence: { id: proof.work.id, version: proof.media.id }, at: new Date(),
  }));
  await versionUse(firstVideo, first, 'rec-version-old'); await drain();
  const nextVersion = await videoOutcome('rec-node-video-version', nodeA, firstVideo.task.id);
  await sourcePass(nextVersion.work.id); await versionUse(nextVersion, second, 'rec-version-new'); await drain();
  const oldVersionState = await db.workRecommendationResult.findUnique({ where: { viewer_id_work_id: { viewer_id: owner.id, work_id: firstVideo.work.id } } });
  assert.equal(oldVersionState?.score, 0); assert.equal(oldVersionState?.qualified, false, 'A superseded use does not retain an old community qualification');
  await recordVideoTaskTake(feishuOwner, firstVideo.task.id, firstVideo.media.source_revision, false);
  assert.equal(await db.workRecommendationEvent.count({ where: { work_id: firstVideo.work.id, signal: 'take-intent' } }), 1);
  assert.equal(await db.workRecommendationEvent.count({ where: { work_id: firstVideo.work.id, signal: 'take' } }), 0, 'A native video redirect is not a completed download');
  await observeVideoTaskDownload(new Request('https://fixture.invalid/video-download'), new Response(new Uint8Array([1, 2, 3, 4]), {
    headers: { 'Content-Length': '4', 'Content-Type': 'video/mp4' },
  }), feishuOwner, firstVideo.task.id, firstVideo.media.source_revision).arrayBuffer();
  const videoTransferDeadline = Date.now() + 2000;
  while (!await db.workRecommendationEvent.count({ where: { work_id: firstVideo.work.id, signal: 'take' } }) && Date.now() < videoTransferDeadline)
    await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(await db.workRecommendationEvent.count({ where: { work_id: firstVideo.work.id, signal: 'take' } }), 1);

  // A single complete native stream counts once; HEAD/ranges/truncation and cancel do not.
  const transfer = await createImage('rec-transfer');
  const request = new Request('https://fixture.invalid/single-download');
  const headers = { 'Content-Length': '4', 'Content-Type': 'image/png' };
  await observeWorkDownload(request, new Response(new Uint8Array([1, 2]), { headers }), owner, transfer.work.id, transfer.media.id).arrayBuffer();
  await observeWorkDownload(new Request(request, { method: 'HEAD' }), new Response(null, { headers }), owner, transfer.work.id, transfer.media.id).arrayBuffer();
  assert.equal(await db.workRecommendationEvent.count({ where: { work_id: transfer.work.id } }), 0);
  await observeWorkDownload(request, new Response(new Uint8Array([1, 2, 3, 4]), { headers }), owner, transfer.work.id, transfer.media.id).arrayBuffer();
  const transferDeadline = Date.now() + 2000;
  while (!await db.workRecommendationEvent.count({ where: { work_id: transfer.work.id } }) && Date.now() < transferDeadline)
    await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(await db.workRecommendationEvent.count({ where: { work_id: transfer.work.id, signal: 'take' } }), 1);
  await recordRecommendationEvidence(owner, transfer.work.id, { viewerId: owner.id, mediaVersion: transfer.media.id, kind: 'copy' });
  assert.equal(await db.workRecommendationEvent.count({ where: { work_id: transfer.work.id, signal: 'take' } }), 1, 'Copy and completed download use one durable deduplication key');

  const earlyAsset = await db.asset.create({ data: { ...source.asset, id: 'rec-early-asset', hash: 'e'.repeat(64),
    original_url: '/uploads/rec-early.png', thumbnail_url: '/uploads/rec-early.webp' } });
  const earlyTask = await db.imageStudioTask.create({ data: { ...source.task, id: 'rec-early-task', batch_id: 'rec-early-batch',
    fingerprint: 'rec-early', asset_id: earlyAsset.id } });
  await recordOriginalAssetTake(feishuOwner, earlyAsset.id);
  assert.equal(await db.work.count({ where: { source_kind: 'image_task', source_id: earlyTask.id } }), 0, 'An evidence callback cannot publish or admit an output');
  assert.equal(await db.workRecommendationEvent.count({ where: { work_id: `asset:${earlyAsset.id}`, signal: 'take' } }), 1);
  const earlyWork = await db.work.create({ data: { source_kind: 'image_task', source_id: earlyTask.id, author_id: owner.id, title: 'Early output', medium: 'image', completed_at: earlyTask.finished_at! } });
  const earlyMedia = await db.workMediaVersion.create({ data: { work_id: earlyWork.id, source_revision: 'rec-early-v1', asset_id: earlyAsset.id,
    source_url: earlyAsset.original_url, source_updated_at: earlyTask.finished_at, content_hash: earlyAsset.hash } });
  const early = { work: earlyWork, media: earlyMedia };
  await db.work.update({ where: { id: early.work.id }, data: { current_version_id: early.media.id } });
  await bindPendingRecommendationTakes(db);
  assert.equal(await db.workRecommendationEvent.count({ where: { work_id: early.work.id, signal: 'take' } }), 1);

  const earlyVideoStamp = new Date();
  const earlyVideo = await db.videoTask.create({ data: { ...firstVideo.task, id: 'rec-early-video-task', local_video_path: '/videos/rec-early-video.mp4',
    source_metadata_json: null, reference_image_ids: null, first_frame_url: null, delivery_completed_at: earlyVideoStamp } });
  const earlyVideoRevision = workVideoSourceRevision(earlyVideo.local_video_path!, earlyVideoStamp, earlyVideo.public_video_file_size);
  await recordVideoTaskTake(feishuOwner, earlyVideo.id, earlyVideoRevision, true);
  assert.equal(await db.workRecommendationEvent.count({ where: { work_id: `video:${earlyVideo.id}`, signal: 'take' } }), 1);
  assert.equal(await db.work.count({ where: { source_kind: 'video_task', source_id: earlyVideo.id } }), 0);
  const admittedVideo = await db.work.create({ data: { source_kind: 'video_task', source_id: earlyVideo.id, author_id: owner.id,
    project_id: earlyVideo.project_id, title: 'Admitted early video', medium: 'video', completed_at: earlyVideoStamp } });
  const admittedVideoMedia = await db.workMediaVersion.create({ data: { work_id: admittedVideo.id, source_revision: earlyVideoRevision,
    video_task_id: earlyVideo.id, source_url: earlyVideo.local_video_path, source_updated_at: earlyVideoStamp } });
  await db.work.update({ where: { id: admittedVideo.id }, data: { current_version_id: admittedVideoMedia.id } });
  await bindPendingRecommendationTakes(db);
  assert.equal(await db.workRecommendationEvent.count({ where: { work_id: admittedVideo.id, signal: 'take' } }), 1);

  const pause = await db.platformSetting.create({ data: { key: 'works-recommendation:v1', value_json: 'false' } });
  await enqueueWorkRecommendation(db, early.work.id);
  const queued = await db.workRecommendationJob.findUnique({ where: { work_id: early.work.id } });
  await processWorkRecommendations(() => false, db);
  assert.deepEqual(await db.workRecommendationJob.findUnique({ where: { work_id: early.work.id } }), queued);
  await db.platformSetting.delete({ where: { id: pause.id } }); await drain();

  const historical = await createImage('rec-trusted-history'), historyAlternate = await createImage('rec-trusted-alternate');
  const historyPurpose = `canvas:${owner.id}:history:node`;
  await db.$transaction(tx => appendRecommendationEvent(tx, { key: 'rec-history-entry', work: historical.work.id, version: historical.media.id,
    actor: admin.id, purpose: historyPurpose, chain: historyPurpose, fact: 'rec-history-entry', slot: 'first', signal: 'retained',
    evidence: { id: first.work.id, version: first.media.id }, at: new Date(Date.now() - 1000) })); await drain();
  const historyState = () => db.workRecommendationResult.findUnique({ where: { viewer_id_work_id: { viewer_id: owner.id, work_id: historical.work.id } } });
  const admittedAt = (await historyState())!.history_from!; assert.ok(admittedAt);
  while (Date.now() <= admittedAt.getTime() + 3) await new Promise(resolve => setImmediate(resolve));
  await db.$transaction(tx => appendRecommendationEvent(tx, { key: 'rec-history-loss', work: historyAlternate.work.id, version: historyAlternate.media.id,
    actor: admin.id, purpose: historyPurpose, chain: historyPurpose, fact: 'rec-history-loss', slot: 'first', signal: 'input',
    evidence: { id: second.work.id, version: second.media.id }, at: new Date() })); await drain();
  assert.equal((await historyState())?.score, 0); assert.equal((await historyState())?.qualified, false);
  for (let index = 0; index < 2; index++) await db.$transaction(tx => appendRecommendationEvent(tx, {
    key: `rec-history-late-${index}`, work: historical.work.id, version: historical.media.id, actor: owner.id, purpose: `actor:${owner.id}`,
    chain: `history-comparison-${index}`, fact: `history-comparison-${index}`, signal: 'revisit', at: new Date(admittedAt.getTime() + 1),
  })); await drain();
  assert.equal((await historyState())?.score, 0); assert.equal((await historyState())?.qualified, false,
    'Late revisits cannot revive a replaced community endorsement');

  const privateSource = await createImage('rec-private-evidence-source'), privateTarget = await createImage('rec-private-evidence-target', 'private', undefined, admin);
  await db.$transaction(tx => appendRecommendationEvent(tx, { key: 'rec-private-use', work: privateSource.work.id, version: privateSource.media.id,
    actor: admin.id, purpose: `actor:${admin.id}`, chain: `actor:${admin.id}`, fact: 'rec-private-use', signal: 'input',
    evidence: { id: privateTarget.work.id, version: privateTarget.media.id }, at: new Date() }));
  await recordRecommendationEvidence(admin, privateSource.work.id, { viewerId: admin.id, mediaVersion: privateSource.media.id, kind: 'copy' });
  await drain();
  const privateState = (viewer: SessionUser) => db.workRecommendationResult.findUnique({ where: { viewer_id_work_id: { viewer_id: viewer.id, work_id: privateSource.work.id } } });
  assert.equal((await privateState(admin))?.score, 1); assert.equal((await privateState(admin))?.qualified, true);
  assert.equal((await privateState(colleague))?.score, 0); assert.equal((await privateState(colleague))?.qualified, false, 'A colleague cannot inherit private usage evidence');

  const variantA = await createImage('rec-group-variant-A'), variantB = await createImage('rec-group-variant-B');
  for (const image of [variantA, variantB]) {
    await db.workContext.create({ data: { work_id: image.work.id, media_version_id: image.media.id, submission_key: 'rec-exact-batch' } });
    await db.$transaction(tx => appendRecommendationEvent(tx, { key: `rec-group-use-${image.work.id}`, work: image.work.id, version: image.media.id,
      actor: admin.id, purpose: `group:${image.work.id}`, chain: 'input', fact: 'input', signal: 'input',
      evidence: { id: returned.work.id, version: returned.media.id }, at: new Date() }));
  }
  await drain();
  assert.equal((await readWorkPage(colleague, new URLSearchParams({ scope: 'recommended', q: 'rec-group-variant' }), db)).items.length, 1);
  assert.deepEqual((await readWorkPage(colleague, new URLSearchParams({ scope: 'recommended', q: 'rec-group-variant-A' }), db)).items.map(work => work.id), [variantA.work.id], 'Filtering happens before selecting the group representative');
  const later = await createImage('rec-late-qualification');
  const beforeQualification = await readWorkPage(owner, new URLSearchParams({ scope: 'recommended', q: 'rec-late-qualification' }), db);
  const lateProof = await createImage('rec-late-proof', 'team', undefined, admin);
  await db.$transaction(tx => appendRecommendationEvent(tx, { key: 'rec-late-proof', work: later.work.id, version: later.media.id,
    actor: admin.id, purpose: 'late', chain: 'late', fact: 'late', signal: 'input', evidence: { id: lateProof.work.id, version: lateProof.media.id }, at: new Date() }));
  await drain();
  assert.equal((await readWorkPage(owner, new URLSearchParams({ scope: 'recommended', q: 'rec-late-qualification', window: beforeQualification.window }), db)).items.length, 0);
  assert.equal((await readWorkPage(owner, new URLSearchParams({ scope: 'recommended', q: 'rec-late-qualification' }), db)).items.length, 1, 'New qualification enters on refresh, not halfway through an older browse window');
  const recommendedFirst = await readWorkPage(colleague, new URLSearchParams({ scope: 'recommended', limit: '2' }), db);
  assert.ok(recommendedFirst.nextCursor);
  const recommendedNext = await readWorkPage(colleague, new URLSearchParams({ scope: 'recommended', limit: '2', after: recommendedFirst.nextCursor!, window: recommendedFirst.window }), db);
  assert.ok(recommendedNext.items.length && recommendedNext.items.every(work => !recommendedFirst.items.some(first => first.id === work.id)));
  const recommendedBack = await readWorkPage(colleague, new URLSearchParams({ scope: 'recommended', limit: '2', before: recommendedNext.previousCursor!, window: recommendedFirst.window }), db);
  assert.deepEqual(recommendedBack.items.map(work => work.id), recommendedFirst.items.map(work => work.id));

  const selectedWork = await createImage('rec-editorial-feature');
  const featureInput = { viewerId: admin.id, requestId: 'rec-editorial-feature', action: 'feature' as const,
    active: true, expectedVersion: 0, expectedMediaVersion: selectedWork.media.id };
  await assert.rejects(mutateWorkEditorial(owner, selectedWork.work.id, { ...featureInput, viewerId: owner.id }), error => (error as { status: number }).status === 403);
  const featured = await mutateWorkEditorial(admin, selectedWork.work.id, featureInput);
  assert.deepEqual(await mutateWorkEditorial(admin, selectedWork.work.id, featureInput), featured, 'An uncertain retry replays the same editorial receipt');
  assert.equal(await db.workOperation.count({ where: { owner_id: admin.id, request_id: featureInput.requestId } }), 1);
  await assert.rejects(mutateWorkEditorial(admin, selectedWork.work.id, { ...featureInput, requestId: 'rec-editorial-conflict', active: false }), error => (error as { status: number }).status === 409);
  const selectedPage = await readWorkPage(colleague, new URLSearchParams({ scope: 'recommended', q: 'rec-editorial-feature' }), db);
  assert.equal(selectedPage.items[0]?.editorial?.featured, true);
  assert.equal(selectedPage.items[0]?.editorial?.canFeature, false);
  assert.equal(selectedPage.items[0]?.reuse, null, 'Selecting a preview-only work grants no original/reference permission');
  assert.equal((await db.work.findUniqueOrThrow({ where: { id: selectedWork.work.id } })).audience, 'team');
  await mutateWorkEditorial(admin, selectedWork.work.id, { ...featureInput, requestId: 'rec-editorial-remove', expectedVersion: 1, active: false });
  assert.equal((await readWorkPage(colleague, new URLSearchParams({ scope: 'recommended', q: 'rec-editorial-feature' }), db)).items.length, 0);

  const nominee = await createImage('rec-new-nominee');
  const nomination = { viewerId: owner.id, requestId: 'rec-nominee-create', action: 'nominate' as const,
    active: true, expectedVersion: 0, expectedMediaVersion: nominee.media.id };
  await assert.rejects(mutateWorkEditorial(colleague, nominee.work.id, { ...nomination, viewerId: colleague.id }), error => (error as { status: number }).status === 403);
  await mutateWorkEditorial(owner, nominee.work.id, nomination);
  for (let index = 0; index < 5; index++) {
    const image = await createImage(`rec-new-batch-${index}`);
    await db.workContext.create({ data: { work_id: image.work.id, media_version_id: image.media.id, submission_key: 'rec-nomination-batch' } });
    await mutateWorkEditorial(owner, image.work.id, { ...nomination, requestId: `rec-nominee-batch-${index}`, expectedMediaVersion: image.media.id });
  }
  const discovery = await readWorkPage(colleague, new URLSearchParams({ scope: 'discoveries' }), db);
  assert.ok(discovery.items.length > 0 && discovery.items.length <= 4);
  assert.equal(new Set(discovery.items.map(work => work.author.id)).size, discovery.items.length, 'One author cannot fill the new-work shelf');
  const privateNominee = await createImage('rec-new-private', 'private');
  await mutateWorkEditorial(owner, privateNominee.work.id, { ...nomination, requestId: 'rec-nominee-private', expectedMediaVersion: privateNominee.media.id });
  assert.equal((await readWorkPage(colleague, new URLSearchParams({ scope: 'discoveries', q: 'rec-new-private' }), db)).items.length, 0);
  const nominationRow = await db.platformSetting.findUniqueOrThrow({ where: { key: WORK_EDITORIAL_PREFIX + nominee.work.id } });
  const aged = { ...JSON.parse(nominationRow.value_json), nominatedAt: Date.now() - 8 * 86400000 };
  await db.platformSetting.update({ where: { id: nominationRow.id }, data: { value_json: JSON.stringify(aged) } });
  assert.equal((await readWorkPage(colleague, new URLSearchParams({ scope: 'discoveries', q: 'rec-new-nominee' }), db)).items.length, 0);
  await mutateWorkEditorial(owner, nominee.work.id, { ...nomination, requestId: 'rec-nominee-off', active: false, expectedVersion: 1 });
  await assert.rejects(mutateWorkEditorial(owner, nominee.work.id, { ...nomination, requestId: 'rec-nominee-on', expectedVersion: 2 }), error => (error as { code: string }).code === 'WORKS_NOMINATION_EXPIRED');
  assert.equal((await readWorkPage(colleague, new URLSearchParams({ scope: 'discoveries', q: 'rec-new-nominee' }), db)).items.length, 0, 'Toggling nomination cannot restart an expired exposure window');

  // Reproduce the observed catalog/user scale without any providers, browser or production data.
  await db.user.createMany({ data: Array.from({ length: 26 }, (_, index) => ({ id: `rec-new-colleague-${index}`, name: 'Synthetic colleague', username: `rec-new-${index}`,
    email: `rec-new-${index}@example.invalid`, password_hash: 'synthetic-not-a-credential', account_type: 'internal', role: 'user', feishu_user_id: `rec-feishu-${index}`, feishu_tenant_key: 'synthetic-tenant' })) });
  const missing = 2827 - await db.work.count();
  if (missing > 0) await db.$executeRaw`WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM n WHERE value<${missing})
    INSERT INTO Work(id,source_kind,source_id,author_id,title,medium,audience,discoverable,completed_at,created_at,updated_at)
    SELECT 'rec-scale-'||value,'upload_asset','rec-scale-asset-'||value,${owner.id},'Synthetic catalog','image','source',0,${new Date()},${new Date()},${new Date()} FROM n`;
  await db.workDiscoveryCheckpoint.updateMany({ where: { source_kind: 'recommendation-repair:v1' }, data: { cursor_id: null, updated_at: new Date(Date.now() - 61_000) } });
  await drain();
  assert.ok(await db.workRecommendationResult.count({ where: { viewer_id: 'rec-new-colleague-0' } }), 'New Feishu colleagues are prepared in the background without opening a page');
  const firstLowState = await db.workRecommendationResult.findUnique({ where: { viewer_id_work_id: { viewer_id: 'rec-new-colleague-0', work_id: firstVideo.work.id } } });
  assert.equal(firstLowState?.score, 0); assert.equal(firstLowState?.qualified, false, 'An old historical score cannot invent a current active colleague endorsement');
  const readStarted = performance.now(), statementStart = statements.length;
  await readWorkPage(colleague, new URLSearchParams({ scope: 'recommended' }), db);
  const readMs = Math.round(performance.now() - readStarted);
  assert.ok(!statements.slice(statementStart).some(row => /\b(?:FROM|JOIN)\s+["`]?WorkRecommendationEvent\b/i.test(row.query)));
  return { elapsedMs: Math.round(performance.now() - started), realFrozenInput: true, positiveAndNegative: true,
    multiFeishuAudience: true, duplicateAndReselection: true, immediateAclGate: true, pageOpenScoring: false,
    nativeStreamNoFullBuffer: true, earlyEvidencePreservedWithoutAdmission: true, pauseResume: true,
    privateEvidenceSeparated: true, filteredGroupRepresentative: true, stableQualificationWindow: true,
    editorialAuthorityAndReceipt: true, nominationDoesNotExpandAudience: true, limitedDiscoveryAndNoToggleBump: true,
    scale: { catalog: await db.work.count(), eligibleAudience: 29, recommendationReadMs: readMs } };
}
