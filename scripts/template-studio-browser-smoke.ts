import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const projectRoot = process.cwd();
const localRequire = createRequire(path.join(projectRoot, 'package.json'));
const browserTimeout = 30_000;
const smokeId = randomUUID();
const databaseRoot = mkdtempSync(path.join(os.tmpdir(), 'template-studio-browser-db-'));
const databasePath = path.join(databaseRoot, 'studio-smoke.db');
const databaseUrl = `file:${databasePath}`;
const sessionSecret = randomBytes(32).toString('hex');
const tenantAllowlist = `template-studio-smoke-${smokeId}`;
const artifactRoot = mkdtempSync(path.join(os.tmpdir(), 'template-studio-browser-artifacts-'));
const createdAssetFiles: string[] = [];
const fixtureUploadPreviews = new Map<string, { body: Buffer; contentType: string }>();
const publicUploads = path.join(projectRoot, 'public', 'uploads');
const publicAssetDirectory = path.join(publicUploads, 'assets');
const uploadsDirectoryExisted = existsSync(publicUploads);
const assetDirectoryExisted = existsSync(publicAssetDirectory);
let prisma: any = null;
let browser: any = null;
let failureCapturePage: any = null;
let server: ChildProcess | null = null;
let serverOutput = '';
let externalBrowserRequestCount = 0;
let expectedExternalStaticRequestCount = 0;
let allowedNonNetworkRequestCount = 0;
const externalBrowserRequests = new Map<string, SafeExternalRequestDiagnostic>();
const expectedExternalStaticRequests = new Map<string, SafeExternalRequestDiagnostic>();

type FixtureAccount = {
  username: string;
  email: string;
  password: string;
};

type StudioApiDiagnostic = { method: string; path: string; status: number | null; code?: string; error?: string };
type PlaywrightRequestLike = { method(): string; postDataJSON(): unknown };
type PlaywrightResponseLike = { request(): PlaywrightRequestLike; status(): number; url(): string };
type SafeExternalRequestDiagnostic = {
  host: string;
  method: string;
  resourceType: string;
  pathClass: string;
  count: number;
};

const studioApiDiagnostics = new WeakMap<object, StudioApiDiagnostic[]>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function log(message: string) {
  console.log(`[template-studio-browser-smoke] ${message}`);
}

function safeScriptStack(error: unknown) {
  const stack = error instanceof Error && typeof error.stack === 'string' ? error.stack : '';
  const locations = stack.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/template-studio-browser-smoke\.(?:[cm]?js|tsx?):(\d+):(\d+)/);
    if (!match) return [];
    const lineNumber = Number(match[1]);
    const columnNumber = Number(match[2]);
    return Number.isSafeInteger(lineNumber) && Number.isSafeInteger(columnNumber)
      ? [{ line: lineNumber, column: columnNumber }]
      : [];
  });
  return locations.filter((location, index) => locations.findIndex((candidate) => candidate.line === location.line && candidate.column === location.column) === index).slice(0, 8);
}

function safeExternalPathClass(pathname: string) {
  const visibleSegments = new Set(['_next', 'static', 'assets', 'fonts', 'font', 'images', 'image', 'avatars', 'avatar', 'media', 'uploads', 'thumbnail', 'thumbnails', 'css', 'js', 'icons']);
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0) return '/';
  return `/${segments.map((segment) => {
    const extension = path.posix.extname(segment).toLowerCase();
    if (visibleSegments.has(segment.toLowerCase())) return segment.toLowerCase();
    if (/^\.[a-z0-9]{1,8}$/.test(extension)) return `[${extension.slice(1)}]`;
    return '[segment]';
  }).join('/')}`;
}

function recordSafeExternalRequest(summary: Map<string, SafeExternalRequestDiagnostic>, request: any) {
  let diagnostic: SafeExternalRequestDiagnostic;
  try {
    const url = new URL(request.url());
    diagnostic = {
      host: url.hostname || '[no-host]',
      method: request.method(),
      resourceType: request.resourceType(),
      pathClass: safeExternalPathClass(url.pathname),
      count: 0,
    };
  } catch {
    diagnostic = {
      host: '[unavailable]',
      method: String(request.method?.() || 'UNKNOWN'),
      resourceType: String(request.resourceType?.() || 'unknown'),
      pathClass: '[unavailable]',
      count: 0,
    };
  }
  const key = JSON.stringify([diagnostic.host, diagnostic.method, diagnostic.resourceType, diagnostic.pathClass]);
  const existing = summary.get(key);
  if (existing) existing.count += 1;
  else summary.set(key, { ...diagnostic, count: 1 });
}

function logBlockedExternalRequestSummary() {
  const entries = Array.from(externalBrowserRequests.values());
  if (entries.length) log(`blocked non-local browser requests (safe summary): ${JSON.stringify(entries)}`);
  const expectedStaticEntries = Array.from(expectedExternalStaticRequests.values());
  if (expectedStaticEntries.length) log(`fulfilled known upload-preview fixtures (safe summary): ${JSON.stringify(expectedStaticEntries)}`);
}

function trackStudioApiDiagnostics(page: any, baseUrl: string) {
  const entries: StudioApiDiagnostic[] = [];
  const requests = new WeakMap<object, StudioApiDiagnostic>();
  studioApiDiagnostics.set(page, entries);
  const getStudioApiPath = (request: any) => {
    const url = new URL(request.url());
    const isWorkbenchApi = url.pathname === '/api/template-studio' || url.pathname.startsWith('/api/template-studio/');
    const isAdminWorkbenchApi = url.pathname === '/api/admin/template-studio' || url.pathname.startsWith('/api/admin/template-studio/');
    if (url.origin !== baseUrl || (!isWorkbenchApi && !isAdminWorkbenchApi)) return null;
    return url.pathname.replace(/\/(drafts|runs|templates)\/[^/]+(?=\/|$)/g, '/$1/[id]');
  };
  page.on('request', (request: any) => {
    try {
      const pathname = getStudioApiPath(request);
      if (!pathname) return;
      const entry: StudioApiDiagnostic = { method: request.method(), path: pathname, status: null };
      entries.push(entry);
      if (entries.length > 120) entries.shift();
      requests.set(request, entry);
    } catch { /* Diagnostics must not affect browser behavior. */ }
  });
  page.on('response', (response: any) => {
    const entry = requests.get(response.request());
    if (!entry) return;
    const status = response.status();
    entry.status = status;
    if (status === 405) {
      entry.code = 'METHOD_NOT_ALLOWED';
      entry.error = '接口不支持此请求方法';
      return;
    }
    if (!(status < 500 || status === 503)) return;
    void response.json().then((body: unknown) => {
      if (!body || typeof body !== 'object' || Array.isArray(body)) return;
      const apiError = body as { code?: unknown; error?: unknown };
      if (typeof apiError.code === 'string' && /^[A-Z_]{2,40}$/.test(apiError.code)) entry.code = apiError.code;
      if (typeof apiError.error === 'string') {
        const safeError = apiError.error.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
        if (safeError && safeError.length <= 240) entry.error = safeError;
      }
    }).catch(() => undefined);
  });
  page.on('requestfailed', (request: any) => {
    const entry = requests.get(request);
    if (entry && entry.status === null) entry.error = '未收到 HTTP 响应';
  });
}

function nextSyntheticReleaseVersion() {
  const packageInfo = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8')) as { version?: unknown };
  const match = typeof packageInfo.version === 'string' ? /^(\d+)\.(\d+)\.(\d+)$/.exec(packageInfo.version) : null;
  if (!match) throw new Error('Browser smoke requires a stable SemVer package version for the isolated release check');
  const patch = Number(match[3]);
  if (!Number.isSafeInteger(patch) || patch >= Number.MAX_SAFE_INTEGER) throw new Error('Package patch version cannot be incremented safely');
  return `${match[1]}.${match[2]}.${patch + 1}`;
}

async function captureBrowserFailure(error: unknown) {
  const page = failureCapturePage;
  if (!page || page.isClosed()) return null;
  const screenshotPath = path.join(artifactRoot, 'template-studio-browser-failure.png');
  const reportPath = path.join(artifactRoot, 'template-studio-browser-failure.json');
  await page.screenshot({ path: screenshotPath, fullPage: false, animations: 'disabled' }).catch(() => undefined);
  const layout = await page.evaluate(() => {
    const safeLabels = new Set(['图片', '视频', '模板', '我的提示词', '视频结果', '提示词', '新建空白模块', 'AI整理']);
    const labelFor = (element: Element, index: number) => {
      const text = (element.textContent || '').replace(/\s+/g, ' ').trim();
      return safeLabels.has(text) ? text : `element-${index + 1}`;
    };
    const describe = (element: Element | null, label: string) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        label,
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute('role'),
        ariaSelected: element.getAttribute('aria-selected'),
        disabled: element instanceof HTMLButtonElement ? element.disabled : undefined,
        rect: {
          x: Math.round(rect.x * 10) / 10,
          y: Math.round(rect.y * 10) / 10,
          width: Math.round(rect.width * 10) / 10,
          height: Math.round(rect.height * 10) / 10,
        },
        computed: {
          display: style.display,
          position: style.position,
          flexDirection: style.flexDirection,
          flexWrap: style.flexWrap,
          alignItems: style.alignItems,
          justifyContent: style.justifyContent,
          gap: style.gap,
          overflowX: style.overflowX,
          overflowY: style.overflowY,
          pointerEvents: style.pointerEvents,
          zIndex: style.zIndex,
          width: style.width,
          minWidth: style.minWidth,
          maxWidth: style.maxWidth,
          transform: style.transform,
        },
      };
    };
    const workbench = document.querySelector('[aria-label="视频模板工作区"]');
    const header = workbench?.querySelector(':scope > header') || null;
    const tabs = Array.from(workbench?.querySelectorAll('[role="tab"]') || []);
    const buttons = Array.from(header?.querySelectorAll('button') || []);
    const headerChildren = Array.from(header?.children || []);
    const tabHits = tabs.map((tab, index) => {
      const rect = tab.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      const pointerTarget = hit?.closest('button,[role="tab"]') || hit;
      return {
        tab: describe(tab, labelFor(tab, index)),
        pointerTarget: describe(pointerTarget, labelFor(pointerTarget || tab, index)),
      };
    });
    return {
      pathname: window.location.pathname,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      workbench: describe(workbench, 'video-workbench'),
      header: describe(header, 'video-header'),
      headerChildren: headerChildren.map((element, index) => describe(element, `header-child-${index + 1}`)),
      tabs: tabs.map((element, index) => describe(element, labelFor(element, index))),
      buttons: buttons.map((element, index) => describe(element, labelFor(element, index))),
      tabHits,
    };
  }).catch(() => ({ pathname: 'unavailable', viewport: null, workbench: null, header: null, headerChildren: [], tabs: [], buttons: [], tabHits: [] }));
  const errorMessage = error instanceof Error ? error.message : String(error);
  const scriptStack = safeScriptStack(error);
  const failure = error instanceof Error
    ? { name: error.name, summary: errorMessage.split(/\r?\n/, 1)[0].slice(0, 300), scriptStack }
    : { name: 'Error', summary: errorMessage.split(/\r?\n/, 1)[0].slice(0, 300), scriptStack };
  const apiRequests = studioApiDiagnostics.get(page) || [];
  writeFileSync(reportPath, JSON.stringify({
    failure,
    layout,
    studioApiRequests: apiRequests,
    blockedExternalRequests: Array.from(externalBrowserRequests.values()),
    expectedExternalStaticRequests: Array.from(expectedExternalStaticRequests.values()),
    allowedNonNetworkRequestCount,
  }, null, 2), { flag: 'wx', mode: 0o600 });
  return { screenshotPath, reportPath };
}

function safeChildEnvironment(port?: number, networkGuardPath?: string) {
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: process.env.HOME || os.homedir(),
    TMPDIR: process.env.TMPDIR || os.tmpdir(),
    LANG: process.env.LANG || 'C.UTF-8',
    NODE_ENV: 'production',
    DATABASE_URL: databaseUrl,
    SESSION_SECRET: sessionSecret,
    NEXT_TELEMETRY_DISABLED: '1',
    FEISHU_ALLOWED_TENANT_KEY: tenantAllowlist,
    FEISHU_APP_ID: '',
    FEISHU_APP_SECRET: '',
    FEISHU_LOGIN_ENABLED: 'false',
    SEEDANCE_API_KEY: 'fixture-only',
    SEEDANCE_BASE_URL: 'https://provider-blocked.invalid',
    MUSK_API_KEY: '',
    MUSK_API_BASE_URL: '',
    H3_API_TOKEN: '',
    H3_ADMIN_TOKEN: '',
    H3_API_BASE_URL: '',
    H3_BASE_URL: '',
    VOLCENGINE_IP_API_KEY: '',
    ARK_API_KEY: '',
    VOLCENGINE_IP_BASE_URL: '',
    ARK_BASE_URL: '',
    AI_MEDIAKIT_API_KEY: '',
    AI_MEDIAKIT_BASE_URL: '',
    R2_ACCOUNT_ID: '',
    R2_ACCESS_KEY_ID: '',
    R2_SECRET_ACCESS_KEY: '',
    R2_BUCKET: '',
    TOS_ACCESS_KEY: '',
    TOS_SECRET_KEY: '',
    ...(process.env.NEXT_DIST_DIR ? { NEXT_DIST_DIR: process.env.NEXT_DIST_DIR } : {}),
    ...(port ? { PORT: String(port), HOSTNAME: '127.0.0.1' } : {}),
    ...(networkGuardPath ? { NODE_OPTIONS: `--require=${networkGuardPath}` } : {}),
  };
  return environment;
}

function makeNetworkGuardSource() {
  return `
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const originalFetch = globalThis.fetch;
let reported = false;
function isLocal(host) {
  const value = String(host || 'localhost').toLowerCase().replace(/^\\[|\\]$/g, '');
  return value === 'localhost' || value === '127.0.0.1' || value === '::1';
}
function hostFrom(input, rest) {
  if (input instanceof URL) return input.hostname;
  if (typeof input === 'string') {
    try { return new URL(input).hostname; } catch { return 'localhost'; }
  }
  if (typeof input === 'number') {
    const options = rest[0];
    return typeof options === 'string' ? options : options && (options.hostname || options.host) || 'localhost';
  }
  if (input && typeof input === 'object') return input.hostname || input.host || 'localhost';
  return 'localhost';
}
function block() {
  if (!reported) {
    reported = true;
    process.stderr.write('[template-studio-smoke-guard] blocked non-local network request\\n');
  }
  throw new Error('Template Studio browser smoke blocks all non-local network requests');
}
for (const client of [http, https]) {
  for (const method of ['request', 'get']) {
    const original = client[method];
    client[method] = function(input, ...rest) {
      if (!isLocal(hostFrom(input, rest))) block();
      return Reflect.apply(original, client, [input, ...rest]);
    };
  }
}
for (const method of ['connect', 'createConnection']) {
  const original = net[method];
  net[method] = function(input, ...rest) {
    if (!isLocal(hostFrom(input, rest))) block();
    return Reflect.apply(original, net, [input, ...rest]);
  };
}
globalThis.fetch = async function(input, ...rest) {
  const raw = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
  let host = 'localhost';
  try { host = new URL(raw, 'http://localhost').hostname; } catch {}
  if (!isLocal(host)) block();
  return Reflect.apply(originalFetch, globalThis, [input, ...rest]);
};
`;
}

function verifyLocalBuild() {
  const configuredDist = process.env.NEXT_DIST_DIR?.trim() || '.next';
  const distPath = path.resolve(projectRoot, configuredDist);
  const relative = path.relative(projectRoot, distPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Refusing to start Next outside the project build directory');
  }
  const buildIdPath = path.join(distPath, 'BUILD_ID');
  if (!existsSync(buildIdPath) || !lstatSync(buildIdPath).isFile()) {
    throw new Error(`Production build not found at ${buildIdPath}; runner must build before this smoke`);
  }
  return configuredDist;
}

function pushIsolatedDatabase() {
  const prismaCli = path.join(projectRoot, 'node_modules', 'prisma', 'build', 'index.js');
  if (!existsSync(prismaCli)) throw new Error('Local Prisma CLI is unavailable; do not install dependencies for this smoke');
  writeFileSync(databasePath, '', { flag: 'wx', mode: 0o600 });
  const result = spawnSync(process.execPath, [
    prismaCli,
    'db',
    'push',
    '--skip-generate',
    '--schema',
    path.join(projectRoot, 'prisma', 'schema.prisma'),
  ], {
    cwd: projectRoot,
    env: safeChildEnvironment(),
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (result.status !== 0) {
    throw new Error(`Isolated Prisma db push failed.\n${result.stdout || ''}\n${result.stderr || ''}`);
  }
  const stat = lstatSync(databasePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Smoke database must be a regular non-symlink file');
}

async function reserveLocalPort() {
  const listener = net.createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => resolve());
  });
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a localhost port');
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function startNext(port: number, networkGuardPath: string) {
  const nextBin = path.join(projectRoot, 'node_modules', 'next', 'dist', 'bin', 'next');
  if (!existsSync(nextBin)) throw new Error('Local Next.js CLI is unavailable; do not install dependencies for this smoke');
  const child = spawn(process.execPath, [nextBin, 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: projectRoot,
    env: safeChildEnvironment(port, networkGuardPath),
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => { serverOutput = `${serverOutput}${chunk.toString()}`.slice(-16_000); });
  child.stderr?.on('data', (chunk: Buffer) => { serverOutput = `${serverOutput}${chunk.toString()}`.slice(-16_000); });
  return child;
}

async function waitForServer(child: ChildProcess, baseUrl: string) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`next start exited before becoming ready.\n${serverOutput}`);
    try {
      const response = await fetch(`${baseUrl}/login`, { signal: AbortSignal.timeout(3_000) });
      if (response.ok) return;
    } catch { /* The local server is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for next start.\n${serverOutput}`);
}

async function stopNext(child: ChildProcess | null) {
  if (!child || child.exitCode !== null || child.killed) return;
  try {
    if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
    else child.kill('SIGTERM');
  } catch { child.kill('SIGTERM'); }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve();
    }, 5_000);
    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once('exit', onExit);
  });
  if (child.exitCode === null) {
    try {
      if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch { child.kill('SIGKILL'); }
  }
}

function installLocalOnlyBrowserRoutes(context: any) {
  return context.route('**/*', async (route: any) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.protocol === 'data:' || url.protocol === 'blob:') {
      allowedNonNetworkRequestCount += 1;
      await route.continue();
      return;
    }
    // Production-mode asset serialization rewrites these smoke-owned local uploads to the site's public origin.
    const fixturePreview = url.origin === 'https://sd2.youdooart.com'
      && request.method() === 'GET'
      && (request.resourceType() === 'image' || request.resourceType() === 'media')
      ? fixtureUploadPreviews.get(url.pathname)
      : undefined;
    if (fixturePreview) {
      expectedExternalStaticRequestCount += 1;
      recordSafeExternalRequest(expectedExternalStaticRequests, request);
      await route.fulfill({ status: 200, contentType: fixturePreview.contentType, body: fixturePreview.body });
      return;
    }
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1') {
      await route.continue();
      return;
    }
    externalBrowserRequestCount += 1;
    recordSafeExternalRequest(externalBrowserRequests, request);
    await route.abort('blockedbyclient');
  });
}

async function loginThroughUi(page: any, account: FixtureAccount, nextPath: string) {
  await page.goto(`/login?next=${encodeURIComponent(nextPath)}`);
  const openLogin = page.getByRole('button', { name: '使用账号密码登录' });
  if (await openLogin.count()) await openLogin.click();
  await page.locator('input[name="identifier"]').fill(account.username);
  await page.locator('input[name="password"]').fill(account.password);
  await Promise.all([
    page.waitForURL((url: URL) => url.pathname !== '/login', { timeout: browserTimeout }),
    page.getByRole('button', { name: '登录', exact: true }).click(),
  ]);
}

async function browserJson(page: any, url: string, method: string, body?: unknown) {
  return page.evaluate(async (input: { url: string; method: string; body?: unknown }) => {
    const response = await fetch(input.url, {
      method: input.method,
      cache: 'no-store',
      ...(input.body === undefined ? {} : {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input.body),
      }),
    });
    let payload: unknown;
    try { payload = await response.json(); } catch { payload = null; }
    return { status: response.status, payload };
  }, { url, method, body });
}

async function createAccount(prismaClient: any, hashPassword: (password: string) => string, role: 'admin' | 'user', accountType: 'internal' | 'external', feishuTenant?: string) {
  const username = `studio-smoke-${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const email = `${username}@example.invalid`;
  const password = randomBytes(24).toString('base64url');
  const feishuIdentity = feishuTenant ? {
    feishu_user_id: `${username}-user`,
    feishu_open_id: `${username}-open`,
    feishu_union_id: `${username}-union`,
    feishu_tenant_key: feishuTenant,
    feishu_employee_no: `${username}-employee`,
    feishu_department_ids: '[]',
    feishu_raw_profile: '{}',
    last_feishu_sync_at: new Date(),
  } : {};
  const user = await prismaClient.user.create({
    data: {
      name: `Template Studio ${role}`,
      username,
      email,
      password_hash: hashPassword(password),
      role,
      account_type: accountType,
      ...feishuIdentity,
    },
  });
  return { user, account: { username, email, password } satisfies FixtureAccount };
}

async function addUncertainRunFixture(prismaClient: any, ownerId: string) {
  const runId = `studio-smoke-uncertain-${smokeId}`;
  const createdAt = new Date(Date.now() - 5_000);
  const draft = await prismaClient.videoStudioDraft.create({
    data: {
      id: `studio-smoke-draft-${smokeId}`,
      owner_user_id: ownerId,
      name: '异常列表浏览器 fixture',
      group_name: 'browser-fixture',
      prompt: '本地异常状态验证，不提交模型。',
      values_json: '{}',
      assets_json: '[]',
      parameters_json: '{}',
      revision: 1,
      template_source: 'blank',
    },
  });
  const snapshot = {
    input: { name: draft.name, groupName: draft.group_name, values: {}, draftPrompt: draft.prompt },
    templateVersion: null,
    recipe: null,
    prompt: draft.prompt,
    parameters: {},
    assets: [],
    owner: { userId: ownerId, username: 'browser-fixture', displayName: '浏览器测试用户', accountType: 'internal' },
  };
  await prismaClient.videoStudioRun.create({
    data: {
      id: runId,
      owner_user_id: ownerId,
      draft_id: draft.id,
      draft_revision: draft.revision,
      request_id: `studio-smoke-request-${smokeId}`,
      request_fingerprint: `fixture-${smokeId}`,
      source: 'blank',
      mode: 'llm',
      status: 'uncertain',
      delivery_state: 'unknown',
      prompt: null,
      snapshot_json: JSON.stringify(snapshot),
      model: null,
      usage_json: null,
      error_message: '离线浏览器 fixture，不执行任何模型请求。',
      attempt: 1,
      created_at: createdAt,
      updated_at: createdAt,
    },
  });
  const task = await prismaClient.videoTask.create({
    data: {
      provider: 'seedance',
      model: 'seedance-2.5',
      generation_mode: 'text_to_video',
      prompt: '离线浏览器关联任务 fixture。',
      source_type: 'web',
      local_status: 'failed',
      delivery_status: 'unknown',
      user_id: ownerId,
      owner_user_id: ownerId,
      template_studio_run_id: runId,
      created_at: createdAt,
      updated_at: createdAt,
    },
  });
  return { runId, taskId: task.id as string };
}

async function waitForSaved(page: any) {
  await page.getByText('自动保存完成', { exact: true }).first().waitFor({ state: 'visible', timeout: browserTimeout });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitWithTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function addFixtureAsset(prismaClient: any, ownerId: string, roleLabel: string) {
  mkdirSync(publicAssetDirectory, { recursive: true });
  const fileName = `template-studio-${smokeId}-${roleLabel}.png`;
  const filePath = path.join(publicAssetDirectory, fileName);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=', 'base64');
  writeFileSync(filePath, png, { flag: 'wx' });
  createdAssetFiles.push(filePath);
  fixtureUploadPreviews.set(`/uploads/assets/${fileName}`, { body: png, contentType: 'image/png' });
  const asset = await prismaClient.asset.create({
    data: {
      owner_id: ownerId,
      type: 'image',
      original_url: `/uploads/assets/${fileName}`,
      thumbnail_url: `/uploads/assets/${fileName}`,
      file_name: fileName,
      mime_type: 'image/png',
      width: 1,
      height: 1,
      file_size: png.byteLength,
      status: 'active',
    },
  });
  return { id: asset.id as string, fileName };
}

async function addFixtureHistoryAsset(prismaClient: any, ownerId: string, type: 'video' | 'audio', previewFileName: string) {
  const extension = type === 'video' ? 'mp4' : 'mp3';
  const fileName = `template-studio-${smokeId}-history-${type}.${extension}`;
  const previewUrl = `/uploads/assets/${previewFileName}`;
  const asset = await prismaClient.asset.create({
    data: {
      owner_id: ownerId,
      type,
      original_url: previewUrl,
      thumbnail_url: previewUrl,
      file_name: fileName,
      mime_type: type === 'video' ? 'video/mp4' : 'audio/mpeg',
      width: null,
      height: null,
      file_size: 1,
      status: 'active',
    },
  });
  return { id: asset.id as string, fileName };
}

async function pickAssetForSlot(page: any, fileName: string, slotIndex: number) {
  await page.getByRole('button', { name: '添加到此槽位' }).nth(slotIndex).click();
  await page.getByRole('heading', { name: '添加参考素材' }).waitFor({ state: 'visible', timeout: browserTimeout });
  const card = page.locator('article.uploaded-picker-card').filter({ hasText: fileName });
  await card.getByRole('button', { name: '选择', exact: true }).click();
  await page.getByRole('button', { name: '加入参考区', exact: true }).click();
  await page.getByRole('heading', { name: '添加参考素材' }).waitFor({ state: 'hidden', timeout: browserTimeout });
}

async function assertVideoOnlyAccess(browserInstance: any, baseUrl: string, account: FixtureAccount) {
  const context = await browserInstance.newContext({ baseURL: baseUrl, viewport: { width: 1280, height: 900 } });
  await installLocalOnlyBrowserRoutes(context);
  const page = await context.newPage();
  trackStudioApiDiagnostics(page, baseUrl);
  failureCapturePage = page;
  await loginThroughUi(page, account, '/template-studio?type=video');
  await page.goto('/template-studio?type=image');
  await page.getByRole('heading', { name: '模板工作台' }).waitFor({ state: 'visible', timeout: browserTimeout });
  assert.equal(await page.getByRole('tab', { name: '图片', exact: true }).count(), 0, 'video-only internal account must not see image access');
  assert.equal(await page.getByRole('tab', { name: '视频', exact: true }).getAttribute('aria-selected'), 'true');
  await context.close();
}

async function assertCompanyAccess(browserInstance: any, baseUrl: string, account: FixtureAccount) {
  const context = await browserInstance.newContext({ baseURL: baseUrl, viewport: { width: 1280, height: 900 } });
  await installLocalOnlyBrowserRoutes(context);
  const page = await context.newPage();
  trackStudioApiDiagnostics(page, baseUrl);
  failureCapturePage = page;
  await loginThroughUi(page, account, '/template-studio?type=image');
  await page.goto('/template-studio?type=image');
  await page.getByRole('heading', { name: '模板工作台' }).waitFor({ state: 'visible', timeout: browserTimeout });
  assert.equal(await page.getByRole('tab', { name: '图片', exact: true }).getAttribute('aria-selected'), 'true');
  assert.equal(await page.getByRole('tab', { name: '视频', exact: true }).count(), 1, 'allowed-tenant company user must retain video access');
  await context.close();
}

async function assertExternalAccessDenied(browserInstance: any, baseUrl: string, account: FixtureAccount) {
  const context = await browserInstance.newContext({ baseURL: baseUrl, viewport: { width: 1280, height: 900 } });
  await installLocalOnlyBrowserRoutes(context);
  const page = await context.newPage();
  trackStudioApiDiagnostics(page, baseUrl);
  failureCapturePage = page;
  await loginThroughUi(page, account, '/template-studio?type=video');
  await page.goto('/template-studio?type=video');
  await page.waitForURL((url: URL) => url.pathname === '/generate/ip', { timeout: browserTimeout });
  assert.equal(await page.getByRole('heading', { name: '模板工作台' }).count(), 0, 'external account must not enter the workbench');
  await context.close();
}

async function assertAdminTemplatePromptAccess(
  browserInstance: any,
  baseUrl: string,
  admin: FixtureAccount,
  ordinaryUser: FixtureAccount,
  fixture: { runId: string; taskId: string },
) {
  const adminContext = await browserInstance.newContext({ baseURL: baseUrl, viewport: { width: 1360, height: 900 } });
  await installLocalOnlyBrowserRoutes(adminContext);
  const adminPage = await adminContext.newPage();
  trackStudioApiDiagnostics(adminPage, baseUrl);
  failureCapturePage = adminPage;
  const requestedStatuses = new Set<string>();
  adminPage.on('request', (request: any) => {
    try {
      const url = new URL(request.url());
      if (url.origin === baseUrl && url.pathname === '/api/admin/template-studio/runs' && request.method() === 'GET') {
        const status = url.searchParams.get('status');
        if (status) requestedStatuses.add(status);
      }
    } catch { /* Keep fixture diagnostics best-effort. */ }
  });

  await loginThroughUi(adminPage, admin, '/admin/agent-runs');
  await adminPage.goto('/admin/agent-runs');
  await adminPage.getByRole('heading', { name: '执行链路' }).waitFor({ state: 'visible', timeout: browserTimeout });
  await adminPage.getByRole('link', { name: '模板提示词异常' }).click();
  await adminPage.waitForURL((url: URL) => url.pathname === '/admin/agent-runs/template-prompts', { timeout: browserTimeout });
  await adminPage.getByRole('heading', { name: '提示词异常' }).waitFor({ state: 'visible', timeout: browserTimeout });
  assert.equal(await adminPage.locator('select').inputValue(), 'exceptions', 'admin list defaults to the exception filter');
  const uncertainRow = adminPage.locator(`[data-run-id="${fixture.runId}"]`);
  await uncertainRow.waitFor({ state: 'visible', timeout: browserTimeout });
  await uncertainRow.getByText('结果待核对', { exact: true }).waitFor({ state: 'visible', timeout: browserTimeout });
  await uncertainRow.getByText('Template Studio user', { exact: true }).waitFor({ state: 'visible', timeout: browserTimeout });
  await uncertainRow.getByText('暂无截图', { exact: true }).waitFor({ state: 'visible', timeout: browserTimeout });
  assert.ok(requestedStatuses.has('uncertain') && requestedStatuses.has('failed'), 'the default exception view uses the API-supported per-status filter twice');
  assert.equal(requestedStatuses.has('exceptions'), false, 'the UI must not send an unsupported combined status value');
  await uncertainRow.getByRole('link', { name: /查看详情/ }).click();
  await adminPage.waitForURL((url: URL) => url.pathname === `/admin/agent-runs/template-prompts/${fixture.runId}`, { timeout: browserTimeout });
  await adminPage.getByText('本站结果待人工核对', { exact: true }).waitFor({ state: 'visible', timeout: browserTimeout });
  await adminPage.getByText('请人工核对本站与服务商记录；此页面没有上游查询能力，也不会自动重试。', { exact: true }).waitFor({ state: 'visible', timeout: browserTimeout });
  const taskRow = adminPage.locator(`[data-admin-task-id="${fixture.taskId}"]`);
  await taskRow.waitFor({ state: 'visible', timeout: browserTimeout });
  await taskRow.getByText('暂无截图', { exact: true }).waitFor({ state: 'visible', timeout: browserTimeout });
  assert.equal(await adminPage.getByRole('button', { name: /重试|退款|上游查询/ }).count(), 0, 'the detail page exposes no upstream, retry, or refund mutation');
  await adminContext.close();

  const userContext = await browserInstance.newContext({ baseURL: baseUrl, viewport: { width: 1280, height: 900 } });
  await installLocalOnlyBrowserRoutes(userContext);
  const userPage = await userContext.newPage();
  trackStudioApiDiagnostics(userPage, baseUrl);
  failureCapturePage = userPage;
  await loginThroughUi(userPage, ordinaryUser, '/template-studio?type=video');
  await userPage.goto('/admin/agent-runs/template-prompts');
  await userPage.waitForURL((url: URL) => url.pathname === '/generate', { timeout: browserTimeout });
  const listApi = await browserJson(userPage, '/api/admin/template-studio/runs', 'GET');
  assert.equal(listApi.status, 403, 'ordinary accounts are rejected by the admin list API');
  await userPage.goto(`/admin/agent-runs/template-prompts/${fixture.runId}`);
  await userPage.waitForURL((url: URL) => url.pathname === '/generate', { timeout: browserTimeout });
  const detailApi = await browserJson(userPage, `/api/admin/template-studio/runs/${fixture.runId}`, 'GET');
  assert.equal(detailApi.status, 403, 'ordinary accounts are rejected by the admin detail API');
  await userContext.close();
  log('admin-only exception list/detail passed with real local uncertain fixture, linked task, and ordinary-user 403; no model request was made');
}

async function assertIsolatedReleaseNotice(page: any, baseUrl: string) {
  failureCapturePage = page;
  const draftReturnUrl = page.url();
  const savedPrompt = new URL(draftReturnUrl).pathname === '/template-studio'
    ? await page.locator('#studio-prompt').inputValue().catch(() => null)
    : null;
  if (savedPrompt !== null) await waitForSaved(page);
  const syntheticVersion = nextSyntheticReleaseVersion();
  let mockRequestCount = 0;
  await page.route('**/api/release', async (route: any) => {
    const url = new URL(route.request().url());
    if (url.origin !== baseUrl || url.pathname !== '/api/release' || route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    mockRequestCount += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({ version: syntheticVersion, channel: 'production', summary: '隔离浏览器测试版本，不代表线上发布。' }),
    });
  });
  const isReleaseResponse = (response: any) => {
    try {
      const url = new URL(response.url());
      return url.origin === baseUrl && url.pathname === '/api/release' && response.request().method() === 'GET';
    } catch { return false; }
  };
  const firstCheck = page.waitForResponse(isReleaseResponse, { timeout: browserTimeout });
  await page.goto('/account');
  assert.equal((await firstCheck).status(), 200);
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ state: 'visible', timeout: browserTimeout });
  const firstTitle = (await page.locator('#release-title').textContent())?.trim() || '';
  assert.ok(firstTitle.length > 0 && firstTitle.length <= 8, `release notice title must be at most 8 characters: ${firstTitle}`);
  await dialog.getByRole('button', { name: '稍后', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: browserTimeout });

  const dismissedVersion = await page.evaluate(() => localStorage.getItem('sd2:release:later'));
  assert.equal(dismissedVersion, syntheticVersion, 'Later should persist the dismissed target version');
  const focusCheck = page.waitForResponse(isReleaseResponse, { timeout: browserTimeout });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  assert.equal((await focusCheck).status(), 200);
  await page.getByRole('status').filter({ hasText: `可更新至 v${syntheticVersion}` }).waitFor({ state: 'visible', timeout: browserTimeout });
  assert.equal(await page.getByRole('dialog').count(), 0, 'a dismissed release must stay hidden on focus checks');

  const manualCheck = page.waitForResponse(isReleaseResponse, { timeout: browserTimeout });
  await page.getByRole('button', { name: '检查更新', exact: true }).click();
  assert.equal((await manualCheck).status(), 200);
  await dialog.waitFor({ state: 'visible', timeout: browserTimeout });
  const manualTitle = (await page.locator('#release-title').textContent())?.trim() || '';
  assert.ok(manualTitle.length > 0 && manualTitle.length <= 8, `manual release notice title must be at most 8 characters: ${manualTitle}`);
  assert.equal(await dialog.getByRole('button', { name: '立即刷新', exact: true }).count(), 1);
  await dialog.getByRole('button', { name: '稍后', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: browserTimeout });
  assert.ok(mockRequestCount >= 3, 'automatic, focus, and manual checks should use the isolated release response');
  await page.unroute('**/api/release');
  if (savedPrompt !== null) {
    await page.goto(draftReturnUrl);
    await page.locator('#studio-prompt').waitFor({ state: 'visible', timeout: browserTimeout });
    assert.equal(await page.locator('#studio-prompt').inputValue(), savedPrompt, 'saved draft should remain recoverable after visiting the release notice');
  }
  log(`existing release notice passed isolated higher-version, Later dedupe, and /account manual reopen checks (${syntheticVersion}; mock only, no refresh or release claim)`);
  if (savedPrompt !== null) log('saved draft content remained recoverable after the offline release-notice check; refresh button was not clicked');
}

async function runBrowserSmoke() {
  const playwrightModule = process.env.PLAYWRIGHT_MODULE || 'playwright';
  let chromium: any;
  try {
    chromium = localRequire(playwrightModule).chromium;
  } catch (error) {
    throw new Error(`Playwright could not be loaded from PLAYWRIGHT_MODULE=${playwrightModule}; no dependency was installed. ${error instanceof Error ? error.message : ''}`);
  }
  if (!chromium?.launch) throw new Error('PLAYWRIGHT_MODULE did not export chromium');

  const builtDist = verifyLocalBuild();
  pushIsolatedDatabase();
  const [{ PrismaClient }, { hashPassword }] = await Promise.all([
    import('@prisma/client'),
    import('../src/lib/auth/password'),
  ]);
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

  const admin = await createAccount(prisma, hashPassword, 'admin', 'internal');
  const companyUser = await createAccount(prisma, hashPassword, 'user', 'internal', tenantAllowlist);
  const videoOnly = await createAccount(prisma, hashPassword, 'user', 'internal', `non-image-${smokeId}`);
  const external = await createAccount(prisma, hashPassword, 'user', 'external');
  const firstAsset = await addFixtureAsset(prisma, admin.user.id, 'first');
  const lastAsset = await addFixtureAsset(prisma, admin.user.id, 'last');
  const videoHistoryAsset = await addFixtureHistoryAsset(prisma, admin.user.id, 'video', firstAsset.fileName);
  const audioHistoryAsset = await addFixtureHistoryAsset(prisma, admin.user.id, 'audio', firstAsset.fileName);
  const uncertainRunFixture = await addUncertainRunFixture(prisma, companyUser.user.id);

  const port = await reserveLocalPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const guardPath = path.join(databaseRoot, 'network-guard.cjs');
  writeFileSync(guardPath, makeNetworkGuardSource(), { flag: 'wx' });
  server = startNext(port, guardPath);
  await waitForServer(server, baseUrl);
  log(`next start ready on 127.0.0.1:${port}; build=${builtDist}; database is isolated under /tmp`);

  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ baseURL: baseUrl, viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  await installLocalOnlyBrowserRoutes(context);
  const page = await context.newPage();
  trackStudioApiDiagnostics(page, baseUrl);
  failureCapturePage = page;
  await loginThroughUi(page, admin.account, '/template-studio?type=video');
  await page.goto('/template-studio?type=video');
  await page.getByRole('heading', { name: '模板工作台' }).waitFor({ state: 'visible', timeout: browserTimeout });
  await assertAdminTemplatePromptAccess(browser, baseUrl, admin.account, companyUser.account, uncertainRunFixture);
  failureCapturePage = page;

  const capabilities = await browserJson(page, '/api/template-studio/capabilities', 'GET');
  assert.equal(capabilities.status, 200);
  assert.equal((capabilities.payload as any)?.llmEnabled, false, 'AI整理 must remain disabled in the isolated fixture DB');

  await page.getByRole('tab', { name: '图片', exact: true }).click();
  await page.waitForURL((url: URL) => url.searchParams.get('type') === 'image', { timeout: browserTimeout });
  assert.equal(await page.getByRole('tab', { name: '图片', exact: true }).getAttribute('aria-selected'), 'true');
  await page.getByRole('tab', { name: '视频', exact: true }).click();
  await page.waitForURL((url: URL) => url.searchParams.get('type') === 'video', { timeout: browserTimeout });
  assert.equal(await page.getByRole('tab', { name: '视频', exact: true }).getAttribute('aria-selected'), 'true');
  await page.getByRole('tab', { name: '我的提示词', exact: true }).click();
  await page.waitForURL((url: URL) => url.searchParams.get('view') === 'prompts', { timeout: browserTimeout });
  await page.getByRole('tab', { name: '视频结果', exact: true }).click();
  await page.waitForURL((url: URL) => url.searchParams.get('view') === 'results', { timeout: browserTimeout });
  await page.getByRole('tab', { name: '模板', exact: true }).click();
  await page.waitForURL((url: URL) => url.searchParams.get('view') === 'templates', { timeout: browserTimeout });
  log('admin image/video category and video-view switching passed');

  const draftDetailPattern = '**/api/template-studio/drafts/*';
  const detailResponseReady = deferred<void>();
  const releaseDetailResponse = deferred<void>();
  const delayNewDraftDetail = async (route: any) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() !== 'GET' || !/^\/api\/template-studio\/drafts\/[^/]+$/.test(pathname)) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    if (response.status() !== 200) throw new Error(`Real draft detail GET returned ${response.status()}`);
    detailResponseReady.resolve();
    await releaseDetailResponse.promise;
    await route.fulfill({ response });
  };
  await page.route(draftDetailPattern, delayNewDraftDetail);
  try {
    await page.getByRole('button', { name: '新建空白模块' }).first().click();
    await page.locator('#studio-prompt').waitFor({ state: 'visible', timeout: browserTimeout });
    await waitWithTimeout(detailResponseReady.promise, browserTimeout, 'Timed out waiting for the real draft detail GET to be held');
    const persistedDraftId = new URL(page.url()).searchParams.get('draftId');
    assert.ok(persistedDraftId, 'blank draft should have a stable URL id');
    await page.getByRole('button', { name: 'AI整理' }).waitFor({ state: 'visible', timeout: browserTimeout });
    assert.equal(await page.getByRole('button', { name: 'AI整理' }).isDisabled(), true);
    log('disabled AI state verified inside the active module editor');

    const immediatePrompt = 'GET尚未返回时立即输入的空白草稿内容';
    const detailResponsePromise: Promise<PlaywrightResponseLike> = page.waitForResponse((response: PlaywrightResponseLike) => {
      const url = new URL(response.url());
      return response.request().method() === 'GET' && url.pathname === `/api/template-studio/drafts/${persistedDraftId}`;
    }, { timeout: browserTimeout });
    const saveResponsePromise: Promise<PlaywrightResponseLike> = page.waitForResponse((response: PlaywrightResponseLike) => {
      const request = response.request();
      if (request.method() !== 'PUT' || new URL(response.url()).pathname !== `/api/template-studio/drafts/${persistedDraftId}`) return false;
      try {
        const body = request.postDataJSON();
        return isRecord(body) && body.prompt === immediatePrompt;
      } catch { return false; }
    }, { timeout: browserTimeout });
    await page.locator('#studio-prompt').fill(immediatePrompt);
    releaseDetailResponse.resolve();
    const detailResponse = await waitWithTimeout<PlaywrightResponseLike>(detailResponsePromise, browserTimeout, 'Timed out waiting for the held real draft detail GET');
    assert.equal(detailResponse.status(), 200);
    const saveResponse = await waitWithTimeout<PlaywrightResponseLike>(saveResponsePromise, browserTimeout, 'Immediate draft text was not sent in the real autosave PUT');
    assert.equal(saveResponse.status(), 200, 'immediate text must autosave after the late detail response');
    await page.unroute(draftDetailPattern, delayNewDraftDetail);
    assert.equal(await page.locator('#studio-prompt').inputValue(), immediatePrompt, 'late same-draft GET must not replace text typed while it was pending');
    await waitForSaved(page);
  } finally {
    releaseDetailResponse.resolve();
    await page.unroute(draftDetailPattern, delayNewDraftDetail);
  }
  const persistedDraftId = new URL(page.url()).searchParams.get('draftId');
  assert.ok(persistedDraftId, 'blank draft should have a stable URL id');
  log('immediate typing survives a held real draft detail response and autosaves');
  await page.screenshot({ path: path.join(artifactRoot, 'template-studio-desktop.png'), fullPage: true });
  await page.reload();
  await page.locator('#studio-prompt').waitFor({ state: 'visible', timeout: browserTimeout });
  assert.equal(await page.locator('#studio-prompt').inputValue(), 'GET尚未返回时立即输入的空白草稿内容');
  log('blank draft autosave and browser refresh recovery passed');

  await page.getByRole('button', { name: '添加素材', exact: true }).click();
  await page.getByRole('heading', { name: '添加参考素材' }).waitFor({ state: 'visible', timeout: browserTimeout });
  const imageHistoryCard = page.locator('article.uploaded-picker-card').filter({ hasText: firstAsset.fileName });
  const videoHistoryCard = page.locator('article.uploaded-picker-card').filter({ hasText: videoHistoryAsset.fileName });
  const audioHistoryCard = page.locator('article.uploaded-picker-card').filter({ hasText: audioHistoryAsset.fileName });
  await imageHistoryCard.waitFor({ state: 'visible', timeout: browserTimeout });
  await videoHistoryCard.waitFor({ state: 'visible', timeout: browserTimeout });
  await audioHistoryCard.waitFor({ state: 'visible', timeout: browserTimeout });
  assert.equal(await imageHistoryCard.locator('.uploaded-picker-delete').count(), 1, 'image history keeps its supported delete action');
  assert.equal(await videoHistoryCard.locator('.uploaded-picker-delete').count(), 0, 'video history must not offer the image-only delete route');
  assert.equal(await audioHistoryCard.locator('.uploaded-picker-delete').count(), 0, 'audio history must not offer the image-only delete route');
  assert.equal((await browserJson(page, `/api/assets/history/${videoHistoryAsset.id}`, 'DELETE')).status, 404, 'the existing API remains image-only');
  assert.equal((await browserJson(page, `/api/assets/history/${audioHistoryAsset.id}`, 'DELETE')).status, 404, 'audio deletion is not enabled by this UI fix');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('heading', { name: '添加参考素材' }).waitFor({ state: 'hidden', timeout: browserTimeout });
  log('history delete action is limited to images; the existing API still rejects video/audio deletion');

  const templateName = `Browser smoke ${smokeId.slice(0, 8)}`;
  const recipe = {
    instruction: '固定镜头基调：纪实、自然光。',
    fields: [
      { key: 'style', label: '画面风格', type: 'select', required: true, options: ['纪实', '动画'], defaultValue: '纪实' },
      { key: 'subject', label: '主要对象', type: 'text', required: true, maxLength: 80 },
      { key: 'continuity', label: '延续首尾画面', type: 'toggle', defaultValue: true },
    ],
    assetSlots: [
      { key: 'opening-frame', label: '首帧参考', role: 'first', types: ['image'], required: true, maxItems: 1 },
      { key: 'closing-frame', label: '尾帧参考', role: 'last', types: ['image'], required: true, maxItems: 1 },
    ],
    defaultParameters: {
      provider: 'seedance', model: 'seedance-2.5', generationMode: 'first_last_frame',
      ratio: '16:9', duration: 5, resolution: '480p', seed: -1, draft: true,
    },
  };
  const templateResponse = await browserJson(page, '/api/template-studio/templates', 'POST', {
    name: templateName,
    description: '本地浏览器 smoke fixture',
    groupName: 'smoke',
    recipe,
  });
  assert.equal(templateResponse.status, 201, `personal template API returned ${templateResponse.status}`);
  const template = (templateResponse.payload as any)?.template;
  assert.ok(template?.id && template.visibility === 'private' && template.canManage);
  await page.reload();
  const templateCard = page.getByRole('button', { name: new RegExp(templateName) });
  await templateCard.waitFor({ state: 'visible', timeout: browserTimeout });
  const previousDraftId = new URL(page.url()).searchParams.get('draftId');
  assert.ok(previousDraftId, 'template selection regression requires an already-open blank draft');
  await templateCard.click();
  await page.waitForURL((url: URL) => url.pathname === '/template-studio'
    && url.searchParams.get('templateId') === template.id
    && url.searchParams.get('templateSource') === 'studio'
    && !url.searchParams.has('draftId')
    && !url.searchParams.has('moduleId')
    && !url.searchParams.has('runId'), { timeout: browserTimeout });
  const selectedTemplateRoute = new URL(page.url());
  assert.equal(selectedTemplateRoute.searchParams.get('templateId'), template.id);
  assert.equal(selectedTemplateRoute.searchParams.get('templateSource'), 'studio');
  assert.equal(selectedTemplateRoute.searchParams.get('draftId'), null, 'selecting a template must not retain the previous draft');
  assert.equal(selectedTemplateRoute.searchParams.get('moduleId'), null, 'selecting a template must not fall back to the previous module');
  assert.equal(selectedTemplateRoute.searchParams.get('runId'), null, 'selecting a template must not retain a previous run');
  await page.getByRole('button', { name: '用此模板新建模块' }).waitFor({ state: 'visible', timeout: browserTimeout });
  await page.getByRole('button', { name: '用此模板新建模块' }).click();
  await page.locator('#studio-value-style').waitFor({ state: 'visible', timeout: browserTimeout });
  await page.waitForURL((url: URL) => url.pathname === '/template-studio'
    && url.searchParams.get('view') === 'templates'
    && Boolean(url.searchParams.get('draftId'))
    && url.searchParams.get('moduleId') === url.searchParams.get('draftId')
    && !url.searchParams.has('templateId')
    && !url.searchParams.has('templateSource')
    && !url.searchParams.has('runId'), { timeout: browserTimeout });
  const appliedTemplateRoute = new URL(page.url());
  assert.ok(appliedTemplateRoute.searchParams.get('draftId'));
  assert.equal(appliedTemplateRoute.searchParams.get('moduleId'), appliedTemplateRoute.searchParams.get('draftId'));
  assert.equal(appliedTemplateRoute.searchParams.get('templateId'), null, 'a created draft is the active route, not a hidden template detail');
  assert.equal(appliedTemplateRoute.searchParams.get('templateSource'), null);
  assert.equal(appliedTemplateRoute.searchParams.get('runId'), null);
  await page.locator('#studio-value-style').selectOption('动画');
  assert.equal(await page.locator('#studio-value-continuity').isChecked(), true);
  await waitForSaved(page);
  assert.equal(await page.locator('#studio-value-subject').inputValue(), '');
  assert.equal(await page.getByText('请填写此项', { exact: true }).count(), 1, 'incomplete required field should remain visible');
  assert.equal(await page.getByRole('button', { name: '直接套用' }).isDisabled(), true, 'incomplete required field must block runs');
  await page.reload();
  await page.locator('#studio-value-style').waitFor({ state: 'visible', timeout: browserTimeout });
  assert.equal(await page.locator('#studio-value-style').inputValue(), '动画', 'partial field values must survive refresh');
  assert.equal(await page.locator('#studio-value-subject').inputValue(), '', 'unfinished required field should remain unfinished after refresh');
  assert.equal(await page.getByRole('button', { name: '直接套用' }).isDisabled(), true, 'refresh must not enable an incomplete template run');
  await page.locator('#studio-value-subject').fill('窗边人物');
  await waitForSaved(page);
  assert.equal(await page.getByRole('button', { name: '直接套用' }).isDisabled(), true, 'required first/last assets still block runs');
  const resultTabs = page.locator('[role="tablist"][aria-label="提示词和视频结果"] [role="tab"]');
  assert.equal(await resultTabs.first().getAttribute('aria-selected'), 'true');
  assert.equal(await resultTabs.first().getAttribute('aria-pressed'), null, 'tabs use aria-selected rather than toggle semantics');
  await pickAssetForSlot(page, firstAsset.fileName, 0);
  await pickAssetForSlot(page, lastAsset.fileName, 1);
  assert.equal(await page.locator('#studio-asset-slot-0').inputValue(), 'opening-frame');
  assert.equal(await page.locator('#studio-asset-slot-1').inputValue(), 'closing-frame');
  assert.equal(await page.locator('#studio-prompt').inputValue(), '', 'template requirements should not require duplicate handwritten text');
  assert.equal(await page.getByRole('button', { name: '直接套用' }).isDisabled(), false, 'template instruction plus complete fields and assets form an effective prompt');
  await page.locator('#studio-prompt').fill('原始草稿提示词：人物从画面左侧走向窗边。');
  await waitForSaved(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(artifactRoot, 'template-studio-mobile.png'), fullPage: true });
  const mobileWidths = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }));
  assert.ok(mobileWidths.document <= mobileWidths.viewport + 1, `mobile layout overflows: ${JSON.stringify(mobileWidths)}`);
  await page.setViewportSize({ width: 1440, height: 1000 });
  log('private template finite fields, required first/last slots, and authorized asset selection passed');

  const originalDraftId = new URL(page.url()).searchParams.get('draftId');
  assert.ok(originalDraftId);
  const originalPrompt = '原始草稿提示词：人物从画面左侧走向窗边。';
  await waitForSaved(page);
  const runResponsePromise = page.waitForResponse((response: any) => response.url().endsWith('/api/template-studio/runs') && response.request().method() === 'POST', { timeout: browserTimeout });
  await page.getByRole('button', { name: '直接套用' }).click();
  const runResponse = await runResponsePromise;
  assert.equal(runResponse.status(), 200, 'direct run must use the real local API');
  const runPayload = await runResponse.json();
  const runId = runPayload?.run?.id as string | undefined;
  assert.ok(runId, 'direct run API should return a run id');
  await page.waitForURL((url: URL) => url.pathname === '/template-studio'
    && url.searchParams.get('view') === 'prompts'
    && url.searchParams.get('runId') === runId
    && url.searchParams.get('draftId') === originalDraftId
    && url.searchParams.get('moduleId') === originalDraftId
    && !url.searchParams.has('templateId')
    && !url.searchParams.has('templateSource'), { timeout: browserTimeout });
  const directRunRoute = new URL(page.url());
  assert.equal(directRunRoute.searchParams.get('view'), 'prompts');
  assert.equal(directRunRoute.searchParams.get('runId'), runId);
  assert.equal(directRunRoute.searchParams.get('draftId'), originalDraftId);
  assert.equal(directRunRoute.searchParams.get('moduleId'), originalDraftId);
  assert.equal(directRunRoute.searchParams.get('templateId'), null);
  assert.equal(directRunRoute.searchParams.get('templateSource'), null);
  await page.getByRole('heading', { name: '直接使用记录' }).waitFor({ state: 'visible', timeout: browserTimeout });
  const runDetailResponse = await browserJson(page, `/api/template-studio/runs/${encodeURIComponent(runId)}`, 'GET');
  assert.equal(runDetailResponse.status, 200);
  const runDetail = runDetailResponse.payload as any;
  assert.equal(runDetail.snapshot.input.draftPrompt, originalPrompt);
  assert.equal(runDetail.snapshot.input.values.style, '动画');
  assert.equal(runDetail.snapshot.input.values.subject, '窗边人物');
  assert.match(runDetail.snapshot.prompt, /固定镜头基调/);
  assert.match(runDetail.snapshot.prompt, /画面风格: 动画/);
  assert.deepEqual(runDetail.snapshot.assets.map((asset: any) => asset.slotKey), ['opening-frame', 'closing-frame']);
  assert.equal(runDetail.run.status, 'succeeded');
  const templateFilterValues = await page.locator('#studio-run-template option').evaluateAll((options: HTMLOptionElement[]) => options.map((option) => option.value));
  assert.ok(templateFilterValues.includes(`studio:${template.id}`), 'template filters must retain source in their option value');
  const filteredResponsePromise = page.waitForResponse((response: any) => {
    if (!response.url().startsWith(`${baseUrl}/api/template-studio/runs?`) || response.request().method() !== 'GET') return false;
    return new URL(response.url()).searchParams.get('template_id') === `studio:${template.id}`;
  }, { timeout: browserTimeout });
  await page.locator('#studio-run-template').selectOption(`studio:${template.id}`);
  await page.getByRole('button', { name: '应用筛选', exact: true }).click();
  const filteredResponse = await filteredResponsePromise;
  assert.equal(filteredResponse.status(), 200);
  const filteredRuns = await filteredResponse.json();
  assert.ok(filteredRuns.items.some((item: any) => item.id === runId));
  await page.getByRole('button', { name: '复用输入' }).click();
  await page.locator('#studio-prompt').waitFor({ state: 'visible', timeout: browserTimeout });
  await page.waitForURL((url: URL) => url.pathname === '/template-studio'
    && url.searchParams.get('view') === 'templates'
    && Boolean(url.searchParams.get('draftId'))
    && url.searchParams.get('draftId') !== originalDraftId
    && url.searchParams.get('moduleId') === url.searchParams.get('draftId')
    && !url.searchParams.has('runId')
    && !url.searchParams.has('templateId')
    && !url.searchParams.has('templateSource'), { timeout: browserTimeout });
  const reusedInputRoute = new URL(page.url());
  assert.notEqual(reusedInputRoute.searchParams.get('draftId'), originalDraftId);
  assert.equal(reusedInputRoute.searchParams.get('moduleId'), reusedInputRoute.searchParams.get('draftId'));
  assert.equal(reusedInputRoute.searchParams.get('runId'), null, 'reuse creates a new draft rather than leaving the source run selected');
  assert.equal(reusedInputRoute.searchParams.get('templateId'), null);
  assert.equal(reusedInputRoute.searchParams.get('templateSource'), null);
  assert.equal(await page.locator('#studio-prompt').inputValue(), originalPrompt, 'reuse must copy draftPrompt, not the assembled run prompt');
  assert.equal(await page.locator('#studio-value-style').inputValue(), '动画');
  assert.equal(await page.locator('#studio-asset-slot-0').inputValue(), 'opening-frame');
  assert.equal(await page.locator('#studio-asset-slot-1').inputValue(), 'closing-frame');
  const copiedDraftId = new URL(page.url()).searchParams.get('draftId');
  const copiedRuns = await browserJson(page, `/api/template-studio/runs?draft_id=${encodeURIComponent(copiedDraftId || '')}`, 'GET');
  assert.equal(copiedRuns.status, 200);
  assert.equal((copiedRuns.payload as any)?.items?.length, 0, 'reused input must not merge or rewrite prompt history');
  log('direct run, immutable history snapshot, and reuse-input revision passed');

  const historyUrl = `/template-studio?type=video&view=prompts&runId=${encodeURIComponent(runId)}&draftId=${encodeURIComponent(originalDraftId)}&moduleId=${encodeURIComponent(originalDraftId)}`;
  await page.goto(historyUrl);
  await page.getByRole('button', { name: '继续生成', exact: true }).waitFor({ state: 'visible', timeout: browserTimeout });
  await page.getByRole('button', { name: '继续生成', exact: true }).click();
  await page.waitForURL((url: URL) => url.pathname === '/generate' && url.searchParams.get('template_studio_run_id') === runId, { timeout: browserTimeout });
  await page.getByRole('link', { name: '返回模板工作台' }).waitFor({ state: 'visible', timeout: browserTimeout });
  await page.getByText('模板运行记录已接入普通视频生成', { exact: false }).waitFor({ state: 'visible', timeout: browserTimeout });
  await page.getByRole('link', { name: '返回模板工作台' }).click();
  await page.waitForURL((url: URL) => url.pathname === '/template-studio'
    && url.searchParams.get('view') === 'prompts'
    && url.searchParams.get('runId') === runId
    && url.searchParams.get('draftId') === originalDraftId
    && url.searchParams.get('moduleId') === originalDraftId
    && !url.searchParams.has('templateId')
    && !url.searchParams.has('templateSource'), { timeout: browserTimeout });
  const returnedRunRoute = new URL(page.url());
  assert.equal(returnedRunRoute.searchParams.get('view'), 'prompts');
  assert.equal(returnedRunRoute.searchParams.get('draftId'), originalDraftId);
  assert.equal(returnedRunRoute.searchParams.get('moduleId'), originalDraftId);
  assert.equal(returnedRunRoute.searchParams.get('templateId'), null);
  assert.equal(returnedRunRoute.searchParams.get('templateSource'), null);
  log('continue-generation uses /generate handoff and returns to the originating run/module context');

  await page.goto('/template-studio?type=video');
  await page.getByRole('button', { name: '新建空白模块' }).first().click();
  await page.locator('#studio-prompt').waitFor({ state: 'visible', timeout: browserTimeout });
  await page.locator('#studio-prompt').fill('延迟响应开始前的文本');
  await waitForSaved(page);
  const heldResponse = deferred<void>();
  const responseArrived = deferred<void>();
  await page.route('**/api/template-studio/runs', async (route: any) => {
    const request = route.request();
    let body: any = null;
    try { body = JSON.parse(request.postData() || '{}'); } catch { /* Let the real API validate malformed requests. */ }
    if (request.method() !== 'POST' || body?.mode !== 'direct') {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    if (!response.ok()) throw new Error(`Real delayed direct run returned ${response.status()}`);
    responseArrived.resolve();
    await heldResponse.promise;
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: '直接套用' }).click();
  await waitWithTimeout(responseArrived.promise, browserTimeout, 'Timed out waiting for the real direct-run response');
  await page.locator('#studio-prompt').fill('真实响应晚到时应保留的新编辑');
  await waitForSaved(page);
  heldResponse.resolve();
  await page.getByText('请求已记录；你当前的模块和新编辑保持不变。', { exact: true }).waitFor({ state: 'visible', timeout: browserTimeout });
  assert.equal(await page.locator('#studio-prompt').inputValue(), '真实响应晚到时应保留的新编辑');
  await page.unroute('**/api/template-studio/runs');
  log('late real run response does not overwrite a newer manual edit');

  await page.goto(`/template-studio?type=video&view=templates&templateId=${encodeURIComponent(template.id)}&templateSource=studio`);
  await page.getByRole('button', { name: '用此模板新建模块' }).waitFor({ state: 'visible', timeout: browserTimeout });
  await page.getByRole('button', { name: '用此模板新建模块' }).click();
  await page.locator('#studio-value-style').waitFor({ state: 'visible', timeout: browserTimeout });
  await page.waitForURL((url: URL) => url.pathname === '/template-studio'
    && url.searchParams.get('view') === 'templates'
    && Boolean(url.searchParams.get('draftId'))
    && url.searchParams.get('moduleId') === url.searchParams.get('draftId')
    && !url.searchParams.has('templateId')
    && !url.searchParams.has('templateSource'), { timeout: browserTimeout });
  await page.locator('#studio-value-style').selectOption('动画');
  await page.locator('#studio-value-subject').fill('冲突恢复保留的主要对象');
  await pickAssetForSlot(page, firstAsset.fileName, 0);
  await pickAssetForSlot(page, lastAsset.fileName, 1);
  await page.locator('#studio-prompt').fill('先保存的服务器版本');
  await waitForSaved(page);
  const conflictUrl = page.url();
  const conflictDraftId = new URL(page.url()).searchParams.get('draftId');
  assert.ok(conflictDraftId);

  const conflictContext = await browser.newContext({ baseURL: baseUrl, viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  await installLocalOnlyBrowserRoutes(conflictContext);
  const conflictPage = await conflictContext.newPage();
  trackStudioApiDiagnostics(conflictPage, baseUrl);
  failureCapturePage = conflictPage;
  await loginThroughUi(conflictPage, admin.account, conflictUrl);
  await conflictPage.goto(conflictUrl);
  await conflictPage.locator('#studio-prompt').waitFor({ state: 'visible', timeout: browserTimeout });
  assert.equal(await conflictPage.locator('#studio-prompt').inputValue(), '先保存的服务器版本');
  await page.locator('#studio-prompt').fill('后保存的服务器版本');
  await waitForSaved(page);
  await conflictPage.locator('#studio-prompt').fill('冲突后保留的本机版本');
  await conflictPage.getByText('草稿版本冲突。', { exact: false }).waitFor({ state: 'visible', timeout: browserTimeout });
  const recoveryResponsePromise = conflictPage.waitForResponse((response: any) => {
    const url = new URL(response.url());
    return url.origin === baseUrl && url.pathname === '/api/template-studio/drafts' && response.request().method() === 'POST';
  }, { timeout: browserTimeout });
  await conflictPage.getByRole('button', { name: '本机内容另存为新模块' }).click();
  const recoveryResponse = await recoveryResponsePromise;
  assert.equal(recoveryResponse.status(), 201, 'recovery must create a complete draft in one request');
  const recoveryRequest: unknown = recoveryResponse.request().postDataJSON();
  assert.ok(isRecord(recoveryRequest));
  assert.ok(isRecord(recoveryRequest.recovery));
  const recoveryInput = recoveryRequest.recovery;
  assert.equal(recoveryRequest.fromDraftId, conflictDraftId);
  assert.equal(recoveryRequest.templateId, undefined);
  assert.equal(recoveryRequest.fromRunId, undefined);
  assert.equal(recoveryInput.prompt, '冲突后保留的本机版本');
  assert.deepEqual(recoveryInput.values, {
    style: '动画',
    subject: '冲突恢复保留的主要对象',
    continuity: true,
  });
  assert.deepEqual(recoveryInput.parameters, recipe.defaultParameters);
  const expectedRecoveredAssets = [
    `${firstAsset.id}:first:image:opening-frame`,
    `${lastAsset.id}:last:image:closing-frame`,
  ].sort();
  const requestedAssetsValue = recoveryInput.assets;
  assert.ok(Array.isArray(requestedAssetsValue));
  const requestedAssets = requestedAssetsValue.map((asset: unknown) => {
    assert.ok(isRecord(asset));
    return `${asset.assetId}:${asset.role}:${asset.type}:${asset.slotKey}`;
  }).sort();
  assert.deepEqual(requestedAssets, expectedRecoveredAssets);
  const recoveryBody: unknown = await recoveryResponse.json();
  assert.ok(isRecord(recoveryBody) && isRecord(recoveryBody.draft));
  const recoveredDraft = recoveryBody.draft;
  assert.ok(recoveredDraft?.id && recoveredDraft.id !== conflictDraftId);
  const recoveredRecipeValue = recoveredDraft.recipe;
  const recoveredTemplateValue = recoveredDraft.template;
  assert.ok(isRecord(recoveredRecipeValue) && isRecord(recoveredTemplateValue), 'the recovered DTO must include the original recipe and template reference');
  const recoveredRecipe = recoveredRecipeValue;
  const recoveredTemplate = recoveredTemplateValue;
  assert.equal(recoveredDraft.prompt, '冲突后保留的本机版本');
  assert.deepEqual(recoveredDraft.values, recoveryInput.values);
  assert.deepEqual(recoveredDraft.parameters, recoveryInput.parameters);
  assert.equal(recoveredRecipe.instruction, recipe.instruction);
  assert.deepEqual(recoveredRecipe.fields, recipe.fields);
  assert.deepEqual(recoveredRecipe.assetSlots, recipe.assetSlots);
  assert.equal(recoveredTemplate.templateId, template.id);
  assert.equal(recoveredTemplate.templateSource, 'studio');
  const recoveredAssetsValue = recoveredDraft.assets;
  assert.ok(Array.isArray(recoveredAssetsValue));
  const restoredAssets = recoveredAssetsValue.map((asset: unknown) => {
    assert.ok(isRecord(asset));
    return `${asset.assetId}:${asset.role}:${asset.type}:${asset.slotKey}`;
  }).sort();
  assert.deepEqual(restoredAssets, expectedRecoveredAssets);
  const originalAfterRecovery = await browserJson(conflictPage, `/api/template-studio/drafts/${encodeURIComponent(conflictDraftId)}`, 'GET');
  assert.equal(originalAfterRecovery.status, 200);
  assert.equal((originalAfterRecovery.payload as any)?.draft?.prompt, '后保存的服务器版本', 'recovery must not overwrite the source draft');
  await conflictPage.waitForURL((url: URL) => url.pathname === '/template-studio'
    && url.searchParams.get('view') === 'templates'
    && Boolean(url.searchParams.get('draftId'))
    && url.searchParams.get('draftId') !== conflictDraftId
    && url.searchParams.get('moduleId') === url.searchParams.get('draftId')
    && !url.searchParams.has('runId')
    && !url.searchParams.has('templateId')
    && !url.searchParams.has('templateSource'), { timeout: browserTimeout });
  await conflictPage.locator('#studio-prompt').waitFor({ state: 'visible', timeout: browserTimeout });
  const recoveredConflictRoute = new URL(conflictPage.url());
  assert.equal(recoveredConflictRoute.searchParams.get('moduleId'), recoveredConflictRoute.searchParams.get('draftId'));
  assert.equal(recoveredConflictRoute.searchParams.get('runId'), null);
  assert.equal(recoveredConflictRoute.searchParams.get('templateId'), null);
  assert.equal(recoveredConflictRoute.searchParams.get('templateSource'), null);
  assert.equal(await conflictPage.locator('#studio-prompt').inputValue(), '冲突后保留的本机版本');
  assert.equal(await conflictPage.locator('#studio-value-style').inputValue(), '动画');
  assert.equal(await conflictPage.locator('#studio-value-subject').inputValue(), '冲突恢复保留的主要对象');
  assert.equal(await conflictPage.locator('#studio-value-continuity').isChecked(), true);
  assert.equal(await conflictPage.locator('#studio-asset-slot-0').inputValue(), 'opening-frame');
  assert.equal(await conflictPage.locator('#studio-asset-slot-1').inputValue(), 'closing-frame');
  assert.equal(await conflictPage.getByRole('button', { name: '直接套用' }).isDisabled(), false);
  await conflictPage.getByText('本机内容已另存为新模块；原草稿和历史记录未覆盖。', { exact: true }).waitFor({ state: 'visible', timeout: browserTimeout });
  await conflictPage.reload();
  await conflictPage.locator('#studio-prompt').waitFor({ state: 'visible', timeout: browserTimeout });
  assert.equal(await conflictPage.locator('#studio-prompt').inputValue(), '冲突后保留的本机版本');
  assert.equal(await conflictPage.locator('#studio-value-style').inputValue(), '动画');
  assert.equal(await conflictPage.locator('#studio-value-subject').inputValue(), '冲突恢复保留的主要对象');
  assert.equal(await conflictPage.locator('#studio-value-continuity').isChecked(), true);
  assert.equal(await conflictPage.locator('#studio-asset-slot-0').inputValue(), 'opening-frame');
  assert.equal(await conflictPage.locator('#studio-asset-slot-1').inputValue(), 'closing-frame');
  assert.equal(await conflictPage.getByRole('button', { name: '直接套用' }).isDisabled(), false);
  await conflictContext.close();
  failureCapturePage = page;
  log('template draft conflict recovery preserves recipe, values, parameters, and first/last asset slots');

  await assertCompanyAccess(browser, baseUrl, companyUser.account);
  await assertVideoOnlyAccess(browser, baseUrl, videoOnly.account);
  await assertExternalAccessDenied(browser, baseUrl, external.account);
  assert.equal(externalBrowserRequestCount, 0, 'browser attempted a non-local request; all such requests are blocked');
  assert.ok(expectedExternalStaticRequestCount > 0, 'expected upload preview fixtures were not requested');
  assert.ok(!serverOutput.includes('[template-studio-smoke-guard]'), 'server attempted a non-local network request');
  log(`fulfilled expected static upload-preview requests: ${expectedExternalStaticRequestCount}; allowed data/blob requests: ${allowedNonNetworkRequestCount}`);
  log('video-only and external permission boundaries passed; no external browser/provider request was attempted');
  await assertIsolatedReleaseNotice(page, baseUrl);
  log(`desktop screenshot: ${path.join(artifactRoot, 'template-studio-desktop.png')}`);
  log(`mobile screenshot: ${path.join(artifactRoot, 'template-studio-mobile.png')}`);
}

async function main() {
  try {
    await runBrowserSmoke();
  } catch (error) {
    logBlockedExternalRequestSummary();
    if (allowedNonNetworkRequestCount) log(`allowed non-network data/blob requests: ${allowedNonNetworkRequestCount}`);
    const scriptStack = safeScriptStack(error);
    if (scriptStack.length) log(`failure source: ${scriptStack.map(({ line, column }) => `L${line}:C${column}`).join(', ')}`);
    const diagnostics = await captureBrowserFailure(error).catch(() => null);
    if (diagnostics) log(`failure screenshot: ${diagnostics.screenshotPath}; layout report: ${diagnostics.reportPath}`);
    throw error;
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    await stopNext(server);
    if (prisma) await prisma.$disconnect().catch(() => undefined);
    for (const filePath of createdAssetFiles) rmSync(filePath, { force: true });
    if (!assetDirectoryExisted) {
      try { rmSync(publicAssetDirectory); } catch { /* Keep any files created concurrently by another process. */ }
    }
    if (!uploadsDirectoryExisted) {
      try { rmSync(publicUploads); } catch { /* Keep any files created concurrently by another process. */ }
    }
    rmSync(databaseRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
