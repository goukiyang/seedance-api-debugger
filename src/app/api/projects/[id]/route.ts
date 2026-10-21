import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/session';
import { assertCanManageProject, assertCanViewProject, compareAndSetProject, getProjectDeletionBlockers, logProjectActionInTransaction, projectStatusVersion, ProjectVersionConflictError } from '@/lib/projects/permissions';
import { getProjectBudgetSummary } from '@/lib/projects/budget';
import { USER_VISIBLE_TASK_RETENTION_STATUSES } from '@/lib/tasks/retention';
import { getVideoCardSummaryMap, serializeVideoCardSummary } from '@/lib/video-cards/summary';
import { getVideoCardArchiveAnomalies } from '@/lib/video-cards/suggestions';
import { taskThumbnailProjection } from '@/lib/video/task-thumbnail-projection';
import { visibleProviderErrorMessage } from '@/lib/provider/error-message';

export const dynamic = 'force-dynamic';

const OFFICIAL_PROJECT_COST_EVENTS = ['official_charge', 'adjustment', 'reversal'];

const PROJECT_DETAIL_PAGE_SIZE = 20;
const PROJECT_TASK_FILTERS = new Set(['all', 'running', 'playable', 'failed']);

class ProjectMutationError extends AuthError {
  constructor(message: string, status: number, public readonly details: Record<string, unknown>) { super(message, status); }
}

function expectedProjectVersion(body: Record<string, unknown>) {
  if (typeof body.expected_status !== 'string' || typeof body.expected_updated_at !== 'string'
    || !Number.isFinite(Date.parse(body.expected_updated_at))) {
    throw new ProjectMutationError('请刷新项目资料后再保存，当前输入已保留', 400, { code: 'PROJECT_VERSION_REQUIRED' });
  }
  return { status: body.expected_status, updated_at: new Date(body.expected_updated_at) };
}

async function projectCapabilities(access: Awaited<ReturnType<typeof assertCanViewProject>>) {
  const project = access.project!;
  const mutableType = !['personal', 'system'].includes(project.type);
  const blockers = access.canManageProject && mutableType
    ? await prisma.$transaction((tx) => getProjectDeletionBlockers(tx, project.id)) : [];
  return {
    role: access.role, can_manage_project: access.canManageProject, can_manage_members: access.canManageMembers,
    can_manage_assets: access.canManageAssets, can_generate: access.canGenerate,
    can_archive: access.canManageProject && mutableType && ['active', 'locked'].includes(project.status),
    can_restore: access.canManageProject && mutableType && project.status === 'archived',
    can_delete: access.canManageProject && mutableType && blockers.length === 0,
  };
}

function boundedPage(value: string | null) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 100_000) : 1;
}

function boundedSearch(value: string | null) {
  return (value || '').trim().slice(0, 120);
}

function safeTaskProjection<T extends {
  id: string;
  local_status: string;
  public_video_url?: string | null;
  local_video_path?: string | null;
  result_video_url?: string | null;
  result_last_frame_url?: string | null;
  delivery_status?: string | null;
}>(task: T) {
  const {
    public_video_url: _publicVideoUrl,
    local_video_path: _localVideoPath,
    result_video_url: _resultVideoUrl,
    result_last_frame_url: _resultLastFrameUrl,
    ...safeTask
  } = task;
  return { ...safeTask, ...taskThumbnailProjection(task) };
}

async function getProjectSection(
  request: NextRequest,
  user: NonNullable<Awaited<ReturnType<typeof getSession>>>,
  access: Awaited<ReturnType<typeof assertCanViewProject>>,
  projectId: string,
  section: string,
) {
  if (!['tasks', 'albums', 'finance', 'members'].includes(section)) {
    return NextResponse.json({ error: '无效的项目分区' }, { status: 400 });
  }

  const searchParams = request.nextUrl.searchParams;
  const requestedPage = boundedPage(searchParams.get('page'));
  const pageSize = PROJECT_DETAIL_PAGE_SIZE;
  const taskWhere = user.role === 'admin'
    ? { project_id: projectId }
    : { project_id: projectId, retention_status: { in: [...USER_VISIBLE_TASK_RETENTION_STATUSES] } };
  const membersSection = section === 'members';
  const canReturnInvites = membersSection && access.canManageMembers;
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      name: true,
      description: true,
      type: true,
      visibility: true,
      status: true,
      owner_user_id: true,
      owner: { select: { id: true, name: true, username: true, avatar_url: true, account_type: true } },
      members: {
        where: { status: 'active' },
        orderBy: { joined_at: 'asc' },
        select: {
          id: true,
          user_id: true,
          role: true,
          joined_at: true,
          user: { select: { id: true, name: true, username: true, email: true, avatar_url: true, role: true, status: true, account_type: true } },
        },
      },
      invites: canReturnInvites ? {
        where: { status: 'active' },
        orderBy: { created_at: 'desc' },
        take: 5,
        select: { id: true, token: true, default_role: true, expires_at: true, used_count: true, max_uses: true },
      } : false,
      _count: { select: { members: true, tasks: true, reference_albums: { where: { status: { not: 'deleted' } } } } },
    },
  });
  if (!project) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const budget = await prisma.$transaction((tx) => getProjectBudgetSummary(tx, projectId));

  const common = {
    project: {
      ...project,
      status_version: projectStatusVersion(access.project!),
      members: membersSection ? project.members : [],
      invites: canReturnInvites ? project.invites : [],
      _count: project._count,
    },
    viewer_id: user.id,
    budget,
    permissions: await projectCapabilities(access),
    status_version: projectStatusVersion(access.project!),
  };

  if (section === 'tasks') {
    const search = boundedSearch(searchParams.get('q'));
    const statusFilter = PROJECT_TASK_FILTERS.has(searchParams.get('status') || '') ? (searchParams.get('status') || 'all') : 'all';
    const sort = searchParams.get('sort') === 'oldest' ? 'oldest' : 'newest';
    const playableTaskWhere = {
      OR: [
        { public_video_url: { not: '' } },
        { local_video_path: { not: '' } },
        {
          result_video_url: { not: '' },
          NOT: { result_video_url: { startsWith: 'h3-internal-output://' } },
        },
      ],
    };
    const runningTaskWhere = {
      OR: [
        { local_status: { in: ['submitted', 'running'] } },
        {
          local_status: 'succeeded',
          AND: [
            { OR: [{ public_video_url: null }, { public_video_url: '' }] },
            {
              OR: [
                { delivery_status: null },
                { delivery_status: { notIn: ['succeeded', 'failed'] } },
              ],
            },
            {
              OR: [
                playableTaskWhere,
                { delivery_status: { in: ['pending', 'running'] } },
              ],
            },
          ],
        },
      ],
    };
    const failedTaskWhere = { local_status: { in: ['failed', 'cancelled'] } };
    const statusWhere = statusFilter === 'running'
      ? runningTaskWhere
      : statusFilter === 'playable'
        ? playableTaskWhere
        : statusFilter === 'failed'
          ? failedTaskWhere
          : {};
    const searchWhere = search ? { OR: [
      { prompt: { contains: search } },
      { model: { contains: search } },
      { provider: { contains: search } },
      { id: { contains: search } },
    ] } : {};
    const where = { AND: [taskWhere, statusWhere, searchWhere] };
    const [total, matchingTaskCount, succeededCount, failedCount, runningCount] = await Promise.all([
      prisma.videoTask.count({ where }),
      prisma.videoTask.count({ where: taskWhere }),
      prisma.videoTask.count({ where: { ...taskWhere, local_status: 'succeeded' } }),
      prisma.videoTask.count({ where: { ...taskWhere, ...failedTaskWhere } }),
      prisma.videoTask.count({ where: { AND: [taskWhere, runningTaskWhere] } }),
    ]);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const tasks = await prisma.videoTask.findMany({
      where,
      orderBy: sort === 'oldest' ? [{ created_at: 'asc' }, { id: 'asc' }] : [{ created_at: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true, prompt: true, provider: true, model: true, generation_mode: true,
        ratio: true, duration: true, resolution: true, local_status: true, delivery_status: true,
        provider_task_id: true, public_video_url: true, result_video_url: true,
        result_last_frame_url: true, local_video_path: true, owner_user_id: true, user_id: true,
        estimated_cost: true, actual_cost: true, refund_amount: true, provider_cost_status: true,
        provider_official_amount_minor: true, provider_final_amount_minor: true,
        provider_official_amount_micros: true, provider_final_amount_micros: true,
        provider_cost_currency: true, provider_billing_status: true, created_at: true,
        video_card_id: true, video_branch_id: true,
        owner: { select: { id: true, name: true, username: true, avatar_url: true, account_type: true } },
        user: { select: { id: true, name: true, username: true, avatar_url: true, account_type: true } },
      },
    });
    return NextResponse.json({ ...common,
      tasks: tasks.map(safeTaskProjection),
      review_summary: { task_count: matchingTaskCount, succeeded_count: succeededCount, failed_count: failedCount, running_count: runningCount },
      pagination: { page, page_size: pageSize, total, total_pages: totalPages },
      filters: { q: search, status: statusFilter, sort },
    });
  }

  if (section === 'albums') {
    const where = { project_id: projectId, status: { not: 'deleted' } };
    const total = await prisma.referenceAlbum.count({ where });
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const pagedAlbums = await prisma.referenceAlbum.findMany({
      where, orderBy: [{ updated_at: 'desc' }, { id: 'desc' }], skip: (page - 1) * pageSize, take: pageSize,
      select: { id: true, name: true, description: true, album_type: true, visibility: true, status: true, updated_at: true,
        _count: { select: { images: { where: { status: 'active' } } } } },
    });
    return NextResponse.json({ ...common,
      reference_albums: pagedAlbums.map((album) => ({ ...album, image_count: album._count.images })),
      pagination: { page, page_size: pageSize, total, total_pages: totalPages },
    });
  }

  if (section === 'members') {
    return NextResponse.json({ ...common, project: { ...common.project,
      members: project.members, invites: canReturnInvites ? project.invites : [],
    } });
  }

  const ledgerWhere = {
    event_type: { in: OFFICIAL_PROJECT_COST_EVENTS },
    OR: [{ project_id: projectId }, { allocations: { some: { project_id: projectId } } }],
  };
  const [taskCount, succeededCount, failedCount, runningCount, creditTotals, officialAllocationMicrosTotals,
    officialAllocationMinorTotals, officialDirectMicrosTotals, officialDirectMinorTotals, ledgerTotalCount, officialPendingCount,
    costUnknownCount, highCostTasks, ledgerPageOne] = await Promise.all([
    prisma.videoTask.count({ where: taskWhere }),
    prisma.videoTask.count({ where: { ...taskWhere, local_status: 'succeeded' } }),
    prisma.videoTask.count({ where: { ...taskWhere, local_status: { in: ['failed', 'cancelled'] } } }),
    prisma.videoTask.count({ where: { ...taskWhere, local_status: { in: ['submitted', 'running'] } } }),
    prisma.videoTask.aggregate({ where: taskWhere, _sum: { estimated_cost: true, actual_cost: true, refund_amount: true } }),
    prisma.costAllocation.groupBy({
      by: ['currency'],
      where: { project_id: projectId, ledger: { event_type: { in: OFFICIAL_PROJECT_COST_EVENTS } }, amount_micros: { not: null } },
      _sum: { amount_micros: true },
    }),
    prisma.costAllocation.groupBy({
      by: ['currency'],
      where: { project_id: projectId, ledger: { event_type: { in: OFFICIAL_PROJECT_COST_EVENTS } }, amount_micros: null, amount_minor: { not: null } },
      _sum: { amount_minor: true },
    }),
    prisma.costLedger.groupBy({
      by: ['currency'],
      where: { event_type: { in: OFFICIAL_PROJECT_COST_EVENTS }, project_id: projectId, allocations: { none: {} }, amount_micros: { not: null } },
      _sum: { amount_micros: true },
    }),
    prisma.costLedger.groupBy({
      by: ['currency'],
      where: { event_type: { in: OFFICIAL_PROJECT_COST_EVENTS }, project_id: projectId, allocations: { none: {} }, amount_micros: null, amount_minor: { not: null } },
      _sum: { amount_minor: true },
    }),
    prisma.costLedger.count({ where: ledgerWhere }),
    prisma.videoTask.count({ where: { ...taskWhere, local_status: { in: ['succeeded', 'failed', 'cancelled'] }, provider_cost_status: { notIn: ['official_confirmed', 'reconciled', 'failed_no_charge'] } } }),
    prisma.videoTask.count({ where: { ...taskWhere, provider_cost_status: { in: ['unknown', 'disputed'] } } }),
    prisma.videoTask.findMany({
      where: taskWhere,
      orderBy: [{ actual_cost: 'desc' }, { estimated_cost: 'desc' }, { created_at: 'desc' }, { id: 'desc' }],
      take: 8,
      select: {
        id: true, prompt: true, provider: true, generation_mode: true, local_status: true, delivery_status: true,
        estimated_cost: true, actual_cost: true, provider_cost_status: true, public_video_url: true,
        result_video_url: true, result_last_frame_url: true, local_video_path: true, created_at: true,
        owner: { select: { id: true, name: true, username: true, avatar_url: true, account_type: true } },
        user: { select: { id: true, name: true, username: true, avatar_url: true, account_type: true } },
      },
    }),
    prisma.costLedger.findMany({
      where: ledgerWhere,
      orderBy: [{ occurred_at: 'desc' }, { created_at: 'desc' }, { id: 'desc' }],
      skip: 0,
      take: pageSize,
      select: {
        id: true, source_type: true, source_id: true, task_id: true, user_id: true, project_id: true,
        provider_name: true, provider_task_id: true, event_type: true, amount_minor: true, amount_micros: true,
        currency: true, usage_quantity: true, usage_unit: true, cost_source: true, confidence: true,
        official_charge_id: true, reason: true, occurred_at: true, created_at: true,
        user: { select: { id: true, name: true, username: true, avatar_url: true, account_type: true } },
        task: { select: { id: true, prompt: true, provider: true, model: true, generation_mode: true, local_status: true,
          delivery_status: true, provider_task_id: true, public_video_url: true, result_video_url: true,
          result_last_frame_url: true, local_video_path: true, provider_cost_status: true,
          provider_official_amount_minor: true, provider_final_amount_minor: true,
          provider_official_amount_micros: true, provider_final_amount_micros: true,
          provider_cost_currency: true, provider_billing_status: true, created_at: true,
          owner: { select: { id: true, name: true, username: true, avatar_url: true, account_type: true } },
          user: { select: { id: true, name: true, username: true, avatar_url: true, account_type: true } } } },
        allocations: { where: { project_id: projectId }, select: { id: true, allocation_type: true, allocation_id: true,
          amount_minor: true, amount_micros: true, currency: true, reason: true } },
      },
    }),
  ]);
  const totalPages = Math.max(1, Math.ceil(ledgerTotalCount / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const pagedLedgers = page === 1 ? ledgerPageOne : await prisma.costLedger.findMany({
    where: ledgerWhere, orderBy: [{ occurred_at: 'desc' }, { created_at: 'desc' }, { id: 'desc' }],
    skip: (page - 1) * pageSize, take: pageSize,
    select: { id: true, source_type: true, source_id: true, task_id: true, user_id: true, project_id: true,
      provider_name: true, provider_task_id: true, event_type: true, amount_minor: true, amount_micros: true,
      currency: true, usage_quantity: true, usage_unit: true, cost_source: true, confidence: true,
      official_charge_id: true, reason: true, occurred_at: true, created_at: true,
      user: { select: { id: true, name: true, username: true, avatar_url: true, account_type: true } },
      task: { select: { id: true, prompt: true, provider: true, model: true, generation_mode: true, local_status: true,
        delivery_status: true, provider_task_id: true, public_video_url: true, result_video_url: true,
        result_last_frame_url: true, local_video_path: true, provider_cost_status: true,
        provider_official_amount_minor: true, provider_final_amount_minor: true,
        provider_official_amount_micros: true, provider_final_amount_micros: true, provider_cost_currency: true,
        provider_billing_status: true, created_at: true,
        owner: { select: { id: true, name: true, username: true, avatar_url: true, account_type: true } },
        user: { select: { id: true, name: true, username: true, avatar_url: true, account_type: true } } } },
      allocations: { where: { project_id: projectId }, select: { id: true, allocation_type: true, allocation_id: true,
        amount_minor: true, amount_micros: true, currency: true, reason: true } },
    },
  });
  const projectedLedgers = pagedLedgers.map((ledger) => ({
    ...ledger,
    task: ledger.task ? safeTaskProjection(ledger.task) : null,
  }));
  const officialCostTotals = buildCostTotals(
    [...officialAllocationMicrosTotals, ...officialDirectMicrosTotals],
    [...officialAllocationMinorTotals, ...officialDirectMinorTotals],
  );
  const primaryOfficialCost = officialCostTotals[0] || null;
  return NextResponse.json({ ...common,
    review_summary: {
      task_count: taskCount, succeeded_count: succeededCount, failed_count: failedCount, running_count: runningCount,
      estimated_credits: creditTotals._sum.estimated_cost || 0,
      charged_credits: creditTotals._sum.actual_cost || 0,
      refunded_credits: creditTotals._sum.refund_amount || 0,
      success_rate: taskCount > 0 ? Math.round((succeededCount / taskCount) * 1000) / 10 : 0,
      official_cost_minor: primaryOfficialCost?.amount_minor || 0,
      official_cost_micros: primaryOfficialCost?.amount_micros || 0,
      official_cost_currency: primaryOfficialCost?.currency || null,
      official_cost_totals: officialCostTotals,
      official_pending_count: officialPendingCount,
      cost_unknown_count: costUnknownCount,
      high_cost_tasks: highCostTasks.map(safeTaskProjection), failed_tasks: [],
    },
    cost_ledgers: projectedLedgers,
    pagination: { page, page_size: pageSize, total: ledgerTotalCount, total_pages: totalPages },
  });
}

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
  provider: string;
  generation_mode: string;
  local_status: string;
  delivery_status?: string | null;
  public_video_url: string | null;
  local_video_path: string | null;
  result_video_url: string | null;
  result_last_frame_url: string | null;
  created_at: Date;
}) {
  if (!task) return null;
  return {
    id: task.id,
    prompt: task.prompt,
    provider: task.provider,
    generation_mode: task.generation_mode,
    local_status: task.local_status,
    ...taskThumbnailProjection(task),
    public_video_url: task.public_video_url,
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
    const section = request.nextUrl.searchParams.get('section');
    if (section) return getProjectSection(request, user, access, params.id, section);

    const project = await prisma.project.findUnique({
      where: { id: params.id },
      include: {
        owner: { select: { id: true, name: true, username: true, email: true, avatar_url: true, account_type: true } },
        members: {
          where: { status: 'active' },
          orderBy: { joined_at: 'asc' },
          include: {
            user: { select: { id: true, name: true, username: true, email: true, avatar_url: true, role: true, status: true, account_type: true } },
          },
        },
        invites: access.canManageMembers ? {
          where: { status: 'active' },
          orderBy: { created_at: 'desc' },
          take: 5,
        } : false,
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
        provider: true,
        generation_mode: true,
        local_status: true,
        delivery_status: true,
        provider_task_id: true,
        public_video_url: true,
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
          select: { id: true, prompt: true, provider: true, generation_mode: true, local_status: true, delivery_status: true, public_video_url: true, local_video_path: true, result_video_url: true, result_last_frame_url: true, created_at: true },
        },
        final_task: {
          select: { id: true, prompt: true, provider: true, generation_mode: true, local_status: true, delivery_status: true, public_video_url: true, local_video_path: true, result_video_url: true, result_last_frame_url: true, created_at: true },
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
              provider: true,
              generation_mode: true,
              local_status: true,
              delivery_status: true,
              provider_task_id: true,
              public_video_url: true,
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
          provider: true,
          generation_mode: true,
          local_status: true,
          delivery_status: true,
          estimated_cost: true,
          actual_cost: true,
          provider_cost_status: true,
          public_video_url: true,
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
          provider: true,
          generation_mode: true,
          local_status: true,
          delivery_status: true,
          error_message: true,
          estimated_cost: true,
          refund_amount: true,
          provider_cost_status: true,
          public_video_url: true,
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
    const { budgetSummary, archiveAnomalies } = await prisma.$transaction(async (tx) => ({
      budgetSummary: await getProjectBudgetSummary(tx, params.id),
      archiveAnomalies: await getVideoCardArchiveAnomalies(tx, params.id),
    }));
    const primaryOfficialCost = officialCostTotals[0] || null;
    const projectedTasks = tasks.map((task) => ({
      ...task,
      ...taskThumbnailProjection(task),
    }));
    const projectedHighCostTasks = highCostTasks.map((task) => ({
      ...task,
      ...taskThumbnailProjection(task),
    }));
    const projectedFailedTasks = failedTasks.map((task) => ({
      ...task,
      error_message: visibleProviderErrorMessage(task.error_message),
      ...taskThumbnailProjection(task),
    }));
    const projectedCostLedgers = costLedgers.map((ledger) => ({
      ...ledger,
      task: ledger.task ? {
        ...ledger.task,
        ...taskThumbnailProjection(ledger.task),
      } : null,
    }));
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
      high_cost_tasks: projectedHighCostTasks,
      failed_tasks: projectedFailedTasks,
    };

    return NextResponse.json({
      project: project ? { ...project, status_version: projectStatusVersion(project) } : null,
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
      tasks: projectedTasks,
      cost_ledgers: projectedCostLedgers,
      budget: budgetSummary,
      archive_anomalies: archiveAnomalies,
      review_summary: reviewSummary,
      permissions: await projectCapabilities(access),
      status_version: projectStatusVersion(access.project!),
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

    const body = await request.json();
    const expected = expectedProjectVersion(body);
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
    if (action && !['archive', 'restore'].includes(action)) return NextResponse.json({ error: '无效的项目操作' }, { status: 400 });
    if (action === 'archive') {
      data.status = 'archived';
      data.archived_at = new Date();
    } else if (action === 'restore') {
      data.status = 'active';
      data.archived_at = null;
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: '没有可更新的字段' }, { status: 400 });
    }

    const updated = await prisma.$transaction(async (tx) => {
      const { project } = await assertCanManageProject(user, params.id, tx);
      if (!project) throw new AuthError('项目不存在', 404);
      if (project.status !== expected.status || project.updated_at.getTime() !== expected.updated_at.getTime()) throw new ProjectVersionConflictError(project);
      if (action && ['personal', 'system'].includes(project.type)) throw new AuthError('默认项目不能归档或恢复', 400);
      if (action === 'restore' && project.status !== 'archived'
        || action === 'archive' && !['active', 'locked'].includes(project.status)
        || !action && project.status !== 'active') throw new AuthError('项目当前只读，请先核对项目状态', 400);
      await compareAndSetProject(tx, project, expected, data);
      await logProjectActionInTransaction(tx, user.id, action ? `project_${action}` : 'project_update', 'project', params.id, { fields: Object.keys(data) });
      return tx.project.findUniqueOrThrow({ where: { id: project.id } });
    });
    return NextResponse.json({ project: { ...updated, status_version: projectStatusVersion(updated) }, status_version: projectStatusVersion(updated) });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message, ...(error instanceof ProjectMutationError || error instanceof ProjectVersionConflictError ? error.details : {}) }, { status: error.status });
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

    const body = await request.json().catch(() => ({}));
    const expected = expectedProjectVersion(body);
    const updated = await prisma.$transaction(async (tx) => {
      const { project } = await assertCanManageProject(user, params.id, tx);
      if (!project) throw new AuthError('项目不存在', 404);
      if (project.status !== expected.status || project.updated_at.getTime() !== expected.updated_at.getTime()) throw new ProjectVersionConflictError(project);
      if (['personal', 'system'].includes(project.type)) throw new AuthError('默认项目不能删除', 400);
      const blockers = await getProjectDeletionBlockers(tx, project.id);
      if (blockers.length) throw new ProjectMutationError('项目已有内容或历史记录，请使用归档', 409,
        { code: 'PROJECT_NOT_EMPTY', blockers, can_archive: ['active', 'locked'].includes(project.status) });
      await compareAndSetProject(tx, project, expected, { status: 'deleted', archived_at: new Date() });
      await tx.projectMember.updateMany({ where: { project_id: project.id, status: 'active' }, data: { status: 'removed' } });
      await tx.projectInvite.updateMany({ where: { project_id: project.id, status: 'active' }, data: { status: 'disabled' } });
      await logProjectActionInTransaction(tx, user.id, 'project_delete', 'project', params.id, { soft_delete: true });
      return tx.project.findUniqueOrThrow({ where: { id: project.id } });
    });
    return NextResponse.json({ project: { ...updated, status_version: projectStatusVersion(updated) }, status_version: projectStatusVersion(updated) });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message, ...(error instanceof ProjectMutationError || error instanceof ProjectVersionConflictError ? error.details : {}) }, { status: error.status });
    }
    console.error('[Projects] Delete error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
