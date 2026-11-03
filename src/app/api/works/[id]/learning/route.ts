import { mutateWorkLearning, readWorkLearning } from '@/lib/works/learning';
import { workApiError, workApiUser, workJson, workJsonBody } from '@/lib/works/operations';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    const user = await workApiUser(request);
    return workJson(await readWorkLearning(user, params.id, new URL(request.url).searchParams));
  } catch (error) { return workApiError(error, 'read'); }
}
async function mutate(request: Request, id: string, action: 'create' | 'edit' | 'remove') {
  try {
    const user = await workApiUser(request);
    return workJson(await mutateWorkLearning(user, id, await workJsonBody(request), action));
  } catch (error) { return workApiError(error); }
}
export async function POST(request: Request, { params }: { params: { id: string } }) { return mutate(request, params.id, 'create'); }
export async function PATCH(request: Request, { params }: { params: { id: string } }) { return mutate(request, params.id, 'edit'); }
export async function DELETE(request: Request, { params }: { params: { id: string } }) { return mutate(request, params.id, 'remove'); }
