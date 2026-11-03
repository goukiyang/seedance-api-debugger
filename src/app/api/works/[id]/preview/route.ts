import { requestWorkPreview } from '@/lib/works/preview-request';
import { workApiError, workApiUser, workJson, workJsonBody } from '@/lib/works/operations';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const user = await workApiUser(request), body = await workJsonBody(request);
    const operation = await requestWorkPreview(user, params.id, { viewerId: body.viewerId, requestId: body.requestId, expectedMediaVersion: body.expectedMediaVersion });
    return workJson({ viewerId: user.id, operation });
  } catch (error) { return workApiError(error); }
}
