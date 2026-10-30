import { NextRequest } from 'next/server';
import { POST as upgradeDraft } from '@/app/api/tasks/[id]/draft-upgrade/route';
import { authenticateCodexVideoApi, CodexApiAuthError, prepareCodexVideoCreation } from '@/lib/integrations/codex';
import { CreationError } from '@/lib/creation/contract';
import { videoPricingError } from '@/lib/pricing/video';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const parsedBody = await request.clone().json().catch(() => ({}));
  let body = parsedBody && typeof parsedBody === 'object' && !Array.isArray(parsedBody)
    ? parsedBody as Record<string, unknown>
    : {};
  const draftTaskId = typeof body.draft_task_id === 'string' ? body.draft_task_id.trim() : '';
  if (!draftTaskId) {
    return Response.json({ error: 'LOCAL_DRAFT_ID_REQUIRED', message: 'draft_task_id 必须是本地 Draft 任务 ID' }, { status: 400 });
  }
  if (body.provider_task_id || body.provider_draft_task_id || body.draft_provider_task_id || body.draft_task_provider_id) {
    return Response.json({ error: 'LOCAL_DRAFT_ID_ONLY', message: 'Codex API 只允许传入本地 Draft 任务 ID' }, { status: 400 });
  }

  if (body.creation_contract_version === 2) {
    try {
      const { user } = await authenticateCodexVideoApi(request);
      body = await prepareCodexVideoCreation(user, body);
    } catch (error) {
      const pricing = videoPricingError(error);
      if (pricing) return Response.json({ error: pricing.code, code: pricing.code, message: pricing.message }, { status: pricing.status, headers: { 'Cache-Control': 'private, no-store' } });
      if (error instanceof CreationError || error instanceof CodexApiAuthError) {
        return Response.json({ error: error.code, code: error.code, message: error.message }, { status: error.status, headers: { 'Cache-Control': 'private, no-store' } });
      }
      throw error;
    }
  }

  const forwarded = new NextRequest(request.url, {
    method: request.method,
    headers: request.headers,
    body: JSON.stringify(body),
  });
  return upgradeDraft(forwarded, { params: { id: draftTaskId } });
}
