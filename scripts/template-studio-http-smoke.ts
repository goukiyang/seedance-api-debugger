import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import type { PrismaClient } from '@prisma/client';
import sharp from 'sharp';

const DATABASE_PREFIX = '/tmp/sd2-template-studio-test-';
const PROVIDER_API_KEY = 'template-studio-http-smoke-local-only';
const BROWSER_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128.0.0.0 Safari/537.36';
const MAX_CAPTURED_SERVER_OUTPUT = 160_000;
let capturedServerOutput = '';
let diagnosticSecrets: string[] = [PROVIDER_API_KEY];

function captureNextServerOutput(child: ChildProcess, secrets: string[]) {
  capturedServerOutput = '';
  diagnosticSecrets = secrets;
  const capture = (chunk: Buffer | string) => {
    capturedServerOutput = `${capturedServerOutput}${chunk.toString()}`.slice(-MAX_CAPTURED_SERVER_OUTPUT);
  };
  child.stdout?.setEncoding('utf8').on('data', capture);
  child.stderr?.setEncoding('utf8').on('data', capture);
}

function sanitizeDiagnostic(value: string) {
  let safe = value;
  for (const secret of diagnosticSecrets) {
    if (secret) safe = safe.split(secret).join('[redacted]');
  }
  return safe
    .replace(/\bsession\s*=\s*[^;,\s]+/gi, 'session=[redacted]')
    .replace(/((?:api[_-]?key|authorization|cookie|set-cookie|session[_-]?secret|token|password)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 700);
}

function extractLocalErrorStack() {
  const lines = capturedServerOutput.replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/);
  const blocks: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/\b(?:Error|Exception)(?::|\s*\])/i.test(lines[index])) continue;
    const block = [lines[index].trim()];
    for (let next = index + 1; next < lines.length && block.length < 24; next += 1) {
      if (/^\s+at\s/.test(lines[next]) || /^\s*(?:Caused by|Suppressed):/.test(lines[next])) {
        block.push(lines[next].trim());
      } else if (lines[next].trim()) {
        break;
      }
    }
    blocks.push(block.map(sanitizeDiagnostic).join('\n'));
  }
  return blocks.slice(-3).join('\n');
}

async function safeResponseError(response: Response) {
  const body = await response.text();
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
  } catch {
    // Non-JSON bodies are represented by status only; never print an HTML error page.
  }
  const code = typeof payload.code === 'string' ? sanitizeDiagnostic(payload.code) : '';
  const error = typeof payload.error === 'string'
    ? sanitizeDiagnostic(payload.error)
    : typeof payload.message === 'string'
      ? sanitizeDiagnostic(payload.message)
      : '';
  return `HTTP ${response.status}${code ? ` code=${code}` : ''}${error ? ` error=${error}` : ''}`;
}

function testFeishuIdentity(suffix: string) {
  return {
    feishu_user_id: `feishu-user-${suffix}`,
    feishu_open_id: `feishu-open-${suffix}`,
    feishu_union_id: `feishu-union-${suffix}`,
    feishu_tenant_key: 'template-studio-http-smoke-tenant',
    feishu_employee_no: `employee-${suffix}`,
    feishu_department_ids: '[]',
    last_feishu_sync_at: new Date(),
  };
}

function makeDatabaseFile() {
  const databasePath = `${DATABASE_PREFIX}${randomUUID()}-template-studio-http-smoke.ts.db`;
  const relative = path.relative('/tmp', databasePath);
  assert.equal(path.dirname(databasePath), '/tmp');
  assert.equal(path.basename(databasePath).startsWith('sd2-template-studio-test-'), true);
  assert.equal(relative.startsWith('..') || path.isAbsolute(relative), false);
  const descriptor = openSync(databasePath, 'wx', 0o600);
  closeSync(descriptor);
  const stat = lstatSync(databasePath);
  assert.equal(stat.isFile(), true, 'isolated SQLite database must be a regular file');
  assert.equal(stat.isSymbolicLink(), false, 'isolated SQLite database must not be a symlink');
  return { databasePath, databaseUrl: `file:${databasePath}` };
}

function runChild(command: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd: process.cwd(), env, stdio: 'ignore' });
    child.once('error', () => reject(new Error('Could not start the isolated database initializer')));
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Isolated database initialization failed (exit ${code ?? 'unknown'})`));
    });
  });
}

function listen(server: Server) {
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Could not bind the local HTTP smoke server'));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: Server) {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

function childHasExited(child: ChildProcess) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForChildExit(child: ChildProcess, timeoutMs: number) {
  if (childHasExited(child)) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
    if (childHasExited(child)) onExit();
  });
}

async function stopChild(child: ChildProcess | null) {
  if (!child || childHasExited(child)) return;
  const pid = child.pid;
  if (!pid) return;
  try {
    if (process.platform !== 'win32') process.kill(-pid, 'SIGTERM');
    else child.kill('SIGTERM');
  } catch {
    try { child.kill('SIGTERM'); } catch { /* already exited */ }
  }
  if (await waitForChildExit(child, 5000)) return;
  try {
    if (process.platform !== 'win32') process.kill(-pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch { /* already exited */ }
  }
  if (!await waitForChildExit(child, 2000)) {
    throw new Error('Local Next server process did not stop after SIGKILL');
  }
}

async function waitForServer(url: string, child: ChildProcess) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (childHasExited(child)) throw new Error('Local Next server exited before becoming ready');
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {
      // The local server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Local Next server did not become ready within 60 seconds');
}

function startLocalProviderStub() {
  let createPackets = 0;
  let unexpectedPackets = 0;
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/call') {
      unexpectedPackets += 1;
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{"error":"not found"}');
      return;
    }
    createPackets += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    // jimeng.createVideoTask requires a successful JSON response with a top-level id.
    response.end(JSON.stringify({ id: `local-provider-task-${createPackets}` }));
  });
  return listen(server).then((port) => ({
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    counts: () => ({ createPackets, unexpectedPackets }),
  }));
}

async function login(baseUrl: string, identifier: string, password: string) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': BROWSER_USER_AGENT },
    body: JSON.stringify({ identifier, password }),
  });
  if (response.status !== 200) throw new Error(`Test-user login failed (HTTP ${response.status})`);
  const setCookie = response.headers.get('set-cookie') || '';
  const token = /(?:^|[,;\s])session=([^;,\s]+)/.exec(setCookie)?.[1];
  if (!token) throw new Error('Test-user login did not return a session cookie');
  return `session=${token}`;
}

async function requestJson(baseUrl: string, cookie: string, pathname: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  headers.set('cookie', cookie);
  headers.set('user-agent', BROWSER_USER_AGENT);
  if (init?.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return fetch(`${baseUrl}${pathname}`, { ...init, headers });
}

function makeTaskBody(input: {
  runId: string;
  projectId: string;
  videoCardId: string;
  idempotencyKey: string;
  prompt: string;
  parameters: Record<string, unknown>;
  assets?: Array<{
    assetId: string;
    role: 'reference' | 'first' | 'last';
    type: 'image' | 'video' | 'audio';
    slotKey?: string;
  }>;
}) {
  const { runId, projectId, videoCardId, idempotencyKey, prompt, parameters, assets = [] } = input;
  return {
    prompt,
    provider: 'seedance',
    model: parameters.model,
    generation_mode: parameters.generationMode,
    ratio: parameters.ratio,
    duration: parameters.duration,
    resolution: parameters.resolution,
    seed: parameters.seed,
    generate_audio: parameters.generateAudio,
    return_last_frame: parameters.returnLastFrame,
    watermark: parameters.watermark,
    draft: parameters.draft,
    project_id: projectId,
    video_card_id: videoCardId,
    reference_image_ids: [],
    reference_video_urls: [],
    reference_audio_urls: [],
    template_id: null,
    agent_run_id: null,
    template_studio_run_id: runId,
    template_studio_assets: assets,
    template_studio_parameters: parameters,
    final_prompt_snapshot: prompt,
    prompt_user_edited: true,
    idempotency_key: idempotencyKey,
  };
}

async function createLocalImageFixture(ownedPaths: string[], ownedDirectories: string[]) {
  const fileName = `template-studio-http-smoke-${randomUUID()}.png`;
  const filePath = path.resolve(process.cwd(), 'public', 'uploads', 'assets', fileName);
  const uploadRoot = path.resolve(process.cwd(), 'public', 'uploads');
  const assetRoot = path.dirname(filePath);
  for (const directory of [uploadRoot, assetRoot]) {
    if (!existsSync(directory)) {
      mkdirSync(directory);
      ownedDirectories.push(directory);
    }
  }
  const relativePath = path.relative(uploadRoot, filePath);
  assert.equal(relativePath.startsWith('..') || path.isAbsolute(relativePath), false);
  const { data: bytes, info } = await sharp({
    create: { width: 640, height: 640, channels: 3, background: '#3478f6' },
  }).png().toBuffer({ resolveWithObject: true });
  const descriptor = openSync(filePath, 'wx', 0o600);
  ownedPaths.push(filePath);
  try { writeFileSync(descriptor, bytes); }
  finally { closeSync(descriptor); }
  return {
    fileName,
    filePath,
    originalUrl: `/uploads/assets/${fileName}`,
    byteLength: info.size,
    width: info.width,
    height: info.height,
  };
}

function assertRegularFileBeforeRemoving(filePath: string) {
  try {
    const stat = lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('Refusing to remove a non-regular isolated smoke file');
    }
    unlinkSync(filePath);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
}

async function runSmoke() {
  const projectRoot = process.cwd();
  const distDir = process.env.NEXT_DIST_DIR?.trim() || '.next';
  const buildIdPath = path.resolve(projectRoot, distDir, 'BUILD_ID');
  const prismaCliPath = path.resolve(projectRoot, 'node_modules/prisma/build/index.js');
  const nextCliPath = path.resolve(projectRoot, 'node_modules/next/dist/bin/next');
  assert.equal(existsSync(buildIdPath), true, 'runner must complete the production build before this smoke');
  assert.equal(existsSync(prismaCliPath), true, 'local Prisma CLI is required');
  assert.equal(existsSync(nextCliPath), true, 'local Next.js CLI is required');

  let databasePath: string | null = null;
  let prisma: PrismaClient | null = null;
  let providerServer: Server | null = null;
  let nextServer: ChildProcess | null = null;
  let databaseUrl = '';
  const fixtureAssetPaths: string[] = [];
  const fixtureAssetDirectories: string[] = [];
  const originalDatabaseUrl = process.env.DATABASE_URL;

  try {
    const isolatedDatabase = makeDatabaseFile();
    databasePath = isolatedDatabase.databasePath;
    databaseUrl = isolatedDatabase.databaseUrl;
    process.env.DATABASE_URL = databaseUrl;

    const initializerEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      NODE_ENV: 'production',
      DATABASE_URL: databaseUrl,
      PRISMA_HIDE_UPDATE_MESSAGE: '1',
    };
    await runChild(process.execPath, [prismaCliPath, 'db', 'push', '--skip-generate', '--schema', 'prisma/schema.prisma'], initializerEnv);

    const [{ prisma: db }, { hashPassword }] = await Promise.all([
      import('../src/lib/prisma'),
      import('../src/lib/auth/password'),
    ]);
    const smokePrisma = db;
    prisma = smokePrisma;

    const password = `${randomUUID()}-${randomUUID()}`;
    const ownerName = `http-smoke-owner-${randomUUID()}`;
    const strangerName = `http-smoke-stranger-${randomUUID()}`;
    const externalName = `http-smoke-external-${randomUUID()}`;
    const [owner, stranger, external] = await Promise.all([
      prisma.user.create({
        data: {
          name: 'Template HTTP smoke owner',
          username: ownerName,
          email: `${ownerName}@example.invalid`,
          password_hash: hashPassword(password),
          account_type: 'internal',
          status: 'active',
          ...testFeishuIdentity(ownerName),
        },
      }),
      prisma.user.create({
        data: {
          name: 'Template HTTP smoke stranger',
          username: strangerName,
          email: `${strangerName}@example.invalid`,
          password_hash: hashPassword(password),
          account_type: 'internal',
          status: 'active',
          ...testFeishuIdentity(strangerName),
        },
      }),
      prisma.user.create({
        data: {
          name: 'Template HTTP smoke external',
          username: externalName,
          email: `${externalName}@example.invalid`,
          password_hash: hashPassword(password),
          account_type: 'external',
          status: 'active',
          ...testFeishuIdentity(externalName),
        },
      }),
    ]);
    for (const user of [owner, stranger, external]) {
      assert.ok(user.feishu_user_id && user.feishu_open_id && user.feishu_union_id,
        'HTTP fixture users must carry the Feishu identity fields used by session authorization');
    }
    assert.equal(owner.account_type, 'internal');
    assert.equal(external.account_type, 'external');
    await prisma.creditAccount.create({ data: { user_id: owner.id, balance: 100_000 } });
    await prisma.creditAccount.create({ data: { user_id: stranger.id, balance: 100_000 } });
    const project = await prisma.project.create({
      data: {
        name: 'Template HTTP smoke project',
        type: 'personal',
        visibility: 'private',
        owner_user_id: owner.id,
        created_by: owner.id,
        status: 'active',
      },
    });
    const videoCard = await prisma.videoCard.create({
      data: {
        project_id: project.id,
        title: 'Template HTTP smoke card',
        owner_user_id: owner.id,
        created_by: owner.id,
        status: 'active',
      },
    });
    const strangerProject = await prisma.project.create({
      data: {
        name: 'Template HTTP smoke no-access project',
        type: 'personal',
        visibility: 'private',
        owner_user_id: stranger.id,
        created_by: stranger.id,
        status: 'active',
      },
    });
    const strangerVideoCard = await prisma.videoCard.create({
      data: {
        project_id: strangerProject.id,
        title: 'Template HTTP smoke no-access card',
        owner_user_id: stranger.id,
        created_by: stranger.id,
        status: 'active',
      },
    });

    const imageFixture = await createLocalImageFixture(fixtureAssetPaths, fixtureAssetDirectories);
    const sharedAlbum = await prisma.referenceAlbum.create({
      data: {
        owner_user_id: external.id,
        name: 'Template HTTP smoke shared album',
        album_type: 'personal',
        visibility: 'shared',
        status: 'active',
      },
    });
    const albumUseShare = await prisma.albumShare.create({
      data: {
        album_id: sharedAlbum.id,
        grantee_type: 'user',
        grantee_id: owner.id,
        permissions_json: JSON.stringify({ view: true, use: true, copy: false, download: false, viewSource: false, edit: false }),
        created_by: external.id,
        status: 'active',
      },
    });
    const createAlbumImageAsset = (input: { url: string; fileName: string; fileSize: number; width: number; height: number }) => smokePrisma.asset.create({
      data: {
        owner_id: external.id,
        type: 'image',
        original_url: input.url,
        file_name: input.fileName,
        mime_type: 'image/png',
        file_size: input.fileSize,
        width: input.width,
        height: input.height,
        hash: randomUUID(),
        status: 'active',
      },
    });
    const sharedAsset = await createAlbumImageAsset({
      url: imageFixture.originalUrl,
      fileName: imageFixture.fileName,
      fileSize: imageFixture.byteLength,
      width: imageFixture.width,
      height: imageFixture.height,
    });
    const sharedReferenceImage = await prisma.referenceImage.create({
      data: {
        album_id: sharedAlbum.id,
        owner_user_id: external.id,
        asset_id: sharedAsset.id,
        url: imageFixture.originalUrl,
        source_type: 'upload',
        status: 'active',
      },
    });
    const missingImageUrl = `/uploads/assets/template-studio-http-smoke-missing-${randomUUID()}.png`;
    const missingAsset = await createAlbumImageAsset({
      url: missingImageUrl,
      fileName: 'missing-shared-image.png',
      fileSize: imageFixture.byteLength,
      width: imageFixture.width,
      height: imageFixture.height,
    });
    const missingReferenceImage = await prisma.referenceImage.create({
      data: {
        album_id: sharedAlbum.id,
        owner_user_id: external.id,
        asset_id: missingAsset.id,
        url: missingImageUrl,
        source_type: 'upload',
        status: 'active',
      },
    });

    const parameters = {
      provider: 'seedance',
      model: 'dreamina-seedance-2-0-260128',
      generationMode: 'all_in_one_reference',
      ratio: '16:9',
      duration: 4,
      resolution: '480p',
      seed: -1,
      generateAudio: true,
      returnLastFrame: false,
      watermark: false,
      draft: false,
    };
    const sourcePrompt = 'An untouched source prompt from the template studio run.';
    const sourceSnapshot = {
      input: { name: 'HTTP smoke', groupName: 'contract', values: {}, draftPrompt: sourcePrompt },
      templateVersion: null,
      recipe: null,
      prompt: sourcePrompt,
      parameters,
      assets: [],
      owner: {
        userId: owner.id,
        username: owner.username,
        displayName: owner.name,
        accountType: 'internal',
      },
    };
    const draft = await prisma.videoStudioDraft.create({
      data: { owner_user_id: owner.id, name: 'HTTP smoke', template_source: 'blank' },
    });
    const run = await prisma.videoStudioRun.create({
      data: {
        owner_user_id: owner.id,
        draft_id: draft.id,
        request_id: randomUUID(),
        request_fingerprint: randomUUID(),
        source: 'blank',
        mode: 'direct',
        status: 'succeeded',
        prompt: sourcePrompt,
        snapshot_json: JSON.stringify(sourceSnapshot),
      },
    });

    const sharedStudioAsset = { assetId: sharedAsset.id, role: 'reference', type: 'image' } as const;
    const missingStudioAsset = { assetId: missingAsset.id, role: 'reference', type: 'image' } as const;
    const slotStudioAsset = { ...sharedStudioAsset, slotKey: 'identity' } as const;
    const slotRecipe = {
      instruction: '',
      fields: [],
      assetSlots: [{ key: 'identity', label: 'Identity', role: 'reference', types: ['image'], required: true, maxItems: 1 }],
      defaultParameters: parameters,
    };
    const createStudioRunFixture = async (input: {
      user: typeof owner;
      name: string;
      prompt: string;
      assets?: Array<typeof sharedStudioAsset | typeof slotStudioAsset>;
      recipe?: typeof slotRecipe | null;
    }) => {
      const fixtureDraft = await smokePrisma.videoStudioDraft.create({
        data: { owner_user_id: input.user.id, name: input.name, template_source: 'blank' },
      });
      const snapshot = {
        ...sourceSnapshot,
        input: { ...sourceSnapshot.input, name: input.name, draftPrompt: input.prompt },
        prompt: input.prompt,
        assets: input.assets || [],
        recipe: input.recipe || null,
        owner: {
          userId: input.user.id,
          username: input.user.username,
          displayName: input.user.name,
          accountType: input.user.account_type,
        },
      };
      return smokePrisma.videoStudioRun.create({
        data: {
          owner_user_id: input.user.id,
          draft_id: fixtureDraft.id,
          request_id: randomUUID(),
          request_fingerprint: randomUUID(),
          source: 'blank',
          mode: 'direct',
          status: 'succeeded',
          prompt: input.prompt,
          snapshot_json: JSON.stringify(snapshot),
        },
      });
    };
    const createRunWorkspace = async (
      ownerId: string,
      runId: string,
      images: Array<{ assetId: string; referenceImageId: string }>,
    ) => {
      const workspace = await smokePrisma.workspace.create({
        data: {
          id: randomUUID(),
          owner_id: ownerId,
          name: `默认工作台:template-studio-${runId}`,
          status: 'active',
        },
      });
      for (let index = 0; index < images.length; index += 1) {
        const image = images[index];
        await smokePrisma.workspaceAsset.create({
          data: {
            id: randomUUID(),
            workspace_id: workspace.id,
            asset_id: image.assetId,
            reference_image_id: image.referenceImageId,
            sort_order: index,
            role: 'reference_image',
          },
        });
      }
    };
    await createRunWorkspace(owner.id, run.id, [
      { assetId: sharedAsset.id, referenceImageId: sharedReferenceImage.id },
      { assetId: missingAsset.id, referenceImageId: missingReferenceImage.id },
    ]);
    const noPermissionRun = await createStudioRunFixture({
      user: stranger,
      name: 'No album use permission',
      prompt: 'No permission source prompt.',
    });
    await createRunWorkspace(stranger.id, noPermissionRun.id, [
      { assetId: sharedAsset.id, referenceImageId: sharedReferenceImage.id },
    ]);
    const sourceSlotRun = await createStudioRunFixture({
      user: owner,
      name: 'Source slot validation',
      prompt: 'Source slot prompt.',
      assets: [slotStudioAsset],
      recipe: slotRecipe,
    });
    await createRunWorkspace(owner.id, sourceSlotRun.id, [
      { assetId: sharedAsset.id, referenceImageId: sharedReferenceImage.id },
    ]);

    const provider = await startLocalProviderStub();
    providerServer = provider.server;
    const serverPort = await new Promise<number>((resolve, reject) => {
      const reservation = createServer();
      reservation.once('error', reject);
      reservation.listen(0, '127.0.0.1', () => {
        const address = reservation.address();
        if (!address || typeof address === 'string') {
          reject(new Error('Could not reserve a local Next server port'));
          return;
        }
        reservation.close((error) => error ? reject(error) : resolve(address.port));
      });
    });
    const baseUrl = `http://127.0.0.1:${serverPort}`;
    const sessionSecret = randomUUID() + randomUUID();
    const callbackSecret = randomUUID() + randomUUID();
    const serverEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      NODE_ENV: 'production',
      NEXT_TELEMETRY_DISABLED: '1',
      DATABASE_URL: databaseUrl,
      SESSION_SECRET: sessionSecret,
      VIDEO_DELIVERY_PUBLIC_BASE_URL: 'https://example.com',
      VIDEO_DELIVERY_CALLBACK_SECRET: callbackSecret,
      SEEDANCE_API_KEY: PROVIDER_API_KEY,
      SEEDANCE_BASE_URL: provider.baseUrl,
      SEEDANCE_API_BASE_URL: provider.baseUrl,
      ...(process.env.NEXT_DIST_DIR?.trim() ? { NEXT_DIST_DIR: process.env.NEXT_DIST_DIR.trim() } : {}),
      HOSTNAME: '127.0.0.1',
      PORT: String(serverPort),
    };
    nextServer = spawn(process.execPath, [nextCliPath, 'start', '--hostname', '127.0.0.1', '--port', String(serverPort)], {
      cwd: projectRoot,
      env: serverEnv,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!nextServer.pid) throw new Error('Could not launch the local Next server');
    captureNextServerOutput(nextServer, [PROVIDER_API_KEY, sessionSecret, callbackSecret]);
    await waitForServer(`${baseUrl}/login`, nextServer);

    const ownerCookie = await login(baseUrl, ownerName, password);
    const strangerCookie = await login(baseUrl, strangerName, password);
    const externalCookie = await login(baseUrl, externalName, password);
    const idempotencyKey = randomUUID();
    const editedPrompt = 'A paper lantern drifts above a quiet river at dusk.';
    const body = makeTaskBody({
      runId: run.id,
      projectId: project.id,
      videoCardId: videoCard.id,
      idempotencyKey,
      prompt: editedPrompt,
      parameters,
    });
    const createPath = '/api/tasks/create';
    const createRequest = (cookie: string, payload: Record<string, unknown>) => requestJson(baseUrl, cookie, createPath, {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    const firstResponse = await createRequest(ownerCookie, body);
    if (firstResponse.status !== 200) {
      throw new Error(`first task submission failed: ${await safeResponseError(firstResponse)}`);
    }
    const firstResult = await firstResponse.json() as Record<string, unknown>;
    assert.equal(typeof firstResult.id, 'string');
    assert.equal(firstResult.status, 'submitted');
    const taskId = String(firstResult.id);

    const firstTask = await prisma.videoTask.findUnique({ where: { id: taskId } });
    assert.ok(firstTask, 'accepted HTTP task must be persisted');
    assert.equal(firstTask.template_studio_run_id, run.id);
    assert.ok(firstTask.request_fingerprint, 'accepted task must persist its normalized request fingerprint');
    assert.ok(firstTask.template_studio_snapshot_json, 'accepted task must persist its immutable studio snapshot');
    const persistedSnapshot = JSON.parse(firstTask.template_studio_snapshot_json) as {
      sourceSnapshot?: { prompt?: string };
      submitted?: { prompt?: string };
    };
    assert.equal(persistedSnapshot.sourceSnapshot?.prompt, sourcePrompt);
    assert.equal(persistedSnapshot.submitted?.prompt, editedPrompt);
    assert.equal(await prisma.videoStudioRun.findUnique({ where: { id: run.id } }).then((item) => item?.prompt), sourcePrompt);

    const firstCreditLedgerCount = await prisma.creditLedger.count({ where: { related_task_id: taskId } });
    const firstProviderRequestCount = await prisma.providerApiRequest.count({ where: { task_id: taskId } });
    const firstCostLedgerCount = await prisma.costLedger.count({ where: { task_id: taskId } });
    const firstTaskCount = await prisma.videoTask.count({ where: { user_id: owner.id } });
    assert.equal(firstCreditLedgerCount, 1, 'first accepted task must write exactly one credit freeze ledger');
    assert.equal(firstProviderRequestCount, 1, 'first accepted task must persist exactly one provider request');
    assert.equal(firstCostLedgerCount, 2, 'first accepted task must write estimate and provider-submitted cost ledger rows');
    assert.equal(firstTaskCount, 1, 'owner must have exactly one task after the first submission');
    assert.deepEqual(provider.counts(), { createPackets: 1, unexpectedPackets: 0 });

    const replayResponse = await createRequest(ownerCookie, body);
    assert.equal(replayResponse.status, 200, `same-key replay failed (HTTP ${replayResponse.status})`);
    const replayResult = await replayResponse.json() as Record<string, unknown>;
    assert.equal(replayResult.id, taskId);
    assert.equal(replayResult.deduplicated, true);
    assert.equal(replayResult.fingerprint_verified, true);

    const changedPromptResponse = await createRequest(ownerCookie, { ...body, prompt: `${editedPrompt} A blue umbrella is nearby.` });
    assert.equal(changedPromptResponse.status, 409, 'same key with changed prompt must conflict');
    const changedPromptResult = await changedPromptResponse.json() as Record<string, unknown>;
    assert.equal(changedPromptResult.code, 'IDEMPOTENCY_PAYLOAD_MISMATCH');
    assert.equal(changedPromptResult.existing_task_id, taskId);

    const crossOwnerResponse = await createRequest(strangerCookie, body);
    assert.equal(crossOwnerResponse.status, 404, 'another owner must not submit against this studio run');
    const externalResponse = await createRequest(externalCookie, body);
    assert.equal(externalResponse.status, 403, 'external account must remain external even when Feishu identity fields exist');

    const lookupPath = `/api/template-studio-video-handoff?idempotency_key=${encodeURIComponent(idempotencyKey)}&template_studio_run_id=${encodeURIComponent(run.id)}`;
    const ownerLookupResponse = await requestJson(baseUrl, ownerCookie, lookupPath);
    assert.equal(ownerLookupResponse.status, 200);
    const ownerLookup = await ownerLookupResponse.json() as { task?: { id?: string; template_studio_run_id?: string } | null };
    assert.equal(ownerLookup.task?.id, taskId);
    assert.equal(ownerLookup.task?.template_studio_run_id, run.id);

    const strangerLookupResponse = await requestJson(baseUrl, strangerCookie, lookupPath);
    assert.equal(strangerLookupResponse.status, 200);
    const strangerLookup = await strangerLookupResponse.json() as { task?: unknown };
    assert.equal(strangerLookup.task, null, 'another owner must not discover the accepted task');
    const externalLookupResponse = await requestJson(baseUrl, externalCookie, lookupPath);
    assert.equal(externalLookupResponse.status, 403, 'external account must not use the internal handoff history endpoint');

    const ordinaryKey = randomUUID();
    const ordinaryBody: Record<string, unknown> = { ...body, idempotency_key: ordinaryKey };
    delete ordinaryBody.template_studio_run_id;
    delete ordinaryBody.template_studio_assets;
    delete ordinaryBody.template_studio_parameters;
    const ordinaryResponse = await createRequest(ownerCookie, ordinaryBody);
    if (ordinaryResponse.status !== 200) {
      throw new Error(`ordinary task submission failed: ${await safeResponseError(ordinaryResponse)}`);
    }
    const ordinaryResult = await ordinaryResponse.json() as Record<string, unknown>;
    const ordinaryTaskId = String(ordinaryResult.id);
    assert.equal(typeof ordinaryResult.id, 'string');
    const ordinaryTask = await prisma.videoTask.findUnique({ where: { id: ordinaryTaskId } });
    assert.ok(ordinaryTask);
    assert.equal(ordinaryTask.template_studio_run_id, null, 'ordinary task must stay outside the studio-run link');
    assert.ok(ordinaryTask.request_fingerprint);
    const ordinaryCreditCount = await prisma.creditLedger.count({ where: { related_task_id: ordinaryTaskId } });
    const ordinaryProviderRequestCount = await prisma.providerApiRequest.count({ where: { task_id: ordinaryTaskId } });
    const ordinaryCostLedgerCount = await prisma.costLedger.count({ where: { task_id: ordinaryTaskId } });
    assert.equal(ordinaryCreditCount, 1);
    assert.equal(ordinaryProviderRequestCount, 1);
    assert.equal(ordinaryCostLedgerCount, 2);

    const ordinaryReplayResponse = await createRequest(ownerCookie, ordinaryBody);
    assert.equal(ordinaryReplayResponse.status, 200, 'ordinary same-key/same-payload replay must reuse the task');
    const ordinaryReplay = await ordinaryReplayResponse.json() as Record<string, unknown>;
    assert.equal(ordinaryReplay.id, ordinaryTaskId);
    assert.equal(ordinaryReplay.deduplicated, true);
    assert.equal(ordinaryReplay.fingerprint_verified, true);
    const ordinaryChangedResponse = await createRequest(ownerCookie, {
      ...ordinaryBody,
      prompt: `${editedPrompt} With a red bicycle.`,
    });
    assert.equal(ordinaryChangedResponse.status, 409, 'ordinary same-key/changed-payload request must conflict');
    assert.equal((await ordinaryChangedResponse.json() as Record<string, unknown>).code, 'IDEMPOTENCY_PAYLOAD_MISMATCH');
    assert.equal(await prisma.creditLedger.count({ where: { related_task_id: ordinaryTaskId } }), ordinaryCreditCount);
    assert.equal(await prisma.providerApiRequest.count({ where: { task_id: ordinaryTaskId } }), ordinaryProviderRequestCount);
    assert.equal(await prisma.costLedger.count({ where: { task_id: ordinaryTaskId } }), ordinaryCostLedgerCount);
    assert.deepEqual(provider.counts(), { createPackets: 2, unexpectedPackets: 0 });

    const legacyKey = randomUUID();
    const legacyTask = await prisma.videoTask.create({
      data: {
        provider: 'seedance',
        model: String(parameters.model),
        generation_mode: String(parameters.generationMode),
        prompt: 'Historical prompt without a stored fingerprint.',
        local_status: 'submitted',
        user_id: owner.id,
        owner_user_id: owner.id,
        project_id: project.id,
        video_card_id: videoCard.id,
        idempotency_key: legacyKey,
        request_fingerprint: null,
      },
    });
    const legacyReplayResponse = await createRequest(ownerCookie, {
      ...ordinaryBody,
      idempotency_key: legacyKey,
      prompt: 'Different retry cannot be fingerprint-verified.',
    });
    assert.equal(legacyReplayResponse.status, 200, 'historical NULL fingerprint must keep legacy replay compatibility');
    const legacyReplay = await legacyReplayResponse.json() as Record<string, unknown>;
    assert.equal(legacyReplay.id, legacyTask.id);
    assert.equal(legacyReplay.deduplicated, true);
    assert.equal(legacyReplay.fingerprint_verified, false);
    assert.equal(await prisma.creditLedger.count({ where: { related_task_id: legacyTask.id } }), 0);
    assert.equal(await prisma.providerApiRequest.count({ where: { task_id: legacyTask.id } }), 0);
    assert.equal(await prisma.costLedger.count({ where: { task_id: legacyTask.id } }), 0);
    assert.deepEqual(provider.counts(), { createPackets: 2, unexpectedPackets: 0 });

    const sharedBody = makeTaskBody({
      runId: run.id,
      projectId: project.id,
      videoCardId: videoCard.id,
      idempotencyKey: randomUUID(),
      prompt: 'A lantern on a quiet river, guided by a shared reference image.',
      parameters,
      assets: [sharedStudioAsset],
    });
    const sharedResponse = await createRequest(ownerCookie, sharedBody);
    if (sharedResponse.status !== 200) {
      throw new Error(`shared-album image submission failed: ${await safeResponseError(sharedResponse)}`);
    }
    const sharedResult = await sharedResponse.json() as Record<string, unknown>;
    const sharedTaskId = String(sharedResult.id);
    const sharedTask = await prisma.videoTask.findUnique({ where: { id: sharedTaskId } });
    assert.ok(sharedTask);
    const sharedSnapshot = JSON.parse(sharedTask.template_studio_snapshot_json || '{}') as {
      submitted?: { assets?: Array<{ assetId?: string; role?: string }> };
    };
    assert.deepEqual(sharedSnapshot.submitted?.assets, [{ assetId: sharedAsset.id, role: 'reference', type: 'image' }]);
    const sharedCreditCount = await prisma.creditLedger.count({ where: { related_task_id: sharedTaskId } });
    const sharedProviderRequestCount = await prisma.providerApiRequest.count({ where: { task_id: sharedTaskId } });
    const sharedCostLedgerCount = await prisma.costLedger.count({ where: { task_id: sharedTaskId } });
    assert.equal(sharedCreditCount, 1);
    assert.equal(sharedProviderRequestCount, 1);
    assert.equal(sharedCostLedgerCount, 2);
    assert.deepEqual(provider.counts(), { createPackets: 3, unexpectedPackets: 0 });

    const sideEffectsBeforeDeniedAssets = {
      tasks: await prisma.videoTask.count(),
      credits: await prisma.creditLedger.count(),
      providerRequests: await prisma.providerApiRequest.count(),
      costs: await prisma.costLedger.count(),
    };
    const missingFileResponse = await createRequest(ownerCookie, makeTaskBody({
      runId: run.id,
      projectId: project.id,
      videoCardId: videoCard.id,
      idempotencyKey: randomUUID(),
      prompt: 'Missing file must not be accepted.',
      parameters,
      assets: [missingStudioAsset],
    }));
    assert.equal(missingFileResponse.status, 409, 'shared access must not bypass real-file validation');

    const wrongSlotResponse = await createRequest(ownerCookie, makeTaskBody({
      runId: sourceSlotRun.id,
      projectId: project.id,
      videoCardId: videoCard.id,
      idempotencyKey: randomUUID(),
      prompt: 'A source slot cannot be rebound.',
      parameters,
      assets: [{ ...slotStudioAsset, slotKey: 'tampered-slot' }],
    }));
    assert.equal(wrongSlotResponse.status, 409, 'source asset slot binding must remain enforced');

    const noPermissionResponse = await createRequest(strangerCookie, makeTaskBody({
      runId: noPermissionRun.id,
      projectId: strangerProject.id,
      videoCardId: strangerVideoCard.id,
      idempotencyKey: randomUUID(),
      prompt: 'No album use permission must be denied.',
      parameters,
      assets: [sharedStudioAsset],
    }));
    assert.equal(noPermissionResponse.status, 403, 'album visibility without use permission must not grant generation access');

    await prisma.asset.update({ where: { id: sharedAsset.id }, data: { status: 'hidden' } });
    const inactiveAssetResponse = await createRequest(ownerCookie, makeTaskBody({
      runId: run.id,
      projectId: project.id,
      videoCardId: videoCard.id,
      idempotencyKey: randomUUID(),
      prompt: 'Inactive shared asset must be denied.',
      parameters,
      assets: [sharedStudioAsset],
    }));
    assert.equal(inactiveAssetResponse.status, 403, 'inactive shared assets must remain unusable');
    await prisma.asset.update({ where: { id: sharedAsset.id }, data: { status: 'active' } });

    await prisma.albumShare.update({ where: { id: albumUseShare.id }, data: { status: 'revoked' } });
    const revokedShareResponse = await createRequest(ownerCookie, makeTaskBody({
      runId: run.id,
      projectId: project.id,
      videoCardId: videoCard.id,
      idempotencyKey: randomUUID(),
      prompt: 'Revoked album use must be denied.',
      parameters,
      assets: [sharedStudioAsset],
    }));
    assert.equal(revokedShareResponse.status, 403, 'revoked album use permission must deny a new task');

    assert.deepEqual({
      tasks: await prisma.videoTask.count(),
      credits: await prisma.creditLedger.count(),
      providerRequests: await prisma.providerApiRequest.count(),
      costs: await prisma.costLedger.count(),
    }, sideEffectsBeforeDeniedAssets, 'denied asset requests must not create tasks or bill/call the provider');
    assert.deepEqual(provider.counts(), { createPackets: 3, unexpectedPackets: 0 });

    assert.equal(await prisma.videoTask.count(), 4, 'only three accepted HTTP tasks plus the seeded legacy row may exist');
    assert.equal(await prisma.videoTask.count({ where: { user_id: owner.id } }), 4);
    assert.equal(await prisma.videoTask.count({ where: { user_id: stranger.id } }), 0);
    assert.equal(await prisma.videoTask.count({ where: { user_id: external.id } }), 0);
    assert.equal(await prisma.creditLedger.count({ where: { related_task_id: taskId } }), firstCreditLedgerCount);
    assert.equal(await prisma.providerApiRequest.count({ where: { task_id: taskId } }), firstProviderRequestCount);
    assert.equal(await prisma.costLedger.count({ where: { task_id: taskId } }), firstCostLedgerCount);
    assert.deepEqual(provider.counts(), { createPackets: 3, unexpectedPackets: 0 });

    console.log('template-studio HTTP smoke passed: isolated ordinary/studio idempotency, shared-album authorization, and side-effect counts.');
  } finally {
    const cleanupErrors: string[] = [];
    try { await stopChild(nextServer); } catch { cleanupErrors.push('Next server stop failed'); }
    if (providerServer) {
      try { await closeServer(providerServer); } catch { cleanupErrors.push('Provider stub close failed'); }
    }
    for (const fixturePath of fixtureAssetPaths) {
      try { assertRegularFileBeforeRemoving(fixturePath); }
      catch { cleanupErrors.push('Temporary image fixture cleanup failed'); }
    }
    for (const directory of fixtureAssetDirectories.reverse()) {
      try { rmdirSync(directory); }
      catch { /* Preserve directories that gained unrelated files during the smoke. */ }
    }
    if (prisma) {
      try { await prisma.$disconnect(); } catch { cleanupErrors.push('Isolated database disconnect failed'); }
    }
    if (databasePath) {
      for (const suffix of ['', '-journal', '-wal', '-shm']) {
        try { assertRegularFileBeforeRemoving(`${databasePath}${suffix}`); }
        catch { cleanupErrors.push('Isolated database cleanup failed'); }
      }
    }
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (cleanupErrors.length > 0) {
      console.error(`HTTP smoke cleanup incomplete: ${Array.from(new Set(cleanupErrors)).join(', ')}`);
      process.exitCode = 1;
    }
  }
}

void runSmoke().catch((error) => {
  console.error(error instanceof Error ? sanitizeDiagnostic(error.message) : 'Template Studio HTTP smoke failed');
  const localStack = extractLocalErrorStack();
  console.error(`Local Next error stack:\n${localStack || '(none captured)'}`);
  process.exitCode = 1;
});
