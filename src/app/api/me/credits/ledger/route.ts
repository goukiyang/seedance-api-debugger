import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSessionUser, errorJson } from '@/lib/auth/api-helpers';

export async function GET(request: NextRequest) {
  let user: { id: string } | null = null;
  try {
    user = await getSessionUser(request);
  } catch {
    return errorJson('未登录', 401);
  }

  const url = new URL(request.url);
  const page = parseInt(url.searchParams.get('page') || '1', 10);
  const pageSize = parseInt(url.searchParams.get('page_size') || '20', 10);
  const skip = (page - 1) * pageSize;

  const [records, total] = await Promise.all([
    prisma.creditLedger.findMany({
      where: { user_id: user.id },
      orderBy: { created_at: 'desc' },
      skip,
      take: pageSize,
    }),
    prisma.creditLedger.count({ where: { user_id: user.id } }),
  ]);

  const relatedTaskIds = Array.from(
    new Set(records.map((record) => record.related_task_id).filter((taskId): taskId is string => Boolean(taskId))),
  );

  const relatedTasks = relatedTaskIds.length > 0
    ? await prisma.videoTask.findMany({
        where: {
          id: { in: relatedTaskIds },
          user_id: user.id,
        },
        select: {
          id: true,
          prompt: true,
          local_status: true,
          model: true,
          created_at: true,
        },
      })
    : [];

  const taskMap = new Map(relatedTasks.map((task) => [task.id, task]));

  return NextResponse.json({
    records: records.map((record) => ({
      ...record,
      related_task: record.related_task_id ? taskMap.get(record.related_task_id) ?? null : null,
    })),
    total,
    page,
    page_size: pageSize,
    total_pages: Math.ceil(total / pageSize),
  });
}
