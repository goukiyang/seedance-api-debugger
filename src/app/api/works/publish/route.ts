import { publishUploadedWork } from '@/lib/works/lifecycle';
import { workApiError, workApiUser, workJson, workJsonBody } from '@/lib/works/operations';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  try { const user = await workApiUser(request), body = await workJsonBody(request);
    return workJson({ viewerId: user.id, operation: await publishUploadedWork(user, { viewerId: body.viewerId, requestId: body.requestId, assetId: body.assetId, title: body.title }) });
  } catch (error) { return workApiError(error); }
}
