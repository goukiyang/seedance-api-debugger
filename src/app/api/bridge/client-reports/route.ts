import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listClientReports, normalizeReport, rateLimited, saveClientReport } from '@/lib/bridge/client-reports';

export const dynamic = 'force-dynamic';

/** 插件出错自动上报：登录用户（会话 cookie）才收；同指纹每天一条；限频 */
export async function POST(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ ok: false, error: '未登录' }, { status: 401 });
    const len = Number(request.headers.get('content-length') || 0);
    if (len > 256 * 1024) return NextResponse.json({ ok: false, error: '上报内容过大' }, { status: 413 });
    if (rateLimited(user.id)) return NextResponse.json({ ok: false, error: '上报过于频繁' }, { status: 429 });
    const report = normalizeReport(await request.json().catch(() => null));
    if (!report) return NextResponse.json({ ok: false, error: '缺少 fingerprint' }, { status: 400 });
    const r = await saveClientReport(user.id, report);
    return NextResponse.json({ ok: true, ...r }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[bridge/client-reports] POST', error);
    return NextResponse.json({ ok: false, error: '保存上报失败' }, { status: 500 });
  }
}

/** 管理员查看最近上报：?since=ISO时间&limit=50&kind=前缀 */
export async function GET(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ ok: false, error: '未登录' }, { status: 401 });
    if (user.role !== 'admin') return NextResponse.json({ ok: false, error: '仅管理员可查看' }, { status: 403 });
    const sp = request.nextUrl.searchParams;
    const sinceRaw = sp.get('since');
    const since = sinceRaw ? new Date(sinceRaw) : new Date(Date.now() - 7 * 86400000);
    const reports = await listClientReports({
      since: Number.isNaN(since.getTime()) ? undefined : since,
      limit: Number(sp.get('limit') || 50),
      kind: sp.get('kind') || undefined,
    });
    return NextResponse.json({ ok: true, reports }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[bridge/client-reports] GET', error);
    return NextResponse.json({ ok: false, error: '读取上报失败' }, { status: 500 });
  }
}
