import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { BridgeDeviceError } from './devices';

export async function bindingSession(request: NextRequest, shellRequired = false) {
  const user = await getSession();
  if (!user) throw new BridgeDeviceError('未登录', 401);
  if (shellRequired && !request.headers.get('X-SD2B-Shell')?.trim()) {
    throw new BridgeDeviceError('请通过 SD2 插件同步设备', 403);
  }
  return user;
}

export async function bindingBody(request: NextRequest): Promise<unknown> {
  try { return await request.json(); }
  catch { throw new BridgeDeviceError('JSON 解析失败', 400); }
}

export function bindingFailure(error: unknown) {
  if (error instanceof BridgeDeviceError) return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
  console.error('[bridge/device-bindings]', error);
  return NextResponse.json({ ok: false, error: '设备操作失败，请稍后重试' }, { status: 500 });
}
