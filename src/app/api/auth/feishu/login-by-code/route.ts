import { NextRequest, NextResponse } from 'next/server';
import { FeishuAuthError, loginWithFeishuCode } from '@/lib/auth/feishu';
import { setSessionCookie } from '@/lib/auth/session-cookie';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    if (!code) return NextResponse.json({ error: 'code 为必填' }, { status: 400 });

    const result = await loginWithFeishuCode(code, new URL(request.url).origin);
    const response = NextResponse.json({ user: result.user });
    return setSessionCookie(response, result.token);
  } catch (error) {
    if (error instanceof FeishuAuthError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    console.error('[Feishu login-by-code]', error);
    return NextResponse.json({ error: '飞书登录失败' }, { status: 500 });
  }
}
