import { SEEDANCE_2_5_IP_MODEL_ID, seedanceVideoDurationOptions } from '@/lib/provider/seedance-models';
import { seedanceReferenceMediaCapabilities } from '@/lib/provider/reference-media-policy';

export type VolcengineIpModelOption = {
  id: string;
  label: string;
  detail: string;
};

export const VOLCENGINE_IP_SEEDANCE_2_0_MODEL_ID = 'doubao-seedance-2-0-260128';
export const VOLCENGINE_IP_SEEDANCE_2_0_FAST_MODEL_ID = 'doubao-seedance-2-0-fast-260128';
export const VOLCENGINE_IP_SEEDANCE_2_0_MINI_MODEL_ID = 'doubao-seedance-2-0-mini-260615';

export const VOLCENGINE_IP_MODEL_OPTIONS: VolcengineIpModelOption[] = [
  {
    id: VOLCENGINE_IP_SEEDANCE_2_0_MODEL_ID,
    label: 'Seedance 2.0',
    detail: '480p / 720p / 1080p',
  },
  {
    id: VOLCENGINE_IP_SEEDANCE_2_0_FAST_MODEL_ID,
    label: 'Seedance 2.0 Fast',
    detail: '480p / 720p',
  },
  {
    id: VOLCENGINE_IP_SEEDANCE_2_0_MINI_MODEL_ID,
    label: 'Seedance 2.0 Mini',
    detail: '480p / 720p',
  },
  {
    id: SEEDANCE_2_5_IP_MODEL_ID,
    label: 'Seedance 2.5',
    detail: '4-30 秒 · 480p / 720p / 1080p',
  },
];

export function isVolcengineIpModelId(value: unknown): value is string {
  return typeof value === 'string' && VOLCENGINE_IP_MODEL_OPTIONS.some((option) => option.id === value);
}

export function volcengineIpModelResolutions(model: string): string[] {
  return [VOLCENGINE_IP_SEEDANCE_2_0_FAST_MODEL_ID, VOLCENGINE_IP_SEEDANCE_2_0_MINI_MODEL_ID].includes(model)
    ? ['480p', '720p']
    : ['480p', '720p', '1080p'];
}

export function volcengineIpModelLabel(model: string): string {
  return VOLCENGINE_IP_MODEL_OPTIONS.find((option) => option.id === model)?.label || model;
}

export function volcengineIpCapabilities() {
  return VOLCENGINE_IP_MODEL_OPTIONS.map((option) => ({
    ...option,
    durations: seedanceVideoDurationOptions(option.id),
    resolutions: volcengineIpModelResolutions(option.id),
    reference_media: seedanceReferenceMediaCapabilities(option.id),
    first_frame_ratio: option.id === SEEDANCE_2_5_IP_MODEL_ID ? 'adaptive' : 'selected',
    internal_credit_multiplier: option.id === SEEDANCE_2_5_IP_MODEL_ID ? 1.5 : 1,
  }));
}
