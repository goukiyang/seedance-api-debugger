import { route as apiRoute } from '@/lib/http/route';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSessionUser, errorJson } from '@/lib/auth/api-helpers';
import { isPrivateMultiviewTask, privateMultiviewLedgerMetadata } from '@/lib/video/multiview-task-privacy';

export const GET = apiRoute({ access: 'user', rateLimit: false }, async function GET(request: NextRequest) {
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

  const relatedTasks = await prisma.videoTask.findMany({ where: {
    id: { in: records.flatMap(record => record.related_task_id ? [record.related_task_id] : []) },
  }, select: { id: true, source_metadata_json: true } });
  const protectedTaskIds = new Set(relatedTasks.filter(isPrivateMultiviewTask).map(task => task.id));
  return NextResponse.json({ records: records.map(record => ({ ...record,
    metadata_json: privateMultiviewLedgerMetadata(record.metadata_json, Boolean(record.related_task_id && protectedTaskIds.has(record.related_task_id))),
  })), total, page, page_size: pageSize }, { headers: { 'Cache-Control': 'private, no-store' } });
});
