import { assertInternalOnly } from '@/lib/access/feature-guard';
import { AuthError, type SessionUser } from '@/lib/auth/session';
import { assertCanGenerateInProject } from '@/lib/projects/permissions';
import { getImageStudioSettings } from '@/lib/image-studio/settings';
import { IMAGE_STUDIO_MODELS, IMAGE_STUDIO_MODEL_LABELS, type ImageStudioModel } from '@/lib/image-studio/model-catalog';
import { getImageGenerationChannels, captureImageGenerationChannel, resolveImageGenerationChannelSnapshot } from '@/lib/integrations/image-generation';
import { resolveImageGenerationRequestChannel } from '@/lib/integrations/image-generation-defaults';
import { captureImageGenerationRequestChannel } from '@/lib/integrations/image-generation';
import { getPricingImageChannelOptions, pricingImageIdentity, readPricingImageScopes, resolvePricingImageCandidate, withImagePricing } from '@/lib/pricing/image';
import { assertPricingImageAvailability } from '@/lib/pricing/image-availability';
import { isPricingItemUnavailable, PricingItemUnavailableError } from '@/lib/pricing/item-unavailable';
import { imagePricingSpecificationsRequired, type CanvasImageModelOption } from '@/lib/pricing/image-option-contract';
import { normalizePricingImageSpecifications } from '@/lib/pricing/pricing-authoring-contract';
import { creditCents, sumCredits } from '@/lib/credits/precision';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

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
  if (!IMAGE_STUDIO_MODELS.includes(input.model as ImageStudioModel)) throw new AuthError('所选图片型号不在允许列表中', 400);
  return prisma.$transaction(tx => buildCanvasImageQuote(input, tx), { maxWait: 10000, timeout: 30000 });
}

// One transaction pins every candidate to the same settings and pricing view.
async function buildCanvasImageQuote(input: CanvasQuoteInput, tx: Prisma.TransactionClient) {
  const specifications = normalizePricingImageSpecifications(input);
  const channels = await getImageGenerationChannels(tx, true);
  const effectiveChannelId = await resolveImageGenerationRequestChannel(input.model, input.channelId, tx, input.quality) || 'original';
  const imageChannel = effectiveChannelId !== 'original' ? await captureImageGenerationRequestChannel(input.model, input.quality, input.channelId, tx) : undefined;
  const studio = await getImageStudioSettings(tx);
  const selected = await resolvePricingImageCandidate(channels, input.model as ImageStudioModel, input.channelId, tx, specifications);
  if (selected.unavailable) throw selected.unavailable;
  // The selected model alone retains its bound snapshot. Other options never capture or borrow it.
  const selectedSettings = imageChannel ? await resolveImageGenerationChannelSnapshot(imageChannel, tx, true, input.model) : selected.settings!;
  const provider = selectedSettings.provider;
  const scopes = await readPricingImageScopes(tx);
  let menu: ReturnType<typeof getPricingImageChannelOptions> | undefined;
  const quoteModel = async (model: ImageStudioModel, selectedModel = false): Promise<CanvasImageModelOption> => {
    const candidate = selectedModel ? { settings: selectedSettings, identity: await pricingImageIdentity(selectedSettings, model, tx, specifications), unavailable: null }
      : await resolvePricingImageCandidate(channels, model, input.channelId, tx, specifications);
    const actual = candidate.identity.billingMode === 'actual';
    const base: CanvasImageModelOption = { model, label: IMAGE_STUDIO_MODEL_LABELS[model], status: 'estimate', reason: null, reasonText: null,
      unitCredits: null, estimatedCredits: null, count: input.count, chargeEnabled: false, billingMode: actual ? 'actual' : 'fixed',
      actualQuoteRequired: actual, estimateSource: candidate.settings?.channelId === 'original' ? 'legacy_fixed' : 'channel_contract',
      creditPrecision: 0.01, pricingQuoteRequired: false };
    try {
      if (candidate.unavailable) throw candidate.unavailable;
      if (imagePricingSpecificationsRequired(candidate.identity, scopes)) {
        const options = await (menu ||= getPricingImageChannelOptions(tx));
        const capability = options.items.find(channel => channel.id === candidate.identity.channelId)?.models[model];
        if (!capability?.ready) throw new PricingItemUnavailableError(candidate.identity, 'price_unconfigured',
          capability?.disabledReason || '该型号尚无可用的规格价格');
        return { ...base, pricingBySpecification: true, pricingQuoteRequired: true };
      }
      const priced = await withImagePricing(candidate.settings!, model, tx, undefined, specifications);
      const api = priced.settings;
      const capability = assertPricingImageAvailability(api, candidate.identity, specifications);
      // Full-quote submissions enqueue independent single-image tasks, not one upstream POST with n=count.
      const modelMaximumCount = priced.quote || actual || api.channelId !== 'original' ? 8 : api.provider === 'seedream' ? 1 : api.max_outputs_per_request;
      if (input.count > modelMaximumCount) throw new PricingItemUnavailableError(candidate.identity, 'count_exceeds_limit', '该型号不支持当前生成张数，当前选择未被替换');
      const price = priced.quote ? priced.quote.credits : api.channelId !== 'original' ? capability.fixedPoints : studio.prices[model];
      const estimated = typeof price === 'number' ? sumCredits(Array.from({ length: input.count }, () => price)) : null;
      if (!actual && (typeof price !== 'number' || !Number.isFinite(price) || price < 0 || estimated === null || !Number.isSafeInteger(creditCents(estimated)))) {
        throw new PricingItemUnavailableError(candidate.identity, 'price_unconfigured', '该型号的固定点数尚未确认');
      }
      return { ...base, unitCredits: actual ? null : price, estimatedCredits: actual ? null : estimated,
        creditPrecision: priced.quote && !['legacy_fixed', 'legacy_actual'].includes(priced.quote.charge.mode) ? 0.1 : 0.01,
        pricingRevision: priced.quote?.charge.revision, pricingQuoteRequired: Boolean(priced.quote) };
    } catch (error) {
      if (selectedModel || !isPricingItemUnavailable(error, candidate.identity)) throw error;
      return { ...base, status: 'unavailable', reason: error.reason, reasonText: error.message };
    }
  };
  const selectedQuote = await quoteModel(input.model as ImageStudioModel, true);
  const maximumCount = imageChannel || selectedQuote.pricingQuoteRequired || selectedQuote.actualQuoteRequired ? 8
    : provider === 'seedream' ? 1 : selectedSettings.max_outputs_per_request;
  const now = Date.now();
  return {
    ...selectedQuote,
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
    specifications: { resolution: specifications.resolution || null, ratio: specifications.ratio || null,
      size: input.size || null, quality: specifications.quality || null },
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    modelOptions: await Promise.all(IMAGE_STUDIO_MODELS.map(model => model === input.model ? selectedQuote : quoteModel(model))),
  };
}
