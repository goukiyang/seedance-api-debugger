import { createHash } from 'crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { IMAGE_RESOLUTION_OPTIONS } from '@/lib/image-generation/resolution';
import { IMAGE_STUDIO_MODELS, IMAGE_STUDIO_MODEL_RESOLUTION_OPTIONS, type ImageStudioModel } from './model-catalog';
import { getImageStudioSettings, saveImageStudioSettingsInTx, type ImageStudioSettings } from './settings';
import { parseStudioTemplateDefaults } from './template-defaults';
import type { ResolutionDelta, ResolutionEntry, ResolutionOperation, ResolutionReceipt } from './resolution-apply-types';

const PREFIX = 'studio-resolution-apply:v1:';
const MAX_TARGETS = 50000;
const CHUNK_SIZE = 200;
const CHUNK_BYTES = 128 * 1024;
const MAX_BYTES = 32 * 1024 * 1024;
const TERMINAL = new Set(['complete', 'partial', 'cancelled', 'restored']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Tx = Prisma.TransactionClient;
type Body = Record<string, unknown>;
export class ResolutionApplyError extends Error {
  constructor(message: string, public status = 409, public requestId?: string) { super(message); }
}
function fail(message: string, status = 409): never { throw new ResolutionApplyError(message, status); }
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function digest(value: unknown) { return createHash('sha256').update(stable(value)).digest('hex'); }
function encoded(value: unknown, limit = CHUNK_BYTES) {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > limit) fail('完整预览或收据超出安全容量，本次没有继续修改', 413);
  return json;
}
function base(owner: string, requestId: string) { return `${PREFIX}${owner}:${requestId}`; }
function activeKey(owner: string) { return `studio-resolution-active:v1:${owner}`; }
function validId(id: unknown): string {
  if (typeof id !== 'string' || !uuid.test(id)) fail('操作编号无效', 400);
  return id;
}
function supported(model: string, resolution: string) {
  return IMAGE_STUDIO_MODELS.includes(model as ImageStudioModel)
    && IMAGE_STUDIO_MODEL_RESOLUTION_OPTIONS[model as ImageStudioModel].includes(resolution as ResolutionOperation['resolution']);
}
async function admin(tx: Tx, owner: string) {
  const user = await tx.user.findUnique({ where: { id: owner }, select: { role: true, status: true, expires_at: true } });
  if (!user || user.role !== 'admin' || user.status !== 'active' || (user.expires_at && user.expires_at.getTime() <= Date.now())) fail('当前账号没有修改权限', 403);
}
export async function resolutionSettingsInput(raw: unknown, tx: Pick<Tx, 'platformSetting'>): Promise<ImageStudioSettings> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('设置内容无效', 400);
  const body = raw as Body;
  if (!Number.isInteger(body.revision) || Number(body.revision) < 0
    || (body.context !== undefined && (typeof body.context !== 'string' || body.context.length > 20000))
    || (body.model !== undefined && !IMAGE_STUDIO_MODELS.includes(body.model as ImageStudioModel))
    || (body.confirmContextClear !== undefined && typeof body.confirmContextClear !== 'boolean')) fail('设置内容无效', 400);
  const current = await getImageStudioSettings(tx);
  const prices = body.prices ?? current.prices;
  if (!prices || typeof prices !== 'object' || Array.isArray(prices)
    || IMAGE_STUDIO_MODELS.some(model => {
      const price = (prices as Record<string, unknown>)[model];
      return price !== null && (!Number.isInteger(price) || Number(price) < 0 || Number(price) > 100000);
    })) fail('积分规则无效', 400);
  let templateDefaults;
  try { templateDefaults = parseStudioTemplateDefaults(body.templateDefaults ?? current.templateDefaults); }
  catch { fail('模板默认值无效', 400); }
  return { context: (body.context ?? current.context) as string, model: (body.model ?? current.model) as ImageStudioModel,
    revision: Number(body.revision), prices: prices as ImageStudioSettings['prices'], templateDefaults };
}
async function readHeader(tx: Tx, owner: string, requestId: string) {
  const row = await tx.platformSetting.findUnique({ where: { key: base(owner, requestId) } });
  if (!row) fail('没有找到本账号的操作记录', 404);
  const operation = JSON.parse(row.value_json) as ResolutionOperation;
  if (operation.schemaVersion !== 1 || operation.ownerId !== owner || operation.requestId !== requestId) fail('操作记录无法安全读取', 503);
  return { row, operation };
}
async function lockHeader(tx: Tx, row: { id: string; value_json: string }) {
  if (!(await tx.platformSetting.updateMany({ where: { id: row.id, value_json: row.value_json }, data: { value_json: row.value_json } })).count) fail('操作已在另一页面更新，请查询结果');
}
async function claim(tx: Tx, owner: string, requestId: string) {
  const key = activeKey(owner);
  const active = await tx.platformSetting.findUnique({ where: { key } });
  if (active) {
    const previous = JSON.parse(active.value_json) as { requestId: string | null };
    if (previous.requestId && previous.requestId !== requestId) {
      const previousHeader = await readHeader(tx, owner, previous.requestId);
      if (!TERMINAL.has(previousHeader.operation.phase)) throw new ResolutionApplyError('本账号还有未结束操作，请先查询或停止该操作', 409, previous.requestId);
    }
    if (!(await tx.platformSetting.updateMany({ where: { id: active.id, value_json: active.value_json }, data: { value_json: JSON.stringify({ requestId }), updated_by: owner } })).count) fail('操作入口已变化，请重新查询');
  } else await tx.platformSetting.create({ data: { key, value_json: JSON.stringify({ requestId }), updated_by: owner } });
}
async function saveHeader(tx: Tx, row: { id: string; value_json: string }, operation: ResolutionOperation) {
  operation.updatedAt = Date.now();
  if (!(await tx.platformSetting.updateMany({ where: { id: row.id, value_json: row.value_json }, data: { value_json: encoded(operation), updated_by: operation.ownerId } })).count) fail('操作已变化，请查询结果');
  if (TERMINAL.has(operation.phase)) {
    const active = await tx.platformSetting.findUnique({ where: { key: activeKey(operation.ownerId) } });
    if (active && JSON.parse(active.value_json).requestId === operation.requestId) await tx.platformSetting.updateMany({
      where: { id: active.id, value_json: active.value_json }, data: { value_json: JSON.stringify({ requestId: null }) },
    });
  }
}
async function receipt(tx: Tx, operation: ResolutionOperation, cursor = 0): Promise<ResolutionReceipt> {
  const index = Math.floor(cursor / CHUNK_SIZE);
  const row = index < operation.chunks ? await tx.platformSetting.findUnique({ where: { key: `${base(operation.ownerId, operation.requestId)}:chunk:${index}` } }) : null;
  const entries = row ? (JSON.parse(row.value_json) as ResolutionEntry[]).slice(cursor % CHUNK_SIZE) : [];
  const next = (index + 1) * CHUNK_SIZE;
  const restoring = operation.nextRestoreBatch > 0;
  const lastBatch = (restoring ? operation.nextRestoreBatch : operation.nextBatch) - 1;
  const replay = lastBatch >= 0 ? await tx.platformSetting.findUnique({ where: { key: `${base(operation.ownerId, operation.requestId)}:batch:${restoring ? 'restore' : 'apply'}:${lastBatch}` } }) : null;
  const deltas = new Map<string, ResolutionDelta>();
  for (const entry of entries) {
    if (entry.restoreResult === 'restored') deltas.set(entry.id, { id: entry.id, beforeRevision: entry.afterRevision!, revision: entry.restoredRevision!, resolution: entry.resolution });
    else if (entry.result === 'applied') deltas.set(entry.id, { id: entry.id, beforeRevision: entry.revision, revision: entry.afterRevision!, resolution: operation.resolution });
  }
  if (replay) for (const delta of JSON.parse(replay.value_json).deltas as ResolutionDelta[]) {
    if (!deltas.has(delta.id) || deltas.get(delta.id)!.revision < delta.revision) deltas.set(delta.id, delta);
  }
  return { operation, entries, nextCursor: next < operation.counts.total ? next : null, deltas: Array.from(deltas.values()) };
}
async function listHeaders(tx: Tx, owner: string) {
  const rows = await tx.platformSetting.findMany({ where: { key: { startsWith: `${PREFIX}${owner}:` }, NOT: [
    { key: { contains: ':chunk:' } }, { key: { contains: ':batch:' } },
  ] }, orderBy: { created_at: 'desc' }, take: 12 });
  return rows.map(row => JSON.parse(row.value_json) as ResolutionOperation);
}
export async function readResolutionOperations(owner: string, requestId?: string, cursor = 0, client: PrismaClient = prisma) {
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > MAX_TARGETS || cursor % CHUNK_SIZE) fail('预览页位置无效', 400);
  return client.$transaction(async tx => {
    await admin(tx, owner);
    if (!requestId) return { operations: await listHeaders(tx, owner) };
    return receipt(tx, (await readHeader(tx, owner, validId(requestId))).operation, cursor);
  });
}
export async function executeResolutionOperation(owner: string, body: Body, client: PrismaClient = prisma): Promise<ResolutionReceipt> {
  const requestId = validId(body.requestId);
  if (!['prepare', 'commit', 'apply', 'cancel', 'restore'].includes(String(body.action))) fail('操作类型无效', 400);
  return client.$transaction(async tx => {
    await admin(tx, owner);
    const key = base(owner, requestId);
    if (body.action === 'prepare') {
      const input = await resolutionSettingsInput(body.settings, tx);
      const resolution = input.templateDefaults!.resolution;
      if (!IMAGE_RESOLUTION_OPTIONS.includes(resolution)) fail('分辨率无效', 400);
      if (!Array.isArray(body.excludeIds) || body.excludeIds.length > MAX_TARGETS || body.excludeIds.some(id => typeof id !== 'string' || id.length > 200)) fail('草稿排除清单无效', 400);
      const excludeIds = Array.from(new Set(body.excludeIds as string[])).sort();
      const settingsDigest = digest({ input, excludeIds, confirmContextClear: (body.settings as Body).confirmContextClear === true });
      const existing = await tx.platformSetting.findUnique({ where: { key } });
      if (existing) {
        const operation = (await readHeader(tx, owner, requestId)).operation;
        if (operation.settingsDigest !== settingsDigest) fail('同一操作编号不能用于不同设置');
        return receipt(tx, operation);
      }
      const current = await getImageStudioSettings(tx);
      if (current.revision !== input.revision) fail('通用设置已变化，请重新读取后预览');
      const headers = await listHeaders(tx, owner);
      const terminal = headers.filter(header => TERMINAL.has(header.phase));
      if (terminal.length >= 10 || terminal.some(header => Date.now() - header.updatedAt > 30 * 86400000)) fail('操作记录已达到保留上限，请先明确归档旧收据；本次没有创建预览');
      await claim(tx, owner, requestId);
      const rows = await tx.imageStudioModule.findMany({ where: { owner_id: owner }, orderBy: [{ created_at: 'asc' }, { id: 'asc' }], take: MAX_TARGETS + 1,
        select: { id: true, name: true, model: true, resolution: true, revision: true, source_preset_id: true, reproduce_task_id: true } });
      if (rows.length > MAX_TARGETS) fail('完整模板清单超过安全容量，本次没有创建预览', 413);
      const excluded = new Set(excludeIds);
      const owned = new Set(rows.map(row => row.id));
      for (const id of excludeIds) if (!owned.has(id)) {
        // A dirty virtual default can become persisted in another tab before preview.
        // An absent virtual default is not a target; a real foreign row is never excluded.
        if (id !== `default-${owner}` || await tx.imageStudioModule.findUnique({ where: { id }, select: { owner_id: true } })) {
          fail('排除清单包含不属于本账号的模板，请重新预览', 400);
        }
      }
      const entries: ResolutionEntry[] = rows.map(row => {
        const effectiveModel = row.model || input.model;
        const bucket = row.reproduce_task_id ? 'reproduction' : excluded.has(row.id) ? 'dirty'
          : !supported(effectiveModel, resolution) ? 'unsupported' : row.resolution === resolution ? 'unchanged' : 'change';
        return { id: row.id, name: row.name, model: row.model, effectiveModel, resolution: row.resolution, revision: row.revision,
          sourcePresetId: row.source_preset_id, reproduceTaskId: row.reproduce_task_id, bucket };
      });
      const counts: ResolutionOperation['counts'] = { total: entries.length, change: 0, unchanged: 0, reproduction: 0, dirty: 0, unsupported: 0, applied: 0, conflicts: 0, restored: 0, restoreConflicts: 0 };
      entries.forEach(entry => counts[entry.bucket]++);
      const chunks = Array.from({ length: Math.ceil(entries.length / CHUNK_SIZE) }, (_, index) => encoded(entries.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE), 96 * 1024));
      // Reserve space for bounded per-target results and batch replay records.
      if (chunks.reduce((bytes, chunk) => bytes + Buffer.byteLength(chunk), 0) + entries.length * 300 > MAX_BYTES) fail('完整预览及恢复收据超出安全容量，本次没有创建预览', 413);
      const now = Date.now();
      const operation: ResolutionOperation = { schemaVersion: 1, ownerId: owner, requestId, resolution, expectedRevision: input.revision, settingsDigest,
        previewDigest: digest({ settingsDigest, entries }), phase: 'preview', operationRevision: 0, createdAt: now, updatedAt: now, expiresAt: now + 600000,
        counts, chunks: chunks.length, cursor: 0, restoreCursor: 0, nextBatch: 0, nextRestoreBatch: 0 };
      await tx.platformSetting.create({ data: { key, value_json: encoded(operation), updated_by: owner } });
      for (let index = 0; index < chunks.length; index++) await tx.platformSetting.create({ data: { key: `${key}:chunk:${index}`, value_json: chunks[index], updated_by: owner } });
      return receipt(tx, operation);
    }
    const { row, operation } = await readHeader(tx, owner, requestId);
    if (body.previewDigest !== operation.previewDigest) fail('预览内容不匹配，请重新查询');
    const batch = body.action === 'apply' || body.action === 'restore';
    const fingerprint = digest({ action: body.action, batch: body.batch, operationRevision: body.operationRevision, previewDigest: body.previewDigest });
    const batchKey = `${key}:batch:${body.action}:${body.batch}`;
    if (batch) {
      if (!Number.isInteger(body.batch) || Number(body.batch) < 0) fail('批次编号无效', 400);
      const replay = await tx.platformSetting.findUnique({ where: { key: batchKey } });
      if (replay) {
        const saved = JSON.parse(replay.value_json) as { fingerprint: string; deltas: ResolutionDelta[] };
        if (saved.fingerprint !== fingerprint) fail('同一批次不能使用不同内容');
        return { ...await receipt(tx, operation), deltas: saved.deltas };
      }
    }
    if (body.action === 'commit') {
      const input = await resolutionSettingsInput(body.settings, tx);
      if (digest({ input, excludeIds: Array.from(new Set(body.excludeIds as string[] ?? [])).sort(), confirmContextClear: (body.settings as Body).confirmContextClear === true }) !== operation.settingsDigest) fail('设置在预览后改变，请停止旧操作并重新预览');
      if (operation.globalRevision !== undefined) {
        const saved = await getImageStudioSettings(tx);
        if (saved.revision !== operation.globalRevision) fail('默认值在提交后又发生变化，请查询操作；不会覆盖新设置');
        return { ...await receipt(tx, operation), settings: saved };
      }
      if (operation.phase !== 'preview' || Date.now() > operation.expiresAt) fail('预览已过期或停止，请停止旧操作并重新预览');
    }
    if (body.operationRevision !== operation.operationRevision) fail('操作已在另一页面更新，请先查询结果');
    await lockHeader(tx, row);
    if (body.action === 'commit') {
      const input = await resolutionSettingsInput(body.settings, tx);
      const saved = await saveImageStudioSettingsInTx(tx, input, owner, { confirmContextClear: (body.settings as Body).confirmContextClear === true, skipUnchanged: true });
      if (!saved) fail('通用设置已在另一页面变化，本次没有修改模板');
      operation.globalRevision = saved.revision;
      operation.phase = operation.counts.change ? 'defaultConfirmed' : 'complete';
      operation.operationRevision++;
      await saveHeader(tx, row, operation);
      return { ...await receipt(tx, operation), settings: saved };
    }
    if (body.action === 'cancel') {
      if (operation.phase === 'restoring') fail('正在恢复，请先完成或查询恢复结果');
      operation.phase = 'cancelled'; operation.operationRevision++;
      await saveHeader(tx, row, operation);
      return receipt(tx, operation);
    }
    const restoring = body.action === 'restore';
    if (restoring) {
      if (!operation.counts.applied || operation.phase === 'preview' || operation.phase === 'restored') fail('当前没有可恢复的已应用条目');
      if (Number(body.batch) !== operation.nextRestoreBatch) fail('恢复批次不匹配，请查询结果');
      await claim(tx, owner, requestId);
    } else {
      if (!['defaultConfirmed', 'applying'].includes(operation.phase) || Number(body.batch) !== operation.nextBatch) fail('当前不能继续旧批次，请查询或停止操作');
      const current = await getImageStudioSettings(tx);
      if (current.revision !== operation.globalRevision) {
        operation.phase = 'paused'; operation.operationRevision++;
        await saveHeader(tx, row, operation);
        return receipt(tx, operation);
      }
      await claim(tx, owner, requestId);
    }
    const currentSettings = await getImageStudioSettings(tx);
    let cursor = restoring ? operation.restoreCursor : operation.cursor;
    let processed = 0;
    const changedChunks = new Map<number, { row: { id: string; value_json: string }; entries: ResolutionEntry[] }>();
    const deltas: ResolutionDelta[] = [];
    while (cursor < operation.counts.total && processed < 20) {
      const index = Math.floor(cursor / CHUNK_SIZE);
      let chunk = changedChunks.get(index);
      if (!chunk) {
        const chunkRow = await tx.platformSetting.findUnique({ where: { key: `${key}:chunk:${index}` } });
        if (!chunkRow) fail('完整收据缺少分片，已停止修改', 503);
        chunk = { row: chunkRow, entries: JSON.parse(chunkRow.value_json) as ResolutionEntry[] };
        changedChunks.set(index, chunk);
      }
      const entry = chunk.entries[cursor % CHUNK_SIZE]; cursor++;
      if (!entry || entry.bucket !== 'change' || (restoring ? entry.result !== 'applied' || Boolean(entry.restoreResult) : Boolean(entry.result))) continue;
      processed++;
      const expectedRevision = restoring ? entry.afterRevision! : entry.revision;
      const expectedResolution = restoring ? operation.resolution : entry.resolution;
      const effectiveModel = entry.model || currentSettings.model;
      const target = restoring ? entry.resolution : operation.resolution;
      const valid = supported(effectiveModel, target) && (restoring || effectiveModel === entry.effectiveModel);
      const updated = valid ? await tx.imageStudioModule.updateMany({ where: { id: entry.id, owner_id: owner, revision: expectedRevision,
        resolution: expectedResolution, model: entry.model, source_preset_id: entry.sourcePresetId, reproduce_task_id: entry.reproduceTaskId },
        data: { resolution: target, revision: { increment: 1 }, updated_at: new Date() } }) : { count: 0 };
      if (restoring) {
        entry.restoreResult = updated.count ? 'restored' : 'conflict';
        if (updated.count) { entry.restoredRevision = expectedRevision + 1; operation.counts.restored++; }
        else { entry.restoreReason = valid ? '模板已被修改、删除或绑定发生变化' : '当前模型不支持原分辨率'; operation.counts.restoreConflicts++; }
      } else {
        entry.result = updated.count ? 'applied' : 'conflict';
        if (updated.count) { entry.afterRevision = expectedRevision + 1; operation.counts.applied++; }
        else { entry.reason = valid ? '模板已被修改、删除或绑定发生变化' : '模型支持范围已变化'; operation.counts.conflicts++; }
      }
      if (updated.count) deltas.push({ id: entry.id, beforeRevision: expectedRevision, revision: expectedRevision + 1, resolution: target });
    }
    for (const chunk of Array.from(changedChunks.values())) if (!(await tx.platformSetting.updateMany({ where: { id: chunk.row.id, value_json: chunk.row.value_json }, data: { value_json: encoded(chunk.entries), updated_by: owner } })).count) fail('收据已变化，本批次没有继续提交');
    if (restoring) {
      operation.restoreCursor = cursor; operation.nextRestoreBatch++;
      operation.phase = cursor >= operation.counts.total ? 'restored' : 'restoring';
    } else {
      operation.cursor = cursor; operation.nextBatch++;
      operation.phase = cursor >= operation.counts.total ? (operation.counts.conflicts ? 'partial' : 'complete') : 'applying';
    }
    operation.operationRevision++;
    await saveHeader(tx, row, operation);
    await tx.platformSetting.create({ data: { key: batchKey, value_json: encoded({ fingerprint, deltas }), updated_by: owner } });
    return { ...await receipt(tx, operation), deltas };
  }, { maxWait: 5000, timeout: 20000 });
}
