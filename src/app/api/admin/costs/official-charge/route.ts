import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { AuthError } from '@/lib/auth/session';
import { getAdminUser } from '@/lib/auth/api-helpers';
import { recordTaskOfficialCharge } from '@/lib/costs/ledger';

export const dynamic = 'force-dynamic';

const ALLOWED_CURRENCIES = new Set(['CNY', 'USD']);

function parseAmountMinor(body: Record<string, unknown>): number | null {
  const amountMinor = body.amount_minor;
  if (typeof amountMinor === 'number' && Number.isInteger(amountMinor) && amountMinor >= 0) {
    return amountMinor;
  }

  const amount = body.amount;
  if (typeof amount !== 'string' && typeof amount !== 'number') return null;

  const numericAmount = typeof amount === 'number' ? amount : Number(amount.trim());
  if (!Number.isFinite(numericAmount) || numericAmount < 0) return null;

  return Math.round(numericAmount * 100);
}

export async function POST(request: NextRequest) {
  try {
    const user = await getAdminUser(request);
    const body = await request.json() as Record<string, unknown>;

    const taskId = typeof body.task_id === 'string' ? body.task_id.trim() : '';
    const officialChargeId = typeof body.official_charge_id === 'string'
      ? body.official_charge_id.trim()
      : '';
    const reason = typeof body.reason === 'string' && body.reason.trim()
      ? body.reason.trim()
      : '管理员录入官方实际扣费';
    const currency = typeof body.currency === 'string' && body.currency.trim()
      ? body.currency.trim().toUpperCase()
      : 'CNY';
    const amountMinor = parseAmountMinor(body);

    if (!taskId) {
      return NextResponse.json({ error: '任务 ID 不能为空' }, { status: 400 });
    }
    if (amountMinor === null) {
      return NextResponse.json({ error: '官方扣费金额不合法' }, { status: 400 });
    }
    if (!ALLOWED_CURRENCIES.has(currency)) {
      return NextResponse.json({ error: '暂只支持 CNY 或 USD' }, { status: 400 });
    }
    if (!officialChargeId) {
      return NextResponse.json({ error: '官方扣费 ID 不能为空，用于防止重复入账' }, { status: 400 });
    }

    const task = await prisma.videoTask.findUnique({ where: { id: taskId } });
    if (!task) {
      return NextResponse.json({ error: '任务不存在' }, { status: 404 });
    }

    const result = await prisma.$transaction(async (tx) => {
      const charge = await recordTaskOfficialCharge(tx, task, {
        amountMinor,
        currency,
        officialChargeId,
        reason,
        createdBy: user.id,
      });

      await tx.operationLog.create({
        data: {
          operator_id: user.id,
          action: charge.deduplicated ? 'official_charge_deduplicated' : 'official_charge_record',
          target_type: 'VideoTask',
          target_id: task.id,
          detail: JSON.stringify({
            amount_minor: amountMinor,
            currency,
            official_charge_id: officialChargeId,
            reason,
            deduplicated: charge.deduplicated,
          }),
        },
      });

      const updatedTask = await tx.videoTask.findUnique({
        where: { id: task.id },
        select: {
          id: true,
          provider_cost_status: true,
          provider_official_amount_minor: true,
          provider_final_amount_minor: true,
          provider_cost_currency: true,
          provider_cost_confirmed_at: true,
          cost_allocation_status: true,
        },
      });

      return { ...charge, task: updatedTask };
    });

    return NextResponse.json({
      ok: true,
      deduplicated: result.deduplicated,
      ledger: {
        id: result.ledger.id,
        idempotency_key: result.ledger.idempotency_key,
        amount_minor: result.ledger.amount_minor,
        currency: result.ledger.currency,
      },
      task: result.task,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[AdminOfficialCharge] Failed:', error);
    return NextResponse.json(
      { error: '录入官方扣费失败', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
