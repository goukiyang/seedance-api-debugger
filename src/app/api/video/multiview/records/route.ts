import { NextRequest } from 'next/server';
import { multiviewWorkRoute } from '@/lib/video/multiview-work-api';
import { listMultiviewRecords } from '@/lib/video/multiview-records.server';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(request: NextRequest) {
  const search = request.nextUrl.searchParams;
  return multiviewWorkRoute(request, false, user => listMultiviewRecords(user, { q: search.get('q') || '', projectId: search.get('projectId') || '', removed: search.get('removed') === '1', cursor: search.get('cursor') }));
}
