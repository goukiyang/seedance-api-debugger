import type { SessionUser } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { mediaProjection } from './outlet';
import { browserUploadAsset, type BrowserMedia, type CompletedUploadAsset } from './browser-asset';

export async function browserAssetMedia(user: SessionUser, assetId: string, referenceImageId?: string | null) {
  if (referenceImageId) {
    const reference = await prisma.referenceImage.findFirst({ where: { id: referenceImageId, asset_id: assetId, status: 'active' }, select: { id: true } });
    if (!reference) return null;
    return mediaProjection(user, { type: 'reference', id: reference.id });
  }
  return mediaProjection(user, { type: 'asset', id: assetId });
}

export async function browserCompletedUpload(user: SessionUser, asset: CompletedUploadAsset) {
  let media: BrowserMedia | null = null;
  try { media = await browserAssetMedia(user, asset.id); } catch { /* A committed upload must stay confirmed when display authorization is temporarily unavailable. */ }
  return browserUploadAsset(asset, media);
}

// Preparation/unknown-state envelopes without a completed Asset remain exact.
export async function browserUploadResponse<T extends object>(user: SessionUser, result: T) {
  const asset = (result as { asset?: CompletedUploadAsset }).asset;
  if (!asset || typeof asset.id !== 'string' || !asset.id) return result;
  return { ...result, asset: await browserCompletedUpload(user, asset) };
}
