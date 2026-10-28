import { NextRequest, NextResponse } from 'next/server';
import { saveMultiviewActionDraft, withMultiviewActionRoute, readMultiviewActionJson, multiviewActionResponseHeaders as headers } from '@/lib/video/multiview-action.server';
export const dynamic = 'force-dynamic';
export async function POST(request: NextRequest) {
  return withMultiviewActionRoute(request, async user => NextResponse.json({ draft: await saveMultiviewActionDraft(user, await readMultiviewActionJson(request)) }, { headers }));
}
