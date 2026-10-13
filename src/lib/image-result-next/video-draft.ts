import { normalizeGenerationDefaults, type GenerationDefaults } from '@/lib/preferences/generation';
import type { ImageResultNextReceipt } from './types';

export type ImageResultVideoHandoff = ImageResultNextReceipt & { ownerId: string };
export type ImageResultVideoDraft = { version: 1; prompt: string; settings: GenerationDefaults; model: string };
function key(handoff: ImageResultVideoHandoff) { return `sd2-image-result-video-draft-v1:${handoff.ownerId}:${handoff.receiptId}`; }
export function readImageResultVideoDraft(handoff: ImageResultVideoHandoff): ImageResultVideoDraft | null {
  try {
    const raw = localStorage.getItem(key(handoff));
    const value = raw ? JSON.parse(raw) : null;
    if (!value || value.version !== 1 || typeof value.prompt !== 'string' || value.prompt.length > 30_000 || typeof value.model !== 'string' || value.model.length > 200 || !value.settings) return null;
    return { version: 1, prompt: value.prompt, model: value.model, settings: normalizeGenerationDefaults(value.settings) };
  } catch { return null; }
}
export function saveImageResultVideoDraft(handoff: ImageResultVideoHandoff, draft: ImageResultVideoDraft): boolean {
  try { localStorage.setItem(key(handoff), JSON.stringify(draft)); return true; } catch { return false; }
}
