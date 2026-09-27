import { NextRequest } from 'next/server';
import { listAnimationDocuments } from '@/lib/animation/repository';
import { AnimationError, animationJson, withAnimationAuth } from '@/lib/animation/http';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  return withAnimationAuth(request, false, async (user) => {
    const status = request.nextUrl.searchParams.get('status') || 'active';
    if (status !== 'active' && status !== 'archived') throw new AnimationError('列表状态无效', 400, 'INVALID_STATUS');
    const result = await listAnimationDocuments(user, {
      projectId: request.nextUrl.searchParams.get('project_id'),
      status,
      cursor: request.nextUrl.searchParams.get('cursor'),
    });
    return animationJson({ success: true, ...result });
  });
}
