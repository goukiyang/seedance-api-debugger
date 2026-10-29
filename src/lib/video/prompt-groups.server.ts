import 'server-only';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { SessionUser } from '@/lib/auth/session';
import { canUseCompanyTemplates } from '@/lib/image-studio/access';
import { studioVisibleAssetWhere } from '@/lib/image-studio/protected-assets';
import { privateOrigin, privatePromptIndex, sealPrivatePrompt, openPrivatePrompt, PrivatePromptError, type PrivateOrigin } from '@/lib/security/private-prompts.server';
import { privatePromptCapabilities, requirePrivatePromptIdentity } from '@/lib/security/private-prompt-identity.server';
import { parseVideoPromptGroupRefs, composeVideoPromptGroups, VideoPromptGroupError,
  type VideoPromptGroupRef, type VideoPromptGroupSummary } from './prompt-groups';
import { exceedsGenerationPromptLimit, GENERATION_PROMPT_LIMIT_MESSAGE } from '@/lib/prompt/limits';
import { readPrivatePromptDraft, savePrivatePromptDraft, readPrivatePromptDraftReceipt, clearAppliedPrivatePromptDraft } from '@/lib/security/private-prompt-drafts.server';
import { VIDEO_PROMPT_GROUP_WRITES_ENABLED } from './prompt-groups-build-mode';

type Client = Pick<Prisma.TransactionClient, 'platformSetting' | 'asset' | 'user'>;
type Head = { schema: 1; id: string; ownerId: string; versionId: string; revision: number; shared: boolean; disabled: boolean; deleted?: boolean };
type Version = { schema: 1; groupId: string; versionId: string; name: string; description: string; conditions: string;
  coverAssetId: string | null; body: string; operatorId: string; createdAt: string; source?: VideoPromptGroupRef; coverOwnerId?: string };
const PREFIX = 'video_prompt_group_v1:';
const headKey = (id: string) => PREFIX + id;
const versionKey = (id: string, version: string) => `video_prompt_group_version_v1:${id}:${version}`;
const receiptKey = (userId: string, requestId: string) => `video_prompt_group_receipt_v1:${userId}:${requestId}`;
const hash = (v: unknown) => privatePromptIndex('video-prompt-group-fingerprint', JSON.stringify(v));
function internal(user: SessionUser) {
  if (!canUseCompanyTemplates(user)) throw new VideoPromptGroupError('当前账号不能使用同事提示词组', 403);
}
// A separate namespace, using the existing author/identity policy for textual skills.
// This does not alter the old image skill catalog or grant new private identities.
function origins(head: Pick<Head, 'id' | 'ownerId'>): PrivateOrigin[] {
  const origin = privateOrigin('skill', `video-group:${head.id}`, head.ownerId);
  if (!origin) throw new PrivatePromptError();
  return [origin];
}
function binding(head: Head, versionId: string) {
  return { kind: 'video-prompt-group-version', id: `${head.id}:${versionId}`, field: 'body', origins: origins(head) };
}
function canUse(user: SessionUser, head: Head) { return head.ownerId === user.id || head.shared && canUseCompanyTemplates(user); }
function requireManage(user: SessionUser, head: Pick<Head, 'id' | 'ownerId'>) {
  internal(user);
  requirePrivatePromptIdentity(user, origins(head));
  if (head.ownerId !== user.id && user.role !== 'admin') throw new VideoPromptGroupError('无权维护该提示词组', 403);
}
export function videoPromptGroupCreateCapability(user: SessionUser) {
  if (!VIDEO_PROMPT_GROUP_WRITES_ENABLED) return false;
  if (!canUseCompanyTemplates(user)) return false;
  try { return privatePromptCapabilities(user, origins({ id: 'new', ownerId: user.id })).canEditPrivatePrompt; } catch { return false; }
}
export function videoPromptGroupCreateState(user: SessionUser) {
  if (!VIDEO_PROMPT_GROUP_WRITES_ENABLED) return { canCreate: false, createReason: '当前运行的是历史兼容版本，暂不接受新建' };
  if (!canUseCompanyTemplates(user)) return { canCreate: false, createReason: '仅公司账号可创建提示词组' };
  try {
    const capability = privatePromptCapabilities(user, origins({ id: 'new', ownerId: user.id }));
    return { canCreate: capability.canEditPrivatePrompt,
      createReason: capability.canEditPrivatePrompt ? '' : '请先通过飞书验证创作者身份，再新建提示词组',
      requiresIdentityVerification: capability.requiresIdentityVerification };
  } catch { return { canCreate: false, createReason: '暂时无法确认新建权限，请刷新重试或联系管理员' }; }
}
export async function readVideoPromptGroup(user: SessionUser, ref: VideoPromptGroupRef, client: Client = prisma, manage = false) {
  internal(user); parseVideoPromptGroupRefs([ref]);
  const row = await client.platformSetting.findUnique({ where: { key: headKey(ref.groupId) }, select: { value_json: true } });
  if (!row) throw new VideoPromptGroupError('提示词组已不可用，请移除或替换');
  const head = JSON.parse(row.value_json) as Head;
  if (head.schema !== 1 || head.id !== ref.groupId || !Number.isSafeInteger(head.revision) || head.revision < 1
    || typeof head.ownerId !== 'string' || typeof head.shared !== 'boolean' || typeof head.disabled !== 'boolean') throw new PrivatePromptError();
  if (manage) requireManage(user, head);
  else if (!canUse(user, head)) throw new VideoPromptGroupError('提示词组不可用或使用权限已变化', 403);
  const saved = await client.platformSetting.findUnique({ where: { key: versionKey(head.id, ref.versionId) }, select: { value_json: true } });
  if (!saved) throw new VideoPromptGroupError('提示词组版本已不可用，请移除或替换');
  const version = JSON.parse(saved.value_json) as Version;
  if (version.schema !== 1 || version.groupId !== head.id || version.versionId !== ref.versionId
    || typeof version.body !== 'string' || !version.body.startsWith('ppenc:')) throw new PrivatePromptError();
  return { head, version, rawHead: row.value_json };
}
export async function videoPromptGroupSummary(user: SessionUser, ref: VideoPromptGroupRef, client: Client = prisma, management = false): Promise<VideoPromptGroupSummary> {
  const { head, version } = await readVideoPromptGroup(user, ref, client, management);
  const author = await client.user.findUnique({ where: { id: head.ownerId }, select: { id: true, name: true, username: true, avatar_url: true } });
  const canManage = privatePromptCapabilities(user, origins(head)).canEditPrivatePrompt;
  return { ...ref, name: version.name, description: version.description, conditions: version.conditions,
    revision: head.revision, ownerId: head.ownerId, author: author || { id: head.ownerId, name: '原作者', avatar_url: null },
    shared: head.shared, disabled: head.disabled, deleted: head.deleted === true, latestVersionId: head.versionId, canManage: canManage && !head.deleted,
    canReadContent: canManage, canCopy: canManage && VIDEO_PROMPT_GROUP_WRITES_ENABLED,
    coverUrl: version.coverAssetId ? `/api/video/prompt-groups/${head.id}/cover?version=${ref.versionId}` : null,
    ...(head.deleted || head.disabled ? { unavailable: true, reason: head.deleted ? '已删除，历史保留，请移除或替换' : '已停用，请移除或替换' } : {}) };
}
export async function videoPromptGroupSelections(user: SessionUser, value: unknown, client: Client = prisma) {
  return Promise.all(parseVideoPromptGroupRefs(value).map(async ref => {
    try { return await videoPromptGroupSummary(user, ref, client); }
    catch (error) {
      if (!(error instanceof VideoPromptGroupError)) throw error;
      return { ...ref, unavailable: true, name: '提示词组不可用', reason: '版本或使用权限已变化，请移除或替换' };
    }
  }));
}
export async function listVideoPromptGroups(user: SessionUser, input: { query?: string; scope?: string; cursor?: string; selected?: boolean }) {
  internal(user);
  const query = (input.query || '').trim().toLocaleLowerCase();
  if (query.length > 160 || input.cursor && !/^[0-9a-f-]{36}$/i.test(input.cursor)) throw new VideoPromptGroupError('筛选条件无效', 400);
  const matches: VideoPromptGroupSummary[] = [];
  const manageDirectory = user.role === 'admin' && privatePromptCapabilities(user, []).canEditPrivatePrompt;
  let cursor = input.cursor || '';
  while (matches.length < 25) {
    // Authorization precedes pagination; encrypted text is never decoded or searched.
    const rows = await prisma.$queryRaw<Array<{ key: string; value_json: string }>>(Prisma.sql`
      SELECT key, value_json FROM PlatformSetting
      WHERE key >= ${PREFIX} AND key < ${PREFIX + '\uffff'} AND json_valid(value_json)
      AND (json_extract(value_json, '$.ownerId') = ${user.id} OR json_extract(value_json, '$.shared') = 1 OR ${manageDirectory ? 1 : 0} = 1)
      AND COALESCE(json_extract(value_json, '$.deleted'), 0) != 1
      ${input.scope === 'mine' ? Prisma.sql`AND json_extract(value_json, '$.ownerId') = ${user.id}` : Prisma.empty}
      ${input.scope === 'shared' ? Prisma.sql`AND json_extract(value_json, '$.shared') = 1` : Prisma.empty}
      ${cursor ? Prisma.sql`AND key > ${headKey(cursor)}` : Prisma.empty}
      ORDER BY key LIMIT 64`);
    for (const row of rows) {
      const head = JSON.parse(row.value_json) as Head;
      if (head.disabled && head.ownerId !== user.id && !manageDirectory) continue;
      const item = await videoPromptGroupSummary(user, { groupId: head.id, versionId: head.versionId }, prisma, manageDirectory);
      if (!canUse(user, head)) Object.assign(item, { unavailable: true, reason: '仅原作者可执行；管理员可维护' });
      if (query && ![item.name, item.author.name, item.author.username || ''].some(v => v.toLocaleLowerCase().includes(query))) continue;
      matches.push(item);
      if (matches.length === 25) break;
    }
    if (rows.length < 64) break;
    cursor = rows[rows.length - 1].key.slice(PREFIX.length);
  }
  return { groups: matches.slice(0, 24), nextCursor: matches.length > 24 ? matches[23].groupId : null,
    ...videoPromptGroupCreateState(user) };
}
export async function resolveVideoPromptGroups(user: SessionUser, value: unknown, personal: string, client: Client = prisma) {
  const refs = parseVideoPromptGroupRefs(value);
  if (!refs.length) return { refs, prompt: personal, origins: [] as PrivateOrigin[], fingerprint: '' };
  const bodies: string[] = [], allOrigins: PrivateOrigin[] = [];
  for (const ref of refs) {
    const { head, version } = await readVideoPromptGroup(user, ref, client);
    if (head.deleted || head.disabled) throw new VideoPromptGroupError(head.deleted ? '已选提示词组已删除，请移除或替换' : '已选提示词组已停用，请移除或替换');
    const body = openPrivatePrompt(version.body, binding(head, ref.versionId));
    bodies.push(body); allOrigins.push(...origins(head));
  }
  const prompt = composeVideoPromptGroups(personal, bodies);
  if (exceedsGenerationPromptLimit(prompt)) throw new VideoPromptGroupError(`组合后${GENERATION_PROMPT_LIMIT_MESSAGE}，请减少组或缩短个人描述`, 400);
  return { refs, prompt, origins: allOrigins, fingerprint: hash([refs, personal, bodies]) };
}
export async function readVideoPromptGroupEditor(user: SessionUser, ref: VideoPromptGroupRef, latest = false) {
  let { head, version } = await readVideoPromptGroup(user, ref, prisma, true);
  if (head.deleted) throw new VideoPromptGroupError('原组已删除，仅保留历史查看，不能编辑');
  if (latest && head.versionId !== ref.versionId) {
    ref = { groupId: head.id, versionId: head.versionId };
    ({ head, version } = await readVideoPromptGroup(user, ref, prisma, true));
  }
  return { ...await videoPromptGroupSummary(user, ref, prisma, true), revision: head.revision, latestVersionId: head.versionId,
    shared: head.shared, disabled: head.disabled, body: openPrivatePrompt(version.body, binding(head, ref.versionId)),
    coverAssetId: version.coverAssetId, draft: await readPrivatePromptDraft(user.id, draftTarget(head)) };
}
export async function readVideoPromptGroupDetail(user: SessionUser, ref: VideoPromptGroupRef) {
  const { head, version } = await readVideoPromptGroup(user, ref, prisma, user.role === 'admin' && privatePromptCapabilities(user, []).canReadPrivatePrompt);
  const summary = await videoPromptGroupSummary(user, ref, prisma, user.role === 'admin' && privatePromptCapabilities(user, []).canReadPrivatePrompt);
  const canRead = privatePromptCapabilities(user, origins(head)).canReadPrivatePrompt;
  return { ...summary, ...(canRead ? { body: openPrivatePrompt(version.body, binding(head, ref.versionId)), coverAssetId: version.coverAssetId } : {}) };
}
export async function videoPromptGroupVersions(user: SessionUser, ref: VideoPromptGroupRef) {
  const { head } = await readVideoPromptGroup(user, ref, prisma, true);
  const prefix = `video_prompt_group_version_v1:${head.id}:`;
  const rows = await prisma.platformSetting.findMany({ where: { key: { startsWith: prefix } }, orderBy: { created_at: 'desc' }, take: 24, select: { value_json: true } });
  return rows.map(row => {
    const version = JSON.parse(row.value_json) as Version;
    return { groupId: head.id, versionId: version.versionId, name: version.name, createdAt: version.createdAt, current: version.versionId === head.versionId };
  });
}
const draftTarget = (head: Pick<Head, 'id' | 'ownerId'>) => ({ kind: 'video-prompt-group', id: head.id, origins: origins(head), fields: ['body', 'metadata'] });
export async function videoPromptGroupDraft(user: SessionUser, groupId: string, input?: Parameters<typeof savePrivatePromptDraft>[2], requestId?: string) {
  if (input && !VIDEO_PROMPT_GROUP_WRITES_ENABLED) throw new VideoPromptGroupError('此版本只保留历史草稿读取，未保存，请更新后继续', 426);
  parseVideoPromptGroupRefs([{ groupId, versionId: groupId }]);
  const row = await prisma.platformSetting.findUnique({ where: { key: headKey(groupId) }, select: { value_json: true } });
  const head = row ? JSON.parse(row.value_json) as Head : { id: groupId, ownerId: user.id };
  requireManage(user, head);
  if (input && 'deleted' in head && head.deleted) throw new VideoPromptGroupError('原组已删除，未更新草稿');
  const target = draftTarget(head);
  if (input) return savePrivatePromptDraft(user.id, target, input);
  return requestId ? readPrivatePromptDraftReceipt(user.id, target, requestId) : readPrivatePromptDraft(user.id, target);
}
export async function videoPromptGroupSaveStatus(user: SessionUser, requestId: string) {
  internal(user);
  if (!/^[A-Za-z0-9:_-]{1,160}$/.test(requestId)) throw new VideoPromptGroupError('保存编号无效', 400);
  const row = await prisma.platformSetting.findUnique({ where: { key: receiptKey(user.id, requestId) }, select: { value_json: true } });
  if (!row) return { state: 'unknown', requestId };
  const saved = JSON.parse(row.value_json);
  const ref = { groupId: saved.groupId, versionId: saved.versionId };
  await readVideoPromptGroup(user, ref, prisma, true);
  return { state: saved.state, requestId, ...ref, revision: saved.revision };
}
export async function saveVideoPromptGroup(user: SessionUser, input: Record<string, unknown>) {
  internal(user);
  if (!VIDEO_PROMPT_GROUP_WRITES_ENABLED) throw new VideoPromptGroupError('此版本只保留历史读取，尚未保存，请更新后继续', 426);
  const requestId = input.requestId;
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9:_-]{1,160}$/.test(requestId)) throw new VideoPromptGroupError('保存编号无效', 400);
  if (typeof input.groupId !== 'string') throw new VideoPromptGroupError('缺少原提示词组编号，请保留输入并重新读取', 400);
  const groupId = input.groupId;
  parseVideoPromptGroupRefs([{ groupId, versionId: groupId }]);
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const body = typeof input.body === 'string' ? input.body : '';
  const description = typeof input.description === 'string' ? input.description.trim() : '';
  const conditions = typeof input.conditions === 'string' ? input.conditions.trim() : '';
  const coverAssetId = typeof input.coverAssetId === 'string' && input.coverAssetId ? input.coverAssetId : null;
  if (!name || name.length > 80 || !body.trim() || body.length > 8000 || description.length > 800 || conditions.length > 800
    || typeof input.shared !== 'boolean' || typeof input.disabled !== 'boolean' || !Number.isSafeInteger(input.revision)
    || (input.revision as number) < 0) throw new VideoPromptGroupError('请检查名称、内部正文和所见版本', 400);
  // All private identity checks happen before opening SQLite's write transaction.
  const existing = await prisma.platformSetting.findUnique({ where: { key: headKey(groupId) }, select: { value_json: true } });
  const current = existing ? JSON.parse(existing.value_json) as Head : null;
  const authority = current || { id: groupId, ownerId: user.id };
  requireManage(user, authority);
  let source: VideoPromptGroupRef | undefined;
  let sourceCoverOwner: string | undefined;
  if (input.copyFrom !== undefined) {
    [source] = parseVideoPromptGroupRefs([input.copyFrom]);
    const original = await readVideoPromptGroup(user, source, prisma, true);
    if (coverAssetId && coverAssetId === original.version.coverAssetId) sourceCoverOwner = original.version.coverOwnerId || original.head.ownerId;
  }
  const fingerprint = hash([groupId, input.revision, name, body, description, conditions, coverAssetId, input.shared, input.disabled, source]);
  return prisma.$transaction(async tx => {
    const prior = await tx.platformSetting.findUnique({ where: { key: receiptKey(user.id, requestId) }, select: { value_json: true } });
    if (prior) {
      const saved = JSON.parse(prior.value_json);
      if (saved.fingerprint !== fingerprint) throw new VideoPromptGroupError('原保存内容不同，请核对原操作', 409);
      return { state: saved.state, requestId, groupId: saved.groupId, versionId: saved.versionId, revision: saved.revision };
    }
    const fresh = await tx.platformSetting.findUnique({ where: { key: headKey(groupId) }, select: { value_json: true } });
    const head = fresh ? JSON.parse(fresh.value_json) as Head : null;
    if (head?.deleted) throw new VideoPromptGroupError('原组已删除，当前输入保留，可另存副本');
    if (source && head) throw new VideoPromptGroupError('另存必须使用新组编号，原组未修改');
    if (head && head.ownerId !== authority.ownerId) throw new VideoPromptGroupError('作者身份已变化，未保存', 409);
    if ((head?.revision || 0) !== input.revision) {
      if (!head) throw new VideoPromptGroupError('原提示词组已不可用', 409);
      const result = { state: 'conflict', requestId, groupId, versionId: head.versionId, revision: head.revision };
      await tx.platformSetting.create({ data: { key: receiptKey(user.id, requestId), value_json: JSON.stringify({ ...result, fingerprint }), updated_by: user.id } });
      return result;
    }
    const previous = head ? (await readVideoPromptGroup(user, { groupId, versionId: head.versionId }, tx, true)).version : null;
    const inheritedCoverOwner = sourceCoverOwner || (previous?.coverAssetId === coverAssetId ? previous?.coverOwnerId : undefined);
    const provenance = source || previous?.source;
    if (coverAssetId) {
      const cover = await tx.asset.findFirst({ where: { id: coverAssetId, owner_id: inheritedCoverOwner || authority.ownerId, status: 'active', type: 'image',
        AND: [await studioVisibleAssetWhere(user, tx)] }, select: { id: true } });
      if (!cover) throw new VideoPromptGroupError('封面不可用，请选择作者有权使用的图片', 403);
    }
    const next: Head = { schema: 1, id: groupId, ownerId: authority.ownerId, versionId: randomUUID(),
      revision: (head?.revision || 0) + 1, shared: source ? false : input.shared as boolean, disabled: input.disabled as boolean };
    const version: Version = { schema: 1, groupId, versionId: next.versionId, name, description, conditions, coverAssetId,
      body: sealPrivatePrompt(body, binding(next, next.versionId)), operatorId: user.id, createdAt: new Date().toISOString(), ...(provenance ? { source: provenance } : {}), ...(inheritedCoverOwner ? { coverOwnerId: inheritedCoverOwner } : {}) };
    await tx.platformSetting.create({ data: { key: versionKey(groupId, next.versionId), value_json: JSON.stringify(version), updated_by: user.id } });
    if (fresh) {
      const update = await tx.platformSetting.updateMany({ where: { key: headKey(groupId), value_json: fresh.value_json },
        data: { value_json: JSON.stringify(next), updated_by: user.id } });
      if (update.count !== 1) throw new VideoPromptGroupError('提示词组已有更新，当前输入保留', 409);
    } else await tx.platformSetting.create({ data: { key: headKey(groupId), value_json: JSON.stringify(next), updated_by: user.id } });
    const result = { state: 'saved', requestId, groupId, versionId: next.versionId, revision: next.revision };
    await clearAppliedPrivatePromptDraft(user.id, draftTarget(next), input.draftRevision, tx);
    await tx.platformSetting.create({ data: { key: receiptKey(user.id, requestId), value_json: JSON.stringify({ ...result, fingerprint }), updated_by: user.id } });
    return result;
  });
}

export async function deleteVideoPromptGroup(user: SessionUser, input: Record<string, unknown>) {
  internal(user);
  if (!VIDEO_PROMPT_GROUP_WRITES_ENABLED) throw new VideoPromptGroupError('此版本只保留历史读取，未删除', 426);
  const [ref] = parseVideoPromptGroupRefs([{ groupId: input.groupId, versionId: input.versionId }]);
  const requestId = input.requestId;
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9:_-]{1,160}$/.test(requestId) || !Number.isSafeInteger(input.revision)) throw new VideoPromptGroupError('删除编号或版本无效', 400);
  await readVideoPromptGroup(user, ref, prisma, true);
  const fingerprint = hash(['delete', ref, input.revision]);
  return prisma.$transaction(async tx => {
    const prior = await tx.platformSetting.findUnique({ where: { key: receiptKey(user.id, requestId) }, select: { value_json: true } });
    if (prior) {
      const saved = JSON.parse(prior.value_json);
      if (saved.fingerprint !== fingerprint) throw new VideoPromptGroupError('原操作内容不同，请核对原删除', 409);
      return { state: saved.state, requestId, ...ref, revision: saved.revision };
    }
    const { head, rawHead } = await readVideoPromptGroup(user, ref, tx, true);
    const conflict = head.deleted || head.revision !== input.revision || head.versionId !== ref.versionId;
    const state = conflict ? 'conflict' : 'deleted';
    const revision = conflict ? head.revision : head.revision + 1;
    if (!conflict) {
      const changed = await tx.platformSetting.updateMany({ where: { key: headKey(head.id), value_json: rawHead },
        data: { value_json: JSON.stringify({ ...head, deleted: true, revision }), updated_by: user.id } });
      if (changed.count !== 1) throw new VideoPromptGroupError('原组已有更新，未删除', 409);
    }
    await tx.platformSetting.create({ data: { key: receiptKey(user.id, requestId), value_json: JSON.stringify({ state, requestId, ...ref, revision, fingerprint }), updated_by: user.id } });
    return { state, requestId, ...ref, revision };
  });
}
