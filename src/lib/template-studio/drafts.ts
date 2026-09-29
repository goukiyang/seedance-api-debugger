import { prisma } from '@/lib/prisma';
import type { SessionUser } from '@/lib/auth/session';
import { authorizeStudioAssets } from './assets';
import { encodeCursor, parseCursor } from './common';
import { StudioError } from './errors';
import { getStudioTemplate } from './templates';
import {
  normalizeAssets,
  normalizeGroupName,
  normalizeName,
  normalizeParameters,
  normalizePrompt,
  normalizeRecipe,
  normalizeValues,
  parseJsonArray,
  parseJsonRecord,
} from './validation';
import type { CreateStudioDraftRequest, StudioDraftDto, StudioDraftRecoveryInput, StudioDraftTemplateRef, StudioRunSnapshot, StudioTemplateRecipe, UpdateStudioDraftRequest } from './types';

type TemplateSnapshot = { ref: StudioDraftTemplateRef; recipe: StudioTemplateRecipe };

function readTemplateSnapshot(json: string | null): TemplateSnapshot | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json) as Record<string, unknown>;
    if (!value || typeof value !== 'object' || !value.ref || typeof value.ref !== 'object' || !value.recipe) throw new Error('invalid');
    const ref = value.ref as Record<string, unknown>;
    if (typeof ref.templateId !== 'string' || (ref.templateSource !== 'legacy' && ref.templateSource !== 'studio') || typeof ref.templateName !== 'string') throw new Error('invalid');
    return {
      ref: {
        templateId: ref.templateId,
        templateSource: ref.templateSource,
        versionId: typeof ref.versionId === 'string' ? ref.versionId : null,
        versionNumber: Number.isInteger(ref.versionNumber) ? ref.versionNumber as number : null,
        templateName: ref.templateName,
        sourceRevision: typeof ref.sourceRevision === 'string' ? ref.sourceRevision : null,
      },
      recipe: normalizeRecipe(value.recipe),
    };
  } catch {
    throw new StudioError('草稿模板快照无法读取', 500, 'UNAVAILABLE');
  }
}

function serializeDraft(row: any): StudioDraftDto {
  const snapshot = readTemplateSnapshot(row.template_snapshot_json);
  return {
    id: row.id,
    name: row.name,
    groupName: row.group_name,
    prompt: row.prompt,
    values: parseJsonRecord(row.values_json, '字段值'),
    assets: parseJsonArray(row.assets_json, '素材') as StudioDraftDto['assets'],
    parameters: parseJsonRecord(row.parameters_json, '参数'),
    recipe: snapshot?.recipe ?? null,
    revision: row.revision,
    template: snapshot?.ref ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function readRunSnapshot(json: string): StudioRunSnapshot {
  try {
    const snapshot = JSON.parse(json) as StudioRunSnapshot;
    if (!snapshot || !snapshot.input || typeof snapshot.input.name !== 'string'
      || typeof snapshot.input.groupName !== 'string' || typeof snapshot.input.draftPrompt !== 'string'
      || !snapshot.input.values || Array.isArray(snapshot.input.values) || typeof snapshot.input.values !== 'object'
      || !snapshot.parameters || Array.isArray(snapshot.parameters) || typeof snapshot.parameters !== 'object'
      || !Array.isArray(snapshot.assets) || typeof snapshot.prompt !== 'string'
      || (snapshot.templateVersion && (!snapshot.recipe || typeof snapshot.templateVersion.templateId !== 'string'
        || (snapshot.templateVersion.templateSource !== 'legacy' && snapshot.templateVersion.templateSource !== 'studio')))
      || (!snapshot.templateVersion && snapshot.recipe)) throw new Error('invalid');
    if (snapshot.recipe) normalizeRecipe(snapshot.recipe);
    return snapshot;
  } catch {
    throw new StudioError('运行快照无法读取', 500, 'UNAVAILABLE');
  }
}

async function createStudioDraftFromRun(user: SessionUser, runId: string) {
  const run = await prisma.videoStudioRun.findFirst({ where: { id: runId, owner_user_id: user.id } });
  if (!run) throw new StudioError('运行记录不存在或无权访问', 404, 'NOT_FOUND');
  const snapshot = readRunSnapshot(run.snapshot_json);
  const ref = snapshot.templateVersion;
  if (run.source !== (ref?.templateSource || 'blank')) throw new StudioError('运行来源与历史快照不一致，无法复用输入', 409, 'CONFLICT');
  const row = await prisma.videoStudioDraft.create({
    data: {
      owner_user_id: user.id,
      name: snapshot.input.name,
      group_name: snapshot.input.groupName,
      prompt: snapshot.input.draftPrompt,
      values_json: JSON.stringify(snapshot.input.values),
      assets_json: JSON.stringify(snapshot.assets),
      parameters_json: JSON.stringify(snapshot.parameters),
      template_source: ref?.templateSource || 'blank',
      source_template_id: ref?.templateId || null,
      source_version_id: ref?.versionId || null,
      template_snapshot_json: ref && snapshot.recipe ? JSON.stringify({ ref, recipe: snapshot.recipe }) : null,
    },
  });
  return serializeDraft(row);
}

function exactRequestKeys(value: Record<string, unknown>, allowed: string[], label: string) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new StudioError(`${label}包含不支持的字段`, 400, 'INVALID');
  }
}

function normalizeDraftRecovery(value: unknown, recipe: StudioTemplateRecipe | null): StudioDraftRecoveryInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StudioError('恢复内容格式无效', 400, 'INVALID');
  const input = value as Record<string, unknown>;
  exactRequestKeys(input, ['name', 'groupName', 'prompt', 'values', 'assets', 'parameters'], '恢复内容');
  if (typeof input.prompt !== 'string' || !input.values || typeof input.values !== 'object' || Array.isArray(input.values)
    || !Array.isArray(input.assets) || !input.parameters || typeof input.parameters !== 'object' || Array.isArray(input.parameters)) {
    throw new StudioError('恢复内容缺少提示词、字段、素材或参数', 400, 'INVALID');
  }
  return {
    ...(input.name !== undefined ? { name: normalizeName(input.name) } : {}),
    ...(input.groupName !== undefined ? { groupName: normalizeGroupName(input.groupName) } : {}),
    prompt: normalizePrompt(input.prompt),
    values: normalizeValues(input.values, recipe, { mode: 'draft' }),
    assets: normalizeAssets(input.assets, recipe),
    parameters: normalizeParameters(input.parameters),
  };
}

async function createStudioDraftFromDraft(user: SessionUser, draftId: string, recoveryInput: unknown) {
  const source = await prisma.videoStudioDraft.findFirst({ where: { id: draftId, owner_user_id: user.id } });
  if (!source) throw new StudioError('草稿不存在或无权访问', 404, 'NOT_FOUND');
  const snapshot = readTemplateSnapshot(source.template_snapshot_json);
  const isBlank = source.template_source === 'blank';
  if ((isBlank && (snapshot || source.source_template_id !== null || source.source_version_id !== null))
    || (!isBlank && (!snapshot || snapshot.ref.templateSource !== source.template_source
      || snapshot.ref.templateId !== source.source_template_id || snapshot.ref.versionId !== source.source_version_id))) {
    throw new StudioError('原草稿模板快照与来源不一致，无法恢复', 409, 'CONFLICT');
  }

  const recovery = normalizeDraftRecovery(recoveryInput, snapshot?.recipe ?? null);
  await authorizeStudioAssets(user, recovery.assets);
  const row = await prisma.$transaction(async (tx) => {
    const currentSource = await tx.videoStudioDraft.findFirst({
      where: { id: draftId, owner_user_id: user.id },
      select: {
        id: true, name: true, group_name: true, template_source: true,
        source_template_id: true, source_version_id: true, template_snapshot_json: true,
      },
    });
    if (!currentSource) throw new StudioError('草稿不存在或无权访问', 404, 'NOT_FOUND');
    if (currentSource.template_source !== source.template_source
      || currentSource.source_template_id !== source.source_template_id
      || currentSource.source_version_id !== source.source_version_id
      || currentSource.template_snapshot_json !== source.template_snapshot_json) {
      throw new StudioError('原草稿模板快照已变化，请重新恢复', 409, 'CONFLICT');
    }
    return tx.videoStudioDraft.create({
      data: {
        owner_user_id: user.id,
        name: recovery.name ?? currentSource.name,
        group_name: recovery.groupName ?? currentSource.group_name,
        prompt: recovery.prompt,
        values_json: JSON.stringify(recovery.values),
        assets_json: JSON.stringify(recovery.assets),
        parameters_json: JSON.stringify(recovery.parameters),
        template_source: currentSource.template_source,
        source_template_id: currentSource.source_template_id,
        source_version_id: currentSource.source_version_id,
        template_snapshot_json: currentSource.template_snapshot_json,
      },
    });
  });
  return serializeDraft(row);
}

async function resolveTemplateSnapshot(user: SessionUser, templateId: string, source: 'legacy' | 'studio'): Promise<TemplateSnapshot> {
  const detail = await getStudioTemplate(user, templateId, source);
  if (source === 'legacy') {
    throw new StudioError('旧版模板请在原生成流程中使用', 409, 'CONFLICT', {
      applyMode: detail.template.applyMode,
      applyUrl: detail.template.applyUrl,
    });
  }
  if (!detail.template.recipe) throw new StudioError('模板当前没有可用 recipe', 409, 'CONFLICT');
  const row = await prisma.videoStudioTemplate.findUnique({
    where: { id: templateId },
    include: { published_version: true },
  });
  if (!row) throw new StudioError('模板不存在', 404, 'NOT_FOUND');
  let recipe = detail.template.recipe;
  let versionId: string | null = null;
  let versionNumber: number | null = null;
  if (row.visibility === 'shared' && row.status === 'published') {
    if (!row.published_version) throw new StudioError('模板发布版本不可用', 409, 'CONFLICT');
    recipe = normalizeRecipe(JSON.parse(row.published_version.recipe_json));
    versionId = row.published_version.id;
    versionNumber = row.published_version.version_number;
  }
  return {
    ref: { templateId, templateSource: source, versionId, versionNumber, templateName: detail.template.name, sourceRevision: versionId ? null : `studio:${row.revision}` },
    recipe,
  };
}

export async function listStudioDrafts(user: SessionUser, cursor?: string) {
  const parsed = parseCursor(cursor);
  const rows = await prisma.videoStudioDraft.findMany({
    where: {
      owner_user_id: user.id,
      ...(parsed ? { OR: [{ updated_at: { lt: parsed.date } }, { updated_at: parsed.date, id: { lt: parsed.id } }] } : {}),
    },
    orderBy: [{ updated_at: 'desc' }, { id: 'desc' }],
    take: 31,
  });
  const page = rows.slice(0, 30);
  const last = page.at(-1);
  return {
    items: page.map(serializeDraft),
    nextCursor: rows.length > 30 && last ? encodeCursor(`${last.updated_at.toISOString()}|${last.id}`) : null,
  };
}

export async function createStudioDraft(user: SessionUser, input: CreateStudioDraftRequest) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new StudioError('草稿请求格式无效', 400, 'INVALID');
  const request = input as CreateStudioDraftRequest & Record<string, unknown>;
  const hasRun = Object.prototype.hasOwnProperty.call(request, 'fromRunId');
  const hasDraft = Object.prototype.hasOwnProperty.call(request, 'fromDraftId');
  const hasRecovery = Object.prototype.hasOwnProperty.call(request, 'recovery');
  const hasTemplate = Object.prototype.hasOwnProperty.call(request, 'templateId')
    || Object.prototype.hasOwnProperty.call(request, 'templateSource');

  if (hasDraft) {
    exactRequestKeys(request, ['fromDraftId', 'recovery'], '恢复请求');
    if (hasRun || hasTemplate || !hasRecovery || typeof request.fromDraftId !== 'string' || !request.fromDraftId.trim()) {
      throw new StudioError('从草稿恢复时不能同时指定运行记录或模板', 400, 'INVALID');
    }
    return createStudioDraftFromDraft(user, request.fromDraftId.trim(), request.recovery);
  }
  if (hasRecovery || (hasRun && hasTemplate)) throw new StudioError('运行记录、模板和草稿恢复来源互斥', 400, 'INVALID');

  if (hasRun) {
    exactRequestKeys(request, ['fromRunId'], '运行记录复用请求');
    if (typeof request.fromRunId !== 'string' || !request.fromRunId.trim()) {
      throw new StudioError('复用运行记录时不能同时指定模板来源', 400, 'INVALID');
    }
    return createStudioDraftFromRun(user, request.fromRunId.trim());
  }
  let snapshot: TemplateSnapshot | null = null;
  if (input?.templateId || input?.templateSource) {
    if (!input.templateId || (input.templateSource !== 'legacy' && input.templateSource !== 'studio')) throw new StudioError('模板来源参数无效', 400, 'INVALID');
    snapshot = await resolveTemplateSnapshot(user, input.templateId, input.templateSource);
  }
  const recipe = snapshot?.recipe ?? null;
  const initialValues: Record<string, unknown> = {};
  for (const field of recipe?.fields ?? []) if ('defaultValue' in field && field.defaultValue !== undefined) initialValues[field.key] = field.defaultValue;
  const row = await prisma.videoStudioDraft.create({
    data: {
      owner_user_id: user.id,
      name: normalizeName(input?.name || snapshot?.ref.templateName || '未命名草稿'),
      group_name: normalizeGroupName(input?.groupName || '未分组'),
      values_json: JSON.stringify(initialValues),
      parameters_json: JSON.stringify(recipe?.defaultParameters || {}),
      template_source: snapshot?.ref.templateSource || 'blank',
      source_template_id: snapshot?.ref.templateId || null,
      source_version_id: snapshot?.ref.versionId || null,
      template_snapshot_json: snapshot ? JSON.stringify(snapshot) : null,
    },
  });
  return serializeDraft(row);
}

export async function getStudioDraft(user: SessionUser, id: string) {
  const row = await prisma.videoStudioDraft.findFirst({ where: { id, owner_user_id: user.id } });
  if (!row) throw new StudioError('草稿不存在或无权访问', 404, 'NOT_FOUND');
  return serializeDraft(row);
}

export async function updateStudioDraft(user: SessionUser, id: string, input: UpdateStudioDraftRequest) {
  if (!Number.isInteger(input?.revision) || input.revision < 1) throw new StudioError('请提供有效的草稿 revision', 400, 'INVALID');
  const current = await prisma.videoStudioDraft.findFirst({ where: { id, owner_user_id: user.id } });
  if (!current) throw new StudioError('草稿不存在或无权访问', 404, 'NOT_FOUND');
  if (current.revision !== input.revision) throw new StudioError('草稿已在其他位置更新，请刷新后重试', 409, 'CONFLICT', { currentRevision: current.revision });
  const snapshot = readTemplateSnapshot(current.template_snapshot_json);
  const recipe = snapshot?.recipe ?? null;
  const name = normalizeName(input.name);
  const groupName = normalizeGroupName(input.groupName);
  const prompt = normalizePrompt(input.prompt);
  const values = normalizeValues(input.values, recipe, { mode: 'draft' });
  const assets = normalizeAssets(input.assets, recipe);
  const parameters = normalizeParameters(input.parameters);
  const previousAssets = parseJsonArray(current.assets_json, '素材') as StudioDraftDto['assets'];
  const previousAssetKeys = new Set(previousAssets.map((asset) => `${asset.assetId}:${asset.type}`));
  await authorizeStudioAssets(user, assets.filter((asset) => !previousAssetKeys.has(`${asset.assetId}:${asset.type}`)));
  const update = await prisma.videoStudioDraft.updateMany({
    where: { id, owner_user_id: user.id, revision: input.revision },
    data: {
      name, group_name: groupName, prompt,
      values_json: JSON.stringify(values),
      assets_json: JSON.stringify(assets),
      parameters_json: JSON.stringify(parameters),
      revision: { increment: 1 },
      updated_at: new Date(),
    },
  });
  if (update.count !== 1) throw new StudioError('草稿已在其他位置更新，请刷新后重试', 409, 'CONFLICT');
  const row = await prisma.videoStudioDraft.findUniqueOrThrow({ where: { id } });
  return serializeDraft(row);
}
