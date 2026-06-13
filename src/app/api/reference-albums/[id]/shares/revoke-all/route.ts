import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/session';
import { assertCanShareAlbum } from '@/lib/reference-albums/permissions';

export const dynamic = 'force-dynamic';

export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const album = await assertCanShareAlbum(user, params.id);
    const result = await prisma.albumShare.updateMany({
      where: { album_id: album.id, status: 'active' },
      data: { status: 'revoked' },
    });

    if (album.visibility === 'shared') {
      await prisma.referenceAlbum.update({
        where: { id: album.id },
        data: { visibility: album.album_type === 'project' ? 'project' : 'private' },
      });
    }

    await prisma.operationLog.create({
      data: {
        operator_id: user.id,
        action: 'reference_album_share_revoke_all',
        target_type: 'ReferenceAlbum',
        target_id: album.id,
        detail: JSON.stringify({ revoked_count: result.count }),
      },
    });

    return NextResponse.json({ success: true, revoked_count: result.count });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[AlbumShares] Revoke all error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
