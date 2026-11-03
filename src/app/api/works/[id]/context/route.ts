import { readWorkContext } from '@/lib/works/context';
import { workApiError, workApiUser, workJson } from '@/lib/works/operations';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, { params }: { params: { id: string } }) {
  try { return workJson(await readWorkContext(await workApiUser(request), params.id, new URL(request.url).searchParams)); }
  catch (error) { return workApiError(error, 'read'); }
}
