import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { AuthError, getSession } from '@/lib/auth/session';
import { ensureSiteAssetPublicUrl } from '@/lib/assets/site-upload';
import {
  assertCanEditAlbum,
  canCopyAlbumImage,
  assertCanViewAlbum,
  canUseDirectAsset,
  getReferenceImageByIdForAccess,
} from '@/lib/reference-albums/permissions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 120;

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    await assertCanViewAlbum(user, params.id);
    const images = await prisma.referenceImage.findMany({
      where: { album_id: params.id, status: 'active' },
      orderBy: { sort_order: 'asc' },
      include: { asset: { select: { id: true, type: true, file_name: true, width: true, height: true, file_size: true, mime_type: true } } },
    });

    return NextResponse.json({
      images: images.map((image) => ({
        id: image.id,
        album_id: image.album_id,
        asset_id: image.asset_id,
        source_type: image.source_type,
        source_content_id: image.source_content_id,
        source_image_id: image.source_image_id,
        sort_order: image.sort_order,
        status: image.status,
        created_at: image.created_at,
        updated_at: image.updated_at,
        image_url: `/api/reference-images/${image.id}/content`,
        thumbnail_url: `/api/reference-images/${image.id}/content?variant=thumbnail`,
        asset: image.asset,
      })),
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[ReferenceAlbumImages] List error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const album = await assertCanEditAlbum(user, params.id);
    const contentType = request.headers.get('content-type') || '';
    if (contentType.includes('multipart/form-data')) {
      return NextResponse.json(
        {
          success: false,
          code: 'CURRENT_UPLOAD_ENTRYPOINT_UPGRADED',
          error: '图集上传入口已升级，请刷新页面后重试；如果仍出现，请重新登录。',
        },
        { status: 400 },
      );
    }

    const body = await request.json().catch(() => ({}));
    const assetIds = normalizeIds(body.asset_ids || body.assetIds || body.asset_id || body.assetId);
    const sourceReferenceImageIds = normalizeIds(body.reference_image_ids || body.referenceImageIds || body.reference_image_id || body.referenceImageId);
    if (assetIds.length === 0 && sourceReferenceImageIds.length === 0) {
      return NextResponse.json({ error: 'asset_id required' }, { status: 400 });
    }

    const currentMax = await prisma.referenceImage.aggregate({
      where: { album_id: album.id },
      _max: { sort_order: true },
    });
    let sortOrder = currentMax._max.sort_order ?? -1;
    const created = [];

    for (const sourceReferenceImageId of sourceReferenceImageIds) {
      const sourceImage = await getReferenceImageByIdForAccess(sourceReferenceImageId);
      if (!sourceImage || !(await canCopyAlbumImage(user, sourceImage))) {
        return NextResponse.json({ error: '无权复制此参考图' }, { status: 403 });
      }
      if (!sourceImage.asset_id) {
        return NextResponse.json({ error: `参考图缺少资产记录: ${sourceReferenceImageId}` }, { status: 400 });
      }
      const sourceAsset = sourceImage.asset
        ? await ensureReferenceAssetReady(sourceImage.asset)
        : null;
      if (!sourceAsset) {
        return NextResponse.json({ error: `参考素材缺少资产记录: ${sourceReferenceImageId}` }, { status: 400 });
      }

      sortOrder += 1;
      const image = await prisma.referenceImage.create({
        data: {
          album_id: album.id,
          workspace_id: album.workspace_id,
          project_id: album.project_id,
          owner_user_id: user.id,
          asset_id: sourceAsset.id,
          url: sourceAsset.original_url,
          thumbnail_url: sourceAsset.thumbnail_url,
          source_type: 'copied',
          source_content_id: sourceImage.source_content_id,
          source_image_id: sourceImage.id,
          sort_order: sortOrder,
          metadata_json: JSON.stringify({ copied_from_album_id: sourceImage.album_id }),
          status: 'active',
        },
      });
      created.push(image);
    }

    for (const assetId of assetIds) {
      if (!(await canUseDirectAsset(user, assetId))) {
        return NextResponse.json({ error: '无权保存此素材到图集' }, { status: 403 });
      }

      const assetRecord = await prisma.asset.findUnique({ where: { id: assetId } });
      const asset = assetRecord && isSupportedReferenceAssetType(assetRecord.type)
        ? await ensureReferenceAssetReady(assetRecord)
        : null;
      if (!asset || !isSupportedReferenceAssetType(asset.type)) {
        return NextResponse.json({ error: `素材不存在或类型不支持: ${assetId}` }, { status: 400 });
      }

      sortOrder += 1;
      const image = await prisma.referenceImage.create({
        data: {
          album_id: album.id,
          workspace_id: album.workspace_id,
          project_id: album.project_id,
          owner_user_id: user.id,
          asset_id: asset.id,
          url: asset.original_url,
          thumbnail_url: asset.thumbnail_url,
          source_type: body.source_type === 'copied' ? 'copied' : 'upload',
          source_content_id: typeof body.source_content_id === 'string' ? body.source_content_id : null,
          source_image_id: typeof body.source_image_id === 'string' ? body.source_image_id : null,
          sort_order: sortOrder,
          metadata_json: body.metadata_json ? JSON.stringify(body.metadata_json) : null,
          status: 'active',
        },
      });
      created.push(image);
    }

    if (!album.cover_image_id && created[0]) {
      await prisma.referenceAlbum.update({
        where: { id: album.id },
        data: { cover_image_id: created[0].id },
      });
    } else {
      await prisma.referenceAlbum.update({ where: { id: album.id }, data: { updated_at: new Date() } });
    }

    await prisma.operationLog.create({
      data: {
        operator_id: user.id,
        action: 'reference_album_add_assets',
        target_type: 'ReferenceAlbum',
        target_id: album.id,
        detail: JSON.stringify({ image_ids: created.map((image) => image.id), asset_ids: assetIds }),
      },
    });

    return NextResponse.json({
      images: created.map((image) => ({
        ...image,
        image_url: `/api/reference-images/${image.id}/content`,
        thumbnail_url: `/api/reference-images/${image.id}/content?variant=thumbnail`,
        url: undefined,
      })),
    }, { status: 201 });
  } catch (error) {
    if (error instanceof ReferenceAssetPublicUrlError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[ReferenceAlbumImages] Add error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

function normalizeIds(input: unknown): string[] {
  if (Array.isArray(input)) {
    return input.map((value) => String(value).trim()).filter(Boolean);
  }
  if (typeof input === 'string' && input.trim()) return [input.trim()];
  return [];
}

type AlbumImageAsset = {
  id: string;
  type: string;
  original_url: string;
  thumbnail_url: string | null;
  file_name: string;
};

class ReferenceAssetPublicUrlError extends Error {
  readonly status = 400;
}

function isSupportedReferenceAssetType(type: string | null | undefined) {
  return type === 'image' || type === 'video' || type === 'audio';
}

async function ensureReferenceAssetReady(asset: AlbumImageAsset): Promise<AlbumImageAsset> {
  if (asset.type !== 'video' && asset.type !== 'audio') return asset;
  let result: Awaited<ReturnType<typeof ensureSiteAssetPublicUrl>>;
  try {
    result = await ensureSiteAssetPublicUrl(asset.id);
  } catch (error) {
    throw new ReferenceAssetPublicUrlError(error instanceof Error ? error.message : '参考视频/音频公网 URL 准备失败');
  }
  if (!result.isPubliclyReachable) {
    throw new ReferenceAssetPublicUrlError('参考视频/音频必须是公网可访问 URL，请重新上传素材或配置 R2/TOS 存储。');
  }
  return {
    id: result.asset.id,
    type: result.asset.type,
    original_url: result.asset.original_url,
    thumbnail_url: result.asset.thumbnail_url,
    file_name: result.asset.file_name,
  };
}
