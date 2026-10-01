import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { AuthError } from '@/lib/auth/session';
import { assertCanUseReferenceImage, uniquePreserveOrder } from '@/lib/reference-albums/permissions';
import { IMAGE_STUDIO_MODELS, IMAGE_STUDIO_MODEL_QUALITY_OPTIONS } from '@/lib/image-studio/model-catalog';
import { IMAGE_RESOLUTION_OPTIONS } from '@/lib/image-generation/resolution';
import { MAX_REFERENCE_IMAGES } from '@/lib/image-studio/limits';
import { getImageStudioSettings } from '@/lib/image-studio/settings';
import { resolveStudioModuleGenerationConfig, validStudioModuleId } from '@/lib/image-studio/modules';
import { submitStudioBatch, StudioError } from '@/lib/image-studio/tasks';
import { normalizeStudioRatio } from '@/lib/image-studio/ratios';
import {
  assertCanvasStyleContext, canvasStyleFailure, canvasStyleJson, parseCanvasStyleContext,
  readCanvasStyleJson, requireCanvasStyleUser,
} from '@/lib/canvas-style-bridge';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const REQUEST_ID_PATTERN = /^[a-zA-Z0-9-]{16,80}$/;
const PRICING_CHANGED_MESSAGE = '风格生成价格或规则已更新。请重新打开风格库重新选择模板，并确认新单价后再生成。';
const MODULE_CHANGED_MESSAGE = '风格模板设置已变化。请重新打开风格库重新应用模板后再生成。';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function invalidSettings() {
  return new StudioError('风格模板的模型、质量、分辨率、张数和画幅已锁定；请重新选择模板，或移除风格恢复普通图片设置。', 409);
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireCanvasStyleUser();
    const body = await readCanvasStyleJson(request);
    const context = parseCanvasStyleContext(body);
    await assertCanvasStyleContext(user, context);

    const moduleId = typeof body.moduleId === 'string' ? body.moduleId : '';
    if (!validStudioModuleId(moduleId, user.id)) throw new AuthError('风格模板模块编号无效', 400);
    const requestId = typeof body.requestId === 'string' ? body.requestId : '';
    if (!REQUEST_ID_PATTERN.test(requestId)) throw new AuthError('生成请求编号无效', 400);
    if (typeof body.prompt !== 'string' || body.prompt.length > 20000) throw new AuthError('画面描述不能超过 20000 字', 400);
    if (!Array.isArray(body.referenceImageIds) || body.referenceImageIds.length > MAX_REFERENCE_IMAGES
      || body.referenceImageIds.some(id => typeof id !== 'string' || id.length > 100)) {
      throw new AuthError(`最多选择 ${MAX_REFERENCE_IMAGES} 张画布参考图`, 400);
    }
    const settingsInput = body.settings;
    if (!isRecord(settingsInput)) throw new AuthError('缺少已确认的风格设置快照', 400);
    const expectedSettingsRevision = body.settingsRevision ?? settingsInput.revision;
    const expectedModuleRevision = body.moduleRevision ?? settingsInput.moduleRevision;
    if (!Number.isInteger(expectedSettingsRevision) || Number(expectedSettingsRevision) < 0
      || !Number.isInteger(expectedModuleRevision) || Number(expectedModuleRevision) < 0) {
      throw new AuthError('缺少风格设置版本，请重新打开风格库后提交', 409);
    }

    const studioModule = await prisma.imageStudioModule.findFirst({
      where: { id: moduleId, owner_id: user.id },
      select: { id: true, model: true, quality: true, resolution: true,
        count: true, aspect_ratio: true, reference_ids: true, revision: true },
    });
    if (!studioModule) throw new AuthError('风格模板模块不存在或无权使用', 404);
    const currentSettings = await getImageStudioSettings();
    if (currentSettings.revision !== Number(expectedSettingsRevision)) throw new StudioError(PRICING_CHANGED_MESSAGE, 409);
    if (studioModule.revision !== Number(expectedModuleRevision)) throw new StudioError(MODULE_CHANGED_MESSAGE, 409);

    const model = typeof settingsInput.model === 'string' ? settingsInput.model : '';
    const quality = typeof settingsInput.quality === 'string' ? settingsInput.quality : '';
    const resolution = typeof settingsInput.resolution === 'string' ? settingsInput.resolution : '';
    const count = settingsInput.count;
    const ratioInput = settingsInput.aspectRatio ?? settingsInput.ratio;
    if (!IMAGE_STUDIO_MODELS.includes(model as typeof IMAGE_STUDIO_MODELS[number])
      || !(IMAGE_STUDIO_MODEL_QUALITY_OPTIONS[model as keyof typeof IMAGE_STUDIO_MODEL_QUALITY_OPTIONS] as readonly string[] | undefined)?.includes(quality)
      || !IMAGE_RESOLUTION_OPTIONS.includes(resolution as typeof IMAGE_RESOLUTION_OPTIONS[number])
      || !Number.isInteger(count) || Number(count) < 1 || Number(count) > 8 || typeof ratioInput !== 'string') {
      throw invalidSettings();
    }
    let aspectRatio: string;
    try { aspectRatio = normalizeStudioRatio(ratioInput); }
    catch { throw invalidSettings(); }

    const generation = resolveStudioModuleGenerationConfig(studioModule, currentSettings);
    const moduleRatio = normalizeStudioRatio(studioModule.aspect_ratio || 'auto');
    if (model !== generation.model || quality !== generation.quality || resolution !== generation.resolution
      || Number(count) !== studioModule.count || aspectRatio !== moduleRatio) throw invalidSettings();
    const unitCredits = currentSettings.prices[generation.model];
    if (unitCredits === null || !Number.isInteger(unitCredits) || unitCredits < 0) {
      throw new StudioError('当前风格模板尚未配置有效单价，请重新选择模板或联系管理员。', 409);
    }

    const requestedReferenceIds = uniquePreserveOrder(body.referenceImageIds as string[]);
    const referenceAssetIds: string[] = [];
    for (const referenceImageId of requestedReferenceIds) {
      const reference = await assertCanUseReferenceImage(user, referenceImageId);
      const asset = reference.asset;
      if (!asset || asset.status !== 'active' || asset.type !== 'image' || !reference.asset_id) {
        throw new AuthError('有画布参考图已不可用，请重新选择后再生成', 409);
      }
      if (asset.owner_id !== user.id) {
        throw new AuthError('风格库生成暂不支持其他用户拥有的共享参考图，请先复制到自己的素材后再选择', 403);
      }
      referenceAssetIds.push(reference.asset_id);
    }

    let moduleReferenceIds: string[];
    try {
      const parsed: unknown = JSON.parse(studioModule.reference_ids);
      if (!Array.isArray(parsed) || parsed.some(id => typeof id !== 'string')) throw new Error();
      moduleReferenceIds = parsed;
    } catch {
      throw new StudioError('风格模板参考图设置无法读取，请重新应用模板', 409);
    }
    const mergedReferenceIds = uniquePreserveOrder([...moduleReferenceIds, ...referenceAssetIds]);
    if (mergedReferenceIds.length > MAX_REFERENCE_IMAGES) {
      throw new StudioError(`模板参考图和本次选择合计不能超过 ${MAX_REFERENCE_IMAGES} 张`, 400);
    }

    const prompt = body.prompt.trim();

    let batchId: string;
    try {
      batchId = await submitStudioBatch(user.id, {
        requestId,
        moduleId,
        moduleRevision: Number(expectedModuleRevision),
        revision: Number(expectedSettingsRevision),
        prompt,
        count: Number(count),
        referenceIds: mergedReferenceIds,
        model: generation.model,
        quality: generation.quality,
        resolution: generation.resolution,
        aspectRatio,
      });
    } catch (error) {
      if (error instanceof StudioError && error.status === 409) {
        if (error.message.includes('模块已在其他页面更新')) throw new StudioError(MODULE_CHANGED_MESSAGE, 409);
        if (error.message.includes('生成规则或通用上下文已更新')) throw new StudioError(PRICING_CHANGED_MESSAGE, 409);
      }
      throw error;
    }
    return canvasStyleJson({ batchId, moduleId, count: Number(count) }, 202);
  } catch (error) {
    return canvasStyleFailure(error, '提交风格生成失败，请通过结果查询确认任务状态后再操作');
  }
}
