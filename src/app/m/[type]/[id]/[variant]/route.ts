import { getSession } from '@/lib/auth/session';
import { route as apiRoute } from '@/lib/http/route';
import { apiErrorResponse } from '@/lib/http/api-error';
import { MEDIA_TYPES, type MediaType } from '@/lib/access/media-policy';
import { redirectMedia } from '@/lib/media/outlet';
import { mediaDenied, signedMediaResponse } from '@/lib/media/signed-media';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function mediaContent(request: Request, context: { params: Promise<{ type: string; id: string; variant: string }> }) {
  const params = await context.params;
  const url = new URL(request.url);
  try {
    // Supplier tickets are the only anonymous local-media capability.
    if (params.type === 'supplier') return signedMediaResponse(request, null);
    const user = await getSession();
    if (!user) return mediaDenied(404);
    if (url.searchParams.size) return signedMediaResponse(request, user.id);
    if (!(MEDIA_TYPES as readonly string[]).includes(params.type)) return mediaDenied(404);
    return redirectMedia(request, user, { type: params.type as MediaType, id: params.id }, params.variant);
  } catch (error) { return apiErrorResponse(error); }
}
// Supplier capability verification and user-bound signature checks are owned by this handler.
export const GET = apiRoute({ access: 'public', rateLimit: false }, mediaContent);
export const HEAD = apiRoute({ access: 'public', rateLimit: false }, mediaContent);
