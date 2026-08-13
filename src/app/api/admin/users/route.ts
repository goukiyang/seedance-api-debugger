import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { errorJson, getAdminUser } from '@/lib/auth/api-helpers';
import { hashPassword } from '@/lib/auth/password';
import type { SessionUser } from '@/lib/auth/session';
import { grantInitialCredits, getCreditPolicy, resolveInitialGrantAmount } from '@/lib/credits/policy';
import {
  getDefaultFeatureProfileId,
  normalizeFeatureProfileId,
  normalizeUserProfile,
} from '@/lib/users/profiles';

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export async function GET(request: NextRequest) {
  try {
    await getAdminUser(request);
  } catch {
    return errorJson('权限不足', 403);
  }

  if (request.nextUrl.searchParams.get('lite') === 'true') {
    const users = await prisma.user.findMany({
      where: { status: { not: 'deleted' } },
      select: {
        id: true,
        name: true,
        username: true,
        email: true,
        avatar_url: true,
        status: true,
      },
      orderBy: { created_at: 'desc' },
    });

    return NextResponse.json({ users });
  }

  const now = new Date();
  const users = await prisma.user.findMany({
    where: { status: { not: 'deleted' } },
    select: {
      id: true,
      name: true,
      username: true,
      email: true,
      avatar_url: true,
	      role: true,
	      account_type: true,
	      user_profile: true,
      feature_profile_id: true,
      status: true,
      feishu_user_id: true,
      feishu_open_id: true,
      feishu_union_id: true,
      expires_at: true,
      created_at: true,
      last_login_at: true,
      credit_account: {
        select: {
          balance: true,
          frozen_credits: true,
          monthly_used: true,
          total_used: true,
        },
      },
      credit_buckets: {
        where: {
          source_type: 'daily_quota',
          status: 'active',
          OR: [{ expires_at: null }, { expires_at: { gt: now } }],
        },
        select: {
          amount_total: true,
          amount_remaining: true,
          frozen_amount: true,
          expires_at: true,
        },
      },
    },
    orderBy: { created_at: 'desc' },
  });

  return NextResponse.json({
    users: users.map((user) => ({
      ...user,
      credit_quota: {
        daily_total: user.credit_buckets.reduce((total, bucket) => total + bucket.amount_total, 0),
        daily_remaining: user.credit_buckets.reduce((total, bucket) => total + bucket.amount_remaining, 0),
        daily_frozen: user.credit_buckets.reduce((total, bucket) => total + bucket.frozen_amount, 0),
        daily_expires_at: user.credit_buckets
          .map((bucket) => bucket.expires_at)
          .filter(Boolean)
          .sort((a, b) => Number(a) - Number(b))[0] || null,
      },
      credit_buckets: undefined,
    })),
  });
}

export async function POST(request: NextRequest) {
  let admin: SessionUser;
  try {
    admin = await getAdminUser(request);
  } catch {
    return errorJson('权限不足', 403);
  }

  try {
    const body = await request.json();
    const name = normalizeText(body.name);
    const username = normalizeText(body.username);
    const email = normalizeText(body.email).toLowerCase();
    const password = typeof body.password === 'string' ? body.password : '';
	    const role = body.role === 'admin' ? 'admin' : 'user';
	    const accountType = body.account_type === 'external' ? 'external' : 'internal';
	    const userProfile = accountType === 'external' ? 'other' : normalizeUserProfile(body.user_profile);
	    const featureProfileId = accountType === 'external'
	      ? 'external_limited'
	      : normalizeFeatureProfileId(body.feature_profile_id) || getDefaultFeatureProfileId(accountType, userProfile);
      const initialCreditsInput = body.initial_credits ?? body.initialCredits;
      const policy = await getCreditPolicy();
	    const initialCredits = initialCreditsInput == null
        ? resolveInitialGrantAmount(policy, { role, account_type: accountType }, 'admin_create')
        : Number(initialCreditsInput);
	    const reason = normalizeText(body.reason) || '创建用户初始点数';

    if (!name || !username || !email || !password) {
      return errorJson('name, username, email, password 为必填项', 400);
    }
	    if (!Number.isFinite(initialCredits) || initialCredits < 0) {
	      return errorJson('initial_credits 必须为非负数', 400);
	    }
	    if (role === 'admin' && accountType !== 'internal') {
	      return errorJson('管理员必须是内部账号', 400);
	    }

    const existing = await prisma.user.findFirst({
      where: { OR: [{ username }, { email }] },
    });
    if (existing) return errorJson('用户名或邮箱已存在', 409);

    const created = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name,
          username,
          email,
	          password_hash: hashPassword(password),
	          role,
	          account_type: accountType,
	          user_profile: userProfile,
	          feature_profile_id: featureProfileId,
	          status: 'active',
	        },
      });

      await tx.creditAccount.create({
        data: {
          user_id: user.id,
          balance: 0,
          frozen_credits: 0,
        },
      });

      const initialGrant = await grantInitialCredits(tx, user, 'admin_create', {
        amount: initialCredits,
        operatorId: admin.id,
        reason,
      });

      const defaultProject = await tx.project.create({
        data: {
          name: '我的默认项目',
          description: '系统自动创建的个人默认项目',
          type: 'personal',
          visibility: 'private',
          owner_user_id: user.id,
          created_by: admin.id,
          status: 'active',
        },
      });

      await tx.projectMember.create({
        data: {
          project_id: defaultProject.id,
          user_id: user.id,
          role: 'project_owner',
          joined_by: admin.id,
        },
      });

      await tx.operationLog.create({
        data: {
          operator_id: admin.id,
          action: 'create_user',
          target_type: 'User',
          target_id: user.id,
          detail: JSON.stringify({
            name,
            username,
            email,
	            role,
	            account_type: accountType,
	            user_profile: userProfile,
	            feature_profile_id: featureProfileId,
	            initial_credits: initialGrant.amount,
	          }),
        },
      });

      await tx.operationLog.create({
        data: {
          operator_id: admin.id,
          action: 'project_create_default',
          target_type: 'project',
          target_id: defaultProject.id,
          detail: JSON.stringify({ user_id: user.id, source: 'admin_create_user' }),
        },
      });

      return user;
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
        expires_at: created.expires_at,
        created_at: created.created_at,
        credit_account: {
          balance: initialCredits,
          frozen_credits: 0,
          monthly_used: 0,
          total_used: 0,
        },
      },
    }, { status: 201 });
  } catch (err) {
    console.error('[Admin/Users POST]', err);
    return errorJson('服务器错误', 500);
  }
}
