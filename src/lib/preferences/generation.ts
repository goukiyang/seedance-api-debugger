import type { GenerationMode, VideoDuration, VideoRatio, VideoResolution } from '@/types';
import { DURATION_OPTIONS, RATIO_OPTIONS, RESOLUTION_OPTIONS } from '@/types';

export const GENERATION_DEFAULTS_PREFERENCE_KEY = 'generation_defaults_v1';

export type GenerationSeedMode = 'random';

export type GenerationDefaults = {
  generationMode: GenerationMode;
  ratio: VideoRatio;
  duration: VideoDuration;
  resolution: VideoResolution;
  generateAudio: boolean;
  returnLastFrame: boolean;
  watermark: boolean;
  seedMode: GenerationSeedMode;
  projectId: string | null;
};

type StoredGenerationDefaults = {
  generation_mode?: unknown;
  ratio?: unknown;
  duration?: unknown;
  resolution?: unknown;
  generate_audio?: unknown;
  return_last_frame?: unknown;
  watermark?: unknown;
  seed_mode?: unknown;
  project_id?: unknown;
};

const GENERATION_MODES: GenerationMode[] = [
  'all_in_one_reference',
  'first_last_frame',
  'smart_multi_frame',
];

export const DEFAULT_GENERATION_DEFAULTS: GenerationDefaults = {
  generationMode: 'all_in_one_reference',
  ratio: '16:9',
  duration: 5,
  resolution: '480p',
  generateAudio: true,
  returnLastFrame: false,
  watermark: false,
  seedMode: 'random',
  projectId: null,
};

function isGenerationMode(value: unknown): value is GenerationMode {
  return typeof value === 'string' && GENERATION_MODES.includes(value as GenerationMode);
}

function isVideoRatio(value: unknown): value is VideoRatio {
  return typeof value === 'string' && RATIO_OPTIONS.includes(value as VideoRatio);
}

function isVideoDuration(value: unknown): value is VideoDuration {
  return typeof value === 'number' && DURATION_OPTIONS.includes(value as VideoDuration);
}

function isVideoResolution(value: unknown): value is VideoResolution {
  return typeof value === 'string' && RESOLUTION_OPTIONS.includes(value as VideoResolution);
}

function optionalProjectId(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function normalizeGenerationDefaults(value: unknown): GenerationDefaults {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};

  const generationMode = record.generationMode ?? record.generation_mode;
  const generateAudio = record.generateAudio ?? record.generate_audio;
  const returnLastFrame = record.returnLastFrame ?? record.return_last_frame;
  const seedMode = record.seedMode ?? record.seed_mode;
  const projectId = record.projectId ?? record.project_id;

  return {
    generationMode: isGenerationMode(generationMode)
      ? generationMode
      : DEFAULT_GENERATION_DEFAULTS.generationMode,
    ratio: isVideoRatio(record.ratio) ? record.ratio : DEFAULT_GENERATION_DEFAULTS.ratio,
    duration: isVideoDuration(record.duration) ? record.duration : DEFAULT_GENERATION_DEFAULTS.duration,
    resolution: isVideoResolution(record.resolution) ? record.resolution : DEFAULT_GENERATION_DEFAULTS.resolution,
    generateAudio: typeof generateAudio === 'boolean' ? generateAudio : DEFAULT_GENERATION_DEFAULTS.generateAudio,
    returnLastFrame: typeof returnLastFrame === 'boolean'
      ? returnLastFrame
      : DEFAULT_GENERATION_DEFAULTS.returnLastFrame,
    watermark: typeof record.watermark === 'boolean' ? record.watermark : DEFAULT_GENERATION_DEFAULTS.watermark,
    seedMode: seedMode === 'random' ? 'random' : DEFAULT_GENERATION_DEFAULTS.seedMode,
    projectId: optionalProjectId(projectId),
  };
}

export function parseStoredGenerationDefaults(valueJson: string | null | undefined) {
  if (!valueJson) return null;
  try {
    return normalizeGenerationDefaults(JSON.parse(valueJson));
  } catch {
    return null;
  }
}

export function serializeGenerationDefaults(settings: GenerationDefaults): string {
  const normalized = normalizeGenerationDefaults(settings);
  const stored: StoredGenerationDefaults = {
    generation_mode: normalized.generationMode,
    ratio: normalized.ratio,
    duration: normalized.duration,
    resolution: normalized.resolution,
    generate_audio: normalized.generateAudio,
    return_last_frame: normalized.returnLastFrame,
    watermark: normalized.watermark,
    seed_mode: normalized.seedMode,
    project_id: normalized.projectId,
  };
  return JSON.stringify(stored);
}
