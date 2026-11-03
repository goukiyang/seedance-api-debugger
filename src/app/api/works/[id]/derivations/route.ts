import { mutateWorkDerivation, readWorkDerivations } from '@/lib/works/learning-derivations';
import { workApiError, workApiUser, workJson, workJsonBody } from '@/lib/works/operations';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    const user = await workApiUser(request);
    return workJson(await readWorkDerivations(user, params.id, new URL(request.url).searchParams));
  } catch (error) { return workApiError(error, 'read'); }
}
async function mutate(request: Request, id: string, remove: boolean) {
  try {
    const user = await workApiUser(request);
    return workJson(await mutateWorkDerivation(user, id, await workJsonBody(request), remove));
  } catch (error) { return workApiError(error); }
}
export async function POST(request: Request, { params }: { params: { id: string } }) { return mutate(request, params.id, false); }
export async function DELETE(request: Request, { params }: { params: { id: string } }) { return mutate(request, params.id, true); }
