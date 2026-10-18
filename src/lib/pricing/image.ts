import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { ImageGenerationResolvedSettings } from '@/lib/integrations/image-generation';
import { getImageGenerationChannelOptions, getImageGenerationChannels, selectImageGenerationSettings,
  validateImageGenerationChannel } from '@/lib/integrations/image-generation';
import { imageBillingReady } from '@/lib/image-studio/billing-readiness';
import { imageBillingScope } from '@/lib/image-studio/billing-scope';
import type { ImageStudioModel } from '@/lib/image-studio/model-catalog';
import type { ImageBillingContract } from '@/lib/image-studio/billing-contract';
import { quotePricingCharge } from './charge';
import { assertPricingImageConsumerReady } from './runtime';

type Client = Prisma.TransactionClient | typeof prisma;

/** Overlay only the charge fields. Transport, enablement and explicit capability limits stay authoritative. */
export async function withImagePricing(settings: ImageGenerationResolvedSettings, model: string,
  client: Client = prisma, accepted?: ImageBillingContract) {
  const capability = settings.modelCapabilities[model as ImageStudioModel];
  const channelId = settings.channelId === 'original' ? model.startsWith('gemini-') ? 'banana' : 'shared' : settings.channelId;
  const actual = capability?.billingMode === 'actual' || settings.channelId === 'original'
    && settings.provider === 'musk' && Boolean(settings.api_key && settings.base_url)
    && (await imageBillingReady(imageBillingScope(settings), model, client)).ready;
  const quote = accepted ? null : await quotePricingCharge({ kind: 'image', channelId, modelId: model,
    billingMode: actual ? 'actual' : 'fixed', unit: 'image', specifications: {} }, '1', client);
  const charge = accepted?.pricing || quote?.charge;
  if (!charge) return { settings, quote };
  if (charge.identity.channelId !== channelId || charge.identity.modelId !== model) throw new Error('Frozen image pricing identity mismatch');
  if (accepted) await assertPricingImageConsumerReady(client);
  return { quote, settings: { ...settings, modelCapabilities: { ...settings.modelCapabilities,
    ...(capability ? { [model]: { ...capability, billingMode: charge.identity.billingMode,
      fixedPoints: charge.identity.billingMode === 'fixed' ? accepted?.authorizedCredits ?? quote!.credits : null } } : {}) } } };
}

/** Public UI projection; the raw catalog/config readers deliberately remain unchanged. */
export async function getPricingImageChannelOptions(client: Client = prisma) {
  const options = await getImageGenerationChannelOptions(client);
  const channels = await getImageGenerationChannels(client);
  for (const item of options.items) for (const model of Object.keys(item.models) as ImageStudioModel[]) {
    const original = item.models[model];
    if (!original) continue;
    try {
      const priced = await withImagePricing(selectImageGenerationSettings(channels, model, item.id), model, client);
      if (!priced.quote) continue;
      const validation = validateImageGenerationChannel(priced.settings, { model });
      item.models[model] = { ...original, billingMode: priced.quote.charge.identity.billingMode,
        fixedPoints: priced.quote.credits, ready: validation.ok,
        disabledReason: validation.ok ? null : validation.error };
    } catch (error) {
      item.models[model] = { ...original, ready: false, disabledReason: error instanceof Error ? error.message : '收费依据暂不可用' };
    }
  }
  return options;
}
