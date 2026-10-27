import { route as apiRoute } from '@/lib/http/route';
import { NextRequest, NextResponse } from 'next/server';
import { getAdminUser } from '@/lib/auth/api-helpers';
import { AuthError } from '@/lib/auth/session';
import { getUsageAnalytics } from '@/lib/admin/usage-analytics';
import { parseUsageQuery, UsageQueryError } from '@/lib/admin/usage-query';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'private, no-store, max-age=0', Pragma: 'no-cache', Vary: 'Cookie' };

export const GET = apiRoute({ access: 'admin', rateLimit: false }, async function GET(request: NextRequest) {
  try {
    await getAdminUser(request);
    const query = parseUsageQuery(request.nextUrl.searchParams);
    return NextResponse.json(await getUsageAnalytics(query), { headers });
  } catch (error) {
    if (error instanceof AuthError || error instanceof UsageQueryError) return NextResponse.json({ error: error.message }, { status: error.status, headers });
    return NextResponse.json({ error: '使用分析读取失败，当前条件已保留，请重试原查询' }, { status: 503, headers });
  }
});
