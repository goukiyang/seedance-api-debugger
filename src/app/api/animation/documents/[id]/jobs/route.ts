import { NextRequest } from 'next/server';
import { createAnimationJob } from '@/lib/animation/repository';
import { animationJson, readJsonBody, withAnimationAuth } from '@/lib/animation/http';

export const runtime = 'nodejs';

type RouteContext = { params: { id: string } };

export async function POST(request: NextRequest, { params }: RouteContext) {
  return withAnimationAuth(request, true, async (user) => {
    const body = await readJsonBody(request);
    return animationJson(await createAnimationJob(user, params.id, body));
  });
}
