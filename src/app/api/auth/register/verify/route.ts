import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { prisma } from '@/lib/prisma';
import { createSession } from '@/lib/auth/session';
import {
  REGISTER_CHALLENGE_COOKIE,
  isCompanyEmail,
  normalizeCompanyEmail,
  normalizeText,
} from '@/lib/auth/registration/config';
import {
  hashRegisterCode,
  verifyRegisterChallengeToken,
} from '@/lib/auth/registration/challenge';
import { createRegisteredUser } from '@/lib/auth/registration/create-user';

const SESSION_COOKIE = 'session';
const SESSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 7;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const email = normalizeCompanyEmail(body.email);
    const code = normalizeText(body.code);

    if (!email || !code) {
      return NextResponse.json({ error: '邮箱和验证码不能为空' }, { status: 400 });
    }
    if (!isCompanyEmail(email)) {
      return NextResponse.json({ error: '请使用 @youdoogo.com 公司邮箱注册' }, { status: 400 });
    }

    const cookieStore = await cookies();
    const challenge = verifyRegisterChallengeToken(cookieStore.get(REGISTER_CHALLENGE_COOKIE)?.value);
    if (!challenge) {
      return NextResponse.json({ error: '验证码已失效，请重新获取' }, { status: 400 });
    }
    if (challenge.email !== email) {
      return NextResponse.json({ error: '邮箱与验证码请求不一致' }, { status: 400 });
    }
    if (challenge.expiresAt <= Date.now()) {
      cookieStore.delete(REGISTER_CHALLENGE_COOKIE);
      return NextResponse.json({ error: '验证码已过期，请重新获取' }, { status: 400 });
    }

    const codeHash = hashRegisterCode(challenge.email, challenge.nonce, code);
    if (codeHash !== challenge.codeHash) {
      return NextResponse.json({ error: '验证码不正确' }, { status: 400 });
    }

    const created = await prisma.$transaction(async (tx) => {
      const existing = await tx.user.findUnique({ where: { email }, select: { id: true } });
      if (existing) return null;
      return createRegisteredUser(tx, {
        email: challenge.email,
        name: challenge.name,
        passwordHash: challenge.passwordHash,
      });
    });

    if (!created) {
      cookieStore.delete(REGISTER_CHALLENGE_COOKIE);
      return NextResponse.json({ error: '该邮箱已注册，请直接登录' }, { status: 409 });
    }

    const sessionToken = await createSession(created.id);
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
    }, { status: 201 });
  } catch (error) {
    console.error('[RegisterVerify]', error);
    return NextResponse.json({ error: '服务器错误' }, { status: 500 });
  }
}
