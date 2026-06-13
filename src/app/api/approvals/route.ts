import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/session';
import { assertCanViewProject, logProjectAction } from '@/lib/projects/permissions';
import { assertCanViewVideoCard } from '@/lib/video-cards/permissions';
import { createApprovalRequest, normalizeApprovalType } from '@/lib/approvals';

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

export async function GET(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const status = optionalString(request.nextUrl.searchParams.get('status'));
    const type = normalizeApprovalType(request.nextUrl.searchParams.get('type'));
    const where = {
      ...(status ? { status } : {}),
      ...(type ? { type } : {}),
      ...(user.role === 'admin'
        ? {}
        : {
            OR: [
              { requester_user_id: user.id },
              { project: { owner_user_id: user.id } },
            ],
          }),
    };

    const approvals = await prisma.approvalRecord.findMany({
      where,
      include: APPROVAL_INCLUDE,
      orderBy: [{ status: 'asc' }, { created_at: 'desc' }],
      take: 100,
    });

    return NextResponse.json({ approvals });
  } catch (error) {
    console.error('[Approvals] List error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const body = await request.json();
    const type = normalizeApprovalType(body.type);
    if (!type) return NextResponse.json({ error: '审批类型无效' }, { status: 400 });

    const projectId = optionalString(body.project_id ?? body.projectId);
    const videoCardId = optionalString(body.video_card_id ?? body.videoCardId);
    const taskId = optionalString(body.task_id ?? body.taskId);
    const reason = optionalString(body.reason);

    if (!projectId && type !== 'project_create') {
      return NextResponse.json({ error: '此审批类型必须关联项目' }, { status: 400 });
    }
    if (projectId) await assertCanViewProject(user, projectId);
    if (videoCardId) await assertCanViewVideoCard(user, videoCardId);

    const approval = await prisma.$transaction(async (tx) => createApprovalRequest(tx, {
      type,
      requesterUserId: user.id,
      projectId,
      videoCardId,
      taskId,
      reason,
      scope: {
        project_id: projectId,
        video_card_id: videoCardId,
        task_id: taskId,
      },
      payload: typeof body.payload === 'object' && body.payload ? body.payload : undefined,
    }));

    await logProjectAction(user.id, 'approval_request_create', 'approval', approval.id, {
      type,
      project_id: projectId,
      video_card_id: videoCardId,
      task_id: taskId,
    });

    const created = await prisma.approvalRecord.findUnique({
      where: { id: approval.id },
      include: APPROVAL_INCLUDE,
    });

    return NextResponse.json({ approval: created });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[Approvals] Create error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
