import 'server-only';
import type { Prisma, WorkContext as ContextRow } from '@prisma/client';
import { prisma, retrySqliteBusy } from '@/lib/prisma';
import type { SessionUser } from '@/lib/auth/session';
import { canViewStudioPreset } from '@/lib/image-studio/access';
import { studioPresetArchived } from '@/lib/image-studio/preset-lifecycle';
import { prepareSharedStudioMethodWorkspace, parseSharedStudioPersonalOverrides } from '@/lib/image-studio/shared-contract';
import { IMAGE_STUDIO_NEW_REQUEST_MODELS, IMAGE_STUDIO_MODEL_RESOLUTION_OPTIONS, imageStudioNewQualityOptions } from '@/lib/image-studio/model-catalog';
import type { SharedStudioPersonalOverrides } from '@/lib/image-studio/shared-types';
import { prepareStudioTemplateMethodDraft } from '@/lib/template-studio/drafts';
import { getStudioTemplateUseAccess } from '@/lib/template-studio/templates';
import { StudioError } from '@/lib/template-studio/errors';
import { normalizeParameters } from '@/lib/template-studio/validation';
import type { StudioJsonValue } from '@/lib/template-studio/types';
import { mapStudioVideoParameters } from '@/lib/template-studio-video-handoff';
import { isSeedanceVideoModelId } from '@/lib/provider/seedance-models';
import { isH3PresetId, isH3LoraId } from '@/lib/integrations/h3';
import { getWorkAccess, type WorkAccess } from './access';
import { runWorkOperation } from './operations';
import { WorkError } from './types';
import type { WorkMethod, WorkMethodSetting, WorkMethodTemplate } from './context-types';

const fallback = (access: WorkAccess, reason: string): WorkMethod['action'] => access.reuse
  ? { kind: 'reference', label: '仅作参考', reason } : { kind: 'unavailable', label: '原方法不可执行', reason };
function settings(row: ContextRow): WorkMethodSetting[] {
  const parsed: unknown = JSON.parse(row.settings_json);
  return Array.isArray(parsed) ? parsed as WorkMethodSetting[] : [];
}

type MethodPreparation = { image?: SharedStudioPersonalOverrides; video?: Record<string, StudioJsonValue>; reason?: string };
async function methodPreparation(access: WorkAccess, row: ContextRow, db: Prisma.TransactionClient): Promise<MethodPreparation> {
  const actual = Object.fromEntries(settings(row).map(setting => [setting.key, setting.value]));
  if (row.template_module === 'image-preset') {
    if (['model', 'quality', 'resolution', 'aspectRatio'].some(key => typeof actual[key] !== 'string')) return { reason: '原作品缺少完整的模型、画质、分辨率或比例设置，不能套用模板默认值' };
    try {
      const image = parseSharedStudioPersonalOverrides({ model: actual.model, quality: actual.quality, resolution: actual.resolution, aspectRatio: actual.aspectRatio });
      if (!IMAGE_STUDIO_NEW_REQUEST_MODELS.some(model => model === image.model)
        || !imageStudioNewQualityOptions(image.model!).includes(image.quality!)
        || !IMAGE_STUDIO_MODEL_RESOLUTION_OPTIONS[image.model!].includes(image.resolution!)) {
        return { reason: '原型号或规格不能作为相同的新选择恢复，不能自动换型或更改参数' };
      }
      return { image };
    } catch { return { reason: '原图片设置无法按当前规则原样恢复，不能套用模板默认值' }; }
  }
  if (row.template_module === 'video-studio') {
    const source = access.work.source_kind === 'video_task' ? await db.videoTask.findUnique({ where: { id: access.work.source_id }, select: {
      provider: true, model: true, generation_mode: true, ratio: true, duration: true, resolution: true, seed: true,
      generate_audio: true, return_last_frame: true, watermark: true, is_draft: true, template_studio_snapshot_json: true,
    } }) : null;
    if (!source || ['model', 'resolution', 'aspectRatio', 'duration', 'generateAudio'].some(key => actual[key] === undefined)
      || actual.model !== source.model || actual.resolution !== source.resolution || actual.aspectRatio !== source.ratio
      || actual.duration !== source.duration || actual.generateAudio !== source.generate_audio
      || source.seed !== null && actual.seed !== source.seed) return { reason: '原视频关键设置不完整或已变化，不能套用模板默认值' };
    if (!(source.provider === 'seedance' && isSeedanceVideoModelId(source.model) || source.provider === 'h3' && isH3PresetId(source.model))) {
      return { reason: '原视频型号无法由当前模板草稿原样承接，不能自动换型' };
    }
    const parameters: Record<string, StudioJsonValue> = { provider: source.provider, model: source.model, generationMode: source.generation_mode,
      ratio: source.ratio!, duration: source.duration!, resolution: source.resolution!, seed: source.seed ?? -1,
      generateAudio: source.generate_audio, returnLastFrame: source.return_last_frame, watermark: source.watermark, draft: source.is_draft };
    if (source.provider === 'h3') {
      let lora: unknown;
      try { lora = JSON.parse(source.template_studio_snapshot_json || '{}').submitted?.parameters?.h3LoraId; } catch { /* Missing frozen public LoRA cannot borrow the current default. */ }
      if (!isH3LoraId(lora)) return { reason: '原视频缺少可确认的公开 LoRA 设置，不能改用当前默认值' };
      parameters.h3LoraId = lora;
    }
    try {
      const mapped = mapStudioVideoParameters(parameters);
      if (mapped.unsupported.length) return { reason: '原视频参数无法由当前生成设置完整承接，不能套用默认值' };
      return { video: normalizeParameters(mapped.supported) };
    } catch { return { reason: '原视频参数不符合当前合法规格，不能套用默认值' }; }
  }
  return {};
}

/** Reads only public provenance and current source authority; private recipe fields never enter the response. */
export async function readIndexedWorkMethod(user: SessionUser, access: WorkAccess, row: ContextRow, db: Prisma.TransactionClient = prisma,
  prepared?: MethodPreparation): Promise<WorkMethod> {
  const result: WorkMethod = { kind: 'settings', label: '生成设置', settings: settings(row), action: fallback(access, '没有可安全执行的原模板版本，成品仍可按现有权限使用') };
  if (row.media_version_id !== access.media.id || !row.template_module || !row.template_id || !row.template_version) return result;
  let template: WorkMethodTemplate | null = null, executable = false, reason = '这类历史模板暂不支持完整原版复用';
  if (row.template_module === 'image-preset') {
    const preset = await db.imageStudioPreset.findUnique({ where: { id: row.template_id } });
    if (preset && canViewStudioPreset(user, preset) && !await studioPresetArchived(preset.id, db)) {
      template = { module: 'image-preset', id: preset.id, version: row.template_version, label: preset.name };
      executable = preset.updated_at.toISOString() === row.template_version && Boolean(row.template_token);
      reason = executable ? '' : '原作品使用的模板版本已变化或缺少原版本凭据，不能改用新版';
    } else reason = '原模板已不可用或当前没有使用权限';
  } else if (row.template_module === 'image-module') {
    const studioModule = await db.imageStudioModule.findFirst({ where: { id: row.template_id, owner_id: user.id } });
    if (studioModule) template = { module: 'image-module', id: studioModule.id, version: row.template_version, label: studioModule.name };
    reason = '私人工作区的历史输入无法安全完整复原，保留成品参考';
  } else if (row.template_module === 'video-studio') {
    try { await getStudioTemplateUseAccess(user, row.template_id, 'studio', db); }
    catch (error) {
      if (error instanceof StudioError && [403, 404, 409].includes(error.status)) {
        result.action = fallback(access, '原模板已不可用或当前没有使用权限');
        return result;
      }
      throw error;
    }
    const current = await db.videoStudioTemplate.findUnique({ where: { id: row.template_id }, include: { published_version: true } });
    const allowed = current && current.status !== 'archived';
    if (allowed) {
      const published = current.visibility === 'shared' && current.status === 'published' ? current.published_version : null;
      template = { module: 'video-studio', id: current.id, version: row.template_version, label: published?.name || current.name };
      executable = row.template_version === (published?.id || `studio:${current.revision}`);
      reason = executable ? '' : '原作品使用的模板版本已变化，不能改用新版';
    } else reason = '原模板已不可用或当前没有使用权限';
  } else if (row.template_module === 'video-legacy') {
    try { await getStudioTemplateUseAccess(user, row.template_id, 'legacy', db); }
    catch (error) {
      if (error instanceof StudioError && [403, 404, 409].includes(error.status)) {
        result.action = fallback(access, '原模板已不可用或当前没有使用权限');
        return result;
      }
      throw error;
    }
    const legacy = await db.generationTemplate.findFirst({ where: { id: row.template_id, status: 'active' }, select: { id: true, name: true } });
    if (legacy) template = { module: 'video-legacy', id: legacy.id, version: row.template_version, label: legacy.name };
    reason = '旧版模板不支持在此准备完整原版草稿，请按现有成品权限参考';
  }
  if (template) {
    result.template = template;
    result.kind = template.module.startsWith('image-') ? 'image-template' : 'video-template';
    result.label = template.label;
  }
  if (executable) {
    const preparation = prepared || await methodPreparation(access, row, db);
    if (preparation.reason) { executable = false; reason = preparation.reason; }
  }
  result.action = executable ? { kind: 'template', label: '用这个模板做' } : fallback(access, reason);
  return result;
}

export async function prepareWorkMethod(user: SessionUser, workId: string, input: { viewerId: unknown; requestId: unknown; expectedMediaVersion: unknown; expectedTemplateVersion?: unknown }) {
  if (typeof input.expectedMediaVersion !== 'string' || typeof input.expectedTemplateVersion !== 'string') throw new WorkError('请重新读取作品方法后再操作', 409, 'WORKS_METHOD_VERSION_REQUIRED');
  return retrySqliteBusy(() => runWorkOperation(user, { viewerId: input.viewerId, requestId: input.requestId,
    intent: { action: 'prepare-work-method', workId, mediaVersion: input.expectedMediaVersion, templateVersion: input.expectedTemplateVersion } }, async (db, actor) => {
    const access = await getWorkAccess(actor, workId, db);
    if (!access?.canPreview) throw new WorkError('作品不存在或无权查看', 404, 'WORKS_NOT_FOUND');
    if (access.media.id !== input.expectedMediaVersion) throw new WorkError('作品版本已变化，请重新打开', 409, 'WORKS_VERSION_CHANGED');
    const context = await db.workContext.findUnique({ where: { work_id: workId } });
    if (!context || context.media_version_id !== access.media.id || context.template_version !== input.expectedTemplateVersion) throw new WorkError('原方法版本已变化，请重新打开作品', 409, 'WORKS_METHOD_CHANGED');
    const prepared = await methodPreparation(access, context, db);
    const method = await readIndexedWorkMethod(actor, access, context, db, prepared);
    if (method.action.kind !== 'template' || !method.template) throw new WorkError(method.action.reason || '当前方法无法安全执行', 409, 'WORKS_METHOD_UNAVAILABLE');
    try {
      if (method.template.module === 'image-preset') {
        const moduleId = await prepareSharedStudioMethodWorkspace(actor, method.template.id, method.template.version, context.template_token, db, prepared.image!);
        return { workId, href: `/template-studio?type=image&moduleId=${encodeURIComponent(moduleId)}`, kind: 'image-template', moduleId, draftId: null };
      }
      if (method.template.module === 'video-studio') {
        await getStudioTemplateUseAccess(actor, method.template.id, 'studio', db);
        const draftId = await prepareStudioTemplateMethodDraft(db, actor, method.template.id, method.template.version, prepared.video!);
        return { workId, href: `/template-studio?type=video&view=templates&draftId=${encodeURIComponent(draftId)}&moduleId=${encodeURIComponent(draftId)}`, kind: 'video-template', moduleId: null, draftId };
      }
    } catch (error) {
      if (error && typeof error === 'object' && 'status' in error && [400, 403, 404, 409].includes(Number(error.status))) {
        throw new WorkError(error instanceof Error ? error.message : '原模板当前无法使用', Number(error.status), 'WORKS_METHOD_UNAVAILABLE');
      }
      throw error;
    }
    throw new WorkError('原方法暂不支持安全复用', 409, 'WORKS_METHOD_UNAVAILABLE');
  }), 2);
}
