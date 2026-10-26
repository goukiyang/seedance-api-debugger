import { NextRequest, NextResponse } from 'next/server';
import { getAdminUser } from '@/lib/auth/api-helpers';
import { AuthError } from '@/lib/auth/session';
import { getUsageAnalytics } from '@/lib/admin/usage-analytics';
import { parseUsageQuery, UsageQueryError } from '@/lib/admin/usage-query';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'private, no-store, max-age=0', Pragma: 'no-cache', Vary: 'Cookie' };

export async function GET(request: NextRequest) {
  try {
    await getAdminUser(request);
    const report = await getUsageAnalytics(parseUsageQuery(request.nextUrl.searchParams));
    return NextResponse.json({ records: report.records, query: report.query, dataAsOf: report.dataAsOf, reportFingerprint: report.reportFingerprint }, { headers });
  } catch (error) {
    if (error instanceof AuthError || error instanceof UsageQueryError) return NextResponse.json({ error: error.message }, { status: error.status, headers });
    return NextResponse.json({ error: '使用明细读取失败，请保留条件重试原查询' }, { status: 503, headers });
  }
}
