import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { prisma } from '@/lib/prisma';
import { AuthError, getSession, type SessionUser } from '@/lib/auth/session';
import { uploadSiteAsset, validateSiteUploadInput } from '@/lib/assets/site-upload';
import {
  assertCanEditAlbum,
  canCopyAlbumImage,
  assertCanViewAlbum,
  canUseDirectAsset,
  getReferenceImageByIdForAccess,
} from '@/lib/reference-albums/permissions';

export const dynamic = 'force-dynamic';

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
      return uploadFilesToAlbum(request, album, user);
    }

    const body = await request.json();
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

      sortOrder += 1;
      const image = await prisma.referenceImage.create({
        data: {
          album_id: album.id,
          workspace_id: album.workspace_id,
          project_id: album.project_id,
          owner_user_id: user.id,
          asset_id: sourceImage.asset_id,
          url: sourceImage.url,
          thumbnail_url: sourceImage.thumbnail_url,
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

      const asset = await prisma.asset.findUnique({ where: { id: assetId } });
      if (!asset || asset.type !== 'image') {
        return NextResponse.json({ error: `素材不存在或不是图片: ${assetId}` }, { status: 400 });
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
        action: 'reference_album_add_images',
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

type EditableAlbum = Awaited<ReturnType<typeof assertCanEditAlbum>>;

type AlbumImageAsset = {
  id: string;
  type: string;
  original_url: string;
  thumbnail_url: string | null;
  file_name: string;
};

function computeUploadHash(buffer: Buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function createAlbumImageFromAsset(params: {
  album: EditableAlbum;
  user: SessionUser;
  asset: AlbumImageAsset;
  sortOrder: number;
  sourceType: string;
  sourceContentId?: string | null;
  sourceImageId?: string | null;
  metadata?: Record<string, unknown> | null;
}) {
  const { album, user, asset, sortOrder, sourceType, sourceContentId, sourceImageId, metadata } = params;
  return prisma.referenceImage.create({
    data: {
      album_id: album.id,
      workspace_id: album.workspace_id,
      project_id: album.project_id,
      owner_user_id: user.id,
      asset_id: asset.id,
      url: asset.original_url,
      thumbnail_url: asset.thumbnail_url,
      source_type: sourceType,
      source_content_id: sourceContentId || null,
      source_image_id: sourceImageId || null,
      sort_order: sortOrder,
      metadata_json: metadata ? JSON.stringify(metadata) : null,
      status: 'active',
    },
  });
}

function serializeAlbumImages(images: Awaited<ReturnType<typeof prisma.referenceImage.create>>[]) {
  return images.map((image) => ({
    ...image,
    image_url: `/api/reference-images/${image.id}/content`,
    thumbnail_url: `/api/reference-images/${image.id}/content?variant=thumbnail`,
    url: undefined,
  }));
}

async function uploadFilesToAlbum(
  request: NextRequest,
  album: EditableAlbum,
  user: SessionUser,
) {
  const formData = await request.formData();
  const files = formData
    .getAll('file')
    .filter((value): value is File => (
      typeof value === 'object'
      && value !== null
      && 'arrayBuffer' in value
      && 'size' in value
      && Number((value as File).size) > 0
    ));

  if (files.length === 0) {
    return NextResponse.json({ error: '请选择要上传的图片' }, { status: 400 });
  }

  const currentMax = await prisma.referenceImage.aggregate({
    where: { album_id: album.id },
    _max: { sort_order: true },
  });
  let sortOrder = currentMax._max.sort_order ?? -1;
  const created = [];
  const reusedAssetIds: string[] = [];

  for (const file of files) {
    if (!file.type.startsWith('image/')) {
      return NextResponse.json({ error: `图集只能上传图片文件: ${file.name}` }, { status: 400 });
    }
    const validationError = validateSiteUploadInput(file);
    if (validationError) return NextResponse.json({ error: validationError }, { status: 400 });

    const buffer = Buffer.from(await file.arrayBuffer());
    const hash = computeUploadHash(buffer);
    const uploadResult = await uploadSiteAsset(buffer, file.name, file.type, file.size, user.id);
    const asset = await prisma.asset.findUnique({
      where: { id: uploadResult.assetId },
      select: {
        id: true,
        type: true,
        original_url: true,
        thumbnail_url: true,
        file_name: true,
      },
    });
    if (!asset || asset.type !== 'image') {
      return NextResponse.json({ error: `图片上传后未生成有效素材: ${file.name}` }, { status: 500 });
    }

    sortOrder += 1;
    const image = await createAlbumImageFromAsset({
      album,
      user,
      asset,
      sortOrder,
      sourceType: 'upload',
      metadata: {
        source: 'album_file_upload',
        original_file_name: file.name,
        upload_hash: hash,
        reused_existing_asset: uploadResult.reused,
      },
    });
    if (uploadResult.reused) reusedAssetIds.push(asset.id);
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
      action: 'reference_album_upload_images',
      target_type: 'ReferenceAlbum',
      target_id: album.id,
      detail: JSON.stringify({
        image_ids: created.map((image) => image.id),
        asset_ids: created.map((image) => image.asset_id).filter(Boolean),
        reused_asset_ids: reusedAssetIds,
      }),
    },
  });

  return NextResponse.json({
    images: serializeAlbumImages(created),
    reused_asset_ids: reusedAssetIds,
  }, { status: 201 });
}
