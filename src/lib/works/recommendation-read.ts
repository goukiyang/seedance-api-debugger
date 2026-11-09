import 'server-only';
import { Prisma } from '@prisma/client';
import { WORK_COMMUNITY_RULE } from './recommendation-score';
import type { workAccessSql } from './access';

/** Each authorization predicate is expanded once, outside nested group queries. */
export function recommendationReadCtes(viewerId: string, access: Awaited<ReturnType<typeof workAccessSql>>, upper: Date, ready = true) {
  return Prisma.sql`recommendation_pool AS MATERIALIZED (
    ${ready ? Prisma.sql`SELECT work_id,media_version_id,work_revision,evidence_json,score FROM WorkRecommendationResult
    WHERE viewer_id=${viewerId} AND qualified=1 AND rule_version=${WORK_COMMUNITY_RULE} AND qualified_at<=${upper}`
    : Prisma.sql`SELECT NULL AS work_id,NULL AS media_version_id,0 AS work_revision,'[]' AS evidence_json,0 AS score WHERE 0=1`}
  ), recommendation_evidence_ids AS MATERIALIZED (
    SELECT DISTINCT json_extract(dependency.value,'$.id') AS id FROM recommendation_pool
    JOIN json_each(recommendation_pool.evidence_json) dependency
  ), recommendation_evidence_access AS MATERIALIZED (
    SELECT w.id,v.id AS version,w.revision FROM recommendation_evidence_ids requested
    CROSS JOIN Work w ON w.id=requested.id ${access.joins}
    WHERE w.discoverable=1 AND (${access.canPreview})
      AND NOT EXISTS (SELECT 1 FROM WorkPersonalState evidence_state
        WHERE evidence_state.work_id=w.id AND evidence_state.owner_id=${viewerId} AND evidence_state.hidden=1)
  )`;
}

/** Only reads a persisted verdict and its authorization proof. Never calculates scores. */
export function recommendationVisibleSql() {
  return Prisma.sql`EXISTS (SELECT 1 FROM recommendation_pool recommendation
    WHERE recommendation.work_id=w.id
      AND recommendation.media_version_id=v.id AND recommendation.work_revision=w.revision
      AND NOT EXISTS (
        SELECT 1 FROM json_each(recommendation.evidence_json) dependency
        LEFT JOIN recommendation_evidence_access available ON available.id=json_extract(dependency.value,'$.id')
          AND available.version=json_extract(dependency.value,'$.version') AND available.revision=json_extract(dependency.value,'$.revision')
        WHERE available.id IS NULL
      )
  )`;
}
