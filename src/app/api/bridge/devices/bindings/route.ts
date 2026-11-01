import { NextRequest, NextResponse } from 'next/server';
import { listBindings } from '@/lib/bridge/device-bindings';
import { bindingFailure, bindingSession } from '@/lib/bridge/device-binding-http';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const me = await bindingSession(request);
    const bindings = await listBindings(me, request.nextUrl.searchParams.get('scope') || 'mine',
      request.nextUrl.searchParams.get('includeArchived') === '1');
    return NextResponse.json({ ok: true, bindings });
  } catch (error) { return bindingFailure(error); }
}
