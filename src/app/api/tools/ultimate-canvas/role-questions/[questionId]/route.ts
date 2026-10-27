import { route as declaredRoute } from '@/lib/http/route';
import { NextRequest } from 'next/server';
import { roleRoute } from '@/lib/canvas-roles/api';
import { actOnRoleQuestion } from '@/lib/canvas-roles/questions';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const POST = declaredRoute({ access: 'internal', rateLimit: false }, async function POST(request: NextRequest, props: { params: Promise<{ questionId: string }> }) {
  const params = await props.params;
  return roleRoute(request, true, (user, body) => actOnRoleQuestion(user, params.questionId, body));
});
