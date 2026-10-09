import { IMAGE_STUDIO_MODELS, IMAGE_STUDIO_MODEL_QUALITY_OPTIONS, IMAGE_STUDIO_MODEL_RESOLUTION_OPTIONS,
  defaultImageStudioQuality, defaultImageResolution, type ImageStudioModel, type ImageStudioQuality, type ImageResolution } from './model-catalog';
import { DEFAULT_STUDIO_PRIMARY_MAX, MAX_REFERENCE_IMAGES } from './limits';
import { normalizeStudioRatio } from './ratios';
import { supportsStudioFourToOne } from '@/lib/image-generation/resolution';
import type { StudioReferencePolicy } from './reference-policy';

export type StudioTemplateDefaults = {
  primaryMin: number; primaryMax: number; styleMax: number; referenceMax: number; auxiliaryMax: number;
  useFixedReferences: boolean; model: ImageStudioModel; quality: ImageStudioQuality; resolution: ImageResolution;
  count: number; aspectRatio: string;
};

export function defaultStudioTemplateDefaults(model: ImageStudioModel = IMAGE_STUDIO_MODELS[0]): StudioTemplateDefaults {
  return { primaryMin: 0, primaryMax: DEFAULT_STUDIO_PRIMARY_MAX, styleMax: MAX_REFERENCE_IMAGES,
    referenceMax: MAX_REFERENCE_IMAGES, auxiliaryMax: MAX_REFERENCE_IMAGES, useFixedReferences: true,
    model, quality: defaultImageStudioQuality(model), resolution: defaultImageResolution(model), count: 1, aspectRatio: 'auto' };
}

export function parseStudioTemplateDefaults(value: unknown): StudioTemplateDefaults {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('统一默认设置无效');
  const record = value as Record<string, unknown>;
  const keys = Object.keys(defaultStudioTemplateDefaults());
  if (Object.keys(record).some(key => !keys.includes(key)) || keys.some(key => record[key] === undefined)
    || !Number.isInteger(record.primaryMin) || Number(record.primaryMin) < 0
    || !Number.isInteger(record.primaryMax) || Number(record.primaryMax) < 1 || Number(record.primaryMax) > MAX_REFERENCE_IMAGES
    || Number(record.primaryMin) > Number(record.primaryMax)
    || ['styleMax', 'referenceMax', 'auxiliaryMax'].some(key => !Number.isInteger(record[key]) || Number(record[key]) < 0 || Number(record[key]) > MAX_REFERENCE_IMAGES)
    || typeof record.useFixedReferences !== 'boolean' || !Number.isInteger(record.count) || Number(record.count) < 1 || Number(record.count) > 8
    || !IMAGE_STUDIO_MODELS.includes(record.model as ImageStudioModel)) throw new Error('统一默认设置数量或模型无效');
  const model = record.model as ImageStudioModel;
  if (!IMAGE_STUDIO_MODEL_QUALITY_OPTIONS[model].includes(record.quality as ImageStudioQuality)
    || !IMAGE_STUDIO_MODEL_RESOLUTION_OPTIONS[model].includes(record.resolution as ImageResolution)) throw new Error('当前默认模型不支持所选质量或分辨率');
  const aspectRatio = normalizeStudioRatio(record.aspectRatio);
  if (aspectRatio === '4:1' && !supportsStudioFourToOne(model)) throw new Error('当前默认模型不支持4:1比例');
  // Explicit projection excludes content, asset IDs and any future administrator-only fields.
  return { primaryMin: Number(record.primaryMin), primaryMax: Number(record.primaryMax), styleMax: Number(record.styleMax),
    referenceMax: Number(record.referenceMax), auxiliaryMax: Number(record.auxiliaryMax), useFixedReferences: record.useFixedReferences,
    model, quality: record.quality as ImageStudioQuality, resolution: record.resolution as ImageResolution,
    count: Number(record.count), aspectRatio };
}

export function studioTemplateDefaultPolicy(defaults: StudioTemplateDefaults, primaryIds: string[] = []): StudioReferencePolicy {
  return { primaryIds, primaryMin: defaults.primaryMin, primaryMax: defaults.primaryMax,
    styleMax: defaults.styleMax, referenceMax: defaults.referenceMax, auxiliaryMax: defaults.auxiliaryMax,
    useFixedReferences: defaults.useFixedReferences };
}
