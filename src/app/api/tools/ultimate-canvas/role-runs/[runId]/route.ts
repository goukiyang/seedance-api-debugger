import { route as declaredRoute } from '@/lib/http/route';
import { NextRequest } from 'next/server';
import { roleReadResponse, roleRoute } from '@/lib/canvas-roles/api';
import { readTaskRun, updateTaskRun } from '@/lib/canvas-roles/work';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const PATCH = declaredRoute({ access: 'internal', rateLimit: false }, async function PATCH(request: NextRequest, props: { params: Promise<{ runId: string }> }) {
  const params = await props.params;
  return roleRoute(request, true, (user, body) => updateTaskRun(user, params.runId, body));
});
export const GET = declaredRoute({ access: 'internal', rateLimit: false }, async function GET(request: NextRequest, props: { params: Promise<{ runId: string }> }) {
  const params = await props.params;
  return roleRoute(request, false, async user => roleReadResponse(request, await readTaskRun(user, params.runId, request.nextUrl.searchParams)));
});
