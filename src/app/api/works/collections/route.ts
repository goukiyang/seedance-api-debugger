import { createWorkCollection, listWorkCollections } from '@/lib/works/collections';
import { workApiError, workApiUser, workJson, workJsonBody } from '@/lib/works/operations';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const user = await workApiUser(request);
    return workJson(await listWorkCollections(user, new URL(request.url).searchParams));
  } catch (error) { return workApiError(error, 'read'); }
}

export async function POST(request: Request) {
  try {
    const user = await workApiUser(request);
    return workJson(await createWorkCollection(user, await workJsonBody(request)));
  } catch (error) { return workApiError(error); }
}
