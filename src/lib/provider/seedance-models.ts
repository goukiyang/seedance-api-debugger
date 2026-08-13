export type SeedanceVideoModelOption = {
  id: string;
  label: string;
  detail: string;
};

export const SEEDANCE_2_0_MODEL_ID = 'dreamina-seedance-2-0-260128';
export const SEEDANCE_2_5_MODEL_ID = 'dreamina-seedance-2-5-260628';
export const DEFAULT_SEEDANCE_VIDEO_MODEL_ID = SEEDANCE_2_0_MODEL_ID;

export const SEEDANCE_VIDEO_MODEL_OPTIONS: SeedanceVideoModelOption[] = [
  {
    id: SEEDANCE_2_0_MODEL_ID,
    label: 'Seedance 2.0',
    detail: '当前稳定默认模型',
  },
  {
    id: SEEDANCE_2_5_MODEL_ID,
    label: 'Seedance 2.5',
    detail: '新一代视频模型',
  },
];

const MODEL_IDS = new Set(SEEDANCE_VIDEO_MODEL_OPTIONS.map((option) => option.id));

export function isSeedanceVideoModelId(value: string): boolean {
  return MODEL_IDS.has(value);
}

export function seedanceVideoModelLabel(modelId: string): string {
  return SEEDANCE_VIDEO_MODEL_OPTIONS.find((option) => option.id === modelId)?.label || modelId;
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
