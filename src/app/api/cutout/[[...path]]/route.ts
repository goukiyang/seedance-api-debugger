import { route as declaredRoute } from '@/lib/http/route';
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { proxyCutout } from '@/lib/cutout/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ path?: string[] }> };
async function proxy(request: NextRequest, context: Context) {
  const user = await getSession();
  const params = await context.params;
  return proxyCutout(request, params.path || [], user);
}
export const GET = declaredRoute({ access: 'admin', rateLimit: false }, proxy);
export const HEAD = declaredRoute({ access: 'admin', rateLimit: false }, proxy);
export const POST = declaredRoute({ access: 'admin', rateLimit: false }, proxy);
export const DELETE = declaredRoute({ access: 'admin', rateLimit: false }, proxy);
