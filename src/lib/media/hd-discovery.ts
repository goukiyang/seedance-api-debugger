import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertHdDirectoryAccess, atomicHdJson, hdCapacity, hdControl, hdDirectory, requestHd, withHdLease } from './hd-derivatives';
import { HD_RESOURCE_POLICY } from './hd-resource-state';
import { hdReadonlyDb } from './hd-readonly-db';
import { studioOutputTaskWhere, studioTaskHasViewableOutput } from '../image-studio/dimension-mismatch';

export type HdDiscoveryItem = { id: string; source: string; preserveText: boolean };
export type HdDiscoveryIsolation = HdDiscoveryItem & {
  key: string; reason: 'source_missing' | 'source_unreadable' | 'remote_version_unknown';
  attempts: number; updatedAt: string; retryAt?: string; resolvedAt?: string;
};
export type HdDiscoveryCursor = { at: string; id: string };
export type HdDiscoveryCheckpoint = { assets: HdDiscoveryCursor; tasks: HdDiscoveryCursor };
export type HdDiscoveryStatus = { checkedAt: string; current: boolean | null };
export const hdIsolationDirectory = () => path.join(hdDirectory(), 'discovery-isolation');
export function hdSourceIsolationReason(error: unknown): 'source_missing' | 'source_unreadable' | null {
  const message = error instanceof Error ? error.message : '';
  return message === 'source_missing' || message === 'source_unreadable' ? message : null;
}
export async function readHdDiscoveryCheckpoint(clock = Date.now): Promise<HdDiscoveryCheckpoint> {
  try {
    const value = JSON.parse(await fs.readFile(path.join(hdDirectory(), 'discovery.json'), 'utf8'));
    // Revisit the old boundary to include same-timestamp assets. Identity/version
    // registration reuses ready manifests, so overlap does not encode them again.
    if (typeof value.since === 'string' && !value.assets && !value.tasks) {
      const time = Date.parse(value.since);
      if (!Number.isFinite(time)) throw new Error('invalid_discovery_checkpoint');
      return { assets: { at: new Date(time - 1000).toISOString(), id: '' }, tasks: { at: new Date(time - 1000).toISOString(), id: '' } };
    }
    for (const cursor of [value.assets, value.tasks]) if (!cursor || !Number.isFinite(Date.parse(cursor.at)) || typeof cursor.id !== 'string') throw new Error('invalid_discovery_checkpoint');
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const at = new Date(clock() - 24 * 60 * 60 * 1000).toISOString();
    return { assets: { at, id: '' }, tasks: { at, id: '' } };
  }
}
export async function hdDiscoveryStatus(checkpoint: HdDiscoveryCheckpoint | null): Promise<HdDiscoveryStatus> {
  const checkedAt = new Date();
  if (!checkpoint) return { checkedAt: checkedAt.toISOString(), current: null };
  try {
    const [asset, task] = await Promise.all([
      hdReadonlyDb.asset.findFirst({ where: { status: 'active', type: 'image', created_at: { lte: checkedAt },
        OR: [{ created_at: { gt: new Date(checkpoint.assets.at) } }, { created_at: new Date(checkpoint.assets.at), id: { gt: checkpoint.assets.id } }] }, select: { id: true } }),
      hdReadonlyDb.imageStudioTask.findFirst({ where: { AND: [studioOutputTaskWhere,
        { deleted_at: null, asset_id: { not: null }, finished_at: { lte: checkedAt },
          OR: [{ finished_at: { gt: new Date(checkpoint.tasks.at) } }, { finished_at: new Date(checkpoint.tasks.at), id: { gt: checkpoint.tasks.id } }] }] }, select: { id: true } }),
    ]);
    // A moving cursor means the queue snapshot and discovery view may straddle a
    // registration. Report unknown until the next read instead of claiming idle.
    const after = await readHdDiscoveryCheckpoint();
    const same = after.assets.at === checkpoint.assets.at && after.assets.id === checkpoint.assets.id
      && after.tasks.at === checkpoint.tasks.at && after.tasks.id === checkpoint.tasks.id;
    return { checkedAt: checkedAt.toISOString(), current: same ? !asset && !task : null };
  } catch {
    return { checkedAt: checkedAt.toISOString(), current: null };
  }
}
export async function listHdIsolations(): Promise<HdDiscoveryIsolation[]> {
  const names = await fs.readdir(hdIsolationDirectory()).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  const result: HdDiscoveryIsolation[] = [];
  for (const name of names.filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
    const value = JSON.parse(await fs.readFile(path.join(hdIsolationDirectory(), name), 'utf8')) as HdDiscoveryIsolation;
    if (value.key !== name.slice(0, -5) || typeof value.source !== 'string' || typeof value.id !== 'string'
      || !Number.isInteger(value.attempts) || value.attempts < 0 || !Number.isFinite(Date.parse(value.updatedAt))
      || !['source_missing', 'source_unreadable', 'remote_version_unknown'].includes(value.reason)
      || (value.retryAt && !Number.isFinite(Date.parse(value.retryAt)))) throw new Error('invalid_hd_isolation');
    result.push(value);
  }
  return result;
}
export async function registerHdDiscovery(item: HdDiscoveryItem, options: {
  clock?: () => number; request?: typeof requestHd;
} = {}) {
  const clock = options.clock || Date.now;
  const request = options.request || requestHd;
  const key = createHash('sha256').update(JSON.stringify({ id: item.id, source: item.source })).digest('hex');
  const file = path.join(hdIsolationDirectory(), `${key}.json`);
  const previous = await fs.readFile(file, 'utf8').then(text => JSON.parse(text) as HdDiscoveryIsolation).catch(error => {
    if (error.code === 'ENOENT') return null; throw error;
  });
  if (previous && !previous.resolvedAt && (!previous.retryAt || Date.parse(previous.retryAt) > clock())) return { durable: true, isolated: true };
  try {
    const job = await request(item.source, 0, item.preserveText);
    if (job) {
      if (previous) await atomicHdJson(file, { ...previous, resolvedAt: new Date(clock()).toISOString(), retryAt: undefined });
      return { durable: true, isolated: false, job };
    }
    await atomicHdJson(file, { ...item, key, reason: 'remote_version_unknown', attempts: 0, updatedAt: new Date(clock()).toISOString() });
    return { durable: true, isolated: true };
  } catch (error) {
    if (error instanceof Error && error.message === 'hd_registration_pending') return { durable: false, isolated: false };
    const reason = hdSourceIsolationReason(error);
    if (!reason) throw error; // DB, shared storage, lease and integrity failures remain global.
    const attempts = (previous?.attempts || 0) + 1;
    const delay = [60_000, 5 * 60_000, 30 * 60_000][Math.min(attempts - 1, 2)];
    await atomicHdJson(file, { ...item, key, reason, attempts, updatedAt: new Date(clock()).toISOString(),
      ...(attempts < HD_RESOURCE_POLICY.isolationRetries ? { retryAt: new Date(clock() + delay).toISOString() } : {}) });
    return { durable: true, isolated: true };
  }
}
export async function advanceHdDiscovery(stream: 'assets' | 'tasks', cursor: HdDiscoveryCursor) {
  const checkpoint = await readHdDiscoveryCheckpoint();
  const previous = checkpoint[stream];
  if (Date.parse(cursor.at) < Date.parse(previous.at) || (cursor.at === previous.at && cursor.id < previous.id)) throw new Error('hd_discovery_cursor_conflict');
  await atomicHdJson(path.join(hdDirectory(), 'discovery.json'), { ...checkpoint, [stream]: cursor });
}
export async function commitHdDiscoveryItem(stream: 'assets' | 'tasks', cursor: HdDiscoveryCursor, item: HdDiscoveryItem,
  options: Parameters<typeof registerHdDiscovery>[1] = {}) {
  const outcome = await registerHdDiscovery(item, options);
  if (outcome.durable) await advanceHdDiscovery(stream, cursor);
  return outcome;
}
export async function retryHdDiscoveryIsolations(limit: number = HD_RESOURCE_POLICY.discoveryLimit) {
  let handled = 0;
  for (const item of await listHdIsolations()) {
    if (handled >= limit) break;
    if (!item.resolvedAt && item.retryAt && Date.parse(item.retryAt) <= Date.now()) { await registerHdDiscovery(item); handled++; }
  }
  return handled;
}
export async function withHdDiscovery<T>(action: () => Promise<T>) {
  return withHdLease('discovery', async () => {
    const state = await hdControl();
    if (state.state === 'hard_pause' || state.state === 'manual_pause') return null;
    return action();
  });
}

// One bounded scan is called only by the lock-owning supervisor. Keeping this
// separate from its encoder loop means slow Sharp work cannot delay discovery.
export async function discoverHdBatch(stopping: () => boolean = () => false) {
  return withHdDiscovery(async () => {
    await assertHdDirectoryAccess();
    if (!(await hdCapacity()).safe) throw new Error('capacity_guard');
    const captured = new Date();
    const checkpoint = await readHdDiscoveryCheckpoint();
    // Reserve ten opportunities for isolated originals, within the same total
    // 100-per-round budget, so a permanent new-asset stream cannot starve them.
    const isolationBudget = Math.min(10, HD_RESOURCE_POLICY.discoveryLimit);
    const streamLimit = Math.floor((HD_RESOURCE_POLICY.discoveryLimit - isolationBudget) / 2);
    const assets = await hdReadonlyDb.asset.findMany({ where: { status: 'active', type: 'image', created_at: { lte: captured },
      OR: [{ created_at: { gt: new Date(checkpoint.assets.at) } }, { created_at: new Date(checkpoint.assets.at), id: { gt: checkpoint.assets.id } }] },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }], take: streamLimit,
      select: { id: true, created_at: true, original_url: true, metadata_json: true } });
    const preserveText = (json: string | null) => { try { return JSON.parse(json || '{}').preserveText === true; } catch { return false; } };
    const allowed = async () => !stopping() && ['active', 'resource_wait'].includes((await hdControl()).state);
    for (const asset of assets) {
      if (!await allowed()) return;
      const outcome = await commitHdDiscoveryItem('assets', { at: asset.created_at.toISOString(), id: asset.id },
        { id: asset.id, source: asset.original_url, preserveText: preserveText(asset.metadata_json) });
      if (!outcome.durable) break;
    }
    const tasks = await hdReadonlyDb.imageStudioTask.findMany({ where: { AND: [studioOutputTaskWhere,
      { deleted_at: null, asset_id: { not: null }, finished_at: { lte: captured },
        OR: [{ finished_at: { gt: new Date(checkpoint.tasks.at) } }, { finished_at: new Date(checkpoint.tasks.at), id: { gt: checkpoint.tasks.id } }] }] },
      orderBy: [{ finished_at: 'asc' }, { id: 'asc' }], take: streamLimit,
      select: { id: true, status: true, usage_json: true, finished_at: true, asset_id: true } });
    for (const task of tasks) {
      if (!await allowed()) return;
      const cursor = { at: task.finished_at!.toISOString(), id: task.id };
      const asset = studioTaskHasViewableOutput(task) ? await hdReadonlyDb.asset.findFirst({
        where: { id: task.asset_id!, status: 'active', type: 'image' }, select: { id: true, original_url: true, metadata_json: true },
      }) : null;
      if (!asset) {
        await atomicHdJson(path.join(hdDirectory(), 'discovery-exclusions', task.id.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json'),
          { taskId: task.id, assetId: task.asset_id, reason: studioTaskHasViewableOutput(task) ? 'inactive_or_missing' : 'no_viewable_output', at: captured.toISOString() });
        await advanceHdDiscovery('tasks', cursor); continue;
      }
      const outcome = await commitHdDiscoveryItem('tasks', cursor, { id: asset.id, source: asset.original_url, preserveText: preserveText(asset.metadata_json) });
      if (!outcome.durable) break;
    }
    if (await allowed()) await retryHdDiscoveryIsolations(isolationBudget);
  });
}
