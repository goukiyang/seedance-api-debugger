import type { StudioPinMutation } from '@/lib/image-studio/result-pin-types';

// Metadata is inert: restoring it never sends a PUT. Only an explicit click retries.
const memory = new Map<string, StudioPinMutation | null>();
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,160}$/.test(value);
export const pinRequestKey = (viewerId: string, moduleId: string, assetId: string) =>
  `sd2-studio-pin-request-v1:${viewerId}:${moduleId}:${assetId}`;
export function readPinRequest(viewerId: string, moduleId: string, assetId: string): StudioPinMutation | null {
  const key = pinRequestKey(viewerId, moduleId, assetId);
  if (memory.has(key)) return memory.get(key) || null;
  try {
    const text = localStorage.getItem(key);
    if (!text || text.length > 2000) return null;
    const value = JSON.parse(text) as StudioPinMutation;
    if (!value || value.viewerId !== viewerId || value.moduleId !== moduleId || value.assetId !== assetId
      || ![value.viewerId, value.moduleId, value.assetId, value.taskId, value.requestId].every(validId)
      || value.presetId !== undefined && !validId(value.presetId)
      || typeof value.active !== 'boolean' || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0) return null;
    memory.set(key, value);
    return value;
  } catch { return null; }
}
export function rememberPinRequest(body: StudioPinMutation, clear = false): boolean {
  const key = pinRequestKey(body.viewerId, body.moduleId, body.assetId);
  memory.set(key, clear ? null : body);
  let persisted = true;
  try { if (clear) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(body)); }
  catch { persisted = false; }
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('sd2-studio-pin-pending', { detail: key }));
  return persisted;
}
