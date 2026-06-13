import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getAdminUser, errorJson } from '@/lib/auth/api-helpers';
import type { SessionUser } from '@/lib/auth/session';

export async function POST(request: NextRequest) {
  let admin: SessionUser;
  try {
    admin = await getAdminUser(request);
  } catch {
    return errorJson('权限不足', 403);
  }

  try {
    const body = await request.json();
    const { user_id, type, amount, reason } = body;
    const confirmed = body.confirm === true || body.confirmed === true;

    if (!user_id) return errorJson('user_id 为必填', 400);
    if (!['grant', 'deduct', 'adjust'].includes(type)) {
      return errorJson('type 必须是 grant / deduct / adjust', 400);
    }
    if (typeof amount !== 'number' || amount <= 0) {
      return errorJson('amount 必须为正数', 400);
    }
    if (!reason || reason.trim() === '') {
      return errorJson('reason 为必填', 400);
    }
    if (!confirmed) {
      return errorJson('点数操作需要二次确认', 400);
    }

    const targetUser = await prisma.user.findUnique({ where: { id: user_id } });
    if (!targetUser) return errorJson('用户不存在', 404);

    const ledgerType = type === 'grant' ? 'admin_grant' : type === 'deduct' ? 'admin_deduct' : 'system_adjust';

    // 事务：更新账户 + 写流水 + 写操作日志
    const result = await prisma.$transaction(async (tx) => {
      const account = await tx.creditAccount.findUnique({ where: { user_id } });
      if (!account) throw new Error('点数账户不存在');

      // deduct 只允许扣可用余额
      if (type === 'deduct') {
        const available = account.balance - account.frozen_credits;
        if (amount > available) {
          throw new Error(`可用余额不足，当前可用 ${available.toFixed(2)}`);
        }
      }

      const balanceBefore = account.balance;
      const newBalance = type === 'deduct'
        ? balanceBefore - amount
        : balanceBefore + amount;

      await tx.creditAccount.update({
        where: { user_id },
        data: { balance: newBalance },
      });

      await tx.creditLedger.create({
        data: {
          user_id,
          type: ledgerType,
          amount: type === 'deduct' ? -amount : amount,
          balance_before: balanceBefore,
          balance_after: newBalance,
          frozen_before: account.frozen_credits,
          frozen_after: account.frozen_credits,
          operator_id: admin.id,
          reason: reason.trim(),
        },
      });

      await tx.operationLog.create({
        data: {
          operator_id: admin.id,
          action: 'credit_adjust',
          target_type: 'User',
          target_id: user_id,
          detail: JSON.stringify({ type, amount, reason, balance_before: balanceBefore, balance_after: newBalance }),
        },
      });

      return { balance_before: balanceBefore, balance_after: newBalance };
    });

    return NextResponse.json({ ok: true, balance_before: result.balance_before, balance_after: result.balance_after });
  } catch (err) {
    if (err instanceof Error) return errorJson(err.message, 400);
    console.error('[Admin/Credits/Adjust]', err);
    return errorJson('服务器错误', 500);
  }
}
