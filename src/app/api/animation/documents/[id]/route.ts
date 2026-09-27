import { NextRequest } from 'next/server';
import { getAnimationDocumentView, patchAnimationDocument } from '@/lib/animation/repository';
import { animationJson, readJsonBody, withAnimationAuth } from '@/lib/animation/http';

export const runtime = 'nodejs';

type RouteContext = { params: { id: string } };

export async function GET(request: NextRequest, { params }: RouteContext) {
  return withAnimationAuth(request, false, async (user) => animationJson({
    success: true,
    document: await getAnimationDocumentView(user, params.id),
  }));
}

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  return withAnimationAuth(request, true, async (user) => {
    const body = await readJsonBody(request);
    return animationJson(await patchAnimationDocument(user, params.id, body));
  });
}
