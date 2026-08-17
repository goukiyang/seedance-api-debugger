import crypto from 'crypto';
import { loadEnvConfig } from '@next/env';
import { PrismaClient } from '@prisma/client';

type SmokeResponse = {
  status: number;
  text: string;
  contentType: string;
};

const baseUrl = (process.env.BASE_URL || 'http://localhost:3001').replace(/\/+$/, '');
const timeoutMs = Number(process.env.TIMEOUT_MS || 30000);
const sessionCookieName = process.env.SESSION_COOKIE_NAME || 'session';

function log(message: string) {
  console.log(`[project-ui-smoke] ${message}`);
}

function fail(message: string): never {
  throw new Error(message);
}

async function request(path: string, cookie?: string): Promise<SmokeResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      cache: 'no-store',
      redirect: 'manual',
      headers: {
        Accept: path.startsWith('/api/') ? 'application/json' : 'text/html',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      signal: controller.signal,
    });

    return {
      status: response.status,
      text: await response.text(),
      contentType: response.headers.get('content-type') || '',
    };
  } finally {
    clearTimeout(timeout);
  }
}

function assertStatus(name: string, actual: number, expected: number | number[]) {
  const expectedList = Array.isArray(expected) ? expected : [expected];
  if (!expectedList.includes(actual)) {
    fail(`${name} returned ${actual}, expected ${expectedList.join('/')}`);
  }
  log(`${name} -> ${actual}`);
}

function buildSessionCookie(userId: string) {
  const secret = process.env.SESSION_SECRET || 'dev-secret-change-in-production';
  const payload = Buffer.from(userId).toString('base64');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64');
  return `${sessionCookieName}=${payload}.${sig}`;
}

async function resolveAuthCookie() {
  if (process.env.TEST_AUTH_COOKIE) return process.env.TEST_AUTH_COOKIE;
  if (process.env.TEST_SESSION_TOKEN) return `${sessionCookieName}=${process.env.TEST_SESSION_TOKEN}`;
  if (process.env.TEST_USER_ID) return buildSessionCookie(process.env.TEST_USER_ID);

  const prisma = new PrismaClient();
  try {
    const user = await prisma.user.findFirst({
      where: { status: 'active' },
      orderBy: [{ role: 'asc' }, { created_at: 'asc' }],
      select: { id: true },
    });
    return user ? buildSessionCookie(user.id) : '';
  } finally {
    await prisma.$disconnect();
  }
}

async function assertJsonObject(name: string, response: SmokeResponse) {
  if (!response.contentType.includes('application/json')) {
    fail(`${name} returned non-json content-type: ${response.contentType || '(empty)'}`);
  }

  try {
    return JSON.parse(response.text) as Record<string, unknown>;
  } catch {
    fail(`${name} returned invalid JSON`);
  }
}

async function main() {
  loadEnvConfig(process.cwd());
  log(`baseUrl=${baseUrl}`);

  const login = await request('/login');
  assertStatus('GET /login', login.status, 200);

  const anonymousGenerate = await request('/generate');
  assertStatus('GET /generate anonymous', anonymousGenerate.status, [307, 308]);

  const anonymousCanvas = await request('/generate/canvas');
  assertStatus('GET /generate/canvas anonymous', anonymousCanvas.status, [307, 308]);

  const authCookie = await resolveAuthCookie();
  if (!authCookie) {
    log('skip auth checks: no active local user or TEST_* auth env provided');
    return;
  }

  const me = await request('/api/auth/me', authCookie);
  assertStatus('GET /api/auth/me auth', me.status, 200);
  const meJson = await assertJsonObject('GET /api/auth/me auth', me);
  if (!meJson.user) fail('GET /api/auth/me auth returned user=null');

  const projects = await request('/api/projects', authCookie);
  assertStatus('GET /api/projects auth', projects.status, 200);
  const projectsJson = await assertJsonObject('GET /api/projects auth', projects);
  if (!Array.isArray(projectsJson.projects)) fail('GET /api/projects auth did not return projects[]');

  const generate = await request('/generate', authCookie);
  assertStatus('GET /generate auth', generate.status, 200);

  const canvas = await request('/generate/canvas', authCookie);
  assertStatus('GET /generate/canvas auth', canvas.status, 200);

  log('read-only project UI smoke passed');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
