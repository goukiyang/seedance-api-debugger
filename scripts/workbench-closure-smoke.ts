import crypto from 'crypto';
import fs from 'fs';
import { execFileSync } from 'node:child_process';
import { loadEnvConfig } from '@next/env';
import { PrismaClient } from '@prisma/client';

const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-in-production';
const SESSION_COOKIE = 'session';
const SAMPLE_IMAGE = 'public/videos/thumbnails/cmpqps1yb003eqkla01irzly7.jpg';

type AnyJson = Record<string, any>;

type HttpResponse = {
  status: number;
  statusText: string;
  text: string;
  json: AnyJson;
};

type SmokeProjectResolution = {
  id: string;
  mode: 'reused' | 'created' | 'unique';
  name: string;
};

function log(message: string, ...rest: Array<string | number | boolean>) {
  console.log(`[closure-smoke] ${message}`, ...rest);
}

function fail(message: string): never {
  throw new Error(message);
}

async function request(
  baseUrl: string,
  path: string,
  cookie: string,
  opts: RequestInit = {},
  timeoutMs = 30000,
  retries = 3,
): Promise<HttpResponse> {
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        ...opts,
        signal: controller.signal,
        headers: {
          Accept: path.startsWith('/api/') ? 'application/json' : 'text/html',
          ...(opts.headers || {}),
          ...(cookie ? { Cookie: `${SESSION_COOKIE}=${cookie}` } : {}),
        },
        cache: 'no-store',
      });
      const text = await response.text();
      let parsed: AnyJson = {};
      if (response.headers.get('content-type')?.includes('application/json')) {
        try {
          parsed = JSON.parse(text || '{}') as AnyJson;
        } catch (parseError) {
          fail(`response json parse failed on ${path}: ${(parseError as Error).message}`);
        }
      }
      return {
        status: response.status,
        statusText: response.statusText,
        text,
        json: parsed,
      };
    } catch (error) {
      if (attempt >= retries) {
        const message = error instanceof Error ? error.message : String(error);
        fail(`request failed on ${path} (attempt ${attempt}/${retries}): ${message}`);
      }
      await wait(500 * attempt);
      continue;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(`request failed on ${path} after ${retries} attempts`);
}

function assertStatus(step: string, actual: number, expected: number | number[]) {
  const expectedList = Array.isArray(expected) ? expected : [expected];
  if (!expectedList.includes(actual)) {
    fail(`${step} failed: status=${actual}, expected=${expectedList.join(' / ')}`);
  }
  log(`${step} -> ${actual}`);
}

function buildSessionCookie(userId: string) {
  const payload = Buffer.from(userId).toString('base64');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64');
  return `${payload}.${sig}`;
}

async function resolveAuthCookie(): Promise<string> {
  if (process.env.TEST_AUTH_COOKIE) return process.env.TEST_AUTH_COOKIE;
  const prisma = new PrismaClient();
  try {
    const user = await prisma.user.findFirst({
      where: { status: 'active' },
      orderBy: [{ role: 'asc' }, { created_at: 'asc' }],
      select: { id: true },
    });
    if (!user?.id) return '';
    return buildSessionCookie(user.id);
  } finally {
    await prisma.$disconnect();
  }
}

function randomSuffix() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function resolveSmokeProject(
  baseUrl: string,
  cookie: string,
  ownerUserId: string | undefined,
  timeoutMs: number,
): Promise<SmokeProjectResolution> {
  const explicitProjectId = process.env.SMOKE_PROJECT_ID?.trim();
  if (explicitProjectId) {
    const projectRes = await request(baseUrl, `/api/projects/${explicitProjectId}`, cookie, { method: 'GET' }, timeoutMs);
    assertStatus('GET /api/projects/:id SMOKE_PROJECT_ID', projectRes.status, 200);
    const projectName = String(projectRes.json?.project?.name || explicitProjectId);
    return { id: explicitProjectId, mode: 'reused', name: projectName };
  }

  const allowUniqueProject = process.env.SMOKE_CREATE_UNIQUE_PROJECT === '1';
  const projectName = allowUniqueProject
    ? `Smoke Project ${randomSuffix()}`
    : (process.env.SMOKE_PROJECT_NAME?.trim() || 'Smoke Project Archive');

  if (!allowUniqueProject && ownerUserId) {
    const prisma = new PrismaClient();
    try {
      const existing = await prisma.project.findFirst({
        where: {
          name: projectName,
          owner_user_id: ownerUserId,
          status: { not: 'deleted' },
        },
        orderBy: { created_at: 'asc' },
        select: { id: true, name: true },
      });
      if (existing) {
        return { id: existing.id, mode: 'reused', name: existing.name };
      }
    } finally {
      await prisma.$disconnect();
    }
  }

  const createProjectRes = await request(
    baseUrl,
    '/api/projects',
    cookie,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: projectName,
        type: 'team',
        description: allowUniqueProject ? 'closure smoke unique project' : 'closure smoke reusable project',
      }),
    },
    timeoutMs,
  );
  assertStatus('POST /api/projects', createProjectRes.status, [200, 201]);
  const project = createProjectRes.json.project as { id: string; name?: string } | undefined;
  if (!project?.id) fail('POST /api/projects missing project.id');
  return {
    id: project.id,
    mode: allowUniqueProject ? 'unique' : 'created',
    name: project.name || projectName,
  };
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function uploadAssetViaCurl(baseUrl: string, cookie: string, filePath: string): Promise<AnyJson> {
  if (!fs.existsSync(filePath)) fail(`sample image not found: ${filePath}`);
  const output = execFileSync(
    'curl',
    [
      '-sS',
      '-X',
      'POST',
      '-H',
      `Cookie: ${SESSION_COOKIE}=${cookie}`,
      '-F',
      `file=@${filePath};type=image/jpeg`,
      `${baseUrl}/api/assets/upload`,
    ],
    { encoding: 'utf8' },
  );
  try {
    return JSON.parse(output || '{}') as AnyJson;
  } catch (parseError) {
    fail(`upload response parse failed: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
  }
}

async function main() {
  loadEnvConfig(process.cwd());
  const baseUrl = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
  const timeoutMs = Number(process.env.TIMEOUT_MS || 30_000);
  const pollMax = Number(process.env.CLOSURE_POLL_MAX || 80);
  const pollInterval = Number(process.env.CLOSURE_POLL_INTERVAL_MS || 3000);
  const allowPaidProviderSmoke = process.env.ALLOW_PAID_PROVIDER_SMOKE === '1';
  const paidGenerationReason = process.env.PAID_GENERATION_REASON
    || '用户显式允许 ALLOW_PAID_PROVIDER_SMOKE=1 执行真实付费闭环生成';

  log(`baseUrl=${baseUrl}`);
  if (!allowPaidProviderSmoke) {
    log('paid provider generation is disabled; set ALLOW_PAID_PROVIDER_SMOKE=1 to create a real video task');
  }

  const cookie = await resolveAuthCookie();
  if (!cookie) fail('No active user found and no TEST_AUTH_COOKIE provided');

  const meRes = await request(baseUrl, '/api/auth/me', cookie, { method: 'GET' }, timeoutMs);
  assertStatus('GET /api/auth/me', meRes.status, 200);
  if (!meRes.json.user) fail('GET /api/auth/me returned null user');
  const me = meRes.json.user as { id?: string };
  log(`me userId=${me.id || 'unknown'}`);

  // 1) 解析 smoke 项目。默认复用固定项目，避免反复制造随机 Smoke Project。
  const project = await resolveSmokeProject(baseUrl, cookie, me.id, timeoutMs);
  log(`project ${project.mode} id=${project.id} name=${project.name}`);

  // 2) 新建画布
  const canvasRes = await request(
    baseUrl,
    '/api/canvases',
    cookie,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: `Smoke Canvas ${randomSuffix()}`,
        project_id: project.id,
        document: {
          version: 1,
          title: 'Smoke Canvas',
          nodes: [],
          edges: [],
          viewport: { x: 0, y: 0, zoom: 1 },
          activeGenerationId: null,
        },
      }),
    },
    timeoutMs,
  );
  assertStatus('POST /api/canvases', canvasRes.status, 200);
  const canvas = canvasRes.json.canvas as { id: string } | undefined;
  if (!canvas?.id) fail('POST /api/canvases missing canvas.id');
  log(`canvas created id=${canvas.id}`);

  // 3) 上传素材（使用 curl，规避 Node fetch/FormData 在当前环境的兼容风险）
  const uploadPayload = await uploadAssetViaCurl(baseUrl, cookie, `${process.cwd()}/${SAMPLE_IMAGE}`);
  if (uploadPayload.success !== true) {
    fail(`POST /api/assets/upload failed: ${JSON.stringify(uploadPayload)}`);
  }
  const asset = uploadPayload.asset as { id?: string; isPubliclyReachable?: boolean } | undefined;
  if (!asset?.id) fail('POST /api/assets/upload missing asset.id');
  if (asset.isPubliclyReachable === false) fail('POST /api/assets/upload returned non-public asset');
  log(`asset uploaded id=${asset.id}`);

  // 4) 加入工作台，生成 referenceImageId
  const workspaceAddRes = await request(
    baseUrl,
    '/api/workspace/assets',
    cookie,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        assetId: asset.id,
        role: 'reference_image',
        replace: true,
      }),
    },
    timeoutMs,
  );
  assertStatus('POST /api/workspace/assets', workspaceAddRes.status, 200);
  const referenceImageId = workspaceAddRes.json.referenceImageId as string | undefined;
  if (!referenceImageId) fail('POST /api/workspace/assets missing referenceImageId');
  log(`workspace referenceImageId=${referenceImageId}`);

  if (!allowPaidProviderSmoke) {
    console.log(
      JSON.stringify({
        ok: true,
        skippedPaidProviderSmoke: true,
        userId: me.id,
        projectId: project.id,
        canvasId: canvas.id,
        assetId: asset.id,
        referenceImageId,
      }, null, 2),
    );
    return;
  }

  // 5) 创建任务
  const taskSourceRequestId = `workbench-closure-smoke-${randomSuffix()}`;
  const taskCreateRes = await request(
    baseUrl,
    '/api/tasks/create',
    cookie,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Paid-Generation-Intent': 'user_authorized_real_provider',
        'X-Paid-Generation-Reason': paidGenerationReason,
      },
      body: JSON.stringify({
        project_id: project.id,
        prompt: `closure smoke prompt ${randomSuffix()}`,
        generation_mode: 'all_in_one_reference',
        ratio: '16:9',
        duration: 5,
        resolution: '720p',
        reference_image_ids: [referenceImageId],
        client_name: 'workbench-closure-smoke',
        source_request_id: taskSourceRequestId,
      }),
    },
    timeoutMs,
  );
  assertStatus('POST /api/tasks/create', taskCreateRes.status, [200, 201]);
  const task = taskCreateRes.json as { id?: string };
  if (!task.id) fail(`POST /api/tasks/create missing task id: ${JSON.stringify(taskCreateRes.json)}`);
  log(`task created id=${task.id}`);

  // 6) 轮询结果
  let taskStatus = 'submitted';
  let resultVideoUrl: string | null = null;
  let attempts = 0;
  while (attempts < pollMax) {
    attempts += 1;
    const taskStatusRes = await request(
      baseUrl,
      `/api/video/status/${task.id}`,
      cookie,
      { method: 'GET' },
      timeoutMs,
    );
    assertStatus(`GET /api/video/status/${task.id}`, taskStatusRes.status, 200);
    taskStatus = String((taskStatusRes.json.local_status || taskStatusRes.json.status || 'unknown'));
    log(`poll ${attempts}/${pollMax}: ${taskStatus}`);
    if (taskStatusRes.json.result_video_url) {
      resultVideoUrl = String(taskStatusRes.json.result_video_url);
    }
    if (['succeeded', 'failed', 'cancelled'].includes(taskStatus)) {
      break;
    }
    await wait(pollInterval);
  }

  if (taskStatus !== 'succeeded') fail(`task final status=${taskStatus}`);
  if (!resultVideoUrl) fail('succeeded task but result_video_url is empty');
  log(`task succeeded result=${resultVideoUrl}`);

  // 7) 下载并校验本地文件是否可访问
  const downloadRes = await request(
    baseUrl,
    `/api/video/download/${task.id}`,
    cookie,
    { method: 'POST' },
    timeoutMs,
  );
  assertStatus('POST /api/video/download/:id', downloadRes.status, [200, 201]);
  if (downloadRes.json.success !== true) fail(`download failed: ${JSON.stringify(downloadRes.json)}`);
  const localVideoPath = downloadRes.json.local_video_path as string;
  log(`video downloaded to ${localVideoPath}`);

  // 8) 保存画布 + 刷新重开检查
  const savePayload = {
    title: 'Smoke Canvas Reopen',
    project_id: project.id,
    document: {
      version: 1,
      title: 'Smoke Canvas Reopen',
      nodes: [
        {
          id: 'n-closure-1',
          type: 'textCard',
          data: { text: '闭环测试文本' },
          position: { x: 120, y: 80 },
        },
      ],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      activeGenerationId: null,
    },
  };
  const saveRes = await request(
    baseUrl,
    `/api/canvases/${canvas.id}`,
    cookie,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(savePayload),
    },
    timeoutMs,
  );
  assertStatus('PUT /api/canvases/:id', saveRes.status, 200);
  if (!(typeof (saveRes.json as { canvas?: { id?: string } }).canvas?.id === 'string')) {
    fail('PUT /api/canvases/:id missing canvas');
  }

  const reopenRes = await request(baseUrl, `/api/canvases/${canvas.id}`, cookie, { method: 'GET' }, timeoutMs);
  assertStatus('GET /api/canvases/:id', reopenRes.status, 200);
  const reopenedTitle = reopenRes.json?.canvas?.title;
  if (reopenedTitle !== 'Smoke Canvas Reopen') {
    fail(`reopen title mismatch: ${String(reopenedTitle)}`);
  }
  const reopenedNodes = reopenRes.json?.canvas?.document?.nodes;
  if (!Array.isArray(reopenedNodes) || reopenedNodes.length !== 1) {
    fail(`reopen nodes mismatch: ${JSON.stringify(reopenedNodes)}`);
  }

  console.log(
    JSON.stringify({
      ok: true,
      userId: me.id,
      projectId: project.id,
      canvasId: canvas.id,
      taskId: task.id,
      taskPolls: attempts,
      resultVideoUrl,
      localVideoPath,
    }, null, 2),
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
