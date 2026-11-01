import { NextRequest, NextResponse } from 'next/server';
import { reportBinding } from '@/lib/bridge/device-bindings';
import { bindingBody, bindingFailure, bindingSession } from '@/lib/bridge/device-binding-http';

export const dynamic = 'force-dynamic';

export async function PUT(request: NextRequest) {
  try {
    const me = await bindingSession(request, true);
    const result = await reportBinding(me, await bindingBody(request));
    return NextResponse.json({ ok: true, ...result });
  } catch (error) { return bindingFailure(error); }
}
