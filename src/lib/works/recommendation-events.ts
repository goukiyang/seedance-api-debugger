import 'server-only';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { SessionUser } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { getWorkAccess } from './access';
import { assertWorkId } from './interactions';
import { assertWorkViewer } from './operations';
import { WorkError } from './types';
import { canUseWorksPreview } from './rollout.server';
import { canReadStudioAsset } from '@/lib/image-studio/protected-assets';
import { studioOutputTaskWhere } from '@/lib/image-studio/dimension-mismatch';
import { assertCanViewTask } from '@/lib/projects/permissions';
import { workVideoSourceRevision } from './source-revision';

export type RecommendationEvent = {
  key: string; work: string; version: string; actor: string; purpose: string; chain: string;
  fact: string; signal: 'revisit' | 'take' | 'input' | 'retained' | 'method'; slot?: string;
  evidence?: { id: string; version: string }; at: Date;
};
export const recommendationKey = (...parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

/** Old readers/writers can run while the additive schema is being installed. */
export async function recommendationSchemaReady(db: Prisma.TransactionClient = prisma) {
  const rows = await db.$queryRaw<Array<{ name: string }>>`SELECT name FROM sqlite_master WHERE type='table'
    AND name IN ('WorkRecommendationEvent','WorkRecommendationJob','WorkRecommendationResult')`;
  return rows.length === 3;
}

export async function enqueueWorkRecommendation(db: Prisma.TransactionClient, workId: string) {
  await db.$executeRaw(Prisma.sql`INSERT INTO WorkRecommendationJob(work_id,revision,viewer_cursor,updated_at)
    VALUES(${workId},1,'',${new Date()}) ON CONFLICT(work_id) DO UPDATE
    SET revision=revision+1,viewer_cursor='',updated_at=excluded.updated_at`);
}

export async function invalidateWorkRecommendations(db: Prisma.TransactionClient, workId: string) {
  if (!await recommendationSchemaReady(db)) return;
  const affected = await db.$queryRaw<Array<{ work_id: string }>>(Prisma.sql`SELECT DISTINCT work_id FROM WorkRecommendationEvent WHERE evidence_work_id=${workId}`);
  for (const id of Array.from(new Set([workId, ...affected.map(row => row.work_id)]))) await enqueueWorkRecommendation(db, id);
}

/** Call after the real operation succeeds. This records evidence; it never scores. */
export async function appendRecommendationEvent(db: Prisma.TransactionClient, event: RecommendationEvent) {
  const changed = await db.$executeRaw(Prisma.sql`INSERT OR IGNORE INTO WorkRecommendationEvent
    (event_key,work_id,media_version_id,actor_id,purpose_key,chain_key,fact_key,signal,slot_key,evidence_work_id,evidence_media_version_id,occurred_at)
    SELECT ${event.key},id,current_version_id,${event.actor},${event.purpose},${event.chain},${event.fact},${event.signal},${event.slot ?? null},
      ${event.evidence?.id ?? null},${event.evidence?.version ?? null},${event.at}
    FROM Work WHERE id=${event.work} AND current_version_id=${event.version}`);
  if (!changed) return;
  await enqueueWorkRecommendation(db, event.work);
  if (event.slot) {
    // A successful replacement affects the preceding inputs in this exact slot.
    const previous = await db.$queryRaw<Array<{ work_id: string }>>(Prisma.sql`SELECT DISTINCT work_id FROM WorkRecommendationEvent
      WHERE actor_id=${event.actor} AND purpose_key=${event.purpose} AND slot_key=${event.slot} AND work_id<>${event.work}`);
    for (const row of previous) await enqueueWorkRecommendation(db, row.work_id);
  }
  const versions = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT sibling.id FROM Work source
    JOIN VideoTask task ON source.source_kind='video_task' AND task.id=source.source_id
    JOIN VideoTask peer ON peer.lineage_root_task_id=COALESCE(task.lineage_root_task_id,task.id)
      OR peer.id=COALESCE(task.lineage_root_task_id,task.id)
    JOIN Work sibling ON sibling.source_kind='video_task' AND sibling.source_id=peer.id
    WHERE source.id=${event.work} AND sibling.id<>source.id`);
  for (const row of versions) await enqueueWorkRecommendation(db, row.id);
}

/** Clipboard success and deliberate comparison-return are supplied by their actual UI callbacks. */
export async function recordRecommendationEvidence(user: SessionUser, workId: string, input: Record<string, unknown>) {
  assertWorkViewer(user, input.viewerId);
  assertWorkId(input.mediaVersion, '作品版本');
  if (input.kind !== 'copy' && input.kind !== 'revisit') throw new WorkError('作品行为无效');
  const access = await getWorkAccess(user, workId);
  if (!access?.canPreview || !access.work.discoverable || access.media.id !== input.mediaVersion)
    throw new WorkError('作品已不可用或已换版', 404);
  const purpose = `actor:${user.id}`;
  let key = recommendationKey('take', access.media.video_task_id ? `video:${access.media.video_task_id}` : access.media.asset_id || workId,
    access.media.video_task_id ? access.media.source_revision : access.media.content_hash || access.media.id, user.id), chain = purpose;
  let evidence: RecommendationEvent['evidence'];
  if (input.kind === 'copy' && !access.canDownload && !access.reuse) throw new WorkError('当前无原图复制权限', 403);
  if (input.kind === 'revisit') {
    assertWorkId(input.comparedWorkId, '比较作品');
    assertWorkId(input.comparisonId, '比较编号');
    const compared = await getWorkAccess(user, input.comparedWorkId);
    if (!compared?.canPreview || !compared.work.discoverable || compared.work.id === workId) throw new WorkError('比较作品不可用', 404);
    const contexts = await prisma.workContext.findMany({ where: { work_id: { in: [workId, compared.work.id] } } });
    const first = contexts.find(row => row.work_id === workId), second = contexts.find(row => row.work_id === compared.work.id);
    if (!first?.submission_key || first.submission_key !== second?.submission_key
      || first.media_version_id !== access.media.id || second.media_version_id !== compared.media.id)
      throw new WorkError('当前比较不能确认属于同批作品', 409);
    chain = recommendationKey('comparison', user.id, first.submission_key, input.comparisonId);
    key = recommendationKey('revisit', workId, access.media.id, chain);
    evidence = { id: compared.work.id, version: compared.media.id };
  }
  if (!await recommendationSchemaReady()) return;
  await prisma.$transaction(tx => appendRecommendationEvent(tx, {
    key, work: workId, version: access.media.id, actor: user.id, purpose, chain, fact: key,
    signal: input.kind === 'copy' ? 'take' : 'revisit', evidence, at: new Date(),
  }), { timeout: 1500 });
}

/** A newly completed asset can be copied before background catalog admission. */
export async function recordOriginalAssetTake(user: SessionUser, assetId: string) {
  if (!canUseWorksPreview(user) || !await recommendationSchemaReady()) return;
  const asset = await prisma.asset.findUnique({ where: { id: assetId } });
  if (!asset || asset.type !== 'image' || asset.status !== 'active' || !asset.hash || !await canReadStudioAsset(user, asset)) return;
  const works = await prisma.work.findMany({ where: { versions: { some: { asset_id: assetId, content_hash: asset.hash } } },
    include: { versions: { where: { asset_id: assetId, content_hash: asset.hash } } }, take: 3 });
  const current = works.filter(work => work.versions.some(version => version.id === work.current_version_id));
  if (current.length === 1) return recordRecommendationEvidence(user, current[0].id, { viewerId: user.id, mediaVersion: current[0].current_version_id, kind: 'copy' });
  if (current.length || asset.owner_id !== user.id || !await prisma.imageStudioTask.findFirst({ where: {
    owner_id: user.id, asset_id: asset.id, deleted_at: null, AND: [studioOutputTaskWhere],
  }, select: { id: true } })) return;
  const key = recommendationKey('take', asset.id, asset.hash, user.id), purpose = `actor:${user.id}`;
  // This pending identity cannot create a Work or broaden its future audience.
  await prisma.$executeRaw(Prisma.sql`INSERT OR IGNORE INTO WorkRecommendationEvent
    (event_key,work_id,media_version_id,actor_id,purpose_key,chain_key,fact_key,signal,occurred_at)
    VALUES(${key},${'asset:' + asset.id},${asset.hash},${user.id},${purpose},${purpose},${key},'take',${new Date()})`);
}

/** Bind already recorded asset facts only after the normal output catalog admits them. */
export async function bindPendingRecommendationTakes(db = prisma) {
  const admitted = await db.$queryRaw<Array<{ id: number }>>(Prisma.sql`SELECT event.id FROM WorkRecommendationEvent event
    WHERE (event.work_id>='asset:' AND event.work_id<'asset;' AND EXISTS (
      SELECT 1 FROM WorkMediaVersion media JOIN Work work ON work.id=media.work_id AND work.current_version_id=media.id
      WHERE media.asset_id=substr(event.work_id,7) AND media.content_hash=event.media_version_id
    )) OR (event.work_id>='video:' AND event.work_id<'video;' AND EXISTS (
      SELECT 1 FROM Work work JOIN WorkMediaVersion media ON media.id=work.current_version_id AND media.work_id=work.id
      WHERE work.source_kind='video_task' AND work.source_id=substr(event.work_id,7) AND media.source_revision=event.media_version_id
    )) ORDER BY event.id LIMIT 12`);
  const pending = await db.workRecommendationEvent.findMany({ where: { id: { in: admitted.map(row => row.id) } } });
  for (const event of pending) {
    const rows = await db.$queryRaw<Array<{ id: string; version: string }>>(Prisma.sql`SELECT w.id,v.id AS version
      FROM WorkMediaVersion v JOIN Work w ON w.id=v.work_id AND w.current_version_id=v.id
      WHERE ${event.work_id.startsWith('asset:')
        ? Prisma.sql`v.asset_id=${event.work_id.slice(6)} AND v.content_hash=${event.media_version_id}`
        : Prisma.sql`w.source_kind='video_task' AND w.source_id=${event.work_id.slice(6)} AND v.source_revision=${event.media_version_id}`} LIMIT 2`);
    if (rows.length !== 1) continue;
    await db.$transaction(async tx => {
      const changed = await tx.workRecommendationEvent.updateMany({ where: { id: event.id, work_id: event.work_id, media_version_id: event.media_version_id },
        data: { work_id: rows[0].id, media_version_id: rows[0].version } });
      if (changed.count) await enqueueWorkRecommendation(tx, rows[0].id);
    }, { timeout: 1500 });
  }
}

/** A redirect proves intent only. A complete native stream may become a strong take fact. */
export async function recordVideoTaskTake(user: SessionUser, taskId: string, expectedRevision: string, confirmed: boolean) {
  if (!canUseWorksPreview(user) || !await recommendationSchemaReady()) return;
  const task = await prisma.videoTask.findUnique({ where: { id: taskId } });
  const source = task?.local_video_path || task?.public_video_url, stamp = task?.public_video_cached_at || task?.delivery_completed_at;
  if (!task || !source || !stamp || task.local_status !== 'succeeded' || !['active', 'retained'].includes(task.retention_status)
    || workVideoSourceRevision(source, stamp, task.public_video_file_size) !== expectedRevision) return;
  await assertCanViewTask(user, task);
  const work = await prisma.work.findUnique({ where: { source_kind_source_id_output_role: { source_kind: 'video_task', source_id: task.id, output_role: 'output' } } });
  const media = work?.current_version_id ? await prisma.workMediaVersion.findUnique({ where: { id: work.current_version_id } }) : null;
  if (confirmed && work && media?.source_revision === expectedRevision)
    return recordRecommendationEvidence(user, work.id, { viewerId: user.id, mediaVersion: media.id, kind: 'copy' });
  const key = recommendationKey(confirmed ? 'take' : 'take-intent', `video:${task.id}`, expectedRevision, user.id), purpose = `actor:${user.id}`;
  await prisma.$executeRaw(Prisma.sql`INSERT OR IGNORE INTO WorkRecommendationEvent
    (event_key,work_id,media_version_id,actor_id,purpose_key,chain_key,fact_key,signal,occurred_at)
    VALUES(${key},${media?.source_revision === expectedRevision ? work!.id : 'video:' + task.id},
      ${media?.source_revision === expectedRevision ? media.id : expectedRevision},${user.id},${purpose},${purpose},${key},${confirmed ? 'take' : 'take-intent'},${new Date()})`);
}

export function observeVideoTaskDownload(request: Request, response: Response, user: SessionUser, taskId: string, expectedRevision: string) {
  return observeOriginalTransfer(request, response, () => recordVideoTaskTake(user, taskId, expectedRevision, true));
}

/** A complete single original transfer is observable; a saved file on disk is not. */
export function observeWorkDownload(request: Request, response: Response, user: SessionUser, workId: string, version: string) {
  return observeOriginalTransfer(request, response, () => recordRecommendationEvidence(user, workId, { viewerId: user.id, mediaVersion: version, kind: 'copy' }));
}

export function observeOriginalAssetDownload(request: Request, response: Response, user: SessionUser, assetId: string) {
  return observeOriginalTransfer(request, response, () => recordOriginalAssetTake(user, assetId));
}

function observeOriginalTransfer(request: Request, response: Response, completed: () => Promise<void>) {
  const length = Number(response.headers.get('content-length'));
  if (request.method !== 'GET' || request.headers.has('range') || response.status !== 200 || !response.body
    || !Number.isSafeInteger(length) || length <= 0) return response;
  const reader = response.body.getReader();
  let bytes = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (!chunk.done) { bytes += chunk.value.byteLength; controller.enqueue(chunk.value); return; }
        controller.close();
        if (bytes === length && !request.signal.aborted) {
          // Detached bookkeeping cannot delay or fail the completed media response.
          void completed()
            .catch(() => console.warn('[works] completed transfer evidence deferred'));
        }
      } catch (error) { controller.error(error); }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
