import { createHash, randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { PRICING_ADMIN_WRITES_ENABLED } from '@/lib/pricing/build-mode';
import { assertPricingImageConsumerReady } from '@/lib/pricing/runtime';
import { getAdminPricingSnapshot, previewAdminPricing, saveAdminPricing } from '@/lib/pricing/policy';
import { pricingCanonical, pricingCatalogRowId } from '@/lib/pricing/catalog';
import { PRICING_POLICY_KEY, type PricingAdminPreviewInput } from '@/lib/pricing/admin-contract';
import { PRICING_AUTHORING_KEY } from '@/lib/pricing/pricing-authoring-contract';
import { getPricingImageChannelOptions } from '@/lib/pricing/image';
import { IMAGE_25_QUALITY_MODEL, isImage25Quality, type Image25Quality } from '@/lib/image-studio/quality-routing';
import { getImageGenerationDefaultRoutes, parseImageGenerationDefaultRoutes, serializeImageGenerationDefaultRoutes,
  IMAGE_GENERATION_MODEL_DEFAULTS_SETTING_KEY } from './image-generation-defaults';
import { getManagedImageGenerationChannels, getImageGenerationSettingsForModel,
  prepareImageQualityChannelUpdate, persistImageQualityChannelUpdate, IMAGE_GENERATION_CHANNEL_REGISTRY_SETTING_KEY,
  ImageGenerationChannelError } from './image-generation';
import { validateStudioProviderApiBaseUrl } from '@/lib/image-studio/provider';

type Client = Prisma.TransactionClient | typeof prisma;
type Stage = Awaited<ReturnType<typeof prepareImageQualityChannelUpdate>>;
const prefix = 'image_quality_route_operation_v1:';
const fingerprint = (value: unknown) => createHash('sha256').update(pricingCanonical(value)).digest('hex');
const fail = (message: string): never => { throw new ImageGenerationChannelError(message, 409, 'image_quality_route_conflict'); };
const operationKey = (actorId: string, id: string) => `${prefix}${actorId}:${id}`;
function operationId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(value)) fail('原操作编号无效');
}
async function actor(id: string, tx: Client, writing = false) {
  const user = await tx.user.findUnique({ where: { id }, select: { id: true, role: true, status: true } });
  if (user?.role !== 'admin' || user.status !== 'active') throw new ImageGenerationChannelError('只有有效管理员可修改图片质量 API', 403);
  if (writing && !PRICING_ADMIN_WRITES_ENABLED) fail('当前为相容回退程序，只读保留已保存的质量和费率配置');
  return { id: user.id };
}
export async function readImageQualityOperation(actorId: string, id: string, tx: Client = prisma) {
  operationId(id); await actor(actorId, tx);
  const row = await tx.platformSetting.findUnique({ where: { key: operationKey(actorId, id) } });
  return row ? JSON.parse(row.value_json) as { fingerprint: string; receipt: Record<string, unknown> } : null;
}
async function swapRoutes(tx: Prisma.TransactionClient, old: string | undefined, next: string, actorId: string) {
  if (old !== undefined) {
    const result = await tx.platformSetting.updateMany({ where: { key: IMAGE_GENERATION_MODEL_DEFAULTS_SETTING_KEY, value_json: old },
      data: { value_json: next, updated_by: actorId } });
    if (result.count !== 1) fail('图片路由发生并发变化，整批未保存');
  } else await tx.platformSetting.create({ data: { key: IMAGE_GENERATION_MODEL_DEFAULTS_SETTING_KEY, value_json: next, updated_by: actorId } });
}
async function writeReceipt(tx: Prisma.TransactionClient, actorId: string, id: string, hash: string, receipt: Record<string, unknown>) {
  await tx.platformSetting.create({ data: { key: operationKey(actorId, id), value_json: JSON.stringify({ fingerprint: hash, receipt }), updated_by: actorId } });
  return receipt;
}
export async function readImageQualitySettings(actorId: string) {
  return prisma.$transaction(async tx => {
    await actor(actorId, tx);
    const [routes, providers, prices] = await Promise.all([
      getImageGenerationDefaultRoutes(tx), getManagedImageGenerationChannels(tx), getPricingImageChannelOptions(tx),
    ]);
    return { model: IMAGE_25_QUALITY_MODEL, routes, writesEnabled: PRICING_ADMIN_WRITES_ENABLED,
      providers: providers.filter(item => item.models[IMAGE_25_QUALITY_MODEL]).map(item => ({ ...item,
        models: { [IMAGE_25_QUALITY_MODEL]: item.models[IMAGE_25_QUALITY_MODEL] },
        price: prices.items.find(value => value.id === item.id)?.models[IMAGE_25_QUALITY_MODEL] || null })) };
  }, { maxWait: 10000, timeout: 30000 });
}

export async function saveImageQualityRoute(actorId: string, input: Record<string, unknown>) {
  operationId(input.operationId);
  if (Object.keys(input).some(key => !['channel_action', 'operationId', 'quality', 'channelId', 'expectedRevision', 'expectedConfigRevision', 'api'].includes(key))
    || !isImage25Quality(input.quality) || typeof input.channelId !== 'string'
    || !/^image-[0-9a-f-]{36}$/.test(input.channelId) || !Number.isSafeInteger(input.expectedRevision)
    || typeof input.expectedConfigRevision !== 'string') fail('质量路由或配置版本无效');
  const id = input.operationId, quality = input.quality as Image25Quality, channelId = input.channelId as string, hash = fingerprint(input);
  const previous = await readImageQualityOperation(actorId, id);
  if (previous) { if (previous.fingerprint !== hash) fail('同一操作编号已用于不同输入，请查询原回执'); return previous.receipt; }
  let patch: { baseUrl?: string; apiKey?: string; maxReferences?: number; resolutions?: string[] } | undefined;
  if (input.api !== undefined) {
    if (!input.api || typeof input.api !== 'object' || Array.isArray(input.api)) fail('API 设置格式无效');
    const api = input.api as Record<string, unknown>;
    if (Object.keys(api).some(key => !['baseUrl', 'apiKey', 'maxReferences', 'resolutions'].includes(key))
      || typeof api.baseUrl !== 'string' || api.apiKey !== undefined && typeof api.apiKey !== 'string'
      || api.maxReferences !== undefined && (!Number.isSafeInteger(api.maxReferences) || Number(api.maxReferences) < 0 || Number(api.maxReferences) > 32)
      || api.resolutions !== undefined && (!Array.isArray(api.resolutions) || !api.resolutions.length || api.resolutions.some(value => !['1K', '2K', '4K'].includes(String(value))))) fail('API 参数无效，未修改原配置');
    const url = await validateStudioProviderApiBaseUrl(api.baseUrl as string);
    const baseUrl = url.ok ? url.url : fail('API 地址必须是安全的 HTTPS 公网地址');
    const key = typeof api.apiKey === 'string' ? api.apiKey.trim() : '';
    if (key.length > 500 || /[*•●…]{3,}|[\r\n\x00-\x1f\x7f]/.test(key)) fail('请填写真实 Key，不能保存掩码或控制字符');
    if (quality === 'medium' && api.maxReferences !== undefined && Number(api.maxReferences) > 7) fail('中等档当前总参考图上限为7张，未提高限制');
    patch = { baseUrl, ...(key ? { apiKey: key } : {}),
      ...(api.maxReferences !== undefined ? { maxReferences: Number(api.maxReferences) } : {}),
      ...(api.resolutions ? { resolutions: api.resolutions as string[] } : {}) };
  }
  return prisma.$transaction(async tx => {
    await actor(actorId, tx, true); await assertPricingImageConsumerReady(tx);
    const replay = await readImageQualityOperation(actorId, id, tx);
    if (replay) { if (replay.fingerprint !== hash) fail('同一操作编号已用于不同输入'); return replay.receipt; }
    const row = await tx.platformSetting.findUnique({ where: { key: IMAGE_GENERATION_MODEL_DEFAULTS_SETTING_KEY } });
    const routes = parseImageGenerationDefaultRoutes(row?.value_json);
    if (routes.revision !== input.expectedRevision || routes.revision >= Number.MAX_SAFE_INTEGER) fail('路由已被修改，请保留草稿重新读取');
    const settings = await getImageGenerationSettingsForModel(IMAGE_25_QUALITY_MODEL, tx, channelId);
    if (settings.configRevision !== input.expectedConfigRevision) fail('API 已被修改，请保留草稿重新读取');
    const opposite = quality === 'medium' ? 'max' : 'medium';
    if (routes.qualityRoutes?.[IMAGE_25_QUALITY_MODEL]?.[opposite] === channelId) fail('中等与最高必须分别使用独立 API');
    let configRevision = settings.configRevision;
    if (patch) {
      const staged = await prepareImageQualityChannelUpdate(tx, channelId, randomUUID(), patch);
      await persistImageQualityChannelUpdate(tx, staged, actorId); configRevision = staged.configRevision;
    }
    const configured = await getImageGenerationSettingsForModel(IMAGE_25_QUALITY_MODEL, tx, channelId);
    const capability = configured.modelCapabilities[IMAGE_25_QUALITY_MODEL];
    if (capability?.qualities && !capability.qualities.includes(quality)) fail('该 API 未配置此质量档位，未自动更改参数');
    if (quality === 'medium' && capability?.maxReferences != null && capability.maxReferences > 7) fail('中等档参考总数不能超过7，请先修改该档 API 设置');
    const next = { ...routes, revision: routes.revision + 1, qualityRoutes: { ...routes.qualityRoutes,
      [IMAGE_25_QUALITY_MODEL]: { ...routes.qualityRoutes?.[IMAGE_25_QUALITY_MODEL], [quality]: channelId } } };
    await swapRoutes(tx, row?.value_json, serializeImageGenerationDefaultRoutes(next), actorId);
    return writeReceipt(tx, actorId, id, hash, { operationId: id, state: 'succeeded', quality, channelId, configRevision,
      routes: next, savedAt: new Date().toISOString() });
  }, { maxWait: 10000, timeout: 30000 });
}

async function activationState(tx: Client) {
  const keys = [IMAGE_GENERATION_CHANNEL_REGISTRY_SETTING_KEY, IMAGE_GENERATION_MODEL_DEFAULTS_SETTING_KEY, PRICING_POLICY_KEY, PRICING_AUTHORING_KEY];
  const rows = await tx.platformSetting.findMany({ where: { key: { in: keys } } });
  const raw = Object.fromEntries(keys.map(key => [key, rows.find(row => row.key === key)?.value_json ?? null]));
  return { raw, fingerprint: fingerprint(raw) };
}

/** Read-through projection for --plan; no temporary writes or provider requests. */
function stagedReader(tx: Prisma.TransactionClient, staged: Stage): Prisma.TransactionClient {
  const values: Record<string, string> = { [IMAGE_GENERATION_CHANNEL_REGISTRY_SETTING_KEY]: staged.registryJson, [staged.versionKey]: staged.versionJson };
  const project = (row: Record<string, unknown>, select: Record<string, unknown> | undefined) => select
    ? Object.fromEntries(Object.entries(row).filter(([key]) => select[key])) : row;
  const platformSetting = new Proxy(tx.platformSetting, { get(target, property) {
    if (property === 'findUnique' || property === 'findUniqueOrThrow') return async (args: { where: { key?: string }; select?: Record<string, unknown> }) => {
      const key = args.where.key;
      if (key && values[key] !== undefined) return project({ key, value_json: values[key] }, args.select);
      return (target[property] as Function).call(target, args);
    };
    if (property === 'findMany') return async (args: unknown) => {
      const rows = await target.findMany(args as never);
      return rows.map(row => values[row.key] !== undefined ? { ...row, value_json: values[row.key] } : row);
    };
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } });
  return new Proxy(tx, { get(target, property) { return property === 'platformSetting' ? platformSetting : Reflect.get(target, property); } });
}

export type Image25ActivationTargets = { mediumChannelId: string; maxChannelId: string };
export type Image25ActivationPlan = {
  schema: 'image25-quality-activation.v1'; actorId: string; operationId: string; expectedStateFingerprint: string;
  targets: Image25ActivationTargets;
  expectedDefaultsRevision: number; expectedPricingRevision: string; expectedAuthoringRevision: string;
  expectedMediumRevision: string; expectedMaxRevision: string; maxFingerprint: string;
  mediumConfigRevision: string; pricing: PricingAdminPreviewInput; previewToken: string;
};

async function prepareActivation(actorId: string, operation: string, tx: Prisma.TransactionClient, targets: Image25ActivationTargets,
  revision: string = randomUUID()) {
  await actor(actorId, tx); await assertPricingImageConsumerReady(tx);
  if (!targets || Object.keys(targets).sort().join(',') !== 'maxChannelId,mediumChannelId'
    || !/^image-[0-9a-f-]{36}$/.test(targets.mediumChannelId) || !/^image-[0-9a-f-]{36}$/.test(targets.maxChannelId)
    || targets.mediumChannelId === targets.maxChannelId) fail('中等与最高必须精确指定两个不同的已有 API 编号');
  const state = await activationState(tx), routes = parseImageGenerationDefaultRoutes(state.raw[IMAGE_GENERATION_MODEL_DEFAULTS_SETTING_KEY]);
  if (routes.qualityRoutes?.[IMAGE_25_QUALITY_MODEL] && Object.keys(routes.qualityRoutes[IMAGE_25_QUALITY_MODEL]!).length) fail('两档路由已存在，请查原操作或使用后台精确设置');
  const max = await getImageGenerationSettingsForModel(IMAGE_25_QUALITY_MODEL, tx, targets.maxChannelId);
  if (!max.enabled || max.deleted || !max.api_key || max.modelCapabilities[IMAGE_25_QUALITY_MODEL]?.fixedPoints !== 5) fail('最高原 5 点通道或配置已变化，停止激活');
  const staged = await prepareImageQualityChannelUpdate(tx, targets.mediumChannelId, revision,
    { mediumActivation: true, baseUrl: 'https://api.uselg.top' });
  const projected = stagedReader(tx, staged), snapshot = await getAdminPricingSnapshot({ id: actorId }, projected);
  if (snapshot.authoring?.globalPointsPerCny !== '10') fail('当前统一费率不是 10，未改全局或其它价格');
  const authoring = snapshot.authoring!;
  const identity = { kind: 'image' as const, channelId: targets.mediumChannelId, modelId: IMAGE_25_QUALITY_MODEL,
    billingMode: 'fixed' as const, unit: 'image' as const, specifications: {} };
  const pricing: PricingAdminPreviewInput = { expectedRevision: snapshot.revision, expectedAuthoringRevision: authoring.revision,
    catalogFingerprint: snapshot.catalogFingerprint, action: { kind: 'save', changes: { rows: [{ id: pricingCatalogRowId(identity),
      authoringRateMode: 'follow_global', basisKind: 'site_base_cny',
      base: { amount: '0.05', currency: 'CNY', unit: 'image', source: { type: 'admin_defined', reference: 'IMG25 user_confirmed 2026-10-19',
        note: '用户确认人民币基价0.05元/张；供应商usage币种仍待核，不作为人民币实账证明' } },
      evidence: { kind: 'user_provided', amount: '0.05', currency: 'CNY', unit: 'image', specifications: {},
        sampledAt: null, exchangeAssumption: null, reference: 'IMG25 user_confirmed 2026-10-19', version: '1' } }] } },
    scenarios: [1, 3, 10].map(quantity => ({ rowId: pricingCatalogRowId(identity), quantity: String(quantity) })) };
  const preview = await previewAdminPricing({ id: actorId }, pricing, projected);
  if (preview.affectedRuleIds.length !== 1 || preview.affectedRuleIds[0] !== pricingCatalogRowId(identity)
    || preview.skipped.length || preview.scenarios?.length !== 3
    || preview.scenarios.some((value, index) => Number(value.adjustedCredits) !== [0.5, 1.5, 5][index])) fail('中等费率预览未精确得到0.5/1.5/5点，未激活');
  const plan: Image25ActivationPlan = { schema: 'image25-quality-activation.v1', actorId, operationId: operation, targets,
    expectedStateFingerprint: state.fingerprint, expectedDefaultsRevision: routes.revision,
    expectedPricingRevision: snapshot.revision, expectedAuthoringRevision: authoring.revision,
    expectedMediumRevision: staged.previousRevision, expectedMaxRevision: max.configRevision, maxFingerprint: fingerprint(max),
    mediumConfigRevision: revision, pricing, previewToken: preview.previewToken };
  return { plan, staged, state, routes, preview };
}

export async function planImage25Activation(actorId: string, id: string, targets: Image25ActivationTargets) {
  operationId(id);
  return prisma.$transaction(async tx => {
    const result = await prepareActivation(actorId, id, tx, targets);
    return { ...result.plan, summary: { mediumCredits: '0.5', quantities: [1, 3, 10], credits: ['0.5', '1.5', '5'],
      highestCredits: '5', maximumTotalReferences: 7, supplierCostStatus: 'user_confirmed_CNY_supplier_unit_unverified',
      affectedRuleIds: result.preview.affectedRuleIds, originalModelsPreserved: true } };
  }, { maxWait: 10000, timeout: 30000 });
}

export async function applyImage25Activation(actorId: string, plan: Image25ActivationPlan) {
  operationId(plan.operationId);
  if (plan.schema !== 'image25-quality-activation.v1' || plan.actorId !== actorId || !/^[a-f0-9-]{36}$/.test(plan.mediumConfigRevision)) fail('激活计划无效或不是当前管理员原计划');
  const hash = fingerprint(plan), id = plan.operationId;
  const existing = await readImageQualityOperation(actorId, id);
  if (existing) { if (existing.fingerprint !== hash) fail('原激活编号对应不同计划'); return existing.receipt; }
  return prisma.$transaction(async tx => {
    await actor(actorId, tx, true); await assertPricingImageConsumerReady(tx);
    const previous = await readImageQualityOperation(actorId, id, tx);
    if (previous) { if (previous.fingerprint !== hash) fail('原激活编号对应不同计划'); return previous.receipt; }
    const current = await prepareActivation(actorId, id, tx, plan.targets, plan.mediumConfigRevision);
    if (current.state.fingerprint !== plan.expectedStateFingerprint || current.plan.maxFingerprint !== plan.maxFingerprint
      || current.plan.expectedDefaultsRevision !== plan.expectedDefaultsRevision
      || current.plan.expectedPricingRevision !== plan.expectedPricingRevision
      || current.plan.expectedAuthoringRevision !== plan.expectedAuthoringRevision
      || current.plan.expectedMediumRevision !== plan.expectedMediumRevision || current.plan.expectedMaxRevision !== plan.expectedMaxRevision
      || pricingCanonical(current.plan.pricing) !== pricingCanonical(plan.pricing)) fail('配置或费率已变化，原计划整批未激活');
    await persistImageQualityChannelUpdate(tx, current.staged, actorId);
    const price = await saveAdminPricing({ id: actorId }, { ...plan.pricing,
      operationId: `img25-${id}`, previewToken: plan.previewToken }, tx);
    if (price.state !== 'succeeded') fail(price.error?.message || '中等费率保存未确认，整批回滚');
    const ruleId = current.preview.affectedRuleIds[0];
    const finalState = await activationState(tx);
    const oldPolicy = JSON.parse(current.state.raw[PRICING_POLICY_KEY] || '{"rules":[]}');
    const newPolicy = JSON.parse(finalState.raw[PRICING_POLICY_KEY] || '{"rules":[]}');
    if (fingerprint(oldPolicy.rules.filter((rule: { id: string }) => rule.id !== ruleId))
      !== fingerprint(newPolicy.rules.filter((rule: { id: string }) => rule.id !== ruleId))) fail('非中等档收费规则发生变化，整批回滚');
    const oldAuthoring = JSON.parse(current.state.raw[PRICING_AUTHORING_KEY] || '{}');
    const newAuthoring = JSON.parse(finalState.raw[PRICING_AUTHORING_KEY] || '{}');
    const unrelatedAuthoring = (value: { members?: string[]; entries?: Record<string, unknown>; globalPointsPerCny?: string }) => ({
      globalPointsPerCny: value.globalPointsPerCny, members: (value.members || []).filter(id => id !== ruleId),
      entries: Object.fromEntries(Object.entries(value.entries || {}).filter(([id]) => id !== ruleId)),
    });
    if (fingerprint(unrelatedAuthoring(oldAuthoring)) !== fingerprint(unrelatedAuthoring(newAuthoring))) fail('非中等档统一费率或依据发生变化，整批回滚');
    const next = { ...current.routes, revision: current.routes.revision + 1, qualityRoutes: { ...current.routes.qualityRoutes,
      [IMAGE_25_QUALITY_MODEL]: { medium: plan.targets.mediumChannelId, max: plan.targets.maxChannelId } } };
    await swapRoutes(tx, current.state.raw[IMAGE_GENERATION_MODEL_DEFAULTS_SETTING_KEY] ?? undefined,
      serializeImageGenerationDefaultRoutes(next), actorId);
    const highest = await getImageGenerationSettingsForModel(IMAGE_25_QUALITY_MODEL, tx, plan.targets.maxChannelId);
    if (fingerprint(highest) !== plan.maxFingerprint) fail('最高配置发生变化，整批回滚');
    return writeReceipt(tx, actorId, id, hash, { operationId: id, state: 'succeeded', routes: next,
      mediumConfigRevision: current.staged.configRevision, pricingRevision: price.revision,
      affectedRuleIds: price.affectedRuleIds, maxConfigRevision: highest.configRevision,
      mediumCredits: '0.5', highestCredits: '5', savedAt: new Date().toISOString() });
  }, { maxWait: 10000, timeout: 30000 });
}
