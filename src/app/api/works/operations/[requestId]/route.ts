import { readWorkOperation, workApiError, workApiUser, workJson } from '@/lib/works/operations';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request, { params }: { params: { requestId: string } }) {
  try {
    const user = await workApiUser(request);
    return workJson({ viewerId: user.id, operation: await readWorkOperation(user, params.requestId) });
  } catch (error) { return workApiError(error, 'read'); }
}
