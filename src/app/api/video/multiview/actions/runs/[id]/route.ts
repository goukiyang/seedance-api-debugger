import { NextRequest, NextResponse } from 'next/server';
import { getMultiviewActionRun, withMultiviewActionRoute, multiviewActionResponseHeaders as headers } from '@/lib/video/multiview-action.server';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  return withMultiviewActionRoute(request, async user => NextResponse.json({ run: await getMultiviewActionRun(user, params.id) }, { headers }));
}
