import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { SessionUser } from '@/lib/auth/session';
import { getWorkAccess, workAccessSql, type WorkPermissionRow } from './access';
import { projectWorkCards } from './query';
import { WorkError } from './types';
import { readIndexedWorkMethod } from './context-method';
import { worksContextSchemaReady } from './context-index';
import type { WorkContext, WorkContextGroupId } from './context-types';

type ContextKey = WorkPermissionRow & { completed_at: Date; project_visible: number | bigint; diversity_rank: number | bigint };
const labels: Record<WorkContextGroupId, string> = { 'same-submission': '同次提交', source: '来源作品', derived: '衍生作品', 'same-template': '同模板其他作品' };
type Cursor = { v: 1; viewer: string; work: string; media: string; group: WorkContextGroupId; upper: string; rank: number; time: string; id: string };
const signature = (value: string) => createHmac('sha256', process.env.SESSION_SECRET || 'works-local-context-v1').update(value).digest('base64url');
function encode(value: Cursor) { const body = Buffer.from(JSON.stringify(value)).toString('base64url'); return `${body}.${signature(body)}`; }
function decode(value: string): Cursor {
  try {
    if (value.length > 2000) throw new Error();
    const [body, sig, extra] = value.split('.'), expected = Buffer.from(signature(body)), actual = Buffer.from(sig || '');
    if (extra !== undefined || expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error();
    const result = JSON.parse(Buffer.from(body, 'base64url').toString()) as Cursor;
    if (result.v !== 1 || !Number.isFinite(Date.parse(result.upper)) || !Number.isFinite(Date.parse(result.time)) || !Number.isSafeInteger(result.rank) || result.rank < 0) throw new Error();
    return result;
  } catch { throw new WorkError('关联浏览位置已失效，请重新打开作品', 409, 'WORKS_CONTEXT_CURSOR_INVALID'); }
}

/** All source edges and labels resolve through current output permissions before the bounded page. */
export async function readWorkContext(user: SessionUser, workId: string, params = new URLSearchParams(), db: Prisma.TransactionClient = prisma): Promise<WorkContext> {
  const root = await getWorkAccess(user, workId, db);
  if (!root?.canPreview) throw new WorkError('作品不存在或无权查看', 404, 'WORKS_NOT_FOUND');
  if (params.has('version') && params.get('version') !== root.media.id) throw new WorkError('作品版本已变化，请重新读取', 409, 'WORKS_VERSION_CHANGED');
  const selection = root.work.source_kind === 'video_task' && root.nativePreview && root.work.project_id
    ? await db.videoDeliverySelection.findFirst({ where: { selected_task_id: root.work.source_id, project_id: root.work.project_id }, select: { state: true } }) : null;
  const delivery: WorkContext['delivery'] = selection ? { selected: true, locked: selection.state === 'locked',
    label: selection.state === 'locked' ? '已锁定交付' : '已选交付' } : undefined;
  const ready = await worksContextSchemaReady(db);
  const metadata = ready ? await db.workContext.findUnique({ where: { work_id: workId } }) : null;
  if (!ready || !metadata || metadata.schema_version !== 1 || metadata.media_version_id !== root.media.id) return { viewerId: user.id, workId, mediaVersion: root.media.id, method: null, groups: [], indexing: true, ...(delivery ? { delivery } : {}) };
  const requestedGroup = params.get('group');
  if (requestedGroup && !Object.prototype.hasOwnProperty.call(labels, requestedGroup)) throw new WorkError('关联分组无效');
  const cursor = params.get('after') ? decode(params.get('after')!) : null;
  if (cursor && (cursor.viewer !== user.id || cursor.work !== workId || cursor.media !== root.media.id || cursor.group !== requestedGroup)) throw new WorkError('关联浏览位置已变化，请重新打开', 409, 'WORKS_CONTEXT_CHANGED');
  const upper = cursor?.upper || new Date().toISOString();
  const access = await workAccessSql(db, user);
  const groupIds: WorkContextGroupId[] = requestedGroup ? [requestedGroup as WorkContextGroupId] : ['same-template', 'same-submission', 'derived', 'source'];
  const result: WorkContext = { viewerId: user.id, workId, mediaVersion: root.media.id, method: await readIndexedWorkMethod(access.user, root, metadata, db), groups: [], indexing: false, ...(delivery ? { delivery } : {}) };
  for (const group of groupIds) {
    let candidates: Prisma.Sql;
    if (group === 'same-submission') {
      if (!metadata.submission_key) continue;
      candidates = Prisma.sql`SELECT work_id,media_version_id FROM WorkContext WHERE schema_version = 1 AND submission_key = ${metadata.submission_key} AND indexed_at <= ${new Date(upper)}`;
    } else if (group === 'same-template') {
      if (!metadata.template_module || !metadata.template_id) continue;
      candidates = Prisma.sql`SELECT work_id,media_version_id FROM WorkContext WHERE schema_version = 1 AND template_module = ${metadata.template_module}
        AND template_id = ${metadata.template_id} AND indexed_at <= ${new Date(upper)}`;
    } else if (group === 'source') {
      candidates = Prisma.sql`SELECT source.id AS work_id,source.current_version_id AS media_version_id
        FROM WorkSourceLink link JOIN Work source ON source.source_kind = link.source_kind AND source.source_id = link.source_id
        WHERE link.work_id = ${workId} AND link.media_version_id = ${root.media.id}
        UNION SELECT media.work_id,media.id FROM WorkSourceLink link JOIN WorkMediaVersion media ON link.source_kind = 'asset' AND link.source_id = media.asset_id
        WHERE link.work_id = ${workId} AND link.media_version_id = ${root.media.id}
        UNION SELECT source_work_id,source_media_version_id FROM WorkDerivedLink WHERE derived_work_id = ${workId}
          AND derived_media_version_id = ${root.media.id} AND removed_at IS NULL`;
    } else {
      candidates = Prisma.sql`SELECT work_id,media_version_id FROM WorkSourceLink
        WHERE (source_kind = ${root.work.source_kind} AND source_id = ${root.work.source_id})
          ${root.media.asset_id ? Prisma.sql`OR (source_kind = 'asset' AND source_id = ${root.media.asset_id})` : Prisma.empty}
        UNION SELECT derived_work_id,derived_media_version_id FROM WorkDerivedLink WHERE source_work_id = ${workId}
          AND source_media_version_id = ${root.media.id} AND removed_at IS NULL`;
    }
    // The first result per author is each author's newest visible work. Favorites never rank recommendations.
    const ranking = group === 'same-template' ? Prisma.sql`ROW_NUMBER() OVER (PARTITION BY author_id ORDER BY completed_at DESC,id DESC)` : Prisma.sql`0`;
    const after = cursor ? Prisma.sql`WHERE (diversity_rank > ${cursor.rank} OR (diversity_rank = ${cursor.rank}
      AND (completed_at < ${new Date(cursor.time)} OR (completed_at = ${new Date(cursor.time)} AND id < ${cursor.id}))))` : Prisma.empty;
    const rows = await db.$queryRaw<ContextKey[]>(Prisma.sql`WITH ${access.ctes}, context_candidates AS (${candidates}), eligible_context AS (
      SELECT w.id,v.id AS media_id,w.revision AS work_revision,w.completed_at,w.author_id,
        (${access.canPreview}) AS can_preview,(${access.canDownload}) AS can_download,(${access.canReuse}) AS can_reuse,
        (${access.nativePreview}) AS native_preview,${access.referenceId} AS reference_id,
        (${access.projectView(Prisma.sql`w.project_id`)}) AS project_visible
      FROM context_candidates candidate JOIN Work w ON w.id = candidate.work_id AND w.current_version_id = candidate.media_version_id ${access.joins}
      WHERE w.id <> ${workId} AND w.discoverable = 1 AND w.admitted_at <= ${new Date(upper)} AND (${access.canPreview})
        AND NOT EXISTS (SELECT 1 FROM WorkPersonalState personal WHERE personal.work_id = w.id AND personal.owner_id = ${user.id} AND personal.hidden = 1)
      ${group === 'same-template' ? Prisma.sql`ORDER BY w.completed_at DESC,w.id DESC LIMIT 96` : Prisma.empty}
    ), visible_context AS (SELECT *,${ranking} AS diversity_rank FROM eligible_context) SELECT * FROM visible_context ${after} ORDER BY diversity_rank ASC,completed_at DESC,id DESC LIMIT 9`);
    const page = rows.slice(0, 8), items = await projectWorkCards(access.user, page, db), last = page[page.length - 1];
    if (items.length || requestedGroup) result.groups.push({ id: group, label: labels[group], items, nextCursor: rows.length > 8 && last
      ? encode({ v: 1, viewer: user.id, work: workId, media: root.media.id, group, upper, rank: Number(last.diversity_rank), time: new Date(last.completed_at).toISOString(), id: last.id }) : null });
  }
  return result;
}
