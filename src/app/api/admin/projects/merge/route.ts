import { NextRequest, NextResponse } from 'next/server';
import { getAdminUser, errorJson } from '@/lib/auth/api-helpers';
import { mergeProjects } from '@/lib/projects/merge';

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
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  const confirm = body.confirm === true;

  if (!confirm) return errorJson('请确认执行项目合并', 400);
  if (!targetProjectId) return errorJson('请选择目标项目', 400);
  if (sourceProjectIds.length === 0) return errorJson('请选择至少一个源项目', 400);
  if (!reason) return errorJson('合并原因必填', 400);

  try {
    const result = await mergeProjects({
      sourceProjectIds,
      targetProjectId,
      actorUserId: admin.id,
      reason,
    });
    return NextResponse.json({ result });
  } catch (error) {
    return errorJson(error instanceof Error ? error.message : '项目合并失败', 400);
  }
}
