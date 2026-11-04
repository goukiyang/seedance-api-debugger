import { performance } from 'node:perf_hooks';
import { workMediaResponse } from '@/lib/works/media';
import { workApiUser } from '@/lib/works/operations';
import { workRouteError } from '@/lib/works/http';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET(request: Request, { params }: { params: { id: string } }) {
  const started = performance.now();
  try { return await workMediaResponse(request, await workApiUser(request), params.id, started); }
  catch (error) { return workRouteError(error); }
}
export const HEAD = GET;
