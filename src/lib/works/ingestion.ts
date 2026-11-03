import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { parseMultiviewWorkManifest } from '@/lib/video/multiview-work-contract';
import { characterLabTaskBatchIds } from '@/lib/character-lab/task-source';
import { studioTaskHasViewableOutput } from '@/lib/image-studio/dimension-mismatch';
import { isTaskHiddenFromRegularUsers } from '@/lib/tasks/retention';
import { worksRegistrationPaused, worksSchemaReady } from './source-policy';
import { backfillWorkContexts, indexWorkContext, worksContextSchemaReady } from './context-index';

type SourceKind = 'image_task' | 'video_task' | 'multiview_work';
const sourceKinds: SourceKind[] = ['image_task', 'video_task', 'multiview_work'];
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const MAX_ATTEMPTS = 6;
export type WorkRegistrationLease = { id: string; source_kind: string; source_id: string; source_revision: string; lease_token: string | null; attempts: number };
type Candidate = { kind: SourceKind; id: string; revision: string; updatedAt: Date; authorId: string; projectId: string | null;
  title: string; medium: 'image' | 'video'; assetId: string | null; videoTaskId: string | null; sourceUrl: string; sourceUpdatedAt: Date;
  hash: string | null; width: number | null; height: number | null; duration: number | null; thumbnailUrl: string | null; completedAt: Date };

/** Freshly validate the original output and exact ready revision in the same transaction that switches the pointer. */
async function readySource(db: Prisma.TransactionClient, kind: SourceKind, id: string, excludedBatches = new Map<string, string[]>()): Promise<Candidate | null> {
  if (kind === 'image_task') {
    const task = await db.imageStudioTask.findUnique({ where: { id } });
    if (!task || task.deleted_at || !task.asset_id || !task.finished_at || !studioTaskHasViewableOutput(task)) return null;
    if (!excludedBatches.has(task.owner_id)) excludedBatches.set(task.owner_id, await characterLabTaskBatchIds(task.owner_id, db));
    if (excludedBatches.get(task.owner_id)!.includes(task.batch_id)) return null;
    const asset = await db.asset.findUnique({ where: { id: task.asset_id } });
    if (!asset || asset.owner_id !== task.owner_id || asset.type !== 'image' || asset.status !== 'active' || !asset.original_url) return null;
    const attribution = await db.$queryRaw<Array<{ project_id: string | null }>>`SELECT project_id FROM UsageAttribution WHERE source_kind = 'image_task' AND source_id = ${id}`;
    return { kind, id, revision: sha(JSON.stringify([asset.id, asset.hash, asset.original_url])), updatedAt: task.updated_at,
      authorId: task.owner_id, projectId: attribution[0]?.project_id || null, title: '图片作品', medium: 'image', assetId: asset.id,
      videoTaskId: null, sourceUrl: asset.original_url, sourceUpdatedAt: task.finished_at, hash: asset.hash, width: asset.width,
      height: asset.height, duration: null, thumbnailUrl: asset.thumbnail_url, completedAt: task.finished_at };
  }
  if (kind === 'video_task') {
    const task = await db.videoTask.findUnique({ where: { id } });
    if (!task || task.local_status !== 'succeeded' || isTaskHiddenFromRegularUsers(task) || !(task.owner_user_id || task.user_id)) return null;
    const publicReady = ['r2', 'tos', 'local-public'].includes(task.public_video_storage_provider || '')
      && task.public_video_url && task.public_video_cached_at && task.public_video_file_size;
    if (!(task.delivery_status === 'succeeded' && task.delivery_completed_at) && !publicReady) return null;
    const sourceUrl = task.local_video_path || (['r2', 'tos', 'local-public'].includes(task.public_video_storage_provider || '')
      && task.public_video_cached_at && task.public_video_file_size ? task.public_video_url : null);
    if (!sourceUrl) return null; // Never use a temporary provider result URL.
    const stamp = (task.public_video_cached_at || task.delivery_completed_at)!;
    return { kind, id, revision: sha(JSON.stringify([sourceUrl, stamp.toISOString(), task.public_video_file_size])), updatedAt: task.updated_at,
      authorId: (task.owner_user_id || task.user_id)!, projectId: task.project_id, title: '视频作品', medium: 'video', assetId: null,
      videoTaskId: task.id, sourceUrl, sourceUpdatedAt: stamp, hash: null, width: null, height: null, duration: task.duration,
      thumbnailUrl: null, completedAt: stamp };
  }
  const work = await db.multiviewWork.findUnique({ where: { id } });
  if (!work || work.removed_at || work.save_state === 'intent' || work.status !== 'ready' || work.ready_revision === null
    || !work.ready_recipe_json || !work.ready_manifest_json) return null;
  const receiptKey = `multiview_output_registration_v1:receipt:${id}:${work.ready_revision}`;
  const receiptRow = await db.platformSetting.findUnique({ where: { key: receiptKey }, select: { value_json: true } });
  if (!receiptRow) return null;
  const receipt = JSON.parse(receiptRow.value_json);
  if (receipt.schema !== 1 || receipt.state !== 'registered' || receipt.workId !== id || receipt.ownerId !== work.owner_id
    || receipt.readyRevision !== work.ready_revision || !Array.isArray(receipt.outputs)) return null;
  const manifest = parseMultiviewWorkManifest(work.ready_manifest_json, JSON.parse(work.ready_recipe_json), work.ready_revision, sha(work.ready_recipe_json));
  const expected = manifest && (JSON.parse(work.ready_recipe_json).schema === 3 ? 1 : manifest.frameCount + 1);
  if (!manifest || receipt.outputs.length !== expected || receipt.outputs.some((output: { state?: string }) => output.state !== 'registered')) return null;
  const mutation = await db.multiviewWorkMutation.findUnique({ where: { id: receipt.mutationRowId } });
  if (!mutation || mutation.work_id !== id || mutation.actor_id !== work.owner_id || mutation.request_hash !== receipt.mutationRequestHash
    || mutation.mutation_id !== receipt.mutationId || !['create', 'save', 'branch'].includes(mutation.action)) return null;
  const saved = JSON.parse(mutation.receipt_json);
  if (saved.state !== 'committed' || saved.draftRevision !== work.ready_revision || saved.workId !== id) return null;
  // Exactly the collage enters the catalog; per-frame reusable assets remain in their original source group.
  const output = receipt.outputs.find((item: { role?: string }) => item.role === 'collage');
  if (!output || typeof output.assetId !== 'string') return null;
  const asset = await db.asset.findUnique({ where: { id: output.assetId } });
  const collage = manifest.files.find(file => file.role === 'collage');
  if (!asset || !collage || asset.owner_id !== work.owner_id || asset.status !== 'active' || asset.type !== 'image'
    || asset.hash !== output.sha256 || asset.hash !== collage.sha256 || asset.original_url !== output.originalUrl
    || asset.width !== collage.width || asset.height !== collage.height) return null;
  return { kind, id, revision: String(work.ready_revision), updatedAt: work.updated_at, authorId: work.owner_id,
    projectId: work.project_id, title: work.title, medium: 'image', assetId: asset.id, videoTaskId: null, sourceUrl: asset.original_url,
    sourceUpdatedAt: mutation.created_at, hash: asset.hash, width: asset.width, height: asset.height, duration: null,
    thumbnailUrl: asset.thumbnail_url, completedAt: mutation.created_at };
}

/** A short page transaction owns candidates, durable jobs and cursor together. Fixed windows cycle forever. */
async function discoverPage(kind: SourceKind, pageSize: number, recent = false) {
  return prisma.$transaction(async db => {
    if (await worksRegistrationPaused(db)) return 0;
    const checkpointKind = recent ? `${kind}:recent` : kind;
    const point = await db.workDiscoveryCheckpoint.upsert({ where: { source_kind: checkpointKind },
      create: { source_kind: checkpointKind, ...(recent ? { cursor_at: new Date(Date.now() - 5 * 60_000), cursor_id: '' } : {}) }, update: {} });
    const upper = point.upper_at || new Date();
    const table = kind === 'image_task' ? Prisma.raw('ImageStudioTask') : kind === 'video_task' ? Prisma.raw('VideoTask') : Prisma.raw('MultiviewWork');
    const after = point.cursor_at && point.cursor_id !== null ? Prisma.sql`AND (updated_at > ${point.cursor_at} OR (updated_at = ${point.cursor_at} AND id > ${point.cursor_id}))` : Prisma.empty;
    const rows = await db.$queryRaw<Array<{ id: string; updated_at: Date }>>(Prisma.sql`
      SELECT id, updated_at FROM ${table} WHERE updated_at <= ${upper} ${after} ORDER BY updated_at ASC, id ASC LIMIT ${pageSize}`);
    const excludedBatches = new Map<string, string[]>();
    for (const row of rows) {
      let candidate: Candidate | null;
      try { candidate = await readySource(db, kind, row.id, excludedBatches); }
      catch {
        // One malformed legacy source must not strand the page or unrelated ready jobs.
        // The original source identity is retried through the same durable, bounded lease queue.
        await db.workRegistrationJob.upsert({ where: { source_kind_source_id_source_revision: {
          source_kind: kind, source_id: row.id, source_revision: `discovery:${row.updated_at.toISOString()}` } },
          create: { source_kind: kind, source_id: row.id, source_revision: `discovery:${row.updated_at.toISOString()}`,
            source_updated_at: row.updated_at, error_code: 'WORKS_SOURCE_DISCOVERY_DEFERRED' }, update: {} });
        continue;
      }
      if (!candidate) continue;
      await db.workRegistrationJob.upsert({ where: { source_kind_source_id_source_revision: { source_kind: kind, source_id: row.id, source_revision: candidate.revision } },
        create: { source_kind: kind, source_id: row.id, source_revision: candidate.revision, source_updated_at: candidate.updatedAt }, update: {} });
    }
    const last = rows[rows.length - 1];
    await db.workDiscoveryCheckpoint.update({ where: { source_kind: checkpointKind }, data: recent && rows.length < pageSize
      ? { cursor_at: upper, cursor_id: '\uffff', upper_at: null, cycles: { increment: 1 } }
      : last ? { cursor_at: last.updated_at, cursor_id: last.id, upper_at: upper }
        : { cursor_at: null, cursor_id: null, upper_at: null, cycles: { increment: 1 } } });
    return rows.length;
  }, { timeout: 15000 });
}

export async function claimWorkRegistrationJob(kinds: string[], leaseMs = 90_000, newest = false): Promise<WorkRegistrationLease | null> {
  return prisma.$transaction(async db => {
    if (await worksRegistrationPaused(db)) return null;
    const now = new Date();
    // A crash during the final attempt still reaches an honest terminal status after its lease expires.
    const exhausted = await db.workRegistrationJob.findMany({ where: { source_kind: { in: kinds }, status: 'running', attempts: { gte: MAX_ATTEMPTS }, lease_until: { lt: now } }, take: 4 });
    for (const expired of exhausted) {
      const changed = await db.workRegistrationJob.updateMany({ where: { id: expired.id, status: 'running', lease_token: expired.lease_token, lease_until: { lt: now } },
        data: { status: 'unavailable', error_code: 'WORKS_LEASE_EXHAUSTED', lease_token: null, lease_until: null } });
      if (changed.count && expired.source_kind === 'media_preview') await db.workMediaVersion.updateMany({ where: { id: expired.source_id, preview_status: { not: 'ready' } }, data: { preview_status: 'unavailable' } });
    }
    const job = await db.workRegistrationJob.findFirst({ where: { source_kind: { in: kinds }, attempts: { lt: MAX_ATTEMPTS },
      OR: [{ status: 'pending', run_after: { lte: now } }, { status: 'running', lease_until: { lt: now } }] }, orderBy: newest ? [{ source_updated_at: 'desc' }, { id: 'desc' }] : [{ run_after: 'asc' }, { id: 'asc' }] });
    if (!job) return null;
    const token = randomUUID();
    const changed = await db.workRegistrationJob.updateMany({ where: { id: job.id, status: job.status, lease_token: job.lease_token, attempts: job.attempts },
      data: { status: 'running', attempts: { increment: 1 }, lease_token: token, lease_until: new Date(Date.now() + leaseMs) } });
    return changed.count ? { ...job, attempts: job.attempts + 1, lease_token: token } : null;
  });
}
export function workRegistrationLeaseWhere(job: WorkRegistrationLease) {
  return { id: job.id, status: 'running', lease_token: job.lease_token, lease_until: { gt: new Date() } };
}
export async function failWorkRegistrationJob(job: WorkRegistrationLease, code: string) {
  const exhausted = job.attempts >= MAX_ATTEMPTS;
  await prisma.$transaction(async db => {
    const changed = await db.workRegistrationJob.updateMany({ where: workRegistrationLeaseWhere(job), data: {
      status: exhausted ? 'unavailable' : 'pending', run_after: new Date(Date.now() + Math.min(30 * 60_000, 15_000 * 2 ** (job.attempts - 1))),
      error_code: code, lease_token: null, lease_until: null } });
    if (changed.count && exhausted && job.source_kind === 'media_preview') await db.workMediaVersion.updateMany({
      where: { id: job.source_id, preview_status: { not: 'ready' } }, data: { preview_status: 'unavailable' } });
  });
}
async function registerClaimed(job: WorkRegistrationLease) {
  return prisma.$transaction(async db => {
    if (!await db.workRegistrationJob.findFirst({ where: workRegistrationLeaseWhere(job) })) return false;
    const source = await readySource(db, job.source_kind as SourceKind, job.source_id);
    if (!source || !job.source_revision.startsWith('discovery:') && source.revision !== job.source_revision) {
      await db.workRegistrationJob.updateMany({ where: workRegistrationLeaseWhere(job), data: { status: 'superseded', lease_token: null, lease_until: null } });
      return false;
    }
    const policy = await db.workSourcePolicy.findUnique({ where: { source_kind_source_id_operation_id: {
      source_kind: source.kind, source_id: source.id, operation_id: source.kind === 'multiview_work' ? source.revision : 'initial' } } });
    const audience = policy?.owner_id === source.authorId && policy.project_id === source.projectId ? policy.audience : 'source';
    const work = await db.work.upsert({ where: { source_kind_source_id_output_role: { source_kind: source.kind, source_id: source.id, output_role: source.kind === 'multiview_work' ? 'collage' : 'output' } },
      create: { source_kind: source.kind, source_id: source.id, output_role: source.kind === 'multiview_work' ? 'collage' : 'output',
        author_id: source.authorId, project_id: source.projectId, title: source.title, medium: source.medium, audience, completed_at: source.completedAt }, update: {} });
    if (work.author_id !== source.authorId) throw new Error('WORKS_SOURCE_OWNER_CHANGED');
    const version = await db.workMediaVersion.upsert({ where: { work_id_source_revision: { work_id: work.id, source_revision: source.revision } },
      create: { work_id: work.id, source_revision: source.revision, policy_id: policy?.id || null, asset_id: source.assetId,
        video_task_id: source.videoTaskId, source_url: source.sourceUrl, source_updated_at: source.sourceUpdatedAt, content_hash: source.hash,
        width: source.width, height: source.height, duration: source.duration, thumbnail_url: source.thumbnailUrl,
        preview_status: source.medium === 'image' && source.thumbnailUrl ? 'ready' : 'pending' }, update: {} });
    if (work.current_version_id !== version.id) await db.work.update({ where: { id: work.id }, data: {
      current_version_id: version.id, title: source.title, project_id: source.projectId, audience, completed_at: source.completedAt, revision: { increment: 1 } } });
    if (await worksContextSchemaReady(db)) await indexWorkContext(db, work, version.id);
    if (source.medium === 'video' && policy || source.medium === 'image' && !source.thumbnailUrl) await db.workRegistrationJob.upsert({
      where: { source_kind_source_id_source_revision: { source_kind: 'media_preview', source_id: version.id, source_revision: version.id } },
      create: { source_kind: 'media_preview', source_id: version.id, source_revision: version.id, source_updated_at: source.updatedAt }, update: {} });
    await db.workRegistrationJob.updateMany({ where: workRegistrationLeaseWhere(job), data: { status: 'done', error_code: null, lease_token: null, lease_until: null } });
    return true;
  }, { timeout: 15000 });
}
export async function processWorksRegistrationPass(options: { pageSize?: number; jobs?: number; shouldStop?: () => boolean } = {}) {
  if (!await worksSchemaReady()) return { state: 'schema-unavailable' as const, scanned: 0, registered: 0 };
  if (await worksRegistrationPaused()) return { state: 'paused' as const, scanned: 0, registered: 0 };
  let scanned = 0, registered = 0, deferred = 0;
  const pageSize = Math.min(40, Math.max(1, options.pageSize || 12));
  const turn = await prisma.workDiscoveryCheckpoint.upsert({ where: { source_kind: 'registration:fairness' },
    create: { source_kind: 'registration:fairness', cycles: 1 }, update: { cycles: { increment: 1 } }, select: { cycles: true } });
  // Existing ready jobs run before discovery. Each source gets a turn even when another source has a larger backlog.
  for (let count = 0; count < Math.min(12, Math.max(1, options.jobs || 4)) && !options.shouldStop?.(); count++) {
    const kind = sourceKinds[(turn.cycles - 1 + count) % sourceKinds.length];
    const job = await claimWorkRegistrationJob([kind], 90_000, count % 2 === 0);
    if (!job) continue;
    try { if (await registerClaimed(job)) registered++; }
    catch { deferred++; await failWorkRegistrationJob(job, 'WORKS_SOURCE_REGISTRATION_DEFERRED'); }
  }
  for (const recent of [true, false]) for (const kind of sourceKinds) {
    if (options.shouldStop?.()) break;
    try { scanned += await discoverPage(kind, pageSize, recent); }
    catch { deferred++; console.warn('[works-registration] source discovery deferred', { source: kind, window: recent ? 'recent' : 'history' }); }
  }
  if (!options.shouldStop?.()) {
    try { await backfillWorkContexts(pageSize); }
    catch { deferred++; console.warn('[works-registration] context checkpoint deferred'); }
  }
  return { state: 'processed' as const, scanned, registered, deferred };
}
