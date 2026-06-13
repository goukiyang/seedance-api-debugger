import { loadEnvConfig } from '@next/env';
import { PrismaClient } from '@prisma/client';

loadEnvConfig(process.cwd());

const prisma = new PrismaClient();
const SAMPLE_LIMIT = 10;

type TaskSample = {
  id: string;
  project_id: string | null;
  video_card_id: string | null;
};

type ProjectCardMismatch = {
  id: string;
  project_id: string;
  video_card_id: string;
  card_project_id: string;
};

type BrokenRolePointer = {
  card_id: string;
  task_id: string;
  task_video_card_id: string | null;
};

type PostSealMutation = {
  log_id: string;
  card_id: string;
  sealed_at: string;
  log_created_at: string;
  detail: string | null;
};

function printSamples(label: string, rows: unknown[]) {
  console.log(`${label}: ${rows.length}`);
  for (const row of rows.slice(0, SAMPLE_LIMIT)) {
    console.log(`  - ${JSON.stringify(row)}`);
  }
}

async function main() {
  const tasksWithoutProject = await prisma.videoTask.findMany({
    where: { project_id: null },
    select: { id: true, project_id: true, video_card_id: true },
    take: SAMPLE_LIMIT,
  });
  const tasksWithoutCard = await prisma.videoTask.findMany({
    where: { video_card_id: null },
    select: { id: true, project_id: true, video_card_id: true },
    take: SAMPLE_LIMIT,
  });
  const projectCardMismatches = await prisma.$queryRaw<ProjectCardMismatch[]>`
    SELECT t.id, t.project_id, t.video_card_id, c.project_id AS card_project_id
    FROM VideoTask t
    JOIN VideoCard c ON t.video_card_id = c.id
    WHERE t.project_id IS NOT NULL
      AND t.video_card_id IS NOT NULL
      AND t.project_id <> c.project_id
    LIMIT ${SAMPLE_LIMIT}
  `;
  const brokenCurrentBest = await prisma.$queryRaw<BrokenRolePointer[]>`
    SELECT c.id AS card_id, c.current_best_task_id AS task_id, t.video_card_id AS task_video_card_id
    FROM VideoCard c
    LEFT JOIN VideoTask t ON c.current_best_task_id = t.id
    WHERE c.current_best_task_id IS NOT NULL
      AND (t.id IS NULL OR t.video_card_id <> c.id)
    LIMIT ${SAMPLE_LIMIT}
  `;
  const brokenFinal = await prisma.$queryRaw<BrokenRolePointer[]>`
    SELECT c.id AS card_id, c.final_task_id AS task_id, t.video_card_id AS task_video_card_id
    FROM VideoCard c
    LEFT JOIN VideoTask t ON c.final_task_id = t.id
    WHERE c.final_task_id IS NOT NULL
      AND (t.id IS NULL OR t.video_card_id <> c.id)
    LIMIT ${SAMPLE_LIMIT}
  `;
  const postSealVersionMutations = await prisma.$queryRaw<PostSealMutation[]>`
    SELECT l.id AS log_id, c.id AS card_id, c.sealed_at, l.created_at AS log_created_at, l.detail
    FROM OperationLog l
    JOIN VideoCard c ON l.target_id = c.id
    WHERE c.sealed_at IS NOT NULL
      AND l.action = 'video_card_update'
      AND l.created_at > c.sealed_at
      AND (
        l.detail LIKE '%candidate_task_id%'
        OR l.detail LIKE '%current_best_task_id%'
        OR l.detail LIKE '%final_task_id%'
      )
    LIMIT ${SAMPLE_LIMIT}
  `;

  const failures: Array<[string, TaskSample[] | ProjectCardMismatch[] | BrokenRolePointer[] | PostSealMutation[]]> = [
    ['tasks_without_project', tasksWithoutProject],
    ['tasks_without_video_card', tasksWithoutCard],
    ['project_card_mismatches', projectCardMismatches],
    ['broken_current_best_pointer', brokenCurrentBest],
    ['broken_final_pointer', brokenFinal],
    ['post_seal_version_mutations', postSealVersionMutations],
  ];

  console.log('[video-card-invariants] read-only audit');
  for (const [label, rows] of failures) printSamples(label, rows);

  const failed = failures.filter(([, rows]) => rows.length > 0);
  if (failed.length > 0) {
    throw new Error(`视频卡归档不变量失败：${failed.map(([label]) => label).join(', ')}`);
  }

  console.log('[video-card-invariants] OK');
}

main()
  .catch((error) => {
    console.error('[video-card-invariants] FAILED', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
