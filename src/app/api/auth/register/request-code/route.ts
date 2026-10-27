import { route as apiRoute } from '@/lib/http/route';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { hashPassword } from '@/lib/auth/password';
import { completeLogin } from '@/lib/auth/complete-login';
import { setSessionCookie } from '@/lib/auth/session-cookie';
import { MIN_REGISTER_PASSWORD_LENGTH, REGISTER_CHALLENGE_COOKIE, REGISTER_CODE_TTL_SECONDS,
  isSelfRegistrationEnabled, isRegisterEmailVerificationEnabled, isValidRegisterEmail, normalizeEmail, normalizeText } from '@/lib/auth/registration/config';
import { createRegisterChallengeToken, createRegisterCode, createRegisterNonce, hashRegisterCode } from '@/lib/auth/registration/challenge';
import { createRegisteredUser } from '@/lib/auth/registration/create-user';
import { sendRegistrationCode } from '@/lib/auth/registration/email';
import { requestSessionDevice } from '@/lib/auth/session-store';

export const POST = apiRoute({ access: 'public', rateLimit: "registration-code" }, async function POST(request: NextRequest) {
  if (!isSelfRegistrationEnabled()) return NextResponse.json({ error: '注册暂未开放' }, { status: 404 });
  if (process.env.NODE_ENV === 'production' && !isRegisterEmailVerificationEnabled()) {
    return NextResponse.json({ error: '服务暂时不可用' }, { status: 503 });
  }
  try {
    const body = await request.json();
    const email = normalizeEmail(body.email), name = normalizeText(body.name);
    const password = typeof body.password === 'string' ? body.password : '';
    if (!isValidRegisterEmail(email) || name.length > 100 || Buffer.byteLength(password) > 1024 || password.length < MIN_REGISTER_PASSWORD_LENGTH) {
      return NextResponse.json({ error: '请输入有效邮箱和至少 8 位的密码' }, { status: 400 });
    }
    if (await prisma.user.findUnique({ where: { email }, select: { id: true } })) {
      return NextResponse.json({ error: '该邮箱已注册，请直接登录' }, { status: 409 });
    }
    const passwordHash = await hashPassword(password);
    if (!isRegisterEmailVerificationEnabled()) {
      const result = await prisma.$transaction(async (tx) => {
        const created = await createRegisteredUser(tx, { email, name, passwordHash });
        return completeLogin({ userId: created.id, device: requestSessionDevice(request) }, 'register', tx);
      });
      const response = setSessionCookie(NextResponse.json({ user: result.user, verification_required: false }, { status: 201 }), result.token);
      response.cookies.set(REGISTER_CHALLENGE_COOKIE, '', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 0 });
      return response;
    }
    const code = createRegisterCode(), nonce = createRegisterNonce();
    const token = await createRegisterChallengeToken({ email, name, passwordHash, codeHash: hashRegisterCode(email, nonce, code), nonce,
      expiresAt: Date.now() + REGISTER_CODE_TTL_SECONDS * 1000 });
    const delivery = await sendRegistrationCode(email, code);
    if (!delivery.delivered) return NextResponse.json({ error: '验证码邮件发送失败，请稍后重试' }, { status: 503 });
    const response = NextResponse.json({ ok: true, verification_required: true, expires_in: REGISTER_CODE_TTL_SECONDS,
      delivery_provider: delivery.provider, ...(process.env.NODE_ENV !== 'production' ? { debug_code: delivery.debugCode } : {}) });
    response.cookies.set(REGISTER_CHALLENGE_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production',
      path: '/', maxAge: REGISTER_CODE_TTL_SECONDS });
    return response;
  } catch {
    return NextResponse.json({ error: '服务暂时不可用' }, { status: 503 });
  }
});
