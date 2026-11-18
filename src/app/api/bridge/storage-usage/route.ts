import { NextRequest, NextResponse } from 'next/server';
import { getBridgeUser } from '@/lib/bridge/panel-token';
import { readBridgeStorageUsage } from '@/lib/bridge/storage-usage';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie, Authorization' };
export async function GET(request: NextRequest) {
  try {
    const user = await getBridgeUser(request);
    if (!user) return NextResponse.json({ ok: false, error: '请先登录 SD2' }, { status: 401, headers });
    if (request.headers.get('x-sd2-user-id') !== user.id) return NextResponse.json({ ok: false, error: '账号已切换，请重新读取' }, { status: 409, headers });
    return NextResponse.json({ ok: true, ...await readBridgeStorageUsage(user.id) }, { headers });
  } catch {
    return NextResponse.json({ ok: false, error: '暂时无法统计，请稍后重试' }, { status: 503, headers });
  }
}
