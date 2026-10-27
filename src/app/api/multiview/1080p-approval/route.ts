import { route as apiRoute } from '@/lib/http/route';
import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth/api-helpers';
import { AuthError } from '@/lib/auth/session';
import { CreditRequestError } from '@/lib/credits/request-rules';
import { readMultiview1080pState, submitMultiview1080pRequest } from '@/lib/video/multiview-1080p-approval';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };
function failure(error: unknown) {
  const known = error instanceof CreditRequestError || error instanceof AuthError;
  return NextResponse.json({ error: known ? error.message : '操作未完成，请稍后刷新重试' }, { status: known ? error.status : 503, headers });
}

export const GET = apiRoute({ access: 'user', rateLimit: false }, async function GET(request: NextRequest) {
  try {
    const user = await getSessionUser(request);
    return NextResponse.json(await readMultiview1080pState(user.id), { headers });
  } catch (error) { return failure(error); }
});

export const POST = apiRoute({ access: 'user', rateLimit: false }, async function POST(request: NextRequest) {
  try {
    const origin = request.headers.get('origin');
    if (!origin || new URL(origin).host !== (request.headers.get('x-forwarded-host') || request.headers.get('host'))) return NextResponse.json({ error: '请求来源无效' }, { status: 403, headers });
    if (Number(request.headers.get('content-length') || 0) > 4096) throw new CreditRequestError('请求过大', 413);
    const user = await getSessionUser(request);
    const body = await request.json().catch(() => null);
    if (body?.action !== 'submit') throw new CreditRequestError('操作无效');
    await submitMultiview1080pRequest(user.id, body.purpose);
    return NextResponse.json(await readMultiview1080pState(user.id), { headers });
  } catch (error) { return failure(error); }
});
