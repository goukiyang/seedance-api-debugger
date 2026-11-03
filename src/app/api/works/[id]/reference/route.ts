import { addWorkReference } from '@/lib/works/lifecycle';
import { workApiError, workApiUser, workJson, workJsonBody } from '@/lib/works/operations';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, { params }: { params: { id: string } }) {
  try { const user = await workApiUser(request), body = await workJsonBody(request);
    return workJson({ viewerId: user.id, operation: await addWorkReference(user, params.id, { viewerId: body.viewerId, requestId: body.requestId, expectedMediaVersion: body.expectedMediaVersion, tabId: body.tabId }) });
  } catch (error) { return workApiError(error); }
}
