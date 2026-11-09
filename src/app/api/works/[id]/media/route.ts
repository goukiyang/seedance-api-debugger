import { workMediaResponse } from '@/lib/works/media';
import { workApiUser } from '@/lib/works/operations';
import { workRouteError } from '@/lib/works/http';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET(request: Request, { params }: { params: { id: string } }) {
  const started = performance.now();
  try {
    const user = await workApiUser(request);
    const authenticated = performance.now();
    const response = await workMediaResponse(request, user, params.id, started);
    response.headers.append('Server-Timing', `auth;dur=${(authenticated - started).toFixed(1)}`);
    return response;
  }
  catch (error) { return workRouteError(error); }
}
export const HEAD = GET;
