import { route as apiRoute } from '@/lib/http/route';
import { apiErrorResponse } from '@/lib/http/api-error';
import { getSession } from '@/lib/auth/session';
import { assertMedia } from '@/lib/access/media-policy';
import { prisma } from '@/lib/prisma';
import { ensureTaskThumbnail } from '@/lib/video/thumbnail';
import { redirectMedia } from '@/lib/media/outlet';
import { mediaDenied } from '@/lib/media/signed-media';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
async function mediaContent(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSession(), { id } = await context.params;
    if (!user) return mediaDenied(404);
    await assertMedia(user, { type: 'video-cover', id }, 'view-thumbnail');
    const task = await prisma.videoTask.findUnique({ where: { id } });
    if (!task || !(await ensureTaskThumbnail(task, { allowRemoteFallback: true })).success) return mediaDenied(404);
    return redirectMedia(request, user, { type: 'video-cover', id }, 'thumbnail');
  } catch (error) {
    const status = (error as { status?: number }).status;
    return status === 403 || status === 404 ? mediaDenied(status) : apiErrorResponse(error);
  }
}
export const GET = apiRoute({ access: 'user', rateLimit: false }, mediaContent);
export const HEAD = apiRoute({ access: 'user', rateLimit: false }, mediaContent);
