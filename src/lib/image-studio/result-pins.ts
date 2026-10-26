import 'server-only';
import { createHash } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import type { Prisma } from '@prisma/client';
import type { SessionUser } from '@/lib/auth/session';
import { canUseCompanyTemplates, canViewStudioPreset } from './access';
import { studioPresetArchived } from './preset-lifecycle';
import { studioSharedBinding, type SharedStudioClient } from './shared-contract';
import { studioHiddenAssetUrls } from './protected-assets';
import type { StudioPinMutation, StudioPinState } from './result-pin-types';
import { studioOutputTaskWhere, studioTaskHasViewableOutput } from './dimension-mismatch';

export class StudioPinError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
type Pin = { taskId: string; assetId: string; ownerId: string; moduleId: string; pinnedAt: string };
type Document = { version: 1; presetId: string; revision: number; pins: Pin[];
  receipts: Array<{ id: string; fingerprint: string }> };
export const resultPinsKey = (presetId: string) => `studio_result_pins_v1:${presetId}`;
const indexKey = (assetId: string) => `studio_result_pin_asset_v1:${assetId}`;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9:_-]{1,160}$/.test(id);
const MAX_PINS = 200;
function decode(raw: string | undefined, presetId: string): Document {
  if (!raw) return { version: 1, presetId, revision: 0, pins: [], receipts: [] };
  try {
    const d = JSON.parse(raw);
    if (d.version !== 1 || d.presetId !== presetId || !Number.isSafeInteger(d.revision) || d.revision < 1
      || !Array.isArray(d.pins) || d.pins.length > MAX_PINS || !Array.isArray(d.receipts) || d.receipts.length > 128
      || d.pins.some((p: Pin) => !p || ![p.taskId, p.assetId, p.ownerId, p.moduleId].every(validId) || !Number.isFinite(Date.parse(p.pinnedAt)))
      || new Set(d.pins.map((p: Pin) => p.assetId)).size !== d.pins.length
      || d.receipts.some((r: Document['receipts'][number]) => !r || !validId(r.id) || !/^[a-f0-9]{64}$/.test(r.fingerprint))) throw new Error();
    return d;
  } catch { throw new StudioPinError('置顶记录暂时无法确认，请重试；原记录保留', 503); }
}
export async function studioPinScope(user: SessionUser, moduleId: string, db: SharedStudioClient = prisma) {
  if (user.status !== 'active' || user.expires_at && user.expires_at <= new Date() || !canUseCompanyTemplates(user) || !validId(moduleId)) throw new StudioPinError('无权访问模板', 403);
  const studioModule = await db.imageStudioModule.findFirst({ where: { id: moduleId, owner_id: user.id } });
  if (!studioModule) return null;
  const binding = await studioSharedBinding(user.id, moduleId, db);
  const presetId = binding?.presetId || studioModule.source_preset_id;
  if (!presetId || studioModule.source_preset_id !== presetId) return null;
  const preset = await db.imageStudioPreset.findUnique({ where: { id: presetId } });
  if (!preset || !preset.is_shared || !canViewStudioPreset(user, preset) || await studioPresetArchived(presetId, db)) return null;
  return { presetId, moduleId, binding };
}
export async function readStudioPinDocument(presetId: string, db: Pick<Prisma.TransactionClient, 'platformSetting'> = prisma) {
  const row = await db.platformSetting.findUnique({ where: { key: resultPinsKey(presetId) }, select: { value_json: true } });
  return { row, document: decode(row?.value_json, presetId) };
}
/** Every display and media/reaction request re-checks the source, task and protected-file ACL. */
export async function readableStudioPins(user: SessionUser, presetId: string, db: SharedStudioClient = prisma) {
  if (user.status !== 'active' || user.expires_at && user.expires_at <= new Date() || !canUseCompanyTemplates(user)) return null;
  const preset = await db.imageStudioPreset.findUnique({ where: { id: presetId } });
  if (!preset || !preset.is_shared || !canViewStudioPreset(user, preset) || await studioPresetArchived(presetId, db)) return null;
  const { document } = await readStudioPinDocument(presetId, db);
  const tasks = await db.imageStudioTask.findMany({ where: { id: { in: document.pins.map(p => p.taskId) },
    AND: [studioOutputTaskWhere], deleted_at: null }, select: { id: true, asset_id: true, owner_id: true, module_id: true,
      source_preset_id: true, created_at: true, status: true, usage_json: true } });
  const assets = await db.asset.findMany({ where: { id: { in: document.pins.map(p => p.assetId) },
    type: 'image', status: 'active' }, select: { id: true, owner_id: true, original_url: true, thumbnail_url: true,
      width: true, height: true, mime_type: true } });
  const hidden = new Set(await studioHiddenAssetUrls(user, db));
  const byTask = new Map(tasks.map(t => [t.id, t]));
  const byAsset = new Map(assets.map(a => [a.id, a]));
  const pins = document.pins.flatMap(pin => {
    const task = byTask.get(pin.taskId), asset = byAsset.get(pin.assetId);
    if (!task || !studioTaskHasViewableOutput(task) || !asset || task.asset_id !== pin.assetId || task.owner_id !== pin.ownerId || asset.owner_id !== pin.ownerId
      || task.module_id !== pin.moduleId || task.source_preset_id && task.source_preset_id !== presetId
      || hidden.has(asset.original_url) || asset.thumbnail_url && hidden.has(asset.thumbnail_url)) return [];
    return [{ ...pin, task, asset }];
  });
  return { document, pins };
}
export function studioPinState(presetId: string | null, revision = 0, assetIds: string[] = []): StudioPinState {
  return { presetId, revision, assetIds, ...(!presetId ? { disabledReason: '模板尚未共享，暂不能置顶给其他人' } : {}) };
}
export async function resolveStudioPinnedAsset(user: SessionUser, assetId: string) {
  const index = await prisma.platformSetting.findUnique({ where: { key: indexKey(assetId) }, select: { value_json: true } });
  if (!index) return null;
  let presetId: string;
  try { const parsed = JSON.parse(index.value_json); if (parsed.version !== 1 || !validId(parsed.presetId)) return null; presetId = parsed.presetId; }
  catch { return null; }
  const readable = await readableStudioPins(user, presetId);
  const pin = readable?.pins.find(p => p.assetId === assetId);
  return pin ? { ...pin, presetId } : null;
}
export async function mutateStudioPin(user: SessionUser, input: StudioPinMutation) {
  if (!input || input.viewerId !== user.id || ![input.moduleId, input.taskId, input.assetId, input.requestId].every(validId)
    || typeof input.active !== 'boolean' || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new StudioPinError('置顶参数无效，请刷新当前模板');
  }
  const fingerprint = digest([user.id, input.moduleId, input.taskId, input.assetId, input.active, input.expectedRevision]);
  return prisma.$transaction(async tx => {
    const scope = await studioPinScope(user, input.moduleId, tx);
    if (!scope) throw new StudioPinError('模板尚未共享或已不可用，不能更改置顶', 409);
    const { row, document } = await readStudioPinDocument(scope.presetId, tx);
    const previous = document.receipts.find(r => r.id === input.requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new StudioPinError('该操作编号已用于其他内容', 409);
      return { saved: true, replayed: true, revision: document.revision };
    }
    if (document.revision !== input.expectedRevision) throw new StudioPinError('置顶顺序已变化，请刷新后再操作', 409);
    const existing = document.pins.find(p => p.assetId === input.assetId);
    // Unpin remains possible after this owner's result is hidden; never remove a public album entry.
    if (!input.active && (!existing || existing.ownerId !== user.id || existing.taskId !== input.taskId)) throw new StudioPinError('只能取消本人结果的置顶', 403);
    if (input.active) {
      const task = await tx.imageStudioTask.findFirst({ where: { id: input.taskId, owner_id: user.id,
        module_id: input.moduleId, asset_id: input.assetId, AND: [studioOutputTaskWhere], deleted_at: null } });
      const asset = await tx.asset.findFirst({ where: { id: input.assetId, owner_id: user.id, type: 'image', status: 'active' } });
      // Publication must not inherit an administrator's private reference access.
      const protectedUrls = new Set(await studioHiddenAssetUrls(null, tx));
      if (!task || !studioTaskHasViewableOutput(task) || !asset || task.source_preset_id && task.source_preset_id !== scope.presetId
        || !task.source_preset_id && scope.binding?.mode !== 'publisher'
        || protectedUrls.has(asset.original_url) || asset.thumbnail_url && protectedUrls.has(asset.thumbnail_url)) throw new StudioPinError('只能置顶本人在这个模板下可分享的结果图', 403);
      if (existing && (existing.ownerId !== user.id || existing.taskId !== input.taskId)) throw new StudioPinError('结果归属不匹配', 409);
      if (!existing && document.pins.length >= MAX_PINS) throw new StudioPinError(`本模板最多置顶 ${MAX_PINS} 张，请先取消部分置顶`, 409);
      const indexed = await tx.platformSetting.findUnique({ where: { key: indexKey(input.assetId) }, select: { value_json: true } });
      if (indexed && JSON.parse(indexed.value_json).presetId !== scope.presetId) throw new StudioPinError('这张结果已有其他模板的置顶记录', 409);
    }
    const pins = input.active ? existing ? document.pins : [{ taskId: input.taskId, assetId: input.assetId,
      ownerId: user.id, moduleId: input.moduleId, pinnedAt: new Date().toISOString() }, ...document.pins]
      : document.pins.filter(p => p.assetId !== input.assetId);
    const next: Document = { ...document, revision: document.revision + 1, pins,
      receipts: [...document.receipts, { id: input.requestId, fingerprint }].slice(-128) };
    if (row) {
      const changed = await tx.platformSetting.updateMany({ where: { key: resultPinsKey(scope.presetId), value_json: row.value_json },
        data: { value_json: JSON.stringify(next), updated_by: user.id } });
      if (!changed.count) throw new StudioPinError('置顶顺序已变化，请刷新后再操作', 409);
    } else await tx.platformSetting.create({ data: { key: resultPinsKey(scope.presetId), value_json: JSON.stringify(next), updated_by: user.id } });
    if (input.active) await tx.platformSetting.upsert({ where: { key: indexKey(input.assetId) },
      create: { key: indexKey(input.assetId), value_json: JSON.stringify({ version: 1, presetId: scope.presetId }), updated_by: user.id },
      update: { value_json: JSON.stringify({ version: 1, presetId: scope.presetId }), updated_by: user.id } });
    else await tx.platformSetting.deleteMany({ where: { key: indexKey(input.assetId),
      value_json: JSON.stringify({ version: 1, presetId: scope.presetId }) } });
    return { saved: true, replayed: false, revision: next.revision };
  }, { timeout: 15000 });
}
