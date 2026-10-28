import { prisma } from '@/lib/prisma';
import type { SessionUser } from '@/lib/auth/session';
import { StudioError } from './errors';
import { getStudioTemplate } from './templates';
import type { Prisma } from '@prisma/client';
import { privateOrigin, isPrivatePromptError, type PrivateOrigin } from '@/lib/security/private-prompts.server';
import { privateFieldBinding, privateFieldOrigins, readPrivateFields, writePrivateFields } from '@/lib/security/private-prompt-fields.server';
import { privatePromptRequestCapabilities, requirePrivatePromptRequest } from '@/lib/security/private-prompt-request.server';
import { readPrivateVideoRecipe, videoTemplateOrigins } from './private-storage.server';

const GLOBAL_KEY = 'video_studio_context_v1';
const moduleKey = (id: string) => `video_studio_module_context:${id}`;
type ContextSetting = { context: string; revision: number };
type ContextClient = Pick<Prisma.TransactionClient, 'platformSetting' | 'videoStudioDraft'>;

function fieldSpec(key: string, origins?: PrivateOrigin[]) {
  const kind = key === GLOBAL_KEY ? 'video-global' : 'video-module-context';
  const id = key === GLOBAL_KEY ? key : key.slice('video_studio_module_context:'.length);
  const origin = privateOrigin(kind, id);
  return { kind, id, fields: [{ field: 'context', origins: origins || (origin ? [origin] : []) }] };
}
function readContext(key: string, value: ContextSetting, origins?: PrivateOrigin[]) {
  const spec = fieldSpec(key, origins);
  return readPrivateFields(value, spec.kind, spec.id, spec.fields);
}
function writeContext(key: string, value: ContextSetting, origins?: PrivateOrigin[]) {
  const spec = fieldSpec(key, origins);
  return writePrivateFields(value, spec.kind, spec.id, spec.fields);
}
export async function copyModuleContext(tx: Prisma.TransactionClient, targetId: string, userId: string, source: { draftId: string } | { text: string; origins: PrivateOrigin[] }) {
  const row = 'draftId' in source ? await tx.platformSetting.findUnique({ where: { key: moduleKey(source.draftId) } }) : null;
  const previous = row && 'draftId' in source ? readContext(moduleKey(source.draftId), JSON.parse(row.value_json)) : null;
  const context = 'text' in source ? source.text : previous?.context ?? null;
  const origins = 'text' in source ? source.origins : previous ? privateFieldOrigins(previous, 'context') : [];
  if (context !== null) await tx.platformSetting.create({ data: { key: moduleKey(targetId),
    value_json: JSON.stringify(writeContext(moduleKey(targetId), { context, revision: 1 }, origins)), updated_by: userId } });
}

async function readSetting(key: string, origins?: PrivateOrigin[], client: ContextClient = prisma): Promise<ContextSetting | null> {
  const row = await client.platformSetting.findUnique({ where: { key }, select: { value_json: true } });
  if (!row) return null;
  try {
    const data = JSON.parse(row.value_json);
    if (typeof data.context !== 'string' || !Number.isInteger(data.revision)) throw new Error();
    return readContext(key, data, origins);
  } catch (error) {
    if (isPrivatePromptError(error)) throw error;
    throw new StudioError('上下文设置暂时无法读取，请重试', 503, 'UNAVAILABLE'); }
}

export async function readVideoGlobalContext() {
  return await readSetting(GLOBAL_KEY) || { context: '', revision: 0 };
}

export async function readVideoModuleContext(id: string, inherited = '') {
  return await readSetting(moduleKey(id)) || { context: inherited, revision: 0 };
}

async function contextAccess(user: SessionUser, draftId?: string, client: ContextClient = prisma) {
  if (!draftId) return { key: GLOBAL_KEY, canEdit: user.role === 'admin', inherited: '', origins: fieldSpec(GLOBAL_KEY).fields[0].origins };
  const draft = await client.videoStudioDraft.findFirst({ where: { id: draftId, purpose: 'studio', ...(user.role === 'admin' ? {} : { owner_user_id: user.id }) } });
  if (!draft) throw new StudioError('模块不存在或无权访问', 404, 'NOT_FOUND');
  let inherited = '';
  let canEdit = true;
  if (draft.source_template_id) {
    const detail = await getStudioTemplate(user, draft.source_template_id, draft.template_source as 'studio' | 'legacy');
    canEdit = detail.template.canManage;
  }
  if (draft.template_snapshot_json) {
    try { inherited = readPrivateVideoRecipe(JSON.stringify(JSON.parse(draft.template_snapshot_json).recipe), 'video-draft', draft.id,
      draft.source_template_id ? videoTemplateOrigins(draft.source_template_id) : []).instruction; }
    catch (error) { if (isPrivatePromptError(error)) throw error; throw new StudioError('模块设置暂时无法读取', 503, 'UNAVAILABLE'); }
  }
  const origin = privateOrigin('video-module-context', draftId, draft.owner_user_id);
  const origins = draft.source_template_id ? videoTemplateOrigins(draft.source_template_id) : origin ? [origin] : [];
  return { key: moduleKey(draftId), canEdit, inherited, origins };
}

export async function privateVideoContextTarget(user: SessionUser, draftId?: string, client: ContextClient = prisma) {
  const access = await contextAccess(user, draftId, client);
  const raw = await client.platformSetting.findUnique({ where: { key: access.key }, select: { value_json: true } });
  const spec = fieldSpec(access.key, access.origins);
  const origins = raw ? privateFieldBinding(JSON.parse(raw.value_json).context, spec.kind, spec.id, 'context', spec.fields[0].origins)?.origins || [] : spec.fields[0].origins;
  if (!origins.length) throw new StudioError('此设置不使用私密编辑入口', 409, 'CONFLICT');
  await requirePrivatePromptRequest(user.id, origins);
  const setting = await readSetting(access.key, origins, client) || { context: access.inherited, revision: 0 };
  return { access, setting, draftTarget: { kind: 'video-context', id: access.key, origins, fields: ['prompt', 'context'] } };
}

export async function writePrivateVideoContext(tx: ContextClient, user: SessionUser, target: Awaited<ReturnType<typeof privateVideoContextTarget>>, context: string) {
  const { access, setting, draftTarget } = target;
  await requirePrivatePromptRequest(user.id, draftTarget.origins);
  const row = await tx.platformSetting.findUnique({ where: { key: access.key } });
  const revision = row ? JSON.parse(row.value_json).revision : 0;
  if (revision !== setting.revision) throw new StudioError('上下文已变化，请重新读取', 409, 'CONFLICT');
  const data = { value_json: JSON.stringify(writeContext(access.key, { context, revision: revision + 1 }, draftTarget.origins)), updated_by: user.id };
  if (row) {
    const changed = await tx.platformSetting.updateMany({ where: { id: row.id, value_json: row.value_json }, data });
    if (changed.count !== 1) throw new StudioError('上下文已变化，请重新读取', 409, 'CONFLICT');
  } else await tx.platformSetting.create({ data: { key: access.key, ...data } });
  return revision + 1;
}

export async function getVideoContext(user: SessionUser, draftId?: string, includePrivate = false) {
  const access = await contextAccess(user, draftId);
  const raw = await prisma.platformSetting.findUnique({ where: { key: access.key }, select: { value_json: true } });
  const spec = fieldSpec(access.key, access.origins);
  const origins = raw ? privateFieldBinding(JSON.parse(raw.value_json).context, spec.kind, spec.id, 'context', spec.fields[0].origins)?.origins || [] : spec.fields[0].origins;
  const capabilities = await privatePromptRequestCapabilities(user.id, origins);
  if (includePrivate && !origins.length && !access.canEdit) throw new StudioError('无权查看此上下文', 403, 'FORBIDDEN');
  if (includePrivate && origins.length) await requirePrivatePromptRequest(user.id, origins);
  const setting = await readSetting(access.key, origins) || { context: access.inherited, revision: 0 };
  return { revision: setting.revision, editorUserId: user.id, privateContext: origins.length > 0, configured: Boolean(setting.context.trim()), canEdit: origins.length ? capabilities.canEditPrivatePrompt : access.canEdit,
    canCopy: origins.length ? capabilities.canReadPrivatePrompt : user.role === 'admin', ...capabilities, ...(includePrivate || !origins.length && access.canEdit ? { context: setting.context } : {}) };
}

export async function saveVideoContext(user: SessionUser, input: unknown, draftId?: string) {
  const access = await contextAccess(user, draftId);
  if (!access.canEdit) throw new StudioError('无权修改此上下文', 403, 'FORBIDDEN');
  const existing = await prisma.platformSetting.findUnique({ where: { key: access.key }, select: { value_json: true } });
  const spec = fieldSpec(access.key, access.origins);
  const origins = existing ? privateFieldBinding(JSON.parse(existing.value_json).context, spec.kind, spec.id, 'context', spec.fields[0].origins)?.origins || [] : spec.fields[0].origins;
  if (origins.length) throw new StudioError('请通过原文入口修改上下文', 409, 'CONFLICT');
  const value = input as ContextSetting;
  if (!value || typeof value.context !== 'string' || value.context.length > 12000
    || !Number.isInteger(value.revision) || value.revision < 0) throw new StudioError('上下文最多12000字，请检查后保存', 400, 'INVALID');
  try {
    await prisma.$transaction(async (tx) => {
      const row = await tx.platformSetting.findUnique({ where: { key: access.key } });
      const revision = row ? JSON.parse(row.value_json).revision : 0;
      if (revision !== value.revision) throw new StudioError('上下文已在别处更新，请重新读取后保存', 409, 'CONFLICT');
      const data = { value_json: JSON.stringify(writeContext(access.key, { context: value.context, revision: revision + 1 }, origins)), updated_by: user.id };
      if (row) {
        const update = await tx.platformSetting.updateMany({ where: { id: row.id, value_json: row.value_json }, data });
        if (update.count !== 1) throw new StudioError('上下文已变化，请重新读取', 409, 'CONFLICT');
      } else await tx.platformSetting.create({ data: { key: access.key, ...data } });
    });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') throw new StudioError('上下文已变化，请重新读取', 409, 'CONFLICT');
    throw error;
  }
  return getVideoContext(user, draftId);
}
