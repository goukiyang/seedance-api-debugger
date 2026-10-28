import { NextRequest, NextResponse } from 'next/server';
import { getMultiviewActionCapabilities, withMultiviewActionRoute, multiviewActionResponseHeaders as headers } from '@/lib/video/multiview-action.server';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  return withMultiviewActionRoute(request, async user => NextResponse.json(await getMultiviewActionCapabilities(user), { headers }));
}
