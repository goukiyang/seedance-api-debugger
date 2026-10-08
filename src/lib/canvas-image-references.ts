import { DEFAULT_STUDIO_PRIMARY_MAX, MAX_REFERENCE_IMAGES } from './image-studio/limits';
import type { StudioReferencePolicy } from './image-studio/reference-policy';

// The selected shot/main image is primary; story materials and remaining inputs are references.
export function canvasImageReferencePolicy(ids: string[], primaryIds = ids.slice(0, 1)): StudioReferencePolicy {
  const unique = Array.from(new Set(ids));
  if (unique.length !== ids.length || ids.length > MAX_REFERENCE_IMAGES
    || ids.some(id => typeof id !== 'string' || !id || id.length > 100)
    || primaryIds.length > DEFAULT_STUDIO_PRIMARY_MAX || primaryIds.some(id => !unique.includes(id))) {
    throw Error(`请选择有效原图，主图最多 ${DEFAULT_STUDIO_PRIMARY_MAX} 张、全部参考最多 ${MAX_REFERENCE_IMAGES} 张`);
  }
  return { primaryIds, primaryMin: 0, primaryMax: DEFAULT_STUDIO_PRIMARY_MAX,
    auxiliaryMax: MAX_REFERENCE_IMAGES, styleMax: MAX_REFERENCE_IMAGES,
    referenceMax: MAX_REFERENCE_IMAGES, useFixedReferences: false };
}
