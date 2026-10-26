import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/session';
import { ensureDefaultProjectForUser, getTaskWhereForUser, readProjectOperationProjection } from '@/lib/projects/permissions';
import { createTeamProject, ProjectOperationError } from '@/lib/projects/operations';
import { isFeatureAllowed } from '@/lib/access/feature-guard';
import { createSelfUsageScope } from '@/lib/usage/access';
import { getUsageReport } from '@/lib/usage/personal';
import { parseUsageQuery } from '@/lib/usage/query';
import { taskThumbnailProjection } from '@/lib/video/task-thumbnail-projection';
import { USER_VISIBLE_TASK_RETENTION_STATUSES } from '@/lib/tasks/retention';
import { countDownloadableProjectTasks } from '@/lib/video/bulk-download';

export const dynamic = 'force-dynamic';

function boundedInteger(value: string | null, fallback: number, min: number, max: number) {
  if (!value || !/^\d+$/.test(value)) return fallback;
  return Math.min(max, Math.max(min, Number(value)));
}

export async function GET(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
    const managementAllowed = isFeatureAllowed(user, 'team_project_manage');
    const capabilities = { can_create_team_project: managementAllowed, create_operation_version: 1 };

    const home = request.nextUrl.searchParams.get('summary') === 'home';
    const lite = request.nextUrl.searchParams.get('lite') === 'true';
    const viewList = !home && !lite && request.nextUrl.searchParams.get('view') === 'list';
    const includeArchived = !home && (viewList || request.nextUrl.searchParams.get('include_archived') === 'true');
    const includeAll = !home && user.role === 'admin' && request.nextUrl.searchParams.get('include_all') === 'true';
    const statusWhere = includeArchived ? { not: 'deleted' } : 'active';

    const where: Prisma.ProjectWhereInput = includeAll
      ? { status: statusWhere }
      : {
          status: statusWhere,
          type: { not: 'system' },
          OR: [
            { owner_user_id: user.id },
            {
              type: { in: ['team', 'public'] },
              members: { some: { user_id: user.id, status: 'active' } },
            },
          ],
        };

    if (home) {
      const projects = await prisma.project.findMany({ where, take: 4,
        orderBy: [{ updated_at: 'desc' }, { id: 'desc' }], select: { id: true, name: true, updated_at: true } });
      const items = [];
      for (const project of projects) {
        const taskWhere = await getTaskWhereForUser(user, project.id);
        const task = await prisma.videoTask.findFirst({ where: { AND: [taskWhere, { local_status: 'succeeded' }] },
          orderBy: [{ updated_at: 'desc' }, { id: 'desc' }], select: { id: true, local_status: true, public_video_url: true,
            local_video_path: true, result_video_url: true, result_last_frame_url: true, delivery_status: true } });
        items.push({ ...project, thumbnailUrl: task ? taskThumbnailProjection(task).thumbnail_url : null });
      }
      return NextResponse.json({ projects: items, capabilities }, { headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
    }

    if (lite) {
      type LiteProject = {
        id: string;
        name: string;
        type: string;
        status: string;
        owner_user_id: string;
        members?: Array<{ role: string; status: string }>;
      };

      const projects = (includeAll
        ? await prisma.project.findMany({
            where,
            orderBy: [{ type: 'asc' }, { updated_at: 'desc' }],
            select: {
              id: true,
              name: true,
              type: true,
              status: true,
              owner_user_id: true,
            },
          })
        : await prisma.project.findMany({
            where,
            orderBy: [{ type: 'asc' }, { updated_at: 'desc' }],
            select: {
              id: true,
              name: true,
              type: true,
              status: true,
              owner_user_id: true,
              members: { where: { user_id: user.id }, select: { role: true, status: true } },
            },
          })) as LiteProject[];

      return NextResponse.json({
        capabilities,
        projects: projects.map((project) => {
          const memberRole = project.members?.[0]?.role || null;
          const myRole = includeAll
            ? 'admin'
            : (project.owner_user_id === user.id ? 'project_owner' : memberRole);
          const isActiveNonSystem = project.status === 'active' && project.type !== 'system';
          return {
            id: project.id,
            name: project.name,
            type: project.type,
            status: project.status,
            owner_user_id: project.owner_user_id,
            my_role: myRole,
            can_generate: isActiveNonSystem && myRole !== null && myRole !== 'viewer',
            can_manage_project: managementAllowed && (myRole === 'admin' || myRole === 'project_owner'),
            can_manage_assets: isActiveNonSystem && (project.type === 'personal' || managementAllowed) && ['admin', 'project_owner', 'editor'].includes(myRole || ''),
          };
        }),
      });
    }

    if (viewList) {
      const params = request.nextUrl.searchParams;
      const selectedStatus = params.get('status') === 'archived' ? 'archived' : 'active';
      const search = (params.get('search') || '').trim().slice(0, 120);
      const sort = params.get('sort') === 'name' ? 'name' : 'updated';
      const scope = params.get('scope') === 'owned' || params.get('scope') === 'participating'
        ? params.get('scope') as 'owned' | 'participating'
        : 'all';
      const pageSize = boundedInteger(params.get('page_size'), 12, 3, 24);
      const requestedPage = boundedInteger(params.get('page'), 1, 1, 1_000_000);
      const statusFilter: Prisma.ProjectWhereInput['status'] = selectedStatus === 'archived'
        ? 'archived'
        : { in: ['active', 'locked'] };

      const filters: Prisma.ProjectWhereInput[] = [where, { status: statusFilter }];
      if (search) {
        filters.push({ OR: [
          { name: { contains: search } },
          { description: { contains: search } },
        ] });
      }
      if (scope === 'owned') filters.push({ owner_user_id: user.id });
      if (scope === 'participating') filters.push({ owner_user_id: { not: user.id } });

      const projectWhere: Prisma.ProjectWhereInput = { AND: filters };
      const gridWhere: Prisma.ProjectWhereInput = {
        AND: [projectWhere, { type: { notIn: ['personal', 'system'] } }],
      };
      const total = await prisma.project.count({ where: gridWhere });
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const page = Math.min(requestedPage, totalPages);
      const orderBy: Prisma.ProjectOrderByWithRelationInput[] = sort === 'name'
        ? [{ name: 'asc' }, { id: 'asc' }]
        : [{ updated_at: 'desc' }, { id: 'desc' }];

      const [projects, personalProject] = await Promise.all([
        prisma.project.findMany({
          where: gridWhere,
          orderBy,
          skip: (page - 1) * pageSize,
          take: pageSize,
          include: {
            owner: { select: { id: true, name: true, username: true, avatar_url: true, account_type: true } },
            members: { where: { user_id: user.id }, select: { user_id: true, role: true, status: true }, take: 1 },
            _count: {
              select: {
                members: true,
                tasks: { where: { retention_status: { in: [...USER_VISIBLE_TASK_RETENTION_STATUSES] } } },
                reference_albums: { where: { status: { not: 'deleted' } } },
              },
            },
          },
        }),
        prisma.project.findFirst({
              // The personal-space shortcut uses the original authorization boundary,
              // independently of the grid's search, status and ownership filters.
              where: { AND: [where, { type: 'personal', owner_user_id: user.id }] },
              orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
              include: {
                owner: { select: { id: true, name: true, username: true, avatar_url: true, account_type: true } },
                members: { where: { user_id: user.id }, select: { user_id: true, role: true, status: true }, take: 1 },
                _count: {
                  select: {
                    members: true,
                    tasks: { where: { retention_status: { in: [...USER_VISIBLE_TASK_RETENTION_STATUSES] } } },
                    reference_albums: { where: { status: { not: 'deleted' } } },
                  },
                },
              },
            }),
      ]);

      const projectIds = projects.map((project) => project.id);
      const [downloadableCountByProject, activeTaskRows] = await Promise.all([
        countDownloadableProjectTasks(projectIds),
        projectIds.length > 0
          ? prisma.videoTask.groupBy({
              by: ['project_id'],
              where: {
                project_id: { in: projectIds },
                retention_status: { in: [...USER_VISIBLE_TASK_RETENTION_STATUSES] },
                local_status: { in: ['submitted', 'running'] },
              },
              _count: { _all: true },
            })
          : Promise.resolve([]),
      ]);
      const activeTaskCountByProject = new Map(
        activeTaskRows.flatMap((row) => row.project_id ? [[row.project_id, row._count._all] as const] : []),
      );
      const projectItems = await Promise.all(projects.map(async (project) => {
        const taskWhere = await getTaskWhereForUser(user, project.id);
        const task = await prisma.videoTask.findFirst({
          where: { AND: [taskWhere, { local_status: 'succeeded' }] },
          orderBy: [{ updated_at: 'desc' }, { id: 'desc' }],
          select: {
            id: true,
            local_status: true,
            public_video_url: true,
            local_video_path: true,
            result_video_url: true,
            result_last_frame_url: true,
            delivery_status: true,
          },
        });
        const myRole = includeAll
          ? 'admin'
          : (project.owner_user_id === user.id ? 'project_owner' : project.members[0]?.role || null);
        const canManageProject = managementAllowed && (myRole === 'admin' || myRole === 'project_owner');
        const operationFields = await readProjectOperationProjection(prisma, project, canManageProject);
        const isActiveNonSystem = project.status === 'active' && project.type !== 'system';
        return {
          ...project,
          ...operationFields,
          my_role: myRole,
          can_generate: isActiveNonSystem && myRole !== null && myRole !== 'viewer',
          can_manage_project: canManageProject,
          ...(canManageProject ? {
            legacy_can_delete: operationFields.can_delete,
          } : {}),
          can_manage_members: canManageProject
            && ['team', 'public'].includes(project.type),
          can_manage_assets: isActiveNonSystem && (project.type === 'personal' || managementAllowed) && ['admin', 'project_owner', 'editor'].includes(myRole || ''),
          active_task_count: activeTaskCountByProject.get(project.id) || 0,
          downloadable_task_count: downloadableCountByProject.get(project.id) || 0,
          thumbnail_url: task ? taskThumbnailProjection(task).thumbnail_url : null,
        };
      }));

      let personalItem = null;
      if (personalProject) {
        const memberRole = personalProject.members[0]?.role || null;
        personalItem = {
          ...personalProject,
          my_role: personalProject.owner_user_id === user.id ? 'project_owner' : memberRole,
        };
      }

      let usageSummary = null;
      let usageSummaryError: string | null = null;
      try {
        const self = createSelfUsageScope(user);
        const usageParams = new URLSearchParams();
        const timeZone = params.get('time_zone');
        if (timeZone) usageParams.set('time_zone', timeZone);
        const report = await getUsageReport(self, parseUsageQuery(usageParams, self));
        usageSummary = { scope: report.scope, query: report.query, asOf: report.asOf, fingerprint: report.fingerprint,
          range: report.range, summary: report.summary, coverage: report.coverage, restricted: report.restricted };
      } catch {
        usageSummaryError = '本月本人用量暂时无法读取，请稍后重试';
      }
      return NextResponse.json({
        capabilities,
        projects: projectItems,
        personal_project: personalItem,
        pagination: { page, page_size: pageSize, total, total_pages: totalPages },
        filters: { search, status: selectedStatus, sort, scope },
        usage_summary: usageSummary,
        usage_summary_error: usageSummaryError,
      }, { headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
    }

    const projects = await prisma.project.findMany({
      where,
      orderBy: [{ type: 'asc' }, { updated_at: 'desc' }],
      include: {
        owner: { select: { id: true, name: true, username: true, email: true, avatar_url: true, account_type: true } },
        members: includeAll
          ? { where: { status: 'active' }, select: { user_id: true, role: true, status: true } }
          : { where: { user_id: user.id }, select: { user_id: true, role: true, status: true } },
        _count: {
          select: {
            members: true,
            tasks: includeAll
              ? true
              : { where: { retention_status: { in: [...USER_VISIBLE_TASK_RETENTION_STATUSES] } } },
            reference_albums: { where: { status: { not: 'deleted' } } },
          },
        },
      },
    });

    const downloadableCountByProject = await countDownloadableProjectTasks(projects.map((project) => project.id));

    return NextResponse.json({
      capabilities,
      projects: await Promise.all(projects.map(async (project) => {
        const myRole = includeAll
          ? 'admin'
          : (project.owner_user_id === user.id ? 'project_owner' : project.members[0]?.role || null);
        const canManageProject = managementAllowed && (myRole === 'admin' || myRole === 'project_owner');
        const operationFields = await readProjectOperationProjection(prisma, project, canManageProject);
        const isActiveNonSystem = project.status === 'active' && project.type !== 'system';
        return {
          ...project,
          ...operationFields,
          my_role: myRole,
          can_generate: isActiveNonSystem && myRole !== null && myRole !== 'viewer',
          can_manage_project: canManageProject,
          can_manage_members: canManageProject
            && ['team', 'public'].includes(project.type),
          can_manage_assets: isActiveNonSystem && (project.type === 'personal' || managementAllowed) && ['admin', 'project_owner', 'editor'].includes(myRole || ''),
          downloadable_task_count: downloadableCountByProject.get(project.id) || 0,
        };
      })),
    });
  } catch (error) {
    console.error('[Projects] List error:', error);
    const busy = error instanceof Prisma.PrismaClientKnownRequestError && ['P1008', 'P2028'].includes(error.code);
    return NextResponse.json(
      { error: busy ? '项目列表暂时繁忙，请稍后重试' : '项目列表暂时无法读取，请稍后重试',
        code: busy ? 'PROJECT_LIST_BUSY' : 'PROJECT_LIST_UNAVAILABLE' },
      { status: busy ? 503 : 500, headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    const body = await request.json();
    if (body.type === 'personal' && body.requestId === undefined && body.operationVersion === undefined) {
      if (typeof body.name !== 'string' || !body.name.trim()) return NextResponse.json({ error: '项目名称不能为空' }, { status: 400 });
      const existing = await ensureDefaultProjectForUser(user.id);
      return NextResponse.json({ project: existing, deduplicated: true });
    }

    const result = await createTeamProject(user, body);
    return NextResponse.json(result.body, { status: result.status, headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message, ...(error instanceof ProjectOperationError ? { code: error.code } : {}) }, { status: error.status });
    }
    console.error('[Projects] Create error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
