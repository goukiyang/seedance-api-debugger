import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { StudioError } from '@/lib/image-studio/tasks';
import { isAvatarSheet } from './layout';
import type { AvatarRecord } from './types';
import { avatarKey, avatarReadKeys, avatarRecordKey } from './storage-keys';
export { avatarKey, avatarPlanKey, avatarRecordKey } from './storage-keys';
export function avatarId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(id)) throw new StudioError('记录编号无效');
}
export async function readAvatar<T>(owner: string, kind: string, id: string, client: Prisma.TransactionClient | typeof prisma = prisma): Promise<T | null> {
  avatarId(id);
  for (const key of avatarReadKeys(owner,kind,id)) { const row = await client.platformSetting.findUnique({ where: { key } });if(row)return JSON.parse(row.value_json) as T; }
  return null;
}
export async function listAvatarRecords(owner: string, cursor?: string, kind?: string, deleted = false) {
  const partitions = { OR: ['record','sheet-record'].map(kind=>({key:{startsWith:`avatar:v1:${owner}:${kind}:`}})) };
  const where: Prisma.PlatformSettingWhereInput = { ...partitions, AND: [
    ...(kind ? [{ value_json: { contains: `"kind":"${kind}"` } }] : []),
    { value_json: deleted ? { not: { contains: '"deletedAt":null' } } : { contains: '"deletedAt":null' } },
  ] };
  if (cursor && !(await prisma.platformSetting.findFirst({ where: { ...where, id: cursor }, select: { id: true } }))) throw new StudioError('分页已失效，请重新读取', 409);
  const rows = await prisma.platformSetting.findMany({ where, orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: 61, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
  const recent = await prisma.platformSetting.findMany({ where: { ...partitions, AND: [{ value_json: { contains: '"kind":"config"' } }, { value_json: { contains: '"deletedAt":null' } }] }, orderBy: { updated_at: 'desc' }, take: 3 });
  return { records: rows.slice(0, 60).map(row => JSON.parse(row.value_json) as AvatarRecord), recentConfigs: recent.map(row => JSON.parse(row.value_json) as AvatarRecord), nextCursor: rows.length > 60 ? rows[59].id : null };
}
export async function mutateAvatarRecord(owner: string, input: { id?: string; revision?: number; action: string; name?: string; record?: Partial<AvatarRecord> }) {
  if (input.id !== undefined) avatarId(input.id);
  if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80)) throw new StudioError('名称须为1到80字');
  if (!['save', 'rename', 'delete', 'undelete', 'quality'].includes(input.action)) throw new StudioError('操作无效');
  return prisma.$transaction(async tx => {
    const id = input.id || `${isAvatarSheet(input.record?.rules || {})?'sheet-':''}${randomUUID()}`, key = avatarRecordKey(owner,{...input.record,id});
    const row = input.id ? await tx.platformSetting.findFirst({where:{key:{in:avatarReadKeys(owner,'record',id)}}}) : null;
    const current = row ? JSON.parse(row.value_json) as AvatarRecord : null;
    if (current && current.revision !== input.revision) throw new StudioError('记录已在另一页修改，请重新读取后保存', 409);
    if (!current && (input.action !== 'save' || !input.name || !['config', 'character'].includes(input.record?.kind || ''))) throw new StudioError('记录不存在或缺少保存内容', 404);
    if (current?.deletedAt && input.action !== 'undelete') throw new StudioError('请先撤销删除');
    const time = new Date().toISOString();
    const next: AvatarRecord = current ? { ...current, revision: current.revision + 1, updatedAt: time } : { id, kind: input.record?.kind || 'config', name: input.name || '未命名', revision: 1, deletedAt: null, createdAt: time, updatedAt: time };
    if (input.action === 'delete') next.deletedAt = time;
    else if (input.action === 'undelete') next.deletedAt = null;
    else if (input.action === 'quality') {
      if (current?.kind !== 'result' || !['unreviewed','matches','mismatch'].includes(input.record?.qualityStatus || '')) throw new StudioError('符合度状态无效');
      next.qualityStatus = input.record!.qualityStatus;
    }
    else if (input.action === 'rename') {
      if (!input.name || current?.kind === 'result') throw new StudioError('历史快照不能改写');
      next.name = input.name.trim();
    }
    else if (input.action === 'save') {
      if (current && (current.kind !== 'config' || input.record?.kind !== 'config')) throw new StudioError('已有具体人物和历史快照不能改写，请另存');
      next.name = (input.name || next.name).trim().slice(0, 80);
      if (input.record?.rules) next.rules = input.record.rules;
      if (!current && input.record?.candidate) next.candidate = input.record.candidate;
      if (!current && input.record?.assetId) next.assetId = input.record.assetId;
      if (!current && input.record?.planId) next.planId = input.record.planId;
      if (!current && input.record?.taskId) next.taskId = input.record.taskId;
      if (next.kind === 'config' && !next.rules || next.kind === 'character' && !next.candidate) throw new StudioError('保存内容无效');
    } else throw new StudioError('操作无效');
    const data = { value_json: JSON.stringify(next), updated_by: owner };
    if (row) { const saved = await tx.platformSetting.updateMany({ where: { id: row.id, value_json: row.value_json }, data }); if (!saved.count) throw new StudioError('记录已变化，请重新读取', 409); }
    else await tx.platformSetting.create({ data: { key, ...data } });
    if (next.kind === 'config' && ['save','rename'].includes(input.action)) await tx.platformSetting.create({ data: { key: avatarKey(owner,'config-version',`${id}-${next.revision}`), ...data } });
    return next;
  });
}
