import { NextRequest } from 'next/server';
import { listAnimationProjects } from '@/lib/animation/access';
import { animationJson, withAnimationAuth } from '@/lib/animation/http';
import { ANIMATION_MAX_UPLOAD_BYTES } from '@/lib/animation/storage';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  return withAnimationAuth(request, false, async (user) => animationJson({
    success: true,
    projects: await listAnimationProjects(user),
    limits: { max_upload_bytes: ANIMATION_MAX_UPLOAD_BYTES },
  }));
}
