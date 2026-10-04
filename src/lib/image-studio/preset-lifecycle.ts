import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

export const archivedPresetKey = (id: string) => `studio_preset_archived_v1:${id}`;
export async function studioPresetArchived(id: string, db: Pick<Prisma.TransactionClient, 'platformSetting'> = prisma) {
  return Boolean(await db.platformSetting.findUnique({ where: { key: archivedPresetKey(id) }, select: { id: true } }));
}
