import { route as apiRoute } from '@/lib/http/route';
import { apiErrorResponse } from '@/lib/http/api-error';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/session';
import { readAlbumCover, readAlbumImagePage } from '@/lib/reference-albums/image-page';
import { assertPageOwner, PaginationError } from '@/lib/pagination/cursor';
import {
  assertCanEditAlbum,
  assertCanViewAlbum,
  getAlbumAccess,
} from '@/lib/reference-albums/permissions';

export const dynamic = 'force-dynamic';

export const GET = apiRoute({ access: 'user', rateLimit: false }, async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
    assertPageOwner(request.headers, user.id);

    const album = await assertCanViewAlbum(user, params.id);
    const access = await getAlbumAccess(user, album);
    const publicFolder = album.public_folder_id
      ? await prisma.referenceAlbumFolder.findUnique({
          where: { id: album.public_folder_id },
          select: { id: true, name: true, description: true, sort_order: true, status: true },
        })
      : null;
    const page = await readAlbumImagePage(user, album, request.nextUrl.searchParams);
    const coverImageId = await readAlbumCover(user, album, page.images[0]?.id || null);
    const activeShareCount = await prisma.albumShare.count({
      where: {
        album_id: album.id,
        status: 'active',
        OR: [{ expires_at: null }, { expires_at: { gt: new Date() } }],
      },
    });

    return NextResponse.json({
      album: {
        id: album.id,
        workspace_id: album.workspace_id,
        project_id: album.project_id,
        public_folder_id: album.public_folder_id,
        owner_user_id: album.owner_user_id,
        name: album.name,
        description: album.description,
        album_type: album.album_type,
        visibility: album.visibility,
        cover_image_id: coverImageId,
        cover_image_url: coverImageId ? `/api/reference-images/${coverImageId}/content?variant=thumbnail` : null,
        status: album.status,
        created_at: album.created_at,
        updated_at: album.updated_at,
        owner: album.owner,
        project: album.project,
        public_folder: publicFolder,
        image_count: page.pagination.total,
        permissions: access.permissions,
        can_share: access.canShare,
        active_share_count: activeShareCount,
        access_role: access.role,
      },
      images: page.images,
      pagination: page.pagination,
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    if (error instanceof AuthError || error instanceof PaginationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    return apiErrorResponse(error);
  }
});

export const PATCH = apiRoute({ access: 'user', rateLimit: false }, async function PATCH(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const albumForAccess = await assertCanEditAlbum(user, params.id);
    const body = await request.json();
    const data: { name?: string; description?: string | null; status?: string; public_folder_id?: string | null } = {};

    if (typeof body.name === 'string') {
      const name = body.name.trim();
      if (!name) return NextResponse.json({ error: '图集名称不能为空' }, { status: 400 });
      data.name = name;
    }
    if (typeof body.description === 'string') data.description = body.description.trim() || null;
    if (['active', 'archived'].includes(body.status)) data.status = body.status;
    if (typeof body.public_folder_id === 'string') {
      if (albumForAccess.album_type !== 'public' && albumForAccess.album_type !== 'system') {
        return NextResponse.json({ error: '只有公共图集可以移动公共文件夹' }, { status: 400 });
      }
      const folderId = body.public_folder_id.trim();
      if (!folderId) {
        data.public_folder_id = null;
      } else {
        const folder = await prisma.referenceAlbumFolder.findFirst({
          where: { id: folderId, scope: 'public', status: 'active' },
        });
        if (!folder) return NextResponse.json({ error: '公共文件夹不存在或已删除' }, { status: 404 });
        data.public_folder_id = folder.id;
      }
    }

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

    return apiErrorResponse(error);
  }
});

export const DELETE = apiRoute({ access: 'user', rateLimit: false }, async function DELETE(_request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
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

    return apiErrorResponse(error);
  }
});
