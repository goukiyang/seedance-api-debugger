import { NextRequest } from 'next/server';
import { roleRoute } from '@/lib/canvas-roles/api';
import { actOnRoleQuestion } from '@/lib/canvas-roles/questions';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export function POST(request: NextRequest, { params }: { params: { questionId: string } }) {
  return roleRoute(request, true, (user, body) => actOnRoleQuestion(user, params.questionId, body));
}
