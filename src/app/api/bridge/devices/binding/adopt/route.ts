import { NextRequest, NextResponse } from 'next/server';
import { adoptBinding } from '@/lib/bridge/device-bindings';
import { bindingBody, bindingFailure, bindingSession } from '@/lib/bridge/device-binding-http';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const me = await bindingSession(request, true);
    const binding = await adoptBinding(me, await bindingBody(request));
    return NextResponse.json({ ok: true, binding });
  } catch (error) { return bindingFailure(error); }
}
