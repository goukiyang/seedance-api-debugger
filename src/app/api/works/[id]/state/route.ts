import { mutateWorkPersonalState, readWorkPersonalState } from '@/lib/works/interactions';
import { workApiError, workApiUser, workJson, workJsonBody } from '@/lib/works/operations';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    const user = await workApiUser(request);
    return workJson(await readWorkPersonalState(user, params.id));
  } catch (error) { return workApiError(error, 'read'); }
}

export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const user = await workApiUser(request);
    return workJson(await mutateWorkPersonalState(user, params.id, await workJsonBody(request)));
  } catch (error) { return workApiError(error); }
}
