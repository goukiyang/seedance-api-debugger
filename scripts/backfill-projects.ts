import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function ensurePersonalProject(userId: string) {
  const existing = await prisma.project.findFirst({
    where: {
      owner_user_id: userId,
      type: 'personal',
      status: { not: 'deleted' },
    },
    orderBy: { created_at: 'asc' },
  });

  if (existing) {
    await prisma.projectMember.upsert({
      where: { project_id_user_id: { project_id: existing.id, user_id: userId } },
      update: { role: 'project_owner', status: 'active' },
      create: {
        project_id: existing.id,
        user_id: userId,
        role: 'project_owner',
        joined_by: userId,
      },
    });
    return existing;
  }

  return prisma.$transaction(async (tx) => {
    const project = await tx.project.create({
      data: {
        name: '我的默认项目',
        description: '系统自动创建的个人默认项目',
        type: 'personal',
        visibility: 'private',
        owner_user_id: userId,
        created_by: userId,
        status: 'active',
      },
    });

    await tx.projectMember.create({
      data: {
        project_id: project.id,
        user_id: userId,
        role: 'project_owner',
        joined_by: userId,
      },
    });

    await tx.operationLog.create({
      data: {
        operator_id: userId,
        action: 'project_create_default',
        target_type: 'project',
        target_id: project.id,
        detail: JSON.stringify({ source: 'backfill' }),
      },
    });

    return project;
  });
}

async function ensureLegacyProject(adminUserId: string) {
  const existing = await prisma.project.findFirst({
    where: {
      owner_user_id: adminUserId,
      type: 'system',
      name: 'Legacy 未归属内容',
      status: { not: 'deleted' },
    },
    orderBy: { created_at: 'asc' },
  });

  if (existing) {
    await prisma.projectMember.upsert({
      where: { project_id_user_id: { project_id: existing.id, user_id: adminUserId } },
      update: { role: 'project_owner', status: 'active' },
      create: {
        project_id: existing.id,
        user_id: adminUserId,
        role: 'project_owner',
        joined_by: adminUserId,
      },
    });
    return existing;
  }

  return prisma.$transaction(async (tx) => {
    const project = await tx.project.create({
      data: {
        name: 'Legacy 未归属内容',
        description: '旧任务中无法识别 owner 的兜底项目，仅管理员维护。',
        type: 'system',
        visibility: 'private',
        owner_user_id: adminUserId,
        created_by: adminUserId,
        status: 'active',
      },
    });

    await tx.projectMember.create({
      data: {
        project_id: project.id,
        user_id: adminUserId,
        role: 'project_owner',
        joined_by: adminUserId,
      },
    });

    await tx.operationLog.create({
      data: {
        operator_id: adminUserId,
        action: 'project_create_legacy',
        target_type: 'project',
        target_id: project.id,
        detail: JSON.stringify({ source: 'backfill' }),
      },
    });

    return project;
  });
}

async function main() {
  const users = await prisma.user.findMany({
    orderBy: { created_at: 'asc' },
    select: { id: true, role: true },
  });

  if (users.length === 0) {
    console.log('No users found; skipped project backfill.');
    return;
  }

  const defaultProjectByUserId = new Map<string, string>();
  for (const user of users) {
    const project = await ensurePersonalProject(user.id);
    defaultProjectByUserId.set(user.id, project.id);
  }

  const admin = users.find((user) => user.role === 'admin') || users[0];
  const legacyProject = await ensureLegacyProject(admin.id);

  const tasks = await prisma.videoTask.findMany({
    select: {
      id: true,
      user_id: true,
      owner_user_id: true,
      project_id: true,
      billing_scope: true,
      billing_account_id: true,
    },
  });

  let migratedTasks = 0;
  for (const task of tasks) {
    if (task.project_id && task.owner_user_id) continue;

    const ownerUserId = task.owner_user_id || task.user_id || admin.id;
    const projectId = task.project_id || defaultProjectByUserId.get(ownerUserId) || legacyProject.id;
    const isLegacyFallback = !task.owner_user_id && !task.user_id;

    await prisma.videoTask.update({
      where: { id: task.id },
      data: {
        owner_user_id: ownerUserId,
        project_id: projectId,
        visibility: isLegacyFallback ? 'project' : 'private',
        billing_scope: task.billing_scope || 'user',
        billing_account_id: task.billing_account_id || ownerUserId,
      },
    });
    migratedTasks++;
  }

  console.log(`Project backfill complete. users=${users.length}, tasks_migrated=${migratedTasks}`);
}

main()
  .catch((error) => {
    console.error('Project backfill failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
