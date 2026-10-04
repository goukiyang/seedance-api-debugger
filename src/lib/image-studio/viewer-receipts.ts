import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { defaultStudioModuleId, validStudioModuleId } from './modules';
import { studioResultVersion, type StudioAttentionSnapshot } from './result-attention';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const directory = (viewerId: string) => path.join(process.cwd(), 'storage', 'studio-viewer-receipts', hash(viewerId));

// Immutable, exclusive publication avoids lost receipts across concurrent tabs/processes.
async function publishReceipt(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
    try { await fs.link(temporary, file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const folder = await fs.open(path.dirname(file), 'r');
    try { await folder.sync(); } finally { await folder.close(); }
  } finally { await fs.unlink(temporary).catch(() => {}); }
}

async function visibleResults(viewerId: string) {
  const modules = await prisma.imageStudioModule.findMany({ where: { owner_id: viewerId }, select: { id: true } });
  const allowed = new Set([defaultStudioModuleId(viewerId), ...modules.map(item => item.id)]);
  const tasks = await prisma.imageStudioTask.findMany({
    where: { owner_id: viewerId, status: 'succeeded', deleted_at: null, asset_id: { not: null }, finished_at: { not: null } },
    select: { id: true, module_id: true, asset_id: true, finished_at: true },
  });
  const assetIds = Array.from(new Set(tasks.filter(task => !task.module_id || allowed.has(task.module_id)).flatMap(task => task.asset_id ? [task.asset_id] : [])));
  const available = new Set<string>();
  for (let offset = 0; offset < assetIds.length; offset += 400) {
    const assets = await prisma.asset.findMany({ where: { id: { in: assetIds.slice(offset, offset + 400) }, owner_id: viewerId, status: 'active', type: 'image', original_url: { not: '' } }, select: { id: true } });
    assets.forEach(asset => available.add(asset.id));
  }
  return { allowed, results: tasks.flatMap(task => {
    if (!task.asset_id || !available.has(task.asset_id) || task.module_id && !allowed.has(task.module_id)) return [];
    const version = studioResultVersion({ id: task.id, status: 'succeeded', finishedAt: task.finished_at, asset: { id: task.asset_id } });
    return version ? [{ moduleId: task.module_id || defaultStudioModuleId(viewerId), version, completedAt: task.finished_at!.getTime() }] : [];
  }) };
}

async function readReceipts(viewerId: string, initialVersions: string[]) {
  const dir = directory(viewerId);
  const baselineFile = path.join(dir, 'baseline.json');
  try { await fs.access(baselineFile); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // Only the successful results in this first snapshot become the historical baseline.
    await publishReceipt(baselineFile, { schemaVersion: 1, versions: initialVersions.map(hash) });
  }
  const baseline = JSON.parse(await fs.readFile(baselineFile, 'utf8'));
  if (baseline?.schemaVersion !== 1 || !Array.isArray(baseline.versions) || baseline.versions.some((item: unknown) => typeof item !== 'string' || !/^[a-f0-9]{64}$/.test(item))) throw new Error('已读记录不可用');
  const files = (await fs.readdir(dir)).filter(file => /^[a-f0-9]{64}\.json$/.test(file));
  return { seen: new Set<string>([...baseline.versions, ...files.map(file => file.slice(0, -5))]), revision: files.length + 1 };
}

export async function studioAttentionSnapshot(viewerId: string): Promise<StudioAttentionSnapshot> {
  const startedAt = Date.now();
  const { results } = await visibleResults(viewerId);
  const receipts = await readReceipts(viewerId, results.filter(item => item.completedAt <= startedAt).map(item => item.version));
  return { viewerId, receiptRevision: receipts.revision, unreadModuleIds: Array.from(new Set(results.filter(item => !receipts.seen.has(hash(item.version))).map(item => item.moduleId))) };
}

export async function markStudioResultsViewed(viewerId: string, moduleId: unknown, versions: unknown) {
  if (!validStudioModuleId(moduleId, viewerId) || !Array.isArray(versions) || versions.length > 24 || versions.some(version => typeof version !== 'string' || version.length > 240)) throw new Error('已读参数无效');
  const { allowed, results } = await visibleResults(viewerId);
  if (!allowed.has(moduleId)) throw new Error('模板不存在或不可访问');
  await readReceipts(viewerId, results.map(item => item.version));
  const valid = new Set(results.filter(item => item.moduleId === moduleId).map(item => item.version));
  const observed = Array.from(new Set<string>(versions));
  if (observed.some(version => !valid.has(version))) throw new Error('结果已变化，请重新打开模板');
  await Promise.all(observed.map(version => publishReceipt(path.join(directory(viewerId), `${hash(version)}.json`), { schemaVersion: 1, moduleId, version, readAt: new Date().toISOString() })));
  return studioAttentionSnapshot(viewerId);
}
