import { createHash, randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { ImageGenerationChannelSnapshot } from '@/lib/integrations/image-generation-channel';
import { imageBillingScope } from './billing-scope';
import { resolveImageGenerationChannelSnapshot } from '@/lib/integrations/image-generation';
import { prepareImageBillingQuote } from './billing-quote-service';
import { imageQuoteKey, type StoredImageQuote } from './billing-quote-store';
import { parseStudioRequest, safeImageChannelSnapshot, parseSharedStudioIntent, sameSharedStudioIntent, resolveOwnedStudioTaskSharedUse, studioSharedGenerationSource, studioBusinessErrorStatus, StudioError } from './tasks';
import type { SharedStudioIntent } from './shared-types';
import { STUDIO_BATCH_LIMITS } from './batch-contract';
import { parseImageBillingContract, type ImageBillingContract } from './billing-contract';
import { imageBillingReady } from './billing-readiness';
import { getImageStudioSettings } from './settings';
import { resolveStudioModuleGenerationConfig } from './modules';
import { captureImageGenerationChannel } from '@/lib/integrations/image-generation';
import { resolveImageGenerationRequestChannel } from '@/lib/integrations/image-generation-defaults';
import { addCredits, creditCents, sumCredits } from '@/lib/credits/precision';
import { assertNewPricingCharge } from '@/lib/pricing/charge';
import { pricingCanonical } from '@/lib/pricing/catalog';
import { samePricingImageCharge } from '@/lib/pricing/image';

const key = (owner: string, id: string) => `image_batch_billing_quote_v1:${owner}:${id}`;

function sameImageChannel(left: ImageGenerationChannelSnapshot | undefined, right: ImageGenerationChannelSnapshot | undefined) {
  return left?.channelId === right?.channelId && left?.configRevision === right?.configRevision;
}

function isPinnedChannelId(value: unknown): value is string {
  return value === 'shared' || value === 'banana' || value === 'fluxport'
    || typeof value === 'string' && /^image-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function assertImageChannelPairMatches(
  channel: ImageGenerationChannelSnapshot | undefined,
  requestedChannelId: string,
): asserts channel is ImageGenerationChannelSnapshot {
  if (!channel || channel.channelId !== requestedChannelId || !/^[0-9a-f-]{36}$/i.test(channel.configRevision)) {
    throw new StudioError('图片通道配置已变化或报价缺少修订信息，请重新获取报价', 409);
  }
}

function canonicalImageChannel(body: Record<string, unknown>, resolved?: ImageGenerationChannelSnapshot) {
  const supplied = body.imageChannel === undefined ? undefined : safeImageChannelSnapshot(body.imageChannel) || undefined;
  if (body.imageChannel !== undefined && !supplied) throw new StudioError('图片通道配置版本无效', 409);
  if (supplied && resolved && !sameImageChannel(supplied, resolved)) {
    throw new StudioError('整批报价对应的图片通道修订已变化，请重新报价', 409);
  }
  const channel = resolved || supplied;
  if (channel && typeof body.channelId === 'string' && body.channelId !== channel.channelId
    && !(resolved && body.channelId === 'original')) {
    throw new StudioError('图片通道与报价修订不匹配', 409);
  }
  return channel;
}

export function batchQuoteFingerprint(body: Record<string, unknown>, resolvedChannel?: ImageGenerationChannelSnapshot, version: 1 | 2 = 2) {
  const input = parseStudioRequest({ ...body, count: 1, maxEstimatedCost: undefined });
  const channel = canonicalImageChannel(body, resolvedChannel);
  const normalizedInput = { ...input } as Record<string, unknown>;
  delete normalizedInput.imageChannel;
  if (channel) normalizedInput.channelId = channel.channelId;
  const value = { input: normalizedInput,
    imageChannel: channel ? { channelId: channel.channelId, configRevision: channel.configRevision } : null,
    moduleId: body.moduleId, sources: body.sources };
  // Versionless receipts keep their original byte-level contract, without fallback matching.
  return createHash('sha256').update(version === 1 ? JSON.stringify(value) : pricingCanonical(value)).digest('hex');
}

type StoredBatchQuote = {
  owner: string;
  fingerprint: string;
  fingerprintVersion?: 2;
  intentRevision: number;
  contracts: ImageBillingContract[];
  expiresAt: string;
  total: number;
  unitCredits: number;
  imageChannel?: ImageGenerationChannelSnapshot;
  sharedLive?: SharedStudioIntent;
};

export async function quoteStudioBatch(owner: string, body: Record<string, unknown>) {
  const sources = body.sources;
  if (typeof body.moduleId !== 'string' || !Array.isArray(sources) || !sources.length || sources.length > STUDIO_BATCH_LIMITS.images) throw new StudioError('本批素材数量或模板无效');
  const input = parseStudioRequest({ ...body, count: 1, maxEstimatedCost: undefined });
  const batchId = createHash('sha256').update(`${owner}:${input.requestId}`).digest('hex');
  const contracts: Array<ImageBillingContract | null> = [];
  const policy = input.draft?.referencePolicy;
  let total = 0, fixedUnit: number | null = null, intentRevision: number | null = null;
  const suppliedImageChannel = canonicalImageChannel({ ...body, channelId: undefined });
  const workspace = await prisma.imageStudioModule.findFirst({ where: { id: body.moduleId, owner_id: owner }, select: { model: true, quality: true, resolution: true } });
  if (!workspace) throw new StudioError('模板不存在或无权使用', 404);
  const settings = await getImageStudioSettings();
  const sharedUse = await prisma.$transaction(tx => resolveOwnedStudioTaskSharedUse(owner, body.moduleId as string, input.sharedLive, tx));
  const sharedLive = sharedUse?.definition.intent;
  const generationSource = sharedUse ? studioSharedGenerationSource(sharedUse, input) : { ...workspace, ...(input.model ? { model: input.model } : {}) };
  const model = resolveStudioModuleGenerationConfig(generationSource, settings).model;
  const requestedChannelId = typeof body.channelId === 'string' ? body.channelId : undefined;
  const effectiveChannelId = requestedChannelId === undefined && suppliedImageChannel
    ? suppliedImageChannel.channelId
    : (await resolveImageGenerationRequestChannel(model, requestedChannelId) || 'original');
  if (suppliedImageChannel && suppliedImageChannel.channelId !== effectiveChannelId) {
    throw new StudioError('整批报价对应的图片通道与型号默认供应商不匹配，请重新报价', 409);
  }
  let imageChannel = suppliedImageChannel || (effectiveChannelId === 'original' ? undefined : await captureImageGenerationChannel(model, effectiveChannelId));
  try {
    for (let index = 0; index < sources.length; index++) {
      const source = sources[index] as { name?: unknown; assetId?: unknown };
      if (!source || typeof source.name !== 'string' || source.name.length > 160
        || source.assetId !== undefined && (typeof source.assetId !== 'string' || source.assetId.length > 100)) throw new StudioError('素材清单无效');
      const referenceIds = source.assetId ? [source.assetId as string, ...input.referenceIds.filter(id => !policy?.primaryIds.includes(id))] : input.referenceIds;
      const quote = await prepareImageBillingQuote(owner, { ...body,
        ...(imageChannel ? { ...(typeof body.channelId === 'string' ? { channelId: body.channelId }
          : imageChannel.channelId === 'original' ? {} : { channelId: imageChannel.channelId }), imageChannel } : {}),
        requestId: `${batchId.slice(0, 48)}-${index + 1}`, count: 1,
        referenceIds, ...(source.assetId && input.draft && policy ? { draft: { ...input.draft, referencePolicy: { ...policy, primaryIds: [source.assetId] } } } : {}) }, undefined, undefined, undefined, 256);
      if (quote.imageChannel) {
        if (imageChannel && !sameImageChannel(imageChannel, quote.imageChannel)) {
          throw new StudioError('整批准备期间图片通道修订发生变化，未报价', 409);
        }
        imageChannel = quote.imageChannel;
      }
      if (!sameSharedStudioIntent(sharedLive, quote.sharedLive)) throw new StudioError('模板已更新，请确认本次生成', 409);
      const isPinned = isPinnedChannelId(imageChannel?.channelId);
      if (isPinned) {
        assertImageChannelPairMatches(imageChannel, imageChannel?.channelId || '');
        const quotedChannel = quote.imageChannel;
        assertImageChannelPairMatches(quotedChannel, imageChannel.channelId);
        if (quotedChannel.configRevision !== imageChannel.configRevision) {
          throw new StudioError('整批报价缺少固定的图片通道修订，未报价', 409);
        }
      }
      if (!Number.isFinite(quote.unitCredits) || quote.unitCredits < 0 || !Number.isFinite(quote.estimatedCredits) || quote.estimatedCredits < 0) {
        throw new StudioError('整批中有条目无法确认有效价格，未报价', 409);
      }
      total = addCredits(total, quote.unitCredits);
      fixedUnit = quote.unitCredits;
      if (!quote.billingQuoteId) { contracts.push(null); continue; }
      const row = await prisma.platformSetting.findUniqueOrThrow({ where: { key: imageQuoteKey(owner, quote.billingQuoteId) } });
      const stored = JSON.parse(row.value_json) as StoredImageQuote & { imageChannel?: ImageGenerationChannelSnapshot };
      if (stored.owner !== owner || !stored.contract || stored.contract.mode !== 'actual' && !stored.contract.pricing
        || !sameSharedStudioIntent(sharedLive, parseSharedStudioIntent(stored.sharedLive))
        || imageChannel && !sameImageChannel(stored.imageChannel, imageChannel)) {
        throw new StudioError('单项报价与整批图片通道不匹配，未报价', 409);
      }
      contracts.push(stored.contract);
      if (intentRevision !== null && stored.intentRevision !== intentRevision) {
        throw new StudioError('整批准备期间实际计费设置发生变化，未报价', 409);
      }
      intentRevision = stored.intentRevision;
      await prisma.platformSetting.delete({ where: { id: row.id } });
    }
  } catch (error) {
    const status = studioBusinessErrorStatus(error);
    if (status && error instanceof Error) throw new StudioError(error.message, status);
    throw new StudioError('整批报价未确认，未派发生成', 503);
  }

  const publicChannel = imageChannel ? { channelId: imageChannel.channelId, configRevision: imageChannel.configRevision } : undefined;
  await prisma.$transaction(tx => resolveOwnedStudioTaskSharedUse(owner, body.moduleId as string, sharedLive, tx));
  const sharedResult = sharedLive ? { sharedLive } : {};
  if (imageChannel) {
    try { await resolveImageGenerationChannelSnapshot(imageChannel, undefined, true, model); }
    catch { throw new StudioError('整批准备期间图片通道已停用或修订过期，请重新报价', 409); }
  }
  if (contracts.every(contract => contract === null)) return { ...sharedResult, billingMode: 'fixed' as const, batchQuoteId: null,
    pricingRevision: null, creditPrecision: 0.01 as const,
    unitCredits: fixedUnit, estimatedCredits: total, expiresAt: new Date(Date.now() + 60000).toISOString(),
    ...(publicChannel ? { imageChannel: publicChannel } : {}) };
  if (contracts.some(contract => !contract)) throw new StudioError('批量准备期间计费状态发生变化，请重新报价', 409);
  const exactContracts = contracts as ImageBillingContract[];
  const first = exactContracts[0];
  if (!first || exactContracts.some(contract => contract.scope !== first.scope || contract.model !== first.model
    || contract.mode !== first.mode || !samePricingImageCharge(contract.pricing, first.pricing))) {
    throw new StudioError('整批条目不是同一私有账单范围和型号，未报价', 409);
  }
  if (first.mode === 'actual') {
    const finalReadiness = await imageBillingReady(first.scope, first.model);
    if (!finalReadiness.ready || finalReadiness.intentRevision !== intentRevision) {
      throw new StudioError('整批准备期间实际计费设置发生变化，未报价', 409);
    }
  }
  for (const contract of exactContracts) if (contract.pricing) await assertNewPricingCharge(contract.pricing, first.pricing?.revision);
  if (imageChannel) {
    try {
      const current = await resolveImageGenerationChannelSnapshot(imageChannel, undefined, true, first.model);
      if (imageBillingScope(current) !== first.scope) throw new Error('scope_changed');
    } catch { throw new StudioError('图片通道在整批报价期间已变化，请重新报价', 409); }
  }
  const id = randomUUID(), expiresAt = new Date(Math.min(...exactContracts.map(contract => Date.parse(contract.expiresAt)))).toISOString();
  if (Date.parse(expiresAt) <= Date.now()) throw new StudioError('整批准备超过报价有效期，请重新报价', 409);
  await prisma.platformSetting.deleteMany({ where: { key: { startsWith: `image_batch_billing_quote_v1:${owner}:` },
    created_at: { lt: new Date(Date.now() - 120000) } } });
  const storedQuote: StoredBatchQuote = { owner, fingerprint: batchQuoteFingerprint(body, imageChannel), fingerprintVersion: 2,
    intentRevision: intentRevision ?? 0, contracts: exactContracts, expiresAt, total,
    unitCredits: Math.max(...exactContracts.map(contract => contract.authorizedCredits)), ...sharedResult, ...(imageChannel ? { imageChannel } : {}) };
  await prisma.platformSetting.create({ data: { key: key(owner, id), updated_by: owner,
    value_json: JSON.stringify(storedQuote) } });
  return { ...sharedResult, billingMode: first.mode, batchQuoteId: id, unitCredits: storedQuote.unitCredits,
    pricingRevision: first.pricing?.revision ?? null,
    creditPrecision: first.pricing && !['legacy_fixed', 'legacy_actual'].includes(first.pricing.mode) ? 0.1 as const : 0.01 as const,
    estimatedCredits: total, expiresAt, ...(publicChannel ? { imageChannel: publicChannel } : {}) };
}

export async function consumeBatchQuote(tx: Prisma.TransactionClient, owner: string, body: Record<string, unknown>) {
  if (typeof body.batchQuoteId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.batchQuoteId)) throw new StudioError('整批报价编号无效');
  const row = await tx.platformSetting.findUnique({ where: { key: key(owner, body.batchQuoteId) } });
  if (!row) throw new StudioError('整批报价已过期或不可用', 409);
  let stored: StoredBatchQuote;
  try { stored = JSON.parse(row.value_json) as StoredBatchQuote; }
  catch { throw new StudioError('整批报价记录无效，未派发生成', 409); }
  if (stored.fingerprintVersion !== undefined && stored.fingerprintVersion !== 2) {
    throw new StudioError('整批报价格式无效，未派发生成', 409);
  }
  const storedChannel = stored.imageChannel ? safeImageChannelSnapshot(stored.imageChannel) || undefined : undefined;
  const input = parseStudioRequest({ ...body, count: 1, maxEstimatedCost: undefined });
  const workspace = typeof body.moduleId === 'string'
    ? await tx.imageStudioModule.findFirst({ where: { id: body.moduleId, owner_id: owner }, select: { model: true, quality: true, resolution: true } })
    : null;
  if (!workspace) throw new StudioError('模板不存在或无权使用', 404);
  const settings = await getImageStudioSettings();
  const sharedUse = await resolveOwnedStudioTaskSharedUse(owner, body.moduleId as string, input.sharedLive, tx);
  if (!sameSharedStudioIntent(parseSharedStudioIntent(stored.sharedLive), sharedUse?.definition.intent)) {
    throw new StudioError('模板已更新，请确认本次生成', 409);
  }
  const generationSource = sharedUse ? studioSharedGenerationSource(sharedUse, input) : { ...workspace, ...(input.model ? { model: input.model } : {}) };
  const model = resolveStudioModuleGenerationConfig(generationSource, settings).model;
  const requestedChannelId = typeof body.channelId === 'string' ? body.channelId : undefined;
  if (requestedChannelId === 'original' && storedChannel) {
    const currentDefault = await resolveImageGenerationRequestChannel(model, 'original', tx) || 'original';
    if (currentDefault !== storedChannel.channelId) throw new StudioError('型号默认图片通道已变化，请重新报价', 409);
  }
  const suppliedChannel = canonicalImageChannel(body, storedChannel);
  if (stored.owner !== owner || !Array.isArray(stored.contracts) || !stored.contracts.length
    || !Number.isFinite(stored.total) || stored.total < 0 || !Number.isFinite(stored.unitCredits) || stored.unitCredits < 0
    || !Number.isInteger(stored.intentRevision) || stored.intentRevision < 0
    || !Number.isFinite(Date.parse(stored.expiresAt))
    || stored.fingerprint !== batchQuoteFingerprint(body, storedChannel, stored.fingerprintVersion ?? 1)
    || !sameImageChannel(suppliedChannel, storedChannel)
    || Date.parse(stored.expiresAt) <= Date.now() || !Array.isArray(body.sources)
    || stored.contracts.length !== body.sources.length || stored.total > Number(body.budget)
    || input.channelId && input.channelId !== 'original' && storedChannel && input.channelId !== storedChannel.channelId) {
    throw new StudioError('本批条件、报价、通道修订或预算已变化', 409);
  }
  const contracts = stored.contracts.map(contract => parseImageBillingContract(JSON.stringify(contract)));
  for (const contract of contracts) {
    if (!contract || contract.mode !== 'actual' && !contract.pricing) throw new StudioError('本批合同无效', 409);
    if (contract.mode === 'actual') {
      const ready = await imageBillingReady(contract.scope, contract.model, tx);
      if (!ready.ready || ready.intentRevision !== stored.intentRevision) throw new StudioError('实扣设置已变化，请重新报价', 409);
    }
    if (contract.pricing) await assertNewPricingCharge(contract.pricing, body.pricingRevision, tx);
  }
  creditCents(stored.total); creditCents(stored.unitCredits);
  if (sumCredits(contracts.map(contract => contract!.authorizedCredits)) !== stored.total
    || contracts.some(contract => contract!.mode !== contracts[0]!.mode)) throw new StudioError('本批报价金额或收费模式不一致', 409);
  if ((await tx.platformSetting.deleteMany({ where: { id: row.id, value_json: row.value_json } })).count !== 1) throw new StudioError('整批报价已被使用', 409);
  return { contracts: contracts as ImageBillingContract[], mode: contracts[0]!.mode, total: stored.total, unitCredits: stored.unitCredits,
    ...(sharedUse ? { sharedLive: sharedUse.definition.intent } : {}),
    ...(storedChannel ? { imageChannel: storedChannel } : {}) };
}
