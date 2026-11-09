import 'server-only';
import { Prisma } from '@prisma/client';
import type { SessionUser } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { workAccessSql } from './access';
import { canUseWorksPreview } from './rollout.server';
import { recommendationSchemaReady, bindPendingRecommendationTakes } from './recommendation-events';
import { collectRecommendationSourcePass } from './recommendation-sources';
import { replayCommunityRecommendation, WORK_COMMUNITY_RULE as WORK_RECOMMENDATION_RULE, type RecommendationStep } from './recommendation-score';

type Visible = { id: string; version: string; revision: number; project: string | null };
type Evidence = Pick<Visible, 'id' | 'version' | 'revision'>;
const signals = new Set(['revisit', 'take', 'input', 'retained', 'method']);

async function viewers(db: typeof prisma, after: string) {
  const allowedTenant = process.env.FEISHU_ALLOWED_TENANT_KEY?.trim();
  const users = await db.user.findMany({ where: { id: { gt: after }, status: 'active', account_type: 'internal', role: { in: ['user', 'admin'] },
    OR: [{ expires_at: null }, { expires_at: { gt: new Date() } }],
    AND: [{ OR: [{ id: process.env.WORKS_PREVIEW_USER_ID?.trim() || '' }, {
      feishu_tenant_key: allowedTenant || { not: null }, AND: [
        { feishu_tenant_key: { not: '' } }, { OR: [
          { feishu_user_id: { not: null }, NOT: { feishu_user_id: '' } },
          { feishu_open_id: { not: null }, NOT: { feishu_open_id: '' } },
          { feishu_union_id: { not: null }, NOT: { feishu_union_id: '' } },
        ] },
      ],
    }] }],
  }, take: 33, orderBy: { id: 'asc' }, select: {
    id: true, name: true, username: true, email: true, role: true, account_type: true,
    user_profile: true, feature_profile_id: true, status: true, expires_at: true,
    feishu_user_id: true, feishu_open_id: true, feishu_union_id: true, feishu_tenant_key: true,
  } });
  return users.map(user => ({ ...user, role: user.role as SessionUser['role'], account_type: 'internal' as const,
    status: 'active' as const, feishu: { user_id: user.feishu_user_id, open_id: user.feishu_open_id,
      union_id: user.feishu_union_id, tenant_key: user.feishu_tenant_key, employee_no: null, department_ids: [], last_sync_at: null } } as SessionUser)).filter(canUseWorksPreview);
}

/** Background only: replay exact evidence under this viewer's current authorization. */
async function prepare(db: typeof prisma, workId: string) {
  const source = await db.work.findUnique({ where: { id: workId } });
  if (!source?.current_version_id) return null;
  const own = await db.workRecommendationEvent.findMany({ where: { work_id: workId, media_version_id: source.current_version_id },
    orderBy: [{ occurred_at: 'asc' }, { id: 'asc' }] });
  const slotKeys = Array.from(new Map(own.filter(event => event.slot_key).map(event => [
    `${event.actor_id}:${event.purpose_key}:${event.slot_key}`, { actor_id: event.actor_id, purpose_key: event.purpose_key, slot_key: event.slot_key },
  ])).values());
  const related = slotKeys.length ? await db.workRecommendationEvent.findMany({ where: { OR: slotKeys, signal: { in: ['input', 'retained'] } } }) : [];
  // Explicit video lineage is the only non-slot version-family signal.
  const video = source.source_kind === 'video_task' ? await db.videoTask.findUnique({ where: { id: source.source_id }, select: { lineage_root_task_id: true } }) : null;
  const root = video?.lineage_root_task_id || source.source_id;
  const family = video ? await db.work.findMany({ where: { source_kind: 'video_task',
    source_id: { in: (await db.videoTask.findMany({ where: { OR: [{ id: root }, { lineage_root_task_id: root }] }, select: { id: true } })).map(task => task.id) },
  }, select: { id: true } }) : [];
  const familyEvents = family.length ? await db.workRecommendationEvent.findMany({ where: {
    work_id: { in: family.map(work => work.id) }, signal: { in: ['input', 'retained'] },
    OR: own.filter(event => event.signal === 'input' || event.signal === 'retained').map(event => ({ actor_id: event.actor_id, purpose_key: event.purpose_key })),
  } }) : [];
  const all = Array.from(new Map([...own, ...related, ...familyEvents].map(event => [event.id, event])).values())
    .sort((a, b) => a.occurred_at.getTime() - b.occurred_at.getTime() || a.id - b.id);
  const ids = Array.from(new Set([workId, ...all.flatMap(event => [event.work_id, ...(event.evidence_work_id ? [event.evidence_work_id] : [])])]));
  return { source, own, slotKeys, family, all, ids };
}

async function evaluate(db: typeof prisma, user: SessionUser, input: NonNullable<Awaited<ReturnType<typeof prepare>>>) {
  const { source, own, slotKeys, family, all, ids } = input;
  const workId = source.id;
  const access = await workAccessSql(db, user);
  const visible = new Map<string, Visible>();
  for (let index = 0; index < ids.length; index += 100) {
    const rows = await db.$queryRaw<Visible[]>(Prisma.sql`WITH ${access.ctes}
      SELECT w.id,v.id AS version,w.revision,w.project_id AS project FROM Work w ${access.joins}
      WHERE w.id IN (${Prisma.join(ids.slice(index, index + 100))}) AND w.discoverable=1 AND (${access.canPreview})
        AND NOT EXISTS (SELECT 1 FROM WorkPersonalState personal WHERE personal.work_id=w.id AND personal.owner_id=${user.id} AND personal.hidden=1)`);
    for (const row of rows) visible.set(row.id, { ...row, revision: Number(row.revision) });
  }
  const previous = await db.workRecommendationResult.findUnique({ where: { viewer_id_work_id: { viewer_id: user.id, work_id: workId } },
    select: { rule_version: true, media_version_id: true, history_from: true } });
  const historyFrom = previous?.rule_version === WORK_RECOMMENDATION_RULE && previous.media_version_id === source.current_version_id ? previous.history_from : null;
  if (!visible.has(workId)) return historyFrom ? { source, score: 0, qualified: false, evidence: [] as Evidence[], historyFrom } : null;
  const valid = all.filter(event => signals.has(event.signal || '') && visible.get(event.work_id)?.version === event.media_version_id
    && (!event.evidence_work_id || visible.get(event.evidence_work_id)?.version === event.evidence_media_version_id));
  const usingActors = new Set(valid.filter(event => event.work_id === workId && (event.signal === 'input' || event.signal === 'retained')).map(event => event.actor_id));
  const ownIds = new Set(own.map(event => event.id)), familyIds = new Set(family.map(work => work.id));
  const steps: RecommendationStep[] = [];
  const dependencies = new Map<string, Evidence>();
  const coUsed = new Map<string, Set<string>>();
  for (const event of valid) if (event.evidence_work_id && (event.signal === 'input' || event.signal === 'retained')) {
    const key = JSON.stringify([event.actor_id, event.purpose_key, event.evidence_work_id]);
    const members = coUsed.get(key) || new Set<string>(); members.add(event.work_id); coUsed.set(key, members);
  }
  for (const [order, event] of Array.from(valid.entries())) {
    const changes: RecommendationStep['changes'] = {};
    const attribution = { actor: event.actor_id, ambiguous: event.purpose_key === `actor:${event.actor_id}` || event.purpose_key.startsWith('project:'),
      family: event.evidence_work_id ? visible.get(event.evidence_work_id)?.project || undefined : undefined };
    const use = event.signal === 'input' || event.signal === 'retained';
    if (ownIds.has(event.id) && !(event.signal === 'take' && usingActors.has(event.actor_id))) changes[event.fact_key] = {
      purpose: event.purpose_key, chain: event.chain_key,
      signal: event.signal === 'method' ? 'retained' : event.signal as 'input' | 'retained' | 'take' | 'revisit', ...attribution,
    };
    if (use && event.slot_key && slotKeys.some(slot => slot.actor_id === event.actor_id && slot.purpose_key === event.purpose_key && slot.slot_key === event.slot_key)) {
      changes[`replacement:${event.actor_id}:${event.purpose_key}:${event.slot_key}`] = event.work_id === workId
        || coUsed.get(JSON.stringify([event.actor_id, event.purpose_key, event.evidence_work_id]))?.has(workId) ? null
        : { purpose: event.purpose_key, chain: event.chain_key, signal: 'replaced', ...attribution };
    }
    if (use && familyIds.has(event.work_id) && own.some(row => row.actor_id === event.actor_id && row.purpose_key === event.purpose_key && (row.signal === 'input' || row.signal === 'retained'))) {
      changes[`version:${event.actor_id}:${event.purpose_key}`] = event.work_id === workId
        || coUsed.get(JSON.stringify([event.actor_id, event.purpose_key, event.evidence_work_id]))?.has(workId) ? null
        : { purpose: event.purpose_key, chain: event.chain_key, signal: 'superseded', ...attribution };
    }
    if (!Object.keys(changes).length) continue;
    steps.push({ id: String(event.id), order, at: event.occurred_at.getTime(), changes });
    for (const id of [event.work_id, event.evidence_work_id]) if (id && id !== workId && visible.has(id)) {
      const { version, revision } = visible.get(id)!; dependencies.set(id, { id, version, revision });
    }
  }
  const verdict = replayCommunityRecommendation(steps, source.author_id);
  return { source, score: verdict.score, qualified: verdict.qualified, evidence: Array.from(dependencies.values()),
    lastUsedAt: verdict.lastUsedAt, historyFrom: historyFrom || (verdict.qualified ? new Date() : null) };
}

/** A slow seek repair covers permission changes and newly eligible colleagues without a page-open job. */
async function repair(db: typeof prisma) {
  const key = 'recommendation-repair:v1';
  const checkpoint = await db.workDiscoveryCheckpoint.findUnique({ where: { source_kind: key } });
  if (checkpoint && Date.now() - checkpoint.updated_at.getTime() < 60_000) return;
  const rows = await db.$queryRaw<Array<{ work_id: string }>>(Prisma.sql`SELECT DISTINCT event.work_id FROM WorkRecommendationEvent event
    JOIN Work work ON work.id=event.work_id WHERE event.work_id>${checkpoint?.cursor_id || ''} ORDER BY event.work_id LIMIT 12`);
  await db.$transaction(async tx => {
    for (const row of rows) await tx.$executeRaw(Prisma.sql`INSERT OR IGNORE INTO WorkRecommendationJob(work_id,revision,viewer_cursor,updated_at)
      VALUES(${row.work_id},1,'',${new Date()})`);
    await tx.workDiscoveryCheckpoint.upsert({ where: { source_kind: key }, create: { source_kind: key, cursor_id: rows.length === 12 ? rows[11].work_id : null },
      update: { cursor_id: rows.length === 12 ? rows[11].work_id : null, cycles: { increment: rows.length < 12 ? 1 : 0 } } });
  }, { timeout: 1500 });
}

/** One consumer inside the existing Works tick. Generation and reads never invoke this. */
export async function processWorkRecommendations(shouldStop: () => boolean, db = prisma) {
  if (shouldStop() || !await recommendationSchemaReady(db)) return;
  const control = await db.platformSetting.findUnique({ where: { key: 'works-recommendation:v1' }, select: { value_json: true } });
  if (control?.value_json === 'false') return;
  const started = performance.now();
  const stop = () => shouldStop() || performance.now() - started > 1200;
  await bindPendingRecommendationTakes(db);
  await collectRecommendationSourcePass(() => shouldStop() || performance.now() - started > 500, db);
  if (stop()) return;
  await repair(db);
  let evaluated = 0;
  while (!stop()) {
    const job = await db.workRecommendationJob.findFirst({ orderBy: [{ updated_at: 'asc' }, { work_id: 'asc' }] });
    if (!job || stop()) break;
    const input = await prepare(db, job.work_id);
    const audience = await viewers(db, job.viewer_cursor);
    const computed: Array<{ viewer: SessionUser; result: Awaited<ReturnType<typeof evaluate>> | null }> = [];
    for (const viewer of audience.slice(0, 32)) {
      if (stop()) break;
      computed.push({ viewer, result: input ? await evaluate(db, viewer, input) : null });
    }
    if (shouldStop() || audience.length && !computed.length) return;
    await db.$transaction(async tx => {
      const claimed = await tx.workRecommendationJob.updateMany({ where: { work_id: job.work_id, revision: job.revision, viewer_cursor: job.viewer_cursor },
        data: { viewer_cursor: computed.at(-1)?.viewer.id || job.viewer_cursor } });
      if (!claimed.count) return;
      for (const { viewer, result } of computed) {
        if (!result) { await tx.workRecommendationResult.deleteMany({ where: { viewer_id: viewer.id, work_id: job.work_id } }); continue; }
        await tx.$executeRaw(Prisma.sql`INSERT INTO WorkRecommendationResult
        (viewer_id,work_id,media_version_id,work_revision,rule_version,score,qualified,qualified_at,history_from,evidence_json,evaluated_at)
        SELECT ${viewer.id},id,current_version_id,revision,${WORK_RECOMMENDATION_RULE},${result.score},${result.qualified},${result.qualified ? new Date() : null},${result.historyFrom},${JSON.stringify(result.evidence)},${new Date()}
          FROM Work WHERE id=${job.work_id} AND current_version_id=${result.source.current_version_id} AND revision=${result.source.revision}
          ON CONFLICT(viewer_id,work_id) DO UPDATE SET media_version_id=excluded.media_version_id,work_revision=excluded.work_revision,
          rule_version=excluded.rule_version,score=excluded.score,qualified=excluded.qualified,history_from=excluded.history_from,
            qualified_at=CASE WHEN WorkRecommendationResult.qualified=1 AND excluded.qualified=1
              AND WorkRecommendationResult.media_version_id=excluded.media_version_id AND WorkRecommendationResult.rule_version=excluded.rule_version
              THEN WorkRecommendationResult.qualified_at ELSE excluded.qualified_at END,
            evidence_json=excluded.evidence_json,evaluated_at=excluded.evaluated_at
          WHERE media_version_id<>excluded.media_version_id OR work_revision<>excluded.work_revision OR rule_version<>excluded.rule_version
          OR score<>excluded.score OR qualified<>excluded.qualified OR history_from IS NOT excluded.history_from OR evidence_json<>excluded.evidence_json`);
      }
      if (computed.length === audience.length) await tx.workRecommendationJob.deleteMany({ where: { work_id: job.work_id, revision: job.revision } });
    }, { timeout: 1500 });
    evaluated += computed.length;
  }
  return { evaluated, elapsedMs: Math.round(performance.now() - started) };
}
