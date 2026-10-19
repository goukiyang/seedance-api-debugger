import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
  getImageGenerationSettingsForModel,
  captureImageGenerationChannel,
  isMuskImageGenerationChannel,
  resolveImageGenerationChannelSnapshot,
  type ImageGenerationResolvedSettings,
} from '@/lib/integrations/image-generation';
import type { ImageGenerationChannelSnapshot } from '@/lib/integrations/image-generation-channel';
import { submitStudioBatch, safeImageChannelSnapshot, parseSharedStudioIntent, sameSharedStudioIntent, resolveOwnedStudioTaskSharedUse, StudioError } from './tasks';
import type { SharedStudioIntent } from './shared-types';
import { parseImageBillingContract, type ImageBillingContract } from './billing-contract';
import { imageBillingReady } from './billing-readiness';
import { imageBillingScope } from './billing-scope';
import { readImageSupplierBills } from './billing-provider';
import { supplierHistoryEstimate } from './billing-quote';
import { exactSpecificationEstimate, imageCostGroup } from './billing-calibration';
import { imageQuoteKey, type StoredImageQuote } from './billing-quote-store';
import { frozenPricingReservation } from '@/lib/pricing/charge';
import { sumCredits } from '@/lib/credits/precision';
import { samePricingImageCharge, withImagePricing } from '@/lib/pricing/image';

type PreparedImageQuoteResult = {
  billingMode: 'fixed' | 'actual';
  billingQuoteId: string | null;
  unitCredits: number;
  estimatedCredits: number;
  expiresAt: string;
  revision: unknown;
  actualChargeEnabled: boolean;
  imageChannel?: ImageGenerationChannelSnapshot;
  sharedLive?: SharedStudioIntent;
  estimate?: {
    source: string;
    confidence?: string;
    samples: number;
    calibrated: boolean;
    assumption?: string;
  };
  pointsPerUsd?: number;
  multiplier?: number;
  creditPrecision?: number;
  authorizedMaximumCredits?: number;
  pricingRevision?: string;
};

function isManagedChannelId(value: unknown): value is string {
  return value === 'fluxport' || typeof value === 'string' && /^image-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isPinnedChannelId(value: unknown): value is string {
  return value === 'shared' || value === 'banana' || isManagedChannelId(value);
}

function imageChannelFromPreparedTask(task: Prisma.ImageStudioTaskUncheckedCreateInput): ImageGenerationChannelSnapshot | undefined {
  try {
    const snapshot = JSON.parse(String(task.snapshot_json)) as Record<string, unknown>;
    const channel = safeImageChannelSnapshot(snapshot.imageChannel);
    if (!channel || !/^[0-9a-f-]{36}$/i.test(channel.configRevision)) return undefined;
    return channel;
  } catch {
    return undefined;
  }
}

function publicImageChannel(channel: ImageGenerationChannelSnapshot | undefined) {
  return channel ? { channelId: channel.channelId, configRevision: channel.configRevision } : undefined;
}

function assertImageChannelPairMatches(
  channel: ImageGenerationChannelSnapshot | undefined,
  requestedChannelId: string,
): asserts channel is ImageGenerationChannelSnapshot {
  if (!channel || channel.channelId !== requestedChannelId || !/^[0-9a-f-]{36}$/i.test(channel.configRevision)) {
    throw new StudioError('图片通道配置已变化或报价缺少修订信息，请重新获取报价', 409);
  }
}

async function resolveQuoteSettings(model: string, channel: ImageGenerationChannelSnapshot | undefined,
  requestedChannelId: string | undefined): Promise<ImageGenerationResolvedSettings> {
  const channelId = requestedChannelId || channel?.channelId || 'original';
  if (channelId === 'original') {
    if (channel) {
      try { await resolveImageGenerationChannelSnapshot(channel, undefined, true, model); }
      catch { throw new StudioError('原图片通道配置已变化，请重新报价', 409); }
    }
    return getImageGenerationSettingsForModel(model);
  }
  if (isPinnedChannelId(channelId)) assertImageChannelPairMatches(channel, channelId);
  if (!channel || channel.channelId !== channelId) {
    throw new StudioError('图片通道报价缺少固定配置修订，请重新报价', 409);
  }
  try {
    return await resolveImageGenerationChannelSnapshot(channel, undefined, true, model);
  } catch {
    throw new StudioError('图片通道配置已停用或修订过期，请重新获取报价', 409);
  }
}

export async function prepareImageBillingQuote(owner: string, body: Record<string, unknown>, avatar?: Parameters<typeof submitStudioBatch>[2],
  canvasUse?: Parameters<typeof submitStudioBatch>[4], canvasPrompt?: Parameters<typeof submitStudioBatch>[5], additionalInputCharacters = 0): Promise<PreparedImageQuoteResult> {
  const prepared: Prisma.ImageStudioTaskUncheckedCreateInput[] = [];
  await submitStudioBatch(owner, { ...body, billingQuoteId: undefined, maxEstimatedCost: undefined }, avatar,
    { batchItem: additionalInputCharacters > 0, save: async (_tx, data) => { prepared.push(data); } }, canvasUse, canvasPrompt);
  if (!prepared.length) throw new StudioError('本次提交已存在，请直接查询生成记录', 409);

  const task = prepared[0];
  const base = parseImageBillingContract(String(task.billing_contract_json));
  if (!base) throw new Error('Billing snapshot missing');
  let taskSnapshot: Record<string, unknown>;
  try { taskSnapshot = JSON.parse(String(task.snapshot_json)) as Record<string, unknown>; }
  catch { throw new StudioError('图片报价快照无效，请重新报价', 409); }
  const sharedLive = parseSharedStudioIntent(taskSnapshot.sharedLive);
  if (prepared.some(item => !sameSharedStudioIntent(sharedLive, parseSharedStudioIntent(JSON.parse(String(item.snapshot_json)).sharedLive)))) {
    throw new StudioError('模板已更新，请确认本次生成', 409);
  }
  const sharedResult = sharedLive ? { sharedLive } : {};
  const confirmDefinition = async () => {
    if (sharedLive) await prisma.$transaction(tx => resolveOwnedStudioTaskSharedUse(owner,
      typeof body.moduleId === 'string' ? body.moduleId : undefined, sharedLive, tx));
  };
  const imageChannel = imageChannelFromPreparedTask(task)
    || await captureImageGenerationChannel(base.model, 'original');
  const requestedChannelId = imageChannel?.channelId
    || (typeof body.channelId === 'string' && body.channelId !== 'original' ? body.channelId : undefined);
  const settings = (await withImagePricing(await resolveQuoteSettings(base.model, imageChannel, requestedChannelId), base.model, prisma, base)).settings;
  const quoteSpecifications = { quality: String(task.quality),
    resolution: typeof taskSnapshot.resolution === 'string' ? taskSnapshot.resolution : undefined,
    ratio: typeof taskSnapshot.aspectRatio === 'string' ? taskSnapshot.aspectRatio : undefined };
  const confirmPricing = async () => {
    const fresh = await withImagePricing(await resolveQuoteSettings(base.model, imageChannel, requestedChannelId),
      base.model, prisma, undefined, quoteSpecifications);
    if (!samePricingImageCharge(fresh.quote?.charge, base.pricing)) {
      throw new StudioError('图片规格或收费规则在准备期间已变化，请重新报价；尚未生成', 409);
    }
  };
  let scope: string;
  try { scope = imageBillingScope(settings); }
  catch { throw new StudioError('当前图片通道缺少有效的账单范围，暂不能报价', 409); }
  if (scope !== base.scope) throw new StudioError('图片通道或私有账单范围已变化，请重新获取报价', 409);

  const pinnedChannel = isPinnedChannelId(requestedChannelId || imageChannel?.channelId);
  const capability = pinnedChannel
    ? settings.modelCapabilities[base.model as keyof typeof settings.modelCapabilities]
    : undefined;
  const fixedResult = async (): Promise<PreparedImageQuoteResult> => {
    await confirmDefinition();
    await confirmPricing();
    let billingQuoteId: string | null = null;
    if (base.pricing) {
      billingQuoteId = randomUUID();
      const quote: StoredImageQuote = { owner, count: prepared.length, fingerprint: base.specification,
        intentRevision: 0, contract: base, ...sharedResult, ...(imageChannel ? { imageChannel } : {}) };
      await prisma.platformSetting.create({ data: { key: imageQuoteKey(owner, billingQuoteId), value_json: JSON.stringify(quote), updated_by: owner } });
    }
    return { ...sharedResult, billingMode: 'fixed', billingQuoteId, unitCredits: base.authorizedCredits,
      estimatedCredits: sumCredits(prepared.map(() => base.authorizedCredits)), revision: body.revision,
      expiresAt: base.expiresAt, actualChargeEnabled: false,
      ...(base.pricing ? { pricingRevision: base.pricing.revision, creditPrecision: base.pricing.mode === 'legacy_fixed' ? 0.01 : 0.1 } : {}),
      ...(imageChannel ? { imageChannel: publicImageChannel(imageChannel) } : {}) };
  };
  if (pinnedChannel) {
    assertImageChannelPairMatches(imageChannel, requestedChannelId || imageChannel?.channelId || '');
    for (const preparedTask of prepared) {
      const preparedChannel = imageChannelFromPreparedTask(preparedTask);
      if (!preparedChannel || preparedChannel.channelId !== imageChannel.channelId
        || preparedChannel.configRevision !== imageChannel.configRevision) {
        throw new StudioError('同一报价中的任务未固定到相同图片通道修订，未报价', 409);
      }
      const preparedContract = parseImageBillingContract(String(preparedTask.billing_contract_json));
      if (!preparedContract || preparedContract.scope !== base.scope || preparedContract.model !== base.model
        || !samePricingImageCharge(preparedContract.pricing, base.pricing)) {
        throw new StudioError('同一报价中的任务账单范围不一致，未报价', 409);
      }
    }
  }
  if (pinnedChannel && (!capability || !capability.enabled || !capability.billingMode)) {
    throw new StudioError('当前图片通道没有明确的型号计费能力，不能报价', 409);
  }

  if (pinnedChannel && capability?.billingMode === 'fixed') {
    if (capability.fixedPoints === null || !base.pricing && !Number.isSafeInteger(capability.fixedPoints) || capability.fixedPoints < 0
      || !base.pricing && base.authorizedCredits !== capability.fixedPoints) {
      throw new StudioError('固定点数已变化，请重新获取报价', 409);
    }
    return fixedResult();
  }

  const state = await imageBillingReady(base.scope, base.model);
  if (pinnedChannel && capability?.billingMode === 'actual') {
    if (!isMuskImageGenerationChannel(settings) || !imageChannel
      || new URL(settings.base_url).origin !== 'https://api.muskapis.com') {
      throw new StudioError('该图片通道没有可验证的同范围实际计费来源，未生成报价', 409);
    }
    if (!capability.actualQuoteRequired || !state.ready) {
      throw new StudioError('同一 API Key 与型号尚无有效账单证明，未生成报价', 409);
    }
  } else if (!state.ready) {
    // The original channel keeps its previous fixed-contract behavior when
    // no exact same-scope billing intent is available.
    return fixedResult();
  }

  const references = Array.isArray(taskSnapshot.referenceImages)
    ? taskSnapshot.referenceImages as Array<{ width?: number; height?: number }>
    : [];
  // Missing dimensions use the existing decoder's 40MP limit as a broad
  // allowance, not as a claim about the source image's actual dimensions.
  const referencePixels = references.reduce((sum, reference) => sum + (reference.width && reference.height
    ? reference.width * reference.height : 40_000_000), 0);
  const rows = await readImageSupplierBills(settings, base.scope);
  const historicalEstimate = supplierHistoryEstimate(rows, base.model,
    { inputCharacters: Math.max(...prepared.map(item => String(item.context).length + String(item.prompt).length)) + additionalInputCharacters, referencePixels });
  const specifications = prepared.map(item => ({ model: base.model, quality: item.quality, output_size: item.output_size,
    aspect_ratio: item.aspect_ratio, reference_ids: String(item.reference_ids), context: String(item.context), prompt: String(item.prompt) }));
  const group = imageCostGroup(specifications[0]);
  const sameGroup = !!group && specifications.every(item => imageCostGroup(item) === group);
  const estimate = historicalEstimate?.source !== 'provider_rule' && additionalInputCharacters === 0 && sameGroup
    ? await exactSpecificationEstimate(base.scope, specifications[0], rows) : null;
  const selectedEstimate = estimate || historicalEstimate;
  if (!selectedEstimate) {
    throw new StudioError(pinnedChannel
      ? '实际计费价格依据不足或已过期，本次不报价也不生成；请核实同一供应商的账单价格依据后重试'
      : '当前模型价格依据不足或已过期，本次尚未报价或生成；请更新价格依据，或由管理员关闭实际计费后继续使用原固定合同', 409);
  }

  const finalState = await imageBillingReady(base.scope, base.model);
  if (!finalState.ready || finalState.intentRevision !== state.intentRevision) {
    throw new StudioError('实际计费证明或设置在报价期间发生变化，请重新获取报价', 409);
  }
  if (pinnedChannel && imageChannel) {
    try {
      const current = await resolveImageGenerationChannelSnapshot(imageChannel, undefined, true, base.model);
      if (imageBillingScope(current) !== base.scope) throw new Error('scope_changed');
    } catch {
      throw new StudioError('图片通道在报价期间已变化，请重新获取报价', 409);
    }
  }

  const now = Date.now();
  await confirmDefinition();
  await confirmPricing();
  const authorizedCredits = base.pricing ? frozenPricingReservation(base.pricing, selectedEstimate.credits) : selectedEstimate.credits;
  const contract: ImageBillingContract = { ...base, mode: 'actual', authorizedCredits,
    issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60000).toISOString(),
    deadline: new Date(now + 48 * 3600000).toISOString(), estimateSource: selectedEstimate.source, estimateVersion: selectedEstimate.version };
  const id = randomUUID();
  const quote: StoredImageQuote & { imageChannel?: ImageGenerationChannelSnapshot } = {
    owner, count: prepared.length, fingerprint: base.specification,
    intentRevision: state.intentRevision, contract, ...sharedResult, ...(imageChannel ? { imageChannel } : {}),
  };
  await prisma.platformSetting.deleteMany({ where: { key: { startsWith: `image_billing_quote_v1:${owner}:` },
    created_at: { lt: new Date(now - 120000) } } });
  await prisma.platformSetting.create({ data: { key: imageQuoteKey(owner, id), value_json: JSON.stringify(quote), updated_by: owner } });
  return { ...sharedResult, billingMode: 'actual', billingQuoteId: id, unitCredits: authorizedCredits,
    estimatedCredits: sumCredits(prepared.map(() => authorizedCredits)), expiresAt: contract.expiresAt, revision: body.revision,
    actualChargeEnabled: true, ...(imageChannel ? { imageChannel: publicImageChannel(imageChannel) } : {}),
    estimate: { source: selectedEstimate.source, confidence: selectedEstimate.confidence,
      samples: selectedEstimate.samples, calibrated: false, assumption: selectedEstimate.assumption },
    ...(base.pricing ? { pricingRevision: base.pricing.revision } : { pointsPerUsd: 35 }),
    multiplier: 1, creditPrecision: base.pricing && base.pricing.mode !== 'legacy_actual' ? 0.1 : 0.01, authorizedMaximumCredits: sumCredits(prepared.map(() => authorizedCredits)) };
}
