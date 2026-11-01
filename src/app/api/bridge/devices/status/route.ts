import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { BridgeDeviceError, parseDeviceStatus, upsertBridgeDevice } from '@/lib/bridge/devices';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: '未登录', ok: false }, { status: 401 });
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'JSON 解析失败', ok: false }, { status: 400 });
    }
    const status = parseDeviceStatus(body);
    if (!status) return NextResponse.json({ error: 'deviceId 不能为空', ok: false }, { status: 400 });
    const device = await upsertBridgeDevice(user.id, status);
    return NextResponse.json({ ok: true, device });
  } catch (error) {
    if (error instanceof BridgeDeviceError) return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
    console.error('[bridge/devices/status]', error);
    return NextResponse.json({ error: '上报设备状态失败', ok: false }, { status: 500 });
  }
}
