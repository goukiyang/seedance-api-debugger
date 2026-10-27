import { assertMedia, decideMedia, type MediaAction, type MediaRef } from '@/lib/access/media-policy';
import type { SessionUser } from '@/lib/auth/session';
import { readStudioDetail, readStudioPreview, readStudioThumbnail, preparedStudioDisplayFile, statStudioDisplayImage } from '@/lib/image-studio/media';
import { lookupHd, hdDirectory, hdRepresentationVersion } from './hd-derivatives';
import path from 'node:path';
import { localMediaLocation, mediaFileLocation } from './storage-roots';
import { signUserMedia, mediaDenied } from './signed-media';
import { cachedRemoteMedia } from './remote-cache';
import { comparisonOriginalVersion } from './image-comparison-version';
import { validComparisonVersion, COMPARISON_VERSION_PARAM } from './image-comparison-contract';
import { isImagePrefetch } from './image-validators';

export const MEDIA_VARIANTS = ['thumbnail', 'preview', 'detail', 'original', 'download', 'hd', 'hd-download', 'hd-description'] as const;
export type MediaVariant = typeof MEDIA_VARIANTS[number];
export const mediaVariantAction = (variant: string): MediaAction => ['original', 'download', 'hd', 'hd-download', 'hd-description'].includes(variant)
  ? 'download-original' : variant === 'thumbnail' ? 'view-thumbnail' : 'view-preview';

export async function mediaAddress(user: SessionUser, ref: MediaRef, variant: MediaVariant, options: { prepare?: boolean } = {}) {
  const decision = await assertMedia(user, ref, mediaVariantAction(variant));
  const source = decision.source;
  if (!source?.url) throw new Error('media_source_unavailable');
  let location = localMediaLocation(source.url), mime = source.mime;
  let fileName = source.name;
  const versions: { sourceVersion?: string; representationVersion?: string; comparisonVersion?: string } = {};
  const comparisonVersion = await comparisonOriginalVersion(source.url);
  if (comparisonVersion) versions.comparisonVersion = comparisonVersion;
  if (['hd', 'hd-download'].includes(variant)) {
    const job = await lookupHd(source.url);
    if (!job || job.status !== 'ready') throw Object.assign(new Error('media_hd_not_ready'), { status: 409 });
    versions.sourceVersion = job.version;
    versions.representationVersion = await hdRepresentationVersion(source.url, job);
    if (variant === 'hd-download') fileName = `${source.name.replace(/\.[^.]+$/, '')}-hd.${job.format === 'original' ? source.mime.split('/')[1] : job.format}`;
    if (job.format !== 'original') {
      if (!job.file || !/^[a-f0-9]{64}\.(webp|avif)$/.test(job.file)) throw new Error('media_hd_manifest');
      location = mediaFileLocation(path.join(hdDirectory(), job.file)); mime = job.mime || 'image/webp';
    }
  } else if ((variant === 'thumbnail' || variant === 'preview' || variant === 'detail') && source.kind === 'image' && ref.type !== 'video-cover') {
    if (variant === 'thumbnail' && source.thumbnail && source.thumbnail !== source.url) {
      location = localMediaLocation(source.thumbnail);
      mime = source.thumbnail.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
    } else {
      if (options.prepare === false) {
        const prepared = await statStudioDisplayImage(source.url, variant);
        if (!prepared) throw Object.assign(new Error('media_rendition_pending'), { status: 409 });
        location = mediaFileLocation(prepared.file);
      } else {
        await (variant === 'thumbnail' ? readStudioThumbnail(source.url) : variant === 'detail' ? readStudioDetail(source.url) : readStudioPreview(source.url));
        location = mediaFileLocation(await preparedStudioDisplayFile(source.url, variant));
      }
      mime = 'image/webp';
    }
  } else if (variant === 'thumbnail') {
    location = source.thumbnail ? localMediaLocation(source.thumbnail) : null; mime = 'image/jpeg';
  } else if (['preview', 'detail'].includes(variant) && !decision.rights.use && !decision.rights.download) {
    // Videos/audio need explicit use or original rights, never a view-only grant.
    throw Object.assign(new Error('media_preview_forbidden'), { status: 403 });
  }
  if (!location) {
    if (options.prepare === false) throw Object.assign(new Error('media_rendition_pending'), { status: 409 });
    if (!/^https?:\/\//.test(source.url)) throw Object.assign(new Error('media_local_rendition_pending'), { status: 409 });
    if (variant === 'thumbnail' && source.thumbnail) location = await cachedRemoteMedia(source.thumbnail, mime);
    else location = await cachedRemoteMedia(source.url, mime);
  }
  if (comparisonVersion && await comparisonOriginalVersion(source.url) !== comparisonVersion) throw Object.assign(new Error('media_source_changed'), { status: 409 });
  return signUserMedia(user.id, ref, variant, location, mime, fileName, versions);
}

export async function mediaProjection(user: SessionUser, ref: MediaRef) {
  const decision = await decideMedia(user, ref, 'view-preview');
  if (!decision.allowed) return null;
  // Keep a usable ID even when a derivative is not ready. The unsigned outlet
  // rechecks the same policy and prepares only that explicitly requested image.
  const address = async (variant: MediaVariant) => {
    try { return await mediaAddress(user, ref, variant, { prepare: false }); }
    catch (error) {
      if ((error as { status?: number }).status === 403) return null;
      return `/m/${ref.type}/${encodeURIComponent(ref.id)}/${variant}`;
    }
  };
  return { ref: { type: ref.type, id: ref.id }, thumbnailUrl: await address('thumbnail'),
    previewUrl: await address('preview'), originalUrl: decision.rights.download ? await address('original') : null,
    canUse: decision.rights.use, canDownload: decision.rights.download };
}

export async function redirectMedia(request: Request, user: SessionUser | null, ref: MediaRef, variant: string) {
  if (!user) return mediaDenied(404);
  if (!(MEDIA_VARIANTS as readonly string[]).includes(variant)) return mediaDenied(400);
  try {
    const expected = new URL(request.url).searchParams.get(COMPARISON_VERSION_PARAM);
    if (expected && ['original', 'download', 'hd', 'hd-download', 'hd-description'].includes(variant)) {
      const decision = await assertMedia(user, ref, 'download-original');
      const current = decision.source && await comparisonOriginalVersion(decision.source.url);
      if (!current) return mediaDenied(503);
      if (!validComparisonVersion(expected) || current !== expected) return mediaDenied(409);
    }
    if (variant === 'hd-description') {
      const decision = await assertMedia(user, ref, 'download-original');
      if (!decision.source) return mediaDenied(404);
      const { authorizedImageResponse } = await import('./authorized-image-response');
      return authorizedImageResponse(request, decision.source.url, 'hd-description', decision.source.mime, decision.source.name, undefined,
        { requesterId: user.id, owner: decision.source.ownerId ? { kind: ref.type === 'reference' ? 'reference' : 'asset', id: ref.id, ownerId: decision.source.ownerId } : undefined });
    }
    if (['hd', 'hd-download'].includes(variant)) {
      const query = new URL(request.url).searchParams;
      const decision = await assertMedia(user, ref, 'download-original');
      const job = decision.source && await lookupHd(decision.source.url);
      if (query.has('hd-version') && query.get('hd-version') !== job?.version) return mediaDenied(409);
      const representation = job && decision.source && await hdRepresentationVersion(decision.source.url, job);
      if (query.has('hd-representation') && query.get('hd-representation') !== representation) return mediaDenied(409);
    }
    const prepare = request.method !== 'HEAD' && !isImagePrefetch(request) && request.headers.get('x-image-read-intent') !== 'status';
    const url = await mediaAddress(user, ref, variant as MediaVariant, { prepare });
    return new Response(null, { status: 302, headers: { Location: new URL(url, request.url).href, 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
  } catch (error) {
    const status = (error as { status?: number }).status;
    return mediaDenied(status && [403, 404, 409, 503].includes(status) ? status : 503);
  }
}
