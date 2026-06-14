import { loadEnvConfig } from '@next/env';
import { prisma } from '../src/lib/prisma';
import { mergeProjects, previewProjectMerge } from '../src/lib/projects/merge';

type Args = {
  target: string;
  pattern: string;
  apply: boolean;
  createTarget: boolean;
  reason: string;
};

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const parsed: Args = {
    target: '',
    pattern: 'Smoke Project',
    apply: false,
    createTarget: false,
    reason: '合并历史 smoke 测试项目',
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--apply') {
      parsed.apply = true;
    } else if (arg === '--create-target') {
      parsed.createTarget = true;
    } else if (arg === '--target') {
      parsed.target = args[index + 1] || '';
      index += 1;
    } else if (arg === '--pattern') {
      parsed.pattern = args[index + 1] || parsed.pattern;
      index += 1;
    } else if (arg === '--reason') {
      parsed.reason = args[index + 1] || parsed.reason;
      index += 1;
    }
  }

  return parsed;
}

async function resolveTargetProject(target: string) {
  if (!target.trim()) throw new Error('请通过 --target 指定目标项目 ID 或名称');

  return prisma.project.findFirst({
    where: {
      status: { not: 'deleted' },
      OR: [
        { id: target.trim() },
        { name: target.trim() },
      ],
    },
    select: { id: true, name: true },
  });
}

async function createTargetProject(name: string, reason: string) {
  const admin = await prisma.user.findFirst({
    where: { role: 'admin', status: 'active' },
    orderBy: { created_at: 'asc' },
    select: { id: true },
  });
  if (!admin) throw new Error('未找到 active admin，无法创建目标项目');

  return prisma.$transaction(async (tx) => {
    const project = await tx.project.create({
      data: {
        name,
        description: 'closure smoke reusable project',
        type: 'team',
        visibility: 'private',
        owner_user_id: admin.id,
        created_by: admin.id,
        status: 'active',
      },
      select: { id: true, name: true },
    });
    await tx.projectMember.create({
      data: {
        project_id: project.id,
        user_id: admin.id,
        role: 'project_owner',
        joined_by: admin.id,
      },
    });
    await tx.operationLog.create({
      data: {
        operator_id: admin.id,
        action: 'project_create_smoke_archive',
        target_type: 'project',
        target_id: project.id,
        detail: JSON.stringify({ name, reason }),
      },
    });
    return project;
  });
}

async function main() {
  loadEnvConfig(process.cwd());
  const args = parseArgs();
  let targetProject = await resolveTargetProject(args.target);
  if (!targetProject) {
    if (!args.apply || !args.createTarget) {
      throw new Error(`目标项目不存在：${args.target}`);
    }
    targetProject = await createTargetProject(args.target.trim(), args.reason);
  }

  const sourceProjects = await prisma.project.findMany({
    where: {
      id: { not: targetProject.id },
      status: { not: 'deleted' },
      name: { contains: args.pattern },
    },
    orderBy: { created_at: 'asc' },
    select: { id: true, name: true },
  });

  const preview = await previewProjectMerge({
    sourceProjectIds: sourceProjects.map((project) => project.id),
    targetProjectId: targetProject.id,
  });

  console.log(JSON.stringify({
    mode: args.apply ? 'apply' : 'dry-run',
    target_project: targetProject,
    pattern: args.pattern,
    blockers: preview.blockers,
    totals: preview.totals,
    source_projects: preview.source_projects.map((item) => ({
      id: item.project.id,
      name: item.project.name,
      status: item.project.status,
      counts: item.counts,
      is_empty: item.is_empty,
      can_quick_delete: item.can_quick_delete,
      blockers: item.blockers,
    })),
  }, null, 2));

  if (!args.apply) {
    console.log('Dry-run only. Add --apply after backing up SQLite and setting BACKUP_CONFIRMED=1.');
    return;
  }

  if (process.env.BACKUP_CONFIRMED !== '1') {
    throw new Error('执行合并前请先备份数据库，并设置 BACKUP_CONFIRMED=1');
  }
  if (preview.blockers.length > 0) {
    throw new Error(`存在阻断项，未执行合并：${preview.blockers.join('；')}`);
  }

  const admin = await prisma.user.findFirst({
    where: { role: 'admin', status: 'active' },
    orderBy: { created_at: 'asc' },
    select: { id: true },
  });
  if (!admin) throw new Error('未找到 active admin，无法写入操作日志');

  const result = await mergeProjects({
    sourceProjectIds: sourceProjects.map((project) => project.id),
    targetProjectId: targetProject.id,
    actorUserId: admin.id,
    reason: args.reason,
  });

  console.log(JSON.stringify({
    ok: true,
    target_project: targetProject,
    counts: result.counts,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
