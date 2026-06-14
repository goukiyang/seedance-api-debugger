import { NextRequest, NextResponse } from 'next/server';
import { getAdminUser, errorJson } from '@/lib/auth/api-helpers';
import { prisma } from '@/lib/prisma';
import { previewProjectMerge } from '@/lib/projects/merge';

export const dynamic = 'force-dynamic';

function normalizeIds(value: unknown) {
  return Array.isArray(value)
    ? Array.from(new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)))
    : [];
}

export async function POST(request: NextRequest) {
  let admin;
  try {
    admin = await getAdminUser(request);
  } catch {
    return errorJson('权限不足', 403);
  }

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return errorJson('请求体格式不正确', 400);

  const sourceProjectIds = normalizeIds(body.source_project_ids);
  const targetProjectId = typeof body.target_project_id === 'string' ? body.target_project_id.trim() : '';
  const preview = await previewProjectMerge({ sourceProjectIds, targetProjectId });

  await prisma.operationLog.create({
    data: {
      operator_id: admin.id,
      action: 'project_merge_preview',
      target_type: 'project',
      target_id: targetProjectId || null,
      detail: JSON.stringify({
        source_project_ids: sourceProjectIds,
        target_project_id: targetProjectId,
        blockers: preview.blockers,
        totals: preview.totals,
      }),
    },
  });

  return NextResponse.json({ preview });
}
