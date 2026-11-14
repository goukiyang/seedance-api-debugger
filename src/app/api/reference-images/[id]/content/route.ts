import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/session';
import {
  assertCanViewReferenceImage,
  canDownloadOriginal,
  canUseAlbumImage,
} from '@/lib/reference-albums/permissions';
import { mediaPreviewResponse } from '@/lib/media/preview-response';
import { authorizedImageResponse, discardHdViewingInterest, recordImageReadDiagnostic, type ImageVariant } from '@/lib/media/authorized-image-response';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { trustedStudioImageVersion } from '@/lib/image-studio/media';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function content(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  const started = performance.now();
  const readId = randomUUID();
  const requestedVariant = request.nextUrl.searchParams.get('variant') || 'original';
  let readStage: 'authorization' | 'read' = 'authorization';
  const completed = (response: Response) => {
    response.headers.set('X-Media-Request-Id', readId);
    recordImageReadDiagnostic({ readId, variant: requestedVariant, started, stage: 'completed' });
    return response;
  };
  let requesterId: string | undefined;
  try {
    const user = await getSession();
    if (!user) throw new AuthError('未登录', 401);
    requesterId = user.id;

    const image = await assertCanViewReferenceImage(user, params.id);
    if (image.asset && image.asset.status !== 'active') throw new AuthError('素材已不可用', 404);
    const variant = requestedVariant;
    if (!['thumbnail', 'preview', 'detail', 'original', 'download', 'hd', 'hd-description', 'hd-download'].includes(variant)) throw new AuthError('素材类型无效', 400);
    const assetType = image.asset?.type || 'image';
    if (variant === 'thumbnail' && assetType !== 'image' && !image.thumbnail_url) {
      throw new AuthError('暂无封面', 404);
    }
    const downloadable = await canDownloadOriginal(user, image);
    const isOriginalMediaPreview = assetType !== 'image' && ['preview', 'detail'].includes(variant);

    if (['original', 'download', 'hd', 'hd-description', 'hd-download'].includes(variant) && !downloadable) {
      throw new AuthError('无权访问原素材', 403);
    }

    if (
      isOriginalMediaPreview
      && !(await canUseAlbumImage(user, image))
      && !downloadable
    ) {
      throw new AuthError('无权预览原始视频/音频素材', 403);
    }

    // Image-only viewers keep thumbnail access; originals still require download permission.
    const useThumbnail = variant === 'thumbnail' || (['preview', 'detail'].includes(variant) && assetType === 'image' && !downloadable);
    const sourceUrl = assetType === 'image' ? image.url : useThumbnail
      ? (image.thumbnail_url || image.url)
      : image.url;
    const contentType = useThumbnail && image.thumbnail_url ? 'image/jpeg' : image.asset?.mime_type || 'image/jpeg';
    readStage = 'read';
    if (assetType === 'image') return completed(await authorizedImageResponse(request, sourceUrl, useThumbnail && variant !== 'thumbnail' ? 'thumbnail' : variant as ImageVariant, image.asset?.mime_type || 'image/jpeg', image.asset?.file_name || 'reference-image', started,
      { requesterId: user.id, owner: image.asset ? { kind: 'asset', id: image.asset.id, ownerId: image.asset.owner_id }
        : { kind: 'reference', id: image.id, ownerId: image.owner_user_id } },
      image.asset && sourceUrl === image.asset.original_url ? trustedStudioImageVersion(image.asset) : undefined, readId));
    return completed(await mediaPreviewResponse(request, sourceUrl, contentType));
  } catch (error) {
    recordImageReadDiagnostic({ readId, variant: requestedVariant, started, stage: readStage, error, cancelled: request.signal.aborted });
    if (error instanceof AuthError) {
      if (requesterId && [401, 403, 404].includes(error.status)) await discardHdViewingInterest(request, requesterId);
      const response = NextResponse.json({ error: error.message }, { status: error.status, headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
      response.headers.set('X-Media-Request-Id', readId);
      return response;
    }
    const response = NextResponse.json(
      { error: '素材暂时无法读取，请重试' },
      { status: 502, headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } },
    );
    response.headers.set('X-Media-Request-Id', readId);
    return response;
  }
}

export const GET = content;
export const HEAD = content;
