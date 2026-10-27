import { NextRequest } from 'next/server';
import { roleRoute } from '@/lib/canvas-roles/api';
import { controlRoleRun } from '@/lib/canvas-roles/advancement';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function POST(request: NextRequest, props: { params: Promise<{ runId: string }> }) {
  const params = await props.params;
  return roleRoute(request, true, (user, body) => controlRoleRun(user, params.runId, body));
}
