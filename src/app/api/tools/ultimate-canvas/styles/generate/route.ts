import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { AuthError } from '@/lib/auth/session';
import { assertCanUseReferenceImage, uniquePreserveOrder } from '@/lib/reference-albums/permissions';
import { IMAGE_STUDIO_MODELS, IMAGE_STUDIO_MODEL_QUALITY_OPTIONS } from '@/lib/image-studio/model-catalog';
import { IMAGE_RESOLUTION_OPTIONS } from '@/lib/image-generation/resolution';
import { MAX_REFERENCE_IMAGES } from '@/lib/image-studio/limits';
import { getImageStudioSettings } from '@/lib/image-studio/settings';
import { resolveStudioModuleGenerationConfig, validStudioModuleId } from '@/lib/image-studio/modules';
import { submitStudioBatch, safeImageChannelSnapshot, StudioError } from '@/lib/image-studio/tasks';
import { roleMediaFingerprint } from '@/lib/canvas-roles/media-bindings';
import { prepareImageBillingQuote } from '@/lib/image-studio/billing-quote-service';
import { withImagePricing } from '@/lib/pricing/image';
import { creditCents } from '@/lib/credits/precision';
import { imageBillingReady } from '@/lib/image-studio/billing-readiness';
import { imageBillingScope } from '@/lib/image-studio/billing-scope';
import { getImageGenerationSettingsForModel, captureImageGenerationChannel, resolveImageGenerationChannelSnapshot, validateImageGenerationChannel, isMuskImageGenerationChannel } from '@/lib/integrations/image-generation';
import { parseCanvasPromptMentions } from '@/lib/canvas-prompt-references';
import { assertCanvasPromptCompatibility } from '@/lib/canvas-prompt-compatibility';
import { normalizeStudioRatio } from '@/lib/image-studio/ratios';
import { resolveImageGenerationRequestChannel } from '@/lib/integrations/image-generation-defaults';
import { captureImageGenerationRequestChannel } from '@/lib/integrations/image-generation';
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
    if (body.roleMediaContext !== undefined) {
      roleMediaFingerprint(body.roleMediaContext);
      const roleContext = body.roleMediaContext as Record<string, unknown>;
      if (roleContext.ownerId !== user.id || roleContext.documentId !== context.documentId
        || roleContext.generationNodeId !== context.nodeId || roleContext.kind !== 'image') throw new AuthError('角色媒体来源与原生成器不匹配', 403);
    }
    if (context.documentId && context.nodeId) {
      const doc = await prisma.canvasDocument.findUniqueOrThrow({ where: { id: context.documentId } });
      const node = JSON.parse(doc.document_json).canvas.nodes.find((item: { id: string }) => item.id === context.nodeId);
      if (node?.data?.roleMediaOrigin && body.roleMediaContext === undefined) throw new AuthError('此生成节点属于固定角色工作，请从原岗位重新打开生成器', 409);
      if (body.roleMediaContext !== undefined && (node?.type !== 'image' || body.action !== 'quote'
        && (node.data?.styleJob?.kind === 'ordinary' || node.data?.styleJob?.requestId !== body.requestId
          || node.data?.styleJob?.moduleId !== body.moduleId || JSON.stringify(node.data?.styleJob?.input) !== JSON.stringify(body)))) {
        throw new AuthError('请先保存本次角色风格请求，再确认提交', 409);
      }
    }
    await assertCanvasPromptCompatibility(user, context.documentId, context.nodeId, String(body.prompt || ''), body.promptMentions);

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
    const requestedChannelId = typeof settingsInput.channelId === 'string' ? settingsInput.channelId : undefined;
    const suppliedImageChannel = body.imageChannel === undefined ? undefined : safeImageChannelSnapshot(body.imageChannel) || undefined;
    if (body.imageChannel !== undefined && !suppliedImageChannel) throw new StudioError('图片通道报价版本无效，请重新报价', 409);
    const effectiveChannelId = generation.model !== 'gpt-image-2.5-sunburst' && requestedChannelId === undefined && suppliedImageChannel
      ? suppliedImageChannel.channelId
      : await resolveImageGenerationRequestChannel(generation.model, requestedChannelId, undefined, quality) || 'original';
    if (suppliedImageChannel && suppliedImageChannel.channelId !== effectiveChannelId) {
      throw new StudioError('当前型号默认图片通道已变化，请重新报价', 409);
    }
    const channelId = requestedChannelId || 'original';
    const freshImageChannel = generation.model === 'gpt-image-2.5-sunburst' ? await captureImageGenerationRequestChannel(generation.model, quality, requestedChannelId) : undefined;
    if (freshImageChannel && suppliedImageChannel && JSON.stringify(freshImageChannel) !== JSON.stringify(suppliedImageChannel)) throw new StudioError('图片质量路由已变化，请重新报价', 409);
    const imageChannel = freshImageChannel || suppliedImageChannel || (effectiveChannelId === 'original' ? undefined : await captureImageGenerationChannel(generation.model, effectiveChannelId));
    const rawApiSettings = imageChannel?.channelId === 'original' ? await getImageGenerationSettingsForModel(generation.model)
      : imageChannel ? await resolveImageGenerationChannelSnapshot(imageChannel, undefined, true, generation.model) : await getImageGenerationSettingsForModel(generation.model);
    const priced = await withImagePricing(rawApiSettings, generation.model, prisma, undefined, { quality, resolution, ratio: aspectRatio });
    const apiSettings = priced.settings;
    let unitCredits = currentSettings.prices[generation.model];
    let channelActual = false;
    if (imageChannel) {
      const validation = validateImageGenerationChannel(apiSettings, { model: generation.model, quality, resolution, ratio: aspectRatio });
      if (!validation.ok) throw new StudioError(validation.error, 409);
      unitCredits = validation.capability.fixedPoints;
      channelActual = validation.capability.billingMode === 'actual';
    }
    if (priced.quote) unitCredits = priced.quote.credits;
    if (body.action !== 'quote' && !body.billingQuoteId && (priced.quote || channelActual || !imageChannel && isMuskImageGenerationChannel(apiSettings) && apiSettings.api_key
      && (await imageBillingReady(imageBillingScope(apiSettings), generation.model)).ready)) {
      throw new StudioError('请先确认本次风格图片的新报价；尚未派发生成', 409);
    }
    if (!channelActual && (unitCredits === null || !Number.isFinite(unitCredits) || unitCredits < 0
      || (priced.quote ? !Number.isSafeInteger(creditCents(unitCredits)) : !Number.isInteger(unitCredits)))) {
      throw new StudioError('当前风格模板尚未配置有效单价，请重新选择模板或联系管理员。', 409);
    }

    const requestedReferenceIds = uniquePreserveOrder(body.referenceImageIds as string[]);
    const mentions = parseCanvasPromptMentions(body.promptMentions);
    if (mentions && requestedReferenceIds.length !== body.referenceImageIds.length) throw new AuthError('绑定参考图重复，请重新选择', 400);
    const referenceAssets: Record<string, string> = {};
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
      referenceAssets[referenceImageId] = reference.asset_id;
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

    const submission = { requestId, projectId: context.projectId, moduleId, moduleRevision: Number(expectedModuleRevision),
      revision: Number(expectedSettingsRevision), prompt, count: Number(count), referenceIds: mergedReferenceIds,
      model: generation.model, ...(requestedChannelId !== undefined || !suppliedImageChannel ? { channelId } : {}), imageChannel: body.imageChannel || imageChannel, quality: generation.quality, resolution: generation.resolution, aspectRatio,
      billingQuoteId: body.billingQuoteId, pricingRevision: body.pricingRevision, maxEstimatedCost: body.maxEstimatedCost };
    const promptBinding = mentions ? { mentions, referenceAssets } : undefined;
    const canvasUse = body.roleMediaContext === undefined ? undefined : { user, referenceImageIds: requestedReferenceIds, projectId: context.projectId };
    if (body.action === 'quote') return canvasStyleJson(await prepareImageBillingQuote(user.id, submission, undefined, canvasUse, promptBinding));

    let batchId: string;
    try {
      batchId = await submitStudioBatch(user.id, submission, undefined, undefined, canvasUse, promptBinding,
        body.roleMediaContext === undefined ? undefined : { user, context: body.roleMediaContext, generationNodeId: context.nodeId! });
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
