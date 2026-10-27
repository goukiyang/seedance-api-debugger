import { NextRequest } from 'next/server';
import { multiviewWorkRoute } from '@/lib/video/multiview-work-api';
import { getMultiviewWork, mutateMultiviewWork } from '@/lib/video/multiview-works';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ workId: string }> };
export async function GET(request: NextRequest, props: Context) {
  const params = await props.params;
  return multiviewWorkRoute(request, false, async user => ({ work: await getMultiviewWork(user, params.workId) }));
}
export async function PATCH(request: NextRequest, props: Context) {
  const params = await props.params;
  return multiviewWorkRoute(request, true, (user, body) => mutateMultiviewWork(user, params.workId, body));
}
