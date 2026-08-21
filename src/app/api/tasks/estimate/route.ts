import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser, errorJson } from '@/lib/auth/api-helpers';
import { AuthError } from '@/lib/auth/session';
import { assertInternalOnly } from '@/lib/access/feature-guard';
import { calculateEstimatedCost } from '@/lib/pricing';
import { parseSeedanceVideoModel } from '@/lib/provider/seedance-models';
import type { VideoResolution, VideoDuration } from '@/types';

export async function GET(request: NextRequest) {
  let user;
  try {
    user = await getSessionUser(request);
    assertInternalOnly(user, '外部账号无权使用普通生成估价，请使用 IP 生成。');
  } catch (error) {
    if (error instanceof AuthError) return errorJson(error.message, error.status);
    return errorJson('未登录', 401);
  }

  const { searchParams } = new URL(request.url);
  const resolution = (searchParams.get('resolution') || '720p') as VideoResolution;
  const duration = parseInt(searchParams.get('duration') || '5', 10) as VideoDuration;
  const parsedModel = parseSeedanceVideoModel(searchParams.get('model'));
  if (!parsedModel.ok) return errorJson(parsedModel.message, 400);

  const pricing = calculateEstimatedCost(resolution, duration, parsedModel.model);

  return NextResponse.json(pricing);
}
