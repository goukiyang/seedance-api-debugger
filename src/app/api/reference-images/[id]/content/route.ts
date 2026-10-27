import { route as apiRoute } from '@/lib/http/route';
import { apiErrorResponse } from '@/lib/http/api-error';
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { redirectMedia } from '@/lib/media/outlet';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
async function mediaContent(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    return await redirectMedia(request, await getSession(), { type: 'reference', id: (await context.params).id }, request.nextUrl.searchParams.get('variant') || 'original');
  } catch (error) { return apiErrorResponse(error); }
}
export const GET = apiRoute({ access: 'user', rateLimit: false }, mediaContent);
export const HEAD = apiRoute({ access: 'user', rateLimit: false }, mediaContent);
