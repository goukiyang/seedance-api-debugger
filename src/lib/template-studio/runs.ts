import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { SessionUser } from '@/lib/auth/session';
import { fileExists, thumbnailFilePath } from '@/lib/video/thumbnail';
import { canRequestTaskThumbnail, shouldExposeTaskThumbnailUrl } from '@/lib/video/thumbnail-availability';
import { authorizeStudioAssets } from './assets';
import { encodeCursor, makeFingerprint, parseCursor } from './common';
import { getStudioCapabilities } from './capabilities';
import { readVideoGlobalContext, readVideoModuleContext } from './context';
import { publicRunSnapshot, visibleRunPrompt } from './projection';
import { StudioError } from './errors';
import { isStudioTextModel } from './text-models';
import { ensureStudioSnapshotSourceStillUsable } from './handoff';
import {
  normalizeAssets,
  normalizeParameters,
  normalizeValues,
  stableJson,
  TEMPLATE_STUDIO_LIMITS,
} from './validation';
import type {
  CreateStudioRunRequest,
  StudioRunDetailResponse,
  StudioRunDto,
  StudioRunSnapshot,
  StudioRunListQuery,
  StudioRunStatus,
  StudioRunTaskDto,
  StudioTemplateSource,
} from './types';

type RunWithOwner = Prisma.VideoStudioRunGetPayload<{ include: { owner: { select: { id: true; username: true; name: true; account_type: true } } } }>;

function dto(row: { id: string; draft_id: string; request_id: string; source: string; mode: string; model?: string | null; status: string; prompt: string | null; snapshot_json: string; error_message: string | null; created_at: Date; updated_at: Date }, projection: { thumbnailUrl?: string | null; taskCount?: number } = {}): StudioRunDto {
  const snapshot = decodeSnapshot(row.snapshot_json);
  const owner = snapshot.owner;
  return {
    llmModel: snapshot.llmModel || row.model || null,
    owner: { displayName: owner.displayName, avatarUrl: owner.avatarUrl || null },
    id: row.id,
    draftId: row.draft_id,
    requestId: row.request_id,
    source: row.source as StudioRunDto['source'],
    mode: row.mode as StudioRunDto['mode'],
    status: row.status as StudioRunStatus,
    prompt: visibleRunPrompt(row),
    error: row.error_message,
    thumbnailUrl: projection.thumbnailUrl || null,
    taskCount: projection.taskCount || 0,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function draftSnapshot(row: any, user: SessionUser, mode: 'direct' | 'llm'): StudioRunSnapshot {
  let template: StudioRunSnapshot['templateVersion'] = null;
  let recipe: StudioRunSnapshot['recipe'] = null;
  if (row.template_snapshot_json) {
    try {
      const data = JSON.parse(row.template_snapshot_json) as { ref?: StudioRunSnapshot['templateVersion']; recipe?: StudioRunSnapshot['recipe'] };
      if (!data.ref || !data.recipe) throw new Error('invalid');
      template = data.ref;
      recipe = data.recipe;
    } catch {
      throw new StudioError('草稿模板快照无法读取', 500, 'UNAVAILABLE');
    }
  }
  const values = normalizeValues(JSON.parse(row.values_json), recipe, { mode: mode === 'llm' ? 'draft' : 'strict' });
  const assets = normalizeAssets(JSON.parse(row.assets_json), recipe, mode === 'direct');
  const parameters = normalizeParameters(JSON.parse(row.parameters_json));
  const prompt = [
    ...(recipe?.fields || []).flatMap((field) => values[field.key] === undefined ? [] : [`${field.label}: ${String(values[field.key])}`]),
    row.prompt?.trim(),
  ].filter((part): part is string => typeof part === 'string' && Boolean(part.trim())).join('\n\n');
  if (!prompt.trim()) throw new StudioError('提示词不能为空', 400, 'INVALID');
  if (prompt.length > TEMPLATE_STUDIO_LIMITS.llmInput) throw new StudioError('合并后的提示词内容过长', 400, 'INVALID');
  return {
    input: { name: row.name, groupName: row.group_name, values, draftPrompt: row.prompt },
    templateVersion: template,
    recipe,
    prompt,
    parameters,
    assets,
    owner: { userId: user.id, username: user.username, displayName: user.name || user.username, avatarUrl: user.avatar_url || null, accountType: user.account_type },
  };
}

function decodeSnapshot(json: string): StudioRunSnapshot {
  try {
    const value = JSON.parse(json) as StudioRunSnapshot;
    if (!value || typeof value.prompt !== 'string' || !value.input || !value.owner || !Array.isArray(value.assets)) throw new Error('invalid');
    return value;
  } catch {
    throw new StudioError('运行快照无法读取', 500, 'UNAVAILABLE');
  }
}

function safeUsage(usage: unknown) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const source = usage as Record<string, unknown>;
  const result: Record<string, number> = {};
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) result[key] = Math.floor(value);
  }
  return Object.keys(result).length ? result : null;
}

function isUniqueConflict(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function responseStatus(run: { mode: string; status: string }) {
  return run.mode === 'llm' && (run.status === 'queued' || run.status === 'running') ? 202 : 200;
}

function assertIdempotentSemantics(run: { draft_id: string; draft_revision: number; mode: string; snapshot_json: string; model: string | null }, input: CreateStudioRunRequest) {
  if (run.draft_id !== input.draftId || run.draft_revision !== input.revision || run.mode !== input.mode) {
    throw new StudioError('requestId 已用于不同的草稿修订或运行模式', 409, 'CONFLICT');
  }
  if (input.llmModel !== undefined && input.llmModel !== (decodeSnapshot(run.snapshot_json).llmModel || run.model)) {
    throw new StudioError('这次请求已使用另一个文案模型，请先查看原记录，不要重复提交', 409, 'CONFLICT');
  }
}

async function projectRunList(rows: Array<{ id: string }>, ownerUserId: string) {
  if (!rows.length) return new Map<string, { thumbnailUrl: string | null; taskCount: number }>();
  const tasks = await prisma.videoTask.findMany({
    where: { template_studio_run_id: { in: rows.map((row) => row.id) }, owner_user_id: ownerUserId },
    select: { id: true, template_studio_run_id: true, local_status: true, result_video_url: true, public_video_url: true, local_video_path: true, result_last_frame_url: true },
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
  });
  const result = new Map<string, { thumbnailUrl: string | null; taskCount: number }>();
  const candidates = new Map<string, Array<typeof tasks[number]>>();
  for (const task of tasks) {
    const runId = task.template_studio_run_id;
    if (!runId) continue;
    const current = result.get(runId) || { thumbnailUrl: null, taskCount: 0 };
    current.taskCount += 1;
    result.set(runId, current);
    const runCandidates = candidates.get(runId) || [];
    runCandidates.push(task);
    candidates.set(runId, runCandidates);
  }
  const cached = new Map<string, boolean>();
  await Promise.all(Array.from(candidates.values()).flat().map(async (task) => {
    cached.set(task.id, await fileExists(thumbnailFilePath(task.id)));
  }));
  for (const [runId, runCandidates] of Array.from(candidates.entries())) {
    const sourceFor = (task: typeof tasks[number]) => ({
      publicVideoUrl: task.public_video_url,
      localVideoPath: task.local_video_path,
      resultVideoUrl: task.result_video_url,
      resultLastFrameUrl: task.result_last_frame_url,
    });
    const task = runCandidates.find((candidate) => cached.get(candidate.id))
      || runCandidates.find((candidate) => canRequestTaskThumbnail(sourceFor(candidate)));
    if (task && shouldExposeTaskThumbnailUrl({ hasExistingThumbnail: cached.get(task.id), ...sourceFor(task) })) {
      result.get(runId)!.thumbnailUrl = `/api/video/thumbnail/${encodeURIComponent(task.id)}`;
    }
  }
  return result;
}

function parseRunDate(value: string | undefined, endOfDay = false) {
  if (!value) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new StudioError('日期筛选格式无效', 400, 'INVALID');
  if (dateOnly && endOfDay) parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed;
}

async function resolveRunTemplateFilter(user: SessionUser, templateId?: string, requestedSource?: string): Promise<{ id: string; source: StudioTemplateSource | 'unresolved' } | null> {
  if (!templateId) return null;
  let id = templateId.trim().slice(0, 240);
  let source = requestedSource;
  const prefix = /^(legacy|studio):(.*)$/.exec(id);
  if (prefix) {
    id = prefix[2];
    if (source && source !== prefix[1]) throw new StudioError('模板来源筛选互相冲突', 400, 'INVALID');
    source = prefix[1];
  }
  if (!id) throw new StudioError('模板 ID 无效', 400, 'INVALID');
  if (source && source !== 'legacy' && source !== 'studio') throw new StudioError('模板来源无效', 400, 'INVALID');
  if (!source) {
    const drafts = await prisma.videoStudioDraft.findMany({
      where: { owner_user_id: user.id, source_template_id: id, template_source: { in: ['legacy', 'studio'] } },
      select: { template_source: true },
      distinct: ['template_source'],
    });
    const sources = new Set(drafts.map((draft) => draft.template_source));
    if (sources.size > 1) throw new StudioError('模板 ID 同时对应新旧模板，请附带 template_source', 400, 'INVALID');
    source = drafts[0]?.template_source;
  }
  return { id, source: (source || 'unresolved') as StudioTemplateSource | 'unresolved' };
}

export async function createStudioRun(user: SessionUser, input: CreateStudioRunRequest) {
  if (!input || typeof input.draftId !== 'string' || !Number.isInteger(input.revision) || input.revision < 1
    || typeof input.requestId !== 'string' || !input.requestId.trim() || input.requestId.length > 120
    || !['direct', 'llm'].includes(input.mode)) throw new StudioError('运行参数无效', 400, 'INVALID');
  if (input.llmModel !== undefined && (input.mode !== 'llm' || !isStudioTextModel(input.llmModel))) {
    throw new StudioError('请选择列表中的文案模型', 400, 'INVALID');
  }
  const requestId = input.requestId.trim();
  const existingBeforeValidation = await prisma.videoStudioRun.findUnique({ where: { owner_user_id_request_id: { owner_user_id: user.id, request_id: requestId } } });
  if (existingBeforeValidation) {
    assertIdempotentSemantics(existingBeforeValidation, { ...input, requestId });
    return { run: dto(existingBeforeValidation), status: responseStatus(existingBeforeValidation) };
  }
  const draft = await prisma.videoStudioDraft.findFirst({ where: { id: input.draftId, owner_user_id: user.id } });
  if (!draft) throw new StudioError('草稿不存在或无权访问', 404, 'NOT_FOUND');
  if (draft.revision !== input.revision) throw new StudioError('草稿内容已变化，请刷新后重新提交', 409, 'CONFLICT', { currentRevision: draft.revision });
  const snapshot = draftSnapshot(draft, user, input.mode);
  const [globalContext, moduleContext] = await Promise.all([
    readVideoGlobalContext(), readVideoModuleContext(draft.id, snapshot.recipe?.instruction || ''),
  ]);
  snapshot.privateContext = { global: globalContext.context, module: moduleContext.context, globalRevision: globalContext.revision, moduleRevision: moduleContext.revision };
  if (snapshot.prompt.length + globalContext.context.length + moduleContext.context.length > TEMPLATE_STUDIO_LIMITS.llmInput) {
    throw new StudioError('上下文与本次输入合计过长，请缩短后再生成', 400, 'INVALID');
  }
  if (snapshot.templateVersion?.templateSource === 'legacy') {
    throw new StudioError('旧版模板请在原生成流程中使用', 409, 'CONFLICT', {
      applyMode: 'legacy-route',
      applyUrl: `/template-generate?templateId=${encodeURIComponent(snapshot.templateVersion.templateId)}`,
    });
  }
  await authorizeStudioAssets(user, snapshot.assets);
  await ensureStudioSnapshotSourceStillUsable(user, snapshot);
  if (input.mode === 'llm') {
    const acceptedSince = new Date(Date.now() - TEMPLATE_STUDIO_LIMITS.llmRequestWindowMs);
    const accepted = await prisma.videoStudioRun.count({ where: { owner_user_id: user.id, mode: 'llm', created_at: { gte: acceptedSince } } });
    if (accepted >= TEMPLATE_STUDIO_LIMITS.llmRequestsPerUserWindow) throw new StudioError('AI 整理提交较频繁，请稍后再试', 429, 'RATE_LIMITED');
    const capabilities = await getStudioCapabilities(user);
    if (!capabilities.llmEnabled) throw new StudioError(capabilities.llmReason || 'AI 整理当前不可用', 503, 'UNAVAILABLE');
    snapshot.llmModel = input.llmModel ?? capabilities.defaultLlmModel;
  }
  const fingerprint = makeFingerprint({ draftId: input.draftId, revision: input.revision, mode: input.mode, snapshot });

  try {
    const run = await prisma.$transaction(async (tx) => {
      const existing = await tx.videoStudioRun.findUnique({ where: { owner_user_id_request_id: { owner_user_id: user.id, request_id: requestId } } });
      if (existing) {
        assertIdempotentSemantics(existing, { ...input, requestId });
        return existing;
      }
      if (input.mode === 'llm') {
        const active = await tx.videoStudioRun.count({ where: { owner_user_id: user.id, mode: 'llm', status: { in: ['queued', 'running'] } } });
        if (active >= TEMPLATE_STUDIO_LIMITS.activeLlmRunsPerUser) throw new StudioError('已有 AI 整理任务正在处理，请稍后再提交', 429, 'RATE_LIMITED');
        const pending = await tx.videoStudioRun.count({ where: { mode: 'llm', status: { in: ['queued', 'running'] } } });
        if (pending >= TEMPLATE_STUDIO_LIMITS.maxPendingLlmRuns) throw new StudioError('AI 整理队列已满，请稍后再提交', 503, 'UNAVAILABLE');
        const accepted = await tx.videoStudioRun.count({ where: { owner_user_id: user.id, mode: 'llm', created_at: { gte: new Date(Date.now() - TEMPLATE_STUDIO_LIMITS.llmRequestWindowMs) } } });
        if (accepted >= TEMPLATE_STUDIO_LIMITS.llmRequestsPerUserWindow) throw new StudioError('AI 整理提交较频繁，请稍后再试', 429, 'RATE_LIMITED');
      }
      const result = await tx.videoStudioRun.create({
        data: {
          owner_user_id: user.id,
          draft_id: draft.id,
          draft_revision: input.revision,
          request_id: requestId,
          request_fingerprint: fingerprint,
          source: draft.template_source,
          mode: input.mode,
          model: snapshot.llmModel || null,
          status: input.mode === 'direct' ? 'succeeded' : 'queued',
          delivery_state: input.mode === 'direct' ? 'not_sent' : 'not_sent',
          prompt: input.mode === 'direct' ? snapshot.prompt : null,
          snapshot_json: JSON.stringify(snapshot),
          completed_at: input.mode === 'direct' ? new Date() : null,
        },
      });
      return result;
    });
    return { run: dto(run), status: responseStatus(run) };
  } catch (error) {
    if (!isUniqueConflict(error)) throw error;
    const existing = await prisma.videoStudioRun.findUnique({ where: { owner_user_id_request_id: { owner_user_id: user.id, request_id: requestId } } });
    if (!existing) throw error;
    assertIdempotentSemantics(existing, { ...input, requestId });
    return { run: dto(existing), status: responseStatus(existing) };
  }
}

export async function listStudioRuns(user: SessionUser, query: StudioRunListQuery) {
  if (query.status && !['queued', 'running', 'succeeded', 'failed', 'uncertain', 'cancelled'].includes(query.status)) throw new StudioError('运行状态筛选无效', 400, 'INVALID');
  const template = await resolveRunTemplateFilter(user, query.templateId, query.templateSource);
  const after = parseRunDate(query.createdAfter);
  const before = parseRunDate(query.createdBefore, true);
  if (after && before && after >= before) throw new StudioError('结束日期必须晚于开始日期', 400, 'INVALID');
  const cursor = parseCursor(query.cursor);
  const where = {
    owner_user_id: user.id,
    ...(query.requestId ? { request_id: query.requestId.slice(0, 120) } : {}),
    ...(query.draftId ? { draft_id: query.draftId.slice(0, 120) } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(template ? { draft: { is: { source_template_id: template.id, template_source: template.source } } } : {}),
    AND: [
      ...(after ? [{ created_at: { gte: after } }] : []),
      ...(before ? [{ created_at: { lt: before } }] : []),
      ...(cursor ? [{ OR: [{ created_at: { lt: cursor.date } }, { created_at: cursor.date, id: { lt: cursor.id } }] }] : []),
    ],
  };
  const rows = await prisma.videoStudioRun.findMany({ where, orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: 31 });
  const page = rows.slice(0, 30);
  const projected = await projectRunList(page, user.id);
  const last = page.at(-1);
  return {
    items: page.map((row) => dto(row, projected.get(row.id))),
    nextCursor: rows.length > 30 && last ? encodeCursor(`${last.created_at.toISOString()}|${last.id}`) : null,
  };
}

export async function getStudioRun(user: SessionUser, id: string): Promise<StudioRunDetailResponse> {
  const row = await prisma.videoStudioRun.findFirst({ where: { id, owner_user_id: user.id } });
  if (!row) throw new StudioError('运行记录不存在或无权访问', 404, 'NOT_FOUND');
  const snapshot = decodeSnapshot(row.snapshot_json);
  const tasks = await prisma.videoTask.findMany({
    where: { template_studio_run_id: id, owner_user_id: user.id },
    select: { id: true, local_status: true, delivery_status: true, created_at: true, result_video_url: true, public_video_url: true, local_video_path: true, result_last_frame_url: true },
    orderBy: { created_at: 'asc' },
  });
  const runTasks: StudioRunTaskDto[] = await Promise.all(tasks.map(async (task) => {
    const hasMedia = Boolean(task.result_video_url || task.public_video_url || task.local_video_path || task.result_last_frame_url);
    const hasCachedThumbnail = await fileExists(thumbnailFilePath(task.id));
    return {
      taskId: task.id,
      status: task.local_status,
      deliveryStatus: task.delivery_status,
      thumbnailUrl: hasMedia || hasCachedThumbnail ? `/api/video/thumbnail/${encodeURIComponent(task.id)}` : null,
      playUrl: task.local_status === 'succeeded' && hasMedia ? `/api/video/play/${encodeURIComponent(task.id)}` : null,
      downloadUrl: task.local_status === 'succeeded' && hasMedia ? `/api/video/download/${encodeURIComponent(task.id)}` : null,
      createdAt: task.created_at.toISOString(),
    };
  }));
  const thumbnails = await projectRunList([{ id: row.id }], user.id);
  return { run: dto(row, thumbnails.get(row.id)), snapshot: publicRunSnapshot(snapshot), tasks: runTasks };
}

export async function cancelStudioRun(user: SessionUser, id: string) {
  const update = await prisma.videoStudioRun.updateMany({
    where: { id, owner_user_id: user.id, status: 'queued', delivery_state: 'not_sent', lease_token: null },
    data: { status: 'cancelled', error_message: '已取消', completed_at: new Date(), updated_at: new Date() },
  });
  if (update.count !== 1) {
    const exists = await prisma.videoStudioRun.findFirst({ where: { id, owner_user_id: user.id }, select: { id: true } });
    if (!exists) throw new StudioError('运行记录不存在或无权访问', 404, 'NOT_FOUND');
    throw new StudioError('当前状态不能取消；已投递任务会保留查询，不会重复提交', 409, 'CONFLICT');
  }
  const row = await prisma.videoStudioRun.findUniqueOrThrow({ where: { id } });
  return dto(row);
}

export async function loadQueuedStudioRun(id: string): Promise<RunWithOwner | null> {
  return prisma.videoStudioRun.findUnique({ where: { id }, include: { owner: { select: { id: true, username: true, name: true, account_type: true } } } });
}

export function parseWorkerSnapshot(json: string) {
  return decodeSnapshot(json);
}

export function workerSafeUsage(usage: unknown) {
  return safeUsage(usage);
}

export function workerSnapshotFingerprint(snapshot: StudioRunSnapshot) {
  return stableJson(snapshot);
}
