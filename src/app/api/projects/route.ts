import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/session';
import { ensureDefaultProjectForUser, getTaskWhereForUser, logProjectAction } from '@/lib/projects/permissions';
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
      return NextResponse.json({ projects: items }, { headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
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
            can_manage_project: myRole === 'admin' || myRole === 'project_owner',
            can_manage_assets: isActiveNonSystem && ['admin', 'project_owner', 'editor'].includes(myRole || ''),
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
        scope === 'participating'
          ? Promise.resolve(null)
          : prisma.project.findFirst({
              where: { AND: [projectWhere, { type: 'personal', owner_user_id: user.id }] },
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
      const deleteCandidateProjectIds = projects
        .filter((project) => project.type === 'team' && (includeAll
          || project.owner_user_id === user.id
          || ['admin', 'project_owner'].includes(project.members[0]?.role || '')))
        .map((project) => project.id);
      const fullTaskCountRows = deleteCandidateProjectIds.length > 0
        ? await prisma.videoTask.groupBy({
            by: ['project_id'],
            where: { project_id: { in: deleteCandidateProjectIds } },
            _count: { _all: true },
          })
        : [];
      const fullTaskCountByProject = new Map(
        fullTaskCountRows.flatMap((row) => row.project_id ? [[row.project_id, row._count._all] as const] : []),
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
        const canManageProject = myRole === 'admin' || myRole === 'project_owner';
        const isActiveNonSystem = project.status === 'active' && project.type !== 'system';
        return {
          ...project,
          my_role: myRole,
          can_generate: isActiveNonSystem && myRole !== null && myRole !== 'viewer',
          can_manage_project: myRole === 'admin' || myRole === 'project_owner',
          ...(canManageProject ? {
            legacy_can_delete: project.type === 'team'
              && (fullTaskCountByProject.get(project.id) ?? 0) === 0
              && project._count.reference_albums === 0,
          } : {}),
          can_manage_members: (myRole === 'admin' || myRole === 'project_owner')
            && ['team', 'public'].includes(project.type),
          can_manage_assets: isActiveNonSystem && ['admin', 'project_owner', 'editor'].includes(myRole || ''),
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

      return NextResponse.json({
        projects: projectItems,
        personal_project: personalItem,
        pagination: { page, page_size: pageSize, total, total_pages: totalPages },
        filters: { search, status: selectedStatus, sort, scope },
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
      projects: projects.map((project) => {
        const myRole = includeAll
          ? 'admin'
          : (project.owner_user_id === user.id ? 'project_owner' : project.members[0]?.role || null);
        const isActiveNonSystem = project.status === 'active' && project.type !== 'system';
        return {
          ...project,
          my_role: myRole,
          can_generate: isActiveNonSystem && myRole !== null && myRole !== 'viewer',
          can_manage_project: myRole === 'admin' || myRole === 'project_owner',
          can_manage_members: (myRole === 'admin' || myRole === 'project_owner')
            && ['team', 'public'].includes(project.type),
          can_manage_assets: isActiveNonSystem && ['admin', 'project_owner', 'editor'].includes(myRole || ''),
          downloadable_task_count: downloadableCountByProject.get(project.id) || 0,
        };
      }),
    });
  } catch (error) {
    console.error('[Projects] List error:', error);
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
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return NextResponse.json({ error: '项目名称不能为空' }, { status: 400 });

    const type = body.type === 'personal' ? 'personal' : 'team';
    if (type === 'personal') {
      const existing = await ensureDefaultProjectForUser(user.id);
      return NextResponse.json({ project: existing, deduplicated: true });
    }

    const project = await prisma.$transaction(async (tx) => {
      const created = await tx.project.create({
        data: {
          name,
          description: typeof body.description === 'string' ? body.description.trim() || null : null,
          type: 'team',
          visibility: 'private',
          owner_user_id: user.id,
          created_by: user.id,
          status: 'active',
        },
      });

      await tx.projectMember.create({
        data: {
          project_id: created.id,
          user_id: user.id,
          role: 'project_owner',
          joined_by: user.id,
        },
      });

      await tx.operationLog.create({
        data: {
          operator_id: user.id,
          action: 'project_create',
          target_type: 'project',
          target_id: created.id,
          detail: JSON.stringify({ name, type: 'team' }),
        },
      });

      return created;
    });

    await logProjectAction(user.id, 'project_member_join', 'project', project.id, {
      user_id: user.id,
      role: 'project_owner',
      source: 'create_project',
    });

    return NextResponse.json({ project });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[Projects] Create error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
