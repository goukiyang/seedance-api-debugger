import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { BRIDGE_DEVICE_STALE_MS, readBridgeDevices, withStale } from '@/lib/bridge/devices';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录', ok: false }, { status: 401 });
    const devices = withStale(await readBridgeDevices(user.id));
    return NextResponse.json({ ok: true, devices, stale_after_ms: BRIDGE_DEVICE_STALE_MS });
  } catch (error) {
    console.error('[bridge/devices]', error);
    return NextResponse.json({ error: '读取设备状态失败', ok: false }, { status: 500 });
  }
}
