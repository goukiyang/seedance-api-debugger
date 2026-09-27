import { NextRequest } from 'next/server';
import { animationJson, withAnimationAuth } from '@/lib/animation/http';
import { getAnimationJobForDocument } from '@/lib/animation/repository';

export const runtime = 'nodejs';

type RouteContext = { params: { id: string; jobId: string } };

export async function GET(request: NextRequest, { params }: RouteContext) {
  return withAnimationAuth(request, false, async (user) => animationJson({
    success: true,
    job: await getAnimationJobForDocument(user, params.id, params.jobId),
  }));
}
