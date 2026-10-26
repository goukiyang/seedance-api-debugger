import { CONTENT_TYPES, type ContentKey, type ContentType } from './types';

export function tryContentKeyParts(input: unknown): { key: ContentKey; type: ContentType; id: string } | null {
  if (typeof input !== 'string' || input.length > 180) return null;
  const separator = input.indexOf(':');
  if (separator < 1) return null;
  const type = input.slice(0, separator), id = input.slice(separator + 1);
  const legacy = type === 'image_template' && /^module-source:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
  if (!CONTENT_TYPES.includes(type as ContentType) || !id || (!legacy && !/^[a-zA-Z0-9_-]+$/.test(id))) return null;
  return { key: input as ContentKey, type: type as ContentType, id };
}
