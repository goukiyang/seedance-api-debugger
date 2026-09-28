import type { VideoDuration } from '@/types';

export type SeedanceVideoModelOption = {
  id: string;
  label: string;
  detail: string;
  internal_credit_multiplier?: number;
  durations?: VideoDuration[];
};

export const SEEDANCE_2_0_MODEL_ID = 'dreamina-seedance-2-0-260128';
export const SEEDANCE_2_5_MODEL_ID = 'dreamina-seedance-2-5-260628';
export const DEFAULT_SEEDANCE_VIDEO_MODEL_ID = SEEDANCE_2_0_MODEL_ID;

// Official model capability, not a reference-media or edit-pilot duration limit.
// https://seed.bytedance.com/zh/seedance2_5 (verified 2026-09-28)
export function seedanceVideoMaxDuration(model?: string | null): number {
  return model === SEEDANCE_2_5_MODEL_ID ? 30 : 15;
}

export function seedanceVideoDurationOptions(model?: string | null): VideoDuration[] {
  return Array.from({ length: seedanceVideoMaxDuration(model) - 3 }, (_, index) => (index + 4) as VideoDuration);
}

export function isSeedanceVideoDuration(value: unknown, model?: string | null): value is VideoDuration {
  return typeof value === 'number' && Number.isInteger(value) && value >= 4 && value <= seedanceVideoMaxDuration(model);
}

export function seedanceVideoDurationError(model?: string | null): string {
  return `当前模型时长须为 4–${seedanceVideoMaxDuration(model)} 秒的整数，请重新选择时长。`;
}

export function seedanceVideoDurationCapabilities() {
  return Object.fromEntries(SEEDANCE_VIDEO_MODEL_OPTIONS.map(({ id }) => [id, seedanceVideoDurationOptions(id)]));
}

export function seedanceRatioFollowsFirstFrame(model: string | null | undefined, mode: string): boolean {
  return model === SEEDANCE_2_5_MODEL_ID && mode === 'first_last_frame';
}

export const SEEDANCE_VIDEO_MODEL_OPTIONS: SeedanceVideoModelOption[] = [
  {
    id: SEEDANCE_2_0_MODEL_ID,
    label: 'Seedance 2.0',
    detail: '当前稳定默认模型',
    internal_credit_multiplier: 1.0,
  },
  {
    id: SEEDANCE_2_5_MODEL_ID,
    label: 'Seedance 2.5',
    detail: '新一代视频模型',
    internal_credit_multiplier: 1.5,
  },
];

const MODEL_IDS = new Set(SEEDANCE_VIDEO_MODEL_OPTIONS.map((option) => option.id));

function findSeedanceVideoModelOption(value: string | null | undefined): SeedanceVideoModelOption | null {
  const requested = typeof value === 'string' ? value.trim() : '';
  if (!requested) {
    return SEEDANCE_VIDEO_MODEL_OPTIONS.find((option) => option.id === DEFAULT_SEEDANCE_VIDEO_MODEL_ID) || null;
  }
  const normalized = requested.toLowerCase();
  return SEEDANCE_VIDEO_MODEL_OPTIONS.find((option) => (
    option.id === requested
    || option.label.toLowerCase() === normalized
  )) || null;
}

export function isSeedanceVideoModelId(value: string): boolean {
  return MODEL_IDS.has(value);
}

export function seedanceVideoModelLabel(modelId: string): string {
  return SEEDANCE_VIDEO_MODEL_OPTIONS.find((option) => option.id === modelId)?.label || modelId;
}

export function seedanceVideoModelPricingLabel(value: string | null | undefined): string {
  const option = findSeedanceVideoModelOption(value);
  if (option) return option.label;
  return typeof value === 'string' && value.trim() ? value.trim() : seedanceVideoModelLabel(DEFAULT_SEEDANCE_VIDEO_MODEL_ID);
}

export function seedanceVideoModelInternalMultiplier(value: string | null | undefined): number {
  const option = findSeedanceVideoModelOption(value);
  if (!option) {
    return seedanceVideoModelInternalMultiplier(DEFAULT_SEEDANCE_VIDEO_MODEL_ID);
  }
  return option.internal_credit_multiplier ?? 1.0;
}

export function parseSeedanceVideoModel(value: unknown): {
  ok: true;
  model: string;
} | {
  ok: false;
  message: string;
} {
  const requested = typeof value === 'string' ? value.trim() : '';
  if (!requested) {
    return { ok: true, model: DEFAULT_SEEDANCE_VIDEO_MODEL_ID };
  }
  if (isSeedanceVideoModelId(requested)) {
    return { ok: true, model: requested };
  }
  return {
    ok: false,
    message: `model 必须是 ${SEEDANCE_VIDEO_MODEL_OPTIONS.map((option) => option.id).join(', ')}`,
  };
}

export function resolveSeedanceVideoModel(value: unknown): string {
  const parsed = parseSeedanceVideoModel(value);
  return parsed.ok ? parsed.model : DEFAULT_SEEDANCE_VIDEO_MODEL_ID;
}
