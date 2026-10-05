import { CUTOUT_KIND_LABELS, type CutoutKind, type CutoutSettings } from './types';

export type PendingCutoutSubmission = {
  key: string; assetId: string; kind: CutoutKind; parameters: Record<string, unknown>;
  sourceId: string; canvasSize: { width: number; height: number } | null;
};

export function savePendingCutout(accountId: string, pending: PendingCutoutSubmission | null) {
  try {
    if (!accountId) return false;
    const key = `${storageKey(accountId)}.pending`;
    if (pending) {
      const value = JSON.stringify({ version: 1, savedAt: Date.now(), pending });
      if (value.length > 64_000) return false;
      window.localStorage.setItem(key, value);
    }
    else window.localStorage.removeItem(key);
    return true;
  } catch { return false; }
}

export function loadPendingCutout(accountId: string): PendingCutoutSubmission | null {
  try {
    const raw = window.localStorage.getItem(`${storageKey(accountId)}.pending`);
    if (!raw || raw.length > 64_000) return null;
    const entry = JSON.parse(raw), value = entry.pending;
    if (entry.version !== 1 || !Number.isFinite(entry.savedAt) || Date.now() - entry.savedAt > 7 * 86400_000 || entry.savedAt > Date.now() + 60_000) return null;
    if (!value || !/^[\w-]{16,128}$/.test(value.key) || !/^[\w-]{1,128}$/.test(value.assetId)
      || !/^[\w-]{1,128}$/.test(value.sourceId) || !Object.hasOwn(CUTOUT_KIND_LABELS, value.kind)
      || !value.parameters || typeof value.parameters !== 'object' || Array.isArray(value.parameters)) return null;
    return { key: value.key, assetId: value.assetId, kind: value.kind, parameters: value.parameters, sourceId: value.sourceId,
      canvasSize: value.canvasSize && [value.canvasSize.width, value.canvasSize.height].every(n => Number.isFinite(n) && n > 0 && n <= 32000) ? value.canvasSize : null };
  } catch { return null; }
}

export type CutoutMode = 'cutout' | 'characters';
export type CutoutPresetKey = 'standard' | 'mechanical' | 'aggressive' | 'detail' | 'soft';

export type CutoutPreferences = {
  settings: CutoutSettings;
  mode: CutoutMode;
  advancedOpen: boolean;
  selectedJobId: string | null;
  historyOffset: number;
};

const SETTINGS_VERSION = 3;
const PREFERENCES_VERSION = 1;

export const DEFAULT_CUTOUT_SETTINGS: CutoutSettings = {
  version: SETTINGS_VERSION,
  background_removal: 50,
  edge_smooth: 40,
  residue_cleanup: 50,
  hole_repair: 35,
  detail_protection: 60,
  shadow_retention: 30,
  model_preference: 'auto',
  alpha_matting: true,
  foreground_threshold: 240,
  background_threshold: 10,
  erode_size: 3,
  mask_expand: 0,
  mask_contract: 0,
  feather: 1,
  remove_small_noise: true,
  fill_holes: false,
  alpha_clamp_foreground: 245,
  background_alpha_cutoff: 8,
  edge_decontaminate: true,
  edge_decontaminate_strength: 0.6,
  edge_band_width: 4,
  preset: 'standard',
};

export const CUTOUT_PRESETS: Record<CutoutPresetKey, { name: string; settings: CutoutSettings }> = {
  standard: { name: '标准', settings: { ...DEFAULT_CUTOUT_SETTINGS, preset: 'standard' } },
  mechanical: {
    name: '一键机械',
    settings: {
      ...DEFAULT_CUTOUT_SETTINGS,
      background_removal: 100,
      edge_smooth: 35,
      residue_cleanup: 95,
      hole_repair: 35,
      detail_protection: 35,
      shadow_retention: 0,
      foreground_threshold: 245,
      background_threshold: 8,
      erode_size: 2,
      feather: 0.8,
      remove_small_noise: true,
      fill_holes: false,
      alpha_clamp_foreground: 245,
      background_alpha_cutoff: 12,
      edge_decontaminate_strength: 0.7,
      edge_band_width: 4,
      preset: 'mechanical',
    },
  },
  aggressive: {
    name: '强力去背景',
    settings: {
      ...DEFAULT_CUTOUT_SETTINGS,
      background_removal: 85,
      edge_smooth: 30,
      residue_cleanup: 80,
      hole_repair: 60,
      detail_protection: 40,
      shadow_retention: 10,
      preset: 'aggressive',
    },
  },
  detail: {
    name: '保细节',
    settings: {
      ...DEFAULT_CUTOUT_SETTINGS,
      background_removal: 35,
      edge_smooth: 25,
      residue_cleanup: 30,
      hole_repair: 30,
      detail_protection: 90,
      shadow_retention: 40,
      feather: 0.7,
      fill_holes: true,
      edge_decontaminate_strength: 0.45,
      preset: 'detail',
    },
  },
  soft: {
    name: '柔和边缘',
    settings: {
      ...DEFAULT_CUTOUT_SETTINGS,
      background_removal: 55,
      edge_smooth: 80,
      residue_cleanup: 50,
      hole_repair: 60,
      detail_protection: 65,
      shadow_retention: 50,
      feather: 1.8,
      edge_band_width: 6,
      preset: 'soft',
    },
  },
};

function clampNumber(value: unknown, fallback: number, min: number, max: number, integer = false) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  const clamped = Math.min(max, Math.max(min, number));
  return integer ? Math.round(clamped) : clamped;
}

function normalizeBoolean(value: unknown, fallback: boolean) {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeModel(value: unknown, fallback: string) {
  if (typeof value !== 'string' || value.length > 160) return fallback;
  return value === 'auto' || value === 'fallback' || value === 'birefnet' || value.startsWith('rembg:')
    ? value
    : fallback;
}

export function normalizeCutoutSettings(input: unknown): CutoutSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ...DEFAULT_CUTOUT_SETTINGS };
  const value = input as Record<string, unknown>;
  if (Number(value.version) !== SETTINGS_VERSION) return { ...DEFAULT_CUTOUT_SETTINGS };
  const allowedPresets = Object.keys(CUTOUT_PRESETS);
  const preset = typeof value.preset === 'string' && allowedPresets.includes(value.preset)
    ? value.preset
    : undefined;

  return {
    version: SETTINGS_VERSION,
    background_removal: clampNumber(value.background_removal, DEFAULT_CUTOUT_SETTINGS.background_removal, 0, 100),
    edge_smooth: clampNumber(value.edge_smooth, DEFAULT_CUTOUT_SETTINGS.edge_smooth, 0, 100),
    residue_cleanup: clampNumber(value.residue_cleanup, DEFAULT_CUTOUT_SETTINGS.residue_cleanup, 0, 100),
    hole_repair: clampNumber(value.hole_repair, DEFAULT_CUTOUT_SETTINGS.hole_repair, 0, 100),
    detail_protection: clampNumber(value.detail_protection, DEFAULT_CUTOUT_SETTINGS.detail_protection, 0, 100),
    shadow_retention: clampNumber(value.shadow_retention, DEFAULT_CUTOUT_SETTINGS.shadow_retention, 0, 100),
    model_preference: normalizeModel(value.model_preference, DEFAULT_CUTOUT_SETTINGS.model_preference),
    alpha_matting: normalizeBoolean(value.alpha_matting, DEFAULT_CUTOUT_SETTINGS.alpha_matting),
    foreground_threshold: clampNumber(value.foreground_threshold, DEFAULT_CUTOUT_SETTINGS.foreground_threshold, 0, 255, true),
    background_threshold: clampNumber(value.background_threshold, DEFAULT_CUTOUT_SETTINGS.background_threshold, 0, 255, true),
    erode_size: clampNumber(value.erode_size, DEFAULT_CUTOUT_SETTINGS.erode_size, 0, 32, true),
    mask_expand: clampNumber(value.mask_expand, DEFAULT_CUTOUT_SETTINGS.mask_expand, 0, 32, true),
    mask_contract: clampNumber(value.mask_contract, DEFAULT_CUTOUT_SETTINGS.mask_contract, 0, 32, true),
    feather: clampNumber(value.feather, DEFAULT_CUTOUT_SETTINGS.feather, 0, 12),
    remove_small_noise: normalizeBoolean(value.remove_small_noise, DEFAULT_CUTOUT_SETTINGS.remove_small_noise),
    fill_holes: normalizeBoolean(value.fill_holes, DEFAULT_CUTOUT_SETTINGS.fill_holes),
    alpha_clamp_foreground: clampNumber(value.alpha_clamp_foreground, DEFAULT_CUTOUT_SETTINGS.alpha_clamp_foreground, 0, 255, true),
    background_alpha_cutoff: clampNumber(value.background_alpha_cutoff, DEFAULT_CUTOUT_SETTINGS.background_alpha_cutoff, 0, 255, true),
    edge_decontaminate: normalizeBoolean(value.edge_decontaminate, DEFAULT_CUTOUT_SETTINGS.edge_decontaminate),
    edge_decontaminate_strength: clampNumber(value.edge_decontaminate_strength, DEFAULT_CUTOUT_SETTINGS.edge_decontaminate_strength, 0, 1),
    edge_band_width: clampNumber(value.edge_band_width, DEFAULT_CUTOUT_SETTINGS.edge_band_width, 0, 32, true),
    preset,
  };
}

export function loadCutoutPreferences(accountId: string): CutoutPreferences | null {
  if (typeof window === 'undefined' || !accountId) return null;
  try {
    const raw = window.localStorage.getItem(storageKey(accountId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || parsed.version !== PREFERENCES_VERSION) return null;
    const selectedJobId = typeof parsed.selectedJobId === 'string'
      && /^[A-Za-z0-9_-]{1,200}$/.test(parsed.selectedJobId)
      ? parsed.selectedJobId
      : null;
    return {
      settings: normalizeCutoutSettings(parsed.settings),
      mode: parsed.mode === 'characters' ? 'characters' : 'cutout',
      advancedOpen: parsed.advancedOpen === true,
      selectedJobId,
      historyOffset: clampNumber(parsed.historyOffset, 0, 0, 100_000, true),
    };
  } catch {
    return null;
  }
}

export function saveCutoutPreferences(accountId: string, preferences: CutoutPreferences) {
  if (typeof window === 'undefined' || !accountId) return false;
  try {
    window.localStorage.setItem(storageKey(accountId), JSON.stringify({
      version: PREFERENCES_VERSION,
      settings: normalizeCutoutSettings(preferences.settings),
      mode: preferences.mode,
      advancedOpen: preferences.advancedOpen,
      selectedJobId: preferences.selectedJobId,
      historyOffset: clampNumber(preferences.historyOffset, 0, 0, 100_000, true),
    }));
    return true;
  } catch {
    return false;
  }
}

function storageKey(accountId: string) {
  return `sd2.cutout.v1.${encodeURIComponent(accountId)}`;
}
