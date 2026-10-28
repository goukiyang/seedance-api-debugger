import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { mock } from 'node:test';
import sharp from '../src/lib/media/sharp';

process.exitCode = 1;

/** Real authenticated route/CAS checks against private SQLite and HD manifests. */
async function main() {
  const applicationRoot = await fs.realpath(process.cwd());
  const runId = process.env.IMAGE_RECOVERY_GATE_RUN_ID;
  assert.match(runId || '', /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sd2-hd-admin-'));
  await fs.chmod(directory, 0o700);
  const oldUmask = process.umask(0o077);
  const require = createRequire(import.meta.url);
  assert.equal(Reflect.get(globalThis, 'prisma'), undefined);
  delete process.env.HD_DERIVATIVES_ROOT; delete process.env.HD_DERIVATIVES_DIR;
  process.env.DATABASE_URL = `file:${path.join(directory, 'synthetic.db')}`;
  process.env.HD_DERIVATIVES_ROOT = path.join(directory, 'storage/hd-derivatives');
  process.env.SESSION_SECRET = randomBytes(32).toString('hex');
  Object.assign(process.env, { NODE_ENV: 'test' });
  Reflect.set(globalThis, 'AsyncLocalStorage', AsyncLocalStorage);
  await fs.mkdir(process.env.HD_DERIVATIVES_ROOT, { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(directory, '.media/uploads'), { recursive: true });
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', DATABASE_URL: process.env.DATABASE_URL,
    PRISMA_GENERATE_SKIP_AUTOINSTALL: '1', NEXT_TELEMETRY_DISABLED: '1' };
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ']) if (process.env[name]) env[name] = process.env[name];
  const prismaCli = path.join(path.dirname(require.resolve('prisma/package.json')), 'build/index.js');
  const schemaLog = execFileSync(process.execPath, [prismaCli, 'db', 'push', '--skip-generate', '--schema',
    path.join(applicationRoot, 'prisma/schema.prisma')], { cwd: directory, env, encoding: 'utf8', timeout: 120000 });
  await fs.writeFile(path.join(directory, 'schema.log'), schemaLog, { mode: 0o600 });
  const { requestAsyncStorage } = require('./fixtures/next-request-context') as typeof import('./fixtures/next-request-context');
  const { RequestCookies } = require('next/dist/compiled/@edge-runtime/cookies') as typeof import('next/dist/compiled/@edge-runtime/cookies');
  const { prisma } = require('../src/lib/prisma') as typeof import('../src/lib/prisma');
  const { hdReadRepository } = require('../src/lib/media/hd-readonly-db') as typeof import('../src/lib/media/hd-readonly-db');
  const { createSession, SESSION_COOKIE } = require('../src/lib/auth/session') as typeof import('../src/lib/auth/session');
  const core = require('../src/lib/media/hd-derivatives') as typeof import('../src/lib/media/hd-derivatives');
  const route = require('../src/app/api/admin/hd-derivatives/route') as typeof import('../src/app/api/admin/hd-derivatives/route');
  let forbiddenCalls = 0;
  const blocked = () => { forbiddenCalls++; throw Error('External requests prohibited in HD admin fixture'); };
  mock.method(globalThis, 'fetch', blocked); mock.method(http, 'request', blocked); mock.method(http, 'get', blocked);
  mock.method(https, 'request', blocked); mock.method(https, 'get', blocked);
  const checks: string[] = [];
  process.chdir(directory);
  try {
    const tokens: Record<string, string> = {};
    for (const [id, role] of [['hd-admin', 'admin'], ['hd-user', 'user']] as const) {
      await prisma.user.create({ data: { id, role, name: `Synthetic ${id}`, username: id,
        email: `${id}@isolated.invalid`, password_hash: 'synthetic-not-a-password' } });
      tokens[id] = await createSession(id);
    }
    const invoke = async (actor: string | null, action?: string, token?: string, sameOrigin = true) => {
      const headers = new Headers({ Host: 'hd-admin-isolated.invalid', ...(actor ? { Cookie: `${SESSION_COOKIE}=${tokens[actor]}` } : {}),
        ...(action ? { 'Content-Type': 'application/json', Origin: sameOrigin ? 'http://hd-admin-isolated.invalid' : 'http://other.invalid' } : {}) });
      const request = new Request('http://hd-admin-isolated.invalid/api/admin/hd-derivatives', {
        method: action ? 'POST' : 'GET', headers, ...(action ? { body: JSON.stringify({ action, token }) } : {}),
      });
      const store = { headers, cookies: new RequestCookies(headers) } as unknown as Parameters<typeof requestAsyncStorage.run>[0];
      const response = await requestAsyncStorage.run(store, () => action ? route.POST(request) : route.GET(request as import('next/server').NextRequest));
      assert.match(response.headers.get('cache-control') || '', /private.*no-store/);
      assert.equal(response.headers.get('vary'), 'Cookie');
      return { status: response.status, body: await response.json() };
    };
    const absent = await core.hdControl();
    assert.equal((await invoke(null)).status, 403);
    assert.equal((await invoke('hd-user')).status, 403);
    assert.equal((await invoke('hd-user', 'pause', absent.token)).status, 403);
    assert.equal((await invoke('hd-admin', 'pause', absent.token, false)).status, 403);
    assert.equal((await invoke('hd-admin', 'pause', 'stale-token')).status, 409);
    assert.deepEqual(await core.hdControl(), absent);
    assert.equal((await core.listHdJobs()).length, 0);
    checks.push('real_admin_session_origin_and_control_token_reject_without_writes');

    const image = await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 51, g: 82, b: 115 } } }).png().toBuffer();
    const writeJob = async (name: string, overrides: Record<string, unknown>) => {
      await fs.writeFile(path.join(directory, '.media/uploads', `${name}.png`), image);
      const job = await core.requestHd(`/uploads/${name}.png`, 0, false); assert.ok(job);
      await core.atomicHdJson(path.join(core.hdDirectory(), `${job.key}.json`), {
        ...job, status: 'failed', attempts: 3, attemptLimit: 3, updatedAt: new Date().toISOString(), ...overrides,
        ...(overrides.status === 'running' ? { attemptHistory: [{ attempt: 1, startedAt: new Date().toISOString(),
          sourceVersion: job.version, status: 'running' }] } : {}),
      });
      return job;
    };
    const io = await writeJob('known-io', { reason: 'temporary_io', errorKind: 'temporary_io' });
    const timeout = await writeJob('known-timeout', { reason: 'encode_timeout', errorKind: 'encode_timeout', executionExitedAt: new Date().toISOString() });
    const unknown = await writeJob('unknown', { reason: 'private /data/synthetic/source.png', errorKind: 'unknown' });
    const unconfirmed = await writeJob('unconfirmed-timeout', { reason: 'encode_timeout', errorKind: 'encode_timeout' });
    const processing = await writeJob('processing', { status: 'running', attempts: 1, attemptLimit: 3, stage: 'encoding',
      executionId: randomUUID(), lastProgressAt: new Date().toISOString(),
      diagnostic: { stage: 'encoding', code: 'private_path', message: '/data/private/source.png stack synthetic' } });
    const beforeRead = await core.hdControl();
    const read = await invoke('hd-admin'); assert.equal(read.status, 200);
    assert.equal(read.body.retryableCount, 2);
    assert.equal(read.body.retry.exhausted, 2);
    assert.equal(read.body.processing.stage, 'encoding');
    assert.equal(read.body.processing.attempt, 1);
    const publicText = JSON.stringify(read.body);
    for (const hidden of [directory, '/data/', '/uploads/', 'executionId', processing.key, io.key, 'stack synthetic']) assert.ok(!publicText.includes(hidden));
    assert.equal(read.body.reasons.unknown_failure, 1);
    assert.deepEqual(await core.hdControl(), beforeRead, 'GET must not modify control');
    checks.push('public_status_reports_real_processing_retry_and_progress_without_private_identity');

    const retry = await invoke('hd-admin', 'retry', read.body.control.token);
    assert.equal(retry.status, 200); assert.equal(retry.body.retrySummary.queued, 2);
    assert.equal((await core.readHdJob(io.key))!.status, 'queued');
    assert.equal((await core.readHdJob(timeout.key))!.status, 'queued');
    assert.equal((await core.readHdJob(unknown.key))!.status, 'failed');
    assert.equal((await core.readHdJob(unconfirmed.key))!.status, 'failed');
    assert.equal(await prisma.imageStudioTask.count(), 0);
    assert.equal(await prisma.creditLedger.count(), 0);
    checks.push('retry_only_known_original_jobs_including_confirmed_timeout_without_provider_or_billing');

    const hardFailed = await writeJob('hard-paused-io', { reason: 'temporary_io', errorKind: 'temporary_io' });
    await core.setHdControl(true, 'output_integrity');
    const hardPause = await core.hdControl();
    const manifestsBefore = JSON.stringify(await core.listHdJobs());
    const heldRetry = await invoke('hd-admin', 'retry', hardPause.token);
    assert.equal(heldRetry.body.retrySummary.queued, 0); assert.equal(heldRetry.body.retrySummary.held, 1);
    assert.equal((await core.readHdJob(hardFailed.key))!.status, 'failed');
    assert.equal((await invoke('hd-admin', 'recheck', hardPause.token)).status, 409);
    await invoke('hd-admin', 'pause', hardPause.token);
    assert.deepEqual(await core.hdControl(), hardPause, 'Retry, recheck and pause cannot relabel a hard stop');
    assert.equal(JSON.stringify(await core.listHdJobs()), manifestsBefore);
    checks.push('hard_pause_never_released_or_relabelled_by_admin_retry_or_recheck');

    // A malformed real private manifest must become an explicit failed read,
    // never an empty/healthy response, and must not be overwritten on GET.
    const manifestFile = path.join(core.hdDirectory(), `${unknown.key}.json`);
    const validManifest = await fs.readFile(manifestFile);
    await fs.writeFile(manifestFile, '{invalid-private-manifest');
    const failedRead = await invoke('hd-admin'); assert.equal(failedRead.status, 503);
    assert.equal(failedRead.body.counts, undefined); assert.equal(failedRead.body.control, undefined);
    assert.ok(!JSON.stringify(failedRead.body).includes(directory));
    assert.equal(await fs.readFile(manifestFile, 'utf8'), '{invalid-private-manifest');
    await fs.writeFile(manifestFile, validManifest);
    assert.equal((await invoke('hd-admin')).status, 200);
    checks.push('status_read_failure_is_explicit_unknown_and_preserves_private_state');

    // The existing account boundary and local preference namespace remain in
    // the real component; this is source evidence, not a browser acceptance.
    const component = await fs.readFile(path.join(applicationRoot, 'src/components/HdDerivativeManagement.tsx'), 'utf8');
    assert.ok(component.includes('snapshotOwner === account'));
    assert.ok(component.includes('`sd2:hd-management:v1:${account}`'));
    assert.ok(component.includes('requestId === sequence.current'));
    assert.ok(component.includes('<RelativeTime value={data.control.wait.nextCheckAt} />'));
    assert.equal(checks.length, 5);
    assert.equal(forbiddenCalls, 0);
    const receipt = { schema: 'hd-admin-engineering.v1', runId, completed: true, checks, total: checks.length, passed: checks.length,
      productionWrites: 0, paidRequests: 0, browserRuns: 0, forbiddenCalls };
    await fs.writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt), { mode: 0o600 });
    console.log(JSON.stringify(receipt));
  } finally {
    mock.restoreAll(); await prisma.$disconnect(); await hdReadRepository.close();
    process.chdir(applicationRoot); process.umask(oldUmask);
  }
}

void main().then(() => { process.exitCode = 0; }).catch(error => { console.error(error); process.exitCode = 1; });
