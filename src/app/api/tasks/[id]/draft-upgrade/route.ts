import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth/api-helpers';
import { AuthError } from '@/lib/auth/session';
import {
  authenticateCodexVideoApi,
  CodexApiAuthError,
  hasCodexApiAuthSignal,
  type GenerationRequestSource,
  webRequestSource,
} from '@/lib/integrations/codex';
import { createSeedanceDraftUpgrade, DraftUpgradeError } from '@/lib/tasks/seedance-draft-upgrade';

export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    let user;
    let source: GenerationRequestSource = webRequestSource(request);
    if (hasCodexApiAuthSignal(request)) {
      const context = await authenticateCodexVideoApi(request);
      user = context.user;
      source = context.source;
    } else {
      user = await getSessionUser(request);
    }

    const parsedBody = await request.json().catch(() => ({}));
    const body = parsedBody && typeof parsedBody === 'object' && !Array.isArray(parsedBody)
      ? parsedBody as Record<string, unknown>
      : {};
    if (
      body.provider_task_id
      || body.provider_draft_task_id
      || body.draft_provider_task_id
      || body.draft_task_provider_id
    ) {
      return NextResponse.json({ error: 'LOCAL_DRAFT_ID_ONLY', message: '只允许传入本地 Draft 任务 ID' }, { status: 400 });
    }
    const result = await createSeedanceDraftUpgrade({
      user,
      draftTaskId: params.id,
      resolutionApprovalConfirmed: body.resolution_approval_confirmed === true || body.resolutionApprovalConfirmed === true,
      resolutionApprovalId: typeof body.resolution_approval_id === 'string'
        ? body.resolution_approval_id
        : typeof body.resolutionApprovalId === 'string' ? body.resolutionApprovalId : null,
      idempotencyKey: typeof body.idempotency_key === 'string' ? body.idempotency_key : null,
      sourceType: source.source_type,
      sourceLabel: source.source_label,
      sourceRequestId: source.source_request_id,
    });
    return NextResponse.json(result, { status: result.pending_confirmation ? 202 : 200 });
  } catch (error) {
    if (error instanceof DraftUpgradeError) {
      return NextResponse.json({ error: error.code, message: error.message }, { status: error.status });
    }
    if (error instanceof CodexApiAuthError) {
      return NextResponse.json({ error: error.code, message: error.message }, { status: error.status });
    }
    if (error instanceof AuthError) {
      return NextResponse.json({ error: 'AUTH_REQUIRED', message: error.message }, { status: error.status });
    }
    console.error('[SeedanceDraftUpgrade] Failed:', error);
    return NextResponse.json({ error: 'DRAFT_UPGRADE_FAILED', message: 'Draft 升级失败，请稍后重试' }, { status: 500 });
  }
}
