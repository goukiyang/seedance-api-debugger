import { NextRequest, NextResponse } from 'next/server';
import { finalizeMultiviewAction, withMultiviewActionRoute, readMultiviewActionJson, multiviewActionResponseHeaders as headers } from '@/lib/video/multiview-action.server';
export const dynamic = 'force-dynamic';
export async function POST(request: NextRequest) {
  return withMultiviewActionRoute(request, async user => NextResponse.json(await finalizeMultiviewAction(user, await readMultiviewActionJson(request)), { headers }));
}
