import { NextRequest } from 'next/server';
import { cancelAnimationJob } from '@/lib/animation/repository';
import { animationJson, withAnimationAuth } from '@/lib/animation/http';

export const runtime = 'nodejs';

type RouteContext = { params: { id: string; jobId: string } };

export async function POST(request: NextRequest, { params }: RouteContext) {
  return withAnimationAuth(request, true, async (user) => animationJson(await cancelAnimationJob(user, params.id, params.jobId)));
}
