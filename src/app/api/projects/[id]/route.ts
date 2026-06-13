import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/session';
import { assertCanManageProject, assertCanManageProjectMembers, assertCanViewProject, logProjectAction } from '@/lib/projects/permissions';
import { getProjectBudgetSummary } from '@/lib/projects/budget';
import { USER_VISIBLE_TASK_RETENTION_STATUSES } from '@/lib/tasks/retention';
import { getVideoCardSummaryMap, serializeVideoCardSummary } from '@/lib/video-cards/summary';

export const dynamic = 'force-dynamic';

const OFFICIAL_PROJECT_COST_EVENTS = ['official_charge', 'adjustment', 'reversal'];

function normalizeCurrency(currency: string | null | undefined) {
  return (currency || 'CNY').trim().toUpperCase();
}

function buildCostTotals(
  microsRows: Array<{ currency: string | null; _sum: { amount_micros: number | null } }>,
  minorRows: Array<{ currency: string | null; _sum: { amount_minor: number | null } }>,
) {
  const totals = new Map<string, { currency: string; amount_micros: number; amount_minor: number }>();

  for (const row of microsRows) {
    const currency = normalizeCurrency(row.currency);
    const amountMicros = row._sum.amount_micros || 0;
    const existing = totals.get(currency) || { currency, amount_micros: 0, amount_minor: 0 };
    existing.amount_micros += amountMicros;
    existing.amount_minor += Math.round(amountMicros / 10000);
    totals.set(currency, existing);
  }

  for (const row of minorRows) {
    const currency = normalizeCurrency(row.currency);
    const amountMinor = row._sum.amount_minor || 0;
    const existing = totals.get(currency) || { currency, amount_micros: 0, amount_minor: 0 };
    existing.amount_minor += amountMinor;
    existing.amount_micros += amountMinor * 10000;
    totals.set(currency, existing);
  }

  return Array.from(totals.values()).sort((a, b) => a.currency.localeCompare(b.currency));
}

function serializeTaskPreview(task: null | {
  id: string;
  prompt: string;
  local_status: string;
  local_video_path: string | null;
  result_video_url: string | null;
  result_last_frame_url: string | null;
  created_at: Date;
}) {
  if (!task) return null;
  return {
    id: task.id,
    prompt: task.prompt,
    local_status: task.local_status,
    local_video_path: task.local_video_path,
    result_video_url: task.result_video_url,
    result_last_frame_url: task.result_last_frame_url,
    created_at: task.created_at,
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const access = await assertCanViewProject(user, params.id);

    const project = await prisma.project.findUnique({
      where: { id: params.id },
      include: {
        owner: { select: { id: true, name: true, username: true, email: true, avatar_url: true, account_type: true } },
        members: {
          where: { status: 'active' },
          orderBy: { joined_at: 'asc' },
          include: {
            user: { select: { id: true, name: true, username: true, email: true, role: true, status: true, account_type: true } },
          },
        },
        invites: {
          where: { status: 'active' },
          orderBy: { created_at: 'desc' },
          take: 5,
        },
        _count: {
          select: {
            members: true,
            tasks: true,
            reference_albums: { where: { status: { not: 'deleted' } } },
          },
        },
      },
    });

    const referenceAlbums = await prisma.referenceAlbum.findMany({
      where: { project_id: params.id, status: { not: 'deleted' } },
      orderBy: { updated_at: 'desc' },
      take: 20,
      select: {
        id: true,
        name: true,
        description: true,
        album_type: true,
        visibility: true,
        status: true,
        updated_at: true,
        _count: { select: { images: { where: { status: 'active' } } } },
      },
    });
    const taskVisibilityWhere = user.role === 'admin'
      ? { project_id: params.id }
      : { project_id: params.id, retention_status: { in: [...USER_VISIBLE_TASK_RETENTION_STATUSES] } };

    const tasks = await prisma.videoTask.findMany({
      where: taskVisibilityWhere,
      orderBy: { created_at: 'desc' },
      take: 50,
      select: {
        id: true,
        prompt: true,
        local_status: true,
        provider_task_id: true,
        result_video_url: true,
        result_last_frame_url: true,
        local_video_path: true,
        owner_user_id: true,
        user_id: true,
        estimated_cost: true,
        actual_cost: true,
        refund_amount: true,
        provider_cost_status: true,
        provider_official_amount_minor: true,
        provider_final_amount_minor: true,
        provider_official_amount_micros: true,
        provider_final_amount_micros: true,
        provider_cost_currency: true,
        provider_billing_status: true,
        created_at: true,
        completed_at: true,
        video_card_id: true,
        video_card: { select: { id: true, title: true, objective: true, status: true } },
        owner: { select: { id: true, name: true, username: true, email: true, avatar_url: true, account_type: true } },
        user: { select: { id: true, name: true, username: true, email: true, avatar_url: true, account_type: true } },
      },
    });

    const videoCards = await prisma.videoCard.findMany({
      where: { project_id: params.id },
      orderBy: [{ is_fallback: 'asc' }, { updated_at: 'desc' }],
      include: {
        owner: { select: { id: true, name: true, username: true, email: true, avatar_url: true, account_type: true } },
        current_best_task: {
          select: { id: true, prompt: true, local_status: true, local_video_path: true, result_video_url: true, result_last_frame_url: true, created_at: true },
        },
        final_task: {
          select: { id: true, prompt: true, local_status: true, local_video_path: true, result_video_url: true, result_last_frame_url: true, created_at: true },
        },
      },
    });
    const videoCardSummaryMap = await getVideoCardSummaryMap(videoCards.map((card) => card.id), {
      taskWhere: user.role === 'admin' ? {} : { retention_status: { in: [...USER_VISIBLE_TASK_RETENTION_STATUSES] } },
    });

    const projectCostWhere = {
      event_type: { in: OFFICIAL_PROJECT_COST_EVENTS },
      OR: [
        { project_id: params.id },
        { allocations: { some: { project_id: params.id } } },
      ],
    };

    const [
      taskCount,
      succeededCount,
      failedCount,
      runningCount,
      creditTotals,
      officialAllocationMicrosTotals,
      officialAllocationMinorFallbackTotals,
      officialDirectMicrosTotals,
      officialDirectMinorFallbackTotals,
      costLedgers,
      officialPendingCount,
      costUnknownCount,
      highCostTasks,
      failedTasks,
    ] = await Promise.all([
      prisma.videoTask.count({ where: taskVisibilityWhere }),
      prisma.videoTask.count({ where: { ...taskVisibilityWhere, local_status: 'succeeded' } }),
      prisma.videoTask.count({ where: { ...taskVisibilityWhere, local_status: { in: ['failed', 'cancelled'] } } }),
      prisma.videoTask.count({ where: { ...taskVisibilityWhere, local_status: { in: ['submitted', 'running'] } } }),
      prisma.videoTask.aggregate({
        where: taskVisibilityWhere,
        _sum: {
          estimated_cost: true,
          actual_cost: true,
          refund_amount: true,
        },
      }),
      prisma.costAllocation.groupBy({
        by: ['currency'],
        where: {
          project_id: params.id,
          ledger: { event_type: { in: OFFICIAL_PROJECT_COST_EVENTS } },
          amount_micros: { not: null },
        },
        _sum: { amount_micros: true },
      }),
      prisma.costAllocation.groupBy({
        by: ['currency'],
        where: {
          project_id: params.id,
          ledger: { event_type: { in: OFFICIAL_PROJECT_COST_EVENTS } },
          amount_micros: null,
          amount_minor: { not: null },
        },
        _sum: { amount_minor: true },
      }),
      prisma.costLedger.groupBy({
        by: ['currency'],
        where: {
          event_type: { in: OFFICIAL_PROJECT_COST_EVENTS },
          project_id: params.id,
          allocations: { none: {} },
          amount_micros: { not: null },
        },
        _sum: { amount_micros: true },
      }),
      prisma.costLedger.groupBy({
        by: ['currency'],
        where: {
          event_type: { in: OFFICIAL_PROJECT_COST_EVENTS },
          project_id: params.id,
          allocations: { none: {} },
          amount_micros: null,
          amount_minor: { not: null },
        },
        _sum: { amount_minor: true },
      }),
      prisma.costLedger.findMany({
        where: projectCostWhere,
        orderBy: [{ occurred_at: 'desc' }, { created_at: 'desc' }],
        take: 80,
        select: {
          id: true,
          source_type: true,
          source_id: true,
          task_id: true,
          user_id: true,
          project_id: true,
          provider_name: true,
          provider_task_id: true,
          event_type: true,
          amount_minor: true,
          amount_micros: true,
          currency: true,
          usage_quantity: true,
          usage_unit: true,
          cost_source: true,
          confidence: true,
          official_charge_id: true,
          reason: true,
          occurred_at: true,
          created_at: true,
          user: { select: { id: true, name: true, username: true, email: true, avatar_url: true, account_type: true } },
          task: {
            select: {
              id: true,
              prompt: true,
              local_status: true,
              provider_task_id: true,
              result_video_url: true,
              result_last_frame_url: true,
              local_video_path: true,
              provider_cost_status: true,
              provider_official_amount_minor: true,
              provider_final_amount_minor: true,
              provider_official_amount_micros: true,
              provider_final_amount_micros: true,
              provider_cost_currency: true,
              provider_billing_status: true,
              created_at: true,
              owner: { select: { id: true, name: true, username: true, email: true, avatar_url: true, account_type: true } },
              user: { select: { id: true, name: true, username: true, email: true, avatar_url: true, account_type: true } },
            },
          },
          allocations: {
            where: { project_id: params.id },
            select: {
              id: true,
              allocation_type: true,
              allocation_id: true,
              amount_minor: true,
              amount_micros: true,
              currency: true,
              reason: true,
            },
          },
        },
      }),
      prisma.videoTask.count({
        where: {
          ...taskVisibilityWhere,
          local_status: { in: ['succeeded', 'failed', 'cancelled'] },
          provider_cost_status: { notIn: ['official_confirmed', 'reconciled', 'failed_no_charge'] },
        },
      }),
      prisma.videoTask.count({
        where: { ...taskVisibilityWhere, provider_cost_status: { in: ['unknown', 'disputed'] } },
      }),
      prisma.videoTask.findMany({
        where: taskVisibilityWhere,
        orderBy: [{ actual_cost: 'desc' }, { estimated_cost: 'desc' }, { created_at: 'desc' }],
        take: 8,
        select: {
          id: true,
          prompt: true,
          local_status: true,
          estimated_cost: true,
          actual_cost: true,
          provider_cost_status: true,
          result_video_url: true,
          result_last_frame_url: true,
          local_video_path: true,
          created_at: true,
          owner: { select: { id: true, name: true, username: true, email: true, avatar_url: true, account_type: true } },
          user: { select: { id: true, name: true, username: true, email: true, avatar_url: true, account_type: true } },
        },
      }),
      prisma.videoTask.findMany({
        where: { ...taskVisibilityWhere, local_status: { in: ['failed', 'cancelled'] } },
        orderBy: { created_at: 'desc' },
        take: 8,
        select: {
          id: true,
          prompt: true,
          local_status: true,
          error_message: true,
          estimated_cost: true,
          refund_amount: true,
          provider_cost_status: true,
          result_video_url: true,
          result_last_frame_url: true,
          local_video_path: true,
          created_at: true,
        },
      }),
    ]);

    const officialCostTotals = buildCostTotals(
      [...officialAllocationMicrosTotals, ...officialDirectMicrosTotals],
      [...officialAllocationMinorFallbackTotals, ...officialDirectMinorFallbackTotals],
    );
    const budgetSummary = await prisma.$transaction((tx) => getProjectBudgetSummary(tx, params.id));
    const primaryOfficialCost = officialCostTotals[0] || null;
    const reviewSummary = {
      task_count: taskCount,
      succeeded_count: succeededCount,
      failed_count: failedCount,
      running_count: runningCount,
      success_rate: taskCount > 0 ? Math.round((succeededCount / taskCount) * 1000) / 10 : 0,
      estimated_credits: creditTotals._sum.estimated_cost || 0,
      charged_credits: creditTotals._sum.actual_cost || 0,
      refunded_credits: creditTotals._sum.refund_amount || 0,
      official_cost_minor: primaryOfficialCost?.amount_minor || 0,
      official_cost_micros: primaryOfficialCost?.amount_micros || 0,
      official_cost_currency: primaryOfficialCost?.currency || null,
      official_cost_totals: officialCostTotals,
      official_pending_count: officialPendingCount,
      cost_unknown_count: costUnknownCount,
      high_cost_tasks: highCostTasks,
      failed_tasks: failedTasks,
    };

    return NextResponse.json({
      project,
      reference_albums: referenceAlbums.map((album) => ({
        ...album,
        image_count: album._count.images,
      })),
      video_cards: videoCards.map((card) => {
        const summary = videoCardSummaryMap.get(card.id);
        return {
          id: card.id,
          project_id: card.project_id,
          title: card.title,
          objective: card.objective,
          status: card.status,
          owner_user_id: card.owner_user_id,
          owner: card.owner,
          platform: card.platform,
          ratio: card.ratio,
          duration: card.duration,
          target_resolution: card.target_resolution,
          budget_credits: card.budget_credits,
          budget_currency: card.budget_currency,
          current_best_task_id: card.current_best_task_id,
          final_task_id: card.final_task_id,
          current_best_task: serializeTaskPreview(card.current_best_task),
          final_task: serializeTaskPreview(card.final_task),
          is_fallback: card.is_fallback,
          created_by: card.created_by,
          created_at: card.created_at,
          updated_at: card.updated_at,
          summary: summary ? serializeVideoCardSummary(summary) : null,
        };
      }),
      tasks,
      cost_ledgers: costLedgers,
      budget: budgetSummary,
      review_summary: reviewSummary,
      permissions: {
        role: access.role,
        can_manage_project: access.canManageProject,
        can_manage_members: access.canManageMembers,
        can_manage_assets: access.canManageAssets,
        can_generate: access.canGenerate,
      },
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[Projects] Detail error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const access = await assertCanManageProject(user, params.id);
    const project = access.project;
    if (!project) return NextResponse.json({ error: '项目不存在' }, { status: 404 });

    const body = await request.json();
    const data: {
      name?: string;
      description?: string | null;
      status?: string;
      archived_at?: Date | null;
    } = {};

    if (typeof body.name === 'string') {
      const name = body.name.trim();
      if (!name) return NextResponse.json({ error: '项目名称不能为空' }, { status: 400 });
      data.name = name;
    }

    if (typeof body.description === 'string') {
      data.description = body.description.trim() || null;
    }

    const action = typeof body.action === 'string' ? body.action : '';
    if (project.status === 'archived' && action !== 'restore') {
      return NextResponse.json({ error: '归档项目为只读，请先恢复后再修改' }, { status: 400 });
    }
    if (action === 'archive') {
      if (project.type === 'personal' || project.type === 'system') {
        return NextResponse.json({ error: '默认项目不能归档' }, { status: 400 });
      }
      data.status = 'archived';
      data.archived_at = new Date();
    } else if (action === 'restore') {
      data.status = 'active';
      data.archived_at = null;
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: '没有可更新的字段' }, { status: 400 });
    }

    const updated = await prisma.project.update({
      where: { id: params.id },
      data,
    });

    await logProjectAction(user.id, action ? `project_${action}` : 'project_update', 'project', params.id, {
      fields: Object.keys(data),
    });

    return NextResponse.json({ project: updated });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[Projects] Update error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const access = await assertCanManageProject(user, params.id);
    const project = access.project;
    if (!project) return NextResponse.json({ error: '项目不存在' }, { status: 404 });

    if (project.type === 'personal' || project.type === 'system') {
      return NextResponse.json({ error: '默认项目不能删除' }, { status: 400 });
    }

    const [taskCount, albumCount] = await Promise.all([
      prisma.videoTask.count({ where: { project_id: params.id } }),
      prisma.referenceAlbum.count({ where: { project_id: params.id, status: { not: 'deleted' } } }),
    ]);
    if (taskCount > 0 || albumCount > 0) {
      return NextResponse.json({ error: '项目已有任务或图集，请先归档，不能删除' }, { status: 400 });
    }

    const updated = await prisma.project.update({
      where: { id: params.id },
      data: { status: 'deleted', archived_at: new Date() },
    });

    await logProjectAction(user.id, 'project_delete', 'project', params.id, {
      soft_delete: true,
    });

    return NextResponse.json({ project: updated });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[Projects] Delete error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
