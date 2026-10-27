import { getSession } from '@/lib/auth/session';
import { route as apiRoute } from '@/lib/http/route';
import { apiErrorResponse } from '@/lib/http/api-error';
import { legacyMediaResponse } from '@/lib/media/legacy';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
async function legacyContent(request: Request) {
  try { return await legacyMediaResponse(request, await getSession()); }
  catch (error) { return apiErrorResponse(error); }
}
export const GET = apiRoute({ access: 'user', unauthenticatedStatus: 404, rateLimit: false }, legacyContent);
export const HEAD = apiRoute({ access: 'user', unauthenticatedStatus: 404, rateLimit: false }, legacyContent);
