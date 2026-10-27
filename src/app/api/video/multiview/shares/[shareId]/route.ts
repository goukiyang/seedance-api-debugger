import { NextRequest } from 'next/server';
import { multiviewWorkRoute } from '@/lib/video/multiview-work-api';
import { readMultiviewShare } from '@/lib/video/multiview-share.server';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest, props: { params: Promise<{ shareId: string }> }) {
  const params = await props.params;
  return multiviewWorkRoute(request, false, async user => ({ share: await readMultiviewShare(user, params.shareId) }));
}
