import { route as declaredRoute } from '@/lib/http/route';
import { NextRequest } from 'next/server';
import { multiviewWorkRoute } from '@/lib/video/multiview-work-api';
import { mutateMultiviewShare, multiviewShareManagement } from '@/lib/video/multiview-share.server';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const POST = declaredRoute({ access: 'user', rateLimit: false }, function POST(request: NextRequest) { return multiviewWorkRoute(request, true, mutateMultiviewShare); });
export const GET = declaredRoute({ access: 'user', rateLimit: false }, function GET(request: NextRequest) { return multiviewWorkRoute(request, false, async user => multiviewShareManagement(user, request.nextUrl.searchParams.get('workId') || '', request.nextUrl.searchParams.get('after') || '')); });
