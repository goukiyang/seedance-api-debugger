import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { calculateEstimatedCost, calculateH3EstimatedCost, calculateEnhanceVideoEstimatedCost, type PricingSnapshot } from '@/lib/pricing';
import { quotePricingCharge, assertNewPricingCharge, PricingChargeError, type FrozenPricingCharge } from './charge';
import { normalizeDecimal, multiplyDecimal } from './math';
import { normalizeCredits } from '@/lib/credits/precision';
import { isSeedanceVideoDuration } from '@/lib/provider/seedance-models';
import type { PricingAdminIdentity } from './admin-contract';

type Client = Prisma.TransactionClient | typeof prisma;
export type VideoPricingInput = { provider: 'seedance' | 'volcengine_ip' | 'volcengine_ark' | 'h3' | 'volcengine_mediakit';
  model: string; resolution: string; duration: number; toolVersion?: string; fps?: number | null };
export type VideoPricingQuote = { identity: PricingAdminIdentity; quantity: string; pricing: PricingSnapshot;
  revision: string | null; charge: FrozenPricingCharge | null };

export function videoPricingIdentity(input: VideoPricingInput): PricingAdminIdentity {
  if (input.provider === 'volcengine_mediakit') return { kind: 'enhance', channelId: 'volcengine_mediakit', modelId: 'enhance-video',
    billingMode: 'fixed', unit: 'second', specifications: { resolution: ['240p', '360p', '480p', '540p'].includes(input.resolution) ? '480p' : input.resolution,
      toolVersion: input.toolVersion || 'standard', fpsTier: input.fps && input.fps > 30 ? 'gt30' : 'lte30' } };
  if (input.provider === 'h3') return { kind: 'h3', channelId: 'h3', modelId: input.model, billingMode: 'fixed', unit: 'second', specifications: {} };
  return { kind: 'video', channelId: input.provider === 'volcengine_ip' ? 'volcengine_ark' : input.provider,
    modelId: input.model, billingMode: 'fixed', unit: 'second', specifications: { resolution: input.resolution } };
}

export async function quoteVideoPricing(input: VideoPricingInput, client: Client = prisma): Promise<VideoPricingQuote> {
  if (!Number.isFinite(input.duration) || input.duration <= 0 || input.duration > 3600) throw new PricingChargeError('视频时长无法安全报价，原输入未改变');
  if (input.provider !== 'volcengine_mediakit' && input.provider !== 'h3' && !isSeedanceVideoDuration(input.duration, input.model)) throw new PricingChargeError('当前型号不支持所选时长，原选择未改变');
  const legacy = input.provider === 'volcengine_mediakit' ? calculateEnhanceVideoEstimatedCost({ duration: input.duration,
    resolution: input.resolution, toolVersion: input.toolVersion || 'standard', fps: input.fps })
    : input.provider === 'h3' ? calculateH3EstimatedCost(input.duration, input.model)
      : calculateEstimatedCost(input.resolution, input.duration, input.model);
  const identity = videoPricingIdentity(input);
  const quantity = normalizeDecimal(String(identity.kind === 'enhance' || identity.kind === 'h3' ? Math.max(1, Math.ceil(input.duration)) : input.duration),
    { maxScale: 8, min: '0', max: '3600', allowZero: false });
  const current = await quotePricingCharge(identity, quantity, client);
  if (!current) return { identity, quantity, pricing: legacy, revision: null, charge: null };
  if (current.credits === null) throw new PricingChargeError('视频固定收费合同缺少明确金额，未受理');
  const amount = normalizeCredits(current.credits);
  const unitPoints = current.charge.mode === 'free' ? 0
    : Number(current.charge.mode === 'legacy_fixed' ? current.charge.legacyUnitCredits
      : multiplyDecimal([current.charge.baseCny!, current.charge.pointsPerCny!]));
  const pricing: PricingSnapshot = { ...legacy, estimatedCost: amount, baseCostPerSecond: unitPoints,
    internalMultiplier: 1, finalCostPerSecond: unitPoints,
    formula: current.charge.mode === 'free' ? 'explicit_free = 0' : `${current.exactCredits} → ${amount}`,
    pricingRuleId: current.charge.ruleId, pricingRuleVersion: 1, pricingPolicyRevision: current.charge.revision, pricingCharge: current.charge };
  return { identity, quantity, pricing, revision: current.charge.revision, charge: current.charge };
}

export function requireVideoPricingRevision(quote: VideoPricingQuote, expectedRevision: unknown) {
  if (quote.charge && expectedRevision !== quote.revision) throw new PricingChargeError();
}
export async function assertVideoPricingAcceptance(quote: VideoPricingQuote, expectedRevision: unknown, client: Client) {
  requireVideoPricingRevision(quote, expectedRevision);
  if (quote.charge) { await assertNewPricingCharge(quote.charge, expectedRevision, client); return; }
  if (await quotePricingCharge(quote.identity, quote.quantity, client)) throw new PricingChargeError();
}
export function publicVideoPricing(quote: VideoPricingQuote) {
  const { pricingCharge: _privateCharge, ...pricing } = quote.pricing;
  return { ...pricing, pricing_revision: quote.revision, policyApplied: quote.charge !== null };
}
export function publicVideoTaskPricing<T extends object>(task: T): T {
  if (!('pricing_snapshot' in task) || typeof task.pricing_snapshot !== 'string') return task;
  try {
    const value = JSON.parse(task.pricing_snapshot);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...task, pricing_snapshot: null };
    const { pricingCharge: _privateCharge, ...visible } = value;
    return { ...task, pricing_snapshot: JSON.stringify(visible) };
  } catch { return { ...task, pricing_snapshot: null }; }
}
export function videoPricingError(error: unknown): { message: string; status: number; code: string } | null {
  if (!error || typeof error !== 'object' || !('code' in error) || typeof error.code !== 'string' || !error.code.startsWith('pricing_')) return null;
  return { message: error instanceof Error ? error.message : '报价暂时无法确认，参数和素材已保留',
    status: 'status' in error && typeof error.status === 'number' ? error.status : 409, code: error.code };
}
