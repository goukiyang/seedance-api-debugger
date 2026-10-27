import { route as apiRoute } from '@/lib/http/route';
import { apiErrorResponse } from '@/lib/http/api-error';
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/session';
import { assertProjectActiveInTransaction, normalizeProjectRole, logProjectActionInTransaction } from '@/lib/projects/permissions';

export const POST = apiRoute({ access: 'user', rateLimit: false }, async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const body = await request.json().catch(() => ({}));
    const defaultRole = normalizeProjectRole(body.default_role);
    const expiresDays = Number(body.expires_days || 7);
    const expiresAt = Number.isFinite(expiresDays) && expiresDays > 0
      ? new Date(Date.now() + expiresDays * 24 * 60 * 60 * 1000)
      : null;

    const invite = await prisma.$transaction(async (tx) => {
    await assertProjectActiveInTransaction(tx, user, params.id, 'members');
    const created = await tx.projectInvite.create({
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

    await logProjectActionInTransaction(tx, user.id, 'project_invite_create', 'project', params.id, {
      invite_id: created.id,
      default_role: created.default_role,
      expires_at: created.expires_at,
    });
    return created;
    });

    return NextResponse.json({
      invite,
      join_url: `/join/${invite.token}`,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    return apiErrorResponse(error);
  }
});
