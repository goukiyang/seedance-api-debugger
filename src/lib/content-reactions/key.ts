import { CONTENT_TYPES, type ContentKey, type ContentType } from './types';
import { validStudioPresetId } from '../image-studio/preset-id';

export function tryContentKeyParts(input: unknown): { key: ContentKey; type: ContentType; id: string } | null {
  if (typeof input !== 'string' || input.length > 180) return null;
  const separator = input.indexOf(':');
  if (separator < 1) return null;
  const type = input.slice(0, separator), id = input.slice(separator + 1);
  const validId = type === 'image_template' ? validStudioPresetId(id) : /^[a-zA-Z0-9_-]+$/.test(id);
  if (!CONTENT_TYPES.includes(type as ContentType) || !validId) return null;
  return { key: input as ContentKey, type: type as ContentType, id };
}
