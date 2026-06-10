import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/session';
import {
  assertCanEditAlbum,
  assertCanViewAlbum,
  getAlbumAccess,
} from '@/lib/reference-albums/permissions';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const album = await assertCanViewAlbum(user, params.id);
    const access = await getAlbumAccess(user, album);
    const images = await prisma.referenceImage.findMany({
      where: { album_id: album.id, status: 'active' },
      orderBy: { sort_order: 'asc' },
      include: { asset: { select: { id: true, type: true, file_name: true, width: true, height: true, file_size: true, mime_type: true } } },
    });
    const coverImageId = album.cover_image_id && images.some((image) => image.id === album.cover_image_id)
      ? album.cover_image_id
      : images[0]?.id || null;

    return NextResponse.json({
      album: {
        id: album.id,
        workspace_id: album.workspace_id,
        project_id: album.project_id,
        owner_user_id: album.owner_user_id,
        name: album.name,
        description: album.description,
        album_type: album.album_type,
        visibility: album.visibility,
        cover_image_id: album.cover_image_id,
        cover_image_url: coverImageId ? `/api/reference-images/${coverImageId}/content?variant=thumbnail` : null,
        status: album.status,
        created_at: album.created_at,
        updated_at: album.updated_at,
        owner: album.owner,
        project: album.project,
        image_count: album._count.images,
        permissions: access.permissions,
        can_share: access.canShare,
        access_role: access.role,
      },
      images: images.map((image) => ({
        id: image.id,
        album_id: image.album_id,
        asset_id: image.asset_id,
        source_type: image.source_type,
        source_content_id: image.source_content_id,
        source_image_id: image.source_image_id,
        sort_order: image.sort_order,
        metadata_json: access.permissions.viewSource ? image.metadata_json : null,
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
    console.error('[ReferenceAlbums] Detail error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    await assertCanEditAlbum(user, params.id);
    const body = await request.json();
    const data: { name?: string; description?: string | null; status?: string } = {};

    if (typeof body.name === 'string') {
      const name = body.name.trim();
      if (!name) return NextResponse.json({ error: '图集名称不能为空' }, { status: 400 });
      data.name = name;
    }
    if (typeof body.description === 'string') data.description = body.description.trim() || null;
    if (['active', 'archived'].includes(body.status)) data.status = body.status;

    const album = await prisma.referenceAlbum.update({
      where: { id: params.id },
      data,
    });

    await prisma.operationLog.create({
      data: {
        operator_id: user.id,
        action: 'reference_album_update',
        target_type: 'ReferenceAlbum',
        target_id: album.id,
        detail: JSON.stringify(data),
      },
    });

    return NextResponse.json({ album });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[ReferenceAlbums] Update error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    await assertCanEditAlbum(user, params.id);
    await prisma.referenceAlbum.update({
      where: { id: params.id },
      data: { status: 'archived' },
    });

    await prisma.operationLog.create({
      data: {
        operator_id: user.id,
        action: 'reference_album_archive',
        target_type: 'ReferenceAlbum',
        target_id: params.id,
        detail: JSON.stringify({ preserved_reference_images: true }),
      },
    });

    return NextResponse.json({ success: true, archived: true });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[ReferenceAlbums] Delete error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
