import { NextRequest } from 'next/server';
import { multiviewWorkRoute } from '@/lib/video/multiview-work-api';
import { mutateMultiviewShare, multiviewShareManagement } from '@/lib/video/multiview-share.server';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function POST(request: NextRequest) { return multiviewWorkRoute(request, true, mutateMultiviewShare); }
export function GET(request: NextRequest) { return multiviewWorkRoute(request, false, async user => multiviewShareManagement(user, request.nextUrl.searchParams.get('workId') || '', request.nextUrl.searchParams.get('after') || '')); }
