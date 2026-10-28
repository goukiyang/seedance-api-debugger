import { NextRequest, NextResponse } from 'next/server';
import { getMultiviewActionState, getMultiviewActionCapabilities, withMultiviewActionRoute, multiviewActionResponseHeaders as headers } from '@/lib/video/multiview-action.server';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  return withMultiviewActionRoute(request, async user => {
    const query = request.nextUrl.searchParams, workId = query.get('workId');
    return NextResponse.json(workId ? await getMultiviewActionState(user, workId, query.get('cursor') || undefined) : { capabilities: await getMultiviewActionCapabilities(user) }, { headers });
  });
}
