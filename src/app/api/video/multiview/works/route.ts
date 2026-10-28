import { NextRequest } from 'next/server';
import { multiviewWorkRoute } from '@/lib/video/multiview-work-api';
import { listMultiviewWorks, createMultiviewWork } from '@/lib/video/multiview-works';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  return multiviewWorkRoute(request, false, user => {
    const search = request.nextUrl.searchParams;
    return listMultiviewWorks(user, { projectId: search.get('projectId') || undefined, taskId: search.get('taskId') || undefined,
      sourceId: search.get('sourceId') || undefined, q: search.get('q') || undefined, removed: search.get('removed') === '1', cursor: search.get('cursor') || undefined, kind: search.get('kind') === 'reference' ? 'reference' : undefined });
  });
}
export async function POST(request: NextRequest) { return multiviewWorkRoute(request, true, (user, body) => createMultiviewWork(user, body)); }
