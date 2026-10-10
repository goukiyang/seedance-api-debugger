import { NextRequest } from 'next/server';
import { roleRoute } from '@/lib/canvas-roles/api';
import { reconcileAttempt } from '@/lib/canvas-roles/execution';
import { readRoleAttempt } from '@/lib/canvas-roles/work';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export function GET(request: NextRequest, { params }: { params: { attemptId: string } }) {
  return roleRoute(request, false, user => readRoleAttempt(user, params.attemptId));
}
export function POST(request: NextRequest, { params }: { params: { attemptId: string } }) {
  return roleRoute(request, true, user => reconcileAttempt(user, params.attemptId));
}
