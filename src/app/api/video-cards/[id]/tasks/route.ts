import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/session';
import { assertCanViewVideoCard } from '@/lib/video-cards/permissions';
import { USER_VISIBLE_TASK_RETENTION_STATUSES } from '@/lib/tasks/retention';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const user = await getSession();
    if (!user) {
      return NextResponse.json({ error: '未登录', message: '请先登录后再查看视频卡任务' }, { status: 401 });
    }

    await assertCanViewVideoCard(user, params.id);

    const searchParams = request.nextUrl.searchParams;
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const limit = Math.min(80, Math.max(1, parseInt(searchParams.get('limit') || '30', 10)));
    const skip = (page - 1) * limit;
    const where = user.role === 'admin'
      ? { video_card_id: params.id }
      : { video_card_id: params.id, retention_status: { in: [...USER_VISIBLE_TASK_RETENTION_STATUSES] } };

    const [total, tasks] = await Promise.all([
      prisma.videoTask.count({ where }),
      prisma.videoTask.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          provider_task_id: true,
          prompt: true,
          generation_mode: true,
          ratio: true,
          duration: true,
          resolution: true,
          local_status: true,
          result_video_url: true,
          result_last_frame_url: true,
          local_video_path: true,
          error_message: true,
          estimated_cost: true,
          actual_cost: true,
          frozen_cost: true,
          refund_amount: true,
          version_role: true,
          provider_cost_currency: true,
          provider_official_amount_minor: true,
          provider_final_amount_minor: true,
          provider_official_amount_micros: true,
          provider_final_amount_micros: true,
          created_at: true,
          completed_at: true,
          user_id: true,
          owner_user_id: true,
          project_id: true,
          video_card_id: true,
          project: { select: { id: true, name: true, type: true } },
          video_card: { select: { id: true, title: true, objective: true, status: true } },
          owner: { select: { id: true, name: true, username: true, email: true, avatar_url: true, account_type: true } },
          user: { select: { id: true, name: true, username: true, email: true, avatar_url: true, account_type: true } },
        },
      }),
    ]);

    return NextResponse.json({
      tasks,
      pagination: {
        page,
        limit,
        total,
        total_pages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: '权限不足', message: error.message }, { status: error.status });
    }
    console.error('[VideoCardTasks] List error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
