import 'server-only';
import { Prisma, type PlatformSetting } from '@prisma/client';
import type { SessionUser } from '@/lib/auth/session';
import { getWorkAccess } from './access';
import { runWorkOperation } from './operations';
import { canUseWorksPreview } from './rollout.server';
import { WorkError, type WorkEditorialMutation } from './types';

export const WORK_EDITORIAL_PREFIX = 'works-editorial:v1:';
export const WORK_DISCOVERY_LIMIT = 4;
export const WORK_DISCOVERY_DAYS = 7;
type Editorial = { schema: 1; version: number; mediaVersion: string; authorId: string;
  featured: boolean; featuredAt: number | null; nominated: boolean; nominatedAt: number | null };

export function readWorkEditorial(row: Pick<PlatformSetting, 'value_json'> | undefined | null, mediaVersion: string, authorId: string): Editorial {
  if (!row) return { schema: 1, version: 0, mediaVersion, authorId, featured: false, featuredAt: null, nominated: false, nominatedAt: null };
  const value = JSON.parse(row.value_json) as Editorial;
  if (value.schema !== 1 || !Number.isSafeInteger(value.version) || value.version < 1
    || typeof value.mediaVersion !== 'string' || typeof value.authorId !== 'string'
    || typeof value.featured !== 'boolean' || typeof value.nominated !== 'boolean'
    || ![value.featuredAt, value.nominatedAt].every(at => at === null || Number.isSafeInteger(at) && at > 0)) {
    throw new WorkError('作品推荐设置暂时无法读取，请稍后重试', 503);
  }
  if (value.mediaVersion === mediaVersion && value.authorId === authorId) return value;
  // A replacement needs a new explicit nomination/selection, never an inherited endorsement.
  return { schema: 1, version: value.version, mediaVersion, authorId, featured: false, featuredAt: null, nominated: false, nominatedAt: null };
}

export function workEditorialCte(upper: Date) {
  return Prisma.sql`editorial AS MATERIALIZED (
    SELECT substr(key,${WORK_EDITORIAL_PREFIX.length + 1}) AS work_id,
      json_extract(value_json,'$.mediaVersion') AS media_version,
      json_extract(value_json,'$.authorId') AS author_id,
      CASE WHEN json_extract(value_json,'$.featured')=1 AND json_extract(value_json,'$.featuredAt')<=${upper.getTime()} THEN 1 ELSE 0 END AS featured,
      CASE WHEN json_extract(value_json,'$.nominated')=1 AND json_extract(value_json,'$.nominatedAt')<=${upper.getTime()} THEN 1 ELSE 0 END AS nominated,
      json_extract(value_json,'$.nominatedAt') AS nominated_at
    FROM PlatformSetting WHERE key>=${WORK_EDITORIAL_PREFIX} AND key<${WORK_EDITORIAL_PREFIX.slice(0, -1) + ';'}
      AND json_valid(value_json) AND json_extract(value_json,'$.schema')=1
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
    const previous = readWorkEditorial(await tx.platformSetting.findUnique({ where: { key } }), media.id, work.author_id);
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
