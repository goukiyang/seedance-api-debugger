import { NextRequest } from 'next/server';
import { roleReadResponse, roleRoute } from '@/lib/canvas-roles/api';
import { createTaskRun, listTaskRuns } from '@/lib/canvas-roles/work';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export function POST(request: NextRequest) { return roleRoute(request, true, createTaskRun); }
export function GET(request: NextRequest) { return roleRoute(request, false, async user => roleReadResponse(request, await listTaskRuns(user, request.nextUrl.searchParams))); }
