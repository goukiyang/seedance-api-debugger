import { seedanceVideoModelInternalMultiplier } from './provider/seedance-models';
import { normalizeCredits } from './credits/precision';

export type VideoPricingRequest = { provider: string; model: string; resolution: string; duration: number; toolVersion?: string; fps?: number | null; context?: Record<string, unknown> };
export type PublicVideoPricing = { estimatedCost: number; pricing_revision: string | null; pricing_quote_token?: string; policyApplied: boolean };
export function videoPricingRequestKey(input: VideoPricingRequest, actorId?: string): string {
  return JSON.stringify({ owner: actorId, input });
}
export function videoPricingBusinessInput(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([key]) => ![
    'pricing_quote_token', 'pricing_revision', 'pricing_fingerprint_version',
  ].includes(key)));
}
export function requireVideoPricingWithinCeiling(quote: PublicVideoPricing, ceiling: unknown): PublicVideoPricing {
  if (!validVideoPricingAmount(ceiling) || !validVideoPricingAmount(quote.estimatedCost)
    || quote.estimatedCost > ceiling) throw new Error('报价已变化，请重新确认点数后生成；原授权上限未提高，尚未生成');
  return quote;
}
export function validVideoPricingAmount(value: unknown): value is number {
  if (typeof value !== 'number' || value < 0 || value > 10000000) return false;
  try { normalizeCredits(value); return true; } catch { return false; }
}
export async function requestVideoPricing(input: VideoPricingRequest, signal?: AbortSignal, actorId?: string): Promise<PublicVideoPricing> {
  const params = new URLSearchParams({ provider: input.provider, model: input.model, resolution: input.resolution, duration: String(input.duration) });
  if (input.toolVersion) params.set('tool_version', input.toolVersion);
  if (input.fps !== undefined && input.fps !== null) params.set('fps', String(input.fps));
  const response = await fetch(input.context ? '/api/tasks/estimate' : `/api/tasks/estimate?${params}`, { cache: 'no-store', signal,
    ...(input.context ? { method: 'POST', body: JSON.stringify({ ...input.context, provider: input.provider, model: input.model, resolution: input.resolution, duration: input.duration, tool_version: input.toolVersion, fps: input.fps }) } : {}),
    headers: { ...(input.context ? { 'Content-Type': 'application/json' } : {}), ...(actorId ? { 'x-app-session-user': actorId } : {}) } });
  const data = await response.json();
  if (!response.ok || !validVideoPricingAmount(data.estimatedCost)
    || data.pricing_revision !== null && typeof data.pricing_revision !== 'string'
    || data.pricing_quote_token !== undefined && (typeof data.pricing_quote_token !== 'string'
      || !data.pricing_quote_token || data.pricing_quote_token.length > 4096)) throw new Error(data.message || data.error || '报价暂不可用，请重新报价');
  return { estimatedCost: data.estimatedCost, pricing_revision: data.pricing_revision, ...(typeof data.pricing_quote_token === 'string' ? { pricing_quote_token: data.pricing_quote_token } : {}), policyApplied: data.policyApplied === true };
}
export function notifyVideoPricingChanged() { if (typeof window !== 'undefined') window.dispatchEvent(new Event('sd2:video-pricing-changed')); }

const SEEDANCE_VIDEO_COST_PER_SECOND = 3;

export function calculateEstimatedCostClient(
  resolution: string,
  duration: number,
  model?: string | null,
): number {
  void resolution;
  const internalMultiplier = seedanceVideoModelInternalMultiplier(model);
  return Math.ceil(SEEDANCE_VIDEO_COST_PER_SECOND * internalMultiplier * duration);
}

export function calculateEnhanceVideoEstimatedCostClient(input: {
  resolution: string;
  duration: number;
  toolVersion: string;
  fps?: number | null;
}): number {
  const duration = Math.max(1, Math.ceil(input.duration || 1));
  const resolutionBase = input.resolution === '4k'
    ? 24
    : input.resolution === '2k'
      ? 16
      : input.resolution === '1080p'
        ? 10
        : input.resolution === '720p'
          ? 7
          : 5;
  const toolMultiplier = input.toolVersion === 'professional' ? 1.5 : 1;
  const fpsMultiplier = input.fps && input.fps > 30 ? 1.2 : 1;
  return Math.ceil(resolutionBase * toolMultiplier * fpsMultiplier * duration);
}
