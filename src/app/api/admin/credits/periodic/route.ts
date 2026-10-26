import { NextRequest, NextResponse } from 'next/server';
import { getAdminUser } from '@/lib/auth/api-helpers';
import { changeQuotaRule, quotaAdminView, QuotaError, runQuotaBatch } from '@/lib/credits/periodic';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
function failure(error: unknown) {
  return NextResponse.json({ error: error instanceof QuotaError ? error.message : '额度操作未完成，请重新读取核对后重试' },
    { status: error instanceof QuotaError ? error.status : 503, headers });
}
export async function GET(request: NextRequest) {
  try { await getAdminUser(request); } catch { return NextResponse.json({ error: '仅管理员可查看' }, { status: 403, headers }); }
  try {
    return NextResponse.json(await quotaAdminView(request.nextUrl.searchParams.get('id') || undefined,
      Math.floor(Math.max(1, Math.min(10000, Number(request.nextUrl.searchParams.get('page')) || 1))),
      (request.nextUrl.searchParams.get('q') || '').slice(0, 80)), { headers });
  } catch (error) { return failure(error); }
}
export async function POST(request: NextRequest) {
  let admin;
  try { admin = await getAdminUser(request); } catch { return NextResponse.json({ error: '仅管理员可操作' }, { status: 403, headers }); }
  try {
    const origin = request.headers.get('origin');
    if (!origin || new URL(origin).host !== request.headers.get('host') || !request.headers.get('content-type')?.includes('application/json')) throw new QuotaError('请求来源无效', 403);
    const text = await request.text();
    if (text.length > 150000) throw new QuotaError('设置内容过大', 413);
    const body = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new QuotaError('请求内容无效');
    if (body.action === 'run') {
      if (body.confirm !== true || typeof body.id !== 'string') throw new QuotaError('请确认补齐本期漏发用户');
      if (body.cursor && (typeof body.cursor !== 'string' || body.cursor.length > 100)) throw new QuotaError('继续位置无效');
      return NextResponse.json(await runQuotaBatch(body.id, admin.id, body.cursor), { headers });
    }
    return NextResponse.json(await changeQuotaRule(body, admin.id), { headers });
  } catch (error) { return failure(error); }
}
