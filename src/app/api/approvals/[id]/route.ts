import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/session';
import { assertCanManageProject, logProjectAction } from '@/lib/projects/permissions';
import { decideApproval } from '@/lib/approvals';

export const dynamic = 'force-dynamic';

const APPROVAL_INCLUDE = {
  project: { select: { id: true, name: true, type: true, status: true, owner_user_id: true } },
  videoCard: { select: { id: true, title: true, status: true, project_id: true } },
  task: { select: { id: true, prompt: true, local_status: true } },
  requester: { select: { id: true, name: true, username: true, email: true, avatar_url: true, account_type: true } },
  approver: { select: { id: true, name: true, username: true, email: true, avatar_url: true, account_type: true } },
} as const;

function optionalString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseDate(value: unknown) {
  if (!value) return undefined;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return undefined;
  return date;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const approval = await prisma.approvalRecord.findUnique({
      where: { id: params.id },
      include: { project: true },
    });
    if (!approval) return NextResponse.json({ error: '审批记录不存在' }, { status: 404 });

    if (user.role !== 'admin') {
      if (!approval.project_id) return NextResponse.json({ error: '无权处理此审批' }, { status: 403 });
      const access = await assertCanManageProject(user, approval.project_id);
      if (!access.canManageProject) return NextResponse.json({ error: '无权处理此审批' }, { status: 403 });
    }

    const body = await request.json();
    const action = body.action === 'reject' ? 'reject' : body.action === 'approve' ? 'approve' : null;
    if (!action) return NextResponse.json({ error: 'action 必须是 approve 或 reject' }, { status: 400 });

    const updated = await prisma.$transaction(async (tx) => decideApproval(tx, {
      approvalId: params.id,
      approverUserId: user.id,
      action,
      reason: optionalString(body.reason),
      expiresAt: parseDate(body.expires_at ?? body.expiresAt),
    }));

    await logProjectAction(user.id, `approval_${action}`, 'approval', params.id, {
      type: approval.type,
      project_id: approval.project_id,
      video_card_id: approval.video_card_id,
    });

    const serializable = await prisma.approvalRecord.findUnique({
      where: { id: updated.id },
      include: APPROVAL_INCLUDE,
    });

    return NextResponse.json({ approval: serializable });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[Approvals] Decide error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
