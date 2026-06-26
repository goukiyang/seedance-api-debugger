import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/session';
import { VOLCENGINE_IP_VIDEO_PROVIDER } from '@/lib/provider/volcengine-ip';
import { getTaskWhereForUser } from '@/lib/projects/permissions';
import { assertCanViewVideoCard } from '@/lib/video-cards/permissions';

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
    const videoCardId = searchParams.get('video_card_id');
    const includeAll = user.role === 'admin' && searchParams.get('include_all') === 'true';
    const includeDeleted = user.role === 'admin' && searchParams.get('include_deleted') === 'true';
    const baseWhere = await getTaskWhereForUser(user, projectId, {
      includeAdminAll: includeAll,
      includeDeleted,
    });
    if (videoCardId) await assertCanViewVideoCard(user, videoCardId);
    const where = {
      AND: [
        baseWhere,
        { provider: { not: VOLCENGINE_IP_VIDEO_PROVIDER } },
        ...(videoCardId ? [{ video_card_id: videoCardId }] : []),
      ],
    };

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
        public_video_url: true,
        public_video_storage_provider: true,
        public_video_cached_at: true,
        result_video_url: true,
        result_last_frame_url: true,
        local_video_path: true,
        error_message: true,
        estimated_cost: true,
        actual_cost: true,
        frozen_cost: true,
        refund_amount: true,
        provider_cost_currency: true,
        provider_official_amount_minor: true,
        provider_final_amount_minor: true,
        provider_official_amount_micros: true,
        provider_final_amount_micros: true,
        reference_image_ids: true,
        reference_image_urls: true,
        created_at: true,
        completed_at: true,
        retention_status: true,
        user_deleted_at: true,
        user_deleted_by: true,
        admin_hidden_at: true,
        admin_hidden_by: true,
        restored_at: true,
        restored_by: true,
        delete_reason: true,
        user_id: true,
        owner_user_id: true,
        project_id: true,
        video_card_id: true,
        template_id: true,
        agent_run_id: true,
        selected_agent_plan_key: true,
        prompt_user_edited: true,
        project: {
          select: { id: true, name: true, type: true },
        },
        video_card: {
          select: { id: true, title: true, objective: true, status: true, project_id: true },
        },
        generation_template: {
          select: { id: true, name: true, template_key: true, version: true },
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
