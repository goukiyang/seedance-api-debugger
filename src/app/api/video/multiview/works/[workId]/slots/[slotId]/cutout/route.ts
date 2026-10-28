import { NextRequest } from 'next/server';
import { multiviewWorkRoute } from '@/lib/video/multiview-work-api';
import { getMultiviewReferenceCutout, mutateMultiviewReferenceCutout } from '@/lib/video/multiview-reference-cutout.server';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: { workId: string; slotId: string } };
export async function GET(request: NextRequest, { params }: Context) {
  return multiviewWorkRoute(request, false, user => getMultiviewReferenceCutout(request, user, params.workId, params.slotId));
}
export async function POST(request: NextRequest, { params }: Context) {
  return multiviewWorkRoute(request, true, (user, body) => mutateMultiviewReferenceCutout(request, user, params.workId, params.slotId, body));
}
