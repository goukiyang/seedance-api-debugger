import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/session';
import { getTaskWhereForUser } from '@/lib/projects/permissions';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) {
      return NextResponse.json(
        { error: 'Unauthorized', message: '请先登录后再查看任务列表' },
        { status: 401 },
      );
    }

    const searchParams = request.nextUrl.searchParams;
    const page = parseInt(searchParams.get('page') || '1');
    const limit = parseInt(searchParams.get('limit') || '20');
    const skip = (page - 1) * limit;
    const projectId = searchParams.get('project_id');
    const where = await getTaskWhereForUser(user, projectId);

    const total = await prisma.videoTask.count({ where });

    const tasks = await prisma.videoTask.findMany({
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
        local_video_path: true,
        error_message: true,
        estimated_cost: true,
        actual_cost: true,
        frozen_cost: true,
        refund_amount: true,
        reference_image_ids: true,
        reference_image_urls: true,
        created_at: true,
        completed_at: true,
        user_id: true,
        owner_user_id: true,
        project_id: true,
        project: {
          select: { id: true, name: true, type: true },
        },
      },
    });

    return NextResponse.json({
      tasks,
      pagination: {
        page,
        limit,
        total,
        total_pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: 'Forbidden', message: error.message },
        { status: error.status },
      );
    }
    console.error('List tasks error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
