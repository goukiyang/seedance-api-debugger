import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/session';
import {
  assertCanViewReferenceImage,
  canDownloadOriginal,
  canUseAlbumImage,
} from '@/lib/reference-albums/permissions';
import { mediaPreviewResponse } from '@/lib/media/preview-response';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function content(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const user = await getSession();
    if (!user) throw new AuthError('未登录', 401);

    const image = await assertCanViewReferenceImage(user, params.id);
    if (image.asset && image.asset.status !== 'active') throw new AuthError('素材已不可用', 404);
    const variant = request.nextUrl.searchParams.get('variant') || 'original';
    if (!['thumbnail', 'preview', 'original'].includes(variant)) throw new AuthError('素材类型无效', 400);
    const assetType = image.asset?.type || 'image';
    if (variant === 'thumbnail' && assetType !== 'image' && !image.thumbnail_url) {
      throw new AuthError('暂无封面', 404);
    }
    const downloadable = await canDownloadOriginal(user, image);
    const isOriginalMediaPreview = assetType !== 'image' && variant === 'preview';

    if (variant === 'original' && !downloadable) {
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
    const useThumbnail = variant === 'thumbnail' || (variant === 'preview' && assetType === 'image' && !downloadable);
    const sourceUrl = useThumbnail
      ? (image.thumbnail_url || image.url)
      : image.url;
    const contentType = useThumbnail && image.thumbnail_url ? 'image/jpeg' : image.asset?.mime_type || 'image/jpeg';
    return await mediaPreviewResponse(request, sourceUrl, contentType);
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status, headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
    }
    return NextResponse.json(
      { error: '素材暂时无法读取，请重试' },
      { status: 502, headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } },
    );
  }
}

export const GET = content;
export const HEAD = content;
