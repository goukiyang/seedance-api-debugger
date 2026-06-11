import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/session';
import { assertCanManageProjectAssets, getAccessibleProjectIds } from '@/lib/projects/permissions';
import { getAlbumAccess } from '@/lib/reference-albums/permissions';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const scope = request.nextUrl.searchParams.get('scope') || 'mine';
    const requestedProjectId = request.nextUrl.searchParams.get('project_id');
    const requestedPublicFolderId = request.nextUrl.searchParams.get('public_folder_id');
    const accessibleProjectIds = await getAccessibleProjectIds(user);
    const now = new Date();

    const baseWhere = user.role === 'admin'
      ? { status: 'active' }
      : {
          status: 'active',
          OR: [
            { owner_user_id: user.id },
            { project_id: { in: accessibleProjectIds } },
            { visibility: 'public' },
            { album_type: { in: ['public', 'system'] } },
            {
              shares: {
                some: {
                  status: 'active',
                  OR: [{ expires_at: null }, { expires_at: { gt: now } }],
                  AND: [
                    {
                      OR: [
                        { grantee_type: 'user', grantee_id: user.id },
                        { grantee_type: 'project', grantee_id: { in: accessibleProjectIds } },
                      ],
                    },
                  ],
                },
              },
            },
          ],
        };

    const albums = await prisma.referenceAlbum.findMany({
      where: baseWhere,
      orderBy: { updated_at: 'desc' },
      include: {
        owner: { select: { id: true, name: true, username: true, account_type: true } },
        project: { select: { id: true, name: true, owner_user_id: true, status: true } },
        publicFolder: { select: { id: true, name: true, description: true, sort_order: true, status: true } },
        shares: {
          where: {
            status: 'active',
            OR: [{ expires_at: null }, { expires_at: { gt: now } }],
          },
        },
        images: {
          where: { status: 'active' },
          orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }],
          select: { id: true },
          take: 1,
        },
        _count: { select: { images: { where: { status: 'active' } } } },
      },
    });

    const activeCoverIds = new Set(
      (
        await prisma.referenceImage.findMany({
          where: {
            id: {
              in: albums
                .map((album) => album.cover_image_id)
                .filter((id): id is string => Boolean(id)),
            },
            status: 'active',
          },
          select: { id: true },
        })
      ).map((image) => image.id),
    );
    const activeShareCounts = albums.length > 0
      ? await prisma.albumShare.groupBy({
          by: ['album_id'],
          where: {
            album_id: { in: albums.map((album) => album.id) },
            status: 'active',
            OR: [{ expires_at: null }, { expires_at: { gt: now } }],
          },
          _count: { id: true },
        })
      : [];
    const activeShareCountByAlbumId = new Map(
      activeShareCounts.map((item) => [item.album_id, item._count.id]),
    );

    const filtered = [];
    for (const album of albums) {
      if (!matchesScope(album, scope, user.id, accessibleProjectIds, requestedProjectId, requestedPublicFolderId)) continue;
      const access = await getAlbumAccess(user, album);
      if (!access.permissions.view) continue;
      filtered.push(serializeAlbum(album, access, activeCoverIds, activeShareCountByAlbumId.get(album.id) || 0));
    }

    return NextResponse.json({ albums: filtered });
  } catch (error) {
    console.error('[ReferenceAlbums] List error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const body = await request.json();
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return NextResponse.json({ error: '图集名称不能为空' }, { status: 400 });

    const description = typeof body.description === 'string' ? body.description.trim() || null : null;
    const requestedType = typeof body.album_type === 'string' ? body.album_type : 'personal';
    const projectId = typeof body.project_id === 'string' && body.project_id.trim() ? body.project_id.trim() : null;
    const publicFolderId = typeof body.public_folder_id === 'string' && body.public_folder_id.trim() ? body.public_folder_id.trim() : null;

    let albumType = 'personal';
    let visibility = 'private';
    let finalProjectId: string | null = null;
    let finalPublicFolderId: string | null = null;

    if (requestedType === 'project') {
      if (!projectId) return NextResponse.json({ error: '项目图集必须指定 project_id' }, { status: 400 });
      await assertCanManageProjectAssets(user, projectId);
      albumType = 'project';
      visibility = 'project';
      finalProjectId = projectId;
    } else if (requestedType === 'public' || requestedType === 'system') {
      if (user.role !== 'admin') return NextResponse.json({ error: '只有管理员可以创建公共图集' }, { status: 403 });
      if (!publicFolderId) return NextResponse.json({ error: '公共图集必须选择文件夹' }, { status: 400 });
      const folder = await prisma.referenceAlbumFolder.findFirst({
        where: { id: publicFolderId, scope: 'public', status: 'active' },
      });
      if (!folder) return NextResponse.json({ error: '公共文件夹不存在或已删除' }, { status: 404 });
      albumType = requestedType;
      visibility = 'public';
      finalPublicFolderId = publicFolderId;
    }

    const existing = await prisma.referenceAlbum.findFirst({
      where: {
        owner_user_id: user.id,
        project_id: finalProjectId,
        public_folder_id: finalPublicFolderId,
        album_type: albumType,
        name,
        status: 'active',
      },
      orderBy: { updated_at: 'desc' },
    });
    if (existing) {
      return NextResponse.json({ album: existing, deduplicated: true });
    }

    const album = await prisma.referenceAlbum.create({
      data: {
        owner_user_id: user.id,
        project_id: finalProjectId,
        public_folder_id: finalPublicFolderId,
        name,
        description,
        album_type: albumType,
        visibility,
        status: 'active',
      },
    });

    await prisma.operationLog.create({
      data: {
        operator_id: user.id,
        action: 'reference_album_create',
        target_type: 'ReferenceAlbum',
        target_id: album.id,
        detail: JSON.stringify({ album_type: albumType, project_id: finalProjectId }),
      },
    });

    return NextResponse.json({ album }, { status: 201 });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[ReferenceAlbums] Create error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

function matchesScope(
  album: {
    owner_user_id: string;
    project_id: string | null;
    public_folder_id: string | null;
    album_type: string;
    visibility: string;
    shares: Array<{ grantee_type: string; grantee_id: string }>;
  },
  scope: string,
  userId: string,
  accessibleProjectIds: string[],
  requestedProjectId: string | null,
  requestedPublicFolderId: string | null,
) {
  if (scope === 'all') return true;
  if (scope === 'mine') return album.owner_user_id === userId && album.album_type === 'personal';
  if (scope === 'project') {
    if (requestedProjectId) return album.project_id === requestedProjectId && album.album_type === 'project';
    return Boolean(album.project_id && accessibleProjectIds.includes(album.project_id) && album.album_type === 'project');
  }
  if (scope === 'shared') {
    return album.shares.some((share) => (
      (share.grantee_type === 'user' && share.grantee_id === userId) ||
      (share.grantee_type === 'project' && accessibleProjectIds.includes(share.grantee_id))
    ));
  }
  if (scope === 'public') {
    const isPublic = album.visibility === 'public' || ['public', 'system'].includes(album.album_type);
    if (!isPublic) return false;
    return requestedPublicFolderId ? album.public_folder_id === requestedPublicFolderId : true;
  }
  return true;
}

function serializeAlbum(
  album: {
    id: string;
    workspace_id: string | null;
    project_id: string | null;
    public_folder_id: string | null;
    owner_user_id: string;
    name: string;
    description: string | null;
    album_type: string;
    visibility: string;
    cover_image_id: string | null;
    status: string;
    created_at: Date;
    updated_at: Date;
    owner: { id: string; name: string; username: string; account_type: string };
    project: { id: string; name: string; owner_user_id: string; status: string } | null;
    publicFolder: { id: string; name: string; description: string | null; sort_order: number; status: string } | null;
    images: Array<{ id: string }>;
    _count: { images: number };
  },
  access: Awaited<ReturnType<typeof getAlbumAccess>>,
  activeCoverIds: Set<string>,
  activeShareCount: number,
) {
  const coverImageId = album.cover_image_id && activeCoverIds.has(album.cover_image_id)
    ? album.cover_image_id
    : album.images[0]?.id || null;

  return {
    id: album.id,
    workspace_id: album.workspace_id,
    project_id: album.project_id,
    public_folder_id: album.public_folder_id,
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
    public_folder: album.publicFolder,
    image_count: album._count.images,
    permissions: access.permissions,
    can_share: access.canShare,
    active_share_count: activeShareCount,
    access_role: access.role,
  };
}
