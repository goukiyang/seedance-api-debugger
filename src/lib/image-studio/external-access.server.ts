import 'server-only';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { canUseCompanyTemplates, isExternalImageStudioActor, type ImageStudioIdentity } from './access';
import { sharedCommandFingerprint } from './shared-command-storage';
import { assertExternalStudioTemplateDependencies, sharedDependencyState, type SharedStudioClient } from './shared-contract';
import { archivedPresetKey } from './preset-lifecycle';
import { isParameterCopyId } from './parameter-copy';

export const EXTERNAL_STUDIO_ACCESS_KEY = 'image_studio_external_access_v1';
export type ExternalStudioTemplateGrant = { presetId: string; sourceRevision: string; dependencyToken: string };
export type ExternalStudioAccessPolicy = { version: 1; revision: number; mode: 'closed' | 'pilot' | 'all-external';
  userIds: string[]; templates: ExternalStudioTemplateGrant[] };
const emptyPolicy = (): ExternalStudioAccessPolicy => ({ version: 1, revision: 0, mode: 'closed', userIds: [], templates: [] });
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9:_-]{1,160}$/.test(value);
export class ExternalStudioAccessError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export function parseExternalStudioAccessPolicy(raw: string | null): ExternalStudioAccessPolicy {
  if (raw === null) return emptyPolicy();
  let value: ExternalStudioAccessPolicy;
  try { value = JSON.parse(raw); } catch { throw new ExternalStudioAccessError('外部生图设置暂时无法读取', 503); }
  if (!value || value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !['closed', 'pilot', 'all-external'].includes(value.mode)
    || !Array.isArray(value.userIds) || value.userIds.length > 500 || value.userIds.some(id => !validId(id))
    || new Set(value.userIds).size !== value.userIds.length || !Array.isArray(value.templates) || value.templates.length > 200
    || value.templates.some(item => !item || !validId(item.presetId) || typeof item.sourceRevision !== 'string'
      || !Number.isFinite(Date.parse(item.sourceRevision)) || !/^[a-f0-9]{64}$/.test(item.dependencyToken))
    || new Set(value.templates.map(item => item.presetId)).size !== value.templates.length) {
    throw new ExternalStudioAccessError('外部生图设置格式无法确认', 503);
  }
  return { version: 1, revision: value.revision, mode: value.mode, userIds: [...value.userIds],
    templates: value.templates.map(item => ({ presetId: item.presetId, sourceRevision: item.sourceRevision, dependencyToken: item.dependencyToken })) };
}

export async function readExternalStudioAccessPolicy(client: Pick<SharedStudioClient, 'platformSetting'> = prisma) {
  const row = await client.platformSetting.findUnique({ where: { key: EXTERNAL_STUDIO_ACCESS_KEY }, select: { value_json: true } });
  return parseExternalStudioAccessPolicy(row?.value_json ?? null);
}

/** Hash stored source/dependency identities; no source values leave this server module. */
export async function externalStudioTemplateBinding(presetId: string, client: SharedStudioClient = prisma): Promise<ExternalStudioTemplateGrant | null> {
  if (isParameterCopyId(presetId)) return null;
  const source = await client.imageStudioPreset.findUnique({ where: { id: presetId } });
  if (!source || !source.is_shared || !['admin', 'creator'].includes(source.scope)) return null;
  const owner = await client.user.findUnique({ where: { id: source.owner_id }, select: {
    id: true, role: true, account_type: true, feature_profile_id: true, status: true, expires_at: true,
    feishu_user_id: true, feishu_open_id: true, feishu_union_id: true, feishu_tenant_key: true,
  } });
  if (!owner || owner.status !== 'active' || owner.expires_at && owner.expires_at <= new Date() || !canUseCompanyTemplates(owner)) return null;
  if (await client.platformSetting.findUnique({ where: { key: archivedPresetKey(source.id) }, select: { key: true } })) return null;
  try { await assertExternalStudioTemplateDependencies(source, client); }
  catch (error) {
    if (error && typeof error === 'object' && 'status' in error && [400, 403, 404, 409].includes(Number(error.status))) return null;
    throw error;
  }
  const dependencies = await sharedDependencyState([source], client, false);
  const global = await client.platformSetting.findUnique({ where: { key: 'gpt_image_studio_v1' }, select: { value_json: true } });
  return { presetId, sourceRevision: source.updated_at.toISOString(),
    dependencyToken: sharedCommandFingerprint({ source, ...dependencies, global: global?.value_json ?? null }) };
}

export async function hydrateExternalStudioActor<T extends ImageStudioIdentity>(user: T, client: SharedStudioClient = prisma): Promise<T & ImageStudioIdentity> {
  if (!isExternalImageStudioActor(user)) return user;
  const policy = await readExternalStudioAccessPolicy(client);
  const enabled = policy.mode === 'all-external' || policy.mode === 'pilot' && policy.userIds.includes(user.id);
  const presetIds: string[] = [];
  if (enabled) for (const grant of policy.templates) {
    const current = await externalStudioTemplateBinding(grant.presetId, client);
    if (current && current.sourceRevision === grant.sourceRevision && current.dependencyToken === grant.dependencyToken) presetIds.push(grant.presetId);
  }
  return { ...user, externalStudioAccess: { enabled, revision: policy.revision, presetIds } };
}

type AdminClient = Prisma.TransactionClient;
type Actor = { id: string };
type Operation = { requestId: string; state: 'succeeded' | 'rejected' | 'unknown'; policy: ExternalStudioAccessPolicy | null; error: string | null };
const action = 'image_studio_external_access_save';
const receiptId = (actorId: string, requestId: string) => `studio-external:${createHash('sha256').update(JSON.stringify([actorId, requestId])).digest('hex')}`;
function checkedRequestId(value: unknown) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9:_-]{8,128}$/.test(value)) throw new ExternalStudioAccessError('保存请求编号无效');
  return value;
}
async function freshAdmin(actor: Actor, client: AdminClient) {
  const user = await client.user.findUnique({ where: { id: actor.id } });
  if (!user || user.role !== 'admin' || user.status !== 'active' || user.expires_at && user.expires_at <= new Date()
    || !canUseCompanyTemplates(user)) throw new ExternalStudioAccessError('无权管理外部生图', 403);
  return user;
}
async function readOperation(actor: Actor, id: string, client: AdminClient) {
  const row = await client.operationLog.findUnique({ where: { id: receiptId(actor.id, id) } });
  if (!row) return null;
  let value: { fingerprint: string; operation: Operation };
  try { value = JSON.parse(row.detail || ''); } catch { throw new ExternalStudioAccessError('原保存回执无法读取，请保留原编号', 503); }
  if (row.operator_id !== actor.id || row.action !== action || row.target_id !== EXTERNAL_STUDIO_ACCESS_KEY
    || typeof value.fingerprint !== 'string' || value.operation?.requestId !== id || !['succeeded', 'rejected'].includes(value.operation.state)) {
    throw new ExternalStudioAccessError('原保存回执无法确认，请保留原编号', 503);
  }
  if (value.operation.policy) value.operation.policy = parseExternalStudioAccessPolicy(JSON.stringify(value.operation.policy));
  return value;
}
export async function getExternalStudioAccessOperation(actor: Actor, requestId: unknown) {
  const id = checkedRequestId(requestId);
  return prisma.$transaction(async client => {
    await freshAdmin(actor, client);
    return { operation: (await readOperation(actor, id, client))?.operation
      ?? { requestId: id, state: 'unknown' as const, policy: null, error: null } };
  });
}

export async function getExternalStudioAccessAdmin(actor: Actor, input: { q?: string; after?: string } = {}) {
  const q = (input.q || '').trim();
  if (q.length > 80 || input.after && !validId(input.after)) throw new ExternalStudioAccessError('查询条件无效');
  return prisma.$transaction(async client => {
    await freshAdmin(actor, client);
    const policy = await readExternalStudioAccessPolicy(client);
    const rows = await client.imageStudioPreset.findMany({ where: { is_shared: true, scope: { in: ['admin', 'creator'] },
      ...(q ? { name: { contains: q } } : {}), ...(input.after ? { id: { gt: input.after } } : {}) }, orderBy: { id: 'asc' }, take: 41,
      select: { id: true, name: true, owner_id: true } });
    const templates: Array<ExternalStudioTemplateGrant & { name: string; approved: boolean; available: boolean }> = [];
    for (const row of rows.slice(0, 40)) {
      const binding = await externalStudioTemplateBinding(row.id, client);
      if (binding) templates.push({ ...binding, name: row.name, available: true, approved: policy.templates.some(item => item.presetId === row.id
        && item.sourceRevision === binding.sourceRevision && item.dependencyToken === binding.dependencyToken) });
    }
    for (const grant of policy.templates.filter(item => !templates.some(row => row.presetId === item.presetId))) {
      const source = await client.imageStudioPreset.findUnique({ where: { id: grant.presetId }, select: { name: true } });
      const binding = await externalStudioTemplateBinding(grant.presetId, client);
      templates.push({ ...(binding || grant), name: source?.name || '已不可用模板', available: Boolean(binding),
        approved: Boolean(binding && binding.sourceRevision === grant.sourceRevision && binding.dependencyToken === grant.dependencyToken) });
    }
    const users = await client.user.findMany({ where: { account_type: 'external', status: 'active',
      ...(q ? { OR: [{ name: { contains: q } }, { email: { contains: q } }, { id: q }] } : {}) },
      orderBy: { id: 'asc' }, take: 40, select: { id: true, name: true, email: true } });
    const selectedUsers = policy.userIds.length ? await client.user.findMany({ where: { id: { in: policy.userIds } },
      select: { id: true, name: true, email: true } }) : [];
    return { policy, templates, users: Array.from(new Map([...selectedUsers, ...users].map(user => [user.id, user])).values()),
      nextCursor: rows.length > 40 ? rows[39].id : null };
  }, { timeout: 20000 });
}

export async function saveExternalStudioAccess(actor: Actor, input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ExternalStudioAccessError('外部生图设置无效');
  const body = input as Record<string, unknown>, id = checkedRequestId(body.requestId), fingerprint = sharedCommandFingerprint(body);
  const replay = async (client: AdminClient) => {
    const previous = await readOperation(actor, id, client);
    if (previous && previous.fingerprint !== fingerprint) throw new ExternalStudioAccessError('原保存编号已用于不同内容，请核对原保存', 409);
    return previous?.operation;
  };
  const writeReceipt = (client: AdminClient, operation: Operation) => client.operationLog.create({ data: {
    id: receiptId(actor.id, id), operator_id: actor.id, action, target_type: 'PlatformSetting', target_id: EXTERNAL_STUDIO_ACCESS_KEY,
    detail: JSON.stringify({ fingerprint, operation }),
  } });
  try {
    return await prisma.$transaction(async client => {
      await freshAdmin(actor, client);
      const previous = await replay(client);
      if (previous) return { operation: previous };
      if (Object.keys(body).some(key => !['requestId', 'revision', 'mode', 'userIds', 'templates'].includes(key))) throw new ExternalStudioAccessError('设置包含未知字段');
      let next: ExternalStudioAccessPolicy;
      try { next = parseExternalStudioAccessPolicy(JSON.stringify({ version: 1, revision: body.revision, mode: body.mode, userIds: body.userIds, templates: body.templates })); }
      catch { throw new ExternalStudioAccessError('请检查开放模式、账号和模板选择'); }
      const row = await client.platformSetting.findUnique({ where: { key: EXTERNAL_STUDIO_ACCESS_KEY } });
      const current = parseExternalStudioAccessPolicy(row?.value_json ?? null);
      if (next.revision !== current.revision) throw new ExternalStudioAccessError('设置已更新，当前修改已保留，请重新读取后核对', 409);
      if (next.mode === 'pilot' && next.userIds.length) {
        const count = await client.user.count({ where: { id: { in: next.userIds }, account_type: 'external', status: 'active',
          OR: [{ expires_at: null }, { expires_at: { gt: new Date() } }] } });
        if (count !== next.userIds.length) throw new ExternalStudioAccessError('所选外部账号已失效，请重新读取');
      }
      for (const grant of next.mode === 'closed' ? [] : next.templates) {
        const currentBinding = await externalStudioTemplateBinding(grant.presetId, client);
        if (!currentBinding || currentBinding.sourceRevision !== grant.sourceRevision || currentBinding.dependencyToken !== grant.dependencyToken) {
          throw new ExternalStudioAccessError('所选模板或依赖已变化，请重新读取并确认当前版本', 409);
        }
      }
      next = { ...next, revision: current.revision + 1 };
      const data = { value_json: JSON.stringify(next), updated_by: actor.id };
      if (row) {
        const result = await client.platformSetting.updateMany({ where: { key: EXTERNAL_STUDIO_ACCESS_KEY, value_json: row.value_json }, data });
        if (result.count !== 1) throw new ExternalStudioAccessError('设置保存冲突，原设置未覆盖', 409);
      } else await client.platformSetting.create({ data: { key: EXTERNAL_STUDIO_ACCESS_KEY, ...data } });
      const operation: Operation = { requestId: id, state: 'succeeded', policy: next, error: null };
      await writeReceipt(client, operation);
      return { operation };
    }, { timeout: 20000 });
  } catch (error) {
    const failure = error instanceof ExternalStudioAccessError ? error
      : error instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2034'].includes(error.code)
        ? new ExternalStudioAccessError('设置发生并发更新，请重新读取后核对', 409) : null;
    if (!failure || failure.status >= 500) throw error;
    return prisma.$transaction(async client => {
      await freshAdmin(actor, client);
      const previous = await replay(client);
      if (previous) return { operation: previous };
      const operation: Operation = { requestId: id, state: 'rejected', policy: null, error: failure.message };
      await writeReceipt(client, operation);
      return { operation };
    });
  }
}
