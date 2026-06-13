import type { GenerationMode, VideoDuration, VideoRatio, VideoResolution } from '@/types';

export const GENERATION_DRAFT_STORAGE_KEY = 'generation_composer_draft';
export const WORKSPACE_TAB_ID_STORAGE_KEY = 'workspace_tab_id';

export interface GenerationDraft {
  prompt: string;
  generationMode: GenerationMode;
  ratio: VideoRatio;
  duration: VideoDuration;
  resolution: VideoResolution;
  seed: number;
  generateAudio: boolean;
  returnLastFrame: boolean;
  watermark: boolean;
}

export type GenerationDraftPatch = Partial<GenerationDraft>;

export const DEFAULT_GENERATION_DRAFT: GenerationDraft = {
  prompt: '',
  generationMode: 'all_in_one_reference',
  ratio: '16:9',
  duration: 5,
  resolution: '480p',
  seed: -1,
  generateAudio: false,
  returnLastFrame: false,
  watermark: false,
};

export function sanitizeGenerationDraft(input: unknown): GenerationDraft {
  if (!input || typeof input !== 'object') {
    return { ...DEFAULT_GENERATION_DRAFT };
  }

  const value = input as Partial<GenerationDraft>;
  const generationMode = value.generationMode;
  const ratio = value.ratio;
  const duration = value.duration;
  const resolution = value.resolution;

  return {
    prompt: typeof value.prompt === 'string' ? value.prompt : DEFAULT_GENERATION_DRAFT.prompt,
    generationMode: generationMode === 'all_in_one_reference' || generationMode === 'first_last_frame' || generationMode === 'smart_multi_frame'
      ? generationMode
      : DEFAULT_GENERATION_DRAFT.generationMode,
    ratio: ratio === '21:9' || ratio === '16:9' || ratio === '4:3' || ratio === '1:1' || ratio === '3:4' || ratio === '9:16'
      ? ratio
      : DEFAULT_GENERATION_DRAFT.ratio,
    duration: typeof duration === 'number' && duration >= 4 && duration <= 15
      ? (duration as VideoDuration)
      : DEFAULT_GENERATION_DRAFT.duration,
    resolution: resolution === '480p' || resolution === '720p'
      ? resolution
      : DEFAULT_GENERATION_DRAFT.resolution,
    seed: typeof value.seed === 'number' ? value.seed : DEFAULT_GENERATION_DRAFT.seed,
    generateAudio: typeof value.generateAudio === 'boolean' ? value.generateAudio : DEFAULT_GENERATION_DRAFT.generateAudio,
    returnLastFrame: typeof value.returnLastFrame === 'boolean' ? value.returnLastFrame : DEFAULT_GENERATION_DRAFT.returnLastFrame,
    watermark: typeof value.watermark === 'boolean' ? value.watermark : DEFAULT_GENERATION_DRAFT.watermark,
  };
}
