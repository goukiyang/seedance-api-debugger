import { prisma } from '../prisma';

type Client = Pick<typeof prisma, 'imageStudioTask'>;
const LIMIT = 1000;

/** Two grouped reads on the (owner_id, module_id, created_at) / source_preset_id indexes: no IN lists, no write lock. */
export async function readStudioRecentUse(ownerId: string, client: Client = prisma): Promise<Record<string, number>> {
  const [modules, presets] = await Promise.all([
    client.imageStudioTask.groupBy({ by: ['module_id'], where: { owner_id: ownerId, module_id: { not: null } }, _max: { created_at: true } }),
    client.imageStudioTask.groupBy({ by: ['source_preset_id'], where: { owner_id: ownerId, source_preset_id: { not: null } }, _max: { created_at: true } }),
  ]);
  const entries: Array<[string, number]> = [
    ...modules.map(row => [`module:${row.module_id}`, row._max.created_at?.getTime() || 0] as [string, number]),
    ...presets.map(row => [`preset:${row.source_preset_id}`, row._max.created_at?.getTime() || 0] as [string, number]),
  ].filter(([, time]) => time > 0);
  entries.sort((left, right) => right[1] - left[1]);
  return Object.fromEntries(entries.slice(0, LIMIT));
}
