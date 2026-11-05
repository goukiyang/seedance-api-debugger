import 'server-only';
import { Prisma } from '@prisma/client';

/** Caller supplies only the current page's already-authorized template identities. */
export async function templateUsageCounts(db: Pick<Prisma.TransactionClient, '$queryRaw'>, userId: string, keys: string[]) {
  const ids = (prefix: string) => Array.from(new Set(keys.filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length))));
  const sources = ids('image_template:'), modules = ids('image_module:');
  const studio = ids('video_template:'), drafts = ids('video_draft:'), legacy = ids('legacy_template:');
  const counts = new Map<string, number | null>(keys.map(key => [key, 0]));
  const queries: Prisma.Sql[] = [];
  const frozenVideoTemplates = Prisma.sql`
    SELECT id,
      json_extract(CASE WHEN json_valid(snapshot_json) THEN snapshot_json ELSE '{}' END, '$.templateVersion.templateId') AS template_id,
      json_extract(CASE WHEN json_valid(snapshot_json) THEN snapshot_json ELSE '{}' END, '$.templateVersion.templateSource') AS template_source
    FROM VideoStudioRun WHERE purpose = 'studio' AND source = 'studio'`;
  if (sources.length) queries.push(Prisma.sql`
    SELECT 'image_template:' || source_preset_id AS key, count(*) AS total FROM (
      SELECT source_preset_id, owner_id, batch_id FROM ImageStudioTask
      WHERE source_preset_id IN (${Prisma.join(sources)}) GROUP BY source_preset_id, owner_id, batch_id
    ) GROUP BY source_preset_id`);
  if (modules.length) queries.push(Prisma.sql`
    SELECT 'image_module:' || module_id AS key, count(DISTINCT batch_id) AS total FROM ImageStudioTask
    WHERE owner_id = ${userId} AND module_id IN (${Prisma.join(modules)}) GROUP BY module_id`);
  if (studio.length) queries.push(Prisma.sql`
    SELECT 'video_template:' || frozen.template_id AS key, count(*) AS total FROM (${frozenVideoTemplates}) frozen
    JOIN VideoTask task ON task.template_studio_run_id = frozen.id
    WHERE frozen.template_source = 'studio' AND frozen.template_id IN (${Prisma.join(studio)}) GROUP BY frozen.template_id`);
  if (drafts.length) queries.push(Prisma.sql`
    SELECT 'video_draft:' || run.draft_id AS key, count(*) AS total FROM VideoStudioRun run
    JOIN VideoTask task ON task.template_studio_run_id = run.id
    WHERE run.owner_user_id = ${userId} AND run.purpose = 'studio' AND run.draft_id IN (${Prisma.join(drafts)}) GROUP BY run.draft_id`);
  if (legacy.length) queries.push(Prisma.sql`
    SELECT 'legacy_template:' || template_id AS key, count(*) AS total FROM (
      SELECT id, template_id FROM VideoTask WHERE template_id IN (${Prisma.join(legacy)})
      UNION
      SELECT task.id, frozen.template_id FROM (${frozenVideoTemplates}) frozen
      JOIN VideoTask task ON task.template_studio_run_id = frozen.id
      WHERE frozen.template_source = 'legacy' AND frozen.template_id IN (${Prisma.join(legacy)})
    ) GROUP BY template_id`);
  if (!queries.length) return counts;
  try {
    const rows = await db.$queryRaw<Array<{ key: string; total: bigint }>>(Prisma.join(queries, ' UNION ALL '));
    for (const row of rows) counts.set(row.key, Number(row.total));
  } catch (error) {
    // Optional statistics must not replace usable templates with an error or a false zero.
    console.warn('[template-usage]', error instanceof Error ? error.name : 'read-failed');
    for (const key of Array.from(counts.keys())) counts.set(key, null);
  }
  return counts;
}
