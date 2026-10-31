import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { canUseCompanyTemplates } from '@/lib/image-studio/access';
import { IMAGE_SUBMIT_RECEIPT_SCHEMA, closeStudioSubmission, readStudioSubmitReceipt, StudioSubmitReceiptError, validStudioSubmitRequestId } from '@/lib/image-studio/submit-receipts.server';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
export async function GET(request: NextRequest) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401, headers });
  if (user.status !== 'active' || !canUseCompanyTemplates(user)) return NextResponse.json({ error: '无权核对图片提交' }, { status: 403, headers });
  const requestId = request.nextUrl.searchParams.get('requestId');
  if (!validStudioSubmitRequestId(requestId)) return NextResponse.json({ error: '原提交编号无效' }, { status: 400, headers });
  try { return NextResponse.json(await readStudioSubmitReceipt(user.id, requestId), { headers }); }
  catch (error) {
    return NextResponse.json({ schema: IMAGE_SUBMIT_RECEIPT_SCHEMA, requestId, state: 'unknown', code: 'IMAGE_SUBMIT_QUERY_UNAVAILABLE', stage: 'original-query',
      message: '原提交暂时无法核对，请保留原编号和输入，不要重复生成。', error: '原提交暂时无法核对' }, { status: error instanceof StudioSubmitReceiptError ? error.status : 503, headers });
  }
}
export async function POST(request: NextRequest) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401, headers });
  if (user.status !== 'active' || !canUseCompanyTemplates(user)) return NextResponse.json({ error: '无权结束图片提交' }, { status: 403, headers });
  let requestId: unknown;
  try {
    const origin = request.headers.get('origin');
    const host = request.headers.get('x-forwarded-host') || request.headers.get('host');
    if (!origin || new URL(origin).host !== host || request.headers.get('sec-fetch-site') === 'cross-site') return NextResponse.json({ error: '请在本站操作' }, { status: 403, headers });
    const body: unknown = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new StudioSubmitReceiptError('IMAGE_SUBMIT_REQUEST_INVALID', '收口请求无效', 400);
    const input = body as Record<string, unknown>; requestId = input.requestId;
    if (input.action !== 'close' || !validStudioSubmitRequestId(requestId)) throw new StudioSubmitReceiptError('IMAGE_SUBMIT_REQUEST_INVALID', '请指定原提交编号及结束操作', 400);
    return NextResponse.json(await closeStudioSubmission(user.id, requestId), { headers });
  } catch (error) {
    const expected = error instanceof StudioSubmitReceiptError;
    return NextResponse.json({ ...(validStudioSubmitRequestId(requestId) ? { schema: IMAGE_SUBMIT_RECEIPT_SCHEMA, requestId, state: 'unknown' } : {}),
      error: expected ? error.message : '本次提交尚未结束，请继续核对原编号；输入仍保留。',
      code: expected ? error.code : 'IMAGE_SUBMIT_CLOSE_UNAVAILABLE', stage: expected ? error.stage : 'explicit-close' },
    { status: expected ? error.status : error instanceof SyntaxError ? 400 : 503, headers });
  }
}
