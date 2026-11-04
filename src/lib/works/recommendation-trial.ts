import 'server-only';
import { Prisma } from '@prisma/client';
import type { SessionUser } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { readWorkRecommendationBatch } from './recommendation-shadow';
import { WORK_RECOMMENDATION_RULE } from './recommendation-score';

export const WORKS_RECOMMENDATION_TRIAL_SETTING = 'works-recommendation-trial:v1';

/** One page per worker tick. This result is internal and cannot grant visibility. */
export async function processWorkRecommendationTrial(shouldStop: () => boolean, db = prisma) {
  const viewerId = process.env.WORKS_PREVIEW_USER_ID?.trim();
  if (!viewerId || shouldStop()) return;
  const control = await db.platformSetting.findUnique({ where: { key: WORKS_RECOMMENDATION_TRIAL_SETTING }, select: { value_json: true } });
  if (control?.value_json !== 'true') return;
  const user = await db.user.findUnique({ where: { id: viewerId }, select: {
    id: true, name: true, username: true, email: true, role: true, account_type: true,
    user_profile: true, feature_profile_id: true, status: true, expires_at: true,
  } });
  if (!user || user.status !== 'active' || user.account_type !== 'internal' ||
    (user.role !== 'admin' && user.role !== 'user') || (user.expires_at && user.expires_at <= new Date())) return;
  const actor: SessionUser = { ...user, status: 'active', account_type: 'internal', role: user.role };
  const checkpointId = `recommendation:${WORK_RECOMMENDATION_RULE}:${viewerId}`;
  const checkpoint = await db.workDiscoveryCheckpoint.findUnique({ where: { source_kind: checkpointId } })
    || await db.workDiscoveryCheckpoint.upsert({ where: { source_kind: checkpointId }, create: { source_kind: checkpointId }, update: {} });
  const batch = await readWorkRecommendationBatch(db, actor, checkpoint.cursor_id || '');
  if (shouldStop() || !batch.ids.length && !checkpoint.cursor_id) return;
  const evaluated = new Set(batch.facts.map(fact => fact.workId));
  const clear = batch.ids.filter(id => !evaluated.has(id));
  await db.$transaction(async tx => {
    const claimed = await tx.workDiscoveryCheckpoint.updateMany({
      where: { source_kind: checkpointId, cursor_id: checkpoint.cursor_id, cycles: checkpoint.cycles },
      data: { cursor_id: batch.next, cycles: { increment: batch.complete ? 1 : 0 } },
    });
    if (!claimed.count) return;
    if (clear.length) await tx.$executeRaw(Prisma.sql`DELETE FROM WorkRecommendationTrial
      WHERE viewer_id = ${viewerId} AND work_id IN (${Prisma.join(clear)})`);
    for (const fact of batch.facts) await tx.$executeRaw(Prisma.sql`
      INSERT INTO WorkRecommendationTrial(viewer_id, work_id, media_version_id, evidence_work_id, evidence_media_version_id, rule_version, score)
      SELECT ${viewerId}, source.id, source.current_version_id, target.id, target.current_version_id, ${WORK_RECOMMENDATION_RULE}, ${fact.score}
      FROM Work source JOIN Work target ON target.id = ${fact.evidence.id}
      WHERE source.id = ${fact.workId} AND source.current_version_id = ${fact.mediaVersion}
        AND target.current_version_id = ${fact.evidence.version}
        AND source.withdrawn_at IS NULL AND target.withdrawn_at IS NULL AND source.discoverable = 1 AND target.discoverable = 1
      ON CONFLICT(viewer_id,work_id) DO UPDATE SET media_version_id=excluded.media_version_id,
        evidence_work_id=excluded.evidence_work_id, evidence_media_version_id=excluded.evidence_media_version_id,
        rule_version=excluded.rule_version, score=excluded.score
      WHERE media_version_id <> excluded.media_version_id OR evidence_work_id <> excluded.evidence_work_id
        OR evidence_media_version_id <> excluded.evidence_media_version_id OR rule_version <> excluded.rule_version
        OR score <> excluded.score`);
  }, { timeout: 3000 });
  return { scanned: batch.ids.length, confirmedInputs: batch.facts.length, complete: batch.complete, truncatedSources: batch.truncatedSources };
}
