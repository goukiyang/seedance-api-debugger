export type MediaPreviewZoomMode = 'fit' | 'width' | 'actual' | 'custom';

export interface MediaPreviewStoredState {
  scale: number;
  offsetX: number;
  offsetY: number;
  zoomMode: MediaPreviewZoomMode;
  currentTime: number;
  loop: boolean;
}

export const MAX_STORED_SCALE = 1_000_000;
export const DEFAULT_STATE: MediaPreviewStoredState = {
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  zoomMode: 'fit',
  currentTime: 0,
  loop: false,
};
export const ZOOM_MODES = new Set<MediaPreviewZoomMode>(['fit', 'width', 'actual', 'custom']);

export function clampNumber(value: unknown, minimum: number, maximum: number, fallback: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

export function parseMediaPreviewStoredState(input: string | null, defaultLoop = false): MediaPreviewStoredState {
  const fallback = defaultLoop ? { ...DEFAULT_STATE, loop: true } : DEFAULT_STATE;
  if (!input) return fallback;
  try {
    const parsed = JSON.parse(input) as Record<string, unknown>;
    if (parsed.version !== 1 || !parsed.state || typeof parsed.state !== 'object') return fallback;
    const state = parsed.state as Record<string, unknown>;
    const zoomMode = ZOOM_MODES.has(state.zoomMode as MediaPreviewZoomMode)
      ? state.zoomMode as MediaPreviewZoomMode
      : DEFAULT_STATE.zoomMode;
    return {
      scale: clampNumber(state.scale, 0.5, MAX_STORED_SCALE, DEFAULT_STATE.scale),
      offsetX: clampNumber(state.offsetX, -50_000, 50_000, DEFAULT_STATE.offsetX),
      offsetY: clampNumber(state.offsetY, -50_000, 50_000, DEFAULT_STATE.offsetY),
      zoomMode,
      currentTime: clampNumber(state.currentTime, 0, 604_800, DEFAULT_STATE.currentTime),
      loop: typeof state.loop === 'boolean' ? state.loop : defaultLoop,
    };
  } catch {
    return fallback;
  }
}
