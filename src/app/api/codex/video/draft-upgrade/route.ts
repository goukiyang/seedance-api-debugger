import { NextRequest } from 'next/server';
import { POST as upgradeDraft } from '@/app/api/tasks/[id]/draft-upgrade/route';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const parsedBody = await request.clone().json().catch(() => ({}));
  const body = parsedBody && typeof parsedBody === 'object' && !Array.isArray(parsedBody)
    ? parsedBody as Record<string, unknown>
    : {};
  const draftTaskId = typeof body.draft_task_id === 'string' ? body.draft_task_id.trim() : '';
  if (!draftTaskId) {
    return Response.json({ error: 'LOCAL_DRAFT_ID_REQUIRED', message: 'draft_task_id 必须是本地 Draft 任务 ID' }, { status: 400 });
  }
  if (body.provider_task_id || body.provider_draft_task_id || body.draft_provider_task_id || body.draft_task_provider_id) {
    return Response.json({ error: 'LOCAL_DRAFT_ID_ONLY', message: 'Codex API 只允许传入本地 Draft 任务 ID' }, { status: 400 });
  }

  const forwarded = new NextRequest(request.url, {
    method: request.method,
    headers: request.headers,
    body: JSON.stringify(body),
  });
  return upgradeDraft(forwarded, { params: { id: draftTaskId } });
}
