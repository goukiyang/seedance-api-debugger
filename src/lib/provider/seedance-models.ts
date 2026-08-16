export type SeedanceVideoModelOption = {
  id: string;
  label: string;
  detail: string;
  internal_credit_multiplier?: number;
};

export const SEEDANCE_2_0_MODEL_ID = 'dreamina-seedance-2-0-260128';
export const SEEDANCE_2_5_MODEL_ID = 'dreamina-seedance-2-5-260628';
export const DEFAULT_SEEDANCE_VIDEO_MODEL_ID = SEEDANCE_2_0_MODEL_ID;

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
