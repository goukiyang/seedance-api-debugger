import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { hdReadonlyDb as prisma } from '../src/lib/media/hd-readonly-db';
import { atomicHdJson, hdCapacity, hdControl, hdDirectory, hdEligibility, hdSource, hdStatus, listHdJobs, processHdJob, readHdJob, recheckHdResources, requestHd, retryFailedHd, retryHdKey, selectHdJob, setHdControl } from '../src/lib/media/hd-derivatives';
import { HD_RESOURCE_POLICY } from '../src/lib/media/hd-resource-state';
import { advanceHdDiscovery, commitHdDiscoveryItem, hdSourceIsolationReason, readHdDiscoveryCheckpoint, retryHdDiscoveryIsolations, withHdDiscovery } from '../src/lib/media/hd-discovery';

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
  const sources = new Map<string, { source: string; preserveText: boolean }>();
  const owners = await prisma.user.findMany({ where: { status: 'active' }, select: { id: true } });
  const activeImageAssets = await prisma.asset.count({ where: { status: 'active', type: 'image' } });
  const assets = await prisma.asset.findMany({ where: { status: 'active', type: 'image', owner_id: { in: owners.map(owner => owner.id) } },
    select: { original_url: true, metadata_json: true } });
  const refs = await prisma.referenceImage.findMany({ where: { status: 'active', asset_id: null, owner: { status: 'active' }, album: { status: 'active' } }, select: { url: true } });
  const remoteSources = new Set<string>();
  let unavailable = 0;
  for (const item of [...assets.map(a => ({ source: a.original_url, preserveText: textFlag(a.metadata_json) })), ...refs.map(r => ({ source: r.url, preserveText: false }))]) {
    try {
      const local = await hdSource(item.source);
      if (!local) { remoteSources.add(item.source); continue; }
      const prior = sources.get(local.file);
      sources.set(local.file, { ...item, preserveText: item.preserveText || Boolean(prior?.preserveText) });
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
      if (enqueue) { const job = await requestHd(item.source, 3, item.preserveText, batch); if (job) result.jobs.push(job.key); }
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
  sharp.concurrency(2);
  let stopping = false;
  process.on('SIGTERM', () => { stopping = true; });
  process.on('SIGINT', () => { stopping = true; });
  const fairnessCheckpoint = path.join(hdDirectory(), 'fairness.json');
  let consecutiveNew = await fs.readFile(fairnessCheckpoint, 'utf8').then(text => {
    const state = JSON.parse(text);
    if (!Number.isInteger(state.consecutiveNew) || state.consecutiveNew < 0 || state.consecutiveNew > 4) throw new Error('invalid_hd_fairness_checkpoint');
    return state.consecutiveNew as number;
  }).catch(error => { if (error.code === 'ENOENT') return 0; throw error; });
  await readHdDiscoveryCheckpoint();
  let lastDiscoveryAt = 0;
  while (!stopping) {
    let control = await hdControl();
    const legacyLoad = control.state === 'hard_pause' && control.reason === 'load_guard';
    if ((legacyLoad && (!control.wait || Date.parse(control.wait.nextCheckAt) <= Date.now()))
      || (control.state === 'resource_wait' && Date.parse(control.wait!.nextCheckAt) <= Date.now())) {
      control = (await recheckHdResources({ expectedToken: control.token })).control;
    }
    if (control.state === 'active' || control.state === 'resource_wait') {
      if (Date.now() - lastDiscoveryAt >= HD_RESOURCE_POLICY.discoveryIntervalMs) {
        await withHdDiscovery(async () => {
          // Capacity and shared permissions are checked before discovery writes,
          // independently of CPU/memory wait. Discovery is bounded on both streams.
          if (!(await hdCapacity()).safe) { await setHdControl(true, 'capacity_guard'); return; }
          const captured = new Date();
          const checkpoint = await readHdDiscoveryCheckpoint();
          const assets = await prisma.asset.findMany({ where: { status: 'active', type: 'image', created_at: { lte: captured },
            OR: [{ created_at: { gt: new Date(checkpoint.assets.at) } }, { created_at: new Date(checkpoint.assets.at), id: { gt: checkpoint.assets.id } }] },
            orderBy: [{ created_at: 'asc' }, { id: 'asc' }], take: HD_RESOURCE_POLICY.discoveryLimit / 2,
            select: { id: true, created_at: true, original_url: true, metadata_json: true } });
          for (const asset of assets) {
            if (stopping || !['active', 'resource_wait'].includes((await hdControl()).state)) return;
            const result = await commitHdDiscoveryItem('assets', { at: asset.created_at.toISOString(), id: asset.id },
              { id: asset.id, source: asset.original_url, preserveText: textFlag(asset.metadata_json) });
            if (!result.durable) break;
          }
          const successes = await prisma.imageStudioTask.findMany({ where: { status: 'succeeded', deleted_at: null, asset_id: { not: null }, finished_at: { lte: captured },
            OR: [{ finished_at: { gt: new Date(checkpoint.tasks.at) } }, { finished_at: new Date(checkpoint.tasks.at), id: { gt: checkpoint.tasks.id } }] },
            orderBy: [{ finished_at: 'asc' }, { id: 'asc' }], take: HD_RESOURCE_POLICY.discoveryLimit / 2,
            select: { id: true, finished_at: true, asset_id: true } });
          for (const task of successes) {
            if (stopping || !['active', 'resource_wait'].includes((await hdControl()).state)) return;
            const asset = await prisma.asset.findFirst({ where: { id: task.asset_id!, status: 'active', type: 'image' },
              select: { id: true, original_url: true, metadata_json: true } });
            const cursor = { at: task.finished_at!.toISOString(), id: task.id };
            if (!asset) {
              // Record a durable, explicit exclusion before advancing this stream.
              await atomicHdJson(path.join(hdDirectory(), 'discovery-exclusions', `${task.id.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`),
                { taskId: task.id, assetId: task.asset_id, reason: 'inactive_or_missing', at: captured.toISOString() });
              await advanceHdDiscovery('tasks', cursor); continue;
            }
            const result = await commitHdDiscoveryItem('tasks', cursor, { id: asset.id, source: asset.original_url, preserveText: textFlag(asset.metadata_json) });
            if (!result.durable) break;
          }
          await retryHdDiscoveryIsolations(10);
        });
        lastDiscoveryAt = Date.now();
      }
      control = await hdControl();
      if (control.state === 'active' && !stopping) {
        const job = selectHdJob(await listHdJobs(), consecutiveNew, batch);
        if (job) {
          // Admission protects actual encoding work. An empty queue is idle,
          // not a resource pause caused by the previous encode or another service.
          control = (await recheckHdResources({ expectedToken: control.token })).control;
          if (control.state !== 'active' || stopping) {
            await new Promise(resolve => setTimeout(resolve, HD_RESOURCE_POLICY.minimumCheckMs));
            continue;
          }
          const previousAttempt = job.attemptHistory?.[job.attemptHistory.length - 1]?.startedAt;
          const result = await processHdJob(job.key);
          if (result === null) throw new Error('hd_lease_conflict');
          const after = await readHdJob(job.key);
          const completed = after?.attemptHistory?.[after.attemptHistory.length - 1];
          if (completed?.finishedAt && completed.startedAt !== previousAttempt) {
            consecutiveNew = job.batch === batch ? 0 : Math.min(4, consecutiveNew + 1);
            await atomicHdJson(fairnessCheckpoint, { consecutiveNew, updatedAt: completed.finishedAt });
          }
          continue;
        }
      }
    }
    await new Promise(resolve => setTimeout(resolve, HD_RESOURCE_POLICY.minimumCheckMs));
  }
}
main().catch(async error => { if (mode === 'worker') await setHdControl(true, 'worker_integrity_failure').catch(() => {}); console.error(error instanceof Error && /^(invalid_discovery_checkpoint|invalid_hd_fairness_checkpoint|batch_paused_or_capacity_guard|invalid_hd_manifest|invalid_hd_retry_target|invalid_hd_process_target|invalid_hd_targeted_arguments|hd_retry_source_changed|hd_retry_requires_failed|hd_targeted_requires_safe_pause|hd_targeted_requires_worker_lock|hd_targeted_requires_queued|hd_targeted_source_changed|hd_targeted_control_changed|hd_targeted_lease_busy|hd_targeted_load_guard)$/.test(error.message) ? error.message : 'hd_worker_failed'); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
