import type { GenerationMode, VideoDuration, VideoRatio, VideoResolution } from '@/types';
import { RATIO_OPTIONS, RESOLUTION_OPTIONS } from '@/types';
import { isVolcengineIpModelId } from '@/lib/integrations/volcengine-ip-models';
import { isSeedanceVideoDuration, isSeedanceVideoModelId } from '@/lib/provider/seedance-models';

export const GENERATION_DEFAULTS_PREFERENCE_KEY = 'generation_defaults_v1';
const IP_GENERATION_DEFAULTS_PREFERENCE_KEY = 'generation_defaults_ip_v1';

export type GenerationSurface = 'normal' | 'ip';

export type GenerationSeedMode = 'random';

export type GenerationDefaults = {
  model?: string | null;
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
  model?: unknown;
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
  model: null,
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

export function generationDefaultsPreferenceKey(surface: GenerationSurface = 'normal'): string {
  return surface === 'ip' ? IP_GENERATION_DEFAULTS_PREFERENCE_KEY : GENERATION_DEFAULTS_PREFERENCE_KEY;
}

function isGenerationSurface(value: unknown): value is GenerationSurface {
  return value === 'ip' || value === 'normal';
}

function isModelForSurface(value: unknown, surface: GenerationSurface): value is string {
  if (typeof value !== 'string') return false;
  if (surface === 'ip') return isVolcengineIpModelId(value);
  return isSeedanceVideoModelId(value);
}

function isGenerationMode(value: unknown): value is GenerationMode {
  return typeof value === 'string' && GENERATION_MODES.includes(value as GenerationMode);
}

function isVideoRatio(value: unknown): value is VideoRatio {
  return typeof value === 'string' && RATIO_OPTIONS.includes(value as VideoRatio);
}

function isVideoResolution(value: unknown): value is VideoResolution {
  return typeof value === 'string' && RESOLUTION_OPTIONS.includes(value as VideoResolution);
}

function optionalProjectId(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function normalizeGenerationDefaults(
  value: unknown,
  surface: GenerationSurface = 'normal',
): GenerationDefaults {
  const normalizedSurface = isGenerationSurface(surface) ? surface : 'normal';
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};

  const generationMode = record.generationMode ?? record.generation_mode;
  const generateAudio = record.generateAudio ?? record.generate_audio;
  const returnLastFrame = record.returnLastFrame ?? record.return_last_frame;
  const seedMode = record.seedMode ?? record.seed_mode;
  const projectId = record.projectId ?? record.project_id;
  const model = isModelForSurface(record.model, normalizedSurface)
    ? record.model
    : null;

  return {
    model,
    generationMode: isGenerationMode(generationMode)
      ? generationMode
      : DEFAULT_GENERATION_DEFAULTS.generationMode,
    ratio: isVideoRatio(record.ratio) ? record.ratio : DEFAULT_GENERATION_DEFAULTS.ratio,
    duration: isSeedanceVideoDuration(record.duration, model) ? record.duration : DEFAULT_GENERATION_DEFAULTS.duration,
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

export function parseStoredGenerationDefaults(
  valueJson: string | null | undefined,
  surface: GenerationSurface = 'normal',
) {
  if (!valueJson) return null;
  try {
    return normalizeGenerationDefaults(JSON.parse(valueJson), surface);
  } catch {
    return null;
  }
}

export function serializeGenerationDefaults(
  settings: GenerationDefaults,
  surface: GenerationSurface = 'normal',
): string {
  const normalized = normalizeGenerationDefaults(settings, surface);
  const stored: StoredGenerationDefaults = {
    model: normalized.model,
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
