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

  return NextResponse.json(pricing);
}
