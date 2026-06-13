import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/session';
import {
  assertCanShareAlbum,
  normalizeAlbumPermissions,
  serializeAlbumPermissions,
} from '@/lib/reference-albums/permissions';

export const dynamic = 'force-dynamic';

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const share = await prisma.albumShare.findUnique({ where: { id: params.id } });
    if (!share) return NextResponse.json({ error: '共享记录不存在' }, { status: 404 });
    await assertCanShareAlbum(user, share.album_id);

    const body = await request.json();
    const data: { permissions_json?: string; expires_at?: Date | null; status?: string } = {};

    if (body.permissions !== undefined) {
      let permissions = normalizeAlbumPermissions(body.permissions);
      if (share.grantee_type === 'user') {
        const grantee = await prisma.user.findUnique({
          where: { id: share.grantee_id },
          select: { status: true, account_type: true },
        });
        if (!grantee || grantee.status === 'disabled') {
          return NextResponse.json({ error: '共享用户不存在或不可用' }, { status: 400 });
        }
        if (grantee.account_type === 'external') {
          permissions = {
            ...permissions,
            copy: false,
            download: false,
            viewSource: false,
            edit: false,
          };
        }
      } else {
        const project = await prisma.project.findUnique({
          where: { id: share.grantee_id },
          select: { status: true },
        });
        if (!project || project.status === 'deleted') {
          return NextResponse.json({ error: '共享项目不存在' }, { status: 400 });
        }
      }
      data.permissions_json = serializeAlbumPermissions(permissions);
    }

    if (Object.prototype.hasOwnProperty.call(body, 'expires_at')) {
      if (!body.expires_at) {
        data.expires_at = null;
      } else {
        const expiresAt = new Date(body.expires_at);
        if (Number.isNaN(expiresAt.getTime())) {
          return NextResponse.json({ error: 'expires_at invalid' }, { status: 400 });
        }
        data.expires_at = expiresAt;
      }
    }

    if (body.status !== undefined) {
      if (!['active', 'revoked'].includes(body.status)) {
        return NextResponse.json({ error: 'status invalid' }, { status: 400 });
      }
      data.status = body.status;
    }

    const updatedShare = await prisma.albumShare.update({
      where: { id: share.id },
      data,
    });

    if (updatedShare.status === 'revoked') {
      await restoreAlbumVisibilityIfNoActiveShares(updatedShare.album_id);
    } else {
      await ensureSharedAlbumVisibility(updatedShare.album_id);
    }

    await prisma.operationLog.create({
      data: {
        operator_id: user.id,
        action: 'reference_album_share_update',
        target_type: 'AlbumShare',
        target_id: share.id,
        detail: JSON.stringify({
          album_id: share.album_id,
          grantee_type: share.grantee_type,
          grantee_id: share.grantee_id,
          updated_fields: Object.keys(data),
        }),
      },
    });

    return NextResponse.json({ share: updatedShare });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[AlbumShares] Update error:', error);
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

    const share = await prisma.albumShare.findUnique({ where: { id: params.id } });
    if (!share) return NextResponse.json({ error: '共享记录不存在' }, { status: 404 });
    await assertCanShareAlbum(user, share.album_id);

    await prisma.albumShare.update({
      where: { id: share.id },
      data: { status: 'revoked' },
    });

    await restoreAlbumVisibilityIfNoActiveShares(share.album_id);

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

async function restoreAlbumVisibilityIfNoActiveShares(albumId: string) {
  const activeCount = await prisma.albumShare.count({
    where: { album_id: albumId, status: 'active' },
  });
  if (activeCount > 0) return;

  const album = await prisma.referenceAlbum.findUnique({ where: { id: albumId } });
  if (album?.visibility === 'shared') {
    await prisma.referenceAlbum.update({
      where: { id: albumId },
      data: { visibility: album.album_type === 'project' ? 'project' : 'private' },
    });
  }
}

async function ensureSharedAlbumVisibility(albumId: string) {
  const album = await prisma.referenceAlbum.findUnique({ where: { id: albumId } });
  if (album?.visibility === 'private') {
    await prisma.referenceAlbum.update({
      where: { id: albumId },
      data: { visibility: 'shared' },
    });
  }
}
