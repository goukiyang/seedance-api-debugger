import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { defaultStudioModuleId, validStudioModuleId } from './modules';
import { studioResultVersion, type StudioAttentionSnapshot } from './result-attention';
import { studioTemplateTaskWhere } from './task-visibility';

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

async function visibleResults(viewerId: string, moduleId?: string) {
  const modules = await prisma.imageStudioModule.findMany({ where: { owner_id: viewerId }, select: { id: true } });
  const allowed = new Set([defaultStudioModuleId(viewerId), ...modules.map(item => item.id)]);
  if (moduleId && !allowed.has(moduleId)) throw new Error('模板不存在或不可访问');
  const tasks = await prisma.imageStudioTask.findMany({
    where: { AND: [moduleId ? studioTemplateTaskWhere(viewerId, moduleId) : { OR: Array.from(allowed, id => studioTemplateTaskWhere(viewerId, id)) },
      { status: 'succeeded', asset_id: { not: null }, finished_at: { not: null } }] },
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
  const files = (await fs.readdir(dir)).filter(file => /^(?:seen-)?[a-f0-9]{64}\.json$/.test(file));
  return { seen: new Set<string>([...baseline.versions, ...files.map(file => file.replace(/^seen-/, '').slice(0, -5))]), revision: files.length + 1 };
}

export async function studioTemplateEntrySnapshot(viewerId: string, moduleId: string) {
  if (!validStudioModuleId(moduleId, viewerId)) throw new Error('模板编号无效');
  const startedAt = Date.now();
  const { allowed, results } = await visibleResults(viewerId);
  if (!allowed.has(moduleId)) throw new Error('模板不存在或不可访问');
  await readReceipts(viewerId, results.filter(item => item.completedAt <= startedAt).map(item => item.version));
  // Content-addressed, immutable snapshots are reused on repeat entry. They never include later completions.
  const snapshot = { schemaVersion: 1, moduleId, versions: results.filter(item => item.moduleId === moduleId && item.completedAt <= startedAt).map(item => hash(item.version)).sort() };
  const token = hash(JSON.stringify(snapshot));
  await publishReceipt(path.join(directory(viewerId), `entry-${token}.json`), snapshot);
  return token;
}

export async function confirmStudioTemplateEntry(viewerId: string, moduleId: unknown, token: unknown) {
  if (!validStudioModuleId(moduleId, viewerId) || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new Error('模板提醒参数无效');
  const snapshot = JSON.parse(await fs.readFile(path.join(directory(viewerId), `entry-${token}.json`), 'utf8'));
  if (snapshot?.schemaVersion !== 1 || snapshot.moduleId !== moduleId || !Array.isArray(snapshot.versions)
    || snapshot.versions.some((item: unknown) => typeof item !== 'string' || !/^[a-f0-9]{64}$/.test(item))
    || hash(JSON.stringify(snapshot)) !== token) throw new Error('模板范围已失效，请重新打开');
  const { allowed, results } = await visibleResults(viewerId);
  if (!allowed.has(moduleId)) throw new Error('模板不存在或不可访问');
  const receipts = await readReceipts(viewerId, results.map(item => item.version));
  const captured = new Set<string>(snapshot.versions);
  // Recheck current visibility; only this server-issued set can acknowledge template attention.
  const observed = results.filter(item => item.moduleId === moduleId && captured.has(hash(item.version)) && !receipts.seen.has(hash(item.version)));
  for (const item of observed) await publishReceipt(path.join(directory(viewerId), `seen-${hash(item.version)}.json`),
    { schemaVersion: 1, moduleId, version: item.version, operation: 'enter_template', seenAt: new Date().toISOString() });
  return studioAttentionSnapshot(viewerId);
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
