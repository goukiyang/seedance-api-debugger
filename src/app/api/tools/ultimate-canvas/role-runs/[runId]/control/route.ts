import { NextRequest } from 'next/server';
import { roleRoute } from '@/lib/canvas-roles/api';
import { controlRoleRun } from '@/lib/canvas-roles/advancement';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export function POST(request: NextRequest, { params }: { params: { runId: string } }) {
  return roleRoute(request, true, (user, body) => controlRoleRun(user, params.runId, body));
}
