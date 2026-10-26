import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

export const STUDIO_NAVIGATION_PREFERENCE_KEY = 'image-studio-navigation:v1';
export type StudioNavigationPreference = { version: 1; revision: number; hiddenModuleIds: string[] };
const moduleIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export class StudioNavigationPreferenceError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export function parseStudioNavigationPreference(raw: string | null): StudioNavigationPreference {
  if (raw === null) return { version: 1, revision: 0, hiddenModuleIds: [] };
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new StudioNavigationPreferenceError('侧栏设置无法读取，原记录已保留', 503); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StudioNavigationPreferenceError('侧栏设置无法读取，原记录已保留', 503);
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !Number.isSafeInteger(record.revision) || Number(record.revision) < 0
    || !Array.isArray(record.hiddenModuleIds) || record.hiddenModuleIds.length > 1000
    || record.hiddenModuleIds.some(id => typeof id !== 'string' || !moduleIdPattern.test(id))) throw new StudioNavigationPreferenceError('侧栏设置无法读取，原记录已保留', 503);
  return { version: 1, revision: Number(record.revision), hiddenModuleIds: Array.from(new Set(record.hiddenModuleIds as string[])) };
}

type PreferenceClient = Pick<Prisma.TransactionClient, 'userPreference' | 'imageStudioModule'>;
export async function readStudioNavigationPreference(ownerId: string, client: PreferenceClient = prisma) {
  const row = await client.userPreference.findUnique({ where: { user_id_key: { user_id: ownerId, key: STUDIO_NAVIGATION_PREFERENCE_KEY } }, select: { value_json: true } });
  const value = parseStudioNavigationPreference(row?.value_json ?? null);
  if (!value.hiddenModuleIds.length) return value;
  const owned = await client.imageStudioModule.findMany({ where: { owner_id: ownerId, id: { in: value.hiddenModuleIds } }, select: { id: true } });
  const ownedIds = new Set(owned.map(row => row.id));
  return { ...value, hiddenModuleIds: value.hiddenModuleIds.filter(id => ownedIds.has(id)) };
}

/** Called inside a transaction: only the user's preference row is written. */
export async function changeStudioNavigationPreference(client: PreferenceClient, ownerId: string, moduleId: unknown, hidden: unknown, expectedRevision: unknown) {
  if (typeof moduleId !== 'string' || !moduleIdPattern.test(moduleId) || typeof hidden !== 'boolean'
    || !Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 0) throw new StudioNavigationPreferenceError('侧栏设置参数无效');
  const owned = await client.imageStudioModule.findFirst({ where: { id: moduleId, owner_id: ownerId }, select: { id: true } });
  if (!owned) throw new StudioNavigationPreferenceError('该模块不存在或无权调整侧栏', 404);
  const row = await client.userPreference.findUnique({ where: { user_id_key: { user_id: ownerId, key: STUDIO_NAVIGATION_PREFERENCE_KEY } }, select: { id: true, value_json: true } });
  const current = parseStudioNavigationPreference(row?.value_json ?? null);
  if (current.revision !== expectedRevision) throw new StudioNavigationPreferenceError('侧栏设置已变化，请重新读取后再操作', 409);
  if (current.hiddenModuleIds.includes(moduleId) === hidden) return readStudioNavigationPreference(ownerId, client);
  if (current.revision >= Number.MAX_SAFE_INTEGER) throw new StudioNavigationPreferenceError('侧栏设置版本无法继续更新', 409);
  const next: StudioNavigationPreference = { version: 1, revision: current.revision + 1,
    hiddenModuleIds: hidden ? [...current.hiddenModuleIds, moduleId] : current.hiddenModuleIds.filter(id => id !== moduleId) };
  if (next.hiddenModuleIds.length > 1000) throw new StudioNavigationPreferenceError('侧栏移除数量已满，请先恢复部分入口');
  const value_json = JSON.stringify(next);
  if (row) {
    const changed = await client.userPreference.updateMany({ where: { id: row.id, user_id: ownerId, key: STUDIO_NAVIGATION_PREFERENCE_KEY, value_json: row.value_json }, data: { value_json } });
    if (changed.count !== 1) throw new StudioNavigationPreferenceError('侧栏设置已变化，请重新读取后再操作', 409);
  } else {
    try { await client.userPreference.create({ data: { user_id: ownerId, key: STUDIO_NAVIGATION_PREFERENCE_KEY, value_json } }); }
    catch (cause) {
      if ((cause as { code?: string })?.code === 'P2002') throw new StudioNavigationPreferenceError('侧栏设置已变化，请重新读取后再操作', 409);
      throw cause;
    }
  }
  return readStudioNavigationPreference(ownerId, client);
}
