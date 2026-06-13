import crypto from 'crypto';
import { loadEnvConfig } from '@next/env';
import { PrismaClient, type Prisma } from '@prisma/client';

type UserProbe = {
  id: string;
  role: string;
  name: string | null;
  username: string;
  label: string;
};

type ProjectProbe = {
  id: string;
  name: string;
  type: string;
  owner_user_id: string;
};

type TaskProbe = {
  id: string;
  project_id: string | null;
  owner_user_id: string | null;
  user_id: string | null;
  retention_status: string | null;
};

type HttpResult = {
  status: number;
  contentType: string;
  text: string;
  json: Record<string, unknown> | null;
};

type ProbeCase = {
  name: string;
  actor: UserProbe;
  path: string;
  expected: number[];
  assert?: (result: HttpResult) => void | Promise<void>;
};

const prisma = new PrismaClient();
const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME || 'session';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-in-production';
const ACTIVE_RETENTION_STATUSES = ['active', 'retained'];
const SHARABLE_PROJECT_TYPES = ['team', 'public'];

function log(message: string) {
  console.log(`[task-permission-matrix] ${message}`);
}

function warn(message: string) {
  console.warn(`[task-permission-matrix] WARN ${message}`);
}

function fail(message: string): never {
  throw new Error(message);
}

function buildSessionCookie(userId: string) {
  const payload = Buffer.from(userId).toString('base64');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64');
  return `${SESSION_COOKIE}=${payload}.${sig}`;
}

function actorLabel(user: Pick<UserProbe, 'label' | 'username' | 'role'>) {
  return `${user.label}:${user.username}:${user.role}`;
}

async function request(baseUrl: string, path: string, actor: UserProbe, timeoutMs: number): Promise<HttpResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      cache: 'no-store',
      redirect: 'manual',
      headers: {
        Accept: path.startsWith('/api/') ? 'application/json' : 'text/html',
        Cookie: buildSessionCookie(actor.id),
      },
      signal: controller.signal,
    });
    const text = await response.text();
    const contentType = response.headers.get('content-type') || '';
    let json: Record<string, unknown> | null = null;
    if (contentType.includes('application/json') && text) {
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        fail(`${actorLabel(actor)} ${path} returned invalid JSON`);
      }
    }
    return { status: response.status, contentType, text, json };
  } finally {
    clearTimeout(timeout);
  }
}

function assertStatus(caseName: string, actual: number, expected: number[]) {
  if (!expected.includes(actual)) {
    fail(`${caseName} returned ${actual}, expected ${expected.join('/')}`);
  }
  log(`${caseName} -> ${actual}`);
}

function assertJsonObject(caseName: string, result: HttpResult): Record<string, unknown> {
  if (!result.contentType.includes('application/json')) {
    fail(`${caseName} returned non-json content-type: ${result.contentType || '(empty)'}`);
  }
  if (!result.json) fail(`${caseName} returned empty JSON`);
  return result.json;
}

function extractTaskIds(caseName: string, result: HttpResult) {
  const json = assertJsonObject(caseName, result);
  const tasks = json.tasks;
  if (!Array.isArray(tasks)) fail(`${caseName} did not return tasks[]`);
  return tasks.map((task) => {
    if (!task || typeof task !== 'object' || !('id' in task) || typeof task.id !== 'string') {
      fail(`${caseName} returned a task without string id`);
    }
    return task.id;
  });
}

function extractPaginationTotal(caseName: string, result: HttpResult) {
  const json = assertJsonObject(caseName, result);
  const pagination = json.pagination;
  if (!pagination || typeof pagination !== 'object' || !('total' in pagination)) {
    fail(`${caseName} did not return pagination.total`);
  }
  const total = Number(pagination.total);
  if (!Number.isFinite(total)) fail(`${caseName} returned non-numeric pagination.total`);
  return total;
}

async function findUserById(userId: string, label: string): Promise<UserProbe> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, name: true, username: true, status: true },
  });
  if (!user || user.status !== 'active') fail(`${label} user ${userId} not found or not active`);
  return { id: user.id, role: user.role, name: user.name, username: user.username, label };
}

async function findAdmin(): Promise<UserProbe | null> {
  if (process.env.TEST_ADMIN_USER_ID) return findUserById(process.env.TEST_ADMIN_USER_ID, 'admin');
  const user = await prisma.user.findFirst({
    where: { role: 'admin', status: 'active' },
    orderBy: { created_at: 'asc' },
    select: { id: true, role: true, name: true, username: true },
  });
  return user ? { ...user, label: 'admin' } : null;
}

async function findRegularUser(): Promise<UserProbe | null> {
  if (process.env.TEST_USER_ID) return findUserById(process.env.TEST_USER_ID, 'regular');
  const taskOwner = await prisma.videoTask.findFirst({
    where: {
      retention_status: { in: ACTIVE_RETENTION_STATUSES },
      OR: [
        { owner: { role: 'user', status: 'active' } },
        { user: { role: 'user', status: 'active' } },
      ],
    },
    orderBy: { created_at: 'desc' },
    select: {
      owner: { select: { id: true, role: true, name: true, username: true } },
      user: { select: { id: true, role: true, name: true, username: true } },
    },
  });
  const user = taskOwner?.owner?.role === 'user' ? taskOwner.owner : taskOwner?.user;
  if (user) return { ...user, label: 'regular' };

  const fallback = await prisma.user.findFirst({
    where: { role: 'user', status: 'active' },
    orderBy: { created_at: 'asc' },
    select: { id: true, role: true, name: true, username: true },
  });
  return fallback ? { ...fallback, label: 'regular' } : null;
}

async function findProjectMember(): Promise<{ user: UserProbe; project: ProjectProbe } | null> {
  const membership = await prisma.projectMember.findFirst({
    where: {
      status: 'active',
      user: { role: 'user', status: 'active' },
      project: {
        status: { not: 'deleted' },
        type: { in: SHARABLE_PROJECT_TYPES },
      },
    },
    orderBy: { joined_at: 'asc' },
    select: {
      user: { select: { id: true, role: true, name: true, username: true } },
      project: { select: { id: true, name: true, type: true, owner_user_id: true } },
    },
  });
  if (!membership) return null;
  return {
    user: { ...membership.user, label: 'project-member' },
    project: membership.project,
  };
}

async function accessibleProjectIds(actor: UserProbe, includeAdminAll = false) {
  if (actor.role === 'admin' && includeAdminAll) {
    const projects = await prisma.project.findMany({
      where: { status: { not: 'deleted' } },
      select: { id: true },
    });
    return projects.map((project) => project.id);
  }

  const [memberships, ownedProjects] = await Promise.all([
    prisma.projectMember.findMany({
      where: {
        user_id: actor.id,
        status: 'active',
        project: {
          status: { not: 'deleted' },
          type: { in: SHARABLE_PROJECT_TYPES },
        },
      },
      select: { project_id: true },
    }),
    prisma.project.findMany({
      where: {
        owner_user_id: actor.id,
        status: { not: 'deleted' },
      },
      select: { id: true },
    }),
  ]);

  return Array.from(new Set([
    ...memberships.map((membership) => membership.project_id),
    ...ownedProjects.map((project) => project.id),
  ]));
}

async function expectedTaskWhere(
  actor: UserProbe,
  options: { includeAdminAll?: boolean; projectId?: string | null } = {},
): Promise<Prisma.VideoTaskWhereInput | null> {
  const includeAdminAll = options.includeAdminAll ?? false;
  const projectId = options.projectId ?? null;
  const retentionWhere: Prisma.VideoTaskWhereInput = {
    retention_status: { in: ACTIVE_RETENTION_STATUSES },
  };

  if (actor.role === 'admin' && includeAdminAll) {
    return projectId
      ? { AND: [{ project_id: projectId }, retentionWhere] }
      : retentionWhere;
  }

  const projectIds = await accessibleProjectIds(actor, includeAdminAll);
  if (projectId) {
    if (!projectIds.includes(projectId)) return null;
    return { AND: [{ project_id: projectId }, retentionWhere] };
  }

  return {
    AND: [
      {
        OR: [
          { project_id: { in: projectIds } },
          { project_id: null, owner_user_id: actor.id },
          { project_id: null, user_id: actor.id },
        ],
      },
      retentionWhere,
    ],
  };
}

async function expectedVisibleTaskCount(actor: UserProbe, includeAdminAll = false, projectId?: string | null) {
  const where = await expectedTaskWhere(actor, { includeAdminAll, projectId });
  if (!where) return null;
  return prisma.videoTask.count({ where });
}

async function findForbiddenTask(actor: UserProbe): Promise<TaskProbe | null> {
  const projectIds = await accessibleProjectIds(actor, false);
  return prisma.videoTask.findFirst({
    where: {
      retention_status: { in: ACTIVE_RETENTION_STATUSES },
      OR: [
        {
          project_id: null,
          AND: [
            { OR: [{ owner_user_id: null }, { owner_user_id: { not: actor.id } }] },
            { OR: [{ user_id: null }, { user_id: { not: actor.id } }] },
          ],
        },
        {
          project_id: { not: null },
          NOT: { project_id: { in: projectIds } },
        },
      ],
    },
    orderBy: { created_at: 'desc' },
    select: {
      id: true,
      project_id: true,
      owner_user_id: true,
      user_id: true,
      retention_status: true,
    },
  });
}

async function findInaccessibleProject(actor: UserProbe): Promise<ProjectProbe | null> {
  const projectIds = await accessibleProjectIds(actor, false);
  return prisma.project.findFirst({
    where: {
      status: { not: 'deleted' },
      NOT: { id: { in: projectIds } },
    },
    orderBy: { created_at: 'desc' },
    select: { id: true, name: true, type: true, owner_user_id: true },
  });
}

function assertListTotal(caseName: string, result: HttpResult, expectedTotal: number | null) {
  if (expectedTotal === null) return;
  const total = extractPaginationTotal(caseName, result);
  if (total !== expectedTotal) {
    fail(`${caseName} pagination.total=${total}, expected ${expectedTotal}`);
  }
}

function assertListDoesNotContain(caseName: string, result: HttpResult, forbiddenTask: TaskProbe | null) {
  if (!forbiddenTask) return;
  const taskIds = extractTaskIds(caseName, result);
  if (taskIds.includes(forbiddenTask.id)) {
    fail(`${caseName} leaked forbidden task ${forbiddenTask.id}`);
  }
}

function assertListProjectOnly(caseName: string, result: HttpResult, projectId: string) {
  const json = assertJsonObject(caseName, result);
  const tasks = json.tasks;
  if (!Array.isArray(tasks)) fail(`${caseName} did not return tasks[]`);
  for (const task of tasks) {
    if (!task || typeof task !== 'object' || !('project_id' in task)) {
      fail(`${caseName} returned a task without project_id`);
    }
    if (task.project_id !== projectId) {
      fail(`${caseName} returned task outside project ${projectId}`);
    }
  }
}

async function runCase(baseUrl: string, timeoutMs: number, probe: ProbeCase) {
  const result = await request(baseUrl, probe.path, probe.actor, timeoutMs);
  assertStatus(`${actorLabel(probe.actor)} ${probe.name}`, result.status, probe.expected);
  if (probe.assert && probe.expected.includes(result.status)) {
    await probe.assert(result);
  }
}

async function main() {
  loadEnvConfig(process.cwd());

  const baseUrl = (process.env.BASE_URL || 'http://localhost:3001').replace(/\/+$/, '');
  const timeoutMs = Number(process.env.TIMEOUT_MS || 30_000);
  log(`baseUrl=${baseUrl}`);

  const [admin, regular, memberProbe] = await Promise.all([
    findAdmin(),
    findRegularUser(),
    findProjectMember(),
  ]);

  if (!admin) warn('skip admin cases: no active admin user found');
  if (!regular) warn('skip regular cases: no active regular user found');
  if (!memberProbe) warn('skip project-member cases: no active member in a team/public project found');

  const actors = [admin, regular, memberProbe?.user].filter((actor): actor is UserProbe => Boolean(actor));
  if (actors.length === 0) fail('no active users found for permission matrix');

  const cases: ProbeCase[] = [];

  for (const actor of actors) {
    const forbiddenTask = actor.role === 'admin' ? null : await findForbiddenTask(actor);
    const inaccessibleProject = actor.role === 'admin' ? null : await findInaccessibleProject(actor);
    const expectedDefaultTotal = await expectedVisibleTaskCount(actor, false);
    const expectedIncludeAllTotal = await expectedVisibleTaskCount(actor, actor.role === 'admin');

    if (!forbiddenTask && actor.role !== 'admin') {
      warn(`no forbidden task sample found for ${actorLabel(actor)}; list totals will still be checked`);
    }
    if (!inaccessibleProject && actor.role !== 'admin') {
      warn(`no inaccessible project sample found for ${actorLabel(actor)}`);
    }

    cases.push({
      name: 'GET /api/video/list',
      actor,
      path: '/api/video/list?limit=100',
      expected: [200],
      assert: (result) => {
        assertListTotal(`${actorLabel(actor)} GET /api/video/list`, result, expectedDefaultTotal);
        assertListDoesNotContain(`${actorLabel(actor)} GET /api/video/list`, result, forbiddenTask);
      },
    });

    cases.push({
      name: 'GET /api/video/list?include_all=true',
      actor,
      path: '/api/video/list?include_all=true&limit=100',
      expected: [200],
      assert: (result) => {
        assertListTotal(`${actorLabel(actor)} GET /api/video/list?include_all=true`, result, expectedIncludeAllTotal);
        assertListDoesNotContain(`${actorLabel(actor)} GET /api/video/list?include_all=true`, result, forbiddenTask);
      },
    });

    if (forbiddenTask) {
      cases.push({
        name: `GET /api/video/status/${forbiddenTask.id}`,
        actor,
        path: `/api/video/status/${forbiddenTask.id}`,
        expected: [403, 404],
      });
      cases.push({
        name: `GET /api/video/thumbnail/${forbiddenTask.id}`,
        actor,
        path: `/api/video/thumbnail/${forbiddenTask.id}`,
        expected: [403, 404],
      });
    }

    if (inaccessibleProject) {
      cases.push({
        name: `GET /api/video/list?project_id=${inaccessibleProject.id}`,
        actor,
        path: `/api/video/list?project_id=${encodeURIComponent(inaccessibleProject.id)}&limit=20`,
        expected: [403, 404],
      });
    }

    cases.push({
      name: 'GET /api/admin/outputs',
      actor,
      path: '/api/admin/outputs?limit=1',
      expected: actor.role === 'admin' ? [200] : [401, 403],
    });
  }

  if (memberProbe) {
    const expectedProjectTotal = await expectedVisibleTaskCount(memberProbe.user, false, memberProbe.project.id);
    cases.push({
      name: `GET /api/video/list?project_id=${memberProbe.project.id}`,
      actor: memberProbe.user,
      path: `/api/video/list?project_id=${encodeURIComponent(memberProbe.project.id)}&limit=100`,
      expected: [200],
      assert: (result) => {
        assertListTotal(
          `${actorLabel(memberProbe.user)} GET /api/video/list?project_id=${memberProbe.project.id}`,
          result,
          expectedProjectTotal,
        );
        assertListProjectOnly(
          `${actorLabel(memberProbe.user)} GET /api/video/list?project_id=${memberProbe.project.id}`,
          result,
          memberProbe.project.id,
        );
      },
    });
  }

  for (const probe of cases) {
    await runCase(baseUrl, timeoutMs, probe);
  }

  log(`permission matrix passed (${cases.length} HTTP checks)`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
