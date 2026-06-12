import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/session';
import { ensureDefaultProjectForUser, logProjectAction } from '@/lib/projects/permissions';
import { USER_VISIBLE_TASK_RETENTION_STATUSES } from '@/lib/tasks/retention';
import { countDownloadableProjectTasks } from '@/lib/video/bulk-download';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

    await ensureDefaultProjectForUser(user.id);

    const includeArchived = request.nextUrl.searchParams.get('include_archived') === 'true';
    const includeAll = user.role === 'admin' && request.nextUrl.searchParams.get('include_all') === 'true';
    const statusWhere = includeArchived ? { not: 'deleted' } : 'active';

    const where = includeAll
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

    const projects = await prisma.project.findMany({
      where,
      orderBy: [{ type: 'asc' }, { updated_at: 'desc' }],
      include: {
        owner: { select: { id: true, name: true, username: true } },
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
