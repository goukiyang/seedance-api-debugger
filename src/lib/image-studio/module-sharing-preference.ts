import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { recordStudioLifecycleEvent } from './shared-lifecycle-audit';

type Client = Pick<Prisma.TransactionClient, 'platformSetting'>;
export type StudioModuleSharingPreference = { version: 1; ownerId: string; moduleId: string; enabled: boolean; revision: number; requestId?: string };
export class StudioSharingPreferenceError extends Error {
  constructor(message: string, public status = 409) { super(message); }
}
export const studioModuleSharingPreferenceKey = (moduleId: string) => `studio_module_sharing_preference_v1:${moduleId}`;
export async function readStudioModuleSharingPreference(ownerId: string, moduleId: string, client: Client = prisma) {
  const row = await client.platformSetting.findUnique({ where: { key: studioModuleSharingPreferenceKey(moduleId) }, select: { value_json: true } });
  if (!row) return null;
  let value: StudioModuleSharingPreference;
  try { value = JSON.parse(row.value_json); } catch { throw new StudioSharingPreferenceError('共享设置读取失败，未改变可见范围'); }
  if (!value || value.version !== 1 || value.ownerId !== ownerId || value.moduleId !== moduleId
    || typeof value.enabled !== 'boolean' || !Number.isSafeInteger(value.revision) || value.revision < 1) {
    throw new StudioSharingPreferenceError('共享设置无法确认，未改变可见范围');
  }
  return value;
}
export async function writeStudioModuleSharingPreference(value: StudioModuleSharingPreference, client: Client & Pick<Prisma.TransactionClient, 'contentAuditLog'>,
  event?: { entryPoint?: unknown; beforeModuleRevision?: number; afterModuleRevision?: number }) {
  const previous = await readStudioModuleSharingPreference(value.ownerId, value.moduleId, client);
  const data = { value_json: JSON.stringify(value), updated_by: value.ownerId };
  await client.platformSetting.upsert({ where: { key: studioModuleSharingPreferenceKey(value.moduleId) },
    create: { key: studioModuleSharingPreferenceKey(value.moduleId), ...data }, update: data });
  if (!previous || previous.enabled !== value.enabled) await recordStudioLifecycleEvent(client, {
    actorUserId: value.ownerId, ownerUserId: value.ownerId, contentType: 'image_studio_module', contentId: value.moduleId,
    action: 'sharing-preference-changed', requestId: value.requestId, entryPoint: event?.entryPoint,
    before: { ...(previous ? { isShared: previous.enabled } : {}), moduleRevision: event?.beforeModuleRevision ?? null },
    after: { isShared: value.enabled, moduleRevision: event?.afterModuleRevision ?? null },
  });
}
