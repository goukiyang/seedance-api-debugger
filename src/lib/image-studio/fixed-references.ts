import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { canViewStudioPreset, type ImageStudioIdentity, type StudioPresetAccessRow } from './access';
import { MAX_REFERENCE_IMAGES } from './limits';

export type StudioFixedReference = { assetId: string; note: string };
export type StudioFixedReferencePreset = StudioPresetAccessRow & { id: string };
type FixedReferenceClient = Pick<Prisma.TransactionClient, 'platformSetting' | 'imageStudioModule' | 'imageStudioPreset' | 'asset'>;

const SETTING_PREFIX = 'studio_fixed_references_v1';
const moduleKey = (id: string) => `${SETTING_PREFIX}:module:${id}`;
const presetKey = (id: string) => `${SETTING_PREFIX}:preset:${id}`;

export class StudioFixedReferenceError extends Error {
  constructor(message: string, public status = 400) { super(message); }
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
  if (!references.length) {
    await client.platformSetting.deleteMany({ where: { key } });
    return;
  }
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
  const module = await client.imageStudioModule.findFirst({ where: { id: moduleId, owner_id: ownerId }, select: { id: true } });
  if (!module) return [];
  return readSetting(client, moduleKey(moduleId), ownerId);
}

export async function setStudioModuleFixedReferences(ownerId: string, moduleId: string, references: StudioFixedReference[], client: FixedReferenceClient = prisma) {
  const module = await client.imageStudioModule.findFirst({ where: { id: moduleId, owner_id: ownerId }, select: { id: true } });
  if (!module) throw new StudioFixedReferenceError('模块不存在或无权使用', 403);
  await writeSetting(client, moduleKey(moduleId), ownerId, references);
}

export async function removeStudioModuleFixedReferences(ownerId: string, moduleId: string, client: FixedReferenceClient = prisma) {
  const module = await client.imageStudioModule.findFirst({ where: { id: moduleId, owner_id: ownerId }, select: { id: true } });
  if (!module) throw new StudioFixedReferenceError('模块不存在或无权使用', 403);
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
}

export async function studioPresetHasFixedReference(user: ImageStudioIdentity, preset: StudioFixedReferencePreset, assetId: string) {
  const references = await getStudioPresetFixedReferences(user, preset);
  return references.some(reference => reference.assetId === assetId);
}
