import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/session';
import { assertProjectActiveInTransaction, getProjectAccess, logProjectActionInTransaction } from '@/lib/projects/permissions';
import { assertFeatureAllowed } from '@/lib/access/feature-guard';

export async function DELETE(
  request: NextRequest,
  props: { params: Promise<{ id: string; userId: string }> }
) {
  const params = await props.params;
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    assertFeatureAllowed(user, 'team_project_manage');
    const member = await prisma.$transaction(async (tx) => {
    const access = params.userId === user.id
      ? await getProjectAccess(user, params.id, tx)
      : await assertProjectActiveInTransaction(tx, user, params.id, 'members');
    if (!access?.canView || access.project?.status !== 'active') throw new AuthError('项目不可修改或无权访问', 403);

    if (access.project?.owner_user_id === params.userId) {
      throw new AuthError('不能移除项目负责人', 400);
    }

    const updated = await tx.projectMember.update({
      where: { project_id_user_id: { project_id: params.id, user_id: params.userId } },
      data: { status: 'removed' },
    });

    await logProjectActionInTransaction(tx, user.id, 'project_member_remove', 'project', params.id, {
      user_id: params.userId,
    });
    return updated;
    });

    return NextResponse.json({ member });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[ProjectMembers] Remove error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
