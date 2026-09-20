import { createHash } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { normalizeStudioRatio, STUDIO_RATIOS } from './ratios';

const prefix = (ownerId: string) => `image-ratio:${createHash('sha256').update(ownerId).digest('hex')}:`;
export async function listStudioRatios(ownerId: string) {
  const rows = await prisma.platformSetting.findMany({ where: { key: { startsWith: prefix(ownerId) } }, orderBy: { created_at: 'asc' }, take: 32, select: { value_json: true } });
  return rows.map(row => JSON.parse(row.value_json) as string);
}
export async function changeStudioRatio(ownerId: string, value: unknown, remove = false) {
  const ratio = normalizeStudioRatio(value);
  if (ratio === 'auto' || STUDIO_RATIOS.some(item => normalizeStudioRatio(item) === ratio)) {
    if (remove) throw new Error('常用比例不能删除');
    return listStudioRatios(ownerId);
  }
  const key = `${prefix(ownerId)}${ratio}`;
  await prisma.$transaction(async tx => {
    if (remove) { await tx.platformSetting.deleteMany({ where: { key } }); return; }
    if (await tx.platformSetting.findUnique({ where: { key } })) return;
    if (await tx.platformSetting.count({ where: { key: { startsWith: prefix(ownerId) } } }) >= 32) throw new Error('最多保存 32 个自定义比例，请先删除不再使用的比例');
    await tx.platformSetting.create({ data: { key, value_json: JSON.stringify(ratio), updated_by: ownerId } });
  });
  return listStudioRatios(ownerId);
}
