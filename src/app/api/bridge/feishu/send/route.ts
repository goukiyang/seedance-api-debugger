import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { BridgeFeishuError } from '@/lib/bridge/feishu-contract';
import { enqueueBridgeFeishuSend, preflightBridgeFeishu } from '@/lib/bridge/feishu-send';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'no-store' };
function failure(error: unknown) {
  return NextResponse.json({ ok: false, error: error instanceof BridgeFeishuError ? error.message : '飞书发送服务暂不可用，请稍后再试',
    ...(error instanceof BridgeFeishuError && error.code ? { code: error.code } : {}) },
  { status: error instanceof BridgeFeishuError ? error.status : 503, headers });
}
export async function GET() {
  try {
    const user = await getSession();
    if (!user) throw new BridgeFeishuError('未登录', 401);
    return NextResponse.json(await preflightBridgeFeishu(user.id), { headers });
  } catch (error) { return failure(error); }
}
export async function POST(request: NextRequest) {
  try {
    const user = await getSession();
    if (!user) throw new BridgeFeishuError('未登录', 401);
    if (Number(request.headers.get('content-length')) > 32 * 1024) throw new BridgeFeishuError('发送内容太长，请缩短提示词或链接');
    return NextResponse.json(await enqueueBridgeFeishuSend(user.id, await request.json().catch(() => null)), { headers });
  } catch (error) { return failure(error); }
}
