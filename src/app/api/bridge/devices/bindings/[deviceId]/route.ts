import { NextRequest, NextResponse } from 'next/server';
import { patchBinding } from '@/lib/bridge/device-bindings';
import { bindingBody, bindingFailure, bindingSession } from '@/lib/bridge/device-binding-http';

export const dynamic = 'force-dynamic';

export async function PATCH(request: NextRequest, { params }: { params: { deviceId: string } }) {
  try {
    const me = await bindingSession(request);
    const binding = await patchBinding(me, params.deviceId, await bindingBody(request));
    return NextResponse.json({ ok: true, binding });
  } catch (error) { return bindingFailure(error); }
}
