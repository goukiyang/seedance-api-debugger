import { route as declaredRoute } from '@/lib/http/route';
import { NextRequest } from 'next/server';
import { roleReadResponse, roleRoute } from '@/lib/canvas-roles/api';
import { createTaskRun, listTaskRuns } from '@/lib/canvas-roles/work';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const POST = declaredRoute({ access: 'internal', rateLimit: false }, function POST(request: NextRequest) { return roleRoute(request, true, createTaskRun); });
export const GET = declaredRoute({ access: 'internal', rateLimit: false }, function GET(request: NextRequest) { return roleRoute(request, false, async user => roleReadResponse(request, await listTaskRuns(user, request.nextUrl.searchParams))); });
