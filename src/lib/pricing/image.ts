import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { ImageGenerationResolvedSettings } from '@/lib/integrations/image-generation';
import { getImageGenerationChannelOptions, getImageGenerationChannels, selectPricingImageGenerationSettings,
  readPricingImageActualReadiness, type ImageGenerationChannels } from '@/lib/integrations/image-generation';
import { resolveImageGenerationRequestChannel } from '@/lib/integrations/image-generation-defaults';
import type { ImageStudioModel } from '@/lib/image-studio/model-catalog';
import type { ImageBillingContract } from '@/lib/image-studio/billing-contract';
import { quotePricingCharge } from './charge';
import { assertPricingImageConsumerReady } from './runtime';
import type { PricingAdminIdentity } from './admin-contract';
import { isPricingItemUnavailable, PricingItemUnavailableError } from './item-unavailable';
import { assertPricingImageAvailability } from './image-availability';

type Client = Prisma.TransactionClient | typeof prisma;

export async function pricingImageIdentity(settings: ImageGenerationResolvedSettings, model: string, client: Client = prisma): Promise<PricingAdminIdentity> {
  const capability = settings.modelCapabilities[model as ImageStudioModel];
  const channelId = settings.channelId === 'original' ? model.startsWith('gemini-') ? 'banana' : 'shared' : settings.channelId;
  const actual = capability?.billingMode === 'actual' || settings.channelId === 'original'
    && settings.provider === 'musk' && Boolean(settings.api_key && settings.base_url)
    && await readPricingImageActualReadiness(settings, model, client);
  return { kind: 'image', channelId, modelId: model, billingMode: actual ? 'actual' : 'fixed', unit: 'image', specifications: {} };
}

/** Overlay only the charge fields. Transport, enablement and explicit capability limits stay authoritative. */
export async function withImagePricing(settings: ImageGenerationResolvedSettings, model: string,
  client: Client = prisma, accepted?: ImageBillingContract) {
  const capability = settings.modelCapabilities[model as ImageStudioModel];
  const channelId = settings.channelId === 'original' ? model.startsWith('gemini-') ? 'banana' : 'shared' : settings.channelId;
  const quote = accepted ? null : await quotePricingCharge(await pricingImageIdentity(settings, model, client), '1', client);
  const charge = accepted?.pricing || quote?.charge;
  if (!charge) return { settings, quote };
  if (charge.identity.channelId !== channelId || charge.identity.modelId !== model) throw new Error('Frozen image pricing identity mismatch');
  if (accepted) await assertPricingImageConsumerReady(client);
  return { quote, settings: { ...settings, modelCapabilities: { ...settings.modelCapabilities,
    ...(capability ? { [model]: { ...capability, billingMode: charge.identity.billingMode,
      fixedPoints: charge.identity.billingMode === 'fixed' ? accepted?.authorizedCredits ?? quote!.credits : null } } : {}) } } };
}

export async function resolvePricingImageCandidate(channels: ImageGenerationChannels, model: ImageStudioModel,
  requestedChannelId: string | undefined, client: Client = prisma) {
  const channelId = await resolveImageGenerationRequestChannel(model, requestedChannelId, client) || 'original';
  if (!['original', 'shared', 'banana', 'fluxport'].includes(channelId)
    && !/^image-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(channelId)) throw new Error('图片通道身份无效');
  if (channelId.startsWith('image-') && !channels.managed.some(item => item.channelId === channelId && !item.deleted)) {
    const identity: PricingAdminIdentity = { kind: 'image', channelId, modelId: model, billingMode: 'fixed', unit: 'image', specifications: {} };
    return { identity, settings: null, unavailable: new PricingItemUnavailableError(identity, 'configuration_missing', '该型号的供应商已归档或不存在，未切换供应商') };
  }
  const settings = await selectPricingImageGenerationSettings(channels, model, channelId, client);
  return { settings, identity: await pricingImageIdentity(settings, model, client), unavailable: null };
}

/** Menu projections consume only typed, identity-matched unavailability, never general failures. */
export async function getPricingImageChannelOptions(client: Client = prisma) {
  const options = await getImageGenerationChannelOptions(client, true);
  const channels = await getImageGenerationChannels(client, true);
  for (const item of options.items.filter(channel => channel.id !== 'original')) for (const model of Object.keys(item.models) as ImageStudioModel[]) {
    const original = item.models[model];
    if (!original) continue;
    const candidate = await resolvePricingImageCandidate(channels, model, item.id, client);
    try {
      if (candidate.unavailable) throw candidate.unavailable;
      const priced = await withImagePricing(candidate.settings!, model, client);
      const capability = assertPricingImageAvailability(priced.settings, candidate.identity);
      const actual = candidate.identity.billingMode === 'actual';
      const price = priced.quote ? priced.quote.credits : capability.fixedPoints;
      if (!actual && price === null) throw new PricingItemUnavailableError(candidate.identity, 'price_unconfigured', '该型号尚未填写固定点数');
      item.models[model] = { ...original, billingMode: candidate.identity.billingMode,
        fixedPoints: actual ? null : price, ready: true, disabledReason: null,
        actualQuoteRequired: actual };
    } catch (error) {
      if (!isPricingItemUnavailable(error, candidate.identity)) throw error;
      item.models[model] = { ...original, ready: false, fixedPoints: null, actualQuoteRequired: false, disabledReason: error.message };
    }
  }
  const original = options.items.find(item => item.id === 'original')!;
  for (const model of Object.keys(original.models) as ImageStudioModel[]) {
    const route = await resolveImageGenerationRequestChannel(model, 'original', client);
    const channelId = route || (model.startsWith('gemini-') ? 'banana' : 'shared');
    const projected = options.items.find(item => item.id === channelId)?.models[model];
    original.models[model] = projected ? { ...projected } : { ...original.models[model]!, ready: false,
      fixedPoints: null, actualQuoteRequired: false, disabledReason: '该型号的默认供应商已归档或不存在，未切换供应商' };
  }
  for (const item of options.items) {
    item.ready = Object.values(item.models).some(model => model?.ready === true);
    item.disabledReason = item.ready ? null : '暂无可用且计价就绪的型号';
  }
  return options;
}
