import { route as apiRoute } from '@/lib/http/route';
import { apiErrorResponse } from '@/lib/http/api-error';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { assertPageOwner, PaginationError } from '@/lib/pagination/cursor';
import { readFolderPage } from '@/lib/reference-albums/governance-page';

export const dynamic = 'force-dynamic';

function serializeFolder(folder: {
  id: string;
  name: string;
  description: string | null;
  scope: string;
  sort_order: number;
  status: string;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}, albumCount: number) {
  return {
    id: folder.id,
    name: folder.name,
    description: folder.description,
    scope: folder.scope,
    sort_order: folder.sort_order,
    status: folder.status,
    created_by: folder.created_by,
    created_at: folder.created_at,
    updated_at: folder.updated_at,
    album_count: albumCount,
  };
}

export const GET = apiRoute({ access: 'user', rateLimit: false }, async function GET(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    assertPageOwner(request.headers, user.id);
    const { items: folders, pagination } = await readFolderPage(user, request.nextUrl.searchParams);

    const counts = folders.length > 0
      ? await prisma.referenceAlbum.groupBy({
          by: ['public_folder_id'],
          where: {
            public_folder_id: { in: folders.map((folder) => folder.id) },
            album_type: 'public',
            visibility: 'public',
            status: 'active',
          },
          _count: { id: true },
        })
      : [];
    const countByFolderId = new Map(counts.map((row) => [row.public_folder_id, row._count.id]));

    return NextResponse.json({
      folders: folders.map((folder) => serializeFolder(folder, countByFolderId.get(folder.id) || 0)),
      can_manage: user.role === 'admin',
      pagination,
    });
  } catch (error) {
    if (error instanceof PaginationError) return NextResponse.json({ error: error.message }, { status: error.status });
    return apiErrorResponse(error);
  }
});

export const POST = apiRoute({ access: 'user', rateLimit: false }, async function POST(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
    if (user.role !== 'admin') return NextResponse.json({ error: '只有管理员可以创建公共文件夹' }, { status: 403 });

    const body = await request.json();
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return NextResponse.json({ error: '文件夹名称不能为空' }, { status: 400 });
    const description = typeof body.description === 'string' ? body.description.trim() || null : null;

    const currentMax = await prisma.referenceAlbumFolder.aggregate({
      where: { scope: 'public', status: 'active' },
      _max: { sort_order: true },
    });

    const folder = await prisma.referenceAlbumFolder.create({
      data: {
        name,
        description,
        scope: 'public',
        sort_order: (currentMax._max.sort_order ?? -1) + 1,
        status: 'active',
        created_by: user.id,
      },
    });

    await prisma.operationLog.create({
      data: {
        operator_id: user.id,
        action: 'reference_album_folder_create',
        target_type: 'ReferenceAlbumFolder',
        target_id: folder.id,
        detail: JSON.stringify({ name }),
      },
    });

    return NextResponse.json({ folder: serializeFolder(folder, 0) }, { status: 201 });
  } catch (error) {

    return apiErrorResponse(error);
  }
});
