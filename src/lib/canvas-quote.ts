import { assertInternalOnly } from '@/lib/access/feature-guard';
import { AuthError, type SessionUser } from '@/lib/auth/session';
import { assertCanGenerateInProject } from '@/lib/projects/permissions';
import { getImageStudioSettings } from '@/lib/image-studio/settings';
import { IMAGE_STUDIO_MODELS, IMAGE_STUDIO_MODEL_LABELS, IMAGE_STUDIO_MODEL_QUALITY_OPTIONS, type ImageStudioModel } from '@/lib/image-studio/model-catalog';
import { getImageGenerationChannels, selectImageGenerationSettings, isImageGenerationApiReady, captureImageGenerationChannel, resolveImageGenerationChannelSnapshot, validateImageGenerationChannel, isMuskImageGenerationChannel, getImageGenerationChannelOptions } from '@/lib/integrations/image-generation';
import { isGeminiImageModel, imageResolutionOptions } from '@/lib/image-generation/resolution';
import { imageBillingReady } from '@/lib/image-studio/billing-readiness';
import { imageBillingScope } from '@/lib/image-studio/billing-scope';
import { resolveImageGenerationRequestChannel } from '@/lib/integrations/image-generation-defaults';

export type CanvasQuoteInput = {
  kind: 'image';
  project_id: string;
  model: string;
  count: number;
  resolution?: string;
  ratio?: string;
  size?: string;
  quality?: string;
  channelId?: string;
};

export function parseCanvasQuoteInput(value: unknown): CanvasQuoteInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AuthError('报价参数无效', 400);
  const body = value as Record<string, unknown>;
  const allowed = new Set(['kind', 'project_id', 'model', 'count', 'resolution', 'ratio', 'size', 'quality', 'channelId']);
  if (Object.keys(body).some(key => !allowed.has(key)) || body.kind !== 'image') {
    throw new AuthError('仅支持普通图片节点报价，请勿传入金额或资产', 400);
  }
  for (const key of ['project_id', 'model']) {
    const raw = body[key];
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 128) {
      throw new AuthError('项目或模型参数无效', 400);
    }
  }
  if (typeof body.count !== 'number' || !Number.isInteger(body.count) || body.count < 1 || body.count > 8) {
    throw new AuthError('生成张数必须为 1 至 8 的整数', 400);
  }
  const specs: Partial<CanvasQuoteInput> = {};
  for (const key of ['resolution', 'ratio', 'size', 'quality', 'channelId'] as const) {
    const raw = body[key];
    if (raw === undefined) continue;
    if (typeof raw !== 'string' || raw.length > 64) throw new AuthError('图片规格参数无效', 400);
    specs[key] = raw.trim();
  }
  return { ...specs, kind: 'image', project_id: (body.project_id as string).trim(), model: (body.model as string).trim(), count: body.count };
}

// An estimate is not a wallet reservation, submission authorization, or payable quote.
export async function getCanvasImageQuote(user: SessionUser, input: CanvasQuoteInput) {
  assertInternalOnly(user, '外部账号无权使用无限画布。');
  await assertCanGenerateInProject(user, input.project_id);
  const channels = await getImageGenerationChannels();
  const effectiveChannelId = IMAGE_STUDIO_MODELS.includes(input.model as ImageStudioModel)
    ? await resolveImageGenerationRequestChannel(input.model as ImageStudioModel, input.channelId) || 'original'
    : input.channelId && input.channelId !== 'original' ? input.channelId : 'original';
  const imageChannel = effectiveChannelId !== 'original' ? await captureImageGenerationChannel(input.model, effectiveChannelId) : undefined;
  const providerSettings = imageChannel ? await resolveImageGenerationChannelSnapshot(imageChannel, undefined, true) : selectImageGenerationSettings(channels, input.model);
  if (imageChannel) {
    const capability = validateImageGenerationChannel(providerSettings, { model: input.model, quality: input.quality, resolution: input.resolution, ratio: input.ratio });
    if (!capability.ok) throw new AuthError(capability.error, 400);
  }
  const studio = await getImageStudioSettings();
  const provider = providerSettings.provider;
  if (input.quality !== undefined && IMAGE_STUDIO_MODELS.includes(input.model as ImageStudioModel)
    && !(IMAGE_STUDIO_MODEL_QUALITY_OPTIONS[input.model as ImageStudioModel] as readonly string[]).includes(input.quality)) throw new AuthError('所选模型不支持此图片质量，请重新选择', 400);
  if (input.resolution !== undefined && !imageResolutionOptions(input.model, provider).includes(input.resolution as never)) throw new AuthError('所选模型不支持此分辨率，请重新选择', 400);
  const channelOptions = imageChannel ? await getImageGenerationChannelOptions() : null;
  const models = imageChannel ? Object.keys(channelOptions?.items.find(item => item.id === imageChannel.channelId)?.models || {}) : channels.shared.provider === 'seedream'
    ? [channels.shared.default_model, ...IMAGE_STUDIO_MODELS.filter(isGeminiImageModel)]
    : Array.from(new Set([...IMAGE_STUDIO_MODELS, channels.shared.default_model]));
  // Explicit channels enqueue single-image tasks; eight is our submission/queue
  // limit, not a claim that this supplier supports n=8 in one upstream POST.
  const maximumCount = imageChannel ? 8 : provider === 'seedream' ? 1 : providerSettings.max_outputs_per_request;
  const quoteModel = async (model: string) => {
    const api = imageChannel || model === input.model ? providerSettings : selectImageGenerationSettings(channels, model);
    const providerReady = isImageGenerationApiReady(api);
    const modelMaximumCount = imageChannel ? 8 : api.provider === 'seedream' ? 1 : api.max_outputs_per_request;
    const studioModel = IMAGE_STUDIO_MODELS.includes(model as ImageStudioModel);
    const allowedModel = api.provider === 'seedream' ? model === channels.shared.default_model : studioModel;
    const capability = imageChannel ? validateImageGenerationChannel(api, { model, quality: input.quality, resolution: input.resolution, ratio: input.ratio }) : null;
    const configuredCapability = capability?.ok ? capability.capability : null;
    const price = imageChannel ? configuredCapability?.fixedPoints ?? null : api.provider !== 'seedream' && studioModel ? studio.prices[model as ImageStudioModel] : null;
    const actualQuoteRequired = imageChannel ? configuredCapability?.billingMode === 'actual' : isMuskImageGenerationChannel(api) && Boolean(api.api_key)
      && (await imageBillingReady(imageBillingScope(api), model)).ready;
    const estimated = typeof price === 'number' ? price * input.count : null;
    const reason = !allowedModel ? 'model_unavailable'
      : !providerReady ? 'provider_unavailable'
        : capability && !capability.ok ? capability.code
        : input.count > modelMaximumCount ? 'count_exceeds_limit'
          : !actualQuoteRequired && (typeof price !== 'number' || !Number.isSafeInteger(price) || price < 0
            || estimated === null || !Number.isSafeInteger(estimated)) ? 'price_unconfigured' : null;
    return {
      model,
      label: studioModel ? IMAGE_STUDIO_MODEL_LABELS[model as ImageStudioModel] : (api.provider === 'seedream' ? 'Seedream 5.0 Pro' : model),
      status: reason ? 'unavailable' as const : 'estimate' as const,
      reason,
      unitCredits: reason || actualQuoteRequired ? null : price,
      estimatedCredits: reason || actualQuoteRequired ? null : estimated,
      count: input.count,
      chargeEnabled: false as const,
      billingMode: actualQuoteRequired ? 'actual' as const : 'fixed' as const,
      actualQuoteRequired,
      estimateSource: imageChannel ? 'channel_contract' as const : 'legacy_fixed' as const,
      creditPrecision: 0.01,
    };
  };
  const now = Date.now();
  return {
    ...await quoteModel(input.model),
    kind: 'image' as const,
    scope: 'ordinary_image' as const,
    projectId: input.project_id,
    provider,
    channelId: input.channelId || 'original',
    imageChannel,
    maximumCount,
    revision: studio.revision,
    pricingBasis: 'global_model_per_image' as const,
    accountScope: 'none' as const,
    confirmationPending: true,
    specifications: { resolution: input.resolution || null, ratio: input.ratio || null, size: input.size || null, quality: input.quality || null },
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    modelOptions: await Promise.all(models.map(quoteModel)),
  };
}
