import 'server-only';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { appendRecommendationEvent, recommendationKey, type RecommendationEvent } from './recommendation-events';
import { canUseWorksPreview } from './rollout.server';
import { ensureAutomaticWorkDiscovery, WORK_DISCOVERY_DAYS } from './editorial';
import { readSuccessfulWorkMethodUse } from './method-reference';

const object = (text: string | null) => {
  try { const value: unknown = JSON.parse(text || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
  catch { return {}; }
};
const identity = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(value);

/** Reads only the existing safe provenance projection. Never reads private recipes or prompts. */
async function collectInputs(workId: string, db: typeof prisma) {
  const target = await db.work.findUnique({ where: { id: workId } });
  if (!target?.current_version_id || target.withdrawn_at || !target.discoverable) return;
  const actor = await db.user.findUnique({ where: { id: target.author_id }, select: {
    id: true, account_type: true, feishu_user_id: true, feishu_open_id: true, feishu_union_id: true, feishu_tenant_key: true,
  } });
  if (!actor || !canUseWorksPreview({ ...actor, feishu: { user_id: actor.feishu_user_id, open_id: actor.feishu_open_id,
    union_id: actor.feishu_union_id, tenant_key: actor.feishu_tenant_key } })) return;
  const context = await db.workContext.findUnique({ where: { work_id: workId } });
  if (!context || context.schema_version !== 1 || context.media_version_id !== target.current_version_id) return;
  const links = await db.workSourceLink.findMany({ where: { work_id: workId, media_version_id: target.current_version_id } });
  const video = target.source_kind === 'video_task' ? await db.videoTask.findUnique({ where: { id: target.source_id } }) : null;
  const metadata = video ? object(video.source_metadata_json) : {};
  const document = video && metadata.source === 'ultimate_canvas' && identity(metadata.canvas_document_id) && identity(metadata.canvas_node_id)
    ? await db.canvasDocument.findFirst({ where: { id: metadata.canvas_document_id, owner_user_id: target.author_id, project_id: video.project_id }, select: { id: true, document_json: true } }) : null;
  const nodes = document ? object(document.document_json).nodes : null;
  const canvas = document && Array.isArray(nodes) && nodes.some(node => node && typeof node === 'object' && node.id === metadata.canvas_node_id)
    ? `${target.author_id}:${document.id}:${metadata.canvas_node_id}` : null;
  // A request/batch ID alone cannot prove an independent creative purpose.
  const purpose = canvas ? `canvas:${canvas}` : video?.video_card_id && video.project_id
    ? `card:${target.author_id}:${video.project_id}:${video.video_card_id}` : target.project_id
      ? `project:${target.author_id}:${target.project_id}` : `actor:${target.author_id}`;
  const taskCreated = video?.created_at || (target.source_kind === 'image_task'
    ? (await db.imageStudioTask.findUnique({ where: { id: target.source_id }, select: { created_at: true } }))?.created_at : null);
  if (!taskCreated) return;
  const finishing = video && (video.draft_upgrade_mode === 'draft_upgrade' || ['upscale', 'enhance', 'extend', 'interpolate', 'trim'].includes(video.derivation_kind || ''));
  const parents = await db.work.findMany({ where: { OR: links.filter(link => finishing && link.source_kind !== 'asset' && link.relation === 'post-process')
    .map(link => ({ source_kind: link.source_kind, source_id: link.source_id })) }, select: { id: true } });
  const events: RecommendationEvent[] = [];
  const image = target.source_kind === 'image_task'
    ? await db.imageStudioTask.findUnique({ where: { id: target.source_id }, select: { batch_id: true } }) : null;
  const method = image || video ? await readSuccessfulWorkMethodUse(db, { ownerId: target.author_id,
    kind: image ? 'image' : 'video', requestId: image?.batch_id || video!.id }) : null;
  if (method && method.workId !== target.id && context.template_id === method.templateId) {
    const key = recommendationKey('method', method.workId, method.mediaVersion, target.id, target.current_version_id);
    events.push({ key, work: method.workId, version: method.mediaVersion, actor: target.author_id,
      purpose: `method:${method.workId}`, chain: `method:${method.scopeId}`, fact: key, signal: 'method',
      evidence: { id: target.id, version: target.current_version_id }, at: target.completed_at });
  }
  for (const link of links) {
    let slot: string | undefined;
    if (link.relation === 'direct-input' && link.source_kind === 'asset') {
      if (video) {
        const asset = await db.asset.findUnique({ where: { id: link.source_id }, select: { original_url: true } });
        // Generic style/reference slots do not prove a key input. First/last frames do.
        const role = asset && asset.original_url === video.first_frame_url ? 'first' : asset && asset.original_url === video.last_frame_url ? 'last' : null;
        if (!role) continue;
        if (canvas) slot = role;
      }
    } else if (video && link.source_kind === 'video_task' && link.relation === 'post-process') {
      if (canvas) slot = 'video';
    } else continue;
    const sources = link.source_kind === 'asset'
      ? await db.work.findMany({ where: { versions: { some: { asset_id: link.source_id } } }, include: { versions: { where: { asset_id: link.source_id } } }, take: 3 })
      : await db.work.findMany({ where: { source_kind: link.source_kind, source_id: link.source_id }, include: { versions: true }, take: 3 });
    const current = sources.flatMap(source => {
      const media = source.versions.find(version => version.id === source.current_version_id);
      return media && source.id !== target.id && source.completed_at <= taskCreated ? [{ source, media }] : [];
    });
    // An ambiguous asset-to-work binding is unknown, not multiple votes.
    if (current.length !== 1) continue;
    const { source, media } = current[0];
    const prior = parents.length ? await db.$queryRaw<Array<{ id: number }>>(Prisma.sql`SELECT id FROM WorkRecommendationEvent
      WHERE work_id=${source.id} AND media_version_id=${media.id} AND actor_id=${target.author_id}
        AND signal IN ('input','retained') AND occurred_at<${target.completed_at}
        AND evidence_work_id IN (${Prisma.join(parents.map(parent => parent.id))}) LIMIT 1`) : [];
    const signal = prior.length ? 'retained' as const : 'input' as const;
    events.push({ key: recommendationKey('input', target.id, target.current_version_id, source.id, media.id),
      work: source.id, version: media.id, actor: target.author_id, purpose, chain: purpose,
      fact: recommendationKey('input', target.id, target.current_version_id, source.id, media.id), signal, slot,
      evidence: { id: target.id, version: target.current_version_id }, at: target.completed_at });
  }
  if (events.length) await db.$transaction(async tx => {
    const fresh = await tx.work.findUnique({ where: { id: target.id }, select: { current_version_id: true, revision: true } });
    if (fresh?.current_version_id !== target.current_version_id || fresh.revision !== target.revision) return;
    for (const event of events) await appendRecommendationEvent(tx, event);
  }, { timeout: 1500 });
}

/** Durable seek recovery also covers sources created before this consumer existed. */
export async function collectRecommendationSourcePass(shouldStop: () => boolean, db = prisma) {
  const discoveryKey = 'automatic-work-discovery:v1';
  const since = new Date(Date.now() - WORK_DISCOVERY_DAYS * 86400000);
  const discovery = await db.workDiscoveryCheckpoint.upsert({ where: { source_kind: discoveryKey },
    create: { source_kind: discoveryKey, cursor_at: since, cursor_id: '' }, update: {} });
  const repairDue = discovery.cursor_id !== '' || !discovery.cycles || Date.now() - discovery.updated_at.getTime() >= 60_000;
  const candidates = repairDue ? await db.work.findMany({ where: { completed_at: { gte: since },
    current_version_id: { not: null }, discoverable: true, withdrawn_at: null,
    OR: [{ admitted_at: { gt: discovery.cursor_at || since } }, { admitted_at: discovery.cursor_at || since, id: { gt: discovery.cursor_id || '' } }],
  }, orderBy: [{ admitted_at: 'asc' }, { id: 'asc' }], take: 12 }) : [];
  for (const work of candidates) {
    if (shouldStop()) return;
    await ensureAutomaticWorkDiscovery(db, work);
    await db.workDiscoveryCheckpoint.update({ where: { source_kind: discoveryKey }, data: { cursor_at: work.admitted_at, cursor_id: work.id } });
  }
  if (repairDue && candidates.length < 12) await db.workDiscoveryCheckpoint.update({ where: { source_kind: discoveryKey },
    data: { cursor_at: since, cursor_id: '', cycles: { increment: 1 } } });
  if (shouldStop()) return;
  // New completions have their own high-water mark, ahead of the bounded historical repair.
  const liveKey = 'recommendation-live-sources:v1';
  const live = await db.workDiscoveryCheckpoint.upsert({ where: { source_kind: liveKey },
    create: { source_kind: liveKey, cursor_at: new Date(), cursor_id: '' }, update: {} });
  const changed = await db.workContext.findMany({ where: { OR: [
    { indexed_at: { gt: live.cursor_at! } }, { indexed_at: live.cursor_at!, work_id: { gt: live.cursor_id || '' } },
  ] }, orderBy: [{ indexed_at: 'asc' }, { work_id: 'asc' }], take: 12, select: { work_id: true, indexed_at: true } });
  for (const row of changed) {
    if (shouldStop()) return;
    await collectInputs(row.work_id, db);
    await db.workDiscoveryCheckpoint.update({ where: { source_kind: liveKey }, data: { cursor_at: row.indexed_at, cursor_id: row.work_id } });
  }
  if (shouldStop()) return;
  const key = 'recommendation-sources:v1';
  const checkpoint = await db.workDiscoveryCheckpoint.upsert({ where: { source_kind: key }, create: { source_kind: key }, update: {} });
  const upper = checkpoint.upper_at || new Date();
  const rows = await db.workContext.findMany({ where: { indexed_at: { lte: upper },
    ...(checkpoint.cursor_at ? { OR: [{ indexed_at: { gt: checkpoint.cursor_at } }, { indexed_at: checkpoint.cursor_at, work_id: { gt: checkpoint.cursor_id || '' } }] } : {}),
  }, orderBy: [{ indexed_at: 'asc' }, { work_id: 'asc' }], take: 12, select: { work_id: true, indexed_at: true } });
  for (const row of rows) {
    if (shouldStop()) return;
    await collectInputs(row.work_id, db);
    await db.workDiscoveryCheckpoint.update({ where: { source_kind: key }, data: { cursor_at: row.indexed_at, cursor_id: row.work_id, upper_at: upper } });
  }
  if (rows.length < 12) await db.workDiscoveryCheckpoint.update({ where: { source_kind: key }, data: {
    cursor_at: null, cursor_id: null, upper_at: null, cycles: { increment: 1 },
  } });
}
