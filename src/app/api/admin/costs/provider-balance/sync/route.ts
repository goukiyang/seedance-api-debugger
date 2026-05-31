import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { AuthError } from '@/lib/auth/session';
import { getAdminUser } from '@/lib/auth/api-helpers';
import { pullSeedanceProviderBalance, rawSnapshotJson } from '@/lib/costs/provider-balance';

export const dynamic = 'force-dynamic';

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

export async function POST(request: NextRequest) {
  try {
    const user = await getAdminUser(request);
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const providerName = typeof body.provider_name === 'string' && body.provider_name.trim()
      ? body.provider_name.trim()
      : 'seedance';

    if (providerName !== 'seedance') {
      return NextResponse.json({ error: '当前只支持拉取 Seedance 账户额度' }, { status: 400 });
    }

    try {
      const result = await pullSeedanceProviderBalance();
      const snapshot = await prisma.$transaction(async (tx) => {
        const created = await tx.providerAccountSnapshot.create({
          data: {
            provider_name: result.providerName,
            provider_account_id: result.providerAccountId || null,
            balance_kind: result.balanceKind,
            amount_decimal: result.amountDecimal || null,
            amount_minor: result.amountMinor ?? null,
            currency: result.currency || null,
            quota_amount: result.quotaAmount ?? null,
            quota_unit: result.quotaUnit || null,
            source: 'provider_api',
            status: 'synced',
            note: result.note || `从 ${result.endpoint} 拉取`,
            raw_snapshot: rawSnapshotJson(result.rawSnapshot),
            created_by: user.id,
          },
        });

        await tx.operationLog.create({
          data: {
            operator_id: user.id,
            action: 'provider_balance_sync',
            target_type: 'ProviderAccountSnapshot',
            target_id: created.id,
            detail: JSON.stringify({
              provider_name: result.providerName,
              provider_account_id: result.providerAccountId,
              amount_decimal: result.amountDecimal,
              amount_minor: result.amountMinor,
              currency: result.currency,
              quota_amount: result.quotaAmount,
              quota_unit: result.quotaUnit,
              endpoint: result.endpoint,
              method: result.method,
            }),
          },
        });

        return created;
      });

      return NextResponse.json({ ok: true, snapshot: snapshotDto(snapshot) });
    } catch (syncError) {
      const errorMessage = syncError instanceof Error ? syncError.message : '拉取供应商账户额度失败';
      const snapshot = await prisma.$transaction(async (tx) => {
        const created = await tx.providerAccountSnapshot.create({
          data: {
            provider_name: providerName,
            balance_kind: 'unknown',
            source: 'provider_api',
            status: 'failed',
            error_message: errorMessage,
            note: '供应商账户额度拉取失败，已记录失败快照',
            created_by: user.id,
          },
        });

        await tx.operationLog.create({
          data: {
            operator_id: user.id,
            action: 'provider_balance_sync_failed',
            target_type: 'ProviderAccountSnapshot',
            target_id: created.id,
            detail: JSON.stringify({ provider_name: providerName, error_message: errorMessage }),
          },
        });

        return created;
      });

      return NextResponse.json(
        { error: errorMessage, snapshot: snapshotDto(snapshot) },
        { status: 502 },
      );
    }
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[ProviderBalanceSync] Failed:', error);
    return NextResponse.json({ error: '拉取供应商账户额度失败' }, { status: 500 });
  }
}
