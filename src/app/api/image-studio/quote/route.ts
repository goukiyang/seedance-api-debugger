import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { canAccessImageTemplates, isExternalImageStudioActor } from '@/lib/image-studio/access';
import { externalStudioErrorMessage } from '@/lib/image-studio/external-task-projection';
import { prepareImageBillingQuote, logImagePricingFailure } from '@/lib/image-studio/billing-quote-service';
import { studioBusinessErrorStatus } from '@/lib/image-studio/tasks';
import { ImageGenerationChannelError } from '@/lib/integrations/image-generation';
import { traceHttpRequest, tracePhase } from '@/lib/performance/request-trace';

export const dynamic = 'force-dynamic';
export async function POST(request: NextRequest) {
  return traceHttpRequest('studio.quote', request.headers, () => quote(request));
}
async function quote(request: NextRequest) {
  const startedAt = Date.now();
  const user = await tracePhase('auth', () => getSession());
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  if (user.status !== 'active' || !canAccessImageTemplates(user)) return NextResponse.json({ error: '无图片生成权限' }, { status: 403 });
  try { return NextResponse.json(await prepareImageBillingQuote(user.id, await tracePhase('parse', () => request.json())), { headers: { 'Cache-Control': 'private, no-store' } }); }
  catch (error) {
    logImagePricingFailure('preview', error, startedAt);
    if (error instanceof ImageGenerationChannelError) return NextResponse.json({ error: isExternalImageStudioActor(user) ? externalStudioErrorMessage(error.status) : error.message, code: error.code, submitted: false }, { status: error.status });
    const status = studioBusinessErrorStatus(error);
    return NextResponse.json({ error: isExternalImageStudioActor(user) ? externalStudioErrorMessage(status || 503)
      : status && error instanceof Error ? error.message : '报价未确认，未发起图片生成', submitted: false }, { status: status || 503 });
  }
}
