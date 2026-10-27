import { route as apiRoute } from '@/lib/http/route';
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { canUseCompanyTemplates } from '@/lib/image-studio/access';
import { prepareImageBillingQuote } from '@/lib/image-studio/billing-quote-service';
import { studioBusinessErrorStatus } from '@/lib/image-studio/tasks';
import { ImageGenerationChannelError } from '@/lib/integrations/image-generation';

export const dynamic = 'force-dynamic';
export const POST = apiRoute({ access: 'user', rateLimit: false }, async function POST(request: NextRequest) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  if (user.status !== 'active' || !canUseCompanyTemplates(user)) return NextResponse.json({ error: '无图片生成权限' }, { status: 403 });
  try { return NextResponse.json(await prepareImageBillingQuote(user.id, await request.json()), { headers: { 'Cache-Control': 'private, no-store' } }); }
  catch (error) {
    if (error instanceof ImageGenerationChannelError) return NextResponse.json({ error: error.message, code: error.code, submitted: false }, { status: error.status });
    const status = studioBusinessErrorStatus(error);
    return NextResponse.json({ error: status && error instanceof Error ? error.message : '报价未确认，未发起图片生成', submitted: false }, { status: status || 503 });
  }
});
