import { assertInternalOnly } from '@/lib/access/feature-guard';
import { AuthError, type SessionUser } from '@/lib/auth/session';
import { assertCanGenerateInProject } from '@/lib/projects/permissions';
import { getImageStudioSettings } from '@/lib/image-studio/settings';
import { IMAGE_STUDIO_MODELS, IMAGE_STUDIO_MODEL_LABELS, IMAGE_STUDIO_MODEL_QUALITY_OPTIONS, type ImageStudioModel } from '@/lib/image-studio/model-catalog';
import { getImageGenerationChannels, selectImageGenerationSettings, isImageGenerationApiReady } from '@/lib/integrations/image-generation';
import { isGeminiImageModel, imageResolutionOptions } from '@/lib/image-generation/resolution';

export type CanvasQuoteInput = {
  kind: 'image';
  project_id: string;
  model: string;
  count: number;
  resolution?: string;
  ratio?: string;
  size?: string;
  quality?: string;
};

export function parseCanvasQuoteInput(value: unknown): CanvasQuoteInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AuthError('报价参数无效', 400);
  const body = value as Record<string, unknown>;
  const allowed = new Set(['kind', 'project_id', 'model', 'count', 'resolution', 'ratio', 'size', 'quality']);
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
  for (const key of ['resolution', 'ratio', 'size', 'quality'] as const) {
    const raw = body[key];
    if (raw === undefined) continue;
    if (typeof raw !== 'string' || raw.length > 64) throw new AuthError('图片规格参数无效', 400);
    specs[key] = raw.trim();
  }
  return { ...specs, kind: 'image', project_id: (body.project_id as string).trim(), model: (body.model as string).trim(), count: body.count };
}

// An estimate is not a wallet reservation, submission authorization, or payable quote.
export async function getCanvasImageQuote(user: SessionUser, input: CanvasQuoteInput) {
  assertInternalOnly(user, '外部账号无权使用无线画布。');
  await assertCanGenerateInProject(user, input.project_id);
  const channels = await getImageGenerationChannels();
  const providerSettings = selectImageGenerationSettings(channels, input.model);
  const studio = await getImageStudioSettings();
  const provider = providerSettings.provider;
  if (input.quality !== undefined && IMAGE_STUDIO_MODELS.includes(input.model as ImageStudioModel)
    && !(IMAGE_STUDIO_MODEL_QUALITY_OPTIONS[input.model as ImageStudioModel] as readonly string[]).includes(input.quality)) throw new AuthError('所选模型不支持此图片质量，请重新选择', 400);
  if (input.resolution !== undefined && !imageResolutionOptions(input.model, provider).includes(input.resolution as never)) throw new AuthError('所选模型不支持此分辨率，请重新选择', 400);
  const models = channels.shared.provider === 'seedream'
    ? [channels.shared.default_model, ...IMAGE_STUDIO_MODELS.filter(isGeminiImageModel)]
    : Array.from(new Set([...IMAGE_STUDIO_MODELS, channels.shared.default_model]));
  const maximumCount = provider === 'seedream' ? 1 : providerSettings.max_outputs_per_request;
  const quoteModel = (model: string) => {
    const api = selectImageGenerationSettings(channels, model);
    const providerReady = isImageGenerationApiReady(api);
    const modelMaximumCount = api.provider === 'seedream' ? 1 : api.max_outputs_per_request;
    const studioModel = IMAGE_STUDIO_MODELS.includes(model as ImageStudioModel);
    const allowedModel = api.provider === 'seedream' ? model === channels.shared.default_model : studioModel;
    const price = api.provider !== 'seedream' && studioModel ? studio.prices[model as ImageStudioModel] : null;
    const estimated = typeof price === 'number' ? price * input.count : null;
    const reason = !allowedModel ? 'model_unavailable'
      : !providerReady ? 'provider_unavailable'
        : input.count > modelMaximumCount ? 'count_exceeds_limit'
          : typeof price !== 'number' || !Number.isSafeInteger(price) || price < 0
            || estimated === null || !Number.isSafeInteger(estimated) ? 'price_unconfigured' : null;
    return {
      model,
      label: studioModel ? IMAGE_STUDIO_MODEL_LABELS[model as ImageStudioModel] : (api.provider === 'seedream' ? 'Seedream 5.0 Pro' : model),
      status: reason ? 'unavailable' as const : 'estimate' as const,
      reason,
      unitCredits: reason ? null : price,
      estimatedCredits: reason ? null : estimated,
      count: input.count,
      chargeEnabled: false as const,
    };
  };
  const now = Date.now();
  return {
    ...quoteModel(input.model),
    kind: 'image' as const,
    scope: 'ordinary_image' as const,
    projectId: input.project_id,
    provider,
    maximumCount,
    revision: studio.revision,
    pricingBasis: 'global_model_per_image' as const,
    accountScope: 'none' as const,
    confirmationPending: true,
    specifications: { resolution: input.resolution || null, ratio: input.ratio || null, size: input.size || null, quality: input.quality || null },
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    modelOptions: models.map(quoteModel),
  };
}
