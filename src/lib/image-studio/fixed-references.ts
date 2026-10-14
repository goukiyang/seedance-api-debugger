import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { canManageStudioPreset, canViewStudioPreset, type ImageStudioIdentity, type StudioPresetAccessRow } from './access';
import { MAX_REFERENCE_IMAGES } from './limits';
import { studioVisibleAssetWhere } from './protected-assets';
import type { SharedStudioFixedReferenceRepair } from './shared-types';

export type StudioFixedReference = { assetId: string; note: string };
export type StudioFixedReferencePreset = StudioPresetAccessRow & { id: string };
type FixedReferenceClient = Pick<Prisma.TransactionClient, 'platformSetting' | 'imageStudioModule' | 'imageStudioPreset' | 'asset'>;

const SETTING_PREFIX = 'studio_fixed_references_v1';
const moduleKey = (id: string) => `${SETTING_PREFIX}:module:${id}`;
const presetKey = (id: string) => `${SETTING_PREFIX}:preset:${id}`;

export class StudioFixedReferenceError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

// Fixed references are deliberately hidden from ordinary authors. That media
// read restriction is NOT evidence that an otherwise valid stored slot failed.
export function studioFixedReferenceStatus(ownerId: string, asset?: { owner_id: string; status: string; type: string }) {
  if (!asset || asset.status !== 'active' || asset.type !== 'image') return 'missing' as const;
  return asset.owner_id === ownerId ? 'valid' as const : 'inaccessible' as const;
}

export async function repairStudioFixedReferences(actor: ImageStudioIdentity, preset: StudioFixedReferencePreset,
  stored: StudioFixedReference[], value: unknown, client: FixedReferenceClient): Promise<StudioFixedReference[]> {
  if (preset.owner_id !== actor.id || !canManageStudioPreset(actor, preset)) {
    throw new StudioFixedReferenceError('只能修复自己有权管理的原模板固定参考', 403);
  }
  if (!Array.isArray(value) || value.length > stored.length) throw new StudioFixedReferenceError('固定参考修复指令无效');
  const changes = new Map<number, SharedStudioFixedReferenceRepair>();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new StudioFixedReferenceError('固定参考修复指令无效');
    const item = raw as Record<string, unknown>;
    if (Object.keys(item).some(key => !['sourceIndex', 'originalAssetId', 'replacementAssetId'].includes(key))
      || !Number.isInteger(item.sourceIndex) || Number(item.sourceIndex) < 0 || Number(item.sourceIndex) >= stored.length
      || typeof item.originalAssetId !== 'string' || stored[Number(item.sourceIndex)].assetId !== item.originalAssetId
      || changes.has(Number(item.sourceIndex)) || item.replacementAssetId !== null
        && (typeof item.replacementAssetId !== 'string' || !item.replacementAssetId || item.replacementAssetId.length > 100)) {
      throw new StudioFixedReferenceError('固定参考来源或槽位已变化，请重新读取；当前草稿保留', 409);
    }
    changes.set(Number(item.sourceIndex), { sourceIndex: Number(item.sourceIndex), originalAssetId: item.originalAssetId,
      replacementAssetId: item.replacementAssetId as string | null });
  }
  const originals = await client.asset.findMany({ where: { id: { in: Array.from(new Set(stored.map(item => item.assetId))) } },
    select: { id: true, owner_id: true, status: true, type: true } });
  const byId = new Map(originals.map(asset => [asset.id, asset]));
  for (const item of Array.from(changes.values())) {
    if (studioFixedReferenceStatus(preset.owner_id, byId.get(item.originalAssetId)) === 'valid') {
      throw new StudioFixedReferenceError('正常固定参考仍由管理员管理，不能移除、替换或改序', 403);
    }
  }
  // Query failures escape; they never turn into missing slots or edit grants.
  // Replacement media must be an actually readable own image BEFORE it becomes
  // protected fixed content. No opaque id can restore hidden/private media.
  const replacementIds = Array.from(new Set(Array.from(changes.values()).flatMap(item => item.replacementAssetId ? [item.replacementAssetId] : [])));
  if (replacementIds.length) {
    const readable = await client.asset.count({ where: { id: { in: replacementIds }, owner_id: actor.id,
      status: 'active', type: 'image', AND: [await studioVisibleAssetWhere(actor, client)] } });
    if (readable !== replacementIds.length) throw new StudioFixedReferenceError('替换图片已不可用或无权读取，固定参考未修改', 403);
  }
  // A slot has exactly one replacement or is removed. Untouched identities,
  // relative order and ALL original notes are copied from server storage.
  return stored.flatMap((item, index) => {
    const change = changes.get(index);
    return !change ? [item] : change.replacementAssetId === null ? [] : [{ assetId: change.replacementAssetId, note: item.note }];
  });
}

export function parseStudioFixedReferences(value: unknown): StudioFixedReference[] {
  if (!Array.isArray(value) || value.length > MAX_REFERENCE_IMAGES) {
    throw new StudioFixedReferenceError(`固定参考图最多 ${MAX_REFERENCE_IMAGES} 张`);
  }
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new StudioFixedReferenceError('固定参考图内容无效');
    }
    const reference = item as Record<string, unknown>;
    if (typeof reference.assetId !== 'string' || !reference.assetId || reference.assetId.length > 100
      || typeof reference.note !== 'string' || reference.note.length > 2000) {
      throw new StudioFixedReferenceError('固定参考图或备注无效（每条备注最多 2000 字）');
    }
    return { assetId: reference.assetId, note: reference.note };
  });
}

function decodeSetting(valueJson: string | undefined, ownerId: string): StudioFixedReference[] {
  if (valueJson === undefined) return [];
  let value: unknown;
  try { value = JSON.parse(valueJson); }
  catch { throw new StudioFixedReferenceError('固定参考图设置无法读取', 503); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new StudioFixedReferenceError('固定参考图设置无法读取', 503);
  }
  const stored = value as Record<string, unknown>;
  if (stored.ownerId !== ownerId || !Array.isArray(stored.references)) {
    throw new StudioFixedReferenceError('固定参考图设置与当前所有者不匹配', 403);
  }
  try { return parseStudioFixedReferences(stored.references); }
  catch { throw new StudioFixedReferenceError('固定参考图设置无法读取', 503); }
}

async function readSetting(client: FixedReferenceClient, key: string, ownerId: string) {
  const row = await client.platformSetting.findUnique({ where: { key }, select: { value_json: true } });
  return decodeSetting(row?.value_json, ownerId);
}

async function writeSetting(client: FixedReferenceClient, key: string, ownerId: string, references: StudioFixedReference[]) {
  const assetIds = Array.from(new Set(references.map(reference => reference.assetId)));
  const assets = await client.asset.findMany({ where: { id: { in: assetIds }, owner_id: ownerId, status: 'active', type: 'image' }, select: { id: true } });
  if (assets.length !== assetIds.length) throw new StudioFixedReferenceError('固定参考图不存在或无权使用', 403);
  const valueJson = JSON.stringify({ ownerId, references });
  await client.platformSetting.upsert({
    where: { key },
    create: { key, value_json: valueJson, updated_by: ownerId },
    update: { value_json: valueJson, updated_by: ownerId },
  });
}

export async function getStudioModuleFixedReferences(ownerId: string, moduleId: string, client: FixedReferenceClient = prisma) {
  const workspace = await client.imageStudioModule.findFirst({ where: { id: moduleId, owner_id: ownerId }, select: { id: true, source_preset_id: true } });
  if (!workspace) return [];
  if (workspace.source_preset_id) {
    const source = await client.imageStudioPreset.findUnique({ where: { id: workspace.source_preset_id }, select: { id: true, owner_id: true } });
    // Shared copies keep a server-side binding instead of granting ownership of hidden images.
    if (source) {
      const binding = await client.platformSetting.findUnique({ where: { key: `studio_shared_binding_v1:${moduleId}` }, select: { value_json: true } });
      if (binding) {
        let value: Record<string, unknown>;
        try { value = JSON.parse(binding.value_json); }
        catch { throw new StudioFixedReferenceError('共享模板绑定无法读取', 409); }
        if (!value || typeof value !== 'object' || Array.isArray(value) || value.protocol !== 'shared-live-v1' || value.ownerId !== ownerId
          || value.presetId !== source.id || !['publisher', 'live'].includes(String(value.mode))) throw new StudioFixedReferenceError('共享模板来源无法确认', 409);
        return readSetting(client, presetKey(source.id), source.owner_id);
      }
      if (source.owner_id !== ownerId) return readSetting(client, presetKey(source.id), source.owner_id);
      const own = await client.platformSetting.findUnique({ where: { key: moduleKey(moduleId) }, select: { value_json: true } });
      return own ? decodeSetting(own.value_json, ownerId) : readSetting(client, presetKey(source.id), source.owner_id);
    }
  }
  return readSetting(client, moduleKey(moduleId), ownerId);
}

export async function setStudioModuleFixedReferences(ownerId: string, moduleId: string, references: StudioFixedReference[], client: FixedReferenceClient = prisma) {
  const workspace = await client.imageStudioModule.findFirst({ where: { id: moduleId, owner_id: ownerId }, select: { id: true } });
  if (!workspace) throw new StudioFixedReferenceError('模块不存在或无权使用', 403);
  if (await client.platformSetting.findUnique({ where: { key: `studio_shared_binding_v1:${moduleId}` }, select: { id: true } })) {
    throw new StudioFixedReferenceError('实时共享固定图只能通过原模板保存', 403);
  }
  await writeSetting(client, moduleKey(moduleId), ownerId, references);
}

export async function removeStudioModuleFixedReferences(ownerId: string, moduleId: string, client: FixedReferenceClient = prisma) {
  const workspace = await client.imageStudioModule.findFirst({ where: { id: moduleId, owner_id: ownerId }, select: { id: true } });
  if (!workspace) throw new StudioFixedReferenceError('模块不存在或无权使用', 403);
  await client.platformSetting.deleteMany({ where: { key: moduleKey(moduleId) } });
}

export async function getStudioPresetFixedReferences(user: ImageStudioIdentity, preset: StudioFixedReferencePreset, client: FixedReferenceClient = prisma) {
  if (!canViewStudioPreset(user, preset)) throw new StudioFixedReferenceError('模板不存在或无权使用', 403);
  return readSetting(client, presetKey(preset.id), preset.owner_id);
}

export async function getStudioPresetsFixedReferences(user: ImageStudioIdentity, presets: StudioFixedReferencePreset[], client: FixedReferenceClient = prisma) {
  if (presets.some(preset => !canViewStudioPreset(user, preset))) throw new StudioFixedReferenceError('模板不存在或无权使用', 403);
  if (!presets.length) return new Map<string, StudioFixedReference[]>();
  const keyToPreset = new Map(presets.map(preset => [presetKey(preset.id), preset]));
  const rows = await client.platformSetting.findMany({ where: { key: { in: Array.from(keyToPreset.keys()) } }, select: { key: true, value_json: true } });
  const valueByKey = new Map(rows.map(row => [row.key, row.value_json]));
  return new Map(presets.map(preset => [preset.id, decodeSetting(valueByKey.get(presetKey(preset.id)), preset.owner_id)]));
}

export async function setStudioPresetFixedReferences(ownerId: string, presetId: string, references: StudioFixedReference[], client: FixedReferenceClient = prisma) {
  const preset = await client.imageStudioPreset.findFirst({ where: { id: presetId, owner_id: ownerId }, select: { id: true } });
  if (!preset) throw new StudioFixedReferenceError('模板不存在或无权使用', 403);
  await writeSetting(client, presetKey(presetId), ownerId, references);
  const key = `studio_shared_reproduction_v1:${presetId}`;
  const historical = await client.platformSetting.findUnique({ where: { key }, select: { value_json: true } });
  if (historical) {
    let value: Record<string, unknown>;
    try { value = JSON.parse(historical.value_json); }
    catch { throw new StudioFixedReferenceError('历史模板定义无法读取', 409); }
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.sourceOwnerId !== ownerId || value.version !== 1) throw new StudioFixedReferenceError('历史模板定义所有者不匹配', 403);
    const changed = await client.platformSetting.updateMany({ where: { key, value_json: historical.value_json },
      data: { value_json: JSON.stringify({ ...value, templateFixedReferences: references }), updated_by: ownerId } });
    if (changed.count !== 1) throw new StudioFixedReferenceError('历史模板固定图已变化，请重新读取', 409);
  }
}

export async function studioPresetHasFixedReference(user: ImageStudioIdentity, preset: StudioFixedReferencePreset, assetId: string) {
  const references = await getStudioPresetFixedReferences(user, preset);
  return references.some(reference => reference.assetId === assetId);
}
