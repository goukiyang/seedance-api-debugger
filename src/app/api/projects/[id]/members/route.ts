import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/session';
import { assertProjectActiveInTransaction, normalizeProjectRole, logProjectActionInTransaction } from '@/lib/projects/permissions';

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const body = await request.json();
    const targetUserId = typeof body.user_id === 'string' ? body.user_id : '';
    if (!targetUserId) return NextResponse.json({ error: 'user_id 为必填' }, { status: 400 });

    const member = await prisma.$transaction(async (tx) => {
    const access = await assertProjectActiveInTransaction(tx, user, params.id, 'members');
    const targetUser = await tx.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, status: true },
    });
    if (!targetUser) throw new AuthError('用户不存在', 404);
    if (targetUser.status !== 'active') throw new AuthError('禁用或非 active 用户不能加入项目', 403);

    const role = normalizeProjectRole(body.role);
    if (access?.project?.owner_user_id === targetUserId && role !== 'project_owner') throw new AuthError('不能修改项目负责人的角色', 400);
    const updated = await tx.projectMember.upsert({
      where: { project_id_user_id: { project_id: params.id, user_id: targetUserId } },
      update: { role, status: 'active', joined_by: user.id, joined_at: new Date() },
      create: {
        project_id: params.id,
        user_id: targetUserId,
        role,
        joined_by: user.id,
      },
    });

    await logProjectActionInTransaction(tx, user.id, 'project_member_add', 'project', params.id, {
      user_id: targetUserId,
      role,
    });
    return updated;
    });

    return NextResponse.json({ member });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[ProjectMembers] Add error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
