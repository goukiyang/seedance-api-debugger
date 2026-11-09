import { mutateWorkEditorial } from '@/lib/works/editorial';
import type { WorkEditorialMutation } from '@/lib/works/types';
import { workApiError, workApiUser, workJson, workJsonBody } from '@/lib/works/operations';

export const dynamic = 'force-dynamic';
export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const user = await workApiUser(request), body = await workJsonBody(request);
    return workJson({ viewerId: user.id, operation: await mutateWorkEditorial(user, params.id, body as unknown as WorkEditorialMutation) });
  } catch (error) { return workApiError(error); }
}
