import { createHash, randomUUID } from 'crypto';
import { appendFile, mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'fs/promises';
import path from 'path';
import { prisma } from '../src/lib/prisma';
import { coordinatorUser } from '../src/lib/canvas-roles/permissions';
import { planRoleDispatches } from '../src/lib/canvas-roles/advancement';
import { executeReservedDispatch, reconcileAttempt, recoverRoleDispatch } from '../src/lib/canvas-roles/execution';
import { reconcileRoleMediaBindings } from '../src/lib/canvas-roles/media-bindings';
import { RoleError } from '../src/lib/canvas-roles/types';
import { isRoleCollaborationReadOnly } from '../src/lib/canvas-roles/guard';

const owner = `${process.pid}:${randomUUID()}`;
const logRoot = '/data/video-api-debugger/role-coordinator/logs';
const logPath = `${logRoot}/coordinator.log`;
const runtimePath = '/data/video-api-debugger/role-coordinator/runtime.json';
let startup: { pid: number; sourceRoot: string; startedAt: string; version: string; loadedModuleSha: Record<string, string> };
const running = new Map<string, { token: string; epoch: number; promise: Promise<void> }>();
let stopped = false, lastHeartbeat = 0;
let attemptAfter: { started_at: Date; id: string } | null = null;
let recoveryAfter: { lease_until: Date; id: string } | null = null;
process.once('SIGTERM', () => { stopped = true; });
process.once('SIGINT', () => { stopped = true; });

async function log(code: string) {
  try {
    await mkdir(logRoot, { recursive: true, mode: 0o700 });
    const info = await stat(logPath).catch(() => null);
    if (info && info.size >= 10 * 1024 * 1024) {
      await unlink(`${logPath}.7`).catch(() => {});
      for (let i = 6; i >= 1; i--) await rename(`${logPath}.${i}`, `${logPath}.${i + 1}`).catch(() => {});
      await rename(logPath, `${logPath}.1`);
    }
    await appendFile(logPath, JSON.stringify({ at: new Date().toISOString(), code }) + '\n', { mode: 0o600 });
  } catch { console.error('[RoleCoordinator] log_unavailable'); }
}
function errorCode(error: unknown) { return error instanceof RoleError ? error.code : 'coordinator_operation_unconfirmed'; }

async function publishRuntime(state: 'active' | 'stopping' | 'stopped') {
  const temporary = `${runtimePath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ protocol: 'role.collaboration.v2', ...startup,
    heartbeatAt: new Date().toISOString(), state, inFlight: running.size }) + '\n', { mode: 0o600 });
  await rename(temporary, runtimePath);
}

async function recordStartup() {
  const sourceRoot = await realpath(process.cwd());
  const files = ['scripts/canvas-role-coordinator.ts', 'prisma/schema.prisma', 'src/lib/canvas-documents.ts',
    'src/lib/admin/usage-attribution.ts',
    ...(await readdir(path.join(sourceRoot, 'src/lib/canvas-roles'))).filter(name => name.endsWith('.ts'))
      .sort().map(name => `src/lib/canvas-roles/${name}`)];
  const loadedModuleSha: Record<string, string> = {};
  for (const file of files) loadedModuleSha[file] = createHash('sha256').update(await readFile(path.join(sourceRoot, file))).digest('hex');
  const packageInfo = JSON.parse(await readFile(path.join(sourceRoot, 'package.json'), 'utf8'));
  const tables = await prisma.$queryRaw<Array<{ name: string }>>`SELECT name FROM sqlite_master WHERE type = 'table'
    AND name IN ('CanvasRoleRunControl','CanvasRoleAuthorization','CanvasRoleDispatch','CanvasRoleQuestion',
    'CanvasRoleMediaBinding','CanvasRoleWorkflowTemplate','CanvasRoleWorkflowTemplateVersion','UsageAttribution')`;
  if (tables.length !== 8) throw new Error('role_schema_unavailable');
  startup = { pid: process.pid, sourceRoot, startedAt: new Date().toISOString(), version: packageInfo.version, loadedModuleSha };
  await mkdir(path.dirname(runtimePath), { recursive: true, mode: 0o700 });
  await publishRuntime('active');
}

async function heartbeat() {
  if (Date.now() - lastHeartbeat < 10000) return;
  lastHeartbeat = Date.now();
  for (const [id, task] of Array.from(running)) await prisma.canvasRoleDispatch.updateMany({ where: { id, state: 'leased',
    lease_owner: owner, lease_token: task.token, lease_epoch: task.epoch }, data: { lease_until: new Date(Date.now() + 90000) } });
  await publishRuntime(stopped ? 'stopping' : 'active');
}

async function recoverExpired() {
  const rows = await prisma.canvasRoleDispatch.findMany({ where: { state: 'leased', lease_until: { lt: new Date() },
    ...(recoveryAfter ? { OR: [{ lease_until: { gt: recoveryAfter.lease_until } },
      { lease_until: recoveryAfter.lease_until, id: { gt: recoveryAfter.id } }] } : {}) },
    orderBy: [{ lease_until: 'asc' }, { id: 'asc' }], take: 32, include: { run: { select: { owner_user_id: true } } } });
  const last = rows[rows.length - 1];
  recoveryAfter = rows.length === 32 && last?.lease_until ? { lease_until: last.lease_until, id: last.id } : null;
  for (const row of rows) {
    try {
      const user = await coordinatorUser(prisma, row.run.owner_user_id);
      await prisma.$transaction(db => recoverRoleDispatch(db, user, row.id), { timeout: 15000 });
    } catch (error) { await log(errorCode(error)); }
  }
}

async function readOriginalResults() {
  const attempts = await prisma.canvasRoleAttempt.findMany({ where: { settlement_applied: false,
    work: { run: { control: { isNot: null } } },
    state: { notIn: ['reserved', 'sending'] }, provider_reference: { not: null },
    fee_state: { in: ['pending', 'unknown'] }, started_at: { gte: new Date(Date.now() - 86400000) },
    ...(attemptAfter ? { OR: [{ started_at: { gt: attemptAfter.started_at } },
      { started_at: attemptAfter.started_at, id: { gt: attemptAfter.id } }] } : {}) },
    orderBy: [{ started_at: 'asc' }, { id: 'asc' }], take: 32,
    select: { id: true, started_at: true, work: { select: { run: { select: { owner_user_id: true } } } } } });
  // Advance past temporarily unavailable owners and backoff entries as well.
  const lastAttempt = attempts[attempts.length - 1];
  attemptAfter = attempts.length === 32 && lastAttempt ? { started_at: lastAttempt.started_at, id: lastAttempt.id } : null;
  for (const row of attempts) {
    if (stopped) return;
    try { await reconcileAttempt(await coordinatorUser(prisma, row.work.run.owner_user_id), row.id, { automatic: true }); }
    catch (error) { await log(errorCode(error)); }
  }
  if (stopped) return;
  const bindings = await prisma.canvasRoleMediaBinding.findMany({ where: { OR: [{ settlement_applied: false },
    { state: { in: ['pending', 'running', 'unknown', 'waiting'] } }],
    AND: [{ OR: [{ next_check_at: null }, { next_check_at: { lte: new Date() } }] }] },
    orderBy: [{ next_check_at: 'asc' }, { id: 'asc' }], take: 32,
    select: { run_id: true, run: { select: { owner_user_id: true } } } });
  const seen = new Set<string>();
  for (const row of bindings) {
    if (stopped) return;
    if (seen.has(row.run_id)) continue;
    seen.add(row.run_id);
    try { await reconcileRoleMediaBindings(await coordinatorUser(prisma, row.run.owner_user_id), row.run_id); }
    catch (error) { await log(errorCode(error)); }
  }
}

async function planReadyRuns() {
  const controls = await prisma.canvasRoleRunControl.findMany({ where: { mode: 'automatic', active_grant_id: { not: null },
    run: { status: 'active', paused: false }, OR: [{ next_wake_at: null }, { next_wake_at: { lte: new Date() } }] },
    orderBy: [{ next_wake_at: 'asc' }, { run_id: 'asc' }], take: 32,
    include: { run: { select: { owner_user_id: true } } } });
  for (const control of controls) {
    if (stopped) return;
    try {
      const user = await coordinatorUser(prisma, control.run.owner_user_id);
      await prisma.$transaction(async db => {
        await planRoleDispatches(db, user, control.run_id);
        await db.canvasRoleRunControl.updateMany({ where: { run_id: control.run_id, mode: 'automatic' },
          data: { next_wake_at: new Date(Date.now() + 15000) } });
      }, { timeout: 15000 });
    } catch (error) {
      const code = errorCode(error);
      await prisma.$transaction(async db => {
        await db.canvasRoleTaskRun.update({ where: { id: control.run_id }, data: { paused: true, revision: { increment: 1 } } });
        await db.canvasRoleRunControl.update({ where: { run_id: control.run_id }, data: { mode: 'paused',
          pause_reason: code, next_wake_at: null, revision: { increment: 1 } } });
      });
      await log(code);
    }
  }
}

async function claimReady() {
  if (stopped || running.size >= 2) return;
  const candidates = await prisma.canvasRoleDispatch.findMany({ where: { state: 'queued', due_at: { lte: new Date() } },
    orderBy: [{ due_at: 'asc' }, { created_at: 'asc' }, { id: 'asc' }], take: 2 - running.size,
    include: { run: { select: { owner_user_id: true } } } });
  for (const candidate of candidates) {
    if (stopped) return;
    const token = randomUUID(), epoch = candidate.lease_epoch + 1;
    const claimed = await prisma.canvasRoleDispatch.updateMany({ where: { id: candidate.id, state: 'queued', lease_epoch: candidate.lease_epoch },
      data: { state: 'leased', lease_owner: owner, lease_token: token, lease_epoch: epoch, lease_until: new Date(Date.now() + 90000) } });
    if (!claimed.count) continue;
    const promise = (async () => {
      try { await executeReservedDispatch(await coordinatorUser(prisma, candidate.run.owner_user_id), candidate.id, token, epoch); }
      catch (error) { await log(errorCode(error)); }
    })().finally(() => { running.delete(candidate.id); });
    running.set(candidate.id, { token, epoch, promise });
  }
}

async function main() {
  if (isRoleCollaborationReadOnly()) throw new Error('collaboration_guard');
  await recordStartup();
  await log('started');
  let heartbeatBusy = false;
  const timer = setInterval(() => {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    void heartbeat().catch(error => log(errorCode(error))).finally(() => { heartbeatBusy = false; });
  }, 10000);
  while (!stopped) {
    try {
      await heartbeat(); await recoverExpired(); await readOriginalResults(); await planReadyRuns(); await claimReady();
    } catch (error) { await log(errorCode(error)); }
    if (!stopped) await new Promise(resolve => setTimeout(resolve, running.size ? 2000 : 15000));
  }
  await Promise.all(Array.from(running.values()).map(task => task.promise));
  clearInterval(timer);
  await publishRuntime('stopped');
  await log('stopped');
  await prisma.$disconnect();
}
main().catch(async () => { await log('startup_failed'); await prisma.$disconnect(); process.exit(1); });
