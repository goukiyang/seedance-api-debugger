import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth/api-helpers';
import { AuthError } from '@/lib/auth/session';
import { CreditRequestError } from '@/lib/credits/request-rules';
import { handleCreditDecision, listCreditRequests, submitCreditRequest } from '@/lib/credits/requests';

function failure(error: unknown) {
  const known = error instanceof CreditRequestError || error instanceof AuthError;
  return NextResponse.json({ error: known ? error.message : '操作未完成，请稍后刷新重试' }, { status: known ? error.status : 503 });
}

export async function GET(request: NextRequest) {
  try {
    const user = await getSessionUser(request);
    const cursor = request.nextUrl.searchParams.get('cursor') || undefined;
    if (cursor && cursor.length > 100) throw new CreditRequestError('分页参数无效');
    return NextResponse.json(await listCreditRequests(user.id, cursor), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return failure(error); }
}

export async function POST(request: NextRequest) {
  try {
    const origin = request.headers.get('origin');
    if (!origin || new URL(origin).host !== (request.headers.get('x-forwarded-host') || request.headers.get('host'))) return NextResponse.json({ error: '请求来源无效' }, { status: 403 });
    if (Number(request.headers.get('content-length') || 0) > 4096) throw new CreditRequestError('请求过大', 413);
    const user = await getSessionUser(request);
    const body = await request.json();
    if (body.action === 'submit') {
      const result = await submitCreditRequest(user.id, body.purpose);
      return NextResponse.json({ id: result.id, status: result.status });
    }
    if (typeof body.requestId !== 'string' || !['prepare', 'confirm', 'reject', 'withdraw'].includes(body.action)) throw new CreditRequestError('操作无效');
    const result = await handleCreditDecision({ requestId: body.requestId, actorId: user.id, action: body.action,
      amount: body.amount, confirmationNonce: body.confirmationNonce, reason: body.reason });
    return NextResponse.json(result);
  } catch (error) { return failure(error); }
}
