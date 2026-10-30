import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { CatalogSqlCompatibilityError } from '@/lib/assets/catalog-visibility-sql';
import { assertStudioActor, StudioSharingError } from './shared-contract';
import { parseGalleryQuery, queryStudioGallery } from './gallery';
import { galleryDirectorySql, type GalleryDirectoryRow } from './gallery-directory-sql';
import { catalogReaderReady, readCatalogRevision } from './catalog-revision';
import type { ImageStudioIdentity } from './access';
import type { GalleryQuery, GalleryQueryResult } from './gallery-types';
import { observeOperation } from '@/lib/performance/server-operations';

export async function queryGalleryDirectory(user: ImageStudioIdentity, raw: unknown): Promise<GalleryQueryResult> {
  const input = parseGalleryQuery(raw);
  if (input.protocol !== 'catalog-paged-v2' || !await catalogReaderReady(prisma)) return queryStudioGallery(user, raw);
  try {
    const result = await readGalleryPage(prisma, user, input);
    if (!await catalogReaderReady(prisma)) throw new CatalogSqlCompatibilityError('目录writer已切换');
    return result;
  }
  catch (error) {
    if (!(error instanceof CatalogSqlCompatibilityError)) throw error;
    // An old or unrecognized writer never leaves a paged client trusting its marker.
    return queryStudioGallery(user, { ...input, catalogRevision: undefined });
  }
}

/** Optimistic short reads: every covered mutation changes the same-transaction marker. */
export async function readGalleryPage(db: Prisma.TransactionClient, user: ImageStudioIdentity, input: GalleryQuery): Promise<GalleryQueryResult> {
  const observed = observeOperation('studio.gallery');
  const actor = await assertStudioActor(user.id, db), before = await readCatalogRevision(db, 'templates');
  if (!before) throw new CatalogSqlCompatibilityError('目录writer尚未就绪');
  const revision = createHash('sha256').update(JSON.stringify([before, actor.id, actor.role, actor.account_type, actor.feature_profile_id,
    input.query || '', input.scope || 'all', input.authorKey || null, input.sort || 'created', input.directoryOrder || {}, input.recentHints || {}])).digest('hex');
  if (input.catalogRevision && input.catalogRevision !== revision) throw new StudioSharingError('封面目录已变化，请重新读取', 409, 'state-conflict');
  const directory = await galleryDirectorySql(db, actor, input);
  const counts = await db.$queryRaw<Array<{ total: bigint }>>(Prisma.sql`WITH ${directory.ctes} SELECT count(*) AS total FROM filtered`);
  const total = Number(counts[0].total), pageSize = input.pageSize || 12, page = Math.min(input.page || 1, Math.max(1, Math.ceil(total / pageSize)));
  const pageRows = input.navigationOnly ? [] : await directory.rows(page, pageSize);
  const navigation = await galleryDirectorySql(db, actor, { sort: 'directory', directoryOrder: input.directoryOrder });
  const navigationCounts = await db.$queryRaw<Array<{ total: bigint }>>(Prisma.sql`WITH ${navigation.ctes} SELECT count(*) AS total FROM filtered`);
  const navigationTotal = Number(navigationCounts[0].total), navigationPageSize = 24;
  let navigationPage = Math.min(input.navigationPage || 1, Math.max(1, Math.ceil(navigationTotal / navigationPageSize)));
  if (input.locate?.moduleId || input.locate?.presetId) {
    const positions = await db.$queryRaw<Array<{ position: bigint }>>(Prisma.sql`WITH ${navigation.ctes}, positioned AS
      (SELECT *, row_number() OVER (ORDER BY ${navigation.order}) AS position FROM filtered)
      SELECT position FROM positioned WHERE ${input.locate.moduleId ? Prisma.sql`targetKind = 'module' AND targetId = ${input.locate.moduleId}`
        : Prisma.sql`key = ${'image_template:' + input.locate.presetId}`} LIMIT 1`);
    if (positions.length) navigationPage = Math.floor((Number(positions[0].position) - 1) / navigationPageSize) + 1;
  }
  const navigationRows = await navigation.rows(navigationPage, navigationPageSize);
  const project = async (rows: GalleryDirectoryRow[], navigationOnly: boolean) => {
    const result = await queryStudioGallery(actor, { navigationOnly, pageSize: 24 }, { tx: db, selection: {
      moduleIds: rows.filter(row => row.targetKind === 'module').map(row => row.targetId),
      presetIds: rows.filter(row => row.targetKind === 'preset').map(row => row.targetId),
    } });
    const available = new Map(result.navigation.map(item => [item.key, item]));
    if (rows.some(row => !available.has(row.key))) throw new StudioSharingError('目录权限或依赖已变化，请重新读取', 409);
    return { ...result, navigation: rows.map(row => available.get(row.key)!),
      items: rows.flatMap(row => result.items.filter(item => item.key === row.key)) };
  };
  const cover = await project(pageRows, Boolean(input.navigationOnly)), nav = await project(navigationRows, true);
  const groups = await db.$queryRaw<Array<{ groupName: string }>>(Prisma.sql`WITH ${navigation.ctes} SELECT DISTINCT groupName FROM filtered ORDER BY groupName`);
  if (before !== await readCatalogRevision(db, 'templates')) throw new StudioSharingError('封面目录已变化，请重新读取', 409, 'state-conflict');
  await assertStudioActor(user.id, db);
  const result: GalleryQueryResult = { protocol: 'catalog-paged-v2', items: cover.items, navigation: nav.navigation, matches: pageRows.length ? cover.navigation : [],
    total, page, pageSize, catalogRevision: revision, navigationTotal, navigationPage, navigationPageSize, directoryGroups: groups.map(row => row.groupName),
    capabilities: { independentReactions: true }, removedDefaultGroups: nav.removedDefaultGroups, deletedSourcePresetIds: [] };
  observed({ rows: result.items.length + result.navigation.length, bytes: Buffer.byteLength(JSON.stringify(result)) });
  return result;
}
