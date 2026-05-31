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
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || (type !== 'adjust' && amount <= 0)) {
      return errorJson(type === 'adjust' ? 'amount 必须为大于等于 0 的数字' : 'amount 必须为正数', 400);
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

      // deduct 只允许扣长期可用余额；每日配额由任务消费，不做后台手工扣减。
      if (type === 'deduct') {
        const available = account.balance - account.frozen_credits;
        if (amount > available) {
          throw new Error(`可用余额不足，当前可用 ${available.toFixed(2)}`);
        }
      }
      if (type === 'adjust' && amount < account.frozen_credits) {
        throw new Error(`修正后的长期余额不能低于已冻结点数 ${account.frozen_credits.toFixed(2)}`);
      }

      const balanceBefore = account.balance;
      const newBalance = type === 'grant'
        ? balanceBefore + amount
        : type === 'deduct'
          ? balanceBefore - amount
          : amount;
      const ledgerAmount = newBalance - balanceBefore;

      await tx.creditAccount.update({
        where: { user_id },
        data: { balance: newBalance },
      });

      await tx.creditLedger.create({
        data: {
          user_id,
          type: ledgerType,
          amount: ledgerAmount,
          balance_before: balanceBefore,
          balance_after: newBalance,
          frozen_before: account.frozen_credits,
          frozen_after: account.frozen_credits,
          operator_id: admin.id,
          reason: reason.trim(),
          metadata_json: JSON.stringify({
            operation: type,
            requested_amount: amount,
            delta: ledgerAmount,
            scope: 'long_term_balance',
          }),
        },
      });

      await tx.operationLog.create({
        data: {
          operator_id: admin.id,
          action: 'credit_adjust',
          target_type: 'User',
          target_id: user_id,
          detail: JSON.stringify({ type, amount, delta: ledgerAmount, reason, balance_before: balanceBefore, balance_after: newBalance }),
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
