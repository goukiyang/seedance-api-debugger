import { NextRequest } from 'next/server';
import { createPreset, listPresets } from '@/lib/bridge/queue-presets';
import { readBody, withUser } from './_shared';

export const dynamic = 'force-dynamic';

/** GET ?scope=mine|shared&q=&sort=new|likes|uses&limit=&offset= */
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  return withUser(request, false, (user) => listPresets(user, {
    scope: sp.get('scope') === 'shared' ? 'shared' : 'mine',
    q: sp.get('q') || '', sort: sp.get('sort') || 'new', limit: Number(sp.get('limit') || 100), offset: Number(sp.get('offset') || 0),
  }));
}

/** POST { name, items, shared, clientId? } */
export async function POST(request: NextRequest) {
  return withUser(request, true, async (user) => ({ preset: await createPreset(user, await readBody(request)) }));
}
