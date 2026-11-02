import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { BridgeFeishuError } from '@/lib/bridge/feishu-contract';
import { readBridgeFeishuSend } from '@/lib/bridge/feishu-send';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  const headers = { 'Cache-Control': 'no-store' };
  try {
    const user = await getSession();
    if (!user) throw new BridgeFeishuError('未登录', 401);
    return NextResponse.json(await readBridgeFeishuSend(user.id, params.id), { headers });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof BridgeFeishuError ? error.message : '发送记录暂时无法读取，请稍后再试' },
      { status: error instanceof BridgeFeishuError ? error.status : 503, headers });
  }
}
