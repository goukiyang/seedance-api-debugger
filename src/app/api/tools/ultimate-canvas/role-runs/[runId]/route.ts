import { NextRequest } from 'next/server';
import { roleReadResponse, roleRoute } from '@/lib/canvas-roles/api';
import { readTaskRun, updateTaskRun } from '@/lib/canvas-roles/work';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export function PATCH(request: NextRequest, { params }: { params: { runId: string } }) { return roleRoute(request, true, (user, body) => updateTaskRun(user, params.runId, body)); }
export function GET(request: NextRequest, { params }: { params: { runId: string } }) { return roleRoute(request, false, async user => roleReadResponse(request, await readTaskRun(user, params.runId, request.nextUrl.searchParams))); }
