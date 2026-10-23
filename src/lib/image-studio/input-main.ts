import { createHash } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { siteUploadPathFromUrl } from '@/lib/assets/site-url';
import type { UploadedAssetPayload } from '@/lib/http/file-upload';
import { canUseCompanyTemplates, type ImageStudioIdentity } from './access';
import { MAX_REFERENCE_IMAGES } from './limits';
import { studioTemplateAssetUrl } from './media';
import { readableStudioCoverIds } from './protected-assets';
import { studioTemplateTaskWhere } from './task-visibility';

export type StudioInputMainState = 'ready' | 'none' | 'unknown' | 'unavailable';
export type StudioInputMainSource = { kind: 'task'; taskId: string }
  | { kind: 'batch-item'; batchId: string; ordinal: number; attempt: number };
export type StudioInputMainPreview = {
  state: StudioInputMainState;
  source: StudioInputMainSource;
  thumbnailUrl?: string;
  count?: number;
};
export type StudioInputMainResponse = {
  source: StudioInputMainSource; taskId?: string; state: StudioInputMainState;
  images: UploadedAssetPayload[]; snapshotToken: string;
};
export class StudioInputMainError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function orderedIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_REFERENCE_IMAGES
    || value.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,120}$/.test(id))
    || new Set(value).size !== value.length) return null;
  return value as string[];
}
const sameIds = (left: string[], right: string[]) => left.length === right.length && left.every((id, index) => id === right[index]);

/** Read only explicit frozen roles. Never reuse the display DTO's legacy-reference fallback. */
export function frozenStudioInputMainIds(snapshotJson: string | null, referenceIdsJson: string): string[] | null {
  try {
    const snapshot: unknown = JSON.parse(snapshotJson || 'null');
    const actual = orderedIds(JSON.parse(referenceIdsJson));
    if (!record(snapshot) || !actual || !record(snapshot.referencePolicy)
      || !Array.isArray(snapshot.primaryReferenceImages)) return null;
    const policyIds = orderedIds(snapshot.referencePolicy.primaryIds);
    const primary = snapshot.primaryReferenceImages;
    if (!policyIds || primary.length > MAX_REFERENCE_IMAGES || primary.some(item => !record(item)
      || typeof item.id !== 'string' || item.referenceRole !== undefined && item.referenceRole !== 'primary')) return null;
    const primaryIds = orderedIds(primary.map(item => (item as Record<string, unknown>).id));
    if (!primaryIds || !sameIds(primaryIds, policyIds)
      || !sameIds(actual.filter(id => primaryIds.includes(id)), primaryIds)) return null;
    if (snapshot.referenceImages !== undefined) {
      if (!Array.isArray(snapshot.referenceImages) || snapshot.referenceImages.length > MAX_REFERENCE_IMAGES
        || snapshot.referenceImages.some(item => !record(item) || typeof item.id !== 'string')) return null;
      const references = snapshot.referenceImages as Record<string, unknown>[];
      const frozenIds = orderedIds(references.map(item => item.id));
      if (!frozenIds || !sameIds(frozenIds, actual) || references.some(item => item.referenceRole !== undefined
        && (item.referenceRole === 'primary') !== primaryIds.includes(item.id as string))) return null;
    }
    for (const field of ['auxiliaryReferenceImages', 'fixedReferenceImages', 'templateReferenceImages']) {
      const auxiliary = snapshot[field];
      if (auxiliary === undefined) continue;
      if (!Array.isArray(auxiliary) || auxiliary.length > MAX_REFERENCE_IMAGES || auxiliary.some(item => !record(item)
        || typeof item.id !== 'string' || primaryIds.includes(item.id) || item.referenceRole === 'primary')) return null;
    }
    return primaryIds;
  } catch { return null; }
}

export function studioInputMainPreview(source: StudioInputMainSource, snapshotJson: string | null,
  referenceIdsJson: string, readableIds?: ReadonlySet<string>): StudioInputMainPreview {
  const ids = frozenStudioInputMainIds(snapshotJson, referenceIdsJson);
  if (ids === null) return { source, state: 'unknown' };
  if (!ids.length) return { source, state: 'none', count: 0 };
  const readable = readableIds ? ids.filter(id => readableIds.has(id)) : ids;
  if (readable.length !== ids.length) return { source, state: 'unavailable', count: ids.length };
  return { source, state: 'ready', thumbnailUrl: studioTemplateAssetUrl(ids[0], true), count: ids.length };
}

type FrozenInputMain = { ownerId: string; snapshotJson: string | null; referenceIdsJson: string };
export async function readFrozenStudioInputMain(user: ImageStudioIdentity, source: StudioInputMainSource,
  frozen: FrozenInputMain): Promise<StudioInputMainResponse> {
  if (!canUseCompanyTemplates(user) || frozen.ownerId !== user.id) throw new StudioInputMainError('无权读取本次输入主图', 403);
  const snapshotToken = createHash('sha256').update(JSON.stringify([
    'studio-direct-input-main-v2', source, frozen.ownerId, frozen.snapshotJson, frozen.referenceIdsJson,
  ])).digest('hex');
  const response = (state: StudioInputMainState, images: UploadedAssetPayload[] = []): StudioInputMainResponse => ({
    source, ...(source.kind === 'task' ? { taskId: source.taskId } : {}), state, images, snapshotToken,
  });
  const primaryIds = frozenStudioInputMainIds(frozen.snapshotJson, frozen.referenceIdsJson);
  if (primaryIds === null) return response('unknown');
  if (!primaryIds.length) return response('none');
  const assets = await prisma.asset.findMany({ where: { id: { in: primaryIds }, owner_id: user.id, status: 'active', type: 'image' },
    take: MAX_REFERENCE_IMAGES, select: { id: true, original_url: true, hash: true, width: true, height: true,
      file_name: true, file_size: true, mime_type: true } });
  if (assets.length !== primaryIds.length || assets.some(asset => !asset.original_url)) return response('unavailable');
  const sourceKeys = assets.map(asset => siteUploadPathFromUrl(asset.original_url) || asset.original_url);
  const hashes = assets.flatMap(asset => asset.hash ? [asset.hash] : []);
  if (new Set(sourceKeys).size !== sourceKeys.length || new Set(hashes).size !== hashes.length) return response('unknown');
  try {
    const readable = await readableStudioCoverIds({ ...user, role: 'user' }, assets);
    if (primaryIds.some(id => !readable.has(id))) return response('unavailable');
  } catch { return response('unavailable'); }
  const byId = new Map(assets.map(asset => [asset.id, asset]));
  return response('ready', primaryIds.map(id => {
    const asset = byId.get(id)!;
    return { id, originalUrl: studioTemplateAssetUrl(id), thumbnailUrl: studioTemplateAssetUrl(id, true),
      width: asset.width, height: asset.height, fileName: asset.file_name, fileSize: asset.file_size,
      mimeType: asset.mime_type || undefined };
  }));
}

export async function getStudioTaskInputMain(user: ImageStudioIdentity, taskId: string): Promise<StudioInputMainResponse> {
  if (!canUseCompanyTemplates(user)) throw new StudioInputMainError('无权读取本次输入主图', 403);
  if (!/^[a-zA-Z0-9-]{1,120}$/.test(taskId)) throw new StudioInputMainError('任务编号无效', 400);
  const task = await prisma.imageStudioTask.findFirst({
    where: { ...studioTemplateTaskWhere(user.id, undefined, true), id: taskId },
    select: { id: true, owner_id: true, snapshot_json: true, reference_ids: true, status: true, usage_json: true, asset_id: true },
  });
  if (!task) throw new StudioInputMainError('任务不存在或无权读取', 404);
  return readFrozenStudioInputMain(user, { kind: 'task', taskId: task.id }, {
    ownerId: task.owner_id, snapshotJson: task.snapshot_json, referenceIdsJson: task.reference_ids,
  });
}
