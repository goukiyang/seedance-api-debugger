import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/session';
import {
  assertCanShareAlbum,
  normalizeAlbumPermissions,
  parseAlbumPermissions,
  serializeAlbumPermissions,
} from '@/lib/reference-albums/permissions';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const now = new Date();
    await assertCanShareAlbum(user, params.id);
    const shares = await prisma.albumShare.findMany({
      where: {
        album_id: params.id,
        status: 'active',
        OR: [{ expires_at: null }, { expires_at: { gt: now } }],
      },
      orderBy: { created_at: 'desc' },
    });
    const grantees = await loadShareGrantees(shares);

    return NextResponse.json({ shares: shares.map((share) => serializeShare(share, grantees)) });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[AlbumShares] List error:', error);
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

    const album = await assertCanShareAlbum(user, params.id);
    const body = await request.json();
    const granteeType = body.grantee_type === 'project' ? 'project' : 'user';
    const granteeId = typeof body.grantee_id === 'string' ? body.grantee_id.trim() : '';
    if (!granteeId) return NextResponse.json({ error: 'grantee_id required' }, { status: 400 });

    let permissions = normalizeAlbumPermissions(body.permissions);
    if (granteeType === 'user') {
      const grantee = await prisma.user.findUnique({ where: { id: granteeId }, select: { id: true, status: true, account_type: true } });
      if (!grantee || grantee.status === 'disabled') return NextResponse.json({ error: '共享用户不存在或不可用' }, { status: 400 });
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
      const project = await prisma.project.findUnique({ where: { id: granteeId }, select: { id: true, status: true } });
      if (!project || project.status === 'deleted') return NextResponse.json({ error: '共享项目不存在' }, { status: 400 });
    }

    const expiresAt = body.expires_at ? new Date(body.expires_at) : null;
    if (expiresAt && Number.isNaN(expiresAt.getTime())) {
      return NextResponse.json({ error: 'expires_at invalid' }, { status: 400 });
    }
    const share = await prisma.albumShare.upsert({
      where: {
        album_id_grantee_type_grantee_id: {
          album_id: album.id,
          grantee_type: granteeType,
          grantee_id: granteeId,
        },
      },
      update: {
        permissions_json: serializeAlbumPermissions(permissions),
        expires_at: expiresAt,
        status: 'active',
      },
      create: {
        album_id: album.id,
        grantee_type: granteeType,
        grantee_id: granteeId,
        permissions_json: serializeAlbumPermissions(permissions),
        created_by: user.id,
        expires_at: expiresAt,
        status: 'active',
      },
    });

    if (album.visibility === 'private') {
      await prisma.referenceAlbum.update({
        where: { id: album.id },
        data: { visibility: 'shared' },
      });
    }

    await prisma.operationLog.create({
      data: {
        operator_id: user.id,
        action: 'reference_album_share',
        target_type: 'ReferenceAlbum',
        target_id: album.id,
        detail: JSON.stringify({ share_id: share.id, grantee_type: granteeType, grantee_id: granteeId }),
      },
    });

    const grantees = await loadShareGrantees([share]);

    return NextResponse.json({ share: serializeShare(share, grantees) }, { status: 201 });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[AlbumShares] Create error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

type ShareRecord = Awaited<ReturnType<typeof prisma.albumShare.findMany>>[number];

type ShareGrantee = {
  id: string;
  type: string;
  label: string;
  subtitle?: string | null;
  status?: string | null;
  account_type?: string | null;
};

async function loadShareGrantees(shares: ShareRecord[]) {
  const userIds = uniqueIds(shares.filter((share) => share.grantee_type === 'user').map((share) => share.grantee_id));
  const projectIds = uniqueIds(shares.filter((share) => share.grantee_type === 'project').map((share) => share.grantee_id));
  const [users, projects] = await Promise.all([
    userIds.length > 0
      ? prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true, username: true, email: true, status: true, account_type: true },
        })
      : [],
    projectIds.length > 0
      ? prisma.project.findMany({
          where: { id: { in: projectIds } },
          select: { id: true, name: true, status: true },
        })
      : [],
  ]);

  const grantees = new Map<string, ShareGrantee>();
  for (const user of users) {
    grantees.set(`user:${user.id}`, {
      id: user.id,
      type: 'user',
      label: user.name || user.username || user.email || user.id,
      subtitle: user.email || user.username,
      status: user.status,
      account_type: user.account_type,
    });
  }
  for (const project of projects) {
    grantees.set(`project:${project.id}`, {
      id: project.id,
      type: 'project',
      label: project.name,
      status: project.status,
    });
  }
  return grantees;
}

function serializeShare(share: ShareRecord, grantees: Map<string, ShareGrantee>) {
  return {
    id: share.id,
    album_id: share.album_id,
    grantee_type: share.grantee_type,
    grantee_id: share.grantee_id,
    permissions_json: share.permissions_json,
    permissions: parseAlbumPermissions(share.permissions_json),
    created_by: share.created_by,
    expires_at: share.expires_at,
    status: share.status,
    created_at: share.created_at,
    grantee: grantees.get(`${share.grantee_type}:${share.grantee_id}`) || null,
  };
}

function uniqueIds(ids: string[]) {
  return Array.from(new Set(ids.filter(Boolean)));
}
