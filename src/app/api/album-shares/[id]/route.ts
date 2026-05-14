import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/session';
import { assertCanShareAlbum } from '@/lib/reference-albums/permissions';

export const dynamic = 'force-dynamic';

export async function DELETE(
  _request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const share = await prisma.albumShare.findUnique({ where: { id: params.id } });
    if (!share) return NextResponse.json({ error: '共享记录不存在' }, { status: 404 });
    await assertCanShareAlbum(user, share.album_id);

    await prisma.albumShare.update({
      where: { id: share.id },
      data: { status: 'revoked' },
    });

    const activeCount = await prisma.albumShare.count({
      where: { album_id: share.album_id, status: 'active' },
    });
    if (activeCount === 0) {
      const album = await prisma.referenceAlbum.findUnique({ where: { id: share.album_id } });
      if (album?.visibility === 'shared') {
        await prisma.referenceAlbum.update({
          where: { id: share.album_id },
          data: { visibility: album.album_type === 'project' ? 'project' : 'private' },
        });
      }
    }

    await prisma.operationLog.create({
      data: {
        operator_id: user.id,
        action: 'reference_album_share_revoke',
        target_type: 'AlbumShare',
        target_id: share.id,
        detail: JSON.stringify({ album_id: share.album_id, grantee_type: share.grantee_type, grantee_id: share.grantee_id }),
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[AlbumShares] Revoke error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
