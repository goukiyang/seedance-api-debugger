import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma, retrySqliteBusy } from '@/lib/prisma';
import { AuthError, type SessionUser } from '@/lib/auth/session';
import { assertCanViewReferenceImage } from '@/lib/reference-albums/permissions';
import { CharacterAssetError } from './errors';
import { normalizeArkAssetId } from './inputs';
import { CHARACTER_ASSET_WRITES_ENABLED } from './build-mode';
import type { CharacterAssetDTO, ReferenceImageInput } from './types';

const PROVIDER = 'volcengine_ark';
type Row = {
  id: string; owner_id: string; provider: string; asset_id: string; name: string;
  group_id: string | null; project_name: string | null; notes: string | null;
  thumbnail_reference_image_id: string | null; enabled: boolean; revision: number;
  deleted_at: Date | null; created_at: Date; updated_at: Date;
};
type EditableFields = {
  name: string; assetId: string; groupId: string | null; projectName: string | null;
  notes: string | null; thumbnailReferenceImageId: string | null; enabled: boolean;
};
const EDITABLE_KEYS = ['name', 'assetId', 'groupId', 'projectName', 'notes', 'thumbnailReferenceImageId', 'enabled'];

function assertWritesEnabled() {
  if (!CHARACTER_ASSET_WRITES_ENABLED) {
    throw new CharacterAssetError('角色目录暂时只读，请保留输入后稍后重试', 503, 'CHARACTER_ASSET_WRITES_PAUSED');
  }
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CharacterAssetError('请提供有效的角色资料', 400, 'CHARACTER_ASSET_INVALID_BODY');
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maximum: number, required = false): string | null {
  if (value === undefined || value === null || value === '') {
    if (required) throw new CharacterAssetError(`请填写${label}`, 400, 'CHARACTER_ASSET_INVALID_BODY');
    return null;
  }
  if (typeof value !== 'string' || value.trim().length > maximum || (required && !value.trim())) {
    throw new CharacterAssetError(`${label}格式无效或过长`, 400, 'CHARACTER_ASSET_INVALID_BODY');
  }
  return value.trim() || null;
}

function fields(body: Record<string, unknown>, creating: boolean): Partial<EditableFields> {
  const result: Partial<EditableFields> = {};
  if (creating || 'name' in body) result.name = text(body.name, '角色名称', 120, true)!;
  if (creating || 'assetId' in body) result.assetId = normalizeArkAssetId(body.assetId);
  for (const [key, label, maximum] of [
    ['groupId', 'Group ID', 256], ['projectName', 'Ark 项目名', 128],
    ['notes', '备注', 2000], ['thumbnailReferenceImageId', '缩略图', 256],
  ] as const) {
    if (creating || key in body) result[key] = text(body[key], label, maximum);
  }
  if (result.groupId && !/^group-[A-Za-z0-9][A-Za-z0-9_-]*$/.test(result.groupId)) {
    throw new CharacterAssetError('Group ID 需为 group-…', 400, 'CHARACTER_ASSET_INVALID_BODY');
  }
  if ('enabled' in body && typeof body.enabled !== 'boolean') {
    throw new CharacterAssetError('启用状态无效', 400, 'CHARACTER_ASSET_INVALID_BODY');
  }
  if (creating || 'enabled' in body) result.enabled = body.enabled === undefined ? true : Boolean(body.enabled);
  return result;
}

export function parseCharacterAssetRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new CharacterAssetError('请重读角色记录后再操作', 400, 'CHARACTER_ASSET_INVALID_REVISION');
  }
  return Number(value);
}

async function findOwned(ownerId: string, id: string, db: Prisma.TransactionClient): Promise<Row> {
  const rows = await db.$queryRaw<Row[]>`SELECT * FROM "CharacterAsset" WHERE "id" = ${id} AND "owner_id" = ${ownerId} AND "provider" = ${PROVIDER}`;
  if (!rows[0]) throw new CharacterAssetError('角色记录不存在或无权访问', 404, 'CHARACTER_ASSET_NOT_FOUND');
  return rows[0];
}

function assertRevision(row: Row, revision: number) {
  if (row.revision !== revision) throw new CharacterAssetError('角色记录已变化，请重读后保留本次输入再修改', 409, 'CHARACTER_ASSET_REVISION_CONFLICT');
}

async function assertNoDuplicate(ownerId: string, assetId: string, db: Prisma.TransactionClient, exceptId = '') {
  const rows = await db.$queryRaw<Row[]>`SELECT * FROM "CharacterAsset" WHERE "owner_id" = ${ownerId} AND "provider" = ${PROVIDER} AND "asset_id" = ${assetId} AND "id" <> ${exceptId} LIMIT 1`;
  if (rows[0]) throw new CharacterAssetError(rows[0].deleted_at
    ? '该 Asset ID 已有删除记录，请恢复原记录'
    : '本人目录中已登记该 Asset ID', 409, rows[0].deleted_at ? 'CHARACTER_ASSET_DELETED_DUPLICATE' : 'CHARACTER_ASSET_DUPLICATE');
}

async function checkThumbnail(user: SessionUser, imageId: string | null | undefined) {
  if (!imageId) return;
  const image = await assertCanViewReferenceImage(user, imageId);
  if (image.asset && (image.asset.status !== 'active' || image.asset.type !== 'image')) {
    throw new CharacterAssetError('缩略图需为可查看的站内图片', 400, 'CHARACTER_ASSET_INVALID_THUMBNAIL');
  }
}

async function present(row: Row, user: SessionUser): Promise<CharacterAssetDTO> {
  let thumbnailUrl: string | null = null;
  if (row.thumbnail_reference_image_id) {
    try {
      await checkThumbnail(user, row.thumbnail_reference_image_id);
      thumbnailUrl = `/api/reference-images/${encodeURIComponent(row.thumbnail_reference_image_id)}/content?variant=thumbnail`;
    } catch (error) {
      if (!(error instanceof AuthError) && !(error instanceof CharacterAssetError)) throw error;
    }
  }
  return {
    id: row.id, name: row.name, assetId: row.asset_id, revision: row.revision,
    enabled: Boolean(row.enabled), deletedAt: row.deleted_at?.toISOString() ?? null,
    groupId: row.group_id, projectName: row.project_name, notes: row.notes,
    thumbnailReferenceImageId: row.thumbnail_reference_image_id, thumbnailUrl, upstreamStatus: 'unknown',
  };
}

export async function listCharacterAssets(user: SessionUser, options: { includeDeleted?: boolean; q?: string } = {}) {
  const q = (options.q || '').trim().slice(0, 256).toLowerCase();
  const rows = await prisma.$queryRaw<Row[]>(Prisma.sql`SELECT * FROM "CharacterAsset"
    WHERE "owner_id" = ${user.id} AND "provider" = ${PROVIDER}
    ${options.includeDeleted ? Prisma.empty : Prisma.sql`AND "deleted_at" IS NULL`}
    ${q ? Prisma.sql`AND (instr(lower("name"), ${q}) > 0 OR instr(lower("asset_id"), ${q}) > 0)` : Prisma.empty}
    ORDER BY "updated_at" DESC, "id" ASC`);
  return Promise.all(rows.map(row => present(row, user)));
}

export async function getCharacterAsset(user: SessionUser, id: string) {
  return present(await findOwned(user.id, id, prisma), user);
}

/** Raw queries keep this additive table usable with the previous generated Prisma reader. */
export async function createCharacterAsset(user: SessionUser, value: unknown) {
  assertWritesEnabled();
  const body = objectBody(value);
  if (Object.keys(body).some(key => !EDITABLE_KEYS.includes(key))) throw new CharacterAssetError('角色资料包含未知字段', 400, 'CHARACTER_ASSET_INVALID_BODY');
  const data = fields(body, true) as EditableFields;
  await checkThumbnail(user, data.thumbnailReferenceImageId);
  const row = await retrySqliteBusy(() => prisma.$transaction(async db => {
    await assertNoDuplicate(user.id, data.assetId, db);
    const id = randomUUID();
    const now = new Date();
    await db.$executeRaw`INSERT INTO "CharacterAsset" ("id", "owner_id", "provider", "asset_id", "name", "group_id", "project_name", "notes", "thumbnail_reference_image_id", "enabled", "revision", "created_at", "updated_at")
      VALUES (${id}, ${user.id}, ${PROVIDER}, ${data.assetId}, ${data.name}, ${data.groupId}, ${data.projectName}, ${data.notes}, ${data.thumbnailReferenceImageId}, ${data.enabled}, 1, ${now}, ${now})`;
    return findOwned(user.id, id, db);
  }));
  return present(row, user);
}

export async function updateCharacterAsset(user: SessionUser, id: string, value: unknown) {
  assertWritesEnabled();
  const body = objectBody(value);
  if (Object.keys(body).some(key => ![...EDITABLE_KEYS, 'revision', 'restore'].includes(key))) throw new CharacterAssetError('角色资料包含未知字段', 400, 'CHARACTER_ASSET_INVALID_BODY');
  const revision = parseCharacterAssetRevision(body.revision);
  if ('restore' in body && (body.restore !== true || Object.keys(body).some(key => key !== 'restore' && key !== 'revision'))) {
    throw new CharacterAssetError('恢复记录时请单独操作', 400, 'CHARACTER_ASSET_INVALID_BODY');
  }
  const data = fields(body, false);
  if (!body.restore && !Object.keys(data).length) throw new CharacterAssetError('没有要修改的角色资料', 400, 'CHARACTER_ASSET_INVALID_BODY');
  await checkThumbnail(user, data.thumbnailReferenceImageId);
  const row = await retrySqliteBusy(() => prisma.$transaction(async db => {
    const current = await findOwned(user.id, id, db);
    assertRevision(current, revision);
    if (body.restore === true && !current.deleted_at) return current;
    if (current.deleted_at && body.restore !== true) throw new CharacterAssetError('该角色记录已删除，请先恢复', 409, 'CHARACTER_ASSET_DELETED');
    if (data.assetId || body.restore) await assertNoDuplicate(user.id, data.assetId || current.asset_id, db, id);
    const assignments: Prisma.Sql[] = [];
    for (const [key, column] of [
      ['name', 'name'], ['assetId', 'asset_id'], ['groupId', 'group_id'], ['projectName', 'project_name'],
      ['notes', 'notes'], ['thumbnailReferenceImageId', 'thumbnail_reference_image_id'], ['enabled', 'enabled'],
    ] as const) {
      if (key in data) assignments.push(Prisma.sql`${Prisma.raw(`"${column}"`)} = ${data[key]}`);
    }
    if (body.restore) assignments.push(Prisma.sql`"deleted_at" = NULL`);
    assignments.push(Prisma.sql`"revision" = "revision" + 1`, Prisma.sql`"updated_at" = ${new Date()}`);
    const count = await db.$executeRaw(Prisma.sql`UPDATE "CharacterAsset" SET ${Prisma.join(assignments)} WHERE "id" = ${id} AND "owner_id" = ${user.id} AND "revision" = ${revision}`);
    if (count !== 1) throw new CharacterAssetError('角色记录已变化，请重读后再修改', 409, 'CHARACTER_ASSET_REVISION_CONFLICT');
    return findOwned(user.id, id, db);
  }));
  return present(row, user);
}

export async function deleteCharacterAsset(user: SessionUser, id: string, revisionValue: unknown) {
  assertWritesEnabled();
  const revision = parseCharacterAssetRevision(revisionValue);
  const row = await retrySqliteBusy(() => prisma.$transaction(async db => {
    const current = await findOwned(user.id, id, db);
    assertRevision(current, revision);
    if (current.deleted_at) return current;
    const now = new Date();
    const count = await db.$executeRaw`UPDATE "CharacterAsset" SET "deleted_at" = ${now}, "updated_at" = ${now}, "revision" = "revision" + 1 WHERE "id" = ${id} AND "owner_id" = ${user.id} AND "revision" = ${revision}`;
    if (count !== 1) throw new CharacterAssetError('角色记录已变化，请重读后再删除', 409, 'CHARACTER_ASSET_REVISION_CONFLICT');
    return findOwned(user.id, id, db);
  }));
  return present(row, user);
}

export async function resolveCharacterAssetReferences(ownerId: string, inputs: ReferenceImageInput[], db: Prisma.TransactionClient = prisma): Promise<Array<{ characterAssetId: string; revision: number; name: string; assetId: string; uri: string; position: number }>> {
  const selected = inputs.flatMap((input, index) => input.kind === 'ark_asset' ? [{ ...input, position: index + 1 }] : []);
  if (!selected.length) return [];
  const rows = await db.$queryRaw<Row[]>(Prisma.sql`SELECT * FROM "CharacterAsset" WHERE "owner_id" = ${ownerId} AND "provider" = ${PROVIDER} AND "id" IN (${Prisma.join(selected.map(input => input.characterAssetId))})`);
  const byId = new Map(rows.map(row => [row.id, row]));
  return selected.map(input => {
    const row = byId.get(input.characterAssetId);
    if (!row) throw new CharacterAssetError('角色记录不存在或无权使用，请移除后重新选择', 404, 'CHARACTER_ASSET_NOT_FOUND');
    if (row.deleted_at) throw new CharacterAssetError(`角色「${row.name}」已删除，请恢复或移除本次选择`, 409, 'CHARACTER_ASSET_DELETED');
    if (!row.enabled) throw new CharacterAssetError(`角色「${row.name}」已停用，请启用或移除本次选择`, 409, 'CHARACTER_ASSET_DISABLED');
    assertRevision(row, input.revision);
    const assetId = normalizeArkAssetId(row.asset_id);
    return { characterAssetId: row.id, revision: row.revision, name: row.name, assetId, uri: `asset://${assetId}`, position: input.position };
  });
}
