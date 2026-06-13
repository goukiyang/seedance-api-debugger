import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getAdminUser, errorJson } from '@/lib/auth/api-helpers';
import type { SessionUser } from '@/lib/auth/session';

const MAX_BULK_RECIPIENTS = 200;

function normalizeUserIds(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const ids: string[] = [];

  for (const item of input) {
    const id = typeof item === 'string' ? item.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }

  return ids;
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
    const userIds = normalizeUserIds(body.user_ids ?? body.userIds);
    const amount = Number(body.amount);
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    const confirmed = body.confirm === true || body.confirmed === true;

    if (userIds.length === 0) return errorJson('请选择至少一个用户', 400);
    if (userIds.length > MAX_BULK_RECIPIENTS) {
      return errorJson(`单次最多发放 ${MAX_BULK_RECIPIENTS} 个用户`, 400);
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return errorJson('amount 必须为正数', 400);
    }
    if (!reason) return errorJson('reason 为必填', 400);
    if (!confirmed) return errorJson('批量发放需要二次确认', 400);

    const recipients = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true, username: true, status: true },
    });
    if (recipients.length !== userIds.length) {
      const found = new Set(recipients.map((user) => user.id));
      const missing = userIds.filter((id) => !found.has(id));
      return errorJson(`用户不存在：${missing.join(', ')}`, 404);
    }

    const results = await prisma.$transaction(async (tx) => {
      const ledgerResults: Array<{
        user_id: string;
        balance_before: number;
        balance_after: number;
      }> = [];

      for (const userId of userIds) {
        let account = await tx.creditAccount.findUnique({ where: { user_id: userId } });
        if (!account) {
          account = await tx.creditAccount.create({
            data: {
              user_id: userId,
              balance: 0,
              frozen_credits: 0,
            },
          });
        }

        const balanceBefore = account.balance;
        const balanceAfter = balanceBefore + amount;

        await tx.creditAccount.update({
          where: { user_id: userId },
          data: { balance: balanceAfter },
        });

        await tx.creditLedger.create({
          data: {
            user_id: userId,
            type: 'admin_grant',
            amount,
            balance_before: balanceBefore,
            balance_after: balanceAfter,
            frozen_before: account.frozen_credits,
            frozen_after: account.frozen_credits,
            operator_id: admin.id,
            reason,
          },
        });

        await tx.operationLog.create({
          data: {
            operator_id: admin.id,
            action: 'credit_bulk_grant',
            target_type: 'User',
            target_id: userId,
            detail: JSON.stringify({
              amount,
              reason,
              balance_before: balanceBefore,
              balance_after: balanceAfter,
              batch_size: userIds.length,
            }),
          },
        });

        ledgerResults.push({
          user_id: userId,
          balance_before: balanceBefore,
          balance_after: balanceAfter,
        });
      }

      await tx.operationLog.create({
        data: {
          operator_id: admin.id,
          action: 'credit_bulk_grant_batch',
          target_type: 'CreditAccount',
          target_id: admin.id,
          detail: JSON.stringify({
            amount,
            reason,
            user_ids: userIds,
            count: userIds.length,
          }),
        },
      });

      return ledgerResults;
    });

    return NextResponse.json({
      ok: true,
      count: results.length,
      amount,
      total_amount: amount * results.length,
      recipients: results,
    });
  } catch (err) {
    if (err instanceof Error) return errorJson(err.message, 400);
    console.error('[Admin/Credits/BulkGrant]', err);
    return errorJson('服务器错误', 500);
  }
}
