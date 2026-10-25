import type { Prisma } from '@prisma/client';
import { prisma, retrySqliteBusy } from '@/lib/prisma';
import type { ImageGenerationResolvedSettings } from '@/lib/integrations/image-generation';
import { getImageGenerationChannelOptions, getImageGenerationChannels, selectPricingImageGenerationSettings,
  readPricingImageActualReadiness, type ImageGenerationChannels } from '@/lib/integrations/image-generation';
import { resolveImageGenerationRequestChannel, getImageGenerationDefaultRoutes, ImageGenerationDefaultRoutesError } from '@/lib/integrations/image-generation-defaults';
import { IMAGE_25_QUALITY_MODEL, isImage25Quality } from '@/lib/image-studio/quality-routing';
import type { ImageStudioModel } from '@/lib/image-studio/model-catalog';
import type { ImageBillingContract } from '@/lib/image-studio/billing-contract';
import { quotePricingCharge, type FrozenPricingCharge } from './charge';
import { assertPricingImageConsumerReady } from './runtime';
import type { PricingAdminIdentity } from './admin-contract';
import { isPricingItemUnavailable, PricingItemUnavailableError } from './item-unavailable';
import { assertPricingImageAvailability } from './image-availability';
import { normalizePricingImageSpecifications, type PricingImageSpecifications } from './pricing-authoring-contract';
import { PRICING_POLICY_KEY } from './admin-contract';
import { PricingAdminServiceError } from './policy';
import type { PricingImageChannelOptions } from './image-option-contract';
import { pricingCanonical } from './catalog';

type Client = Prisma.TransactionClient | typeof prisma;

/** A refreshed quote may change its issue time, never its accepted pricing inputs. */
export function samePricingImageCharge(left: FrozenPricingCharge | undefined, right: FrozenPricingCharge | undefined) {
  return left && right ? pricingCanonical({ ...left, issuedAt: null }) === pricingCanonical({ ...right, issuedAt: null }) : left === right;
}

export async function pricingImageIdentity(settings: ImageGenerationResolvedSettings, model: string, client: Client = prisma,
  specifications: PricingImageSpecifications = {}): Promise<PricingAdminIdentity> {
  const capability = settings.modelCapabilities[model as ImageStudioModel];
  const channelId = settings.channelId === 'original' ? model.startsWith('gemini-') ? 'banana' : 'shared' : settings.channelId;
  const actual = capability?.billingMode === 'actual' || settings.channelId === 'original'
    && settings.provider === 'musk' && Boolean(settings.api_key && settings.base_url)
    && await readPricingImageActualReadiness(settings, model, client);
  return { kind: 'image', channelId, modelId: model, billingMode: actual ? 'actual' : 'fixed', unit: 'image', specifications: normalizePricingImageSpecifications(specifications) };
}

/** Overlay only the charge fields. Transport, enablement and explicit capability limits stay authoritative. */
export async function withImagePricing(settings: ImageGenerationResolvedSettings, model: string,
  client: Client = prisma, accepted?: ImageBillingContract, specifications: PricingImageSpecifications = {}) {
  const capability = settings.modelCapabilities[model as ImageStudioModel];
  const channelId = settings.channelId === 'original' ? model.startsWith('gemini-') ? 'banana' : 'shared' : settings.channelId;
  let quote: Awaited<ReturnType<typeof quotePricingCharge>> = null;
  if (!accepted) {
    const identity = await pricingImageIdentity(settings, model, client, specifications);
    try { quote = await quotePricingCharge(identity, '1', client); }
    catch (error) {
      if (error instanceof PricingAdminServiceError && error.code === 'pricing_scope_unmatched') {
        throw new PricingItemUnavailableError(identity, 'price_unconfigured', '当前图片规格尚未设置价格，请调整规格或联系管理员；未使用其他规格的价格');
      }
      throw error;
    }
  }
  const charge = accepted?.pricing || quote?.charge;
  if (!charge) return { settings, quote };
  if (charge.identity.channelId !== channelId || charge.identity.modelId !== model) throw new Error('Frozen image pricing identity mismatch');
  if (accepted) await assertPricingImageConsumerReady(client);
  return { quote, settings: { ...settings, modelCapabilities: { ...settings.modelCapabilities,
    ...(capability ? { [model]: { ...capability, billingMode: charge.identity.billingMode,
      fixedPoints: charge.identity.billingMode === 'fixed' ? accepted?.authorizedCredits ?? quote!.credits : null } } : {}) } } };
}

export async function resolvePricingImageCandidate(channels: ImageGenerationChannels, model: ImageStudioModel,
  requestedChannelId: string | undefined, client: Client = prisma, specifications: PricingImageSpecifications = {}) {
  let channelId: string;
  try { channelId = await resolveImageGenerationRequestChannel(model, requestedChannelId, client, specifications.quality) || 'original'; }
  catch (error) {
    if (model !== IMAGE_25_QUALITY_MODEL || !(error instanceof ImageGenerationDefaultRoutesError)) throw error;
    const routes = await getImageGenerationDefaultRoutes(client);
    const id = isImage25Quality(specifications.quality) ? routes.qualityRoutes?.[IMAGE_25_QUALITY_MODEL]?.[specifications.quality] : undefined;
    const identity: PricingAdminIdentity = { kind: 'image', channelId: id || routes.models[IMAGE_25_QUALITY_MODEL] || 'shared',
      modelId: model, billingMode: 'fixed', unit: 'image', specifications: normalizePricingImageSpecifications(specifications) };
    return { identity, settings: null, unavailable: new PricingItemUnavailableError(identity, 'specification_unsupported', error.message) };
  }
  if (!['original', 'shared', 'banana', 'fluxport'].includes(channelId)
    && !/^image-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(channelId)) throw new Error('图片通道身份无效');
  if (channelId.startsWith('image-') && !channels.managed.some(item => item.channelId === channelId && !item.deleted)) {
    const identity: PricingAdminIdentity = { kind: 'image', channelId, modelId: model, billingMode: 'fixed', unit: 'image', specifications: normalizePricingImageSpecifications(specifications) };
    return { identity, settings: null, unavailable: new PricingItemUnavailableError(identity, 'configuration_missing', '该型号的供应商已归档或不存在，未切换供应商') };
  }
  const settings = await selectPricingImageGenerationSettings(channels, model, channelId, client);
  return { settings, identity: await pricingImageIdentity(settings, model, client, specifications), unavailable: null };
}

export async function readPricingImageScopes(client: Client = prisma): Promise<PricingAdminIdentity[]> {
  const policyRecord = await client.platformSetting.findUnique({ where: { key: PRICING_POLICY_KEY } });
  if (!policyRecord) return [];
  const policy = JSON.parse(policyRecord.value_json) as { rules: Array<{ identity: PricingAdminIdentity }> };
  return policy.rules.filter(rule => rule.identity.kind === 'image').map(rule => ({ ...rule.identity,
    specifications: normalizePricingImageSpecifications(rule.identity.specifications) }));
}

/** Menu projections consume only typed, identity-matched unavailability, never general failures. */
export async function getPricingImageChannelOptions(client: Client = prisma): Promise<PricingImageChannelOptions> {
  if (client === prisma) return retrySqliteBusy(() => prisma.$transaction(tx => getPricingImageChannelOptions(tx), { maxWait: 10000, timeout: 30000 }));
  const options: PricingImageChannelOptions = await getImageGenerationChannelOptions(client, true);
  const channels = await getImageGenerationChannels(client, true);
  const scopes = await readPricingImageScopes(client);
  for (const item of options.items.filter(channel => channel.id !== 'original')) for (const model of Object.keys(item.models) as ImageStudioModel[]) {
    const original = item.models[model];
    if (!original) continue;
    const candidate = await resolvePricingImageCandidate(channels, model, item.id, client);
    try {
      if (candidate.unavailable) throw candidate.unavailable;
      const modelScopes = scopes.filter(identity => identity.channelId === candidate.identity.channelId && identity.modelId === model
        && identity.billingMode === candidate.identity.billingMode && identity.unit === candidate.identity.unit);
      if (modelScopes.some(identity => Object.keys(identity.specifications).length > 0)) {
        let available = false;
        let unavailable: PricingItemUnavailableError | undefined;
        // Probe real adopted scopes only. No invented default or zero-price capability is used.
        for (const identity of modelScopes) {
          try {
            const priced = await withImagePricing(candidate.settings!, model, client, undefined, identity.specifications);
            assertPricingImageAvailability(priced.settings, identity);
            available = true;
            break;
          } catch (error) {
            if (!isPricingItemUnavailable(error, identity)) throw error;
            unavailable = error;
          }
        }
        if (!available) throw new PricingItemUnavailableError(candidate.identity, unavailable?.reason || 'price_unconfigured',
          unavailable?.message || '该型号尚无可用的规格价格');
        const actual = candidate.identity.billingMode === 'actual';
        item.models[model] = { ...original, billingMode: candidate.identity.billingMode, ready: true,
          fixedPoints: null, disabledReason: null, actualQuoteRequired: actual, pricingBySpecification: true };
        continue;
      }
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
      item.models[model] = { ...original, ready: false, fixedPoints: null, actualQuoteRequired: false,
        pricingBySpecification: false, disabledReason: error.message };
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
