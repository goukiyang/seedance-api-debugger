import { route as declaredRoute } from '@/lib/http/route';
import { NextRequest } from 'next/server';
import { roleRoute } from '@/lib/canvas-roles/api';
import { authorizeRoleSettlement, reconcileAttempt } from '@/lib/canvas-roles/execution';
import { readRoleAttempt } from '@/lib/canvas-roles/work';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const GET = declaredRoute({ access: 'internal', rateLimit: false }, async function GET(request: NextRequest, props: { params: Promise<{ attemptId: string }> }) {
  const params = await props.params;
  return roleRoute(request, false, user => readRoleAttempt(user, params.attemptId));
});
export const POST = declaredRoute({ access: 'internal', rateLimit: false }, async function POST(request: NextRequest, props: { params: Promise<{ attemptId: string }> }) {
  const params = await props.params;
  return roleRoute(request, true, (user, body) => body.action === 'authorize_settlement'
    ? authorizeRoleSettlement(user, params.attemptId, body) : reconcileAttempt(user, params.attemptId));
});
