import { route as declaredRoute } from '@/lib/http/route';
import { NextRequest } from 'next/server';
import { multiviewWorkRoute } from '@/lib/video/multiview-work-api';
import { listMultiviewRecords } from '@/lib/video/multiview-records.server';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = declaredRoute({ access: 'user', rateLimit: false }, function GET(request: NextRequest) {
  const search = request.nextUrl.searchParams;
  return multiviewWorkRoute(request, false, user => listMultiviewRecords(user, { q: search.get('q') || '', projectId: search.get('projectId') || '', removed: search.get('removed') === '1', cursor: search.get('cursor') }));
});
