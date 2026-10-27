import { route as apiRoute } from '@/lib/http/route';
import { apiErrorResponse } from '@/lib/http/api-error';
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
import { recordAssetUploadLog } from '@/lib/assets/upload-log';
import type { Prisma } from '@prisma/client';
import type { SessionUser } from '@/lib/auth/session';
import { assertProjectActiveInTransaction, getProjectAccess } from '@/lib/projects/permissions';
import { assertFeatureAllowed } from '@/lib/access/feature-guard';
import { parseAlbumPermissions } from '@/lib/reference-albums/permissions';
import { referenceCopyCeiling } from '@/lib/access/media-policy';
import { readAlbumImagePage } from '@/lib/reference-albums/image-page';
import { assertPageOwner, PaginationError } from '@/lib/pagination/cursor';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 120;

export const GET = apiRoute({ access: 'user', rateLimit: false }, async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
    assertPageOwner(request.headers, user.id);

    const album = await assertCanViewAlbum(user, params.id);
    return NextResponse.json(await readAlbumImagePage(user, album, request.nextUrl.searchParams), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    if (error instanceof AuthError || error instanceof PaginationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    return apiErrorResponse(error);
  }
});

export const POST = apiRoute({ access: 'user', rateLimit: false }, async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const startedAt = Date.now();
  let userId: string | null = null;
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
    userId = user.id;

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

    const pending: Prisma.ReferenceImageUncheckedCreateInput[] = [];

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

      pending.push({
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
          rights_ceiling: await referenceCopyCeiling(user, sourceImage),
          metadata_json: JSON.stringify({ copied_from_album_id: sourceImage.album_id }),
          status: 'active',
      });
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

      pending.push({
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
          metadata_json: body.metadata_json ? JSON.stringify(body.metadata_json) : null,
          status: 'active',
      });
    }

    const created = await prisma.$transaction(async (tx) => {
    const freshAlbum = await albumForWrite(tx, user, album.id);
    if (freshAlbum.project_id !== album.project_id || freshAlbum.workspace_id !== album.workspace_id) throw new AuthError('图集归属已变化，请重新核对后添加', 409);
    const currentMax = await tx.referenceImage.aggregate({ where: { album_id: album.id }, _max: { sort_order: true } });
    let sortOrder = currentMax._max.sort_order ?? -1;
    const images = [];
    for (const data of pending) {
      if (data.source_image_id && data.source_type === 'copied') {
        const freshSource = await getReferenceImageByIdForAccess(data.source_image_id, tx);
        if (!freshSource) throw new AuthError('来源已不可用', 403);
        const ceiling = await referenceCopyCeiling(user, freshSource, tx);
        if (!JSON.parse(ceiling).copy || ceiling !== data.rights_ceiling) throw new AuthError('来源权限已变化，请重新选择', 409);
      }
      images.push(await tx.referenceImage.create({ data: { ...data, sort_order: ++sortOrder } }));
    }
    if (!freshAlbum.cover_image_id && images[0]) {
      await tx.referenceAlbum.update({
        where: { id: album.id },
        data: { cover_image_id: images[0].id },
      });
    } else {
      await tx.referenceAlbum.update({ where: { id: album.id }, data: { updated_at: new Date() } });
    }

    await tx.operationLog.create({
      data: {
        operator_id: user.id,
        action: 'reference_album_add_assets',
        target_type: 'ReferenceAlbum',
        target_id: album.id,
        detail: JSON.stringify({ image_ids: images.map((image) => image.id), asset_ids: assetIds }),
      },
    });
    return images;
    });

    await recordAssetUploadLog({
      operatorId: user.id,
      stage: 'mount',
      status: 'succeeded',
      assetId: assetIds[0] || sourceReferenceImageIds[0] || null,
      durationMs: Date.now() - startedAt,
      uploadMode: 'single',
      totalParts: created.length,
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
      if (userId) {
        await recordAssetUploadLog({
          operatorId: userId,
          stage: 'mount',
          status: 'failed',
          durationMs: Date.now() - startedAt,
          errorCode: 'reference_asset_not_public',
          errorMessage: error.message,
        });
      }
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    if (userId) {
      await recordAssetUploadLog({
        operatorId: userId,
        stage: 'mount',
        status: 'failed',
        durationMs: Date.now() - startedAt,
        errorCode: 'reference_album_mount_failed',
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
      });
    }
    return apiErrorResponse(error);
  }
});

async function albumForWrite(tx: Prisma.TransactionClient, user: SessionUser, albumId: string) {
  const album = await tx.referenceAlbum.findFirst({ where: { id: albumId, status: { not: 'deleted' } }, include: {
    shares: { where: { status: 'active', OR: [{ expires_at: null }, { expires_at: { gt: new Date() } }] } },
  } });
  if (!album || user.status !== 'active') throw new AuthError('图集不存在或不可编辑', 403);
  const scoped = Boolean(album.project_id && (album.album_type === 'project' || album.visibility === 'project'));
  let canEdit = !scoped && (user.role === 'admin' || album.owner_user_id === user.id);
  const direct = album.shares.find((share) => share.grantee_type === 'user' && share.grantee_id === user.id);
  if (direct) canEdit ||= parseAlbumPermissions(direct.permissions_json).edit;
  for (const share of album.shares.filter((item) => item.grantee_type === 'project')) {
    const access = await getProjectAccess(user, share.grantee_id, tx);
    if (access.canView) canEdit ||= parseAlbumPermissions(share.permissions_json).edit;
  }
  if (album.project_id) {
    const projectAccess = await getProjectAccess(user, album.project_id, tx);
    if (projectAccess.project?.type !== 'personal') assertFeatureAllowed(user, 'team_project_manage');
    await assertProjectActiveInTransaction(tx, user, album.project_id, 'active');
    if (scoped) canEdit ||= projectAccess.canManageAssets;
  }
  if (!canEdit) throw new AuthError('无权编辑此图集', 403);
  return album;
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
