import { deleteWorkCollection, renameWorkCollection } from '@/lib/works/collections';
import { workApiError, workApiUser, workJson, workJsonBody } from '@/lib/works/operations';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  try {
    const user = await workApiUser(request);
    return workJson(await renameWorkCollection(user, params.id, await workJsonBody(request)));
  } catch (error) { return workApiError(error); }
}

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  try {
    const user = await workApiUser(request);
    return workJson(await deleteWorkCollection(user, params.id, await workJsonBody(request)));
  } catch (error) { return workApiError(error); }
}
