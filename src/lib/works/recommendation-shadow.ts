import 'server-only';

import { Prisma } from '@prisma/client';
import type { SessionUser } from '@/lib/auth/session';
import { workAccessSql } from './access';
import { canUseWorksPreview } from './rollout.server';
import { replayWorkRecommendation, WORK_RECOMMENDATION_RULE } from './recommendation-score';

const PAGE_SIZE = 24;
const MAX_PAGES = 192;
const EDGE_LIMIT = 24;
const TIME_BUDGET_MS = 10_000;

type Source = { id: string; asset_id: string | null; completed_at: Date; links: string };
type Visible = { id: string; evidence_at: Date | null; own_image: number | bigint };

/** One bounded pass over a static snapshot. Scores never leave this function. */
export async function trialWorkRecommendation(db: Prisma.TransactionClient, user: SessionUser) {
  if (!canUseWorksPreview(user)) throw new Error('Work recommendation trial is restricted to the existing preview account');
  const started = performance.now();
  const access = await workAccessSql(db, user);
  if (!canUseWorksPreview(access.user)) throw new Error('Work recommendation preview account has changed');
  const result = { rule: WORK_RECOMMENDATION_RULE, scanned: 0, indexedCandidates: 0, truncatedSources: 0,
    confirmedInputs: 0, qualified: 0, complete: false, pages: 0, slowestPageMs: 0, elapsedMs: 0 };
  let cursor = '';
  while (result.pages < MAX_PAGES && performance.now() - started < TIME_BUDGET_MS) {
    const batchStarted = performance.now();
    // Seek on the primary key before joining. The per-asset limit applies even to a popular input.
    const sources = await db.$queryRaw<Source[]>(Prisma.sql`WITH page AS MATERIALIZED (
      SELECT id, current_version_id, medium, discoverable, completed_at FROM Work
      WHERE id > ${cursor} ORDER BY id LIMIT ${PAGE_SIZE}
    ) SELECT page.id, page.completed_at, version.asset_id, COALESCE((
      SELECT json_group_array(work_id) FROM (
        SELECT link.work_id FROM WorkSourceLink link
        WHERE link.source_kind = 'asset' AND link.source_id = version.asset_id AND link.relation = 'direct-input'
        ORDER BY link.work_id LIMIT ${EDGE_LIMIT + 1}
      )
    ), '[]') AS links
    FROM page LEFT JOIN WorkMediaVersion version ON version.id = page.current_version_id AND version.work_id = page.id
      AND page.medium = 'image' AND page.discoverable = 1
      AND version.content_hash IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM WorkMediaVersion other WHERE other.asset_id = version.asset_id AND other.id <> version.id)
    ORDER BY page.id`);
    result.scanned += sources.length;
    result.pages++;
    const candidates = sources.flatMap(source => {
      const links: string[] = JSON.parse(source.links);
      if (!links.length) return [];
      result.indexedCandidates++;
      if (links.length > EDGE_LIMIT) {
        result.truncatedSources++;
        return [];
      }
      return [{ source, links }];
    });

    if (candidates.length) {
      const ids = Array.from(new Set(candidates.flatMap(({ source, links }) => [source.id, ...links])));
      const visible = await db.$queryRaw<Visible[]>(Prisma.sql`WITH ${access.ctes}
        SELECT w.id, image_source.created_at AS evidence_at,
          (w.source_kind = 'image_task' AND w.author_id = ${access.user.id}
            AND (w.project_id IS NULL OR ${access.projectView(Prisma.sql`w.project_id`)})) AS own_image
        FROM Work w ${access.joins}
        WHERE w.id IN (${Prisma.join(ids)}) AND w.discoverable = 1 AND (${access.canPreview})
          AND NOT EXISTS (SELECT 1 FROM WorkPersonalState personal
            WHERE personal.work_id = w.id AND personal.owner_id = ${access.user.id} AND personal.hidden = 1)`);
      const byId = new Map(visible.map(row => [row.id, row]));
      for (const { source, links } of candidates) {
        if (!byId.has(source.id)) continue;
        // Image context indexes direct-input only from verified frozen primary roles.
        // Match the exact downstream media index again. Same-batch and ambiguous
        // independent purposes conservatively contribute just one input use.
        const usable = links.filter(id => {
          const target = byId.get(id);
          return id !== source.id && target?.own_image && target.evidence_at &&
            target.evidence_at >= source.completed_at;
        });
        if (!usable.length) continue;
        const [evidence] = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT w.id FROM Work w
          JOIN WorkContext context ON context.work_id = w.id
            AND context.media_version_id = w.current_version_id AND context.schema_version = 1
          JOIN WorkSourceLink link ON link.work_id = w.id AND link.media_version_id = w.current_version_id
            AND link.source_kind = 'asset' AND link.source_id = ${source.asset_id} AND link.relation = 'direct-input'
          WHERE w.id IN (${Prisma.join(usable)}) ORDER BY w.id LIMIT 1`);
        if (!evidence) continue;
        const verdict = replayWorkRecommendation([{
          id: evidence.id, order: 0,
          changes: { primary: { purpose: 'verified-input', chain: 'verified-input', signal: 'input' } },
        }]);
        result.confirmedInputs++;
        if (verdict.qualified) result.qualified++;
      }
    }
    result.slowestPageMs = Math.max(result.slowestPageMs, Math.round(performance.now() - batchStarted));
    if (sources.length < PAGE_SIZE) { result.complete = true; break; }
    cursor = sources[sources.length - 1].id;
  }
  result.elapsedMs = Math.round(performance.now() - started);
  return result;
}
