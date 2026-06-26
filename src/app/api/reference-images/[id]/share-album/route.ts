import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { AuthError, getSession } from '@/lib/auth/session';
import {
  canCopyAlbumImage,
  getReferenceImageByIdForAccess,
} from '@/lib/reference-albums/permissions';

export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const sourceImage = await getReferenceImageByIdForAccess(params.id);
    if (!sourceImage) return NextResponse.json({ error: '参考图不存在' }, { status: 404 });
    if (!(await canCopyAlbumImage(user, sourceImage))) {
      return NextResponse.json({ error: '无权复制此参考图用于共享' }, { status: 403 });
    }

    const body = await request.json().catch(() => ({}));
    const requestedName = typeof body.name === 'string' ? body.name.trim() : '';
    const requestedDescription = typeof body.description === 'string' ? body.description.trim() : '';
    const sourceName = sourceImage.asset?.file_name || sourceImage.album.name || '参考图';
    const albumName = normalizeAlbumName(requestedName || `单图共享 - ${stripExtension(sourceName)}`);
    const description = requestedDescription || `来自图集「${sourceImage.album.name}」的单张图片共享副本`;

    const created = await prisma.$transaction(async (tx) => {
      const album = await tx.referenceAlbum.create({
        data: {
          owner_user_id: user.id,
          name: albumName,
          description,
          album_type: 'personal',
          visibility: 'private',
          status: 'active',
        },
      });

      const image = await tx.referenceImage.create({
        data: {
          album_id: album.id,
          owner_user_id: user.id,
          asset_id: sourceImage.asset_id,
          url: sourceImage.url,
          thumbnail_url: sourceImage.thumbnail_url,
          source_type: 'copied',
          source_content_id: sourceImage.source_content_id,
          source_image_id: sourceImage.id,
          sort_order: 0,
          metadata_json: JSON.stringify({
            copied_from_album_id: sourceImage.album_id,
            copied_from_image_id: sourceImage.id,
            created_for: 'single_image_share',
          }),
          status: 'active',
        },
      });

      const updatedAlbum = await tx.referenceAlbum.update({
        where: { id: album.id },
        data: { cover_image_id: image.id },
      });

      await tx.operationLog.create({
        data: {
          operator_id: user.id,
          action: 'reference_image_single_share_album_create',
          target_type: 'ReferenceAlbum',
          target_id: updatedAlbum.id,
          detail: JSON.stringify({
            source_image_id: sourceImage.id,
            source_album_id: sourceImage.album_id,
            copied_image_id: image.id,
          }),
        },
      });

      return updatedAlbum;
    });

    return NextResponse.json({
      album: {
        id: created.id,
        name: created.name,
        description: created.description,
        album_type: created.album_type,
        visibility: created.visibility,
        active_share_count: 0,
      },
    }, { status: 201 });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[ReferenceImages] Create single share album error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

function normalizeAlbumName(name: string) {
  const normalized = name.trim().slice(0, 80);
  return normalized || '单图共享';
}

function stripExtension(fileName: string) {
  return fileName.replace(/\.[^.]+$/, '').slice(0, 60) || fileName;
}
