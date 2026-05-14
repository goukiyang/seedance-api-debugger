import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { prisma } from '@/lib/prisma';
import { hashPassword } from '@/lib/auth/password';
import { SESSION_COOKIE, createSession } from '@/lib/auth/session';
import {
  MIN_REGISTER_PASSWORD_LENGTH,
  REGISTER_CHALLENGE_COOKIE,
  REGISTER_CODE_TTL_SECONDS,
  isRegisterEmailVerificationEnabled,
  isCompanyEmail,
  normalizeCompanyEmail,
  normalizeText,
} from '@/lib/auth/registration/config';
import {
  createRegisterChallengeToken,
  createRegisterCode,
  createRegisterNonce,
  hashRegisterCode,
} from '@/lib/auth/registration/challenge';
import { createRegisteredUser } from '@/lib/auth/registration/create-user';
import { sendRegistrationCode } from '@/lib/auth/registration/email';

const SESSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 7;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const email = normalizeCompanyEmail(body.email);
    const name = normalizeText(body.name);
    const password = typeof body.password === 'string' ? body.password : '';

    if (!email || !password) {
      return NextResponse.json({ error: '邮箱和密码不能为空' }, { status: 400 });
    }
    if (!isCompanyEmail(email)) {
      return NextResponse.json({ error: '请使用 @youdoogo.com 公司邮箱注册' }, { status: 400 });
    }
    if (password.length < MIN_REGISTER_PASSWORD_LENGTH) {
      return NextResponse.json({ error: `密码至少需要 ${MIN_REGISTER_PASSWORD_LENGTH} 位` }, { status: 400 });
    }

    const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (existing) {
      return NextResponse.json({ error: '该邮箱已注册，请直接登录' }, { status: 409 });
    }

    const passwordHash = hashPassword(password);
    if (!isRegisterEmailVerificationEnabled()) {
      const created = await prisma.$transaction(async (tx) => {
        const duplicate = await tx.user.findUnique({ where: { email }, select: { id: true } });
        if (duplicate) return null;
        return createRegisteredUser(tx, { email, name, passwordHash });
      });

      if (!created) {
        return NextResponse.json({ error: '该邮箱已注册，请直接登录' }, { status: 409 });
      }

      const sessionToken = await createSession(created.id);
      const cookieStore = await cookies();
      cookieStore.delete(REGISTER_CHALLENGE_COOKIE);
      cookieStore.set(SESSION_COOKIE, sessionToken, {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: SESSION_COOKIE_MAX_AGE,
        path: '/',
      });

      return NextResponse.json({
        user: {
          id: created.id,
          name: created.name,
          username: created.username,
	          email: created.email,
	          role: created.role,
	          account_type: created.account_type,
	          user_profile: created.user_profile,
	          feature_profile_id: created.feature_profile_id,
	          status: created.status,
	        },
        verification_required: false,
      }, { status: 201 });
    }

    const code = createRegisterCode();
    const nonce = createRegisterNonce();
    const expiresAt = Date.now() + REGISTER_CODE_TTL_SECONDS * 1000;
    const token = createRegisterChallengeToken({
      email,
      name,
      passwordHash,
      codeHash: hashRegisterCode(email, nonce, code),
      nonce,
      expiresAt,
    });

    const delivery = await sendRegistrationCode(email, code);
    if (!delivery.delivered) {
      return NextResponse.json(
        { error: delivery.error || '验证码邮件发送失败' },
        { status: 503 },
      );
    }

    const cookieStore = await cookies();
    cookieStore.set(REGISTER_CHALLENGE_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: REGISTER_CODE_TTL_SECONDS,
      path: '/',
    });

    return NextResponse.json({
      ok: true,
      verification_required: true,
      expires_in: REGISTER_CODE_TTL_SECONDS,
      delivery_provider: delivery.provider,
      debug_code: delivery.debugCode,
    });
  } catch (error) {
    console.error('[RegisterRequestCode]', error);
    return NextResponse.json({ error: '服务器错误' }, { status: 500 });
  }
}
