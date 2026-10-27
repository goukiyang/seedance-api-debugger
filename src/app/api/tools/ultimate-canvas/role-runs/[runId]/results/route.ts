import { NextRequest } from 'next/server';
import { roleReadResponse, roleRoute } from '@/lib/canvas-roles/api';
import { actOnRoleResults, readRoleResults } from '@/lib/canvas-roles/results';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET(request: NextRequest, props: { params: Promise<{ runId: string }> }) {
  const params = await props.params;
  return roleRoute(request, false, async user => roleReadResponse(request, await readRoleResults(user, params.runId, request.nextUrl.searchParams)));
}
export async function POST(request: NextRequest, props: { params: Promise<{ runId: string }> }) {
  const params = await props.params;
  return roleRoute(request, true, (user, body) => actOnRoleResults(user, params.runId, body));
}
