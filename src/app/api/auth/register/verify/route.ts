import { route as apiRoute } from '@/lib/http/route';
import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { prisma } from '@/lib/prisma';
import { completeLogin } from '@/lib/auth/complete-login';
import { setSessionCookie } from '@/lib/auth/session-cookie';
import { REGISTER_CHALLENGE_COOKIE, isSelfRegistrationEnabled, isValidRegisterEmail, normalizeEmail, normalizeText } from '@/lib/auth/registration/config';
import { consumeRegisterChallenge } from '@/lib/auth/registration/challenge';
import { createRegisteredUser } from '@/lib/auth/registration/create-user';
import { requestSessionDevice } from '@/lib/auth/session-store';

export const POST = apiRoute({ access: 'public', rateLimit: "auth" }, async function POST(request: NextRequest) {
  if (!isSelfRegistrationEnabled()) return NextResponse.json({ error: '注册暂未开放' }, { status: 404 });
  try {
    const body = await request.json(), email = normalizeEmail(body.email), code = normalizeText(body.code);
    if (!isValidRegisterEmail(email) || !code || code.length > 20) return NextResponse.json({ error: '请输入有效邮箱和验证码' }, { status: 400 });
    const token = (await cookies()).get(REGISTER_CHALLENGE_COOKIE)?.value;
    const result = await prisma.$transaction(async (tx) => {
      // A wrong attempt commits its counter; throwing here would roll it back.
      const challenge = await consumeRegisterChallenge(tx, token, email, code);
      if (!challenge) return null;
      if (await tx.user.findUnique({ where: { email }, select: { id: true } })) return { duplicate: true } as const;
      const user = await createRegisteredUser(tx, { ...challenge, emailVerified: true });
      return completeLogin({ userId: user.id, device: requestSessionDevice(request) }, 'register', tx);
    });
    if (!result) return NextResponse.json({ error: '验证码不正确或已失效，请重新获取' }, { status: 400 });
    if ('duplicate' in result) return NextResponse.json({ error: '该邮箱已注册，请直接登录' }, { status: 409 });
    const response = setSessionCookie(NextResponse.json({ user: result.user }, { status: 201 }), result.token);
    response.cookies.set(REGISTER_CHALLENGE_COOKIE, '', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 0 });
    return response;
  } catch {
    return NextResponse.json({ error: '服务暂时不可用' }, { status: 503 });
  }
});
