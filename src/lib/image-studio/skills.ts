import { createHash, randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { canUseCompanyTemplates, type ImageStudioIdentity } from './access';
import { StudioStyleError } from './style-groups';
import { studioVisibleAssetWhere } from './protected-assets';
type Client = Pick<Prisma.TransactionClient, 'platformSetting' | 'asset'>;
const PREFIX = 'studio_skill_v1:';
const skillKey = (ownerId: string, id: string) => `${PREFIX}${ownerId}:${id}`;
export type StudioSkill = { id: string; ownerId: string; name: string; prompt: string; promptVersion: string;
  revision: number; coverAssetId: string | null; deleted?: boolean };
export type SkillSnapshot = Pick<StudioSkill, 'id' | 'name' | 'prompt' | 'promptVersion' | 'ownerId'>;
const identity = (user: ImageStudioIdentity) => { if (!canUseCompanyTemplates(user)) throw new StudioStyleError('当前账号无法使用skills', 403); };
export function parseSkillIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 12 || value.some(id => typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id))) throw new StudioStyleError('skills选择无效');
  return Array.from(new Set(value as string[]));
}
export async function getSkill(user: ImageStudioIdentity, id: string, tx: Client = prisma, historical = false) {
  identity(user); parseSkillIds([id]);
  let row = await tx.platformSetting.findUnique({ where: { key: skillKey(user.id, id) }, select: { value_json: true } });
  if (!row && user.role === 'admin') row = await tx.platformSetting.findFirst({ where: { key: { startsWith: PREFIX, endsWith: `:${id}` } }, select: { value_json: true } });
  if (!row) throw new StudioStyleError('skills不存在', 404);
  let skill: StudioSkill;
  try {
    skill = JSON.parse(row.value_json);
    if (skill.id !== id || typeof skill.prompt !== 'string' || !skill.promptVersion || !skill.ownerId) throw new Error();
  } catch { throw new StudioStyleError('skills暂时无法读取', 503); }
  if (skill.ownerId !== user.id && user.role !== 'admin') throw new StudioStyleError('skills不存在或无权使用', 403);
  if (skill.deleted && !historical) throw new StudioStyleError('skills已删除，请移除或使用历史文字副本', 409);
  return skill;
}
export const skillDTO = (skill: StudioSkill) => ({ ...skill,
  coverUrl: skill.coverAssetId ? `/api/image-studio/skills/${skill.id}/cover?revision=${skill.revision}` : null });
export async function resolveSkills(user: ImageStudioIdentity, value: unknown, tx: Client = prisma): Promise<SkillSnapshot[]> {
  return Promise.all(parseSkillIds(value).map(async id => {
    const { name, prompt, promptVersion, ownerId } = await getSkill(user, id, tx);
    if (ownerId !== user.id) throw new StudioStyleError('私有skills只能由本人选用', 403);
    return { id, name, prompt, promptVersion, ownerId };
  }));
}
export async function historicalSkills(user: ImageStudioIdentity, value: unknown, tx: Client = prisma): Promise<SkillSnapshot[]> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 12) throw new StudioStyleError('历史skills快照无效', 409);
  return Promise.all(value.map(async record => {
    const current = await getSkill(user, record?.id, tx, true);
    if (current.ownerId !== user.id) throw new StudioStyleError('历史skills归属已变化', 403);
    if (record.ownerId !== current.ownerId || typeof record.prompt !== 'string' || record.prompt.length > 8000
      || createHash('sha256').update(record.prompt).digest('hex') !== record.promptVersion) throw new StudioStyleError('历史skills快照无效', 409);
    return { id: current.id, ownerId: current.ownerId, name: typeof record.name === 'string' ? record.name : 'skills',
      prompt: record.prompt, promptVersion: record.promptVersion };
  }));
}
export async function cloneHistoricalSkills(user: ImageStudioIdentity, value: unknown, tx: Client) {
  const snapshots = await historicalSkills(user, value, tx);
  const ids: string[] = [];
  for (const snapshot of snapshots) {
    const id = randomUUID();
    const skill: StudioSkill = { ...snapshot, id, ownerId: user.id, revision: 1, coverAssetId: null };
    await tx.platformSetting.create({ data: { key: skillKey(user.id, id), value_json: JSON.stringify(skill), updated_by: user.id } });
    ids.push(id);
  }
  return ids;
}
export async function getSkillSelection(owner: string, id: string, tx: Client = prisma, kind = 'module') {
  const row = await tx.platformSetting.findUnique({ where: { key: `studio_skill_selection_v1:${kind}:${id}` }, select: { value_json: true } });
  if (!row) return [];
  const value = JSON.parse(row.value_json);
  if (value.ownerId !== owner) throw new StudioStyleError('skills选择归属不一致', 403);
  return parseSkillIds(value.ids);
}
export async function setSkillSelection(user: ImageStudioIdentity, id: string, value: unknown, tx: Client = prisma, kind = 'module') {
  const ids = parseSkillIds(value); await resolveSkills(user, ids, tx);
  const key = `studio_skill_selection_v1:${kind}:${id}`, value_json = JSON.stringify({ ownerId: user.id, ids });
  await tx.platformSetting.upsert({ where: { key }, create: { key, value_json, updated_by: user.id }, update: { value_json, updated_by: user.id } });
}
export async function listSkills(user: ImageStudioIdentity) {
  identity(user);
  const rows = await prisma.platformSetting.findMany({ where: { key: { startsWith: `${PREFIX}${user.id}:` } }, select: { value_json: true } });
  return rows.map(row => JSON.parse(row.value_json) as StudioSkill).filter(s => !s.deleted && s.ownerId === user.id).map(skillDTO);
}
export async function saveSkill(user: ImageStudioIdentity, body: Record<string, unknown>) {
  identity(user);
  const prompt = typeof body.prompt === 'string' ? body.prompt : '';
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : '新建skills';
  if (!prompt.trim() || prompt.length > 8000 || name.length > 80) throw new StudioStyleError('请填写8000字以内的提示词，名称最多80字');
  const id = body.id ? String(body.id) : randomUUID();
  return prisma.$transaction(async tx => {
    const current = body.id ? await getSkill(user, id, tx) : null;
    if (current && current.revision !== body.revision) throw new StudioStyleError('skills已更新，请重新打开', 409);
    const coverAssetId = typeof body.coverAssetId === 'string' && body.coverAssetId ? body.coverAssetId : null;
    if (coverAssetId && coverAssetId !== current?.coverAssetId && !await tx.asset.findFirst({ where: { id: coverAssetId, owner_id: user.id,
      type: 'image', status: 'active', AND: [await studioVisibleAssetWhere(user, tx)] }, select: { id: true } })) throw new StudioStyleError('封面不存在或无权使用', 403);
    const next: StudioSkill = { id, ownerId: current?.ownerId || user.id, name, prompt,
      promptVersion: createHash('sha256').update(prompt).digest('hex'), coverAssetId, revision: (current?.revision || 0) + 1 };
    const key = skillKey(next.ownerId, id), value_json = JSON.stringify(next);
    if (current) {
      const updated = await tx.platformSetting.updateMany({ where: { key, value_json: JSON.stringify(current) }, data: { value_json, updated_by: user.id } });
      if (!updated.count) throw new StudioStyleError('skills已更新，请重新打开', 409);
    } else await tx.platformSetting.create({ data: { key, value_json, updated_by: user.id } });
    return skillDTO(next);
  });
}
export async function deleteSkill(user: ImageStudioIdentity, body: Record<string, unknown>) {
  const skill = await getSkill(user, String(body.id));
  if (skill.revision !== body.revision) throw new StudioStyleError('skills已更新，请重新打开', 409);
  const updated = await prisma.platformSetting.updateMany({ where: { key: skillKey(skill.ownerId, skill.id), value_json: JSON.stringify(skill) },
    data: { value_json: JSON.stringify({ ...skill, deleted: true, revision: skill.revision + 1 }), updated_by: user.id } });
  if (!updated.count) throw new StudioStyleError('skills已更新，请重新打开', 409);
}
