import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { calculateEstimatedCost, calculateEnhanceVideoEstimatedCost } from '@/lib/pricing';
import { getProviderConfig, isApiKeyConfigured } from '@/lib/provider/jimeng';
import { SEEDANCE_VIDEO_MODEL_OPTIONS } from '@/lib/provider/seedance-models';
import { VOLCENGINE_IP_MODEL_OPTIONS } from '@/lib/integrations/volcengine-ip-models';
import { getVolcengineIpApiSettings, isVolcengineIpApiReady, VOLCENGINE_IP_API_SETTING_KEY } from '@/lib/integrations/volcengine-ip';
import { getAiMediaKitApiSettings, isAiMediaKitApiReady, AIMEDIAKIT_API_SETTING_KEY } from '@/lib/integrations/aimediakit';
import { getH3ApiSettings, H3_API_SETTING_KEY, H3_PRESET_OPTIONS, isH3Operational } from '@/lib/integrations/h3';
import { IMAGE_STUDIO_MODELS, IMAGE_STUDIO_MODEL_LABELS } from '@/lib/image-studio/model-catalog';
import { IMAGE_STUDIO_SETTING_KEY, getImageStudioSettings } from '@/lib/image-studio/settings';
import { imageBillingScope } from '@/lib/image-studio/billing-scope';
import { imageBillingIntent } from '@/lib/image-studio/billing-readiness';
import { getImageGenerationChannels, getImageGenerationChannelOptions, selectImageGenerationSettings,
  resolveImageGenerationModelSettings, selectPricingImageGenerationSettings, validateImageGenerationChannel, IMAGE_GENERATION_API_SETTING_KEY, BANANA_IMAGE_API_SETTING_KEY,
  IMAGE_GENERATION_CHANNEL_REGISTRY_SETTING_KEY, IMAGE_GENERATION_LEGACY_MODEL_API_SETTING_PREFIX } from '@/lib/integrations/image-generation';
import type { PricingAdminIdentity, PricingAdminRow } from './admin-contract';
import { PricingItemUnavailableError } from './item-unavailable';
import { assertPricingImageAvailability } from './image-availability';

export type PricingClient = Prisma.TransactionClient | typeof prisma;
export type PricingCatalogBinding = {
  configRevision: string;
  billingPrincipalId: string;
  credentialVersion: string;
  configFingerprint: string;
};
export type PricingCatalog = { rows: PricingAdminRow[]; bindings: Record<string, PricingCatalogBinding>; fingerprint: string };

export function pricingCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(pricingCanonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${pricingCanonical(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export function pricingFingerprint(value: unknown) { return createHash('sha256').update(pricingCanonical(value)).digest('hex'); }
export function pricingCatalogRowId(identity: PricingAdminIdentity) { return `rate-${pricingFingerprint(identity).slice(0, 32)}`; }

export async function assertPricingCatalogIdentity(identity: PricingAdminIdentity, client: PricingClient = prisma, fixedPriceConfirmed = false) {
  const reject = (): never => { throw new Error('收费作用域或规格不在当前合法能力范围，未回退旧价'); };
  if (!identity || !plain(identity.specifications) || Object.values(identity.specifications).some(value => typeof value !== 'string')) reject();
  const specifications = identity.specifications;
  if (identity.kind === 'image') {
    if (identity.unit !== 'image' || !IMAGE_STUDIO_MODELS.includes(identity.modelId as typeof IMAGE_STUDIO_MODELS[number])
      || Object.keys(specifications).some(key => !['quality', 'resolution', 'ratio'].includes(key))) reject();
    await validateSources(client, 'image');
    const channels = await getImageGenerationChannels(client, true);
    const options = await getImageGenerationChannelOptions(client, true);
    const channel = options.items.find(item => item.id === identity.channelId);
    if (!channel) {
      if (!/^image-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(identity.channelId)) reject();
      throw new PricingItemUnavailableError(identity, 'configuration_missing', '该型号的供应商已归档或不存在，未切换供应商');
    }
    const settings = await selectPricingImageGenerationSettings(channels, identity.modelId, identity.channelId, client);
    const capability = channel.models[identity.modelId as typeof IMAGE_STUDIO_MODELS[number]];
    const adoptingFixed = fixedPriceConfirmed && identity.billingMode === 'fixed' && settings.modelCapabilities[identity.modelId as typeof IMAGE_STUDIO_MODELS[number]]?.billingMode === 'fixed';
    const validationSettings = adoptingFixed ? { ...settings, modelCapabilities: { ...settings.modelCapabilities,
      [identity.modelId]: { ...settings.modelCapabilities[identity.modelId as typeof IMAGE_STUDIO_MODELS[number]]!, fixedPoints: 0 } } } : settings;
    assertPricingImageAvailability(validationSettings, identity, specifications);
    if (!capability || capability.billingMode !== identity.billingMode) return reject();
    if (!capability.ready && !adoptingFixed) {
      throw new PricingItemUnavailableError(identity, 'evidence_unconfirmed', capability.disabledReason || '该型号的计价依据尚未就绪');
    }
    return;
  }
  if (identity.unit !== 'second' || identity.billingMode !== 'fixed') reject();
  if (identity.kind === 'video') {
    if (Object.keys(specifications).some(key => !['resolution', 'referenceVideo', 'pricingPurpose'].includes(key))
      || specifications.resolution && !['480p', '720p', '1080p'].includes(specifications.resolution)
      || specifications.referenceVideo && !['none', 'present', 'unknown'].includes(specifications.referenceVideo)
      || specifications.pricingPurpose && !['standard', 'draft', 'draft_upgrade', 'unknown'].includes(specifications.pricingPurpose)) reject();
    if (identity.channelId === 'seedance') {
      if (!SEEDANCE_VIDEO_MODEL_OPTIONS.some(model => model.id === identity.modelId) || !isApiKeyConfigured()) reject();
      return;
    }
    if (identity.channelId === 'volcengine_ark') {
      await validateSources(client, 'ip');
      const settings = await getVolcengineIpApiSettings(client);
      if (!isVolcengineIpApiReady(settings) || !VOLCENGINE_IP_MODEL_OPTIONS.some(model => model.id === identity.modelId) && settings.default_model !== identity.modelId) reject();
      return;
    }
    reject();
  }
  if (identity.kind === 'enhance') {
    await validateSources(client, 'enhance');
    if (identity.channelId !== 'volcengine_mediakit' || identity.modelId !== 'enhance-video'
      || Object.keys(specifications).some(key => !['resolution', 'toolVersion', 'fpsTier'].includes(key))
      || !['480p', '720p', '1080p', '2k', '4k'].includes(specifications.resolution)
      || !['standard', 'professional'].includes(specifications.toolVersion) || !['lte30', 'gt30'].includes(specifications.fpsTier)
      || !isAiMediaKitApiReady(await getAiMediaKitApiSettings(client))) reject();
    return;
  }
  if (identity.kind === 'h3') {
    await validateSources(client, 'h3');
    if (identity.channelId === 'h3' && H3_PRESET_OPTIONS.some(preset => preset.id === identity.modelId)
      && !Object.keys(specifications).length && isH3Operational(await getH3ApiSettings(client))) return;
  }
  reject();
}

function plain(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }

// Several legacy readers intentionally fall back. Pricing must reject present but corrupt sources first.
async function validateSources(client: PricingClient, area?: 'image' | 'ip' | 'enhance' | 'h3') {
  const imageKeys = [IMAGE_GENERATION_API_SETTING_KEY, BANANA_IMAGE_API_SETTING_KEY, IMAGE_GENERATION_CHANNEL_REGISTRY_SETTING_KEY,
    `${IMAGE_GENERATION_LEGACY_MODEL_API_SETTING_PREFIX}shared`, `${IMAGE_GENERATION_LEGACY_MODEL_API_SETTING_PREFIX}banana`,
    IMAGE_STUDIO_SETTING_KEY, 'image_actual_billing_intent_v1'];
  const keys = !area ? [...imageKeys, VOLCENGINE_IP_API_SETTING_KEY, AIMEDIAKIT_API_SETTING_KEY, H3_API_SETTING_KEY]
    : area === 'image' ? imageKeys : [area === 'ip' ? VOLCENGINE_IP_API_SETTING_KEY : area === 'enhance' ? AIMEDIAKIT_API_SETTING_KEY : H3_API_SETTING_KEY];
  const records = await client.platformSetting.findMany({ where: { key: { in: keys } } });
  for (const record of records) {
    let value: unknown;
    try { value = JSON.parse(record.value_json); } catch { throw new Error('现有收费来源配置损坏，未按空配置处理'); }
    if (!plain(value)) throw new Error('现有收费来源格式损坏，未使用默认价');
    if ('enabled' in value && typeof value.enabled !== 'boolean') throw new Error('现有通道启用状态损坏');
    for (const field of ['base_url', 'api_key', 'api_token']) {
      if (value[field] !== undefined && value[field] !== null && typeof value[field] !== 'string') throw new Error('现有通道配置字段损坏');
    }
    for (const field of ['default_model', 'default_preset_id', 'default_lora_id']) {
      if (value[field] !== undefined && typeof value[field] !== 'string') throw new Error('现有通道型号配置损坏');
    }
    for (const field of ['supports_text_to_image', 'supports_image_to_image', 'supports_async_task', 'watermark']) {
      if (value[field] !== undefined && typeof value[field] !== 'boolean') throw new Error('现有通道能力配置损坏');
    }
    for (const field of ['timeout_ms', 'max_outputs_per_request']) {
      if (value[field] !== undefined && (typeof value[field] !== 'number' || !Number.isSafeInteger(value[field]) || Number(value[field]) <= 0)) throw new Error('现有通道数值配置损坏');
    }
    if (record.key === IMAGE_STUDIO_SETTING_KEY) {
      if (!plain(value.prices)) throw new Error('现有图片价格配置损坏');
      for (const price of Object.values(value.prices)) {
        if (price !== null && (typeof price !== 'number' || !Number.isFinite(price) || price < 0 || price > 100000)) throw new Error('现有图片价格无效');
      }
    }
  }
  if (!area || area === 'image') { await getImageStudioSettings(client); await imageBillingIntent(client); }
  return new Map(records.map(record => [record.key, pricingFingerprint(JSON.parse(record.value_json))]));
}

function binding(channel: string, configuration: unknown, credential: string | null | undefined,
  revision: string, scope?: string): PricingCatalogBinding {
  const credentialVersion = pricingFingerprint({ credential: credential || null });
  return { configRevision: revision, credentialVersion,
    // No independently verified account-rotation chain exists in the legacy config. Never claim one.
    billingPrincipalId: scope ? `scope:${scope}` : `unverified:${channel}:${credentialVersion}`,
    configFingerprint: pricingFingerprint(configuration) };
}

function row(identity: PricingAdminIdentity, label: string, providerLabel: string, enabled: boolean,
  ready: boolean, price: number | null, reason: string | null, appliesTo: string[], isDefault = false): PricingAdminRow {
  const actual = identity.billingMode === 'actual';
  return { id: pricingCatalogRowId(identity), identity, label, providerLabel, enabled, isDefault, appliesTo,
    availability: !enabled ? 'disabled' : ready ? 'ready' : 'unconfigured', unavailableReason: ready ? null : reason,
    basisKind: actual ? 'supplier_cost_cny' : 'site_base_cny',
    mode: actual ? 'legacy_actual' : price === null ? 'unset' : price === 0 ? 'free' : 'legacy_fixed',
    baseCny: null, source: null, exchangeRate: null, currentPointsPerCny: null,
    currentUnitCredits: actual || price === null ? null : String(price),
    legacyRounding: actual ? 'half_up_cent' : identity.kind === 'image' ? 'fixed_unit' : 'ceil_task',
    legacyPointsPerUsd: actual ? '35' : null, relativeMultiplier: null, differencePercent: null,
    hasDifference: false, confirmation: price === 0 ? 'not_applicable' : 'unconfirmed', canAdopt: false,
    adoptionReason: actual ? '请确认汇率与费率；实际账单仍须沿原精确匹配及授权上限' : '请先补充独立人民币基价', updatedAt: null };
}

export async function getPricingCatalog(client: PricingClient = prisma): Promise<PricingCatalog> {
  const sources = await validateSources(client);
  const rows: PricingAdminRow[] = [], bindings: PricingCatalog['bindings'] = {};
  const add = (value: PricingAdminRow, source: PricingCatalogBinding) => { rows.push(value); bindings[value.id] = source; };
  const seedance = getProviderConfig();
  const seedanceBinding = binding('seedance', { base: seedance.baseUrl,
    credential: pricingFingerprint(process.env.SEEDANCE_API_KEY || ''), models: seedance.model_options },
  process.env.SEEDANCE_API_KEY, 'environment');
  for (const model of SEEDANCE_VIDEO_MODEL_OPTIONS) {
    const price = calculateEstimatedCost('1080p', 1, model.id).finalCostPerSecond;
    add(row({ kind: 'video', channelId: 'seedance', modelId: model.id, billingMode: 'fixed', unit: 'second', specifications: {} },
      model.label, '视频接口', true, isApiKeyConfigured(), price, '尚未配置视频接口', ['普通视频', 'Draft 升级', '全部合法分辨率'], model.id === seedance.model), seedanceBinding);
    for (const resolution of ['480p', '720p', '1080p']) add(row({ kind: 'video', channelId: 'seedance', modelId: model.id,
      billingMode: 'fixed', unit: 'second', specifications: { resolution, referenceVideo: 'none', pricingPurpose: 'standard' } },
    `${model.label} ${resolution}`, '视频接口', true, isApiKeyConfigured(), price, '尚未配置视频接口', ['普通生成', '无参考视频', resolution], model.id === seedance.model), seedanceBinding);
  }
  const ip = await getVolcengineIpApiSettings(client);
  const ipModels = [...VOLCENGINE_IP_MODEL_OPTIONS];
  if (ip.default_model && !ipModels.some(model => model.id === ip.default_model)) ipModels.push({ id: ip.default_model, label: ip.default_model, detail: '当前配置型号' });
  const ipBinding = binding('volcengine_ark', ip, ip.api_key, sources.get(VOLCENGINE_IP_API_SETTING_KEY) || 'legacy-default');
  for (const model of ipModels) add(row({ kind: 'video', channelId: 'volcengine_ark', modelId: model.id,
    billingMode: 'fixed', unit: 'second', specifications: {} }, model.label, '火山 IP 视频', ip.enabled,
  isVolcengineIpApiReady(ip), calculateEstimatedCost('1080p', 1, model.id).finalCostPerSecond,
  'IP 视频接口未就绪', [model.detail, 'IP 视频'], model.id === ip.default_model), ipBinding);
  const enhance = await getAiMediaKitApiSettings(client);
  const enhanceBinding = binding('volcengine_mediakit', enhance, enhance.api_key, sources.get(AIMEDIAKIT_API_SETTING_KEY) || 'legacy-default');
  for (const resolution of ['480p', '720p', '1080p', '2k', '4k']) for (const toolVersion of ['standard', 'professional']) for (const fpsTier of ['lte30', 'gt30']) {
    const price = calculateEnhanceVideoEstimatedCost({ duration: 1, resolution, toolVersion, fps: fpsTier === 'gt30' ? 60 : 30 }).finalCostPerSecond;
    add(row({ kind: 'enhance', channelId: 'volcengine_mediakit', modelId: 'enhance-video', billingMode: 'fixed', unit: 'second',
      specifications: { resolution, toolVersion, fpsTier } }, `视频增强 ${resolution} · ${toolVersion === 'professional' ? '专业' : '普通'} · ${fpsTier === 'gt30' ? '>30fps' : '≤30fps'}`,
    'AI MediaKit', enhance.enabled, isAiMediaKitApiReady(enhance), price, '增强视频接口未就绪', ['时长向上取整秒',
      ...(resolution === '480p' ? ['含原 240p / 360p / 540p 同价档，不改变请求输出尺寸'] : [])], true), enhanceBinding);
  }
  const h3 = await getH3ApiSettings(client);
  const h3Binding = binding('h3', { enabled: h3.enabled, base: h3.base_url }, h3.api_token, sources.get(H3_API_SETTING_KEY) || 'legacy-default');
  for (const preset of H3_PRESET_OPTIONS) add(row({ kind: 'h3', channelId: 'h3', modelId: preset.id,
    billingMode: 'fixed', unit: 'second', specifications: {} }, preset.label, 'H3 本地工作站', h3.enabled, isH3Operational(h3), 0,
  'H3 服务未就绪', ['沿原本地免费合同'], preset.id === h3.default_preset_id), h3Binding);
  const channels = await getImageGenerationChannels(client, true);
  const options = await getImageGenerationChannelOptions(client, true);
  for (const channel of options.items) {
    if (channel.id === 'original') continue;
    for (const model of IMAGE_STUDIO_MODELS) {
      const capability = channel.models[model];
      if (!capability) continue;
      const settings = resolveImageGenerationModelSettings(selectImageGenerationSettings(channels, model, channel.id), model);
      const actual = capability.billingMode === 'actual';
      const address = new URL(settings.base_url);
      const scope = settings.api_key && address.protocol === 'https:' && !address.username && !address.password ? imageBillingScope(settings) : undefined;
      const source = binding(channel.id, { provider: settings.provider, baseUrl: settings.base_url,
        upstreamModel: settings.modelCapabilities[model]?.upstreamModel || model, protocol: capability,
        credentials: pricingFingerprint(settings.api_key), billingIntent: actual ? await imageBillingIntent(client) : null },
      settings.api_key, settings.configRevision, scope);
      const actualReady = capability.actualQuoteRequired && capability.ready;
      const rawCapability = settings.modelCapabilities[model];
      const transport = rawCapability ? validateImageGenerationChannel({ ...settings, modelCapabilities: { ...settings.modelCapabilities,
        [model]: { ...rawCapability, billingMode: 'fixed', fixedPoints: 0 } } }, { model }) : null;
      const value = row({ kind: 'image', channelId: channel.id, modelId: model, billingMode: actual ? 'actual' : 'fixed', unit: 'image', specifications: {} },
        IMAGE_STUDIO_MODEL_LABELS[model], channel.supplierName || channel.label, channel.enabled,
        actual ? actualReady : Boolean(transport?.ok), actual ? null : capability.fixedPoints,
        capability.disabledReason || channel.disabledReason, [
          `质量：${capability.qualities?.join(' / ') || '未知'}`, `分辨率：${capability.resolutions?.join(' / ') || '未知'}`,
          `比例：${capability.ratios?.join(' / ') || '沿原比例合同'}`,
        ], (options.defaultRoutes?.models[model] || (model.startsWith('gemini-') ? 'banana' : 'shared')) === channel.id);
      value.enabled = channel.enabled && settings.modelCapabilities[model]?.enabled === true;
      if (!value.enabled) value.availability = 'disabled';
      add(value, source);
    }
  }
  rows.sort((a, b) => a.identity.kind.localeCompare(b.identity.kind) || a.identity.channelId.localeCompare(b.identity.channelId) || a.id.localeCompare(b.id));
  if (new Set(rows.map(value => value.id)).size !== rows.length) throw new Error('收费目录存在重复作用域，已停止使用');
  return { rows, bindings, fingerprint: pricingFingerprint({ rows, bindings, sources: Array.from(sources.entries()).sort() }) };
}

export async function appendPricingCatalogScopes(catalog: PricingCatalog, identities: PricingAdminIdentity[], client: PricingClient, validate = true) {
  for (const identity of identities) {
    const id = pricingCatalogRowId(identity);
    if (catalog.rows.some(row => row.id === id)) continue;
    const original = catalog.rows.find(row => row.identity.kind === identity.kind && row.identity.channelId === identity.channelId
      && row.identity.modelId === identity.modelId && row.identity.billingMode === identity.billingMode
      && row.identity.unit === identity.unit && !Object.keys(row.identity.specifications).length);
    if (!original) throw new Error('精确收费项缺少真实供应商范围');
    if (validate) await assertPricingCatalogIdentity(identity, client, true);
    catalog.rows.push({ ...original, id, identity, appliesTo: Object.entries(identity.specifications).map(([key, value]) => `${key}: ${value}`) });
    catalog.bindings[id] = catalog.bindings[original.id];
  }
}
