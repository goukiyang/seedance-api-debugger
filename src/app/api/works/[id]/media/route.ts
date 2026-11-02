import { workMediaResponse } from '@/lib/works/media';
import { workApiUser } from '@/lib/works/operations';
import { workRouteError } from '@/lib/works/http';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET(request: Request, { params }: { params: { id: string } }) {
  try { return await workMediaResponse(request, await workApiUser(request), params.id); }
  catch (error) { return workRouteError(error); }
}
export const HEAD = GET;
