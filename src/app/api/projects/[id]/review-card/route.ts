import { userSummarySelect } from '@/lib/dto/user';
import { route as apiRoute } from '@/lib/http/route';
import { apiErrorResponse } from '@/lib/http/api-error';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/session';
import { assertCanManageProject, assertCanViewProject } from '@/lib/projects/permissions';
import { generateProjectReviewCard } from '@/lib/review-cards';
import { createInAppNotification } from '@/lib/notifications';

export const dynamic = 'force-dynamic';

export const GET = apiRoute({ access: 'user', rateLimit: false }, async function GET(_request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    await assertCanViewProject(user, params.id);
    const review_cards = await prisma.reviewCard.findMany({
      where: { project_id: params.id },
      orderBy: { generated_at: 'desc' },
      take: 20,
      include: {
        generator: { select: userSummarySelect },
      },
    });

    return NextResponse.json({ review_cards });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    return apiErrorResponse(error);
  }
});

export const POST = apiRoute({ access: 'user', rateLimit: false }, async function POST(_request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const access = await assertCanManageProject(user, params.id);
    const review_card = await prisma.$transaction(async (tx) => {
      const card = await generateProjectReviewCard(tx, {
        projectId: params.id,
        actorUserId: user.id,
      });
      await createInAppNotification(tx, {
        targetUserId: access.project.owner_user_id,
        actorUserId: user.id,
        type: 'project_review_card_generated',
        title: '项目复盘卡已生成',
        body: `项目「${access.project.name}」已生成成本复盘卡，可用于下一次预算估算。`,
        projectId: params.id,
        metadata: { review_card_id: card.id },
      });
      return card;
    });

    return NextResponse.json({ review_card }, { status: 201 });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof Error) return NextResponse.json({ error: error.message }, { status: 400 });

    return apiErrorResponse(error);
  }
});

export const PATCH = apiRoute({ access: 'user', rateLimit: false }, async function PATCH(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
    if (user.role !== 'admin') return NextResponse.json({ error: '只有管理员可以补充复盘结论' }, { status: 403 });

    const body = await request.json();
    const reviewCardId = typeof body.review_card_id === 'string' ? body.review_card_id.trim() : '';
    if (!reviewCardId) return NextResponse.json({ error: 'review_card_id 不能为空' }, { status: 400 });

    const existing = await prisma.reviewCard.findUnique({
      where: { id: reviewCardId },
      select: { id: true, project_id: true },
    });
    if (!existing || existing.project_id !== params.id) {
      return NextResponse.json({ error: '复盘卡不属于当前项目' }, { status: 400 });
    }
    const review_card = await prisma.reviewCard.update({
      where: { id: reviewCardId },
      data: { admin_note: typeof body.admin_note === 'string' ? body.admin_note : null },
    });
    return NextResponse.json({ review_card });
  } catch (error) {
    if (error instanceof Error) return NextResponse.json({ error: error.message }, { status: 400 });

    return apiErrorResponse(error);
  }
});
