import { NextRequest } from 'next/server';
import { roleRoute } from '@/lib/canvas-roles/api';
import { createRoleQuestion } from '@/lib/canvas-roles/questions';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export function POST(request: NextRequest, { params }: { params: { runId: string } }) {
  return roleRoute(request, true, (user, body) => createRoleQuestion(user, params.runId, body));
}
