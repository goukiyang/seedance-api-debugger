import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { AuthError, type SessionUser } from '@/lib/auth/session';
import { getAlbumAccess, getReferenceImageByIdForAccess, type AlbumPermissions } from '@/lib/reference-albums/permissions';
import { getProjectAccess } from '@/lib/projects/permissions';
import { studioHiddenAssetUrls } from '@/lib/image-studio/protected-assets';
import { canUseCompanyTemplates, canViewStudioPreset } from '@/lib/image-studio/access';
import { studioPresetArchived } from '@/lib/image-studio/preset-lifecycle';
import { getStudioPresetReferencePolicy } from '@/lib/image-studio/reference-policy';
import { getStudioPresetsFixedReferences } from '@/lib/image-studio/fixed-references';
import { homeTemplateCover } from '@/lib/content-reactions/home-templates';
import { studioTaskHasViewableOutput } from '@/lib/image-studio/dimension-mismatch';
import { multiviewSystemReferenceFileAccess } from '@/lib/video/multiview-recipe-storage.server';
import { isMultiviewOutputMetadata } from '@/lib/video/multiview-output-access.server';
import { isTaskHiddenFromRegularUsers } from '@/lib/tasks/retention';
import { previewMime } from '@/lib/media/preview-response';
import { isPrivateMultiviewTask } from '@/lib/video/multiview-task-privacy';
import { siteUploadPathFromUrl, siteUploadBaseUrls } from '@/lib/assets/site-url';

export const MEDIA_TYPES = ['asset', 'reference', 'video', 'video-cover', 'video-input', 'video-frame', 'image-task', 'template-cover', 'multiview-reference', 'multiview-output', 'seedance'] as const;
export type MediaType = typeof MEDIA_TYPES[number];
export const MEDIA_ACTIONS = ['view-thumbnail', 'view-preview', 'use', 'download-original', 'delete', 'copy', 'edit'] as const;
export type MediaAction = typeof MEDIA_ACTIONS[number];
export type MediaRef = { type: MediaType; id: string; homeContentKey?: string };
export type MediaSource = { url: string; thumbnail: string | null; mime: string; name: string; kind: string; ownerId: string | null };
export type MediaDecision = { allowed: boolean; ref: MediaRef; action: MediaAction; rights: AlbumPermissions; source?: MediaSource; reason: string };
type Db = Prisma.TransactionClient;
type Image = NonNullable<Awaited<ReturnType<typeof getReferenceImageByIdForAccess>>>;
const none = (): AlbumPermissions => ({ view: false, use: false, copy: false, download: false, viewSource: false, edit: false });
const all = (): AlbumPermissions => ({ view: true, use: true, copy: true, download: true, viewSource: true, edit: true });
const administrator = (user: SessionUser) => user.role === 'admin' && user.account_type === 'internal';
const active = (user: SessionUser | null): user is SessionUser => Boolean(user && user.status === 'active' && (!user.expires_at || user.expires_at.getTime() > Date.now()));
const actionRight: Record<MediaAction, keyof AlbumPermissions> = {
  'view-thumbnail': 'view', 'view-preview': 'view', use: 'use', 'download-original': 'download', delete: 'edit', copy: 'copy', edit: 'edit',
};
const intersect = (left: AlbumPermissions, right: AlbumPermissions): AlbumPermissions => Object.fromEntries(
  (Object.keys(left) as Array<keyof AlbumPermissions>).map(key => [key, left[key] && right[key]]),
) as AlbumPermissions;

export function parseRightsCeiling(value: string | null | undefined): AlbumPermissions | null {
  if (value == null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return none();
    const allowed = Object.keys(none());
    if (Object.keys(parsed).some(key => !allowed.includes(key))) return none();
    return Object.fromEntries(allowed.map(key => [key, (parsed as Record<string, unknown>)[key] === true])) as AlbumPermissions;
  } catch { return none(); }
}

async function protectedSource(user: SessionUser, source: string, db: Db) {
  return (await studioHiddenAssetUrls(user, db)).includes(source);
}

// Container grants may narrow content rights, never create original ownership.
export async function referenceContentRights(user: SessionUser, image: Image, db: Db = prisma, seen = new Set<string>()): Promise<AlbumPermissions> {
  if (!active(user) || seen.size >= 32 || seen.has(image.id) || image.status !== 'active' || image.asset && image.asset.status !== 'active') return none();
  seen.add(image.id);
  if (await protectedSource(user, image.asset?.original_url || image.url, db) || await protectedSource(user, image.url, db)) return none();
  const access = await getAlbumAccess(user, image.album, db);
  let rights = { ...access.permissions };
  const contentOwner = image.asset?.owner_id || (!image.source_image_id && !['copied', 'shared'].includes(image.source_type) ? image.owner_user_id : null);
  const ceiling = parseRightsCeiling(image.rights_ceiling);
  if (ceiling) rights = intersect(rights, ceiling);
  // Old copied rows have no ceiling. Trace the real source, bounded and cycle-safe.
  if (!ceiling && image.source_image_id) {
    const source = await getReferenceImageByIdForAccess(image.source_image_id, db);
    rights = source ? intersect(rights, await referenceContentRights(user, source, db, seen)) : none();
  }
  if (contentOwner !== user.id && !administrator(user) && !ceiling && !image.source_image_id
    && (image.owner_user_id !== contentOwner || image.album.owner_user_id !== contentOwner || ['owner', 'admin'].includes(access.role))) {
    rights.download = false;
    rights.viewSource = false;
  }
  if (contentOwner === user.id || administrator(user)) {
    // Independent real content ownership/admin management is not a copied grant.
    rights.download = access.permissions.view;
    rights.viewSource = access.permissions.view;
  }
  return rights;
}

export async function referenceCopyCeiling(user: SessionUser, image: Image, db: Db = prisma) {
  return JSON.stringify(await referenceContentRights(user, image, db));
}

async function assetRights(user: SessionUser, asset: { id: string; owner_id: string; original_url: string; status: string }, db: Db) {
  if (asset.status !== 'active' || await protectedSource(user, asset.original_url, db)) return none();
  if (asset.owner_id === user.id || administrator(user)) return all();
  const refs = await db.referenceImage.findMany({ where: { asset_id: asset.id, status: 'active', album: { status: { not: 'deleted' } } }, select: { id: true } });
  let rights = none();
  for (const ref of refs) {
    const image = await getReferenceImageByIdForAccess(ref.id, db);
    if (!image) continue;
    const grant = await referenceContentRights(user, image, db);
    rights = Object.fromEntries((Object.keys(rights) as Array<keyof AlbumPermissions>).map(key => [key, rights[key] || grant[key]])) as AlbumPermissions;
  }
  // An album editor does not gain the ability to delete the underlying Asset.
  rights.edit = false;
  if (!rights.view) {
    const { resolveStudioPinnedAsset } = await import('@/lib/image-studio/result-pins');
    if (await resolveStudioPinnedAsset(user, asset.id)) rights.view = true;
  }
  return rights;
}

async function templateRights(user: SessionUser, asset: { id: string; owner_id: string }, db: Db) {
  if (!canUseCompanyTemplates(user)) return none();
  if (asset.owner_id === user.id || administrator(user)) return all();
  const presets = await db.imageStudioPreset.findMany({ where: { OR: [{ owner_id: user.id }, { is_shared: true }] },
    select: { id: true, owner_id: true, scope: true, is_shared: true, banner_asset_id: true, reference_ids: true } });
  const visible = [];
  for (const preset of presets) {
    if (preset.owner_id !== asset.owner_id || !canViewStudioPreset(user, preset) || await studioPresetArchived(preset.id)) continue;
    visible.push(preset);
    if (preset.banner_asset_id === asset.id) return { ...none(), view: true, use: true };
    const ids: unknown = JSON.parse(preset.reference_ids);
    if (!Array.isArray(ids)) continue;
    const policy = await getStudioPresetReferencePolicy(preset.owner_id, preset.id, ids, undefined);
    if (ids.includes(asset.id) && !policy.primaryIds.includes(asset.id)) return { ...none(), view: true, use: true };
  }
  const fixed = await getStudioPresetsFixedReferences(user, visible);
  return Array.from(fixed.values()).some(refs => refs.some(ref => ref.assetId === asset.id)) ? { ...none(), view: true, use: true } : none();
}

export async function decideMedia(user: SessionUser | null, ref: MediaRef, action: MediaAction, db: Db = prisma): Promise<MediaDecision> {
  const denied = (reason: string): MediaDecision => ({ allowed: false, ref, action, rights: none(), reason });
  if (!active(user) || !MEDIA_TYPES.includes(ref.type) || !MEDIA_ACTIONS.includes(action) || !/^[a-zA-Z0-9_-]{1,180}$/.test(ref.id)) return denied('identity_or_reference');
  let rights = none();
  let source: MediaSource | undefined;
  if (ref.type === 'reference') {
    const image = await getReferenceImageByIdForAccess(ref.id, db);
    if (!image) return denied('missing');
    rights = await referenceContentRights(user, image, db);
    source = { url: image.asset?.original_url || image.url, thumbnail: image.thumbnail_url || image.asset?.thumbnail_url || null,
      mime: image.asset?.mime_type || 'image/jpeg', name: image.asset?.file_name || 'reference', kind: image.asset?.type || 'image', ownerId: image.asset?.owner_id || image.owner_user_id };
    // Removing a reference is a container operation, not deletion of the source bytes.
    if (action === 'delete') rights.edit = (await getAlbumAccess(user, image.album, db)).permissions.edit && rights.view;
  } else if (['video', 'video-cover', 'video-input', 'video-frame'].includes(ref.type)) {
    const input = ref.type === 'video-input' ? /^(.+)--(image|video|audio|frame|first|last)--(\d{1,2})$/.exec(ref.id) : null;
    if (ref.type === 'video-input' && !input) return denied('input_reference');
    const task = await db.videoTask.findUnique({ where: { id: input?.[1] || ref.id }, select: {
      id: true, project_id: true, owner_user_id: true, user_id: true, retention_status: true,
      local_video_path: true, result_video_url: true, public_video_url: true, public_video_storage_key: true,
      result_last_frame_url: true, reference_image_urls: true, reference_video_urls: true, reference_audio_urls: true,
      first_frame_url: true, last_frame_url: true, frame_image_urls: true, source_metadata_json: true,
    } });
    if (!task || !administrator(user) && isTaskHiddenFromRegularUsers(task)) return denied('missing');
    const owner = task.owner_user_id || task.user_id;
    const access = task.project_id ? await getProjectAccess(user, task.project_id, db) : null;
    const view = administrator(user) || (task.project_id ? Boolean(access?.canView) : owner === user.id);
    rights = { view, use: view, copy: view, download: view, viewSource: view, edit: view && (owner === user.id || administrator(user)) };
    if (ref.type === 'video-input' || ref.type === 'video-frame') {
      if (!view || isPrivateMultiviewTask(task)) return denied('task_source_protected');
      let url: string | null = task.result_last_frame_url;
      const role = input?.[2], index = Number(input?.[3] || 0);
      const kind = role === 'video' ? 'video' : role === 'audio' ? 'audio' : 'image';
      if (input) {
        if (role === 'first' || role === 'last') url = role === 'first' ? task.first_frame_url : task.last_frame_url;
        else {
          try {
            const values: unknown = JSON.parse(role === 'image' ? task.reference_image_urls || '[]' : role === 'video'
              ? task.reference_video_urls || '[]' : role === 'audio' ? task.reference_audio_urls || '[]' : task.frame_image_urls || '[]');
            url = Array.isArray(values) && typeof values[index] === 'string' ? values[index] : null;
          } catch { url = null; }
        }
      }
      if (!url || await protectedSource(user, url, db)) return denied('input_missing');
      if (input) {
        // A task's use grant never creates download permission for its input.
        const local = siteUploadPathFromUrl(url);
        const aliases = local ? [...new Set([url, local, ...siteUploadBaseUrls().map(base => base + local)])] : [url];
        const assets = await db.asset.findMany({ where: { original_url: { in: aliases }, status: 'active' }, take: 2,
          select: { id: true, owner_id: true, original_url: true, status: true } });
        if (assets.length > 1) return denied('input_source_ambiguous');
        const asset = assets[0] || null;
        const images = asset ? [] : await db.referenceImage.findMany({ where: { url: { in: aliases }, status: 'active' }, take: 2, select: { id: true } });
        if (images.length > 1) return denied('input_source_ambiguous');
        const image = images[0] || null;
        const imageSource = image ? await getReferenceImageByIdForAccess(image.id, db) : null;
        const ceiling = asset ? await assetRights(user, asset, db) : imageSource ? await referenceContentRights(user, imageSource, db) : null;
        if (ceiling && !ceiling.view) return denied('input_source_revoked');
        rights = { ...none(), view: true, use: ceiling?.use ?? owner === user.id,
          download: ceiling?.download ?? (!local && owner === user.id), viewSource: ceiling?.viewSource ?? (!local && owner === user.id) };
      }
      source = { url, thumbnail: null, mime: previewMime(url, kind === 'image' ? 'image/png' : kind === 'video' ? 'video/mp4' : 'audio/mpeg'),
        name: `${task.id}-${input ? 'input' : 'frame'}`, kind, ownerId: owner };
    } else {
    source = { url: ref.type === 'video-cover' ? `/videos/thumbnails/${task.id}.jpg` : task.local_video_path || task.result_video_url || task.public_video_url || '',
      thumbnail: `/videos/thumbnails/${task.id}.jpg`, mime: ref.type === 'video-cover' ? 'image/jpeg' : 'video/mp4', name: `${task.id}.${ref.type === 'video-cover' ? 'jpg' : 'mp4'}`,
      kind: ref.type === 'video-cover' ? 'image' : 'video', ownerId: owner };
    }
  } else if (ref.type === 'seedance') {
    const asset = await db.seedanceAsset.findUnique({ where: { id: ref.id } });
    if (!asset || user.account_type !== 'internal' || !canUseCompanyTemplates(user)) return denied('missing');
    const known = asset.ownership_status === 'owned' && Boolean(asset.owner_id);
    if (!known) {
      // Unknown historical records are inspectable only by an administrator;
      // no use/mutation/provider operation is inferred from quarantine visibility.
      rights.view = administrator(user);
    } else if (asset.local_status === 'Active' || administrator(user)) {
      if (asset.owner_id === user.id || administrator(user)) rights = all();
    }
    source = { url: asset.original_url, thumbnail: null, mime: previewMime(asset.original_url, asset.asset_type === 'Image' ? 'image/jpeg' : asset.asset_type === 'Video' ? 'video/mp4' : 'audio/mpeg'), name: asset.name,
      kind: asset.asset_type.toLowerCase(), ownerId: asset.owner_id };
  } else {
    let assetId = ref.id;
    if (ref.type === 'image-task') {
      if (!canUseCompanyTemplates(user)) return denied('identity');
      const task = await db.imageStudioTask.findUnique({ where: { id: ref.id } });
      if (!task || task.owner_id !== user.id || task.deleted_at || !studioTaskHasViewableOutput(task) || !task.asset_id) return denied('missing');
      assetId = task.asset_id;
    }
    const asset = await db.asset.findUnique({ where: { id: assetId } });
    if (!asset || asset.status !== 'active' || await protectedSource(user, asset.original_url, db)) return denied('source_protected');
    if (ref.type === 'multiview-reference') {
      const access = await multiviewSystemReferenceFileAccess(user, asset.original_url, db);
      rights = access.protected && access.allowed ? all() : none();
    } else if (ref.type === 'template-cover') {
      if (ref.homeContentKey !== undefined) {
        const cover = await homeTemplateCover(user, ref.homeContentKey, asset.id);
        rights.view = Boolean(cover);
      } else rights = await templateRights(user, asset, db);
    } else {
      if (ref.type === 'multiview-output' && !isMultiviewOutputMetadata(asset.metadata_json) && !asset.original_url.includes('/uploads/multiview-outputs/')) return denied('missing');
      rights = await assetRights(user, asset, db);
    }
    source = { url: asset.original_url, thumbnail: asset.thumbnail_url, mime: asset.mime_type, name: asset.file_name, kind: asset.type, ownerId: asset.owner_id };
  }
  if (source && (await protectedSource(user, source.url, db) || source.thumbnail && await protectedSource(user, source.thumbnail, db))) return denied('source_protected');
  const allowed = rights[actionRight[action]] && !(action === 'view-preview' && source?.kind !== 'image' && !rights.use && !rights.download);
  return { allowed, ref, action, rights, source, reason: allowed ? 'granted' : 'permission' };
}

export async function assertMedia(user: SessionUser | null, ref: MediaRef, action: MediaAction, db: Db = prisma) {
  const decision = await decideMedia(user, ref, action, db);
  if (!decision.allowed) throw new AuthError('素材不存在或无权执行此操作', user ? 403 : 404);
  return decision;
}
