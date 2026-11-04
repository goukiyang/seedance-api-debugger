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

type Link = { id: string; version: string };
type Source = { id: string; version: string | null; completed_at: Date; links: string };
type Visible = { id: string; version: string; evidence_at: Date | null; own_image: number | bigint };

export async function readWorkRecommendationBatch(db: Prisma.TransactionClient, user: SessionUser, cursor: string) {
  if (!canUseWorksPreview(user)) throw new Error('Work recommendation trial is restricted to the existing preview account');
  // Seek on the primary key before joining. The per-asset limit also bounds popular inputs.
  const sources = await db.$queryRaw<Source[]>(Prisma.sql`WITH page AS MATERIALIZED (
    SELECT id, current_version_id, medium, discoverable, completed_at FROM Work
    WHERE id > ${cursor} ORDER BY id LIMIT ${PAGE_SIZE}
  ) SELECT page.id, page.completed_at, version.id AS version, COALESCE((
    SELECT json_group_array(json_object('id', work_id, 'version', media_version_id)) FROM (
      SELECT link.work_id, link.media_version_id FROM WorkSourceLink link
      WHERE link.source_kind = 'asset' AND link.source_id = version.asset_id AND link.relation = 'direct-input'
      ORDER BY link.work_id LIMIT ${EDGE_LIMIT + 1}
    )
  ), '[]') AS links
  FROM page LEFT JOIN WorkMediaVersion version ON version.id = page.current_version_id AND version.work_id = page.id
    AND page.medium = 'image' AND page.discoverable = 1 AND version.content_hash IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM WorkMediaVersion other WHERE other.asset_id = version.asset_id AND other.id <> version.id)
  ORDER BY page.id`);
  const indexed = sources.map(source => ({ source, links: JSON.parse(source.links) as Link[] })).filter(entry => entry.links.length);
  const candidates = indexed.filter(entry => entry.links.length <= EDGE_LIMIT);
  const facts: Array<{ workId: string; mediaVersion: string; evidence: Link; score: number; qualified: boolean }> = [];
  if (candidates.length) {
    const access = await workAccessSql(db, user);
    if (!canUseWorksPreview(access.user)) throw new Error('Work recommendation preview account has changed');
    const ids = Array.from(new Set(candidates.flatMap(({ source, links }) => [source.id, ...links.map(link => link.id)])));
    const visible = await db.$queryRaw<Visible[]>(Prisma.sql`WITH ${access.ctes}
      SELECT w.id, v.id AS version, image_source.created_at AS evidence_at,
        (w.source_kind = 'image_task' AND w.author_id = ${access.user.id} AND context.work_id IS NOT NULL
          AND (w.project_id IS NULL OR ${access.projectView(Prisma.sql`w.project_id`)})) AS own_image
      FROM Work w ${access.joins} LEFT JOIN WorkContext context ON context.work_id = w.id
        AND context.media_version_id = v.id AND context.schema_version = 1
      WHERE w.id IN (${Prisma.join(ids)}) AND w.discoverable = 1 AND (${access.canPreview})
        AND NOT EXISTS (SELECT 1 FROM WorkPersonalState personal
          WHERE personal.work_id = w.id AND personal.owner_id = ${access.user.id} AND personal.hidden = 1)`);
    const byId = new Map(visible.map(row => [row.id, row]));
    for (const { source, links } of candidates) {
      if (!source.version || byId.get(source.id)?.version !== source.version) continue;
      // Only image direct-input links prove frozen primary roles. One evidence is enough
      // for the conservative +8 until independent purposes can be demonstrated.
      const evidence = links.find(link => {
        const target = byId.get(link.id);
        return link.id !== source.id && target?.version === link.version && target.own_image && target.evidence_at &&
          target.evidence_at >= source.completed_at;
      });
      if (!evidence) continue;
      const verdict = replayWorkRecommendation([{
        id: evidence.id, order: 0,
        changes: { primary: { purpose: 'verified-input', chain: 'verified-input', signal: 'input' } },
      }]);
      facts.push({ workId: source.id, mediaVersion: source.version, evidence, score: verdict.score, qualified: verdict.qualified });
    }
  }
  const complete = sources.length < PAGE_SIZE;
  return { ids: sources.map(source => source.id), facts, complete,
    indexedCandidates: indexed.length, truncatedSources: indexed.length - candidates.length,
    next: complete ? null : sources[sources.length - 1].id };
}

/** Bounded snapshot diagnostic. Scores never leave the process. */
export async function trialWorkRecommendation(db: Prisma.TransactionClient, user: SessionUser) {
  const started = performance.now();
  const result = { rule: WORK_RECOMMENDATION_RULE, scanned: 0, indexedCandidates: 0, truncatedSources: 0,
    confirmedInputs: 0, qualified: 0, complete: false, pages: 0, slowestPageMs: 0, elapsedMs: 0 };
  let cursor = '';
  while (result.pages < MAX_PAGES && performance.now() - started < TIME_BUDGET_MS) {
    const batchStarted = performance.now();
    const batch = await readWorkRecommendationBatch(db, user, cursor);
    result.scanned += batch.ids.length;
    result.pages++;
    result.indexedCandidates += batch.indexedCandidates;
    result.truncatedSources += batch.truncatedSources;
    result.confirmedInputs += batch.facts.length;
    result.qualified += batch.facts.filter(fact => fact.qualified).length;
    result.slowestPageMs = Math.max(result.slowestPageMs, Math.round(performance.now() - batchStarted));
    if (batch.next === null) { result.complete = true; break; }
    cursor = batch.next;
  }
  result.elapsedMs = Math.round(performance.now() - started);
  return result;
}
