import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/session';
import { assertCanManageProjectMembers, normalizeProjectRole, logProjectAction } from '@/lib/projects/permissions';

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const access = await assertCanManageProjectMembers(user, params.id);
    if (access.project?.status === 'archived') {
      return NextResponse.json({ error: '归档项目为只读，请先恢复后再创建邀请' }, { status: 400 });
    }

    const body = await request.json().catch(() => ({}));
    const defaultRole = normalizeProjectRole(body.default_role);
    const expiresDays = Number(body.expires_days || 7);
    const expiresAt = Number.isFinite(expiresDays) && expiresDays > 0
      ? new Date(Date.now() + expiresDays * 24 * 60 * 60 * 1000)
      : null;

    const invite = await prisma.projectInvite.create({
      data: {
        project_id: params.id,
        token: crypto.randomBytes(24).toString('hex'),
        default_role: defaultRole === 'project_owner' ? 'member' : defaultRole,
        allowed_account_type: typeof body.allowed_account_type === 'string' ? body.allowed_account_type : null,
        max_uses: Number.isInteger(body.max_uses) && body.max_uses > 0 ? body.max_uses : null,
        expires_at: expiresAt,
        require_approval: false,
        created_by: user.id,
        status: 'active',
      },
    });

    await logProjectAction(user.id, 'project_invite_create', 'project', params.id, {
      invite_id: invite.id,
      default_role: invite.default_role,
      expires_at: invite.expires_at,
    });

    return NextResponse.json({
      invite,
      join_url: `/join/${invite.token}`,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[ProjectInvites] Create error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
