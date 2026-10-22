'use client';

import { parseMultiviewGenerationDraft, type MultiviewGenerationDraft } from './multiview-generation-contract';
import { RATIO_OPTIONS, RESOLUTION_OPTIONS } from '@/types';

const KEY_PREFIX = 'sd2:multiview-reuse-handoff:v1:';
const MAX_AGE_MS = 5 * 60 * 1000;
const tokenPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const identifier = (value: unknown): value is string => typeof value === 'string'
  && /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

export type MultiviewReusePatch = {
  provider: 'seedance'; model: string; ratio: string; duration: number; resolution: string; supplement: string;
  seed: number; generateAudio: boolean; returnLastFrame: boolean; watermark: boolean;
  projectId?: string; videoCardId?: string; mainImage?: { assetId: string; referenceImageId: string };
};
export type MultiviewReuseHandoff = {
  schema: 1; token: string; ownerId: string; sourceTaskId: string; targetPath: '/multiview';
  createdAt: number; expiresAt: number; patch: MultiviewReusePatch | null; warnings: string[];
};

function safeWarnings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .slice(0, 8).map(item => item.trim().slice(0, 500));
}

function patchFromResponse(value: Record<string, unknown>, taskId: string): MultiviewReusePatch | null {
  if (value.task_id !== taskId || value.target_path !== '/multiview' || value.provider !== 'seedance'
    || typeof value.model !== 'string' || !value.model.trim() || value.model.length > 160
    || !RATIO_OPTIONS.includes(value.ratio as never)
    || typeof value.duration !== 'number' || !Number.isFinite(value.duration) || value.duration <= 0 || value.duration > 1_000_000
    || !RESOLUTION_OPTIONS.includes(value.resolution as never)
    || typeof value.seed !== 'number' || !Number.isSafeInteger(value.seed) || value.seed < -1 || value.seed > 2_147_483_647
    || typeof value.generate_audio !== 'boolean' || typeof value.return_last_frame !== 'boolean' || typeof value.watermark !== 'boolean'
    || value.resolution_approval_confirmed !== false
    || typeof value.supplement !== 'string' || value.supplement.length > 40_000) return null;
  const projectId = identifier(value.project_id) ? value.project_id : undefined;
  const videoCardId = projectId && identifier(value.video_card_id) ? value.video_card_id : undefined;
  const hasMainAsset = value.main_asset_id !== null && value.main_asset_id !== undefined;
  const hasMainReference = value.main_reference_image_id !== null && value.main_reference_image_id !== undefined;
  if (hasMainAsset !== hasMainReference || hasMainAsset && (!identifier(value.main_asset_id) || !identifier(value.main_reference_image_id))) return null;
  return {
    provider: 'seedance', model: value.model, ratio: value.ratio as string, duration: value.duration,
    resolution: value.resolution as string, supplement: value.supplement, seed: value.seed,
    generateAudio: value.generate_audio, returnLastFrame: value.return_last_frame, watermark: value.watermark,
    ...(projectId ? { projectId } : {}), ...(videoCardId ? { videoCardId } : {}),
    ...(hasMainAsset ? { mainImage: { assetId: value.main_asset_id as string, referenceImageId: value.main_reference_image_id as string } } : {}),
  };
}

function parseStored(value: unknown, token: string, ownerId: string, now: number): MultiviewReuseHandoff | null {
  if (!record(value) || value.schema !== 1 || value.token !== token || value.ownerId !== ownerId || value.targetPath !== '/multiview'
    || !identifier(value.sourceTaskId) || typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)
    || typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt) || value.expiresAt <= now
    || value.expiresAt > value.createdAt + MAX_AGE_MS || value.createdAt > now + 30_000
    || !Array.isArray(value.warnings) || value.warnings.some(item => typeof item !== 'string' || item.length > 500)) return null;
  let patch: MultiviewReusePatch | null = null;
  if (value.patch !== null) {
    if (!record(value.patch)) return null;
    const source = value.patch;
    if (source.provider !== 'seedance' || typeof source.model !== 'string' || !source.model.trim() || source.model.length > 160
      || !RATIO_OPTIONS.includes(source.ratio as never)
      || typeof source.duration !== 'number' || !Number.isFinite(source.duration) || source.duration <= 0 || source.duration > 1_000_000
      || !RESOLUTION_OPTIONS.includes(source.resolution as never)
      || typeof source.supplement !== 'string' || source.supplement.length > 40_000
      || typeof source.seed !== 'number' || !Number.isSafeInteger(source.seed) || source.seed < -1 || source.seed > 2_147_483_647
      || typeof source.generateAudio !== 'boolean' || typeof source.returnLastFrame !== 'boolean' || typeof source.watermark !== 'boolean'
      || source.projectId !== undefined && !identifier(source.projectId)
      || source.videoCardId !== undefined && (!identifier(source.videoCardId) || !identifier(source.projectId))) return null;
    const mainImage = source.mainImage;
    if (mainImage !== undefined && (!record(mainImage) || !identifier(mainImage.assetId) || !identifier(mainImage.referenceImageId))) return null;
    const projectId = identifier(source.projectId) ? source.projectId : undefined;
    const videoCardId = projectId && identifier(source.videoCardId) ? source.videoCardId : undefined;
    patch = {
      provider: 'seedance', model: source.model, ratio: source.ratio as string, duration: source.duration,
      resolution: source.resolution as string, supplement: source.supplement, seed: source.seed,
      generateAudio: source.generateAudio, returnLastFrame: source.returnLastFrame, watermark: source.watermark,
      ...(projectId ? { projectId } : {}), ...(videoCardId ? { videoCardId } : {}),
      ...(mainImage ? { mainImage: { assetId: mainImage.assetId as string, referenceImageId: mainImage.referenceImageId as string } } : {}),
    };
  }
  return { schema: 1, token, ownerId, sourceTaskId: value.sourceTaskId, targetPath: '/multiview',
    createdAt: value.createdAt, expiresAt: value.expiresAt, patch, warnings: [...value.warnings] as string[] };
}

export function issueMultiviewReuseHandoff(ownerId: string, taskId: string, response: unknown, allowEmpty: boolean) {
  if (!identifier(ownerId) || !identifier(taskId) || !record(response) || response.target_path !== '/multiview'
    || !record(response.draft) || response.draft.target_path !== '/multiview') return null;
  const patch = patchFromResponse(response.draft, taskId);
  if (!patch && !(allowEmpty && response.draft.task_id === undefined)) return null;
  const token = crypto.randomUUID();
  const now = Date.now();
  const handoff: MultiviewReuseHandoff = { schema: 1, token, ownerId, sourceTaskId: taskId, targetPath: '/multiview',
    createdAt: now, expiresAt: now + MAX_AGE_MS, patch, warnings: safeWarnings(response.inputWarnings) };
  const key = `${KEY_PREFIX}${token}`;
  const bytes = JSON.stringify(handoff);
  sessionStorage.setItem(key, bytes);
  if (sessionStorage.getItem(key) !== bytes) throw new Error('3D多视图复用现场未能保留，尚未跳转。');
  return { token, href: `/multiview?reuse_handoff=${encodeURIComponent(token)}` };
}

export function readMultiviewReuseHandoff(token: string, ownerId: string): MultiviewReuseHandoff | null {
  if (!tokenPattern.test(token) || !identifier(ownerId)) return null;
  try { return parseStored(JSON.parse(sessionStorage.getItem(`${KEY_PREFIX}${token}`) || 'null'), token, ownerId, Date.now()); }
  catch { return null; }
}

export function clearMultiviewReuseHandoff(token: string) {
  if (!tokenPattern.test(token)) return;
  try { sessionStorage.removeItem(`${KEY_PREFIX}${token}`); } catch { /* Expiry/query cleanup must not replace the current draft. */ }
}

export function applyMultiviewReusePatch(current: MultiviewGenerationDraft, patch: MultiviewReusePatch) {
  const { settingsBinding: _binding, ...withoutBinding } = current;
  return parseMultiviewGenerationDraft({ ...withoutBinding, provider: patch.provider, model: patch.model, ratio: patch.ratio,
    duration: patch.duration, resolution: patch.resolution, supplement: patch.supplement, seed: patch.seed,
    generateAudio: patch.generateAudio, returnLastFrame: patch.returnLastFrame, watermark: patch.watermark,
    projectId: patch.projectId || current.projectId,
    videoCardId: patch.projectId ? patch.videoCardId || '' : current.videoCardId,
    resolutionApprovalConfirmed: false, resolutionApprovalId: '' });
}
