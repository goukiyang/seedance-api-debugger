import 'server-only';
import { Prisma, type PlatformSetting } from '@prisma/client';
import type { SessionUser } from '@/lib/auth/session';
import { getWorkAccess } from './access';
import { runWorkOperation } from './operations';
import { canUseWorksPreview } from './rollout.server';
import { WorkError, type WorkEditorialMutation } from './types';

export const WORK_EDITORIAL_PREFIX = 'works-editorial:v1:';
export const WORK_AUTOMATIC_DISCOVERY_PREFIX = 'works-discovery-auto:v1:';
export const WORK_DISCOVERY_LIMIT = 4;
export const WORK_DISCOVERY_DAYS = 7;
type Editorial = { schema: 1; version: number; mediaVersion: string; authorId: string;
  featured: boolean; featuredAt: number | null; nominated: boolean; nominatedAt: number | null };
type EditorialRow = Pick<PlatformSetting, 'value_json'> | undefined | null;
export const workAutomaticDiscoveryKey = (work: { id: string; completed_at: Date }) =>
  WORK_AUTOMATIC_DISCOVERY_PREFIX + work.completed_at.toISOString() + ':' + work.id;

/** Background-only admission, independent of whether anybody has opened the plaza. */
export async function ensureAutomaticWorkDiscovery(db: Prisma.TransactionClient, work: {
  id: string; author_id: string; current_version_id: string | null; completed_at: Date; discoverable: boolean; withdrawn_at: Date | null;
}, now = Date.now()) {
  if (!work.current_version_id || !work.discoverable || work.withdrawn_at
    || work.completed_at.getTime() > now || work.completed_at.getTime() < now - WORK_DISCOVERY_DAYS * 86400000) return;
  const actor = await db.user.findUnique({ where: { id: work.author_id }, select: {
    id: true, account_type: true, status: true, feishu_user_id: true, feishu_open_id: true, feishu_union_id: true, feishu_tenant_key: true,
  } });
  if (!actor || actor.status !== 'active' || !canUseWorksPreview({ ...actor, feishu: { user_id: actor.feishu_user_id,
    open_id: actor.feishu_open_id, union_id: actor.feishu_union_id, tenant_key: actor.feishu_tenant_key } })) return;
  const media = await db.workMediaVersion.findUnique({ where: { id: work.current_version_id }, select: { preview_status: true } });
  if (media?.preview_status !== 'ready') return;
  const explicit = editorialValue(await db.platformSetting.findUnique({ where: { key: WORK_EDITORIAL_PREFIX + work.id } }));
  if (explicit?.mediaVersion === work.current_version_id && explicit.authorId === work.author_id) return;
  const key = workAutomaticDiscoveryKey(work);
  const value = JSON.stringify({ schema: 1, version: 1, workId: work.id, mediaVersion: work.current_version_id,
    authorId: work.author_id, featured: false, featuredAt: null, nominated: true, nominatedAt: work.completed_at.getTime() });
  await db.$executeRaw(Prisma.sql`INSERT INTO PlatformSetting(id,key,value_json,created_at,updated_at)
    SELECT ${key},${key},${value},${new Date(now)},${new Date(now)} FROM Work
    WHERE id=${work.id} AND current_version_id=${work.current_version_id} AND discoverable=1 AND withdrawn_at IS NULL
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at
    WHERE PlatformSetting.value_json<>excluded.value_json`);
}

function editorialValue(row: EditorialRow): Editorial | null {
  if (!row) return null;
  const value = JSON.parse(row.value_json) as Editorial;
  if (value.schema !== 1 || !Number.isSafeInteger(value.version) || value.version < 1
    || typeof value.mediaVersion !== 'string' || typeof value.authorId !== 'string'
    || typeof value.featured !== 'boolean' || typeof value.nominated !== 'boolean'
    || ![value.featuredAt, value.nominatedAt].every(at => at === null || Number.isSafeInteger(at) && at > 0)) {
    throw new WorkError('作品推荐设置暂时无法读取，请稍后重试', 503);
  }
  return value;
}

export function readWorkEditorial(row: EditorialRow, mediaVersion: string, authorId: string, automatic?: EditorialRow): Editorial {
  const explicit = editorialValue(row);
  if (explicit?.mediaVersion === mediaVersion && explicit.authorId === authorId) return explicit;
  const candidate = editorialValue(automatic);
  if (candidate?.mediaVersion === mediaVersion && candidate.authorId === authorId) return { ...candidate, version: explicit?.version || 0 };
  return { schema: 1, version: explicit?.version || 0, mediaVersion, authorId, featured: false, featuredAt: null, nominated: false, nominatedAt: null };
}

export function workEditorialCte(upper: Date, includeAutomatic = false) {
  const projection = (id: Prisma.Sql) => Prisma.sql`${id} AS work_id,
      json_extract(value_json,'$.mediaVersion') AS media_version,
      json_extract(value_json,'$.authorId') AS author_id,
      CASE WHEN json_extract(value_json,'$.featured')=1 AND json_extract(value_json,'$.featuredAt')<=${upper.getTime()} THEN 1 ELSE 0 END AS featured,
      CASE WHEN json_extract(value_json,'$.nominated')=1 AND json_extract(value_json,'$.nominatedAt')<=${upper.getTime()} THEN 1 ELSE 0 END AS nominated,
      json_extract(value_json,'$.nominatedAt') AS nominated_at`;
  return Prisma.sql`editorial_explicit AS MATERIALIZED (
    SELECT ${projection(Prisma.sql`substr(key,${WORK_EDITORIAL_PREFIX.length + 1})`)}
    FROM PlatformSetting WHERE key>=${WORK_EDITORIAL_PREFIX} AND key<${WORK_EDITORIAL_PREFIX.slice(0, -1) + ';'}
      AND json_valid(value_json) AND json_extract(value_json,'$.schema')=1
  ), editorial AS MATERIALIZED (
    SELECT * FROM editorial_explicit
    ${includeAutomatic ? Prisma.sql`UNION ALL SELECT automatic.* FROM (
      SELECT ${projection(Prisma.sql`json_extract(value_json,'$.workId')`)} FROM PlatformSetting
      WHERE key>=${WORK_AUTOMATIC_DISCOVERY_PREFIX + new Date(upper.getTime() - WORK_DISCOVERY_DAYS * 86400000).toISOString()}
        AND key<${WORK_AUTOMATIC_DISCOVERY_PREFIX + upper.toISOString() + ';'}
        AND json_valid(value_json) AND json_extract(value_json,'$.schema')=1
    ) automatic WHERE NOT EXISTS (SELECT 1 FROM editorial_explicit explicit
      WHERE explicit.work_id=automatic.work_id AND explicit.media_version=automatic.media_version AND explicit.author_id=automatic.author_id)` : Prisma.empty}
  )`;
}

export async function mutateWorkEditorial(user: SessionUser, workId: string, input: WorkEditorialMutation) {
  if (!input || !['feature', 'nominate'].includes(input.action) || typeof input.active !== 'boolean'
    || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0
    || typeof input.expectedMediaVersion !== 'string' || !/^[A-Za-z0-9_:-]{1,180}$/.test(input.expectedMediaVersion)) throw new WorkError('作品推荐参数无效');
  return runWorkOperation(user, { ...input, intent: ['work-editorial-v1', workId, input.action, input.active, input.expectedVersion, input.expectedMediaVersion] }, async (tx, actor) => {
    if (!canUseWorksPreview(actor)) throw new WorkError('页面暂不可用', 404);
    const access = await getWorkAccess(actor, workId, tx, true);
    if (!access) throw new WorkError('作品暂不可用', 404);
    const { work, media } = access;
    if (input.action === 'feature' ? actor.role !== 'admin' || actor.account_type !== 'internal' || !access.canPreview : work.author_id !== actor.id) {
      throw new WorkError(input.action === 'feature' ? '只有管理员可以设置精选' : '只能提交或撤下本人作品', 403);
    }
    if (media.id !== input.expectedMediaVersion) throw new WorkError('作品版本已变化，请重新打开后操作', 409, 'WORKS_VERSION_CHANGED');
    if (input.active && (!access.canPreview || !work.discoverable || work.withdrawn_at)) throw new WorkError('作品当前不可推荐，请先恢复原有分享', 409);
    const key = WORK_EDITORIAL_PREFIX + workId;
    const [explicit, automatic] = await Promise.all([
      tx.platformSetting.findUnique({ where: { key } }),
      tx.platformSetting.findUnique({ where: { key: workAutomaticDiscoveryKey(work) } }),
    ]);
    const previous = readWorkEditorial(explicit, media.id, work.author_id, automatic);
    if (previous.version !== input.expectedVersion) throw new WorkError('推荐设置已变化，请重新读取后操作', 409, 'WORKS_EDITORIAL_CHANGED');
    if (input.action === 'nominate' && input.active && previous.nominatedAt && previous.nominatedAt + WORK_DISCOVERY_DAYS * 86400000 <= Date.now()) {
      throw new WorkError('本版本的新作展示期已结束，可提交新的作品', 409, 'WORKS_NOMINATION_EXPIRED');
    }
    const next: Editorial = { ...previous, version: previous.version + 1 };
    if (input.action === 'feature') { next.featured = input.active; next.featuredAt = input.active ? Date.now() : null; }
    else { next.nominated = input.active; next.nominatedAt = previous.nominatedAt || (input.active ? Date.now() : null); }
    await tx.platformSetting.upsert({ where: { key }, create: { key, value_json: JSON.stringify(next) }, update: { value_json: JSON.stringify(next) } });
    return { kind: 'work-editorial', workId, mediaVersion: media.id, editorialVersion: next.version, featured: next.featured, nominated: next.nominated };
  });
}
