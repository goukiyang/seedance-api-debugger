import { mutateWorkLifecycle } from '@/lib/works/lifecycle';
import type { WorkLifecycleMutation } from '@/lib/works/types';
import { workApiError, workApiUser, workJson, workJsonBody } from '@/lib/works/operations';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, { params }: { params: { id: string } }) {
  try { const user = await workApiUser(request), body = await workJsonBody(request);
    return workJson({ viewerId: user.id, operation: await mutateWorkLifecycle(user, params.id, body as unknown as WorkLifecycleMutation) });
  } catch (error) { return workApiError(error); }
}
