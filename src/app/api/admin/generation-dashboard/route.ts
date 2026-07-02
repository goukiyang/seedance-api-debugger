import { NextRequest, NextResponse } from 'next/server';
import { AuthError } from '@/lib/auth/session';
import { getAdminUser } from '@/lib/auth/api-helpers';
import {
  getGenerationDashboardData,
  normalizeDashboardResolution,
  type DashboardRangeKey,
} from '@/lib/admin/generation-dashboard';

export const dynamic = 'force-dynamic';

function rangeKey(value: string | null): DashboardRangeKey | undefined {
  if (value === 'all' || value === '7d' || value === '30d' || value === 'month' || value === 'custom') return value;
  return undefined;
}

export async function GET(request: NextRequest) {
  try {
    await getAdminUser(request);

    const searchParams = request.nextUrl.searchParams;
    const resolution = searchParams.get('resolution');
    const dashboard = await getGenerationDashboardData({
      range: rangeKey(searchParams.get('range')),
      dateFrom: searchParams.get('date_from'),
      dateTo: searchParams.get('date_to'),
      projectId: searchParams.get('project_id'),
      ownerUserId: searchParams.get('owner_user_id'),
      resolution: resolution ? normalizeDashboardResolution(resolution) : null,
    });

    return NextResponse.json({
      dashboard,
      generated_at: new Date().toISOString(),
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[AdminGenerationDashboard] Load error:', error);
    return NextResponse.json({ error: '加载驾驶舱失败' }, { status: 500 });
  }
}
