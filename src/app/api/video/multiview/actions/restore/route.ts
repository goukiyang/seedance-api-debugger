import { NextRequest, NextResponse } from 'next/server';
import { withMultiviewActionRoute, multiviewActionResponseHeaders } from '@/lib/video/multiview-action.server';
import { restoreMultiviewVideoInput } from '@/lib/video/multiview-action-restore.server';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  return withMultiviewActionRoute(request, async user => NextResponse.json(
    await restoreMultiviewVideoInput(user, request.nextUrl.searchParams.get('taskId') || ''),
    { headers: multiviewActionResponseHeaders }));
}
