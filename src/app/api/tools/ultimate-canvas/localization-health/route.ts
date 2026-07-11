import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { getTaskWhereForUser } from '@/lib/projects/permissions';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
    if (user.role !== 'admin') {
      return NextResponse.json({ error: '权限不足', message: '无线画布本地化健康检查只对管理员开放' }, { status: 403 });
    }

    const projectId = request.nextUrl.searchParams.get('project_id')?.trim() || null;
    const baseWhere = await getTaskWhereForUser(user, projectId, {
      includeAdminAll: user.role === 'admin',
    });
    const where = {
      AND: [
        baseWhere,
        {
          local_status: 'succeeded',
          result_video_url: { not: null },
          local_video_path: null,
        },
      ],
    };

    const [pendingLocalizationCount, latestPendingTask, recentFailures] = await Promise.all([
      prisma.videoTask.count({ where }),
      prisma.videoTask.findFirst({
        where,
        orderBy: { completed_at: 'desc' },
        select: { id: true, completed_at: true, project_id: true, video_card_id: true },
      }),
      prisma.videoTask.count({
        where: {
          AND: [
            baseWhere,
            {
              local_status: 'failed',
              error_message: { contains: '本地' },
            },
          ],
        },
      }),
    ]);

    return NextResponse.json({
      pending_localization_count: pendingLocalizationCount,
      latest_pending_task: latestPendingTask ? {
        id: latestPendingTask.id,
        completed_at: latestPendingTask.completed_at?.toISOString() || null,
        project_id: latestPendingTask.project_id,
        video_card_id: latestPendingTask.video_card_id,
      } : null,
      recent_localization_failure_count: recentFailures,
      compensation_command: 'npx tsx scripts/finalize-pending-videos.ts',
      note: '该接口只读；实际补偿由 finalize-pending-videos 脚本或生产定时任务执行。',
    });
  } catch (error) {
    console.error('[UltimateCanvasLocalizationHealth] Error:', error);
    return NextResponse.json(
      { error: '本地化健康信息读取失败', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
