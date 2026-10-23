import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { hdReadonlyDb as prisma } from '../src/lib/media/hd-readonly-db';
import { assertHdDirectoryAccess, assertHdWorkerLock, atomicHdJson, hdCapacity, hdControl, hdDirectory, hdEligibility, hdSource, hdStatus, hdWorkerFailureSummary, listHdJobs, processHdJob, readHdJob, recordHdWorkerFailure, recheckHdResources, requestHd, retryFailedHd, retryHdKey, setHdControl, type HdFairnessState, type HdRequestContext } from '../src/lib/media/hd-derivatives';
import { claimHdScheduledJob, finishHdScheduledClaim, readHdScheduler, seedHdSchedulerFairness } from '../src/lib/media/hd-scheduler';
import { stopHdImageProcessors } from '../src/lib/media/hd-image-processor';
import { HD_RESOURCE_POLICY } from '../src/lib/media/hd-resource-state';
import { discoverHdBatch, hdSourceIsolationReason, readHdDiscoveryCheckpoint } from '../src/lib/media/hd-discovery';

const mode = process.argv[2] || 'status';
const batch = 'ui30-old-20261007';
async function availableMemory() {
  if (process.platform !== 'linux') return os.freemem();
  const info = await fs.readFile('/proc/meminfo', 'utf8');
  const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(info);
  if (!match) throw new Error('memory_guard_unavailable');
  return Number(match[1]) * 1024;
}
const textFlag = (json: string | null) => {
  try { return JSON.parse(json || '{}').preserveText === true; } catch { return false; }
};
async function inventory(enqueue: boolean) {
  const sources = new Map<string, { source: string; preserveText: boolean; context: HdRequestContext }>();
  const owners = await prisma.user.findMany({ where: { status: 'active' }, select: { id: true } });
  const activeImageAssets = await prisma.asset.count({ where: { status: 'active', type: 'image' } });
  const assets = await prisma.asset.findMany({ where: { status: 'active', type: 'image', owner_id: { in: owners.map(owner => owner.id) } },
    orderBy: [{ created_at: 'asc' }, { id: 'asc' }], select: { id: true, owner_id: true, original_url: true, metadata_json: true } });
  const refs = await prisma.referenceImage.findMany({ where: { status: 'active', asset_id: null, owner: { status: 'active' }, album: { status: 'active' } }, orderBy: [{ created_at: 'asc' }, { id: 'asc' }], select: { id: true, owner_user_id: true, url: true } });
  const remoteSources = new Set<string>();
  let unavailable = 0;
  for (const item of [...assets.map(a => ({ source: a.original_url, preserveText: textFlag(a.metadata_json), context: { owner: { kind: 'asset' as const, id: a.id, ownerId: a.owner_id } } })), ...refs.map(r => ({ source: r.url, preserveText: false, context: { owner: { kind: 'reference' as const, id: r.id, ownerId: r.owner_user_id } } }))]) {
    try {
      const local = await hdSource(item.source);
      if (!local) { remoteSources.add(item.source); continue; }
      const prior = sources.get(local.file);
      sources.set(local.file, { ...item, context: prior?.context || item.context, preserveText: item.preserveText || Boolean(prior?.preserveText) });
    } catch (error) { if (!hdSourceIsolationReason(error)) throw error; unavailable++; }
  }
  const result = { batch, capturedAt: new Date().toISOString(), uniqueLocalOriginals: sources.size, totalBytes: 0,
    types: {} as Record<string, number>, eligible: 0, cacheHits: 0, skipped: 0, reasons: {} as Record<string, number>,
    remoteVersionUnknown: remoteSources.size, unavailable, excludedInactiveOrMissingOwner: activeImageAssets - assets.length, mount: await fs.realpath(path.join(process.cwd(), 'storage')),
    capacity: await hdCapacity(), jobs: [] as string[] };
  const existing = new Map((await listHdJobs()).map(j => [j.source, j]));
  for (const item of Array.from(sources.values())) {
    try {
      const input = (await hdSource(item.source))!;
      result.totalBytes += input.size;
      const meta = await sharp(input.file, { animated: true, limitInputPixels: false }).metadata();
      result.types[meta.format || 'unknown'] = (result.types[meta.format || 'unknown'] || 0) + 1;
      const reason = hdEligibility(meta);
      if (reason) { result.skipped++; result.reasons[reason] = (result.reasons[reason] || 0) + 1; }
      else result.eligible++;
      const cached = existing.get(item.source);
      if (cached?.status === 'ready' && cached.version === input.version && cached.preserveText === item.preserveText) result.cacheHits++;
      if (enqueue) { const job = await requestHd(item.source, 3, item.preserveText, batch, item.context); if (job) result.jobs.push(job.key); }
    } catch (error) { if (!hdSourceIsolationReason(error)) throw error; result.skipped++; result.reasons.unreadable = (result.reasons.unreadable || 0) + 1; }
  }
  if (enqueue) await atomicHdJson(path.join(hdDirectory(), `${batch}.inventory.json`), result);
  return result;
}
async function main() {
  if (mode === 'pause') { await setHdControl(true, 'operator_pause'); console.log(JSON.stringify(await hdStatus())); return; }
  if (mode === 'resume' || mode === 'recheck') {
    const observed = await hdControl();
    const result = await recheckHdResources({ expectedToken: observed.token, allowManualResume: mode === 'resume' });
    if (result.conflict) throw new Error('hd_control_conflict');
    console.log(JSON.stringify(await hdStatus())); return;
  }
  if (mode === 'retry') { await retryFailedHd(); console.log(JSON.stringify(await hdStatus())); return; }
  if (mode === 'retry-key' || mode === 'process-key') {
    const key = process.argv[3], version = process.argv[4];
    if (!key || !/^[a-f0-9]{64}$/.test(key) || !version || process.argv.length !== 5) throw new Error('invalid_hd_targeted_arguments');
    if (mode === 'retry-key') {
      const job = await retryHdKey(key, version);
      if (!job) throw new Error('hd_targeted_lease_busy');
    } else {
      sharp.concurrency(2);
      if (os.loadavg()[0] > Math.max(4, os.cpus().length * 1.5) || await availableMemory() < 1024 * 1024 * 1024) throw new Error('hd_targeted_load_guard');
      // Caller must hold storage/hd-worker.lock via flock --no-fork after naturally stopping
      // the old worker. Remain paused: one explicit key is the entire work budget.
      if (await processHdJob(key, version) === null) throw new Error('hd_targeted_lease_busy');
    }
    const job = await readHdJob(key);
    console.log(JSON.stringify({ key, status: job?.status, reason: job?.reason, attempts: job?.attempts,
      attemptLimit: job?.attemptLimit, integrity: job?.integrity, control: await hdControl() }));
    if (mode === 'process-key' && job?.status !== 'ready') process.exitCode = 1;
    return;
  }
  if (mode === 'inventory' || mode === 'enqueue-old') {
    if (mode === 'enqueue-old' && (!(await hdCapacity()).safe || (await hdControl()).paused)) throw new Error('batch_paused_or_capacity_guard');
    const result = await inventory(mode === 'enqueue-old');
    // Output counts only. Source paths and queue keys remain in the private manifest.
    console.log(JSON.stringify({ ...result, jobs: undefined })); return;
  }
  if (mode !== 'worker') { console.log(JSON.stringify(await hdStatus())); return; }
  await assertHdDirectoryAccess();
  await assertHdWorkerLock();
  let stopping = false;
  let fatal: Error | null = null;
  let shutdown: Promise<void> | undefined;
  const stop = () => {
    stopping = true;
    shutdown ||= stopHdImageProcessors().catch(error => { fatal ||= error instanceof Error ? error : new Error('hd_child_exit_unknown'); });
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  const fairnessCheckpoint = path.join(hdDirectory(), 'fairness.json');
  let fairness: HdFairnessState = await fs.readFile(fairnessCheckpoint, 'utf8').then(text => {
    const state = JSON.parse(text);
    if (state.protocol === 'hd-fairness-v2') {
      if (!Number.isInteger(state.consecutiveViewer) || state.consecutiveViewer < 0 || state.consecutiveViewer > 2
        || !Number.isInteger(state.consecutiveForeground) || state.consecutiveForeground < 0 || state.consecutiveForeground > 4) throw new Error('invalid_hd_fairness_checkpoint');
      return { consecutiveViewer: state.consecutiveViewer, consecutiveForeground: state.consecutiveForeground };
    }
    if (!Number.isInteger(state.consecutiveNew) || state.consecutiveNew < 0 || state.consecutiveNew > 4) throw new Error('invalid_hd_fairness_checkpoint');
    return { consecutiveViewer: 0, consecutiveForeground: state.consecutiveNew };
  }).catch(error => { if (error.code === 'ENOENT') return { consecutiveViewer: 0, consecutiveForeground: 0 }; throw error; });
  await seedHdSchedulerFairness(fairness);
  await readHdDiscoveryCheckpoint();
  let lastDiscoveryAt = 0;
  const wait = () => new Promise(resolve => setTimeout(resolve, HD_RESOURCE_POLICY.minimumCheckMs));
  const fail = async (error: unknown, phase: string) => {
    fatal ||= error instanceof Error ? error : new Error('hd_worker_failed');
    Object.assign(fatal, { hdWorkerPhase: phase });
    stop(); await shutdown;
  };
  // Exactly one maintenance loop performs discoveries. It remains responsive
  // while the encoder awaits an isolated process, under the same global flock.
  const maintain = async () => {
    try {
      while (!stopping) {
        let control = await hdControl();
        const legacy = control.state === 'hard_pause' && control.reason === 'load_guard';
        if (legacy && (!control.wait || Date.parse(control.wait.nextCheckAt) <= Date.now())
          || control.state === 'resource_wait' && Date.parse(control.wait!.nextCheckAt) <= Date.now()) {
          control = (await recheckHdResources({ expectedToken: control.token })).control;
        }
        if (['active', 'resource_wait'].includes(control.state) && Date.now() - lastDiscoveryAt >= HD_RESOURCE_POLICY.discoveryIntervalMs) {
          await discoverHdBatch(() => stopping);
          lastDiscoveryAt = Date.now();
        }
        if (!stopping) await wait();
      }
    } catch (error) { await fail(error, 'maintenance'); }
  };
  const encode = async () => {
    const contentionUntil = new Map<string, number>();
    let ownerRetryAt = 0, ownerFailures = 0;
    try {
      while (!stopping) {
        let control = await hdControl();
        if (control.state === 'active') {
          const clock = Date.now();
          if (clock < ownerRetryAt) { await wait(); continue; }
          for (const [key, until] of Array.from(contentionUntil)) if (until <= clock) contentionUntil.delete(key);
          let job: Awaited<ReturnType<typeof claimHdScheduledJob>>;
          try {
            job = await claimHdScheduledJob(await listHdJobs(), new Set(contentionUntil.keys()), clock);
            ownerFailures = 0;
          } catch (error) {
            if (!(error instanceof Error) || error.message !== 'hd_scheduler_owner_unavailable') throw error;
            // A failed authoritative lookup cannot manufacture a legacy owner,
            // consume a turn or lose a durable registration. Retry quietly.
            ownerRetryAt = clock + Math.min(60000, 5000 * 2 ** Math.min(ownerFailures++, 4));
            await wait(); continue;
          }
          if (job) {
            // Empty queues never enter resource_wait. Only actual due work
            // takes the existing fresh resource-admission path.
            control = (await recheckHdResources({ expectedToken: control.token })).control;
            if (control.state !== 'active' || stopping) { if (!stopping) await wait(); continue; }
            let result;
            try { result = await processHdJob(job.key, undefined, { recoverInterrupted: job.status === 'running' }); }
            finally { await finishHdScheduledClaim(await readHdJob(job.key), job.key); }
            if (result === null) {
              // A known live lease is contention. It neither consumes an
              // attempt nor pauses the queue; another due key may proceed.
              contentionUntil.set(job.key, Date.now() + HD_RESOURCE_POLICY.minimumCheckMs);
              continue;
            }
            const after = await readHdJob(job.key);
            const completed = after?.attemptHistory?.[after.attemptHistory.length - 1];
            const scheduled = await readHdScheduler();
            fairness = { consecutiveViewer: scheduled.consecutiveViewer, consecutiveForeground: scheduled.consecutiveForeground };
            await atomicHdJson(fairnessCheckpoint, { protocol: 'hd-fairness-v2', ...fairness, updatedAt: completed?.finishedAt || new Date().toISOString() });
            continue;
          }
        }
        if (!stopping) await wait();
      }
    } catch (error) { await fail(error, 'encoding'); }
  };
  await Promise.all([maintain(), encode()]);
  await shutdown;
  process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
  if (fatal) throw fatal;
}
main().catch(async error => {
  const phase = (error as Error & { hdWorkerPhase?: string })?.hdWorkerPhase || 'startup';
  const diagnostic = hdWorkerFailureSummary(error, phase);
  if (mode === 'worker') {
    try { await recordHdWorkerFailure(error, phase); }
    catch (writeError) {
      // A failed storage/control write is evidence, never silently swallowed.
      console.error(JSON.stringify({ error: 'hd_worker_failure_record_failed', original: diagnostic.code, storage: hdWorkerFailureSummary(writeError).code }));
    }
  }
  console.error(JSON.stringify({ error: 'hd_worker_failed', diagnostic }));
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
