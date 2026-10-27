import { route as apiRoute } from '@/lib/http/route';
import { cookieOrCodexIdentity } from '@/lib/http/route-identities';
import { CreationError } from '@/lib/creation/contract';
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
import { quoteVideoPricing, publicVideoPricing, videoPricingError } from '@/lib/pricing/video';
import { prisma } from '@/lib/prisma';
import { toVideoTaskView } from '@/lib/dto/video-task';
import { assertCanViewTask } from '@/lib/projects/permissions';
import { SEEDANCE_2_5_MODEL_ID } from '@/lib/provider/seedance-models';
import { resolveVideoPricingContext, savedVideoPricingContextInput, issueVideoPricingCredential } from '@/lib/pricing/video-context';

export const dynamic = 'force-dynamic';

export const GET = apiRoute({ access: 'user', identity: cookieOrCodexIdentity, rateLimit: false }, async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const user = hasCodexApiAuthSignal(request) ? (await authenticateCodexVideoApi(request)).user : await getSessionUser(request);
    const draft = await prisma.videoTask.findUnique({ where: { id: params.id } });
    if (!draft || ['admin_hidden', 'user_deleted'].includes(draft.retention_status)) throw new DraftUpgradeError('Draft 任务不存在或不可见', 404, 'DRAFT_NOT_FOUND');
    await assertCanViewTask(user, draft);
    const key = new URL(request.url).searchParams.get('idempotency_key') || `draft-upgrade:${draft.id}`;
    if (!key.trim() || key.length > 200) throw new DraftUpgradeError('原升级请求编号无效');
    const existing = await prisma.videoTask.findFirst({ where: { user_id: user.id, source_draft_task_id: draft.id, idempotency_key: key },
      select: { id: true, source_metadata_json: true, provider_task_id: true, local_status: true } });
    if (existing) return NextResponse.json({ accepted: toVideoTaskView(existing, user) }, { headers: { 'Cache-Control': 'private, no-store' } });
    if (!draft.is_draft || draft.provider !== 'seedance' || draft.model !== SEEDANCE_2_5_MODEL_ID || draft.local_status !== 'succeeded'
      || !draft.provider_draft_task_id) throw new DraftUpgradeError('当前样片还不能升级，请保留原任务', 409, 'DRAFT_NOT_READY');
    const destination = draft.project_id || request.nextUrl.searchParams.get('project_id');
    if (!destination) throw new DraftUpgradeError('请先明确本次结果保存到的项目', 400, 'DRAFT_SCOPE_REQUIRED');
    if (draft.project_id && request.nextUrl.searchParams.get('project_id') && request.nextUrl.searchParams.get('project_id') !== draft.project_id) throw new DraftUpgradeError('升级须保留原项目', 409, 'DRAFT_SCOPE_CHANGED');
    const creationInput = { ...savedVideoPricingContextInput(draft, true), project_id: destination, action: 'draft_upgrade', entry: 'draft_upgrade',
      continuation: { mode: 'continue', parent_task_id: draft.id }, baseline_task_id: draft.id, source_draft_task_id: draft.id };
    const context = await resolveVideoPricingContext(user, creationInput, 'draft_upgrade');
    const quote = await quoteVideoPricing({ provider: 'seedance', model: draft.model, resolution: '1080p', duration: draft.duration ?? 5, context });
    return NextResponse.json({ creation_input: creationInput, ...publicVideoPricing(quote), pricing_quote_token: issueVideoPricingCredential(context, quote.revision, quote.pricing.estimatedCost) }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    const pricingFailure = videoPricingError(error);
    const status = pricingFailure?.status || (error instanceof AuthError || error instanceof DraftUpgradeError || error instanceof CodexApiAuthError ? error.status : 503);
    return NextResponse.json({ error: pricingFailure?.code || 'DRAFT_QUOTE_UNAVAILABLE', message: pricingFailure?.message
      || (error instanceof AuthError || error instanceof DraftUpgradeError || error instanceof CodexApiAuthError ? error.message : '报价暂不可用，原样片保留') },
    { status, headers: { 'Cache-Control': 'private, no-store' } });
  }
});

export const POST = apiRoute({ access: 'user', identity: cookieOrCodexIdentity, rateLimit: false }, async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
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
      creationBody: body,
      draftTaskId: params.id,
      resolutionApprovalConfirmed: body.resolution_approval_confirmed === true || body.resolutionApprovalConfirmed === true,
      resolutionApprovalId: typeof body.resolution_approval_id === 'string'
        ? body.resolution_approval_id
        : typeof body.resolutionApprovalId === 'string' ? body.resolutionApprovalId : null,
      idempotencyKey: typeof body.idempotency_key === 'string' ? body.idempotency_key : null,
      sourceType: source.source_type,
      sourceLabel: source.source_label,
      sourceRequestId: source.source_request_id,
      pricingRevision: typeof body.pricing_revision === 'string' ? body.pricing_revision : null,
      pricingQuoteToken: typeof body.pricing_quote_token === 'string' ? body.pricing_quote_token : null,
      maxEstimatedCost: body.max_estimated_cost,
    });
    return NextResponse.json(result, { status: result.pending_confirmation ? 202 : 200 });
  } catch (error) {
    const pricingFailure = videoPricingError(error);
    if (pricingFailure) return NextResponse.json({ error: pricingFailure.code, code: pricingFailure.code, message: pricingFailure.message }, { status: pricingFailure.status });
    if (error instanceof CreationError) return NextResponse.json({ error: error.code, code: error.code, message: error.message }, { status: error.status });
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
});
