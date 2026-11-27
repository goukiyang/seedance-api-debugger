import type { ApiQuote } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { fixedPricingCredits } from '@/lib/pricing/math';
import { creditCents } from '@/lib/credits/precision';
import { videoPricingIdentity, type VideoPricingQuote } from '@/lib/pricing/video';
import { getVolcengineIpApiSettings, isVolcengineIpApiReady, type VolcengineIpApiSettings } from '@/lib/integrations/volcengine-ip';
import { apiJson, assertModel, assertNewAdmission, CUSTOMER_API_REQUEST_PREFIX, CustomerApiError, digest, recheckApiContext, type ApiContext, type ApiTx } from './auth';
import { budgetPeriod, inputHash, INTERNAL_IP_MODEL, normalizeVideoInput, publicModels, type ApiVideoInput } from './contracts';
import { reservationUsage, storageUsage } from './usage';
import { resolveApiInputAssets, materializeApiInput, type ApiInputAssets } from './input-assets';
import { ADMINISTERED_PRIVATE_ORIGIN, openPrivatePrompt, sealPrivatePrompt } from '@/lib/security/private-prompts.server';

export type IpApiAdmission = {
  context: ApiContext; fingerprint: string; priceQuote: VideoPricingQuote; providerSettings: VolcengineIpApiSettings;
  preparedImages: Array<{ name: string; originalUrl: string; sourceType: 'upload'; order: number; width?: number | null; height?: number | null }>;
  beforeCreate(tx: ApiTx): Promise<void>; bindTask(tx: ApiTx, taskId: string): Promise<void>;
};

function quotePrice(input: ApiVideoInput, cnyPerSecond: number, pointsPerCny: number, revision: string): VideoPricingQuote {
  const amount = fixedPricingCredits(String(cnyPerSecond), String(pointsPerCny), String(input.duration));
  if (Number(amount.credits) <= 0) throw new CustomerApiError('PRICE_REQUIRED', '客户收费需为明确的正数。', 503);
  const unit = cnyPerSecond * pointsPerCny;
  return { identity: videoPricingIdentity({ provider: 'volcengine_ip', model: INTERNAL_IP_MODEL, resolution: input.resolution, duration: input.duration }),
    quantity: String(input.duration), revision, charge: null,
    pricing: { model: INTERNAL_IP_MODEL, resolution: input.resolution, duration: input.duration, baseCostPerSecond: unit,
      internalMultiplier: 1, finalCostPerSecond: unit, estimatedCost: Number(amount.credits), formula: `${amount.exactCredits} -> ${amount.credits}`,
      pricingRuleId: 'customer-api', pricingRuleVersion: 1, pricingPolicyRevision: revision } };
}

export async function availableApiModels(context: ApiContext) {
  const models = publicModels(context);
  if (!models.length || !context.customer.create_enabled || !context.customer.license_confirmed) return [];
  const [global, provider, rates] = await Promise.all([
    prisma.apiConfiguration.findUnique({ where: { id: 'global' } }),
    getVolcengineIpApiSettings(),
    prisma.apiRate.findMany({ where: { customer_id: context.customer.id, enabled: true, cny_per_second: { gt: 0 } } }),
  ]);
  if (!global?.enabled || !global.license_confirmed || !isVolcengineIpApiReady(provider)) return [];
  return models.flatMap(model => {
    const resolutions = model.resolutions.filter(resolution => rates.some(rate => rate.model === model.id && rate.resolution === resolution));
    return resolutions.length ? [{ ...model, resolutions }] : [];
  });
}

export async function createApiQuote(context: ApiContext, body: Record<string, unknown>) {
  if (Object.keys(body).some(k => !['input', 'max_cost_points'].includes(k))) throw new CustomerApiError('UNKNOWN_FIELD', '报价包含不支持的字段。');
  const input = normalizeVideoInput(body.input);
  const maxCost = body.max_cost_points;
  if (typeof maxCost !== 'number' || !Number.isFinite(maxCost) || maxCost <= 0 || maxCost > 10_000_000) throw new CustomerApiError('COST_CEILING_REQUIRED', '需要明确的 max_cost_points。');
  if (!isVolcengineIpApiReady(await getVolcengineIpApiSettings())) throw new CustomerApiError('PROVIDER_UNAVAILABLE', '生成服务暂未就绪。', 503);
  return prisma.$transaction(async tx => {
    const fresh = await recheckApiContext(tx, context, 'video:write');
    await assertNewAdmission(tx, fresh); assertModel(fresh, input.model);
    const assets = await resolveApiInputAssets(tx, fresh, input);
    const rate = await tx.apiRate.findUnique({ where: { customer_id_model_resolution: { customer_id: fresh.customer.id, model: input.model, resolution: input.resolution } } });
    if (!rate?.enabled || rate.cny_per_second <= 0) throw new CustomerApiError('PRICE_REQUIRED', '此规格尚未配置有效客户售价。', 503);
    const price = quotePrice(input, rate.cny_per_second, fresh.customer.points_per_cny!, `${fresh.customer.revision}:${rate.id}:${rate.revision}`);
    if (price.pricing.estimatedCost > maxCost || price.pricing.estimatedCost > fresh.customer.max_task_points!) throw new CustomerApiError('COST_CEILING', '报价超过本次或客户单笔费用上限。', 409);
    const quote = await tx.apiQuote.create({ data: { customer_id: fresh.customer.id, input_json: JSON.stringify(input), input_hash: inputHash(input),
      asset_versions_json: JSON.stringify(assets.versions), pricing_json: JSON.stringify(price), customer_revision: fresh.customer.revision,
      rate_id: rate.id, rate_revision: rate.revision, points: price.pricing.estimatedCost, max_cost_points: maxCost, expires_at: new Date(Date.now() + 10 * 60_000) } });
    return apiJson({ id: quote.id, input, points: quote.points, max_cost_points: quote.max_cost_points, expires_at: quote.expires_at.toISOString() });
  });
}

export async function originalApiRequest(context: ApiContext, requestId: string, fingerprint?: string) {
  const original = await prisma.apiRequest.findUnique({ where: { customer_id_request_id: { customer_id: context.customer.id, request_id: requestId } } });
  if (original && fingerprint && original.fingerprint !== fingerprint) throw new CustomerApiError('IDEMPOTENCY_CONFLICT', '原请求号已用于不同内容；请查询原请求。', 409);
  return original;
}

export function apiRequestFingerprint(input: ApiVideoInput) {
  return `customer-api:${inputHash(input)}`;
}

const retryableRejections: Record<string, 'same_request' | 'new_quote'> = {
  RATE_LIMIT: 'same_request', INSUFFICIENT_BALANCE: 'same_request', BUDGET_LIMIT: 'same_request',
  CONCURRENCY_LIMIT: 'same_request', STORAGE_LIMIT: 'same_request', QUOTE_CHANGED: 'new_quote', QUOTE_NOT_FOUND: 'new_quote',
};

export function submissionRetry(error: unknown) {
  return error instanceof CustomerApiError ? retryableRejections[error.code] : undefined;
}

export async function rememberRejectedApiRequest(context: ApiContext, requestId: string, fingerprint: string, code: string, retry: string) {
  const scope = { customer_id: context.customer.id, request_id: requestId };
  return prisma.$transaction(async tx => {
    // The original task always takes priority over an admission rejection for an earlier attempt.
    await tx.apiConfiguration.updateMany({ where: { id: 'global' }, data: { revision: { increment: 0 } } });
    const original = await tx.apiRequest.findUnique({ where: { customer_id_request_id: scope } });
    if (original) {
      if (original.fingerprint !== fingerprint) throw new CustomerApiError('IDEMPOTENCY_CONFLICT', '原请求号已用于不同内容。', 409);
      return original;
    }
    const prior = await tx.apiRequestRejection.findUnique({ where: { customer_id_request_id: scope } });
    if (prior && prior.fingerprint !== fingerprint) throw new CustomerApiError('IDEMPOTENCY_CONFLICT', '原请求号已用于不同内容。', 409);
    await tx.apiRequestRejection.upsert({ where: { customer_id_request_id: scope },
      create: { ...scope, fingerprint, code, retry }, update: { code, retry } });
    return null;
  });
}

export async function prepareApiAdmission(context: ApiContext, requestId: string, quoteId: string, input: ApiVideoInput, fingerprint: string) {
  const original = await originalApiRequest(context, requestId, fingerprint);
  if (original) return { original, fingerprint };
  const quote = await prisma.apiQuote.findFirst({ where: { id: quoteId, customer_id: context.customer.id } });
  if (!quote) throw new CustomerApiError('QUOTE_NOT_FOUND', '报价不存在。', 404);
  const providerSettings = await getVolcengineIpApiSettings();
  if (!isVolcengineIpApiReady(providerSettings)) throw new CustomerApiError('PROVIDER_UNAVAILABLE', '生成服务暂未就绪。', 503);
  const assets = await validateQuote(prisma, context, quote, input);
  const materialized = await materializeApiInput(context, input, assets);
  const priceQuote = JSON.parse(quote.pricing_json) as VideoPricingQuote;
  let outputReserved = BigInt(0);
  let period = budgetPeriod(context.customer.timezone);
  const admission: IpApiAdmission = { context, fingerprint, priceQuote, providerSettings, preparedImages: materialized.images,
    async beforeCreate(tx) {
      // The shared global writer serializes task and upload reservations across customers.
      const locked = await tx.apiConfiguration.updateMany({ where: { id: 'global' }, data: { revision: { increment: 0 } } });
      if (!locked.count) throw new CustomerApiError('CONFIGURATION_REQUIRED', '客户 API 尚未配置。', 503);
      const existing = await tx.apiRequest.findUnique({ where: { customer_id_request_id: { customer_id: context.customer.id, request_id: requestId } } });
      if (existing) throw new CustomerApiError('ORIGINAL_REQUEST_EXISTS', '原请求已受理，请查询原请求。', 409);
      const rejected = await tx.apiRequestRejection.findUnique({ where: { customer_id_request_id: { customer_id: context.customer.id, request_id: requestId } } });
      if (rejected && rejected.fingerprint !== fingerprint) throw new CustomerApiError('IDEMPOTENCY_CONFLICT', '原请求号已用于不同内容。', 409);
      const fresh = await recheckApiContext(tx, context, 'video:write');
      const global = await assertNewAdmission(tx, fresh);
      await validateQuote(tx, fresh, quote, input);
      period = budgetPeriod(fresh.customer.timezone);
      const usage = await reservationUsage(tx, fresh.customer.id, period.day, period.month);
      if (creditCents(usage.day) + creditCents(quote.points) > creditCents(fresh.customer.daily_points!)
        || creditCents(usage.month) + creditCents(quote.points) > creditCents(fresh.customer.monthly_points!)) throw new CustomerApiError('BUDGET_LIMIT', '客户日或月预算不足。', 429);
      if (usage.active >= fresh.customer.concurrency_limit! || usage.globalActive >= global.concurrency_limit!) throw new CustomerApiError('CONCURRENCY_LIMIT', '当前执行额度已满，请稍后提交同一原请求。', 429);
      outputReserved = global.max_output_bytes!;
      if (await storageUsage(tx, fresh.customer.id) + outputReserved > fresh.customer.storage_limit_bytes!
        || await storageUsage(tx) + outputReserved > global.storage_limit_bytes!) throw new CustomerApiError('STORAGE_LIMIT', '媒体存储额度不足。', 429);
    },
    async bindTask(tx, taskId) {
      const configuration = JSON.stringify({ apiKey: providerSettings.api_key, baseUrl: providerSettings.base_url, model: INTERNAL_IP_MODEL });
      const credentialDigest = digest(configuration);
      const credential = await tx.apiProviderCredential.findUnique({ where: { digest: credentialDigest } })
        || await tx.apiProviderCredential.create({ data: { digest: credentialDigest,
          configuration_json: sealPrivatePrompt(configuration, credentialBinding(credentialDigest)) } });
      await tx.apiRequest.create({ data: { customer_id: context.customer.id, request_id: requestId, fingerprint, task_id: taskId,
        agent_id: context.key.agent_id, key_id: context.key.id,
        quote_id: quote.id, reserved_points: quote.points, day_key: period.day, month_key: period.month, timezone: context.customer.timezone,
        credential_id: credential.id, output_reserved_bytes: outputReserved } });
      await tx.apiRequestRejection.deleteMany({ where: { customer_id: context.customer.id, request_id: requestId } });
    } };
  return { original: null, fingerprint, admission, body: { ...materialized.body, model: INTERNAL_IP_MODEL,
    project_id: context.customer.project_id, video_card_id: context.customer.video_card_id,
    idempotency_key: CUSTOMER_API_REQUEST_PREFIX + requestId, max_estimated_cost: quote.max_cost_points, pricing_revision: priceQuote.revision } };
}

async function validateQuote(tx: ApiTx | typeof prisma, context: ApiContext, quote: ApiQuote, input: ApiVideoInput): Promise<ApiInputAssets> {
  assertModel(context, input.model);
  if (quote.expires_at.getTime() <= Date.now() || quote.customer_revision !== context.customer.revision
    || quote.input_hash !== inputHash(input)) throw new CustomerApiError('QUOTE_CHANGED', '报价已过期或输入已变化，请重新报价。', 409);
  const rate = await tx.apiRate.findUnique({ where: { id: quote.rate_id } });
  if (!rate?.enabled || rate.customer_id !== context.customer.id || rate.revision !== quote.rate_revision) throw new CustomerApiError('QUOTE_CHANGED', '售价已更新，请重新报价。', 409);
  const assets = await resolveApiInputAssets(tx, context, input);
  if (JSON.stringify(assets.versions) !== quote.asset_versions_json) throw new CustomerApiError('ASSET_CHANGED', '素材已变化，请重新报价。', 409);
  return assets;
}

function credentialBinding(credentialDigest: string) {
  return { kind: 'provider-credential', id: `customer-api:${credentialDigest}`, field: 'configuration',
    origins: [{ kind: 'provider-credential', id: 'customer-api', ownerId: ADMINISTERED_PRIVATE_ORIGIN }] };
}

export async function apiProviderOptions(task: { id?: string; source_type?: string | null }) {
  const sourceType = task.source_type === undefined
    ? task.id && (await prisma.videoTask.findUnique({ where: { id: task.id }, select: { source_type: true } }))?.source_type
    : task.source_type;
  if (sourceType !== 'customer_api') return null;
  const receipt = task.id && await prisma.apiRequest.findUnique({ where: { task_id: task.id }, include: { credential: true } });
  if (!receipt) throw new Error('API provider reader unavailable');
  const value = JSON.parse(openPrivatePrompt(receipt.credential.configuration_json, credentialBinding(receipt.credential.digest))) as { apiKey: string; baseUrl: string; model: string };
  if (!value.apiKey || !value.baseUrl || !value.model) throw new Error('API provider reader unavailable');
  return value;
}
