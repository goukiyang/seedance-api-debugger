import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { serializeGenerationTemplate, TEMPLATE_INCLUDE } from '@/lib/templates/workbench';
import type { SessionUser } from '@/lib/auth/session';
import { encodeCursor, parseCursor } from './common';
import { StudioError } from './errors';
import { normalizeDescription, normalizeGroupName, normalizeName, normalizeRecipe, parseJsonRecord } from './validation';
import type {
  CreateStudioTemplateRequest,
  PatchStudioTemplateRequest,
  StudioTemplateDto,
  StudioTemplateRecipe,
  StudioTemplateVersionSummary,
} from './types';

const templateInclude = {
  owner: { select: { id: true, name: true, username: true, avatar_url: true } },
  published_version: true,
  versions: { orderBy: { version_number: 'desc' as const } },
};

function parseRecipe(json: string): StudioTemplateRecipe {
  try { return normalizeRecipe(JSON.parse(json)); } catch { throw new StudioError('模板 recipe 快照无法读取', 500, 'UNAVAILABLE'); }
}

function versionSummary(version: any): StudioTemplateVersionSummary {
  return {
    id: version.id,
    number: version.version_number,
    createdAt: version.created_at.toISOString(),
    createdBy: null,
  };
}

function serializeStudioTemplate(row: any, user: SessionUser): StudioTemplateDto {
  const canManage = user.role === 'admin' || (row.owner_user_id === user.id && row.visibility === 'private');
  const canPublish = user.account_type === 'internal' && user.role === 'admin';
  const visibleRecipe = canManage ? row.recipe_json : row.published_version?.recipe_json;
  return {
    id: row.id,
    source: 'studio',
    name: row.visibility === 'shared' && row.status === 'published' && !canManage ? row.published_version?.name || row.name : row.name,
    description: row.visibility === 'shared' && row.status === 'published' && !canManage ? row.published_version?.description ?? row.description : row.description,
    groupName: row.visibility === 'shared' && row.status === 'published' && !canManage ? row.published_version?.group_name || row.group_name : row.group_name,
    status: row.status as StudioTemplateDto['status'],
    visibility: row.visibility as StudioTemplateDto['visibility'],
    revision: row.revision,
    owner: { displayName: row.owner.name || row.owner.username, avatarUrl: row.owner.avatar_url || null },
    canManage,
    canPublish,
    applyMode: 'studio-draft',
    applyUrl: null,
    version: row.published_version ? versionSummary(row.published_version) : null,
    recipe: visibleRecipe ? parseRecipe(visibleRecipe) : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function serializeLegacy(template: any): StudioTemplateDto {
  const normalized = serializeGenerationTemplate(template);
  const applyUrl = `/template-generate?templateId=${encodeURIComponent(template.id)}`;
  return {
    id: template.id,
    source: 'legacy',
    name: normalized.name,
    description: normalized.description,
    groupName: '旧版模板',
    status: 'published',
    visibility: 'legacy',
    revision: 1,
    owner: null,
    canManage: false,
    canPublish: false,
    applyMode: 'legacy-route',
    applyUrl,
    version: null,
    recipe: null,
    createdAt: new Date(normalized.created_at).toISOString(),
    updatedAt: new Date(normalized.updated_at).toISOString(),
  };
}

function canReadTemplate(row: any, user: SessionUser) {
  return user.role === 'admin'
    || (row.owner_user_id === user.id)
    || (row.status === 'published' && row.visibility === 'shared');
}

const TEMPLATE_PAGE_SIZE = 30;

export async function listStudioTemplates(user: SessionUser, query: { cursor?: string; search?: string; group?: string }) {
  const search = query.search?.trim().slice(0, 120);
  const group = query.group?.trim() || undefined;
  const cursor = parseCursor(query.cursor);
  const [cursorKind, cursorId] = cursor?.id.split(':', 2) ?? [];
  const studioKeyset: Prisma.VideoStudioTemplateWhereInput | null = cursor
    ? cursorKind === 'studio'
      ? { OR: [{ updated_at: { lt: cursor.date } }, { updated_at: cursor.date, id: { lt: cursorId } }] }
      : { updated_at: { lt: cursor.date } }
    : null;
  const legacyKeyset: Prisma.GenerationTemplateWhereInput | null = cursor
    ? cursorKind === 'legacy'
      ? { OR: [{ updated_at: { lt: cursor.date } }, { updated_at: cursor.date, id: { lt: cursorId } }] }
      : { updated_at: { lte: cursor.date } }
    : null;
  const rowFilters: Prisma.VideoStudioTemplateWhereInput = {
    ...(search ? { name: { contains: search } } : {}),
    ...(group ? { group_name: group } : {}),
  };
  const publishedFilters: Prisma.VideoStudioTemplateVersionWhereInput = {
    ...(search ? { name: { contains: search } } : {}),
    ...(group ? { group_name: group } : {}),
  };
  const studioWhere: Prisma.VideoStudioTemplateWhereInput = user.role === 'admin'
    ? { AND: [rowFilters, ...(studioKeyset ? [studioKeyset] : [])] }
    : {
      AND: [
        {
          OR: [
            { owner_user_id: user.id, visibility: 'private', ...rowFilters },
            {
              status: 'published',
              visibility: 'shared',
              published_version_id: { not: null },
              ...(search || group ? { published_version: { is: publishedFilters } } : {}),
            },
          ],
        },
        ...(studioKeyset ? [studioKeyset] : []),
      ],
    };
  const includeLegacyGroup = !group || group === '旧版模板';
  const [studioRows, legacyRows] = await Promise.all([
    prisma.videoStudioTemplate.findMany({
      where: studioWhere,
      include: templateInclude,
      orderBy: [{ updated_at: 'desc' }, { id: 'desc' }],
      take: TEMPLATE_PAGE_SIZE + 1,
    }),
    includeLegacyGroup
      ? prisma.generationTemplate.findMany({
        where: { status: 'active', ...(search ? { name: { contains: search } } : {}), ...(legacyKeyset || {}) },
        include: TEMPLATE_INCLUDE,
        orderBy: [{ updated_at: 'desc' }, { id: 'desc' }],
        take: TEMPLATE_PAGE_SIZE + 1,
      })
      : Promise.resolve([]),
  ]);
  const studio = studioRows.map((row) => {
    const dto = serializeStudioTemplate(row, user);
    return { dto, updatedAt: row.updated_at, id: `studio:${row.id}` };
  });
  const legacy = legacyRows.map((row) => {
    const dto = serializeLegacy(row);
    return { dto, updatedAt: row.updated_at, id: `legacy:${row.id}` };
  });
  const merged = [...studio, ...legacy].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || b.id.localeCompare(a.id));
  const page = merged.slice(0, TEMPLATE_PAGE_SIZE);
  const last = page.at(-1);
  const nextCursor = merged.length > TEMPLATE_PAGE_SIZE && last
    ? encodeCursor(`${last.updatedAt.toISOString()}|${last.id}`)
    : null;
  return { items: page.map(({ dto }) => dto), nextCursor };
}

export async function getStudioTemplate(user: SessionUser, id: string, source: 'legacy' | 'studio' = 'studio') {
  if (source === 'legacy') {
    const row = await prisma.generationTemplate.findFirst({ where: { id, status: 'active' }, include: TEMPLATE_INCLUDE });
    if (!row) throw new StudioError('模板不存在或已撤销', 404, 'NOT_FOUND');
    return { template: serializeLegacy(row), versions: [] as StudioTemplateVersionSummary[] };
  }
  const row = await prisma.videoStudioTemplate.findUnique({ where: { id }, include: templateInclude });
  if (!row || !canReadTemplate(row, user)) throw new StudioError('模板不存在或无权访问', 404, 'NOT_FOUND');
  const dto = serializeStudioTemplate(row, user);
  const versions = row.versions.map(versionSummary);
  return { template: dto, versions: user.role === 'admin' || row.owner_user_id === user.id ? versions : row.published_version ? versions.filter((version) => version.id === row.published_version_id) : [] };
}

export async function createStudioTemplate(user: SessionUser, input: CreateStudioTemplateRequest) {
  if (user.account_type !== 'internal') throw new StudioError('外部账号不能创建模板', 403, 'FORBIDDEN');
  const name = normalizeName(input?.name);
  const groupName = normalizeGroupName(input?.groupName);
  const description = normalizeDescription(input?.description);
  const recipe = normalizeRecipe(input?.recipe);
  const row = await prisma.videoStudioTemplate.create({
    data: { owner_user_id: user.id, name, group_name: groupName, description, recipe_json: JSON.stringify(recipe), revision: 1 },
    include: templateInclude,
  });
  return serializeStudioTemplate(row, user);
}

function isUniqueVersionConflict(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export async function patchStudioTemplate(user: SessionUser, id: string, input: PatchStudioTemplateRequest) {
  if (!input || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) {
    throw new StudioError('请提供有效的 expectedRevision', 400, 'INVALID');
  }
  const initial = await prisma.videoStudioTemplate.findUnique({ where: { id }, select: { id: true, owner_user_id: true, visibility: true } });
  if (!initial) throw new StudioError('模板不存在', 404, 'NOT_FOUND');
  const isAdmin = user.account_type === 'internal' && user.role === 'admin';
  const isPrivateOwner = initial.owner_user_id === user.id && initial.visibility === 'private';
  if (!isAdmin && !isPrivateOwner) throw new StudioError('无权管理此模板', 403, 'FORBIDDEN');

  try {
    const result = await prisma.$transaction(async (tx) => {
      const current = await tx.videoStudioTemplate.findUnique({ where: { id }, include: { published_version: true } });
      if (!current) throw new StudioError('模板不存在', 404, 'NOT_FOUND');
      if (current.revision !== input.expectedRevision) throw new StudioError('模板已被其他编辑更新，请刷新后重试', 409, 'CONFLICT', { currentRevision: current.revision });
      if (current.status === 'archived' && input.action !== 'archive') throw new StudioError('已归档模板不能继续修改或发布', 409, 'CONFLICT');
      if (input.action === 'publish') {
        if (!isAdmin) throw new StudioError('仅管理员可以发布共享模板', 403, 'FORBIDDEN');
        if (input.expectedVersionId !== undefined && input.expectedVersionId !== current.published_version_id) {
          throw new StudioError('当前发布版本已变化，请刷新后重试', 409, 'CONFLICT');
        }
        const recipe = parseRecipe(current.recipe_json);
        const nextNumber = (await tx.videoStudioTemplateVersion.aggregate({ where: { template_id: id }, _max: { version_number: true } }))._max.version_number ?? 0;
        const cas = await tx.videoStudioTemplate.updateMany({ where: { id, revision: input.expectedRevision }, data: { revision: { increment: 1 }, updated_at: new Date() } });
        if (cas.count !== 1) throw new StudioError('模板已被其他编辑更新，请刷新后重试', 409, 'CONFLICT');
        const version = await tx.videoStudioTemplateVersion.create({
          data: { template_id: id, version_number: nextNumber + 1, name: current.name, description: current.description, group_name: current.group_name, recipe_json: JSON.stringify(recipe), created_by: user.id },
        });
        await tx.videoStudioTemplate.update({ where: { id }, data: { status: 'published', visibility: 'shared', published_version_id: version.id, updated_at: new Date() } });
      } else if (input.action === 'archive') {
        const cas = await tx.videoStudioTemplate.updateMany({ where: { id, revision: input.expectedRevision }, data: { status: 'archived', revision: { increment: 1 }, updated_at: new Date() } });
        if (cas.count !== 1) throw new StudioError('模板已被其他编辑更新，请刷新后重试', 409, 'CONFLICT');
      } else {
        const name = normalizeName(input.name);
        const groupName = normalizeGroupName(input.groupName);
        const description = normalizeDescription(input.description);
        const recipe = normalizeRecipe(input.recipe);
        const cas = await tx.videoStudioTemplate.updateMany({ where: { id, revision: input.expectedRevision }, data: { name, group_name: groupName, description, recipe_json: JSON.stringify(recipe), revision: { increment: 1 }, updated_at: new Date() } });
        if (cas.count !== 1) throw new StudioError('模板已被其他编辑更新，请刷新后重试', 409, 'CONFLICT');
      }
      return tx.videoStudioTemplate.findUniqueOrThrow({ where: { id }, include: templateInclude });
    });
    return serializeStudioTemplate(result, user);
  } catch (error) {
    if (isUniqueVersionConflict(error)) throw new StudioError('模板版本号冲突，请刷新后重新发布', 409, 'CONFLICT');
    throw error;
  }
}

export function parseTemplateSnapshot(json: string | null) {
  if (!json) return null;
  return parseJsonRecord(json, '模板');
}
