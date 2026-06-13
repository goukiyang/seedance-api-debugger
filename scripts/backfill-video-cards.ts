import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const APPLY = process.argv.includes('--apply');
const FALLBACK_CARD_TITLE = '历史生成归档';

async function main() {
  const unassignedTasks = await prisma.videoTask.count({
    where: { project_id: null, video_card_id: null },
  });
  if (unassignedTasks > 0) {
    throw new Error(`发现 ${unassignedTasks} 条无 project_id 的历史任务，需先完成项目归属再归档视频卡。`);
  }

  const projectGroups = await prisma.videoTask.groupBy({
    by: ['project_id'],
    where: {
      project_id: { not: null },
      video_card_id: null,
    },
    _count: { _all: true },
    orderBy: { project_id: 'asc' },
  });

  const projectIds = projectGroups
    .map((group) => group.project_id)
    .filter((id): id is string => Boolean(id));

  if (projectIds.length === 0) {
    console.log('Video card backfill: no tasks need migration.');
    return;
  }

  const projects = await prisma.project.findMany({
    where: { id: { in: projectIds } },
    select: { id: true, name: true, owner_user_id: true, created_by: true },
  });
  const projectById = new Map(projects.map((project) => [project.id, project]));

  let createdCards = 0;
  let reusedCards = 0;
  let migratedTasks = 0;

  for (const group of projectGroups) {
    if (!group.project_id) continue;
    const project = projectById.get(group.project_id);
    if (!project) {
      throw new Error(`任务引用的项目不存在：${group.project_id}`);
    }

    const existing = await prisma.videoCard.findFirst({
      where: {
        project_id: project.id,
        is_fallback: true,
      },
      orderBy: { created_at: 'asc' },
    });

    if (!APPLY) {
      console.log([
        '[dry-run]',
        existing ? 'reuse-card' : 'create-card',
        `project=${project.name}(${project.id})`,
        `tasks=${group._count._all}`,
      ].join(' '));
      continue;
    }

    const card = existing || await prisma.videoCard.create({
      data: {
        project_id: project.id,
        title: FALLBACK_CARD_TITLE,
        objective: '系统迁移生成的历史任务兜底视频卡，用于归档上线前已有生成记录。',
        status: 'active',
        owner_user_id: project.owner_user_id,
        is_fallback: true,
        created_by: project.created_by,
      },
    });

    if (existing) reusedCards += 1;
    else createdCards += 1;

    const result = await prisma.videoTask.updateMany({
      where: {
        project_id: project.id,
        video_card_id: null,
      },
      data: { video_card_id: card.id },
    });
    migratedTasks += result.count;

    console.log([
      '[apply]',
      existing ? 'reuse-card' : 'create-card',
      `project=${project.name}(${project.id})`,
      `card=${card.id}`,
      `tasks=${result.count}`,
    ].join(' '));
  }

  console.log(
    `Video card backfill complete. mode=${APPLY ? 'apply' : 'dry-run'} projects=${projectIds.length} created_cards=${createdCards} reused_cards=${reusedCards} tasks_migrated=${migratedTasks}`,
  );
  if (!APPLY) {
    console.log('Run with --apply after backing up SQLite to write these changes.');
  }
}

main()
  .catch((error) => {
    console.error('Video card backfill failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
