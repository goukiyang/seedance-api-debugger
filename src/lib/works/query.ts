import 'server-only';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { SessionUser } from '@/lib/auth/session';
import { workAccessSql, type WorkPermissionRow } from './access';
import { WORKS_PROTOCOL, WorkError, type WorkAudience, type WorkCard, type WorkPage, type WorkQuery } from './types';
import { projectWorkProvenance } from './provenance';
import { readWorkActivity } from './activity';
import { recommendationVisibleSql, recommendationReadCtes } from './recommendation-read';
import { recommendationSchemaReady } from './recommendation-events';
import { WORK_EDITORIAL_PREFIX, WORK_DISCOVERY_DAYS, WORK_DISCOVERY_LIMIT, readWorkEditorial, workEditorialCte, workAutomaticDiscoveryKey } from './editorial';

type PageKey = WorkPermissionRow & { completed_at: Date; project_visible: number | bigint; feed_round?: number; feed_tier?: number; feed_score?: number };
type Position = { time: string; id: string; rank?: [number, number, number] };
type WindowToken = { v: 1; owner: string; query: string; upper: string; position?: Position };
const secret = () => process.env.SESSION_SECRET || 'works-local-window-v1';
const sign = (body: string) => createHmac('sha256', secret()).update(body).digest('base64url');
function encode(value: WindowToken) { const body = Buffer.from(JSON.stringify(value)).toString('base64url'); return `${body}.${sign(body)}`; }
function decode(value: string, owner: string, query: string): WindowToken {
  try {
    if (value.length > 1800) throw new Error();
    const [body, signature, extra] = value.split('.');
    const expected = Buffer.from(sign(body)), actual = Buffer.from(signature || '');
    if (extra !== undefined || expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error();
    const token = JSON.parse(Buffer.from(body, 'base64url').toString()) as WindowToken;
    if (token.v !== 1 || token.owner !== owner || token.query !== query || !Number.isFinite(Date.parse(token.upper))
      || token.position && (typeof token.position.id !== 'string' || !Number.isFinite(Date.parse(token.position.time))
        || token.position.rank !== undefined && (!Array.isArray(token.position.rank) || token.position.rank.length !== 3 || !token.position.rank.every(Number.isSafeInteger)))) throw new Error();
    return token;
  } catch { throw new WorkError('浏览位置已失效，请刷新作品列表', 409, 'WORKS_WINDOW_CHANGED'); }
}
const idValue = (value: string | null) => {
  if (!value) return undefined;
  if (!/^[a-zA-Z0-9_:-]{1,180}$/.test(value)) throw new WorkError('筛选条件无效');
  return value;
};
export function parseWorkQuery(params: URLSearchParams): WorkQuery {
  const medium = params.get('medium') || 'all', scope = params.get('scope') || 'all';
  if (!['all', 'image', 'video'].includes(medium) || !['all', 'recommended', 'discoveries', 'mine', 'favorites', 'hidden', 'managed'].includes(scope)) throw new WorkError('筛选条件无效');
  return { medium: medium as WorkQuery['medium'], scope: scope as WorkQuery['scope'], q: (params.get('q') || '').trim().slice(0, 120),
    author: idValue(params.get('author')), project: idValue(params.get('project')), collection: idValue(params.get('collection')) };
}
const point = (key: PageKey): Position => ({ time: new Date(key.completed_at).toISOString(), id: key.id,
  ...(key.feed_round !== undefined ? { rank: [Number(key.feed_round), Number(key.feed_tier), Number(key.feed_score)] as [number, number, number] } : {}) });
function boundary(position: Position, direction: 'older' | 'newer', inclusive = false) {
  const time = new Date(position.time);
  if (position.rank) return Prisma.sql`(w.feed_round,w.feed_tier,w.feed_score,w.completed_at,w.id)
    ${Prisma.raw(direction === 'older' ? inclusive ? '<=' : '<' : '>')}
    (${position.rank[0]},${position.rank[1]},${position.rank[2]},${time},${position.id})`;
  return direction === 'older' ? Prisma.sql`(w.completed_at < ${time} OR (w.completed_at = ${time} AND w.id ${inclusive ? Prisma.raw('<=') : Prisma.raw('<')} ${position.id}))`
    : Prisma.sql`(w.completed_at > ${time} OR (w.completed_at = ${time} AND w.id > ${position.id}))`;
}
export function workMediaUrl(id: string, version: string, variant: string) {
  return `/api/works/${encodeURIComponent(id)}/media?${new URLSearchParams({ version, variant })}`;
}

/** Page projection is bounded by the selected IDs, including state, counts and collection joins. */
export async function projectWorkCards(user: SessionUser, keys: PageKey[], db: Prisma.TransactionClient = prisma): Promise<WorkCard[]> {
  if (!keys.length) return [];
  const ids = keys.map(key => key.id);
  const mediaIds = keys.map(key => key.media_id);
  const [works, versions, states, memberships, likes, activity, editorialRows] = await Promise.all([
    db.work.findMany({ where: { id: { in: ids } } }),
    db.workMediaVersion.findMany({ where: { id: { in: mediaIds } } }),
    db.workPersonalState.findMany({ where: { owner_id: user.id, work_id: { in: ids } } }),
    db.workCollectionItem.findMany({ where: { work_id: { in: ids }, collection: { owner_id: user.id, removed_at: null } }, select: { work_id: true, collection_id: true } }),
    db.$queryRaw<Array<{ work_id: string; amount: bigint | number }>>(Prisma.sql`SELECT work_id, count(*) AS amount FROM WorkPersonalState
      WHERE work_id IN (${Prisma.join(ids)}) AND liked = 1 GROUP BY work_id`),
    readWorkActivity(db, keys.filter(key => key.can_preview).map(key => key.id)),
    db.platformSetting.findMany({ where: { key: { in: keys.flatMap(key => [WORK_EDITORIAL_PREFIX + key.id,
      workAutomaticDiscoveryKey({ id: key.id, completed_at: new Date(key.completed_at) })]) } }, select: { key: true, value_json: true } }),
  ]);
  const pending = versions.filter(version => version.preview_status === 'pending').map(version => version.id);
  const [authors, projects, provenance, jobs] = await Promise.all([
    db.user.findMany({ where: { id: { in: Array.from(new Set(works.map(work => work.author_id))) } }, select: { id: true, name: true, avatar_url: true } }),
    db.project.findMany({ where: { id: { in: Array.from(new Set(works.flatMap(work => work.project_id ? [work.project_id] : []))) } }, select: { id: true, name: true } }),
    projectWorkProvenance(user, works, db),
    pending.length ? db.workRegistrationJob.findMany({ where: { source_kind: 'media_preview', source_id: { in: pending },
      status: { in: ['pending', 'running'] } }, select: { source_id: true } }) : [],
  ]);
  const workById = new Map(works.map(work => [work.id, work])), versionById = new Map(versions.map(version => [version.id, version]));
  const stateById = new Map(states.map(state => [state.work_id, state])), authorById = new Map(authors.map(author => [author.id, author]));
  const projectById = new Map(projects.map(project => [project.id, project])), countById = new Map(likes.map(row => [row.work_id, Number(row.amount)]));
  const preparing = new Set(jobs.map(job => job.source_id));
  const editorialByKey = new Map(editorialRows.map(row => [row.key, row]));
  return keys.flatMap(key => {
    const work = workById.get(key.id), media = versionById.get(key.media_id);
    // A concurrent replacement never pairs the old authorization result with a newer file.
    if (!work || !media || work.current_version_id !== key.media_id || work.revision !== Number(key.work_revision)) return [];
    const state = stateById.get(work.id), author = authorById.get(work.author_id), project = work.project_id ? projectById.get(work.project_id) : null;
    const canPreview = Boolean(key.can_preview), canDownload = Boolean(key.can_download);
    const nativePreview = Boolean(key.native_preview), owned = work.author_id === user.id;
    const hasPreview = canPreview && media.preview_status === 'ready' && (work.medium === 'image' ? Boolean(media.thumbnail_url) : Boolean(media.preview_url));
    const hasDetail = hasPreview || canPreview && Boolean(media.source_url) && (canDownload || work.medium === 'image' && Boolean(key.can_reuse));
    const name = author?.name?.trim();
    const safeName = name && !name.includes('@') && !/^\+?[\d\s-]{7,}$/.test(name) ? name : '同事';
    const reuse = key.can_reuse ? key.reference_id ? { referenceImageId: key.reference_id } : media.asset_id ? { assetId: media.asset_id } : null : null;
    const editorial = readWorkEditorial(editorialByKey.get(WORK_EDITORIAL_PREFIX + work.id), media.id, work.author_id,
      editorialByKey.get(workAutomaticDiscoveryKey(work)));
    const canRecommend = canPreview && work.discoverable && !work.withdrawn_at;
    return [{ id: work.id, title: work.title, medium: work.medium as WorkCard['medium'], mediaVersion: media.id, revision: work.revision,
      width: media.width, height: media.height, duration: media.duration, completedAt: work.completed_at.toISOString(),
      author: { id: work.author_id, name: safeName, avatarUrl: author?.avatar_url || null }, provenance: provenance.get(work.id),
      project: key.project_visible && project ? { id: project.id, name: project.name } : null,
      thumbnailUrl: canPreview && media.thumbnail_url ? workMediaUrl(work.id, media.id, 'thumbnail')
        : canPreview && work.medium === 'video' && media.video_task_id && media.source_url?.startsWith('/videos/')
          ? workMediaUrl(work.id, media.id, 'thumbnail') + '&cached=1' : null,
      previewUrl: hasPreview ? workMediaUrl(work.id, media.id, 'preview') : null,
      detailPreviewUrl: hasDetail ? workMediaUrl(work.id, media.id, 'detail') : null,
      downloadUrl: canDownload ? workMediaUrl(work.id, media.id, 'download') : null,
      previewStatus: hasPreview ? 'ready' : preparing.has(media.id) ? 'preparing'
        : media.preview_status === 'pending' && canPreview ? 'not-prepared' : 'unavailable',
      reuse, sourceHref: nativePreview ? work.source_kind === 'video_task' ? `/tasks/${encodeURIComponent(work.source_id)}`
        : work.source_kind === 'multiview_work' && owned ? `/multiview?work=${encodeURIComponent(work.source_id)}`
          : media.asset_id ? `/assets?content=${encodeURIComponent(`asset:${media.asset_id}`)}` : null : null,
      audience: work.audience as WorkAudience, canManage: owned, discoverable: work.discoverable, withdrawn: Boolean(work.withdrawn_at),
      editorial: { version: editorial.version, featured: editorial.featured, nominated: editorial.nominated,
        nominationExpired: Boolean(editorial.nominatedAt && editorial.nominatedAt + WORK_DISCOVERY_DAYS * 86400000 <= Date.now()),
        canFeature: canRecommend && user.role === 'admin' && user.account_type === 'internal', canNominate: canRecommend && owned },
      personal: { liked: state?.liked || false, favorited: state?.favorited || false, hidden: state?.hidden || false, version: state?.version || 0 },
      likeCount: countById.get(work.id) || 0, collectionIds: memberships.filter(item => item.work_id === work.id).map(item => item.collection_id),
      activity: canPreview ? activity.get(work.id) || { views: 0, reuses: 0 } : undefined,
    } satisfies WorkCard];
  });
}

export async function readWorkPage(user: SessionUser, params: URLSearchParams, db: Prisma.TransactionClient = prisma): Promise<WorkPage> {
  const query = parseWorkQuery(params);
  const discovery = query.scope === 'discoveries', ranked = query.scope === 'recommended' || discovery;
  const queryHash = createHash('sha256').update(JSON.stringify(ranked ? { ...query, rankingRule: 3 } : query)).digest('hex');
  const after = params.get('after'), before = params.get('before'), requestedAnchor = idValue(params.get('anchor'));
  if (after && before || requestedAnchor && (after || before)) throw new WorkError('浏览位置参数无效');
  const cursor = after || before ? decode((after || before)!, user.id, queryHash) : null;
  const window = params.get('window') ? decode(params.get('window')!, user.id, queryHash) : cursor || { v: 1 as const, owner: user.id, query: queryHash, upper: new Date().toISOString() };
  if (cursor && (cursor.upper !== window.upper || !cursor.position)) throw new WorkError('浏览位置已变化，请刷新列表', 409);
  const requestedLimit = Number(params.get('limit'));
  const limit = discovery ? WORK_DISCOVERY_LIMIT : Number.isSafeInteger(requestedLimit) && requestedLimit > 0 ? Math.min(24, requestedLimit) : 24;
  const access = await workAccessSql(db, user);
  if (query.collection && !await db.workCollection.findFirst({ where: { id: query.collection, owner_id: user.id, removed_at: null }, select: { id: true } })) throw new WorkError('收藏集不存在或不属于当前账号', 404);
  const recommendedReady = ranked && await recommendationSchemaReady(db);
  const filters: Prisma.Sql[] = [Prisma.sql`w.admitted_at <= ${new Date(window.upper)}`];
  if (ranked) filters.push(discovery
    ? Prisma.sql`editorial.nominated=1 AND editorial.featured=0 AND v.preview_status='ready'
        AND editorial.nominated_at>=${Date.parse(window.upper) - WORK_DISCOVERY_DAYS * 86400000}
        AND NOT (${recommendationVisibleSql()})`
    : Prisma.sql`editorial.featured=1 OR (${recommendationVisibleSql()})`);
  filters.push(query.scope === 'managed' ? Prisma.sql`${access.owner}` : Prisma.sql`(${access.canPreview})`);
  if (query.scope !== 'managed' && query.scope !== 'favorites' && !query.collection) filters.push(Prisma.sql`w.discoverable = 1`);
  if (query.scope === 'mine') filters.push(access.owner);
  if (query.scope === 'favorites') filters.push(Prisma.sql`personal.favorited = 1`);
  if (query.scope === 'hidden') filters.push(Prisma.sql`personal.hidden = 1`);
  else if (query.scope !== 'managed') filters.push(Prisma.sql`COALESCE(personal.hidden,0) = 0`);
  if (query.medium !== 'all') filters.push(Prisma.sql`w.medium = ${query.medium}`);
  if (query.author) filters.push(Prisma.sql`w.author_id = ${query.author}`);
  if (query.project) filters.push(Prisma.sql`w.project_id = ${query.project} AND ${access.projectView(Prisma.sql`w.project_id`)}`);
  if (query.collection) filters.push(Prisma.sql`EXISTS (SELECT 1 FROM WorkCollectionItem ci WHERE ci.collection_id = ${query.collection} AND ci.work_id = w.id)`);
  if (query.q) filters.push(Prisma.sql`w.title LIKE ${'%' + query.q.replace(/[\\%_]/g, '\\$&') + '%'} ESCAPE ${'\\'}`);
  const where = Prisma.join(filters.map(filter => Prisma.sql`(${filter})`), ' AND ');
  const projection = Prisma.sql`w.id,v.id AS media_id,w.revision AS work_revision,w.completed_at,
    (${access.canPreview}) AS can_preview,(${access.canDownload}) AS can_download,(${access.canReuse}) AS can_reuse,
    (${access.nativePreview}) AS native_preview,${access.referenceId} AS reference_id,
    (${access.projectView(Prisma.sql`w.project_id`)}) AS project_visible`;
  const select = async (extra: Prisma.Sql, ascending = false, amount = limit + 1) => {
    const direction = ascending ? Prisma.raw('ASC') : Prisma.raw('DESC');
    if (ranked) {
      return db.$queryRaw<PageKey[]>(Prisma.sql`WITH ${access.ctes},
        ${workEditorialCte(new Date(window.upper), discovery)},
        ${recommendationReadCtes(user.id, access, new Date(window.upper), recommendedReady)},
        admission_ids AS (SELECT work_id FROM editorial WHERE ${discovery ? Prisma.sql`nominated=1` : Prisma.sql`featured=1`}
          ${discovery ? Prisma.empty : Prisma.sql`UNION SELECT work_id FROM recommendation_pool`}),
        eligible AS MATERIALIZED (
          SELECT ${projection},w.author_id,COALESCE(context.submission_key,w.id) AS group_key,
            COALESCE(editorial.featured,0) AS feed_tier,COALESCE(admission.score,0) AS feed_score
          FROM admission_ids requested CROSS JOIN Work w ON w.id=requested.work_id ${access.joins}
          LEFT JOIN editorial ON editorial.work_id=w.id AND editorial.media_version=v.id AND editorial.author_id=w.author_id
          LEFT JOIN recommendation_pool admission ON admission.work_id=w.id
          LEFT JOIN WorkPersonalState personal ON personal.work_id=w.id AND personal.owner_id=${user.id}
          LEFT JOIN WorkContext context ON context.work_id=w.id AND context.media_version_id=v.id AND context.schema_version=1
          WHERE ${where}
        ), representatives AS (
          SELECT *,row_number() OVER (PARTITION BY group_key ORDER BY feed_tier DESC,feed_score DESC,completed_at DESC,id DESC) AS group_position FROM eligible
        ), authors AS (
          SELECT *,row_number() OVER (PARTITION BY author_id ORDER BY feed_tier DESC,feed_score DESC,completed_at DESC,id DESC) AS author_position
          FROM representatives WHERE group_position=1
        ), spaced AS (
          SELECT *,-CAST((author_position-1)/2 AS INTEGER) AS feed_round FROM authors
        ) SELECT * FROM spaced w WHERE ${discovery ? Prisma.sql`author_position=1` : Prisma.sql`1=1`} ${extra}
        ORDER BY w.feed_round ${direction},w.feed_tier ${direction},w.feed_score ${direction},w.completed_at ${direction},w.id ${direction} LIMIT ${amount}`);
    }
    return db.$queryRaw<PageKey[]>(Prisma.sql`WITH ${access.ctes}
      SELECT ${projection} FROM Work w ${access.joins}
      LEFT JOIN WorkPersonalState personal ON personal.work_id=w.id AND personal.owner_id=${user.id}
      WHERE ${where} ${extra} ORDER BY w.completed_at ${direction},w.id ${direction} LIMIT ${amount}`);
  };
  let keys: PageKey[], hasPrevious = false, hasNext = false, anchorUnavailable = false, anchorId: string | null = null;
  if (requestedAnchor) {
    const anchor = (await select(Prisma.sql`AND w.id = ${requestedAnchor}`, false, 1))[0];
    if (anchor) {
      anchorId = anchor.id;
      const half = Math.floor(limit / 2);
      const [newer, older] = await Promise.all([select(Prisma.sql`AND ${boundary(point(anchor), 'newer')}`, true, half + 1),
        select(Prisma.sql`AND ${boundary(point(anchor), 'older', true)}`, false, limit - half + 1)]);
      hasPrevious = newer.length > half; hasNext = older.length > limit - half;
      keys = [...newer.slice(0, half).reverse(), ...older.slice(0, limit - half)];
    } else { anchorUnavailable = true; const rows = await select(Prisma.empty); hasNext = rows.length > limit; keys = rows.slice(0, limit); }
  } else {
    const rows = await select(cursor?.position ? Prisma.sql`AND ${boundary(cursor.position, before ? 'newer' : 'older')}` : Prisma.empty, Boolean(before));
    if (before) { hasPrevious = rows.length > limit; keys = rows.slice(0, limit).reverse(); }
    else { hasNext = rows.length > limit; keys = rows.slice(0, limit); }
    if (keys.length && (before || after)) {
      if (before) hasNext = (await select(Prisma.sql`AND ${boundary(point(keys[keys.length - 1]), 'older')}`, false, 1)).length > 0;
      else hasPrevious = (await select(Prisma.sql`AND ${boundary(point(keys[0]), 'newer')}`, true, 1)).length > 0;
    }
  }
  const base: WindowToken = { v: 1, owner: user.id, query: queryHash, upper: window.upper };
  let omittedIds: string[] | undefined;
  if (query.scope === 'recommended' && params.has('check')) {
    const checked = Array.from(new Set(params.get('check')!.split(',')));
    if (checked.length > 48 || checked.some(id => !idValue(id))) throw new WorkError('作品核对范围无效');
    const current = new Set((await select(Prisma.sql`AND w.id IN (${Prisma.join(checked)})`, false, 48)).map(key => key.id));
    omittedIds = checked.filter(id => !current.has(id));
  }
  return { protocol: WORKS_PROTOCOL, viewerId: user.id, items: await projectWorkCards(access.user, keys, db), window: encode(base),
    previousCursor: hasPrevious && keys.length ? encode({ ...base, position: point(keys[0]) }) : null,
    nextCursor: !discovery && hasNext && keys.length ? encode({ ...base, position: point(keys[keys.length - 1]) }) : null,
    anchorId, anchorUnavailable, ...(omittedIds ? { omittedIds } : {}) };
}

export async function readWorkDetail(user: SessionUser, id: string, db: Prisma.TransactionClient = prisma) {
  const access = await workAccessSql(db, user);
  const keys = await db.$queryRaw<PageKey[]>(Prisma.sql`WITH ${access.ctes} SELECT w.id, v.id AS media_id,
    w.revision AS work_revision, w.completed_at, (${access.canPreview}) AS can_preview, (${access.canDownload}) AS can_download,
    (${access.canReuse}) AS can_reuse, (${access.nativePreview}) AS native_preview, ${access.referenceId} AS reference_id,
    (${access.projectView(Prisma.sql`w.project_id`)}) AS project_visible FROM Work w ${access.joins}
    WHERE w.id = ${id} AND ((${access.canPreview}) OR ${access.owner}) LIMIT 1`);
  const card = (await projectWorkCards(access.user, keys, db))[0] || null;
  return card;
}
