import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { normalizeProjectRole, logProjectAction } from '@/lib/projects/permissions';

export async function POST(
  request: NextRequest,
  { params }: { params: { token: string } },
) {
  try {
    const user = await getSession();
    if (!user) {
      return NextResponse.json(
        { error: '未登录', message: '请先登录后再加入项目' },
        { status: 401 },
      );
    }

    const invite = await prisma.projectInvite.findUnique({
      where: { token: params.token },
      include: { project: true },
    });

    if (!invite || invite.status !== 'active') {
      return NextResponse.json({ error: '邀请链接无效或已停用' }, { status: 404 });
    }
    if (invite.expires_at && invite.expires_at.getTime() <= Date.now()) {
      return NextResponse.json({ error: '邀请链接已过期' }, { status: 410 });
    }
    if (invite.max_uses !== null && invite.used_count >= invite.max_uses) {
      return NextResponse.json({ error: '邀请链接使用次数已达上限' }, { status: 410 });
    }
    if (invite.allowed_account_type && invite.allowed_account_type !== user.account_type) {
      return NextResponse.json({ error: '当前账号类型不允许加入此项目' }, { status: 403 });
    }
    if (invite.project.status !== 'active') {
      return NextResponse.json({ error: '项目当前不可加入' }, { status: 403 });
    }

    const role = normalizeProjectRole(invite.default_role);
    const member = await prisma.$transaction(async (tx) => {
      const membership = await tx.projectMember.upsert({
        where: { project_id_user_id: { project_id: invite.project_id, user_id: user.id } },
        update: { role, status: 'active', joined_by: invite.created_by, joined_at: new Date() },
        create: {
          project_id: invite.project_id,
          user_id: user.id,
          role,
          joined_by: invite.created_by,
        },
      });

      await tx.projectInvite.update({
        where: { id: invite.id },
        data: { used_count: { increment: 1 } },
      });

      await tx.operationLog.create({
        data: {
          operator_id: user.id,
          action: 'project_member_join',
          target_type: 'project',
          target_id: invite.project_id,
          detail: JSON.stringify({ via: 'invite', invite_id: invite.id, role }),
        },
      });

      return membership;
    });

    await logProjectAction(invite.created_by, 'project_invite_used', 'project', invite.project_id, {
      invite_id: invite.id,
      user_id: user.id,
    });

    return NextResponse.json({ project_id: invite.project_id, member });
  } catch (error) {
    console.error('[ProjectInvites] Join error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
