import { NextRequest, NextResponse } from 'next/server';
import { getAdminUser } from '@/lib/auth/api-helpers';
import { AuthError } from '@/lib/auth/session';
import { getUsageAnalyticsSnapshot } from '@/lib/admin/usage-analytics';
import { parseUsageQuery, UsageQueryError } from '@/lib/admin/usage-query';
import { streamUsageCsv } from '@/lib/admin/usage-csv';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const privateHeaders = { 'Cache-Control': 'private, no-store, max-age=0', Pragma: 'no-cache', Vary: 'Cookie' };

export async function GET(request: NextRequest) {
  try {
    await getAdminUser(request);
    const query = parseUsageQuery(request.nextUrl.searchParams);
    const type = request.nextUrl.searchParams.get('type') === 'summary' ? 'summary' : 'records';
    const snapshot = await getUsageAnalyticsSnapshot(query);
    const { report } = snapshot;
    return new NextResponse(streamUsageCsv(snapshot, type, request.signal), { headers: {
      ...privateHeaders,
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="usage-${type}-${report.dataAsOf.slice(0, 10)}.csv"`,
      'X-Content-Type-Options': 'nosniff',
      'X-Usage-Data-As-Of': report.dataAsOf,
      'X-Usage-Report-Fingerprint': report.reportFingerprint,
      'X-Usage-Summary': Buffer.from(JSON.stringify(report.summary), 'utf8').toString('base64url'),
      'X-Usage-Summary-Encoding': 'base64url-json',
      'X-Usage-Query': Buffer.from(JSON.stringify(report.query), 'utf8').toString('base64url'),
      'X-Usage-Export-Type': type,
      'X-Usage-Record-Count': String(snapshot.records.length),
    } });
  } catch (error) {
    if (error instanceof AuthError || error instanceof UsageQueryError) return NextResponse.json({ error: error.message }, { status: error.status, headers: privateHeaders });
    return NextResponse.json({ error: '使用分析导出失败，请保留条件重试；未生成不完整导出文件' }, { status: 503, headers: privateHeaders });
  }
}
