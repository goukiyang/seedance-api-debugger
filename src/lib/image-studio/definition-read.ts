import 'server-only';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { resolveModuleContextVersion } from './context-version';
import { getStudioPresetFixedReferences } from './fixed-references';
import { assertStudioActor, resolveSharedStudioDefinition, StudioSharingError } from './shared-contract';
import { studioPresetArchived } from './preset-lifecycle';
import { resolveStudioTemplateAuthor } from './template-author';
import type { ImageStudioIdentity } from './access';
import type { SharedStudioReasonCode, StudioTemplateDefinitionRead, StudioTemplateRead } from './shared-types';

export class StudioDefinitionReadError extends Error {
  constructor(message: string, public status = 400, public reasonCode: SharedStudioReasonCode = 'access-revoked') { super(message); }
}

export async function readStudioTemplateDefinition(user: ImageStudioIdentity,
  target: { presetId?: string; moduleId?: string }): Promise<StudioTemplateDefinitionRead> {
  const resolved = await resolveStudioTemplateAuthor(user, target);
  if (!resolved.templateRead.canViewTemplateContext || resolved.templateRead.author.state !== 'known') {
    throw new StudioDefinitionReadError('模板不存在或无权读取', 404);
  }
  if (!resolved.preset) {
    const row = await prisma.imageStudioModule.findFirst({ where: { id: resolved.templateRead.sourceId, owner_id: resolved.actor.id } });
    if (!row) throw new StudioDefinitionReadError('模板不存在或无权读取', 404);
    const contextVersion = await resolveModuleContextVersion(row.context).then(code => ({ code, state: 'ready' })).catch(() => null);
    return { templateRead: resolved.templateRead, definition: { name: row.name, templatePrompt: row.prompt, context: row.context,
      sourceRevision: String(row.revision), contextVersion, limits: { count: row.count, referenceLimit: row.reference_limit, aspectRatio: row.aspect_ratio },
      referenceNotes: [] }, lifecycle: 'active', generation: { available: true, reasonCode: null }, readAt: new Date().toISOString() };
  }
  const source = resolved.preset;
  const archived = await studioPresetArchived(source.id);
  let available: boolean | null = false;
  let reasonCode: SharedStudioReasonCode | null = archived ? 'source-archived' : !resolved.ordinarilyVisible ? 'source-withdrawn' : null;
  if (!archived && resolved.ordinarilyVisible) {
    try { await resolveSharedStudioDefinition(resolved.actor, source.id); available = true; reasonCode = null; }
    catch (error) {
      if (error instanceof StudioSharingError && ['dependency-invalid', 'source-archived', 'source-withdrawn', 'access-revoked'].includes(error.reasonCode)) {
        available = false; reasonCode = error.reasonCode;
      } else { available = null; reasonCode = 'read-unavailable'; }
    }
  }
  const contextVersion = await resolveModuleContextVersion(source.context).then(code => ({ code, state: 'ready' })).catch(() => null);
  let referenceNotes: string[] = [];
  if (resolved.actor.role === 'admin') {
    try { referenceNotes = (await getStudioPresetFixedReferences(resolved.actor, source)).map(item => item.note); }
    catch { referenceNotes = []; }
  }
  return { templateRead: resolved.templateRead, definition: { name: source.name, templatePrompt: source.prompt, context: source.context,
    sourceRevision: source.updated_at.toISOString(), contextVersion,
    limits: { count: source.count, referenceLimit: source.reference_limit, aspectRatio: source.aspect_ratio }, referenceNotes },
    lifecycle: archived ? 'archived' : 'active', generation: { available, reasonCode }, readAt: new Date().toISOString() };
}

type DirectoryCursor = { version: 1; queryHash: string; createdAt: string; id: string };
const encodeCursor = (value: DirectoryCursor) => Buffer.from(JSON.stringify(value)).toString('base64url');
function decodeCursor(value: string | undefined, queryHash: string): DirectoryCursor | null {
  if (!value) return null;
  if (value.length > 500) throw new StudioDefinitionReadError('模板目录分页无效');
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as DirectoryCursor;
    if (parsed.version !== 1 || parsed.queryHash !== queryHash || typeof parsed.id !== 'string' || parsed.id.length > 160
      || typeof parsed.createdAt !== 'string' || !Number.isFinite(Date.parse(parsed.createdAt))) throw new Error();
    return parsed;
  } catch { throw new StudioDefinitionReadError('模板目录已变化，请重新读取', 409, 'state-conflict'); }
}

export async function listAdminStudioDefinitionDirectory(user: ImageStudioIdentity,
  input: { cursor?: string; q?: string; limit?: number }) {
  const actor = await assertStudioActor(user.id);
  if (actor.account_type !== 'internal' || actor.role !== 'admin') throw new StudioDefinitionReadError('无权查看全部模板', 403);
  const q = (input.q || '').trim();
  if (q.length > 80 || /[\u0000-\u001f]/.test(q)) throw new StudioDefinitionReadError('模板搜索内容无效');
  const limit = input.limit === undefined ? 24 : input.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 24) throw new StudioDefinitionReadError('模板目录数量无效');
  const queryHash = createHash('sha256').update(q).digest('hex');
  const cursor = decodeCursor(input.cursor, queryHash);
  const qPattern = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
  const rows = await prisma.$queryRaw<Array<{ id: string; owner_id: string; scope: string; is_shared: number; name: string;
    created_at: string | Date; updated_at: string | Date; owner_account_type: string | null }>>(Prisma.sql`
      SELECT p.id, p.owner_id, p.scope, p.is_shared, p.name, p.created_at, p.updated_at,
        u.account_type AS owner_account_type
      FROM ImageStudioPreset p LEFT JOIN User u ON u.id = p.owner_id
      WHERE (u.account_type = 'internal' OR u.id IS NULL)
        ${q ? Prisma.sql`AND p.name LIKE ${qPattern} ESCAPE '\\'` : Prisma.empty}
        ${cursor ? Prisma.sql`AND (p.created_at < ${cursor.createdAt} OR (p.created_at = ${cursor.createdAt} AND p.id < ${cursor.id}))` : Prisma.empty}
      ORDER BY p.created_at DESC, p.id DESC LIMIT ${limit + 1}`);
  const selected = rows.slice(0, limit);
  const items = await Promise.all(selected.map(async row => {
    const sourceRevision = new Date(row.updated_at).toISOString();
    let templateRead: StudioTemplateRead = { sourceKind: 'preset', sourceId: row.id, sourceRevision,
      author: { state: 'unknown', displayName: null, avatarUrl: null, isSelf: false }, canViewTemplateContext: false };
    let definitionAvailable = false;
    if (row.owner_account_type === 'internal') {
      const resolved = await resolveStudioTemplateAuthor(actor, { presetId: row.id });
      templateRead = resolved.templateRead;
      definitionAvailable = resolved.bindingConfirmed && templateRead.author.state === 'known';
    }
    return { presetId: row.id, name: row.name, author: templateRead.author,
      lifecycle: await studioPresetArchived(row.id) ? 'archived' as const : 'active' as const,
      isShared: Boolean(row.is_shared), scope: row.scope, sourceRevision,
      createdAt: new Date(row.created_at).toISOString(), updatedAt: sourceRevision, definitionAvailable };
  }));
  const last = selected[selected.length - 1];
  return { items, nextCursor: rows.length > limit && last ? encodeCursor({ version: 1, queryHash,
    createdAt: new Date(last.created_at).toISOString(), id: last.id }) : null, hasMore: rows.length > limit, readAt: new Date().toISOString() };
}

export async function readStudioTemplateAuthorContact(user: ImageStudioIdentity,
  target: { presetId?: string; moduleId?: string }) {
  const resolved = await resolveStudioTemplateAuthor(user, target);
  const adminRead = resolved.actor.account_type === 'internal' && resolved.actor.role === 'admin' && resolved.bindingConfirmed;
  if ((!resolved.ordinarilyVisible && !adminRead) || resolved.templateRead.author.state !== 'known' || !resolved.owner) {
    throw new StudioDefinitionReadError('模板不存在或无权读取', 404);
  }
  const base = { displayName: resolved.templateRead.author.displayName, sourceRevision: resolved.templateRead.sourceRevision };
  if (resolved.owner.status !== 'active') return { ...base, status: 'unavailable' as const, reasonCode: 'author-unavailable' };
  const openId = resolved.owner.feishu_open_id?.trim();
  const allowedTenant = process.env.FEISHU_ALLOWED_TENANT_KEY?.trim();
  if (!openId || !/^[A-Za-z0-9_-]{1,160}$/.test(openId)) return { ...base, status: 'unavailable' as const, reasonCode: 'feishu-not-linked' };
  if (allowedTenant && resolved.owner.feishu_tenant_key !== allowedTenant) return { ...base, status: 'unavailable' as const, reasonCode: 'tenant-mismatch' };
  return { ...base, status: 'available' as const, href: `https://applink.feishu.cn/client/chat/open?openId=${encodeURIComponent(openId)}` };
}
