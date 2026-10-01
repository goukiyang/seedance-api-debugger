import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { MAX_REFERENCE_IMAGES } from './limits';

export type StudioReferencePolicy = {
  primaryIds: string[];
  primaryMin: number;
  primaryMax: number;
  auxiliaryMax: number;
  useFixedReferences: boolean;
};

type ReferencePolicyClient = Pick<Prisma.TransactionClient, 'platformSetting' | 'imageStudioModule' | 'imageStudioPreset'>;

const SETTING_PREFIX = 'studio_reference_policy_v1';
const moduleKey = (ownerId: string, moduleId: string) => `${SETTING_PREFIX}:module:${ownerId}:${moduleId}`;
const presetKey = (ownerId: string, presetId: string) => `${SETTING_PREFIX}:preset:${ownerId}:${presetId}`;

export class StudioReferencePolicyError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

function boundedPrimaryMax(value: unknown) {
  const number = Number(value);
  return Number.isInteger(number) ? Math.max(1, Math.min(MAX_REFERENCE_IMAGES, number)) : MAX_REFERENCE_IMAGES;
}

function orderedUnique(ids: string[]) {
  return Array.from(new Set(ids));
}

export function defaultStudioReferencePolicy(transientIds: string[], primaryMax: unknown = MAX_REFERENCE_IMAGES): StudioReferencePolicy {
  return {
    primaryIds: orderedUnique(transientIds),
    primaryMin: 0,
    primaryMax: boundedPrimaryMax(primaryMax),
    auxiliaryMax: MAX_REFERENCE_IMAGES,
    useFixedReferences: true,
  };
}

export function validateStudioReferenceCounts(policy: StudioReferencePolicy, transientIds: string[], fixedCount: number, styleCount: number, requireMinimum = false) {
  const ids = orderedUnique(transientIds);
  const primaryCount = ids.filter(id => policy.primaryIds.includes(id)).length;
  const auxiliaryCount = ids.length - primaryCount + (policy.useFixedReferences ? fixedCount : 0) + styleCount;
  if ((requireMinimum && primaryCount < policy.primaryMin) || primaryCount > policy.primaryMax) {
    throw new StudioReferencePolicyError(`主图数量须为 ${policy.primaryMin} 到 ${policy.primaryMax} 张`);
  }
  if (auxiliaryCount > policy.auxiliaryMax) throw new StudioReferencePolicyError(`辅助参考图最多使用 ${policy.auxiliaryMax} 张`);
  if (primaryCount + auxiliaryCount > MAX_REFERENCE_IMAGES) throw new StudioReferencePolicyError(`主图与辅助参考图合计不能超过 ${MAX_REFERENCE_IMAGES} 张`);
}

function parsePolicyShape(value: unknown): StudioReferencePolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StudioReferencePolicyError('参考图角色设置无效');
  const record = value as Record<string, unknown>;
  const expected = ['primaryIds', 'primaryMin', 'primaryMax', 'auxiliaryMax', 'useFixedReferences'];
  if (Object.keys(record).some(key => !expected.includes(key)) || expected.some(key => !Object.prototype.hasOwnProperty.call(record, key))) {
    throw new StudioReferencePolicyError('参考图角色设置无效');
  }
  if (!Array.isArray(record.primaryIds) || record.primaryIds.length > MAX_REFERENCE_IMAGES
    || record.primaryIds.some(id => typeof id !== 'string' || !id || id.length > 100)
    || new Set(record.primaryIds).size !== record.primaryIds.length
    || !Number.isInteger(record.primaryMin) || Number(record.primaryMin) < 0
    || !Number.isInteger(record.primaryMax) || Number(record.primaryMax) < 1 || Number(record.primaryMax) > MAX_REFERENCE_IMAGES
    || Number(record.primaryMin) > Number(record.primaryMax)
    || !Number.isInteger(record.auxiliaryMax) || Number(record.auxiliaryMax) < 0 || Number(record.auxiliaryMax) > MAX_REFERENCE_IMAGES
    || typeof record.useFixedReferences !== 'boolean'
    || record.primaryIds.length > Number(record.primaryMax)) {
    throw new StudioReferencePolicyError('参考图角色数量或范围无效');
  }
  return {
    primaryIds: record.primaryIds as string[],
    primaryMin: Number(record.primaryMin),
    primaryMax: Number(record.primaryMax),
    auxiliaryMax: Number(record.auxiliaryMax),
    useFixedReferences: record.useFixedReferences,
  };
}

export function parseStudioReferencePolicy(value: unknown, transientIds: string[]): StudioReferencePolicy {
  const policy = parsePolicyShape(value);
  const available = new Set(transientIds);
  if (policy.primaryIds.some(id => !available.has(id))) throw new StudioReferencePolicyError('主参考图必须来自本次已选择的图片');
  return { ...policy, primaryIds: orderedUnique(transientIds).filter(id => policy.primaryIds.includes(id)) };
}

export function mapStudioReferencePolicy(value: unknown, transientIds: string[]): StudioReferencePolicy {
  const policy = parsePolicyShape(value);
  const selected = new Set(transientIds);
  return { ...policy, primaryIds: orderedUnique(transientIds).filter(id => selected.has(id) && policy.primaryIds.includes(id)) };
}

function decodeStoredPolicy(valueJson: string | undefined, ownerId: string, transientIds: string[], primaryMax: unknown): StudioReferencePolicy {
  if (valueJson === undefined) return defaultStudioReferencePolicy(transientIds, primaryMax);
  let value: unknown;
  try { value = JSON.parse(valueJson); }
  catch { throw new StudioReferencePolicyError('参考图角色设置无法读取', 503); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StudioReferencePolicyError('参考图角色设置无法读取', 503);
  const record = value as Record<string, unknown>;
  if (record.ownerId !== ownerId) throw new StudioReferencePolicyError('参考图角色设置与当前所有者不匹配', 403);
  try {
    const policy = parsePolicyShape(record.policy);
    const selected = new Set(transientIds);
    return { ...policy, primaryIds: orderedUnique(transientIds).filter(id => selected.has(id) && policy.primaryIds.includes(id)) };
  } catch {
    throw new StudioReferencePolicyError('参考图角色设置无法读取', 503);
  }
}

async function readPolicy(client: ReferencePolicyClient, key: string, ownerId: string, transientIds: string[], primaryMax: unknown) {
  const row = await client.platformSetting.findUnique({ where: { key }, select: { value_json: true } });
  return decodeStoredPolicy(row?.value_json, ownerId, transientIds, primaryMax);
}

async function writePolicy(client: ReferencePolicyClient, key: string, ownerId: string, value: unknown, transientIds: string[]) {
  const policy = parseStudioReferencePolicy(value, transientIds);
  const valueJson = JSON.stringify({ ownerId, policy });
  await client.platformSetting.upsert({
    where: { key },
    create: { key, value_json: valueJson, updated_by: ownerId },
    update: { value_json: valueJson, updated_by: ownerId },
  });
  return policy;
}

export async function getStudioModuleReferencePolicy(ownerId: string, moduleId: string, transientIds: string[], primaryMax: unknown, client: ReferencePolicyClient = prisma) {
  return readPolicy(client, moduleKey(ownerId, moduleId), ownerId, transientIds, primaryMax);
}

export async function setStudioModuleReferencePolicy(ownerId: string, moduleId: string, value: unknown, transientIds: string[], client: ReferencePolicyClient = prisma) {
  const workspace = await client.imageStudioModule.findFirst({ where: { id: moduleId, owner_id: ownerId }, select: { id: true } });
  if (!workspace) throw new StudioReferencePolicyError('模块不存在或无权修改', 403);
  return writePolicy(client, moduleKey(ownerId, moduleId), ownerId, value, transientIds);
}

export async function removeStudioModuleReferencePolicy(ownerId: string, moduleId: string, client: ReferencePolicyClient = prisma) {
  await client.platformSetting.deleteMany({ where: { key: moduleKey(ownerId, moduleId) } });
}

export async function getStudioPresetReferencePolicy(ownerId: string, presetId: string, transientIds: string[], primaryMax: unknown, client: ReferencePolicyClient = prisma) {
  return readPolicy(client, presetKey(ownerId, presetId), ownerId, transientIds, primaryMax);
}

export async function setStudioPresetReferencePolicy(ownerId: string, presetId: string, value: unknown, transientIds: string[], client: ReferencePolicyClient = prisma) {
  const preset = await client.imageStudioPreset.findFirst({ where: { id: presetId, owner_id: ownerId }, select: { id: true } });
  if (!preset) throw new StudioReferencePolicyError('模板不存在或无权修改', 403);
  return writePolicy(client, presetKey(ownerId, presetId), ownerId, value, transientIds);
}
