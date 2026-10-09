import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getImageGenerationSettingsForModel } from '@/lib/integrations/image-generation';
import { submitStudioBatch, StudioError } from './tasks';
import { parseImageBillingContract, type ImageBillingContract } from './billing-contract';
import { imageBillingReady } from './billing-readiness';
import { readImageSupplierBills } from './billing-provider';
import { supplierHistoryEstimate } from './billing-quote';
import { exactSpecificationEstimate, imageCostGroup } from './billing-calibration';
import { imageQuoteKey, type StoredImageQuote } from './billing-quote-store';

export async function prepareImageBillingQuote(owner: string, body: Record<string, unknown>, avatar?: Parameters<typeof submitStudioBatch>[2],
  canvasUse?: Parameters<typeof submitStudioBatch>[4], canvasPrompt?: Parameters<typeof submitStudioBatch>[5], additionalInputCharacters = 0) {
  const prepared: Prisma.ImageStudioTaskUncheckedCreateInput[] = [];
  await submitStudioBatch(owner, { ...body, billingQuoteId: undefined, maxEstimatedCost: undefined }, avatar,
    { save: async (_tx, data) => { prepared.push(data); } }, canvasUse, canvasPrompt);
  if (!prepared.length) throw new StudioError('本次提交已存在，请直接查询生成记录', 409);
  const task = prepared[0];
  const base = parseImageBillingContract(String(task.billing_contract_json));
  if (!base) throw new Error('Billing snapshot missing');
  const state = await imageBillingReady(base.scope, base.model);
  if (!state.ready) return { billingMode: 'fixed', billingQuoteId: null, unitCredits: base.authorizedCredits,
    estimatedCredits: base.authorizedCredits * prepared.length, revision: body.revision,
    expiresAt: base.expiresAt, actualChargeEnabled: false };
  const snapshot = JSON.parse(String(task.snapshot_json));
  const references = snapshot.referenceImages as Array<{ width?: number; height?: number }>;
  // Missing historical dimensions use the existing decoder's 40MP limit as
  // a broad input allowance, not a claim about the asset's actual dimensions.
  const referencePixels = references.reduce((sum, reference) => sum + (reference.width && reference.height
    ? reference.width * reference.height : 40_000_000), 0);
  const settings = await getImageGenerationSettingsForModel(base.model);
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
  if (!selectedEstimate) throw new StudioError('当前模型价格依据不足或已过期，本次尚未报价或生成；请更新价格依据，或由管理员关闭实际计费后继续使用原固定合同', 409);
  const now = Date.now();
  const contract: ImageBillingContract = { ...base, mode: 'actual', authorizedCredits: selectedEstimate.credits,
    issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60000).toISOString(),
    deadline: new Date(now + 48 * 3600000).toISOString(), estimateSource: selectedEstimate.source, estimateVersion: selectedEstimate.version };
  const id = randomUUID();
  const quote: StoredImageQuote = { owner, count: prepared.length, fingerprint: base.specification,
    intentRevision: state.intentRevision, contract };
  await prisma.platformSetting.deleteMany({ where: { key: { startsWith: `image_billing_quote_v1:${owner}:` },
    created_at: { lt: new Date(now - 120000) } } });
  await prisma.platformSetting.create({ data: { key: imageQuoteKey(owner, id), value_json: JSON.stringify(quote), updated_by: owner } });
  return { billingMode: 'actual', billingQuoteId: id, unitCredits: selectedEstimate.credits,
    estimatedCredits: selectedEstimate.credits * prepared.length, expiresAt: contract.expiresAt, revision: body.revision,
    actualChargeEnabled: true, estimate: { source: selectedEstimate.source, confidence: selectedEstimate.confidence,
      samples: selectedEstimate.samples, calibrated: false, assumption: selectedEstimate.assumption },
    pointsPerUsd: 35, multiplier: 1, creditPrecision: 0.01, authorizedMaximumCredits: selectedEstimate.credits * prepared.length };
}
