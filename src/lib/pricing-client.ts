import { seedanceVideoModelInternalMultiplier } from './provider/seedance-models';
import { normalizeCredits } from './credits/precision';

export type VideoPricingRequest = { provider: string; model: string; resolution: string; duration: number; toolVersion?: string; fps?: number | null };
export type PublicVideoPricing = { estimatedCost: number; pricing_revision: string | null; policyApplied: boolean };
export function validVideoPricingAmount(value: unknown): value is number {
  if (typeof value !== 'number' || value < 0 || value > 10000000) return false;
  try { normalizeCredits(value); return true; } catch { return false; }
}
export async function requestVideoPricing(input: VideoPricingRequest, signal?: AbortSignal, actorId?: string): Promise<PublicVideoPricing> {
  const params = new URLSearchParams({ provider: input.provider, model: input.model, resolution: input.resolution, duration: String(input.duration) });
  if (input.toolVersion) params.set('tool_version', input.toolVersion);
  if (input.fps !== undefined && input.fps !== null) params.set('fps', String(input.fps));
  const response = await fetch(`/api/tasks/estimate?${params}`, { cache: 'no-store', signal,
    headers: actorId ? { 'x-app-session-user': actorId } : {} });
  const data = await response.json();
  if (!response.ok || !validVideoPricingAmount(data.estimatedCost)
    || data.pricing_revision !== null && typeof data.pricing_revision !== 'string') throw new Error(data.message || data.error || '报价暂不可用，请重新报价');
  return { estimatedCost: data.estimatedCost, pricing_revision: data.pricing_revision, policyApplied: data.policyApplied === true };
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
