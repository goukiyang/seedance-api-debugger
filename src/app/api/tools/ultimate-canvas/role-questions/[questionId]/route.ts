import { NextRequest } from 'next/server';
import { roleRoute } from '@/lib/canvas-roles/api';
import { actOnRoleQuestion } from '@/lib/canvas-roles/questions';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function POST(request: NextRequest, props: { params: Promise<{ questionId: string }> }) {
  const params = await props.params;
  return roleRoute(request, true, (user, body) => actOnRoleQuestion(user, params.questionId, body));
}
