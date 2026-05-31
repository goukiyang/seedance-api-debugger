import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { AuthError } from '@/lib/auth/session';
import { getAdminUser } from '@/lib/auth/api-helpers';
import { decimalToMinor, rawSnapshotJson } from '@/lib/costs/provider-balance';

export const dynamic = 'force-dynamic';

function normalizeCurrency(value: unknown) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(normalized) ? normalized : null;
}

function parseAmount(value: unknown) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = String(value).trim().replace(/[,，]/g, '');
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
  return normalized;
}

function snapshotDto(snapshot: {
  id: string;
  provider_name: string;
  provider_account_id: string | null;
  balance_kind: string;
  amount_decimal: string | null;
  amount_minor: number | null;
  currency: string | null;
  quota_amount: number | null;
  quota_unit: string | null;
  source: string;
  status: string;
  note: string | null;
  error_message: string | null;
  fetched_at: Date;
  created_at: Date;
}) {
  return {
    ...snapshot,
    fetched_at: snapshot.fetched_at.toISOString(),
    created_at: snapshot.created_at.toISOString(),
  };
}

export async function GET(request: NextRequest) {
  try {
    await getAdminUser(request);
    const searchParams = request.nextUrl.searchParams;
    const limit = Math.min(Math.max(Number(searchParams.get('limit') || 10), 1), 50);
    const providerName = searchParams.get('provider')?.trim() || 'seedance';

    const snapshots = await prisma.providerAccountSnapshot.findMany({
      where: { provider_name: providerName },
      orderBy: { fetched_at: 'desc' },
      take: limit,
    });

    return NextResponse.json({
      ok: true,
      latest: snapshots[0] ? snapshotDto(snapshots[0]) : null,
      snapshots: snapshots.map(snapshotDto),
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[ProviderBalance] GET failed:', error);
    return NextResponse.json({ error: '读取供应商额度快照失败' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await getAdminUser(request);
    const body = await request.json() as Record<string, unknown>;
    const amountDecimal = parseAmount(body.amount ?? body.amount_decimal);
    const currency = normalizeCurrency(body.currency);
    const providerName = typeof body.provider_name === 'string' && body.provider_name.trim()
      ? body.provider_name.trim()
      : 'seedance';
    const providerAccountId = typeof body.provider_account_id === 'string' && body.provider_account_id.trim()
      ? body.provider_account_id.trim()
      : null;
    const note = typeof body.note === 'string' && body.note.trim()
      ? body.note.trim()
      : '管理员手动记录供应商账户额度';

    if (!amountDecimal) {
      return NextResponse.json({ error: '额度金额必须是非负数字' }, { status: 400 });
    }
    if (!currency) {
      return NextResponse.json({ error: '币种必须是三位字母，例如 CNY 或 USD' }, { status: 400 });
    }

    const snapshot = await prisma.$transaction(async (tx) => {
      const created = await tx.providerAccountSnapshot.create({
        data: {
          provider_name: providerName,
          provider_account_id: providerAccountId,
          balance_kind: 'prepaid',
          amount_decimal: amountDecimal,
          amount_minor: decimalToMinor(amountDecimal),
          currency,
          source: 'manual',
          status: 'manual',
          note,
          raw_snapshot: rawSnapshotJson({ amount: amountDecimal, currency, provider_account_id: providerAccountId, note }),
          created_by: user.id,
        },
      });

      await tx.operationLog.create({
        data: {
          operator_id: user.id,
          action: 'provider_balance_manual_record',
          target_type: 'ProviderAccountSnapshot',
          target_id: created.id,
          detail: JSON.stringify({
            provider_name: providerName,
            provider_account_id: providerAccountId,
            amount_decimal: amountDecimal,
            amount_minor: created.amount_minor,
            currency,
          }),
        },
      });

      return created;
    });

    return NextResponse.json({ ok: true, snapshot: snapshotDto(snapshot) });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[ProviderBalance] POST failed:', error);
    return NextResponse.json({ error: '保存供应商额度快照失败' }, { status: 500 });
  }
}
