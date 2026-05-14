import { NextRequest, NextResponse } from 'next/server';
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
      return NextResponse.json({ error: '归档项目为只读，请先恢复后再修改成员' }, { status: 400 });
    }

    const body = await request.json();
    const targetUserId = typeof body.user_id === 'string' ? body.user_id : '';
    if (!targetUserId) return NextResponse.json({ error: 'user_id 为必填' }, { status: 400 });

    const targetUser = await prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, status: true },
    });
    if (!targetUser) return NextResponse.json({ error: '用户不存在' }, { status: 404 });
    if (targetUser.status !== 'active') return NextResponse.json({ error: '禁用或非 active 用户不能加入项目' }, { status: 403 });

    const role = normalizeProjectRole(body.role);
    const member = await prisma.projectMember.upsert({
      where: { project_id_user_id: { project_id: params.id, user_id: targetUserId } },
      update: { role, status: 'active', joined_by: user.id, joined_at: new Date() },
      create: {
        project_id: params.id,
        user_id: targetUserId,
        role,
        joined_by: user.id,
      },
    });

    await logProjectAction(user.id, 'project_member_add', 'project', params.id, {
      user_id: targetUserId,
      role,
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
