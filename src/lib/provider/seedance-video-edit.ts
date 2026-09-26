import type { CreateVideoInput } from '@/types';
import { SEEDANCE_2_5_MODEL_ID } from './seedance-models';

/** Internal evidence from the existing server-side media probe, never request metadata. */
export type SeedanceEditReference = {
  url: string;
  width: number;
  height: number;
  durationSeconds: number;
};

export function validateSeedanceEditMode(input: {
  taskType: unknown;
  provider: string;
  model: string;
  mode: string;
  draft?: boolean;
}): string | null {
  if (input.taskType === undefined) return null;
  if (input.taskType !== 'edit') return 'omni_reference_task_type 当前仅支持显式 edit；普通生成请省略此字段。';
  if (input.provider !== 'seedance' || input.model !== SEEDANCE_2_5_MODEL_ID) {
    return '视频编辑仅支持 Seedance 2.5。';
  }
  if (input.mode !== 'all_in_one_reference' || input.draft) {
    return '视频编辑须使用全能参考模式，不能与首尾帧、多帧或 Draft 混用。';
  }
  return null;
}

export function validateSeedanceEditReference(input: {
  urls: string[];
  reference: Partial<SeedanceEditReference> | null;
  duration: number;
  ratio: string;
}): string | null {
  if (input.urls.length !== 1) return '本次视频编辑仅支持一个待编辑视频，避免跟随对象不明确。';
  const ref = input.reference;
  if (!ref || ref.url !== input.urls[0]
    || !Number.isFinite(ref.durationSeconds) || !Number.isFinite(ref.width) || !Number.isFinite(ref.height)
    || !Number.isInteger(ref.width) || !Number.isInteger(ref.height) || ref.width! <= 0 || ref.height! <= 0) {
    return '无法确认待编辑视频的实际时长和尺寸，请重新上传或稍后重试。';
  }
  // Keep existing 4–15s business pricing/limits. Provider -1 is not a billable duration.
  if (ref.durationSeconds! < 4 || ref.durationSeconds! > 15
    || !Number.isInteger(input.duration) || input.duration < 4 || input.duration > 15) {
    return '当前平台视频编辑仅开放 4–15 秒的原视频。';
  }
  if (Math.ceil(ref.durationSeconds!) !== input.duration) {
    return '编辑时长必须与实际原视频向上取整后的秒数一致，不能用较短时长估费。';
  }
  const ratios: Record<string, [number, number]> = {
    '21:9': [21, 9], '16:9': [16, 9], '4:3': [4, 3],
    '1:1': [1, 1], '3:4': [3, 4], '9:16': [9, 16],
  };
  const pair = ratios[input.ratio];
  // Permit at most one pixel of encoder dimension rounding, not arbitrary cropping.
  if (!pair || Math.abs(ref.width! * pair[1] - ref.height! * pair[0]) > Math.max(...pair)) {
    return '编辑画幅跟随原视频，请选择与原视频一致的比例，不能绕过视频卡比例锁。';
  }
  return null;
}

/** Narrow provider-only override. Business input remains positive and unchanged. */
export function seedanceVideoEditParameters(input: CreateVideoInput): {
  omni_reference_task_type?: 'edit'; ratio?: 'adaptive'; duration?: -1;
} {
  if (input.omni_reference_task_type === undefined) return {};
  const modeError = validateSeedanceEditMode({
    taskType: input.omni_reference_task_type, provider: 'seedance',
    model: input.model || '', mode: input.generation_mode, draft: input.draft,
  });
  const refError = validateSeedanceEditReference({
    urls: input.reference_video_urls || [], reference: input.seedance_edit_reference || null,
    duration: input.duration ?? NaN, ratio: input.ratio || '',
  });
  if (modeError || refError) throw new Error(modeError || refError!);
  return { omni_reference_task_type: 'edit', ratio: 'adaptive', duration: -1 };
}
