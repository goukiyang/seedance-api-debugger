import 'server-only';
import { createHash } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import type { Prisma } from '@prisma/client';
import type { SessionUser } from '@/lib/auth/session';
import { canUseCompanyTemplates, canViewStudioPreset, isExternalImageStudioActor } from './access';
import { studioPresetArchived } from './preset-lifecycle';
import { studioSharedBinding, studioPublisherModule, studioMethodHistoryModuleId, type SharedStudioClient } from './shared-contract';
import { defaultStudioModuleId } from './modules';
import { studioTemplateTaskWhere } from './task-visibility';
import { studioHiddenAssetUrls } from './protected-assets';
import type { StudioPinMutation, StudioPinState, StudioOwnPin } from './result-pin-types';
import { studioOutputTaskWhere, studioTaskHasViewableOutput } from './dimension-mismatch';
import { characterLabTaskBatchIds } from '@/lib/character-lab/task-source';

export class StudioPinError extends Error {
  constructor(message: string, public status = 400, public code?: string) { super(message); }
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
export async function studioPinScope(user: SessionUser, moduleId: string, db: SharedStudioClient = prisma, management = false) {
  if (isExternalImageStudioActor(user)) return null;
  if (user.status !== 'active' || user.expires_at && user.expires_at <= new Date() || !canUseCompanyTemplates(user) || !validId(moduleId)) throw new StudioPinError('无权访问模板', 403);
  const studioModule = await db.imageStudioModule.findFirst({ where: { id: moduleId, owner_id: user.id } });
  if (!studioModule) return null;
  const binding = await studioSharedBinding(user.id, moduleId, db);
  const presetId = binding?.presetId || studioModule.source_preset_id;
  if (!presetId || studioModule.source_preset_id !== presetId) return null;
  const preset = await db.imageStudioPreset.findUnique({ where: { id: presetId } });
  const canPublish = Boolean(preset && preset.is_shared && canViewStudioPreset(user, preset) && !await studioPresetArchived(presetId, db));
  if (!canPublish && !management) return null;
  const publisherModuleId = binding?.mode === 'publisher' ? moduleId
    : preset?.owner_id === user.id ? await studioPublisherModule(user.id, presetId, db) : null;
  return { presetId, moduleId, binding, publisherModuleId, presetOwnerId: preset?.owner_id || null, canPublish };
}
// Older default-template tasks legitimately predate a physical workspace row.
const pinTaskModuleId = (task: { module_id: string | null; owner_id: string }) => task.module_id ?? defaultStudioModuleId(task.owner_id);
// A historical reproduction retains its recipe source, independently of this
// result's execution workspace. Only the server-frozen matching identity proves it.
function studioPinReproduction(task: { id: string; module_id: string | null; source_preset_id: string | null; snapshot_json: string | null }) {
  if (!task.snapshot_json) return false;
  try {
    const snapshot = JSON.parse(task.snapshot_json);
    return snapshot?.version === 1 && snapshot.moduleId === task.module_id && snapshot.sourcePresetId === task.source_preset_id
      && validId(snapshot.reproducedFromTaskId) && snapshot.reproducedFromTaskId !== task.id;
  } catch { return false; }
}
export function studioPinTaskReason(task: { id: string; module_id: string | null; owner_id: string; source_preset_id: string | null;
  status: string; asset_id: string | null; usage_json: string | null; snapshot_json: string | null },
scope: NonNullable<Awaited<ReturnType<typeof studioPinScope>>>, historyModuleId?: string): string | null {
  const taskModule = pinTaskModuleId(task);
  if (taskModule !== scope.moduleId && taskModule !== historyModuleId) return '这张结果不属于当前模板';
  if (!studioTaskHasViewableOutput(task)) return '图片尚未完整保存，暂不能置顶';
  if (task.source_preset_id && task.source_preset_id !== scope.presetId && !studioPinReproduction(task)) return '这张结果来自其他模板，不能在当前模板置顶';
  if (!task.source_preset_id && taskModule !== scope.publisherModuleId) {
    // This is a new publication by the actual target owner, not a rewrite of
    // the recipe source of an older result that predates the shared template.
    let executedHere = false;
    if (!scope.binding && scope.presetOwnerId === task.owner_id && task.module_id === scope.moduleId && task.snapshot_json) {
      try {
        const frozen = JSON.parse(task.snapshot_json);
        executedHere = frozen?.version === 1 && frozen.moduleId === task.module_id && frozen.sourcePresetId === null
          && Number.isSafeInteger(frozen.moduleRevision) && frozen.moduleRevision >= 0;
      } catch { /* An unproven historical identity cannot authorize publication. */ }
    }
    if (!executedHere) return '这张旧结果的执行归属无法确认，不能共享置顶';
  }
  return null;
}
export async function readStudioPinDocument(presetId: string, db: Pick<Prisma.TransactionClient, 'platformSetting'> = prisma) {
  const row = await db.platformSetting.findUnique({ where: { key: resultPinsKey(presetId) }, select: { value_json: true } });
  return { row, document: decode(row?.value_json, presetId) };
}
/** Every display and media/reaction request re-checks the source, task and protected-file ACL. */
export async function readableStudioPins(user: SessionUser, presetId: string, db: SharedStudioClient = prisma, assetId?: string) {
  if (user.status !== 'active' || user.expires_at && user.expires_at <= new Date() || !canUseCompanyTemplates(user)) return null;
  const preset = await db.imageStudioPreset.findUnique({ where: { id: presetId } });
  if (!preset || !preset.is_shared || !canViewStudioPreset(user, preset) || await studioPresetArchived(presetId, db)) return null;
  const { document } = await readStudioPinDocument(presetId, db);
  const selectedPins = assetId ? document.pins.filter(pin => pin.assetId === assetId) : document.pins;
  const tasks = await db.imageStudioTask.findMany({ where: { id: { in: selectedPins.map(p => p.taskId) },
    AND: [studioOutputTaskWhere], deleted_at: null }, select: { id: true, asset_id: true, owner_id: true, module_id: true,
      source_preset_id: true, batch_id: true, created_at: true, status: true, usage_json: true } });
  const excludedByOwner = new Map(await Promise.all(Array.from(new Set(tasks.map(task => task.owner_id)), async ownerId =>
    [ownerId, new Set(await characterLabTaskBatchIds(ownerId, db))] as const)));
  const visibleTasks = tasks.filter(task => !excludedByOwner.get(task.owner_id)?.has(task.batch_id));
  const differentSources = visibleTasks.filter(task => task.source_preset_id && task.source_preset_id !== presetId);
  const reproductionProofs = differentSources.length ? await db.imageStudioTask.findMany({
    where: { id: { in: differentSources.map(task => task.id) } },
    select: { id: true, module_id: true, source_preset_id: true, snapshot_json: true },
  }) : [];
  const reproducedIds = new Set(reproductionProofs.filter(studioPinReproduction).map(task => task.id));
  const assets = await db.asset.findMany({ where: { id: { in: selectedPins.map(p => p.assetId) },
    type: 'image', status: 'active' }, select: { id: true, owner_id: true, original_url: true, thumbnail_url: true,
      width: true, height: true, mime_type: true } });
  const hidden = new Set(await studioHiddenAssetUrls(user, db, selectedPins.map(pin => pin.assetId)));
  const byTask = new Map(visibleTasks.map(t => [t.id, t]));
  const byAsset = new Map(assets.map(a => [a.id, a]));
  const pins = selectedPins.flatMap(pin => {
    const task = byTask.get(pin.taskId), asset = byAsset.get(pin.assetId);
    if (!task || !studioTaskHasViewableOutput(task) || !asset || task.asset_id !== pin.assetId || task.owner_id !== pin.ownerId || asset.owner_id !== pin.ownerId
      || pinTaskModuleId(task) !== pin.moduleId || task.source_preset_id && task.source_preset_id !== presetId && !reproducedIds.has(task.id)
      || hidden.has(asset.original_url) || asset.thumbnail_url && hidden.has(asset.thumbnail_url)) return [];
    return [{ ...pin, task, asset }];
  });
  return { document, pins };
}
export function studioPinState(presetId: string | null, revision = 0, assetIds: string[] = []): StudioPinState {
  return { presetId, revision, assetIds, ...(!presetId ? { disabledReason: '模板尚未共享，暂不能置顶给其他人' } : {}) };
}
export async function studioManagedPinState(user: SessionUser, scope: Awaited<ReturnType<typeof studioPinScope>>,
  readable: Awaited<ReturnType<typeof readableStudioPins>>, db: SharedStudioClient = prisma, details = true): Promise<StudioPinState> {
  if (!scope) return { ...studioPinState(null), ownAssetIds: [], ...(details ? { ownPins: [] } : {}) };
  const document = readable?.document || (await readStudioPinDocument(scope.presetId, db)).document;
  const own = document.pins.filter(pin => pin.ownerId === user.id);
  const state: StudioPinState = { presetId: scope.presetId, revision: document.revision,
    assetIds: readable?.pins.map(pin => pin.assetId) || [], ownAssetIds: own.map(pin => pin.assetId),
    ...(!scope.canPublish ? { disabledReason: '模板当前不可共享，仍可取消本人置顶' } : {}) };
  // Regular polling needs only ownership ids. Full reasons/thumbnails are read
  // on demand in owner management, rather than expanded on every result page.
  if (!details) return state;
  const assets = own.length ? await db.asset.findMany({ where: { id: { in: own.map(pin => pin.assetId) }, owner_id: user.id },
    select: { id: true, original_url: true, thumbnail_url: true, status: true } }) : [];
  const protectedUrls = new Set(own.length ? await studioHiddenAssetUrls(null, db, own.map(pin => pin.assetId)) : []);
  const ownPins: StudioOwnPin[] = own.map(pin => {
    const asset = assets.find(item => item.id === pin.assetId);
    const restricted = asset && (protectedUrls.has(asset.original_url) || asset.thumbnail_url && protectedUrls.has(asset.thumbnail_url));
    const visible = readable?.pins.some(item => item.assetId === pin.assetId);
    const availability = !scope.canPublish ? 'unavailable' : restricted ? 'restricted' : visible ? 'available' : 'unavailable';
    return { taskId: pin.taskId, assetId: pin.assetId, moduleId: pin.moduleId, pinnedAt: pin.pinnedAt, availability,
      reason: !scope.canPublish ? '模板当前不可共享' : restricted ? '图片属于受保护素材' : !visible ? '图片当前不可展示' : null,
      thumbnailUrl: visible ? `/api/content-reactions/media?key=${encodeURIComponent(`asset:${pin.assetId}`)}&variant=thumbnail` : null };
  });
  return { ...state, ownPins };
}
export async function readStudioOwnPinState(user: SessionUser, moduleId: string) {
  const scope = await studioPinScope(user, moduleId, prisma, true);
  return studioManagedPinState(user, scope, scope?.canPublish ? await readableStudioPins(user, scope.presetId) : null);
}
export async function resolveStudioPinnedAsset(user: SessionUser, assetId: string) {
  const index = await prisma.platformSetting.findUnique({ where: { key: indexKey(assetId) }, select: { value_json: true } });
  if (!index) return null;
  let presetId: string;
  try { const parsed = JSON.parse(index.value_json); if (parsed.version !== 1 || !validId(parsed.presetId)) return null; presetId = parsed.presetId; }
  catch { return null; }
  const readable = await readableStudioPins(user, presetId, prisma, assetId);
  const pin = readable?.pins.find(p => p.assetId === assetId);
  return pin ? { ...pin, presetId } : null;
}
function pinCommandFingerprint(user: SessionUser, input: StudioPinMutation) {
  if (user.status !== 'active' || user.expires_at && user.expires_at <= new Date() || !canUseCompanyTemplates(user)) {
    throw new StudioPinError('无权操作置顶记录', 403);
  }
  if (!input || input.viewerId !== user.id || ![input.moduleId, input.taskId, input.assetId, input.requestId].every(validId)
    || input.presetId !== undefined && !validId(input.presetId)
    || typeof input.active !== 'boolean' || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new StudioPinError('置顶参数无效，请刷新当前模板');
  }
  // The receipt lives inside its preset document. Preserve the v1 fingerprint
  // so original commands remain replayable by the compatible rollback reader.
  return digest([user.id, input.moduleId, input.taskId, input.assetId, input.active, input.expectedRevision]);
}
export async function studioPinCommandStatus(user: SessionUser, input: StudioPinMutation) {
  const fingerprint = pinCommandFingerprint(user, input);
  const scope = input.presetId ? null : await studioPinScope(user, input.moduleId, prisma, true);
  const presetId = scope?.presetId || input.presetId;
  if (!presetId) return { status: 'unknown' as const };
  if (input.presetId && scope && input.presetId !== scope.presetId) throw new StudioPinError('置顶目标已变化，请核对原操作', 409);
  const { document } = await readStudioPinDocument(presetId);
  const receipt = document.receipts.find(item => item.id === input.requestId);
  if (receipt && receipt.fingerprint !== fingerprint) throw new StudioPinError('原置顶请求与当前对象不匹配', 409);
  return receipt ? { status: 'completed' as const, revision: document.revision } : { status: 'unknown' as const };
}
export async function mutateStudioPin(user: SessionUser, input: StudioPinMutation) {
  const fingerprint = pinCommandFingerprint(user, input);
  return prisma.$transaction(async tx => {
    // An explicit cancellation is authorized by the existing own publication,
    // independent of the current availability of its original workspace.
    const scope = !input.active && input.presetId ? null : await studioPinScope(user, input.moduleId, tx, true);
    const presetId = scope?.presetId || (!input.active ? input.presetId : undefined);
    if (!presetId) throw new StudioPinError('模板尚未共享或已不可用，不能更改置顶', 409);
    if (input.presetId && input.presetId !== presetId) throw new StudioPinError('置顶目标已变化，请核对原操作', 409);
    const { row, document } = await readStudioPinDocument(presetId, tx);
    const previous = document.receipts.find(r => r.id === input.requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new StudioPinError('该操作编号已用于其他内容', 409);
      return { saved: true, replayed: true, revision: document.revision };
    }
    if (document.revision !== input.expectedRevision) throw new StudioPinError('置顶顺序已变化，请刷新后再操作', 409, 'studio-pin-revision-changed');
    const existing = document.pins.find(p => p.assetId === input.assetId);
    // Unpin remains possible after this owner's result is hidden; never remove a public album entry.
    if (!input.active && (!existing || existing.ownerId !== user.id || existing.taskId !== input.taskId)) throw new StudioPinError('只能取消本人结果的置顶', 403);
    let resultModuleId = input.moduleId;
    if (input.active) {
      if (!scope?.canPublish) throw new StudioPinError('模板当前不可共享，不能新增置顶', 403);
      const [excludedToolBatches, historyModuleId] = await Promise.all([
        characterLabTaskBatchIds(user.id, tx), studioMethodHistoryModuleId(user, input.moduleId, tx),
      ]);
      const task = await tx.imageStudioTask.findFirst({ where: { id: input.taskId, owner_id: user.id,
        asset_id: input.assetId, AND: [studioTemplateTaskWhere(user.id, input.moduleId, false, excludedToolBatches, historyModuleId)] } });
      if (!task) throw new StudioPinError('找不到本人在当前模板下的结果，请刷新结果列表', 403);
      const reason = studioPinTaskReason(task, scope, historyModuleId);
      if (reason) throw new StudioPinError(reason, 403);
      const asset = await tx.asset.findFirst({ where: { id: input.assetId, owner_id: user.id, type: 'image', status: 'active' } });
      if (!asset) throw new StudioPinError('这张图片已不可用，或不属于本人', 403);
      // Publication must not inherit an administrator's private reference access.
      const protectedUrls = new Set(await studioHiddenAssetUrls(null, tx, [input.assetId]));
      if (protectedUrls.has(asset.original_url) || asset.thumbnail_url && protectedUrls.has(asset.thumbnail_url)) {
        throw new StudioPinError('这张图片属于受保护参考素材，不能共享置顶', 403);
      }
      resultModuleId = pinTaskModuleId(task);
      if (existing && (existing.ownerId !== user.id || existing.taskId !== input.taskId)) throw new StudioPinError('结果归属不匹配', 409);
      if (!existing && document.pins.length >= MAX_PINS) throw new StudioPinError(`本模板最多置顶 ${MAX_PINS} 张，请先取消部分置顶`, 409);
      const indexed = await tx.platformSetting.findUnique({ where: { key: indexKey(input.assetId) }, select: { value_json: true } });
      if (indexed && JSON.parse(indexed.value_json).presetId !== presetId) throw new StudioPinError('这张结果已有其他模板的置顶记录', 409);
    }
    const pins = input.active ? existing ? document.pins : [{ taskId: input.taskId, assetId: input.assetId,
      ownerId: user.id, moduleId: resultModuleId, pinnedAt: new Date().toISOString() }, ...document.pins]
      : document.pins.filter(p => p.assetId !== input.assetId);
    const next: Document = { ...document, revision: document.revision + 1, pins,
      receipts: [...document.receipts, { id: input.requestId, fingerprint }].slice(-128) };
    if (row) {
      const changed = await tx.platformSetting.updateMany({ where: { key: resultPinsKey(presetId), value_json: row.value_json },
        data: { value_json: JSON.stringify(next), updated_by: user.id } });
      if (!changed.count) throw new StudioPinError('置顶顺序已变化，请刷新后再操作', 409, 'studio-pin-revision-changed');
    } else await tx.platformSetting.create({ data: { key: resultPinsKey(presetId), value_json: JSON.stringify(next), updated_by: user.id } });
    if (input.active) await tx.platformSetting.upsert({ where: { key: indexKey(input.assetId) },
      create: { key: indexKey(input.assetId), value_json: JSON.stringify({ version: 1, presetId }), updated_by: user.id },
      update: { value_json: JSON.stringify({ version: 1, presetId }), updated_by: user.id } });
    else await tx.platformSetting.deleteMany({ where: { key: indexKey(input.assetId),
      value_json: JSON.stringify({ version: 1, presetId }) } });
    return { saved: true, replayed: false, revision: next.revision };
  }, { timeout: 15000 });
}
