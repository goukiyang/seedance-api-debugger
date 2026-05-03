import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser, errorJson } from '@/lib/auth/api-helpers';
import { getPricingSnapshot } from '@/lib/pricing';
import type { VideoResolution, VideoDuration } from '@/types';

const DEFAULT_MODEL = 'dreamina-seedance-2-0-260128';

export async function GET(request: NextRequest) {
  try {
    await getSessionUser(request);
  } catch {
    return errorJson('未登录', 401);
  }

  const { searchParams } = new URL(request.url);
  const resolution = (searchParams.get('resolution') || '720p') as VideoResolution;
  const duration = parseInt(searchParams.get('duration') || '5', 10) as VideoDuration;

  const pricing = await getPricingSnapshot({ model: DEFAULT_MODEL, resolution, duration, isFast: false });

  return NextResponse.json(pricing);
}
