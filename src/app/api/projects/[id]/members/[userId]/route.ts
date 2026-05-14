import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/session';
import { assertCanManageProjectMembers, assertCanViewProject, logProjectAction } from '@/lib/projects/permissions';

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string; userId: string } },
) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const access = params.userId === user.id
      ? await assertCanViewProject(user, params.id)
      : await assertCanManageProjectMembers(user, params.id);

    if (access.project?.status === 'archived') {
      return NextResponse.json({ error: '归档项目为只读，请先恢复后再修改成员' }, { status: 400 });
    }

    if (access.project?.owner_user_id === params.userId) {
      return NextResponse.json({ error: '不能移除项目负责人' }, { status: 400 });
    }

    const member = await prisma.projectMember.update({
      where: { project_id_user_id: { project_id: params.id, user_id: params.userId } },
      data: { status: 'removed' },
    });

    await logProjectAction(user.id, 'project_member_remove', 'project', params.id, {
      user_id: params.userId,
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
