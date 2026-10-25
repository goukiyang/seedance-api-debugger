import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { realpath, stat, lstat, open } from 'node:fs/promises';
import path from 'node:path';
import type { Prisma, MultiviewWork } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { AuthError, type SessionUser } from '@/lib/auth/session';
import { assertInternalOnly } from '@/lib/access/feature-guard';
import { assertCanViewTask, getTaskWhereForUser } from '@/lib/projects/permissions';
import { isTaskHiddenFromRegularUsers } from '@/lib/tasks/retention';
import { multiviewInfoForWork, multiviewSourceVersion, MultiviewError } from './multiview';
import type { MultiviewInfo } from './multiview-contract';
import { defaultMultiviewWorkRecipe, isMultiviewWorkId, isMultiviewWorkFileRole, parseMultiviewWorkRecipe,
  parseMultiviewWorkManifest, multiviewWorkRecipesEqual, type MultiviewWorkDto, type MultiviewWorkRecipe, type MultiviewWorkReceipt,
  type MultiviewWorkManifest, type MultiviewWorkList, type MultiviewWorkStatus } from './multiview-work-contract';

type Db = Prisma.TransactionClient;
type Json = Record<string, unknown>;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const multiviewWorkRecipeHash = (recipe: MultiviewWorkRecipe) => digest(JSON.stringify(recipe));
const baseId = (ownerId: string, taskId: string) => `mvw_${digest(JSON.stringify([ownerId, taskId])).slice(0, 48)}`;
const record = (value: unknown): value is Json => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const sourceBinding = (task: { local_status: string; local_video_path: string | null; public_video_url: string | null; result_video_url: string | null }) =>
  JSON.stringify([task.local_status, task.local_video_path, task.public_video_url, task.result_video_url]);
const mutationValid = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => record(entry) ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry);
}
export class MultiviewWorkError extends Error {
  constructor(message: string, public status = 400, public code = 'WORK_INVALID', public details: Json = {}) { super(message); }
}
const invalid = (message = '作品设置无效，原输入已保留。') => new MultiviewWorkError(message, 400, 'WORK_INVALID', { notCommitted: true });
const conflict = () => new MultiviewWorkError('作品已在其他页面更新，未覆盖服务器内容；请打开服务器版本或将本机修改另存。', 409, 'WORK_REVISION_CONFLICT', { notCommitted: true });
function title(value: unknown, fallback = '3D多视图作品') {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !value.trim() || value.length > 120) throw invalid('作品名称须为1–120字，原名称保留。');
  return value;
}
function readInfo(row: MultiviewWork): MultiviewInfo | null {
  if (!row.source_info_json) return null;
  let info: MultiviewInfo;
  try { info = JSON.parse(row.source_info_json); } catch { throw new MultiviewWorkError('作品来源记录暂时无法读取。', 503, 'WORK_STORAGE_INVALID'); }
  if (info.taskId !== row.source_task_id || info.sourceVersion !== row.source_version || !Number.isInteger(info.width) || !Number.isInteger(info.height)
    || info.width < 1 || info.height < 1 || !Array.isArray(info.timestamps) || info.timestamps.length < 8 || info.timestamps.length > 21600
    || info.timestamps.some(time => !Number.isFinite(time))) throw new MultiviewWorkError('作品来源记录暂时无法读取。', 503, 'WORK_STORAGE_INVALID');
  return info;
}
function readRecipe(row: MultiviewWork, ready = false) {
  const info = readInfo(row), raw = ready ? row.ready_recipe_json : row.recipe_json;
  if (!raw || !info) return null;
  const recipe = parseMultiviewWorkRecipe(raw, info);
  if (!recipe) throw new MultiviewWorkError('作品配方暂时无法读取，请保留本机修改。', 503, 'WORK_STORAGE_INVALID');
  return recipe;
}

/** Actual persisted account; no synthesized privileged session or public self-call. */
export async function multiviewWorkActor(ownerId: string, db: Db = prisma): Promise<SessionUser> {
  const row = await db.user.findUnique({ where: { id: ownerId } });
  if (!row || row.status !== 'active' || row.expires_at && row.expires_at.getTime() <= Date.now()
    || !['admin', 'user'].includes(row.role) || !['internal', 'external'].includes(row.account_type)) throw new AuthError('账号或授权已变化，请重新登录核对。', 403);
  const user: SessionUser = { id: row.id, name: row.name, username: row.username, email: row.email,
    role: row.role as SessionUser['role'], account_type: row.account_type as SessionUser['account_type'],
    status: 'active', expires_at: row.expires_at, user_profile: row.user_profile, feature_profile_id: row.feature_profile_id,
    feishu: { user_id: row.feishu_user_id, open_id: row.feishu_open_id, union_id: row.feishu_union_id,
      tenant_key: null, employee_no: null, department_ids: [], last_sync_at: null } };
  assertInternalOnly(user, '外部账号无权使用3D多视图作品。');
  return user;
}
async function currentActor(user: SessionUser, db: Db = prisma) {
  const current = await multiviewWorkActor(user.id, db);
  if (current.role !== user.role || current.account_type !== user.account_type || current.feature_profile_id !== user.feature_profile_id
    || current.user_profile !== user.user_profile || current.expires_at?.getTime() !== user.expires_at?.getTime()
    || (current.feishu?.user_id || null) !== (user.feishu?.user_id || null)
    || (current.feishu?.open_id || null) !== (user.feishu?.open_id || null)
    || (current.feishu?.union_id || null) !== (user.feishu?.union_id || null)) throw new AuthError('账号或授权已变化，请重新登录核对。', 403);
  return current;
}
export async function assertMultiviewWorkSource(user: SessionUser, taskId: string, db: Db = prisma) {
  if (!isMultiviewWorkId(taskId)) throw invalid('来源视频编号无效。');
  await currentActor(user, db);
  const task = await db.videoTask.findUnique({ where: { id: taskId } });
  if (!task) throw new AuthError('来源视频不存在或已删除，无法读取作品。', 404);
  if (isTaskHiddenFromRegularUsers(task)) throw new AuthError('来源视频已删除或隐藏，无法读取作品。', 404);
  if (db === prisma) await assertCanViewTask(user, task);
  else if (user.role !== 'admin') {
    // Recheck the existing permission contract within the write snapshot too.
    if (isTaskHiddenFromRegularUsers(task)) throw new AuthError('任务不存在或已删除', 404);
    if (task.project_id) {
      const project = await db.project.findUnique({ where: { id: task.project_id }, include: { members: { where: { user_id: user.id }, take: 1 } } });
      if (!project || project.status === 'deleted' || project.owner_user_id !== user.id
        && (!['team', 'public'].includes(project.type) || project.members[0]?.status !== 'active')) throw new AuthError('无权查看来源项目。', 403);
    } else if ((task.owner_user_id || task.user_id) !== user.id) throw new AuthError('无权查看来源视频。', 403);
  }
  return task;
}
async function ownedWork(user: SessionUser, workId: string, db: Db = prisma) {
  if (!isMultiviewWorkId(workId)) throw invalid('作品编号无效。');
  const row = await db.multiviewWork.findFirst({ where: { id: workId, owner_id: user.id } });
  if (!row) throw new AuthError('作品不存在或不可访问。', 404);
  await assertMultiviewWorkSource(user, row.source_task_id, db);
  return row;
}
async function dto(user: SessionUser, row: MultiviewWork): Promise<MultiviewWorkDto> {
  await assertMultiviewWorkSource(user, row.source_task_id);
  let sourceState: MultiviewWorkDto['sourceState'] = 'unavailable';
  if (row.source_version) {
    try { sourceState = await multiviewSourceVersion(user, row.source_task_id) === row.source_version ? 'current' : 'changed'; }
    catch (error) { if (!(error instanceof MultiviewError) || ![404, 409, 503].includes(error.status)) throw error; }
  }
  const recipe = readRecipe(row), readyRecipe = readRecipe(row, true);
  let ready: MultiviewWorkDto['ready'] = null;
  if (row.ready_revision !== null && readyRecipe) {
    const manifest = parseMultiviewWorkManifest(row.ready_manifest_json, readyRecipe, row.ready_revision, multiviewWorkRecipeHash(readyRecipe));
    if (!manifest) throw new MultiviewWorkError('作品成品清单暂时无法读取。', 503, 'WORK_STORAGE_INVALID');
    ready = { revision: row.ready_revision, recipe: readyRecipe, width: manifest.width, height: manifest.height, frameCount: manifest.frameCount,
      files: manifest.files.map(file => ({ role: file.role, mime: file.mime, bytes: file.bytes, width: file.width, height: file.height,
        url: `/api/video/multiview/works/${encodeURIComponent(row.id)}/files/${encodeURIComponent(file.role)}?readyRevision=${row.ready_revision}` })) };
  }
  const project = row.project_id ? await prisma.project.findUnique({ where: { id: row.project_id }, select: { name: true } }) : null;
  await assertMultiviewWorkSource(user, row.source_task_id);
  return { id: row.id, title: row.title, sourceTaskId: row.source_task_id, sourceVersion: row.source_version,
    projectId: row.project_id, projectTitle: project?.name || null, videoCardId: row.video_card_id, parentWorkId: row.parent_work_id,
    revision: row.revision, draftRevision: row.draft_revision, recipe, info: readInfo(row), status: row.status as MultiviewWorkStatus,
    removed: row.removed_at !== null, sourceState, ready, lastError: row.last_error, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() };
}
export async function getMultiviewWork(user: SessionUser, workId: string) { return dto(user, await ownedWork(user, workId)); }

export async function listMultiviewWorks(user: SessionUser, input: { projectId?: string; taskId?: string; q?: string; removed?: boolean; cursor?: string }): Promise<MultiviewWorkList> {
  await currentActor(user);
  if (input.projectId && !isMultiviewWorkId(input.projectId) || input.taskId && !isMultiviewWorkId(input.taskId)
    || input.q && input.q.length > 120 || input.cursor && input.cursor.length > 512) throw invalid('作品筛选条件无效。');
  const scope = digest(stable({ owner: user.id, ...input, cursor: undefined }));
  let cursor: { at: string; id: string; scope: string } | null = null;
  if (input.cursor) {
    try { cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')); } catch { throw invalid('作品翻页位置失效，请重新读取。'); }
    if (!cursor || cursor.scope !== scope || !isMultiviewWorkId(cursor.id) || !Number.isFinite(Date.parse(cursor.at))) throw invalid('作品翻页位置失效，请重新读取。');
  }
  const taskWhere = await getTaskWhereForUser(user);
  const where: Prisma.MultiviewWorkWhereInput = { owner_id: user.id, removed_at: input.removed ? { not: null } : null,
    ...(input.taskId ? { source_task_id: input.taskId } : { source_version: { not: null } }),
    ...(input.q ? { title: { contains: input.q } } : {}) };
  let scan: string | undefined, total = 0;
  const selected: Array<{ id: string; updated_at: Date }> = [];
  const projects = new Map<string, string>();
  // Scan bounded metadata batches for the exact permission-filtered count;
  // only the chosen 24 rows receive recipes/file projections, never all media.
  while (true) {
    const rows = await prisma.multiviewWork.findMany({ where, take: 128, orderBy: [{ updated_at: 'desc' }, { id: 'desc' }],
      ...(scan ? { cursor: { id: scan }, skip: 1 } : {}), select: { id: true, source_task_id: true, project_id: true, updated_at: true } });
    if (!rows.length) break;
    const tasks = await prisma.videoTask.findMany({ where: { AND: [taskWhere as Prisma.VideoTaskWhereInput,
      { id: { in: Array.from(new Set(rows.map(row => row.source_task_id))) } }] }, select: { id: true, project: { select: { id: true, name: true } } } });
    const allowed = new Map(tasks.map(task => [task.id, task]));
    for (const row of rows) {
      const task = allowed.get(row.source_task_id); if (!task) continue;
      if (task.project) projects.set(task.project.id, task.project.name);
      if (input.projectId && row.project_id !== input.projectId) continue;
      total += 1;
      if (cursor && (row.updated_at.getTime() > Date.parse(cursor.at) || row.updated_at.getTime() === Date.parse(cursor.at) && row.id >= cursor.id)) continue;
      if (selected.length < 25) selected.push(row);
    }
    scan = rows[rows.length - 1].id;
    if (rows.length < 128) break;
  }
  const page = selected.slice(0, 24), last = page[page.length - 1];
  const works = [];
  for (const row of page) works.push(await getMultiviewWork(user, row.id));
  let preferredWorkId: string | null | undefined;
  if (input.taskId) {
    await assertMultiviewWorkSource(user, input.taskId);
    const target = { owner_id: user.id, source_task_id: input.taskId, removed_at: null };
    // Render completion updates updated_at too. Prefer the last real accepted
    // user save/branch receipt, independent of list pagination or background IO.
    const lastEdit = await prisma.multiviewWorkMutation.findFirst({ where: { actor_id: user.id,
      action: { in: ['create', 'save', 'branch'] }, work: target }, orderBy: [{ created_at: 'desc' }, { id: 'desc' }], select: { work_id: true } });
    preferredWorkId = lastEdit?.work_id ?? (await prisma.multiviewWork.findFirst({ where: target,
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }], select: { id: true } }))?.id ?? null;
  }
  return { works, total, projects: Array.from(projects, ([id, projectTitle]) => ({ id, title: projectTitle })),
    ...(preferredWorkId !== undefined ? { preferredWorkId } : {}),
    nextCursor: selected.length > 24 && last ? Buffer.from(JSON.stringify({ scope, at: last.updated_at.toISOString(), id: last.id })).toString('base64url') : null };
}

async function receipt(user: SessionUser, mutationId: string, db: Db = prisma) {
  if (!mutationValid(mutationId)) throw invalid('作品保存编号无效。');
  const row = await db.multiviewWorkMutation.findUnique({ where: { actor_id_mutation_id: { actor_id: user.id, mutation_id: mutationId } } });
  if (!row) return null;
  let value: MultiviewWorkReceipt;
  try { value = JSON.parse(row.receipt_json); } catch { throw new MultiviewWorkError('原保存回执暂时无法确认。', 503, 'WORK_RECEIPT_UNKNOWN'); }
  if (value.state !== 'committed' || value.mutationId !== mutationId || value.workId !== row.work_id) throw new MultiviewWorkError('原保存回执暂时无法确认。', 503, 'WORK_RECEIPT_UNKNOWN');
  return { row, value };
}
async function priorMutation(user: SessionUser, input: Json, action: MultiviewWorkReceipt['action'], workId: string | null) {
  if (!mutationValid(input.mutationId)) throw invalid('作品保存编号无效。');
  const previous = await receipt(user, input.mutationId);
  if (!previous) return null;
  if (previous.row.request_hash !== digest(stable({ action, workId, input }))) throw new MultiviewWorkError('原保存编号已用于不同内容，请先查询原回执。', 409, 'WORK_MUTATION_CONFLICT');
  return { receipt: previous.value, work: await getMultiviewWork(user, previous.value.workId) };
}
export async function readMultiviewWorkMutation(user: SessionUser, mutationId: string) {
  await currentActor(user);
  const found = await receipt(user, mutationId);
  if (!found) return { state: 'not_found' as const, mutationId };
  await ownedWork(user, found.value.workId);
  return found.value;
}
async function mutation(user: SessionUser, input: Json, action: MultiviewWorkReceipt['action'], workId: string | null,
  perform: (db: Db) => Promise<MultiviewWork>) {
  if (!mutationValid(input.mutationId)) throw invalid('作品保存编号无效。');
  const mutationId = input.mutationId, requestHash = digest(stable({ action, workId, input }));
  const replay = async (db: Db) => {
    const found = await receipt(user, mutationId, db);
    if (!found) return null;
    if (found.row.request_hash !== requestHash) throw new MultiviewWorkError('原保存编号已用于不同内容，请先查询原回执。', 409, 'WORK_MUTATION_CONFLICT');
    return found.value;
  };
  let saved = await replay(prisma);
  if (!saved) {
    try {
      saved = await prisma.$transaction(async db => {
        await currentActor(user, db);
        const previous = await replay(db); if (previous) return previous;
        const row = await perform(db);
        const result: MultiviewWorkReceipt = { state: 'committed', mutationId, action, workId: row.id, revision: row.revision, draftRevision: row.draft_revision };
        await db.multiviewWorkMutation.create({ data: { actor_id: user.id, mutation_id: mutationId, work_id: row.id,
          request_hash: requestHash, base_revision: typeof input.baseRevision === 'number' ? input.baseRevision : null, action, receipt_json: JSON.stringify(result) } });
        await db.operationLog.create({ data: { operator_id: user.id, action: `multiview_work_${action}`, target_type: 'MultiviewWork', target_id: row.id,
          detail: JSON.stringify({ mutationId, revision: row.revision, draftRevision: row.draft_revision, requestHash }) } });
        return result;
      });
    } catch (error) {
      if (error instanceof AuthError || error instanceof MultiviewWorkError) throw error;
      saved = await replay(prisma);
      if (!saved) throw new MultiviewWorkError('作品保存结果待确认，请保留本机修改并查询原保存编号。', 503, 'WORK_SAVE_UNKNOWN');
    }
  }
  return { receipt: saved, work: await getMultiviewWork(user, saved.workId) };
}

export async function createMultiviewWork(user: SessionUser, input: Json) {
  if (Object.keys(input).some(key => !['mutationId', 'taskId', 'sourceVersion', 'recipe', 'title'].includes(key))
    || !isMultiviewWorkId(input.taskId) || typeof input.sourceVersion !== 'string' || !/^[a-f0-9]{64}$/.test(input.sourceVersion)) throw invalid();
  const taskId = input.taskId, version = input.sourceVersion;
  const prior = await priorMutation(user, input, 'create', null); if (prior) return prior;
  await assertMultiviewWorkSource(user, taskId);
  const existing = await prisma.multiviewWork.findUnique({ where: { owner_id_source_task_id_base_key: { owner_id: user.id, source_task_id: taskId, base_key: 'base' } } });
  if (existing?.source_version && existing.source_version !== version) throw new MultiviewWorkError('原视频已变化，已有作品保留，请打开原作品核对。', 409, 'WORK_SOURCE_CHANGED', { workId: existing.id, notCommitted: true });
  const info = await multiviewInfoForWork(user, taskId, version);
  const frozenSourceBinding = sourceBinding(await assertMultiviewWorkSource(user, taskId));
  if (await multiviewSourceVersion(user, taskId) !== version) throw new MultiviewWorkError('原视频已变化，本次未保存，已有作品保留。', 409, 'WORK_SOURCE_CHANGED', { notCommitted: true });
  const recipe = input.recipe === undefined ? defaultMultiviewWorkRecipe(info) : parseMultiviewWorkRecipe(input.recipe, info);
  if (!recipe) throw invalid();
  const recipeHash = multiviewWorkRecipeHash(recipe);
  return mutation(user, input, 'create', null, async db => {
    const source = await assertMultiviewWorkSource(user, taskId, db);
    if (sourceBinding(source) !== frozenSourceBinding) throw new MultiviewWorkError('原视频已变化，本次未保存，已有作品保留。', 409, 'WORK_SOURCE_CHANGED', { notCommitted: true });
    const previous = await db.multiviewWork.findUnique({ where: { owner_id_source_task_id_base_key: { owner_id: user.id, source_task_id: taskId, base_key: 'base' } } });
    if (previous?.recipe_json) {
      if (previous.source_version !== version || !multiviewWorkRecipesEqual(readRecipe(previous)!, recipe) || input.title !== undefined && title(input.title) !== previous.title)
        throw new MultiviewWorkError('已有同一来源作品，未覆盖服务器内容；本机修改可以另存一版。', 409, 'WORK_EXISTS', { workId: previous.id, notCommitted: true });
      return previous;
    }
    const data = { owner_id: user.id, source_task_id: taskId, project_id: source.project_id, video_card_id: source.video_card_id,
      source_version: version, source_info_json: JSON.stringify(info), title: title(input.title, previous?.title),
      draft_revision: 1, recipe_json: JSON.stringify(recipe), recipe_hash: recipeHash, status: 'queued', next_attempt_at: new Date(),
      lease_token: null, lease_until: null, attempts: 0, last_error: null };
    if (previous) return db.multiviewWork.update({ where: { id: previous.id }, data: { ...data, revision: { increment: 1 } } });
    return db.multiviewWork.create({ data: { id: baseId(user.id, taskId), base_key: 'base', ...data } });
  });
}
export async function mutateMultiviewWork(user: SessionUser, workId: string, input: Json) {
  if (!['save', 'branch', 'remove', 'restore'].includes(String(input.action)) || !Number.isSafeInteger(input.baseRevision)
    || Number(input.baseRevision) < 1 || Object.keys(input).some(key => !['mutationId', 'baseRevision', 'action', 'recipe', 'title', 'branchKey'].includes(key))) throw invalid();
  const action = input.action as 'save' | 'branch' | 'remove' | 'restore';
  const prior = await priorMutation(user, input, action, workId); if (prior) return prior;
  const before = await ownedWork(user, workId);
  let info = readInfo(before);
  let frozenSourceBinding: string | null = null;
  if (action === 'save' || action === 'branch') {
    if (!before.source_version || !info) throw invalid('原视频尚未归档，作品配方暂不能修改。');
    const current = await multiviewSourceVersion(user, before.source_task_id);
    if (current !== before.source_version) throw new MultiviewWorkError('原视频已变化，旧选帧未套用到新视频；原作品保留。', 409, 'WORK_SOURCE_CHANGED', { notCommitted: true });
    info = await multiviewInfoForWork(user, before.source_task_id, before.source_version);
    frozenSourceBinding = sourceBinding(await assertMultiviewWorkSource(user, before.source_task_id));
    if (await multiviewSourceVersion(user, before.source_task_id) !== before.source_version) throw new MultiviewWorkError('原视频已变化，本次未保存，已有作品保留。', 409, 'WORK_SOURCE_CHANGED', { notCommitted: true });
  }
  const recipe = input.recipe === undefined ? readRecipe(before) : info && parseMultiviewWorkRecipe(input.recipe, info);
  if ((action === 'save' || action === 'branch') && !recipe) throw invalid();
  if (action === 'branch' && (!mutationValid(input.branchKey) || input.branchKey.length > 100)) throw invalid('另存编号无效。');
  return mutation(user, input, action, workId, async db => {
    const row = await ownedWork(user, workId, db);
    if (row.revision !== input.baseRevision) throw conflict();
    if (frozenSourceBinding !== null && sourceBinding(await assertMultiviewWorkSource(user, row.source_task_id, db)) !== frozenSourceBinding)
      throw new MultiviewWorkError('原视频已变化，本次未保存，已有作品保留。', 409, 'WORK_SOURCE_CHANGED', { notCommitted: true });
    if (action === 'branch') {
      const branchKey = input.branchKey as string;
      const previous = await db.multiviewWork.findUnique({ where: { owner_id_branch_key: { owner_id: user.id, branch_key: branchKey } } });
      const hash = multiviewWorkRecipeHash(recipe!);
      if (previous) {
        if (previous.parent_work_id !== workId || previous.recipe_hash !== hash) throw new MultiviewWorkError('另存编号已有不同作品，原作品未覆盖。', 409, 'WORK_BRANCH_CONFLICT', { notCommitted: true });
        return previous;
      }
      return db.multiviewWork.create({ data: { id: `mvw_${digest(JSON.stringify([user.id, branchKey])).slice(0, 48)}`, owner_id: user.id,
        source_task_id: row.source_task_id, project_id: row.project_id, video_card_id: row.video_card_id, parent_work_id: row.id,
        branch_key: branchKey, title: title(input.title, `${row.title.slice(0, 114)}（另存）`), source_version: row.source_version,
        source_info_json: row.source_info_json, draft_revision: 1, recipe_json: JSON.stringify(recipe), recipe_hash: hash, status: 'queued' } });
    }
    const patch: Prisma.MultiviewWorkUpdateManyMutationInput = { revision: { increment: 1 } };
    if (action === 'remove' || action === 'restore') patch.removed_at = action === 'remove' ? new Date() : null;
    else {
      if (row.removed_at) throw new MultiviewWorkError('作品已移出，请先恢复再编辑。', 409, 'WORK_REMOVED', { notCommitted: true });
      patch.title = title(input.title, row.title);
      const hash = multiviewWorkRecipeHash(recipe!);
      if (!multiviewWorkRecipesEqual(readRecipe(row)!, recipe!)) Object.assign(patch, { draft_revision: row.draft_revision + 1, recipe_json: JSON.stringify(recipe), recipe_hash: hash,
        status: 'queued', next_attempt_at: new Date(), attempts: 0, last_error: null, lease_token: null, lease_until: null });
      else if (row.status === 'failed') Object.assign(patch, { status: 'queued', next_attempt_at: new Date(), attempts: 0,
        last_error: null, lease_token: null, lease_until: null });
    }
    const updated = await db.multiviewWork.updateMany({ where: { id: row.id, owner_id: user.id, revision: Number(input.baseRevision) }, data: patch });
    if (updated.count !== 1) throw conflict();
    return db.multiviewWork.findUniqueOrThrow({ where: { id: row.id } });
  });
}

export async function registerMultiviewWorkIntent(db: Db, input: { ownerId: string; taskId: string; projectId: string | null; videoCardId: string | null }) {
  return db.multiviewWork.upsert({ where: { owner_id_source_task_id_base_key: { owner_id: input.ownerId, source_task_id: input.taskId, base_key: 'base' } },
    create: { id: baseId(input.ownerId, input.taskId), owner_id: input.ownerId, source_task_id: input.taskId, project_id: input.projectId,
      video_card_id: input.videoCardId, base_key: 'base', status: 'waiting_source' }, update: {} });
}
export type MultiviewWorkLease = {
  workId: string; ownerId: string; sourceTaskId: string; sourceVersion: string | null; info: MultiviewInfo | null;
  recipe: MultiviewWorkRecipe | null; revision: number; draftRevision: number; recipeHash: string | null; token: string;
};
const leaseOf = (row: MultiviewWork): MultiviewWorkLease => ({ workId: row.id, ownerId: row.owner_id, sourceTaskId: row.source_task_id,
  sourceVersion: row.source_version, info: readInfo(row), recipe: readRecipe(row), revision: row.revision,
  draftRevision: row.draft_revision, recipeHash: row.recipe_hash, token: row.lease_token! });
const leaseWhere = (lease: MultiviewWorkLease): Prisma.MultiviewWorkWhereInput => ({ id: lease.workId, owner_id: lease.ownerId,
  lease_token: lease.token, lease_until: { gt: new Date() }, draft_revision: lease.draftRevision, recipe_hash: lease.recipeHash });
export async function claimNextMultiviewWork(): Promise<MultiviewWorkLease | null> {
  return prisma.$transaction(async db => {
    const now = new Date();
    const available: Prisma.MultiviewWorkWhereInput = { attempts: { lt: 5 }, next_attempt_at: { lte: now },
      OR: [{ status: { in: ['waiting_source', 'queued', 'failed'] }, OR: [{ lease_until: null }, { lease_until: { lte: now } }] },
        { status: 'rendering', lease_until: { lte: now } }] };
    const row = await db.multiviewWork.findFirst({ where: available, orderBy: [{ next_attempt_at: 'asc' }, { id: 'asc' }] });
    if (!row) return null;
    const changed = await db.multiviewWork.updateMany({ where: { AND: [{ id: row.id }, available] }, data: { status: 'rendering', lease_token: randomUUID(),
      lease_until: new Date(Date.now() + 10 * 60 * 1000), attempts: { increment: row.recipe_json ? 1 : 0 } } });
    return changed.count === 1 ? leaseOf(await db.multiviewWork.findUniqueOrThrow({ where: { id: row.id } })) : null;
  });
}
export async function initializeMultiviewWork(lease: MultiviewWorkLease, info: MultiviewInfo): Promise<MultiviewWorkLease | null> {
  if (lease.sourceVersion || lease.recipe || info.taskId !== lease.sourceTaskId) return null;
  const recipe = defaultMultiviewWorkRecipe(info);
  if (!parseMultiviewWorkRecipe(recipe, info)) throw invalid('视频初始选帧记录无效。');
  const user = await multiviewWorkActor(lease.ownerId);
  await assertMultiviewWorkSource(user, lease.sourceTaskId);
  if (await multiviewSourceVersion(user, lease.sourceTaskId) !== info.sourceVersion) return null;
  return prisma.$transaction(async db => {
    await assertMultiviewWorkSource(user, lease.sourceTaskId, db);
    const changed = await db.multiviewWork.updateMany({ where: { ...leaseWhere(lease), source_version: null, recipe_json: null },
      data: { source_version: info.sourceVersion, source_info_json: JSON.stringify(info), recipe_json: JSON.stringify(recipe),
        recipe_hash: multiviewWorkRecipeHash(recipe), draft_revision: 1, revision: { increment: 1 }, attempts: 1 } });
    return changed.count === 1 ? leaseOf(await db.multiviewWork.findUniqueOrThrow({ where: { id: lease.workId } })) : null;
  });
}
export async function completeMultiviewWork(lease: MultiviewWorkLease, manifest: MultiviewWorkManifest): Promise<boolean> {
  if (!lease.recipe || !lease.recipeHash || !parseMultiviewWorkManifest(manifest, lease.recipe, lease.draftRevision, lease.recipeHash)) throw invalid('成品清单不完整，未标记保存成功。');
  const user = await multiviewWorkActor(lease.ownerId);
  await assertMultiviewWorkSource(user, lease.sourceTaskId);
  if (await multiviewSourceVersion(user, lease.sourceTaskId) !== lease.sourceVersion) return false;
  return prisma.$transaction(async db => {
    await assertMultiviewWorkSource(user, lease.sourceTaskId, db);
    const changed = await db.multiviewWork.updateMany({ where: leaseWhere(lease), data: { status: 'ready', ready_revision: lease.draftRevision,
      ready_recipe_json: JSON.stringify(lease.recipe), ready_manifest_json: JSON.stringify(manifest), lease_token: null, lease_until: null, last_error: null } });
    return changed.count === 1;
  });
}
export async function failMultiviewWork(lease: MultiviewWorkLease, message: string, options: { waitingSource?: boolean; resourceWait?: boolean; retryable?: boolean; sourceChanged?: boolean } = {}) {
  const waiting = options.waitingSource || options.resourceWait;
  await prisma.multiviewWork.updateMany({ where: leaseWhere(lease), data: { status: options.sourceChanged ? 'source_changed' : options.waitingSource ? 'waiting_source' : options.resourceWait ? 'queued' : 'failed',
    last_error: message.slice(0, 240), lease_token: null, lease_until: null,
    ...(options.retryable === false || options.sourceChanged ? { attempts: 5 } : waiting && lease.recipe ? { attempts: { decrement: 1 } } : {}),
    next_attempt_at: new Date(Date.now() + (options.waitingSource ? 30000 : 60000)) } });
}
export async function wakeMultiviewWorkForTask(taskId: string) {
  await prisma.multiviewWork.updateMany({ where: { source_task_id: taskId, status: 'waiting_source' }, data: { next_attempt_at: new Date() } });
}

export async function multiviewWorkDirectory(ownerId: string, workId: string, revision: number) {
  if (!isMultiviewWorkId(ownerId) || !isMultiviewWorkId(workId) || !Number.isSafeInteger(revision) || revision < 1) throw invalid('作品文件标识无效。');
  if (process.env.NODE_ENV === 'production') {
    const [data, system] = await Promise.all([stat('/data'), stat('/')]);
    if (!data.isDirectory() || data.dev === system.dev) throw new MultiviewWorkError('数据盘暂不可用，已保存成果保持不变。', 503, 'WORK_STORAGE_UNAVAILABLE');
  }
  const root = process.env.NODE_ENV === 'production' ? '/data/video-api-debugger/var-lib/storage/multiview-works' : path.join(process.cwd(), '.cache', 'multiview-works');
  return path.join(root, ownerId, workId, String(revision));
}
/** Read-only: the content hash of the current ready collage/frame, used to find the library asset it was saved as. */
export async function multiviewWorkReadyFileHash(user: SessionUser, workId: string, role: string) {
  if (role !== 'collage' && !role.startsWith('frame-') || !isMultiviewWorkFileRole(role)) throw invalid('只能使用拼图或单张作为参考图。');
  const row = await ownedWork(user, workId), recipe = readRecipe(row, true);
  const manifest = recipe && row.ready_revision !== null ? parseMultiviewWorkManifest(row.ready_manifest_json, recipe, row.ready_revision, multiviewWorkRecipeHash(recipe)) : null;
  const entry = manifest?.files.find(file => file.role === role);
  if (!entry) throw new MultiviewWorkError('该作品成品尚未准备好。', 404, 'WORK_FILE_UNAVAILABLE');
  return entry.sha256;
}
export async function readMultiviewWorkFile(user: SessionUser, workId: string, role: string, readyRevision: number) {
  if (!isMultiviewWorkFileRole(role) || !Number.isSafeInteger(readyRevision) || readyRevision < 1) throw invalid('作品文件或版本无效。');
  const row = await ownedWork(user, workId), recipe = readRecipe(row, true);
  if (!recipe || row.ready_revision !== readyRevision) throw new MultiviewWorkError('作品成品版本已变化，请重新读取当前作品。', 409, 'WORK_READY_CHANGED');
  const manifest = parseMultiviewWorkManifest(row.ready_manifest_json, recipe, readyRevision, multiviewWorkRecipeHash(recipe));
  const entry = manifest?.files.find(file => file.role === role);
  if (!entry) throw new MultiviewWorkError('该作品文件尚未准备好。', 404, 'WORK_FILE_UNAVAILABLE');
  const directory = await multiviewWorkDirectory(user.id, workId, readyRevision), expected = path.join(directory, entry.file);
  const before = await lstat(expected).catch(() => null);
  const actual = await realpath(expected).catch(() => null);
  if (!before || !before.isFile() || before.isSymbolicLink() || !actual || actual !== expected)
    throw new MultiviewWorkError('作品文件暂不可用，原配方与上次成果保留。', 503, 'WORK_FILE_UNAVAILABLE');
  if (typeof constants.O_NOFOLLOW !== 'number') throw new MultiviewWorkError('当前文件系统不支持安全读取作品文件。', 503, 'WORK_STORAGE_UNAVAILABLE');
  const handle = await open(expected, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const bound = (metadata: Stats) => metadata.isFile() && metadata.dev === before.dev && metadata.ino === before.ino
      && metadata.size === entry.bytes && metadata.nlink === 1 && [0o400, 0o600].includes(metadata.mode & 0o777)
      && (typeof process.getuid !== 'function' || metadata.uid === process.getuid());
    if (!bound(await handle.stat())) throw new MultiviewWorkError('作品文件身份或私有权限已变化，请重新读取。', 503, 'WORK_FILE_UNAVAILABLE');
    const magic = Buffer.alloc(8); const { bytesRead } = await handle.read(magic, 0, 8, 0);
    const valid = entry.mime === 'image/png' ? magic.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : entry.mime === 'image/jpeg' ? magic[0] === 255 && magic[1] === 216 : magic[0] === 80 && magic[1] === 75;
    if (bytesRead !== 8 || !valid) throw new MultiviewWorkError('作品文件格式不完整，请稍后重试。', 503, 'WORK_FILE_UNAVAILABLE');
    const fresh = await ownedWork(user, workId);
    if (fresh.ready_revision !== readyRevision) throw new MultiviewWorkError('作品成品版本已变化，请重新读取当前作品。', 409, 'WORK_READY_CHANGED');
    if (!bound(await handle.stat())) throw new MultiviewWorkError('作品文件身份或私有权限已变化，请重新读取。', 503, 'WORK_FILE_UNAVAILABLE');
    // Ownership transfers to the route: HEAD closes it, GET streams this exact
    // descriptor with autoClose, and every failed branch below closes it.
    return { path: actual, handle, ...entry, etag: `"${entry.sha256}"`, revision: readyRevision };
  } catch (error) { await handle.close().catch(() => undefined); throw error; }
}
