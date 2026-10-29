import 'server-only';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth/api-helpers';
import { studioErrorResponse } from '@/lib/template-studio/errors';
import { prisma } from '@/lib/prisma';
import type { SessionUser } from '@/lib/auth/session';
import { requireStudioUser, makeFingerprint, parseCursor, encodeCursor } from '@/lib/template-studio/common';
import { StudioError } from '@/lib/template-studio/errors';
import { assertUsageProject, recordUsageAttribution } from '@/lib/admin/usage-attribution';
import { getStudioCapabilities } from '@/lib/template-studio/capabilities';
import { isSeedanceVideoModelId, isSeedanceVideoDuration, seedanceVideoDurationError, DEFAULT_SEEDANCE_VIDEO_MODEL_ID } from '@/lib/provider/seedance-models';
import { isStudioTextModel } from '@/lib/template-studio/text-models';
import { TEMPLATE_STUDIO_LIMITS, stableJson } from '@/lib/template-studio/validation';
import { containsPrivateContext, visibleRunPrompt } from '@/lib/template-studio/projection';
import { transformPrivateVideoRun, privateVideoRunOrigins } from '@/lib/template-studio/private-storage.server';
import { assertPrivateMuskSend, getMuskApiSettings } from '@/lib/integrations/musk';
import { privatePromptState, type PrivateOrigin } from '@/lib/security/private-prompts.server';
import type { StudioJsonValue, StudioRunSnapshot } from '@/lib/template-studio/types';
import { getMultiviewWork, multiviewWorkRecipeHash, assertMultiviewWorkReference, MultiviewWorkError } from './multiview-works';
import { ensureMultiviewReferenceAsset, readMultiviewReferenceBinding } from './multiview-output-assets.server';
import { privateMultiviewFailure } from './multiview-task-privacy';
import { multiviewActionContextMetadata, readMultiviewActionContext, multiviewActionContextOrigins } from './multiview-action-context.server';
import { MULTIVIEW_ACTION_ENABLED } from './multiview-action-capability';
import { MULTIVIEW_ACTION_PURPOSE, parseMultiviewActionBinding, type MultiviewActionBinding, type MultiviewActionDraft, type MultiviewActionParameters,
  type MultiviewActionRun, type MultiviewActionCapabilities, type MultiviewActionState } from './multiview-action-contract';

type Db = Prisma.TransactionClient;
type RunRow = NonNullable<Awaited<ReturnType<typeof prisma.videoStudioRun.findFirst>>>;
type DraftRow = NonNullable<Awaited<ReturnType<typeof prisma.videoStudioDraft.findFirst>>>;
const invalid = (message: string) => new StudioError(message, 400, 'INVALID');
const conflict = (message: string) => new StudioError(message, 409, 'CONFLICT');
const notFound = () => new StudioError('动作记录不存在或无权访问', 404, 'NOT_FOUND');
const purpose = MULTIVIEW_ACTION_PURPOSE;
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function actionText(value: unknown, required = false) {
  if (typeof value !== 'string' || value.length > 12000 || /\u0000/.test(value)) throw invalid('动作最多12000字');
  if (required && !value.trim()) throw invalid('请先填写动作');
  return value;
}
export function normalizeMultiviewActionParameters(value: unknown, complete = false): MultiviewActionParameters {
  if (!object(value)) throw invalid('视频参数无效');
  const allowed = ['provider', 'model', 'duration', 'resolution', 'ratio', 'project_id', 'video_card_id', 'seed', 'generate_audio', 'return_last_frame', 'watermark'];
  if (Object.keys(value).some(key => !allowed.includes(key)) || value.provider !== undefined && value.provider !== 'seedance'
    || typeof value.model !== 'string' || value.model.length > 100 || value.model !== '' && !isSeedanceVideoModelId(value.model)
    || !['480p', '720p', '1080p'].includes(String(value.resolution)) || !['16:9', '9:16', '1:1'].includes(String(value.ratio))
    || typeof value.project_id !== 'string' || value.project_id.length > 100 || value.project_id && !identifier(value.project_id)
    || value.video_card_id !== null && value.video_card_id !== undefined && !identifier(value.video_card_id)
    || value.seed !== undefined && (!Number.isInteger(value.seed) || Number(value.seed) < -1 || Number(value.seed) > 2147483647)
    || ['generate_audio', 'return_last_frame', 'watermark'].some(key => value[key] !== undefined && typeof value[key] !== 'boolean')) throw invalid('视频参数无效，原输入保留');
  if (!isSeedanceVideoDuration(value.duration, value.model as string || DEFAULT_SEEDANCE_VIDEO_MODEL_ID)) throw invalid(seedanceVideoDurationError(value.model as string || DEFAULT_SEEDANCE_VIDEO_MODEL_ID));
  if (complete && (!value.model || !value.project_id)) throw invalid('请选择视频型号和项目');
  return { provider: 'seedance', model: value.model, duration: Number(value.duration), resolution: value.resolution as MultiviewActionParameters['resolution'],
    ratio: value.ratio as MultiviewActionParameters['ratio'], project_id: value.project_id, video_card_id: value.video_card_id as string || null,
    ...(value.seed !== undefined ? { seed: value.seed as number } : {}),
    ...Object.fromEntries(['generate_audio', 'return_last_frame', 'watermark'].filter(key => value[key] !== undefined).map(key => [key, value[key]])) };
}
function draftIdentity(user: SessionUser, workId: string) { return `mvaction-${makeFingerprint([user.id, workId]).slice(0, 48)}`; }
function draftDto(row: DraftRow): MultiviewActionDraft {
  const values = JSON.parse(row.values_json);
  if (row.purpose !== purpose || !identifier(values.workId) || !Number.isSafeInteger(values.workRevision)) throw conflict('动作草稿无法读取');
  return { id: row.id, workId: values.workId, workRevision: values.workRevision, revision: row.revision, text: row.prompt,
    parameters: normalizeMultiviewActionParameters(JSON.parse(row.parameters_json)), updatedAt: row.updated_at.toISOString() };
}
function snapshot(row: RunRow) {
  const value = transformPrivateVideoRun(JSON.parse(row.snapshot_json) as StudioRunSnapshot, row.id, row.draft_id, false);
  if (row.purpose !== purpose || value.purpose !== purpose || !value.multiviewAction || !['format', 'final'].includes(value.multiviewAction.stage)) throw conflict('动作快照用途不一致');
  return value;
}
async function runDto(row: RunRow, db: Db = prisma): Promise<MultiviewActionRun> {
  // Read through the same protected snapshot decoder as the worker; never return privateContext.
  const value = snapshot(row);
  const action = value.multiviewAction!;
  const tasks = await db.videoTask.findMany({ where: { template_studio_run_id: row.id, owner_user_id: row.owner_user_id },
    select: { id: true, local_status: true, error_message: true, delivery_status: true, result_video_url: true, public_video_url: true, local_video_path: true, created_at: true },
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: 24 });
  return { id: row.id, draftId: row.draft_id, draftRevision: row.draft_revision, inputText: value.input.draftPrompt, requestId: row.request_id, mode: row.mode as 'direct' | 'llm', status: row.status as MultiviewActionRun['status'],
    text: visibleRunPrompt(row), error: row.error_message, llmModel: value.llmModel || row.model || null,
    parameters: normalizeMultiviewActionParameters(value.parameters),
    binding: action.stage === 'final' && action.inputHash ? { runId: row.id, workId: action.workId, revision: action.revision, recipeHash: action.recipeHash, inputHash: action.inputHash } : null,
    attemptId: action.attemptId || 'initial', createdAt: row.created_at.toISOString(), tasks: tasks.map(task => { const ready = task.local_status === 'succeeded' && Boolean(task.result_video_url || task.public_video_url || task.local_video_path);
      return { taskId: task.id, status: task.local_status, error: privateMultiviewFailure(task.error_message, task.local_status)?.message || null, deliveryStatus: task.delivery_status, playUrl: ready ? `/api/video/play/${encodeURIComponent(task.id)}` : null,
        downloadUrl: ready ? `/api/video/download/${encodeURIComponent(task.id)}` : null, createdAt: task.created_at.toISOString() }; }) };
}
export async function getMultiviewActionCapabilities(user: SessionUser): Promise<MultiviewActionCapabilities> {
  requireStudioUser(user);
  const capabilities = await getStudioCapabilities(user);
  try {
    const [format, sync] = await Promise.all([multiviewActionContextMetadata(user, 'format'), multiviewActionContextMetadata(user, 'sync')]);
    const ready = format.configured && sync.configured && MULTIVIEW_ACTION_ENABLED && process.env.MULTIVIEW_ACTION_ACCEPTING !== '0';
    return { ...capabilities, actionReady: ready, actionReason: ready ? null : (!MULTIVIEW_ACTION_ENABLED || process.env.MULTIVIEW_ACTION_ACCEPTING === '0') ? '同步动作暂不接受新任务，原任务仍可查看' : '固定规则尚未配置，请联系管理员', rules: { format, sync } };
  } catch {
    return { ...capabilities, actionReady: false, actionReason: '私密规则暂不可用，请联系管理员',
      rules: { format: { configured: false, revision: 0, canEdit: false }, sync: { configured: false, revision: 0, canEdit: false } } };
  }
}
export async function getMultiviewActionState(user: SessionUser, workId: string, cursor?: string): Promise<MultiviewActionState> {
  requireStudioUser(user);
  const work = await getMultiviewWork(user, workId);
  if (!work.recipe || work.recipe.schema !== 3) throw conflict('这不是视频参考拼图');
  const parsed = parseCursor(cursor);
  const draft = await prisma.videoStudioDraft.findFirst({ where: { id: draftIdentity(user, workId), owner_user_id: user.id, purpose } });
  const rows = draft ? await prisma.videoStudioRun.findMany({ where: { draft_id: draft.id, owner_user_id: user.id, purpose,
    ...(parsed ? { OR: [{ created_at: { lt: parsed.date } }, { created_at: parsed.date, id: { lt: parsed.id } }] } : {}) },
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: 13 }) : [];
  const page = rows.slice(0, 12), last = page.at(-1);
  return { capabilities: await getMultiviewActionCapabilities(user), draft: draft ? draftDto(draft) : null,
    runs: await Promise.all(page.map(row => runDto(row))), nextCursor: rows.length > 12 && last ? encodeCursor(`${last.created_at.toISOString()}|${last.id}`) : null };
}
async function referenceDraftWork(user: SessionUser, workId: string) {
  if (!identifier(workId)) throw invalid('拼图编号无效');
  const work = await getMultiviewWork(user, workId);
  if (work.removed || work.sourceState !== 'current' || !work.recipe || work.recipe.schema !== 3) throw conflict('请先保存参考拼图；原动作保留');
  return work;
}
export async function saveMultiviewActionDraft(user: SessionUser, input: unknown): Promise<MultiviewActionDraft> {
  requireStudioUser(user);
  if (!object(input) || !identifier(input.workId) || !Number.isSafeInteger(input.revision) || Number(input.revision) < 0) throw invalid('动作草稿参数无效');
  const work = await referenceDraftWork(user, input.workId);
  const id = draftIdentity(user, work.id);
  if (input.draftId !== undefined && input.draftId !== id) throw conflict('动作草稿与拼图不一致');
  const text = actionText(input.text), parameters = normalizeMultiviewActionParameters(input.parameters);
  const values = { workId: work.id, workRevision: work.draftRevision };
  const row = await prisma.$transaction(async tx => {
    const current = await tx.videoStudioDraft.findFirst({ where: { id, owner_user_id: user.id, purpose } });
    if (!current) {
      if (input.revision !== 0) throw conflict('动作草稿已变化，请重新读取；当前文字保留');
      return tx.videoStudioDraft.create({ data: { id, owner_user_id: user.id, purpose, name: '同步动作视频', group_name: work.id,
        prompt: text, values_json: JSON.stringify(values), parameters_json: JSON.stringify(parameters) } });
    }
    if (current.revision !== input.revision) throw conflict('动作已在另一处更新，当前文字保留');
    if (current.prompt === text && current.parameters_json === JSON.stringify(parameters) && current.values_json === JSON.stringify(values)) return current;
    const updated = await tx.videoStudioDraft.updateMany({ where: { id, owner_user_id: user.id, purpose, revision: current.revision },
      data: { prompt: text, parameters_json: JSON.stringify(parameters), values_json: JSON.stringify(values), revision: { increment: 1 }, updated_at: new Date() } });
    if (updated.count !== 1) throw conflict('动作已在另一处更新，当前文字保留');
    return tx.videoStudioDraft.findUniqueOrThrow({ where: { id } });
  });
  return draftDto(row);
}
async function ownedDraft(user: SessionUser, id: unknown, revision?: unknown) {
  if (!identifier(id)) throw invalid('动作草稿编号无效');
  const row = await prisma.videoStudioDraft.findFirst({ where: { id, owner_user_id: user.id, purpose } });
  if (!row) throw notFound();
  if (revision !== undefined && row.revision !== revision) throw conflict('动作草稿已变化，请重新保存；当前文字保留');
  return row;
}
function workGeometry(recipe: { output: unknown; panels: unknown; placements: unknown; divider: unknown }) {
  return JSON.parse(JSON.stringify({ output: recipe.output, panels: recipe.panels, placements: recipe.placements, divider: recipe.divider })) as Record<string, StudioJsonValue>;
}
function baseSnapshot(user: SessionUser, draft: DraftRow, prompt: string, parameters: MultiviewActionParameters): StudioRunSnapshot {
  return { purpose, input: { name: '同步动作视频', groupName: '3D多视图', values: {}, draftPrompt: prompt },
    templateVersion: null, recipe: null, prompt, parameters: { ...parameters }, assets: [],
    owner: { userId: user.id, username: user.username, displayName: user.name || user.username, avatarUrl: user.avatar_url || null, accountType: user.account_type } };
}
export async function createMultiviewActionRun(user: SessionUser, input: unknown) {
  requireStudioUser(user);
  if (!object(input) || !identifier(input.draftId) || !Number.isSafeInteger(input.revision) || typeof input.requestId !== 'string'
    || !/^[A-Za-z0-9:_-]{1,96}$/.test(input.requestId) || input.llmModel !== undefined && !isStudioTextModel(String(input.llmModel))) throw invalid('文案请求无效');
  const requestId = `mv-action:${input.requestId}`;
  const prior = await prisma.videoStudioRun.findUnique({ where: { owner_user_id_request_id: { owner_user_id: user.id, request_id: requestId } } });
  if (prior) {
    if (prior.purpose !== purpose || prior.draft_id !== input.draftId || prior.draft_revision !== input.revision || prior.mode !== 'llm'
      || input.llmModel !== undefined && snapshot(prior).llmModel !== input.llmModel) throw conflict('原请求编号已用于另一份动作，请查看原记录');
    return { run: await runDto(prior), status: 200 };
  }
  const draft = await ownedDraft(user, input.draftId, input.revision), parsed = draftDto(draft);
  const work = await referenceDraftWork(user, parsed.workId);
  const text = actionText(draft.prompt, true);
  const capabilities = await getMultiviewActionCapabilities(user);
  if (!capabilities.actionReady || !capabilities.llmEnabled) throw new StudioError(capabilities.actionReason || capabilities.llmReason || '文案服务当前不可用', 503, 'UNAVAILABLE');
  const format = await readMultiviewActionContext('format');
  if (!format.context.trim()) throw conflict('动作格式尚未配置');
  const value = baseSnapshot(user, draft, text, parsed.parameters);
  value.privateContext = { global: format.context, module: '', globalRevision: format.revision, moduleRevision: 0 };
  value.llmModel = input.llmModel as string || capabilities.defaultLlmModel;
  value.multiviewAction = { stage: 'format', workId: work.id, revision: work.draftRevision, recipeHash: multiviewWorkRecipeHash(work.recipe!), outputHash: '',
    sourceTaskId: work.sourceTaskId, sourceVersion: work.recipe!.sourceVersion, geometry: workGeometry(work.recipe! as Parameters<typeof workGeometry>[0]), assetId: '', formatRevision: format.revision, syncRevision: 0 };
  if (text.length + format.context.length > TEMPLATE_STUDIO_LIMITS.llmInput) throw invalid('动作和固定规则合计过长');
  const settings = { ...await getMuskApiSettings(), default_model: value.llmModel };
  const origins = privateVideoRunOrigins(value, draft.id);
  assertPrivateMuskSend(settings, origins);
  if (!['legacy-read', 'compatible-read'].includes(privatePromptState())) value.privateProvider = { kind: 'musk', settings };
  const fingerprint = makeFingerprint({ revision: draft.revision, model: value.llmModel, snapshot: value });
  const row = await prisma.$transaction(async tx => {
    const existing = await tx.videoStudioRun.findUnique({ where: { owner_user_id_request_id: { owner_user_id: user.id, request_id: requestId } } });
    if (existing) {
      if (existing.purpose !== purpose || existing.draft_id !== draft.id || existing.draft_revision !== draft.revision || existing.mode !== 'llm' || snapshot(existing).llmModel !== value.llmModel) throw conflict('原请求编号已使用');
      return existing;
    }
    const current = await tx.videoStudioDraft.findFirst({ where: { id: draft.id, owner_user_id: user.id, purpose, revision: draft.revision } });
    if (!current) throw conflict('动作已变化，请重新保存');
    const [active, pending, accepted] = await Promise.all([
      tx.videoStudioRun.count({ where: { owner_user_id: user.id, mode: 'llm', status: { in: ['queued', 'running'] } } }),
      tx.videoStudioRun.count({ where: { mode: 'llm', status: { in: ['queued', 'running'] } } }),
      tx.videoStudioRun.count({ where: { owner_user_id: user.id, mode: 'llm', created_at: { gte: new Date(Date.now() - TEMPLATE_STUDIO_LIMITS.llmRequestWindowMs) } } }),
    ]);
    if (active >= TEMPLATE_STUDIO_LIMITS.activeLlmRunsPerUser || pending >= TEMPLATE_STUDIO_LIMITS.maxPendingLlmRuns || accepted >= TEMPLATE_STUDIO_LIMITS.llmRequestsPerUserWindow) throw new StudioError('AI 整理提交较频繁，请稍后再试', 429, 'RATE_LIMITED');
    const id = randomUUID();
    await assertUsageProject(tx, user, parsed.parameters.project_id || null);
    const created = await tx.videoStudioRun.create({ data: { id, owner_user_id: user.id, purpose, draft_id: draft.id, draft_revision: draft.revision, request_id: requestId,
      request_fingerprint: fingerprint, source: 'blank', mode: 'llm', status: 'queued', delivery_state: 'not_sent', model: value.llmModel,
      snapshot_json: JSON.stringify(transformPrivateVideoRun(value, id, draft.id, true)) } });
    await recordUsageAttribution(tx, { sourceKind: 'video_studio_run', sourceId: id, actorUserId: user.id, ownerUserId: user.id, billingSubjectType: 'user', billingSubjectId: user.id,
      projectId: parsed.parameters.project_id || null, occurredAt: created.created_at, contextOrigin: 'multiview-action-explicit-project' });
    return created;
  });
  return { run: await runDto(row), status: row.status === 'queued' || row.status === 'running' ? 202 : 200 };
}
export async function getMultiviewActionRun(user: SessionUser, id: string) {
  requireStudioUser(user);
  const row = await prisma.videoStudioRun.findFirst({ where: { owner_user_id: user.id, purpose, OR: [{ id }, { request_id: `mv-action:${id}` }] } });
  if (!row) throw notFound();
  return runDto(row);
}
export async function ensureMultiviewActionSnapshot(user: SessionUser, value: StudioRunSnapshot, db: Db = prisma) {
  if (value.purpose !== purpose || !value.multiviewAction || value.owner.userId !== user.id) throw conflict('动作快照用途不一致');
  const action = value.multiviewAction;
  const work = await db.multiviewWork.findFirst({ where: { id: action.workId, owner_id: user.id, removed_at: null } });
  if (!work) throw conflict('参考拼图已不可用，原输入保留');
  await assertMultiviewWorkReference(user, work, db);
  if (work.source_task_id !== action.sourceTaskId || work.source_version !== action.sourceVersion) throw conflict('来源视频已变化，原输入保留');
}
export async function finalizeMultiviewAction(user: SessionUser, input: unknown) {
  requireStudioUser(user);
  if (!object(input) || !identifier(input.draftId) || !Number.isSafeInteger(input.revision) || Number(input.revision) < 1) throw invalid('动作提交参数无效');
  if ((!MULTIVIEW_ACTION_ENABLED || process.env.MULTIVIEW_ACTION_ACCEPTING === '0')) throw conflict('同步动作暂不接受新任务，原任务仍可查看');
  const draft = await ownedDraft(user, input.draftId, input.revision), parsed = draftDto(draft);
  const text = actionText(input.text, true).trim(), parameters = normalizeMultiviewActionParameters(input.parameters, true);
  const attemptId = input.attemptId === undefined ? 'initial' : input.attemptId;
  if (attemptId !== 'initial' && (typeof attemptId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(attemptId))) throw invalid('这次生成准备编号无效，原输入保留');
  const normalizedAttemptId = (attemptId as string).toLowerCase();
  const reference = await ensureMultiviewReferenceAsset(user, parsed.workId, parsed.workRevision);
  const [format, sync] = await Promise.all([readMultiviewActionContext('format'), readMultiviewActionContext('sync')]);
  if (!format.context.trim() || !sync.context.trim()) throw conflict('固定规则尚未配置');
  const output = reference.geometry.output;
  const ratio = parameters.ratio.split(':').map(Number);
  if (Math.abs(output.width / output.height - ratio[0] / ratio[1]) > 0.002) throw conflict('视频比例与参考拼图不同，请先调整画幅');
  let sourceRunId: string | undefined;
  if (input.sourceRunId !== undefined && input.sourceRunId !== null) {
    if (!identifier(input.sourceRunId)) throw invalid('原文案记录无效');
    const source = await prisma.videoStudioRun.findFirst({ where: { id: input.sourceRunId, owner_user_id: user.id, purpose, draft_id: draft.id, status: 'succeeded' } });
    if (!source) throw conflict('原文案记录不可用，动作文字仍保留');
    sourceRunId = source.id;
  }
  const value = baseSnapshot(user, draft, text, parameters);
  value.sourceRunId = sourceRunId;
  value.privateContext = { global: format.context, module: sync.context, globalRevision: format.revision, moduleRevision: sync.revision };
  if (containsPrivateContext(text, value)) throw invalid('动作疑似包含内部规则，不能提交视频');
  const backgroundPolicy = 'current-composition-v1' as const;
  const frozen = { ...reference, geometry: JSON.parse(JSON.stringify(reference.geometry)) as Record<string, StudioJsonValue>, parameters,
    actionText: text, formatRevision: format.revision, syncRevision: sync.revision, format: format.context, sync: sync.context, backgroundPolicy };
  const inputHash = makeFingerprint(frozen);
  value.multiviewAction = { stage: 'final', attemptId: normalizedAttemptId, workId: parsed.workId, revision: parsed.workRevision, recipeHash: reference.recipeHash, outputHash: reference.outputHash,
    sourceTaskId: reference.sourceTaskId, sourceVersion: reference.sourceVersion, geometry: frozen.geometry, assetId: reference.assetId,
    inputHash, formatRevision: format.revision, syncRevision: sync.revision, backgroundPolicy };
  const requestId = `mv-action-final:${makeFingerprint([inputHash, draft.id, normalizedAttemptId])}`;
  const row = await prisma.$transaction(async tx => {
    const old = await tx.videoStudioRun.findUnique({ where: { owner_user_id_request_id: { owner_user_id: user.id, request_id: requestId } } });
    if (old) { if (old.purpose !== purpose || old.draft_id !== draft.id || old.mode !== 'direct') throw conflict('动作版本冲突'); return old; }
    const current = await tx.videoStudioDraft.findFirst({ where: { id: draft.id, owner_user_id: user.id, purpose, revision: draft.revision } });
    if (!current) throw conflict('动作草稿已变化，请重新保存；当前输入保留');
    const fresh = await readMultiviewReferenceBinding(user, parsed.workId, parsed.workRevision, tx);
    if (fresh.outputHash !== reference.outputHash || fresh.recipeHash !== reference.recipeHash || fresh.assetId !== reference.assetId) throw conflict('参考拼图已变化，请重新准备');
    const [freshFormat, freshSync] = await Promise.all([readMultiviewActionContext('format', tx), readMultiviewActionContext('sync', tx)]);
    if (freshFormat.revision !== format.revision || freshSync.revision !== sync.revision) throw conflict('固定规则已变化，请重新准备费用');
    const id = randomUUID();
    return tx.videoStudioRun.create({ data: { id, owner_user_id: user.id, purpose, draft_id: draft.id, draft_revision: draft.revision, request_id: requestId,
      request_fingerprint: inputHash, source: 'blank', mode: 'direct', status: 'succeeded', delivery_state: 'not_sent', prompt: text,
      snapshot_json: JSON.stringify(transformPrivateVideoRun(value, id, draft.id, true)), completed_at: new Date() } });
  });
  const run = await runDto(row);
  return { run, binding: run.binding!, requestId: `multiview-action:${row.id}` };
}
export type ResolvedMultiviewAction = MultiviewActionBinding & { actionText: string; prompt: string; assetId: string; outputHash: string; sourceTaskId: string; sourceVersion: string;
  geometry: NonNullable<StudioRunSnapshot['multiviewAction']>['geometry']; origins: PrivateOrigin[]; parameters: MultiviewActionParameters; formatRevision: number; syncRevision: number };
export async function resolveMultiviewActionForGeneration(user: SessionUser, input: unknown, db: Db = prisma): Promise<ResolvedMultiviewAction> {
  requireStudioUser(user);
  if ((!MULTIVIEW_ACTION_ENABLED || process.env.MULTIVIEW_ACTION_ACCEPTING === '0')) throw conflict('同步动作暂不接受新任务，原任务仍可查看');
  const parsed = parseMultiviewActionBinding(input);
  if (!parsed) throw invalid('动作与拼图绑定无效');
  const row = await db.videoStudioRun.findFirst({ where: { id: parsed.runId, owner_user_id: user.id, purpose, status: 'succeeded', mode: 'direct' } });
  if (!row) throw notFound();
  const value = snapshot(row), action = value.multiviewAction!;
  if (action.stage !== 'final' || action.workId !== parsed.workId || action.revision !== parsed.revision || action.recipeHash !== parsed.recipeHash || action.inputHash !== parsed.inputHash) throw conflict('动作与拼图版本不同，请重新准备费用');
  await ensureMultiviewActionSnapshot(user, value, db);
  const reference = await readMultiviewReferenceBinding(user, parsed.workId, parsed.revision, db);
  if (reference.assetId !== action.assetId || reference.recipeHash !== action.recipeHash || reference.outputHash !== action.outputHash
    || stableJson(reference.geometry) !== stableJson(action.geometry)) throw conflict('参考拼图已变化，请重新准备费用');
  const [format, sync] = await Promise.all([readMultiviewActionContext('format', db), readMultiviewActionContext('sync', db)]);
  if (format.revision !== action.formatRevision || sync.revision !== action.syncRevision) throw conflict('固定规则已更新，请重新准备费用');
  const text = visibleRunPrompt(row);
  if (!text || !value.privateContext?.module.trim()) throw conflict('动作快照暂不可用');
  const parameters = normalizeMultiviewActionParameters(value.parameters, true);
  const frozen = { ...reference, geometry: action.geometry, parameters, actionText: text, formatRevision: action.formatRevision, syncRevision: action.syncRevision,
    format: value.privateContext.global, sync: value.privateContext.module,
    ...(action.backgroundPolicy === 'current-composition-v1' ? { backgroundPolicy: action.backgroundPolicy } : {}) };
  if (makeFingerprint(frozen) !== action.inputHash) throw conflict('动作快照签名不同，请重新准备费用');
  // Freeze this policy only for new finals; historical accepted snapshots retain
  // their original hash and prompt contract.
  const backgroundInstruction = action.backgroundPolicy === 'current-composition-v1'
    ? '\n\n本次以参考拼图当前的背景与构图为准。背景处理可选，未处理区域保留原图背景；画布底色只描述空白区域，不主动去背景或更换背景。'
    : '';
  const prompt = `${text}\n\n${value.privateContext.module}\n\n${JSON.stringify({ panels: action.geometry.panels, placements: action.geometry.placements, output: action.geometry.output, divider: action.geometry.divider })}${backgroundInstruction}`;
  return { ...parsed, actionText: text, prompt, assetId: action.assetId, outputHash: action.outputHash, sourceTaskId: action.sourceTaskId, sourceVersion: action.sourceVersion,
    geometry: action.geometry, origins: multiviewActionContextOrigins('sync'), parameters, formatRevision: action.formatRevision, syncRevision: action.syncRevision };
}

export async function withMultiviewActionRoute(request: NextRequest, handler: (user: SessionUser) => Promise<NextResponse>) {
  try {
    const user = await getSessionUser(request);
    requireStudioUser(user);
    const expectedActor = request.headers.get('x-app-session-user');
    if (expectedActor && expectedActor !== user.id) throw conflict('账号已变化，请重新打开本页；原输入保留');
    if (!['GET', 'HEAD'].includes(request.method)) {
      const origin = request.headers.get('origin'), host = request.headers.get('host');
      const protocol = request.headers.get('x-forwarded-proto') || request.nextUrl.protocol.replace(':', '');
      if (!host || /[/\\?#@,\s]/.test(host) || !['http', 'https'].includes(protocol)
        || origin !== new URL(`${protocol}://${host}`).origin) throw new StudioError('请求来源无效', 403, 'FORBIDDEN');
    }
    return await handler(user);
  } catch (error) {
    if (error instanceof MultiviewWorkError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers: multiviewActionResponseHeaders });
    return studioErrorResponse(error);
  }
}
export const multiviewActionResponseHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
export async function readMultiviewActionJson(request: NextRequest) {
  const reader = request.body?.getReader();
  if (!reader) throw invalid('请求内容为空');
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const item = await reader.read(); if (item.done) break;
      bytes += item.value.byteLength; if (bytes > 131072) throw invalid('请求内容过大');
      chunks.push(item.value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!object(data)) throw invalid('请求内容无效');
  return data;
}

export async function findMultiviewActionRunRequest(user: SessionUser, requestId: string) {
  requireStudioUser(user);
  if (!/^[A-Za-z0-9:_-]{1,96}$/.test(requestId)) throw invalid('文案请求编号无效');
  const row = await prisma.videoStudioRun.findFirst({ where: { owner_user_id: user.id, purpose, request_id: `mv-action:${requestId}` } });
  return row ? runDto(row) : null;
}
