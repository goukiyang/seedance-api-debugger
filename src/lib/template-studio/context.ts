import { prisma } from '@/lib/prisma';
import type { SessionUser } from '@/lib/auth/session';
import { StudioError } from './errors';
import { getStudioTemplate } from './templates';
import type { Prisma } from '@prisma/client';

const GLOBAL_KEY = 'video_studio_context_v1';
const moduleKey = (id: string) => `video_studio_module_context:${id}`;
type ContextSetting = { context: string; revision: number };

export async function copyModuleContext(tx: Prisma.TransactionClient, targetId: string, userId: string, source: { draftId: string } | { text: string }) {
  const row = 'draftId' in source ? await tx.platformSetting.findUnique({ where: { key: moduleKey(source.draftId) } }) : null;
  const context = 'text' in source ? source.text : row ? JSON.parse(row.value_json).context : null;
  if (context !== null) await tx.platformSetting.create({ data: { key: moduleKey(targetId), value_json: JSON.stringify({ context, revision: 1 }), updated_by: userId } });
}

async function readSetting(key: string): Promise<ContextSetting | null> {
  const row = await prisma.platformSetting.findUnique({ where: { key }, select: { value_json: true } });
  if (!row) return null;
  try {
    const data = JSON.parse(row.value_json);
    if (typeof data.context !== 'string' || !Number.isInteger(data.revision)) throw new Error();
    return { context: data.context, revision: data.revision };
  } catch { throw new StudioError('上下文设置暂时无法读取，请重试', 503, 'UNAVAILABLE'); }
}

export async function readVideoGlobalContext() {
  return await readSetting(GLOBAL_KEY) || { context: '', revision: 0 };
}

export async function readVideoModuleContext(id: string, inherited = '') {
  return await readSetting(moduleKey(id)) || { context: inherited, revision: 0 };
}

async function contextAccess(user: SessionUser, draftId?: string) {
  if (!draftId) return { key: GLOBAL_KEY, canEdit: user.role === 'admin', inherited: '' };
  const draft = await prisma.videoStudioDraft.findFirst({ where: { id: draftId, owner_user_id: user.id } });
  if (!draft) throw new StudioError('模块不存在或无权访问', 404, 'NOT_FOUND');
  let inherited = '';
  let canEdit = true;
  if (draft.source_template_id) {
    const detail = await getStudioTemplate(user, draft.source_template_id, draft.template_source as 'studio' | 'legacy');
    canEdit = detail.template.canManage;
  }
  if (draft.template_snapshot_json) {
    try { inherited = JSON.parse(draft.template_snapshot_json).recipe?.instruction || ''; }
    catch { throw new StudioError('模块设置暂时无法读取', 503, 'UNAVAILABLE'); }
  }
  return { key: moduleKey(draftId), canEdit, inherited };
}

export async function getVideoContext(user: SessionUser, draftId?: string) {
  const access = await contextAccess(user, draftId);
  const setting = await readSetting(access.key) || { context: access.inherited, revision: 0 };
  return { revision: setting.revision, configured: Boolean(setting.context.trim()), canEdit: access.canEdit,
    canCopy: user.role === 'admin', ...(access.canEdit ? { context: setting.context } : {}) };
}

export async function saveVideoContext(user: SessionUser, input: unknown, draftId?: string) {
  const access = await contextAccess(user, draftId);
  if (!access.canEdit) throw new StudioError('无权修改此上下文', 403, 'FORBIDDEN');
  const value = input as ContextSetting;
  if (!value || typeof value.context !== 'string' || value.context.length > 12000
    || !Number.isInteger(value.revision) || value.revision < 0) throw new StudioError('上下文最多12000字，请检查后保存', 400, 'INVALID');
  try {
    await prisma.$transaction(async (tx) => {
      const row = await tx.platformSetting.findUnique({ where: { key: access.key } });
      const revision = row ? JSON.parse(row.value_json).revision : 0;
      if (revision !== value.revision) throw new StudioError('上下文已在别处更新，请重新读取后保存', 409, 'CONFLICT');
      const data = { value_json: JSON.stringify({ context: value.context, revision: revision + 1 }), updated_by: user.id };
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
