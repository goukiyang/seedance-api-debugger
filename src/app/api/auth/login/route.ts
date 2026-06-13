import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { login } from '@/lib/auth/session';

const COOKIE_NAME = 'session';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { identifier, password } = body;

    if (!identifier || !password) {
      return NextResponse.json({ error: '账号和密码不能为空' }, { status: 400 });
    }

    const result = await login(identifier, password);

    if ('error' in result) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    const cookieStore = await cookies();
    cookieStore.set(COOKIE_NAME, result.token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: COOKIE_MAX_AGE,
      path: '/',
    });

    return NextResponse.json({ user: result.user });
  } catch (err) {
    console.error('[Login]', err);
    return NextResponse.json({ error: '服务器错误' }, { status: 500 });
  }
}