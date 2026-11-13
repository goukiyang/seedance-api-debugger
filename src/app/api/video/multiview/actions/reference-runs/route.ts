import { NextRequest, NextResponse } from 'next/server';
import { createMultiviewActionRun, withMultiviewActionRoute, readMultiviewActionJson, multiviewActionResponseHeaders as headers } from '@/lib/video/multiview-action.server';

export const dynamic = 'force-dynamic';
export async function POST(request: NextRequest) {
  return withMultiviewActionRoute(request, async user => {
    const result = await createMultiviewActionRun(user, await readMultiviewActionJson(request), true);
    return NextResponse.json({ run: result.run }, { status: result.status, headers });
  });
}
