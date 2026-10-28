import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { canUseCompanyTemplates, type ImageStudioIdentity } from './access';
import { StudioStyleError, validateStudioSelectorPage, type StudioSelectorPageOptions } from './style-groups';
import { studioVisibleAssetWhere } from './protected-assets';
import { privateOrigin, privatePromptIndex, isStoredPrivatePrompt } from '@/lib/security/private-prompts.server';
import { privateFieldOrigins, privateStoredValue, readPrivateFields, writePrivateFields, transferPrivateOrigins } from '@/lib/security/private-prompt-fields.server';
import { privatePromptRequestCapabilities, requirePrivatePromptRequest } from '@/lib/security/private-prompt-request.server';
import type { SessionClient } from '@/lib/auth/session-store';
type Client = Pick<Prisma.TransactionClient, 'platformSetting' | 'asset'>;
const PREFIX = 'studio_skill_v1:';
const skillKey = (ownerId: string, id: string) => `${PREFIX}${ownerId}:${id}`;
export type StudioSkill = { id: string; ownerId: string; name: string; prompt: string; promptVersion: string;
  revision: number; coverAssetId: string | null; deleted?: boolean };
export type SkillSnapshot = Pick<StudioSkill, 'id' | 'name' | 'prompt' | 'promptVersion' | 'ownerId'>;
export function publicSkillVersion(skill: { id: string; promptVersion: string }) {
  return privateFieldOrigins(skill, 'promptVersion').length || privateOrigin('skill', skill.id)
    ? privatePromptIndex('skill-public-version', JSON.stringify([skill.id, skill.promptVersion])).split(':').pop()!
    : skill.promptVersion;
}
export function publicSkillSnapshot(skill: SkillSnapshot, taskId: string, index: number) {
  const origin = privateOrigin('skill', skill.id);
  const decoded = readPrivateFields(skill, 'image-task-skill', `${taskId}:${index}`,
    [{ field: 'promptVersion', origins: origin ? [origin] : [] }]);
  const protectedPrompt = Boolean(origin) || isStoredPrivatePrompt(skill.prompt) || privateFieldOrigins(skill, 'prompt').length > 0;
  return { id: skill.id, name: skill.name, ownerId: skill.ownerId, prompt: protectedPrompt ? '' : skill.prompt,
    promptVersion: publicSkillVersion(decoded), privatePrompt: protectedPrompt };
}
const storedJson = new WeakMap<object, string>();
function decodeSkill(raw: string) {
  const value = JSON.parse(raw) as StudioSkill;
  const origin = privateOrigin('skill', value.id, value.ownerId);
  const skill = readPrivateFields(value, 'skill', value.id, ['prompt', 'promptVersion'].map(field => ({ field, origins: origin ? [origin] : [] })));
  storedJson.set(skill, raw);
  return skill;
}
function encodeSkill(skill: StudioSkill, original?: StudioSkill) {
  const inherited = original ? privateFieldOrigins(original, 'prompt') : privateFieldOrigins(skill, 'prompt');
  const origin = privateOrigin('skill', skill.id, skill.ownerId);
  const origins = inherited.length ? inherited : origin ? [origin] : [];
  return JSON.stringify(writePrivateFields(skill, 'skill', skill.id, ['prompt', 'promptVersion'].map(field => ({ field, origins }))));
}
const identity = (user: ImageStudioIdentity) => { if (!canUseCompanyTemplates(user)) throw new StudioStyleError('当前账号无法使用提示词组', 403); };
export function parseSkillIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 12 || value.some(id => typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id))) throw new StudioStyleError('提示词组选择无效');
  return Array.from(new Set(value as string[]));
}
export async function getSkill(user: ImageStudioIdentity, id: string, tx: Client = prisma, historical = false) {
  identity(user); parseSkillIds([id]);
  let row = await tx.platformSetting.findUnique({ where: { key: skillKey(user.id, id) }, select: { value_json: true } });
  if (!row && user.role === 'admin') row = await tx.platformSetting.findFirst({ where: { key: { startsWith: PREFIX, endsWith: `:${id}` } }, select: { value_json: true } });
  if (!row) throw new StudioStyleError('提示词组不存在', 404);
  let skill: StudioSkill;
  try {
    skill = decodeSkill(row.value_json);
    if (skill.id !== id || typeof skill.prompt !== 'string' || !skill.promptVersion || !skill.ownerId) throw new Error();
  } catch { throw new StudioStyleError('提示词组暂时无法读取', 503); }
  if (skill.ownerId !== user.id && user.role !== 'admin') throw new StudioStyleError('提示词组不存在或无权使用', 403);
  if (skill.deleted && !historical) throw new StudioStyleError('提示词组已删除，请移除或使用历史文字副本', 409);
  return skill;
}
export async function skillDTO(skill: StudioSkill, user?: ImageStudioIdentity, includePrivate = false, client?: SessionClient) {
  const origins = privateFieldOrigins(skill, 'prompt');
  const capabilities = user ? await privatePromptRequestCapabilities(user.id, origins, client)
    : { canReadPrivatePrompt: false, canEditPrivatePrompt: false, requiresIdentityVerification: false };
  if (includePrivate && origins.length) {
    if (!user) throw new StudioStyleError('需要本人身份验证', 403);
    await requirePrivatePromptRequest(user.id, origins, client);
  }
  return { id: skill.id, ownerId: skill.ownerId, name: skill.name, revision: skill.revision,
    coverAssetId: skill.coverAssetId, deleted: skill.deleted, privatePrompt: origins.length > 0, ...capabilities,
    promptVersion: publicSkillVersion(skill),
    ...(!origins.length || includePrivate ? { prompt: skill.prompt } : {}),
    coverUrl: skill.coverAssetId ? `/api/image-studio/skills/${skill.id}/cover?revision=${skill.revision}` : null };
}
export async function resolveSkills(user: ImageStudioIdentity, value: unknown, tx: Client = prisma): Promise<SkillSnapshot[]> {
  return Promise.all(parseSkillIds(value).map(async id => {
    const skill = await getSkill(user, id, tx);
    const { name, prompt, promptVersion, ownerId } = skill;
    if (ownerId !== user.id) throw new StudioStyleError('私有提示词组只能由本人选用', 403);
    const snapshot = { id, name, prompt, promptVersion, ownerId };
    transferPrivateOrigins(skill, snapshot, ['prompt', 'promptVersion']);
    return snapshot;
  }));
}
export async function historicalSkills(user: ImageStudioIdentity, value: unknown, tx: Client = prisma): Promise<SkillSnapshot[]> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 12) throw new StudioStyleError('历史提示词组快照无效', 409);
  return Promise.all(value.map(async record => {
    const current = await getSkill(user, record?.id, tx, true);
    if (current.ownerId !== user.id) throw new StudioStyleError('历史提示词组归属已变化', 403);
    if (record.ownerId !== current.ownerId || typeof record.prompt !== 'string' || record.prompt.length > 8000
      || createHash('sha256').update(record.prompt).digest('hex') !== record.promptVersion) throw new StudioStyleError('历史提示词组快照无效', 409);
    const snapshot = { id: current.id, ownerId: current.ownerId, name: typeof record.name === 'string' ? record.name : '提示词组',
      prompt: record.prompt, promptVersion: record.promptVersion };
    transferPrivateOrigins(current, snapshot, ['prompt', 'promptVersion']);
    return snapshot;
  }));
}
export async function cloneHistoricalSkills(user: ImageStudioIdentity, value: unknown, tx: Client) {
  const snapshots = await historicalSkills(user, value, tx);
  const ids: string[] = [];
  for (const snapshot of snapshots) {
    const id = randomUUID();
    const skill: StudioSkill = { ...snapshot, id, ownerId: user.id, revision: 1, coverAssetId: null };
    transferPrivateOrigins(snapshot, skill, ['prompt', 'promptVersion']);
    await tx.platformSetting.create({ data: { key: skillKey(user.id, id), value_json: encodeSkill(skill), updated_by: user.id } });
    ids.push(id);
  }
  return ids;
}
export async function getSkillSelection(owner: string, id: string, tx: Client = prisma, kind = 'module') {
  const row = await tx.platformSetting.findUnique({ where: { key: `studio_skill_selection_v1:${kind}:${id}` }, select: { value_json: true } });
  if (!row) return [];
  const value = JSON.parse(row.value_json);
  if (value.ownerId !== owner) throw new StudioStyleError('提示词组选择归属不一致', 403);
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
  return Promise.all(rows.map(row => decodeSkill(row.value_json)).filter(s => !s.deleted && s.ownerId === user.id).map(skill => skillDTO(skill, user)));
}
export async function listSkillsPage(user: ImageStudioIdentity, options: StudioSelectorPageOptions = {}) {
  identity(user); validateStudioSelectorPage(options);
  if (options.keys && !options.keys.length) return { skills: [], nextCursor: null };
  const prefix = `${PREFIX}${user.id}:`, query = options.query?.trim() || '';
  // Ownership is filtered before matching any prompt; even admins keep the existing own-list scope.
  const matches: Array<{ key: string; skill: StudioSkill }> = [];
  let cursor = options.cursor ? prefix + options.cursor : '';
  while (matches.length < 49) {
  const rows = await prisma.$queryRaw<Array<{ key: string; value_json: string }>>(Prisma.sql`
    SELECT key, value_json FROM PlatformSetting
    WHERE key >= ${prefix} AND key < ${prefix + '\uffff'}
      AND json_valid(value_json) AND json_extract(value_json, '$.ownerId') = ${user.id}
      AND COALESCE(json_extract(value_json, '$.deleted'), 0) != 1
      ${cursor ? Prisma.sql`AND key > ${cursor}` : Prisma.empty}
      ${options.keys ? Prisma.sql`AND key IN (${Prisma.join(options.keys.map(id => prefix + id))})` : Prisma.empty}
    ORDER BY key ASC LIMIT 128`);
  for (const row of rows) {
    const skill = decodeSkill(row.value_json);
    const origins = privateFieldOrigins(skill, 'prompt');
    const canSearchPrompt = !origins.length || (await privatePromptRequestCapabilities(user.id, origins)).canReadPrivatePrompt;
    if (!query || skill.name.toLowerCase().includes(query.toLowerCase())
      || canSearchPrompt && skill.prompt.toLowerCase().includes(query.toLowerCase())) matches.push({ key: row.key, skill });
    if (matches.length === 49) break;
  }
  if (rows.length < 128) break;
  cursor = rows[rows.length - 1].key;
  }
  const page = matches.slice(0, 48);
  return { skills: await Promise.all(page.map(row => skillDTO(row.skill, user))),
    nextCursor: matches.length > 48 ? page[page.length - 1].key.slice(prefix.length) : null };
}
export async function saveSkill(user: ImageStudioIdentity, body: Record<string, unknown>) {
  identity(user);
  return prisma.$transaction(tx => saveSkillInTx(user, body, tx));
}
export async function saveSkillInTx(user: ImageStudioIdentity, body: Record<string, unknown>, tx: Client & SessionClient,
  privateEdit = false) {
  identity(user);
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : '新建提示词组';
  const id = body.id ? String(body.id) : randomUUID();
    const current = body.id ? await getSkill(user, id, tx) : null;
    const source = !current && typeof body.copyFromId === 'string' ? await getSkill(user, body.copyFromId, tx) : null;
    if (source && source.revision !== body.copyFromRevision) throw new StudioStyleError('提示词组已更新，请重新打开', 409);
    const origin = privateOrigin('skill', id, current?.ownerId || user.id);
    const origins = current ? privateFieldOrigins(current, 'prompt') : source ? privateFieldOrigins(source, 'prompt') : origin ? [origin] : [];
    if (origins.length && (privateEdit || !current)) await requirePrivatePromptRequest(user.id, origins, tx);
    if (current && origins.length && !privateEdit && Object.prototype.hasOwnProperty.call(body, 'prompt')) throw new StudioStyleError('请通过原文入口修改提示词', 403);
    const prompt = source?.prompt ?? (current && origins.length && !privateEdit ? current.prompt : typeof body.prompt === 'string' ? body.prompt : '');
    if (!prompt.trim() || prompt.length > 8000 || name.length > 80) throw new StudioStyleError('请填写8000字以内的提示词，名称最多80字');
    if (current && current.revision !== body.revision) throw new StudioStyleError('提示词组已更新，请重新打开', 409);
    const coverAssetId = typeof body.coverAssetId === 'string' && body.coverAssetId ? body.coverAssetId : null;
    if (coverAssetId && coverAssetId !== current?.coverAssetId && !await tx.asset.findFirst({ where: { id: coverAssetId, owner_id: user.id,
      type: 'image', status: 'active', AND: [await studioVisibleAssetWhere(user, tx)] }, select: { id: true } })) throw new StudioStyleError('封面不存在或无权使用', 403);
    const next: StudioSkill = { id, ownerId: current?.ownerId || user.id, name, prompt,
      promptVersion: createHash('sha256').update(prompt).digest('hex'), coverAssetId, revision: (current?.revision || 0) + 1 };
    if (source) transferPrivateOrigins(source, next, ['prompt', 'promptVersion']);
    const key = skillKey(next.ownerId, id), value_json = current && origins.length && !privateEdit
      ? JSON.stringify({ ...privateStoredValue(current), name, coverAssetId, revision: next.revision })
      : encodeSkill(next, current || source || undefined);
    if (current) {
      const updated = await tx.platformSetting.updateMany({ where: { key, value_json: storedJson.get(current)! }, data: { value_json, updated_by: user.id } });
      if (!updated.count) throw new StudioStyleError('提示词组已更新，请重新打开', 409);
    } else await tx.platformSetting.create({ data: { key, value_json, updated_by: user.id } });
    return skillDTO(decodeSkill(value_json), user, false, tx);
}
export async function deleteSkill(user: ImageStudioIdentity, body: Record<string, unknown>) {
  const skill = await getSkill(user, String(body.id));
  const origins = privateFieldOrigins(skill, 'prompt');
  if (origins.length) await requirePrivatePromptRequest(user.id, origins);
  if (skill.revision !== body.revision) throw new StudioStyleError('提示词组已更新，请重新打开', 409);
  const updated = await prisma.platformSetting.updateMany({ where: { key: skillKey(skill.ownerId, skill.id), value_json: storedJson.get(skill)! },
    data: { value_json: JSON.stringify({ ...privateStoredValue(skill), deleted: true, revision: skill.revision + 1 }), updated_by: user.id } });
  if (!updated.count) throw new StudioStyleError('提示词组已更新，请重新打开', 409);
}
