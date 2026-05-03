import { NextRequest, NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getAdminUser, errorJson } from '@/lib/auth/api-helpers';

const LONG_FROZEN_HOURS = 2;

function buildRefundRelevantWhere(): Prisma.VideoTaskWhereInput {
  return {
    OR: [
      { frozen_cost: { gt: 0 }, local_status: { in: ['failed', 'cancelled'] } },
      { frozen_cost: { gt: 0 }, created_at: { lte: new Date(Date.now() - LONG_FROZEN_HOURS * 60 * 60 * 1000) } },
      { actual_cost: { gt: 0 }, refund_amount: null },
    ],
  };
}

export async function GET(request: NextRequest) {
  try {
    await getAdminUser(request);
  } catch {
    return errorJson('权限不足', 403);
  }

  const url = new URL(request.url);
  const userQuery = url.searchParams.get('user')?.trim() || '';
  const userId = url.searchParams.get('user_id')?.trim() || '';
  const status = url.searchParams.get('status')?.trim() || '';
  const model = url.searchParams.get('model')?.trim() || '';
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const frozenOnly = url.searchParams.get('frozen') === '1';
  const attention = url.searchParams.get('attention') || 'exceptions';
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('page_size') || '20', 10)));
  const skip = (page - 1) * pageSize;

  const where: Prisma.VideoTaskWhereInput = {};

  if (userId) {
    where.user_id = userId;
  } else if (userQuery) {
    where.user = {
      OR: [
        { name: { contains: userQuery } },
        { username: { contains: userQuery } },
        { email: { contains: userQuery } },
      ],
    };
  }

  if (status) where.local_status = status;
  if (model) where.model = { contains: model };
  if (frozenOnly) where.frozen_cost = { gt: 0 };

  const createdAt: Prisma.DateTimeFilter = {};
  if (from) {
    const parsed = new Date(from);
    if (!Number.isNaN(parsed.getTime())) createdAt.gte = parsed;
  }
  if (to) {
    const parsed = new Date(to);
    if (!Number.isNaN(parsed.getTime())) createdAt.lte = parsed;
  }
  if (Object.keys(createdAt).length > 0) where.created_at = createdAt;

  const longFrozenCutoff = new Date(Date.now() - LONG_FROZEN_HOURS * 60 * 60 * 1000);
  let attentionTaskIds: string[] | null = null;

  if (attention === 'failed') {
    where.local_status = 'failed';
  } else if (attention === 'frozen') {
    where.frozen_cost = { gt: 0 };
  } else if (attention === 'refund') {
    const existingAnd = Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : [];
    where.AND = [...existingAnd, buildRefundRelevantWhere()];
  } else if (attention === 'abnormal' || attention === 'exceptions') {
    const baseIds = await prisma.videoTask.findMany({
      where,
      select: { id: true },
    });
    const candidateIds = baseIds.map((item) => item.id);

    if (candidateIds.length === 0) {
      return NextResponse.json({
        tasks: [],
        summary: {
          abnormal_count: 0,
          still_frozen_count: 0,
          long_frozen_count: 0,
          failed_count: 0,
          refund_relevant_count: 0,
        },
        pagination: { page, page_size: pageSize, total: 0, total_pages: 0 },
      });
    }

    const abnormalLogs = await prisma.operationLog.findMany({
      where: {
        target_type: 'VideoTask',
        target_id: { in: candidateIds },
        action: { in: ['task_mark_abnormal', 'task_mark_failed'] },
      },
      select: { target_id: true },
    });
    const abnormalIds = Array.from(new Set(abnormalLogs.map((log) => log.target_id).filter(Boolean) as string[]));

    if (attention === 'abnormal') {
      attentionTaskIds = abnormalIds;
    } else {
      const failedIds = await prisma.videoTask.findMany({
        where: {
          ...where,
          OR: [
            { local_status: 'failed' },
            { frozen_cost: { gt: 0 } },
            buildRefundRelevantWhere(),
          ],
        },
        select: { id: true },
      });
      attentionTaskIds = Array.from(new Set([...abnormalIds, ...failedIds.map((item) => item.id)]));
    }

    if (attentionTaskIds.length === 0) {
      return NextResponse.json({
        tasks: [],
        summary: {
          abnormal_count: abnormalIds.length,
          still_frozen_count: await prisma.videoTask.count({ where: { ...where, frozen_cost: { gt: 0 } } }),
          long_frozen_count: await prisma.videoTask.count({ where: { ...where, frozen_cost: { gt: 0 }, created_at: { lte: longFrozenCutoff } } }),
          failed_count: await prisma.videoTask.count({ where: { ...where, local_status: 'failed' } }),
          refund_relevant_count: await prisma.videoTask.count({ where: { ...where, AND: [buildRefundRelevantWhere()] } }),
        },
        pagination: { page, page_size: pageSize, total: 0, total_pages: 0 },
      });
    }

    where.id = { in: attentionTaskIds };
  }

  const [tasks, total, matchingIds, stillFrozenCount, longFrozenCount, failedCount, refundRelevantCount] = await Promise.all([
    prisma.videoTask.findMany({
      where,
      include: {
        user: { select: { id: true, name: true, username: true, email: true } },
      },
      orderBy: [{ frozen_cost: 'desc' }, { created_at: 'desc' }],
      skip,
      take: pageSize,
    }),
    prisma.videoTask.count({ where }),
    prisma.videoTask.findMany({ where, select: { id: true } }),
    prisma.videoTask.count({ where: { ...where, frozen_cost: { gt: 0 } } }),
    prisma.videoTask.count({ where: { ...where, frozen_cost: { gt: 0 }, created_at: { lte: longFrozenCutoff } } }),
    prisma.videoTask.count({ where: { ...where, local_status: 'failed' } }),
    prisma.videoTask.count({ where: { ...where, AND: [buildRefundRelevantWhere()] } }),
  ]);

  const matchedTaskIds = matchingIds.map((item) => item.id);
  const logs = matchedTaskIds.length
    ? await prisma.operationLog.findMany({
      where: {
        target_type: 'VideoTask',
        target_id: { in: matchedTaskIds },
        action: { in: ['task_mark_abnormal', 'task_mark_failed', 'task_note', 'task_manual_refund'] },
      },
      orderBy: { created_at: 'desc' },
      include: {
        operator: { select: { id: true, name: true, username: true } },
      },
    })
    : [];

  const logMap = new Map<string, typeof logs>();
  for (const log of logs) {
    const list = logMap.get(log.target_id || '') || [];
    list.push(log);
    logMap.set(log.target_id || '', list);
  }

  const abnormalIds = new Set(
    logs
      .filter((log) => log.action === 'task_mark_abnormal' || log.action === 'task_mark_failed')
      .map((log) => log.target_id)
      .filter(Boolean) as string[],
  );

  return NextResponse.json({
    tasks: tasks.map((task) => ({
      ...task,
      attention_flags: {
        abnormal: abnormalIds.has(task.id),
        still_frozen: (task.frozen_cost ?? 0) > 0,
        long_frozen: (task.frozen_cost ?? 0) > 0 && new Date(task.created_at) <= longFrozenCutoff,
        refund_relevant:
          ((task.frozen_cost ?? 0) > 0 && ['failed', 'cancelled'].includes(task.local_status)) ||
          ((task.frozen_cost ?? 0) > 0 && new Date(task.created_at) <= longFrozenCutoff) ||
          ((task.actual_cost ?? 0) > 0 && (task.refund_amount ?? 0) === 0),
      },
      latest_operation: (logMap.get(task.id) || [])[0] || null,
    })),
    summary: {
      abnormal_count: abnormalIds.size,
      still_frozen_count: stillFrozenCount,
      long_frozen_count: longFrozenCount,
      failed_count: failedCount,
      refund_relevant_count: refundRelevantCount,
    },
    pagination: {
      page,
      page_size: pageSize,
      total,
      total_pages: Math.ceil(total / pageSize),
    },
  });
}
