import { prepareWorkMethod } from '@/lib/works/context-method';
import { workApiError, workApiUser, workJson, workJsonBody } from '@/lib/works/operations';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, { params }: { params: { id: string } }) {
  try { const user = await workApiUser(request), body = await workJsonBody(request);
    return workJson({ viewerId: user.id, operation: await prepareWorkMethod(user, params.id, { viewerId: body.viewerId, requestId: body.requestId,
      expectedMediaVersion: body.expectedMediaVersion, expectedTemplateVersion: body.expectedTemplateVersion }) });
  } catch (error) { return workApiError(error); }
}
