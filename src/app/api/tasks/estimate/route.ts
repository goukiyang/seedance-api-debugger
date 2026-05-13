import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser, errorJson } from '@/lib/auth/api-helpers';
import { calculateEstimatedCost } from '@/lib/pricing';
import type { VideoResolution, VideoDuration } from '@/types';

export async function GET(request: NextRequest) {
  try {
    await getSessionUser(request);
  } catch {
    return errorJson('未登录', 401);
  }

  const { searchParams } = new URL(request.url);
  const resolution = (searchParams.get('resolution') || '720p') as VideoResolution;
  const duration = parseInt(searchParams.get('duration') || '5', 10) as VideoDuration;

  const pricing = calculateEstimatedCost(resolution, duration);
  if (!pricing) {
    return NextResponse.json(
      { error: 'NO_PRICING_RULE', message: '当前参数暂无计费规则' },
      { status: 404 },
    );
  }

  return NextResponse.json(pricing);
}
