import { createHash } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { AuthError, type SessionUser } from '@/lib/auth/session';
import { USER_VISIBLE_TASK_RETENTION_STATUSES } from '@/lib/tasks/retention';
import { privateMultiviewTaskWhere } from './multiview-task-privacy';
import { currentMultiviewActor, assertMultiviewWorkReference, MultiviewWorkError, multiviewWorkRecipeHash } from './multiview-works';
import { parseMultiviewWorkManifest, parseMultiviewWorkRecipe } from './multiview-work-contract';
import { readSafePrivateMultiviewInput } from './multiview-private-create.server';
import { resolveContent } from '@/lib/content-reactions/content';
import { assertCanViewReferenceImage } from '@/lib/reference-albums/permissions';
import { displayUserName, isTechnicalUsername } from '@/lib/users/display';

export type MultiviewRecordCover = { url: string; kind: 'result' | 'video-frame' | 'input'; bytes?: number; width?: number; height?: number };

export type MultiviewRecord = { id: string; taskId: string; sourceId: string | null; workId: string | null; sourceVersion: string | null;
  title: string; status: string; createdAt: string; projectId: string | null; projectTitle: string | null; schemeCount: number; removed: boolean; coverUrl: string | null;
  creator?: { id: string; name: string; avatar_url: string | null } | null;
  cover?: { candidates: MultiviewRecordCover[]; retryable: boolean } };

async function recordCovers(user: SessionUser, item: MultiviewRecord) {
  const candidates: MultiviewRecordCover[] = [];
  let retryable = false, after: string | undefined;
  // Search older saved results in bounded chunks; an unfinished latest scheme must not mask a ready one.
  if (item.workId) do {
    const rows = await prisma.multiviewWork.findMany({ where: { owner_id: user.id, save_state: { not: 'intent' },
      removed_at: item.removed ? { not: null } : null, ...(item.sourceId ? { source_id: item.sourceId } : { source_id: null, source_task_id: item.taskId }) },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: 128, ...(after ? { cursor: { id: after }, skip: 1 } : {}),
      select: { id: true, owner_id: true, source_task_id: true, source_id: true, source_version: true, source_info_json: true,
        ready_revision: true, ready_recipe_json: true, ready_manifest_json: true } });
    for (const row of rows) {
      if (row.ready_revision === null || !row.ready_recipe_json) continue;
      try {
        await assertMultiviewWorkReference(user, row);
        const info = JSON.parse(row.source_info_json || 'null');
        if (!info || info.taskId !== row.source_task_id || info.sourceVersion !== row.source_version
          || !Number.isInteger(info.width) || !Number.isInteger(info.height) || info.width < 1 || info.height < 1
          || !Array.isArray(info.timestamps) || info.timestamps.length < 8 || info.timestamps.length > 21600 || info.timestamps.some((time: number) => !Number.isFinite(time))) throw new Error('invalid_source');
        const recipe = parseMultiviewWorkRecipe(row.ready_recipe_json, info);
        const manifest = recipe && parseMultiviewWorkManifest(row.ready_manifest_json, recipe, row.ready_revision, multiviewWorkRecipeHash(recipe));
        if (!manifest) throw new Error('invalid_manifest');
        for (const role of ['thumbnail', 'collage'] as const) {
          const file = manifest.files.find(file => file.role === role);
          if (file) candidates.push({ kind: 'result', bytes: file.bytes, width: file.width, height: file.height,
            url: `/api/video/multiview/works/${encodeURIComponent(row.id)}/files/${role}?readyRevision=${row.ready_revision}` });
        }
        if (candidates.length) break;
      } catch (error) { if (!(error instanceof AuthError && [403, 404].includes(error.status))) retryable = true; }
    }
    if (candidates.length) break;
    after = rows.length === 128 ? rows[rows.length - 1].id : undefined;
  } while (after);
  if (item.coverUrl) candidates.push({ url: item.coverUrl, kind: 'video-frame' });
  // Output access is never authority to read an input. Only the original owner's explicit main input is eligible.
  if (!item.sourceId) {
    try {
      const task = await prisma.videoTask.findUnique({ where: { id: item.taskId }, select: { owner_user_id: true, user_id: true,
        source_metadata_json: true, params_json: true, project_id: true, video_card_id: true, provider: true, model: true, generation_mode: true,
        ratio: true, duration: true, resolution: true, seed: true, generate_audio: true, return_last_frame: true, watermark: true, reference_image_ids: true } });
      if (task && (task.owner_user_id || task.user_id) === user.id && task.model) {
        const safe = readSafePrivateMultiviewInput({ ...task, model: task.model });
        const assetId = safe.snapshot.mainAssetId, referenceId = safe.snapshot.mainReferenceImageId;
        const asset = assetId ? await prisma.asset.findUnique({ where: { id: assetId }, select: { id: true, type: true, status: true } }) : null;
        if (asset?.type === 'image' && asset.status === 'active') {
          if (referenceId) {
            const reference = await assertCanViewReferenceImage(user, referenceId);
            if (reference.asset_id !== asset.id) throw new AuthError('主图来源不匹配。', 403);
          }
          const key = referenceId ? `reference_image:${referenceId}` as const : `asset:${asset.id}` as const;
          const content = await resolveContent(user, key);
          if (content?.summary.category === 'image' && content.summary.thumbnailUrl?.startsWith('/api/')) candidates.push({ kind: 'input', url: content.summary.thumbnailUrl });
        }
      }
    } catch (error) { if (!(error instanceof AuthError && [403, 404].includes(error.status))) retryable = true; }
  }
  return { candidates, retryable };
}
export async function listMultiviewRecords(user: SessionUser, input: { q: string; projectId: string; removed: boolean; cursor: string | null }) {
  await currentMultiviewActor(user);
  if (input.q.length > 120 || input.projectId.length > 100 || (input.cursor?.length || 0) > 512) throw new MultiviewWorkError('记录筛选无效。');
  const groups = new Map<string, MultiviewRecord>();
  const titles = new Map<string, string[]>();
  const projects = new Map<string, string>();
  const creators = new Map<string, string | null>();
  if (!input.removed) {
    let after: string | undefined;
    do {
      const tasks = await prisma.videoTask.findMany({ where: { AND: [privateMultiviewTaskWhere(),
        { OR: [{ owner_user_id: user.id }, { owner_user_id: null, user_id: user.id }] },
        { retention_status: { in: [...USER_VISIBLE_TASK_RETENTION_STATUSES] } }] }, orderBy: { id: 'asc' }, take: 128,
        ...(after ? { cursor: { id: after }, skip: 1 } : {}),
        select: { id: true, user_id: true, created_at: true, local_status: true, project_id: true, project: { select: { name: true } } } });
      for (const task of tasks) {
        const id = `task:${task.id}`;
        creators.set(id, task.user_id);
        groups.set(id, { id, taskId: task.id, sourceId: null, workId: null, sourceVersion: null,
          title: '3D多视图', status: task.local_status, createdAt: task.created_at.toISOString(), projectId: task.project_id,
          projectTitle: task.project?.name || null, schemeCount: 0, removed: false,
          coverUrl: `/api/video/multiview/records/${encodeURIComponent(task.id)}/cover` });
        if (task.project_id && task.project) projects.set(task.project_id, task.project.name);
      }
      after = tasks.length === 128 ? tasks[tasks.length - 1].id : undefined;
    } while (after);
  }
  let after: string | undefined;
  do {
    const rows = await prisma.multiviewWork.findMany({ where: { owner_id: user.id, save_state: { not: 'intent' }, removed_at: input.removed ? { not: null } : null },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: 128, ...(after ? { cursor: { id: after }, skip: 1 } : {}),
      select: { id: true, owner_id: true, source_task_id: true, source_id: true, source_version: true, title: true, created_at: true, project_id: true, status: true } });
    for (const row of rows) {
      try { await assertMultiviewWorkReference(user, row); }
      catch (error) { if (error instanceof AuthError && [403, 404].includes(error.status)) continue; throw error; }
      const id = row.source_id ? `source:${row.source_id}` : `task:${row.source_task_id}`;
      titles.set(id, [...(titles.get(id) || []), row.title]);
      let group = groups.get(id);
      if (!group) {
        creators.set(id, row.owner_id);
        const project = row.project_id && !row.source_id ? await prisma.project.findUnique({ where: { id: row.project_id }, select: { name: true } }) : null;
        group = { id, taskId: row.source_task_id, sourceId: row.source_id, workId: row.id, sourceVersion: row.source_version,
          title: row.title, status: row.status, createdAt: row.created_at.toISOString(), projectId: row.source_id ? null : row.project_id,
          projectTitle: project?.name || null, schemeCount: 0, removed: input.removed, coverUrl: null };
        groups.set(id, group);
        if (group.projectId && project) projects.set(group.projectId, project.name);
      }
      group.schemeCount++;
      if (!group.workId) { group.workId = row.id; group.sourceVersion = row.source_version; group.title = row.title; }
      if (group.sourceVersion && !input.removed) group.coverUrl = `/api/video/multiview/works/${encodeURIComponent(group.workId!)}/source?version=${group.sourceVersion}&frame=0&thumbnail=1`;
    }
    after = rows.length === 128 ? rows[rows.length - 1].id : undefined;
  } while (after);
  const scope = createHash('sha256').update(JSON.stringify([user.id, input.q, input.projectId, input.removed])).digest('hex');
  let offset = 0;
  if (input.cursor) {
    let cursor: { scope?: string; offset?: number };
    try { cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString()); } catch { throw new MultiviewWorkError('记录分页已失效，请刷新。'); }
    if (cursor.scope !== scope || !Number.isSafeInteger(cursor.offset) || cursor.offset! < 0) throw new MultiviewWorkError('记录分页已失效，请刷新。');
    offset = cursor.offset!;
  }
  const filtered = Array.from(groups.values()).filter(row => (!input.projectId || row.projectId === input.projectId)
    && (!input.q || `${row.title} ${row.taskId} ${row.projectTitle || ''} ${(titles.get(row.id) || []).join(' ')}`.toLowerCase().includes(input.q.toLowerCase())))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const items = filtered.slice(offset, offset + 24);
  const creatorIds = Array.from(new Set(items.map(item => creators.get(item.id)).filter((id): id is string => Boolean(id))));
  const people = creatorIds.length ? await prisma.user.findMany({ where: { id: { in: creatorIds } }, select: { id: true, name: true, username: true, avatar_url: true } }) : [];
  const peopleById = new Map(people.map(person => [person.id, person]));
  for (const item of items) {
    const person = peopleById.get(creators.get(item.id) || '');
    const hasName = person && [person.name, person.username].some(value => value?.trim() && !isTechnicalUsername(value));
    item.creator = person && hasName ? { id: person.id, name: displayUserName(person), avatar_url: person.avatar_url } : null;
    item.cover = await recordCovers(user, item);
    item.coverUrl = item.cover.candidates[0]?.url || null;
  }
  return { items, total: filtered.length, projects: Array.from(projects, ([id, title]) => ({ id, title })),
    nextCursor: offset + 24 < filtered.length ? Buffer.from(JSON.stringify({ scope, offset: offset + 24 })).toString('base64url') : null };
}
