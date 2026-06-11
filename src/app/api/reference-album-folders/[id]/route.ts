import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

async function assertAdmin() {
  const user = await getSession();
  if (!user) return { error: NextResponse.json({ error: '未登录' }, { status: 401 }), user: null };
  if (user.role !== 'admin') return { error: NextResponse.json({ error: '只有管理员可以管理公共文件夹' }, { status: 403 }), user: null };
  return { error: null, user };
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const { error, user } = await assertAdmin();
    if (error) return error;
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const body = await request.json();
    const data: { name?: string; description?: string | null; sort_order?: number; status?: string } = {};
    if (typeof body.name === 'string') {
      const name = body.name.trim();
      if (!name) return NextResponse.json({ error: '文件夹名称不能为空' }, { status: 400 });
      data.name = name;
    }
    if (typeof body.description === 'string') data.description = body.description.trim() || null;
    if (Number.isFinite(body.sort_order)) data.sort_order = Number(body.sort_order);
    if (['active', 'archived'].includes(body.status)) data.status = body.status;
    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: '没有可更新的字段' }, { status: 400 });
    }

    const folder = await prisma.referenceAlbumFolder.update({
      where: { id: params.id },
      data,
    });

    await prisma.operationLog.create({
      data: {
        operator_id: user.id,
        action: 'reference_album_folder_update',
        target_type: 'ReferenceAlbumFolder',
        target_id: folder.id,
        detail: JSON.stringify(data),
      },
    });

    return NextResponse.json({ folder });
  } catch (error) {
    console.error('[ReferenceAlbumFolders] Update error:', error);
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
    const { error, user } = await assertAdmin();
    if (error) return error;
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const activeAlbumCount = await prisma.referenceAlbum.count({
      where: {
        public_folder_id: params.id,
        album_type: 'public',
        visibility: 'public',
        status: 'active',
      },
    });
    if (activeAlbumCount > 0) {
      return NextResponse.json({ error: '文件夹内还有公共图集，请先移动或归档图集' }, { status: 400 });
    }

    const folder = await prisma.referenceAlbumFolder.update({
      where: { id: params.id },
      data: { status: 'deleted' },
    });

    await prisma.operationLog.create({
      data: {
        operator_id: user.id,
        action: 'reference_album_folder_delete',
        target_type: 'ReferenceAlbumFolder',
        target_id: folder.id,
        detail: JSON.stringify({ soft_delete: true }),
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[ReferenceAlbumFolders] Delete error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
