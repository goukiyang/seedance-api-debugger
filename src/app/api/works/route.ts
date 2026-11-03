import { readWorkPage } from '@/lib/works/query';
import { workApiUser, workJson } from '@/lib/works/operations';
import { workRouteError } from '@/lib/works/http';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  try { const user = await workApiUser(request); return workJson(await readWorkPage(user, new URL(request.url).searchParams)); }
  catch (error) { return workRouteError(error); }
}
