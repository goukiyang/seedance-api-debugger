import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { proxyCutout } from '@/lib/cutout/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: { path?: string[] } };
async function proxy(request: NextRequest, context: Context) {
  const user = await getSession();
  return proxyCutout(request, context.params.path || [], user);
}
export const GET = proxy;
export const HEAD = proxy;
export const POST = proxy;
export const DELETE = proxy;
