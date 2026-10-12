import { NextRequest } from 'next/server';
import { roleReadResponse, roleRoute } from '@/lib/canvas-roles/api';
import { actOnRoleResults, readRoleResults } from '@/lib/canvas-roles/results';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export function GET(request: NextRequest, { params }: { params: { runId: string } }) {
  return roleRoute(request, false, async user => roleReadResponse(request, await readRoleResults(user, params.runId, request.nextUrl.searchParams)));
}
export function POST(request: NextRequest, { params }: { params: { runId: string } }) {
  return roleRoute(request, true, (user, body) => actOnRoleResults(user, params.runId, body));
}
