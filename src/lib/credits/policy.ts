import type { Prisma, User } from '@prisma/client';
import { prisma } from '@/lib/prisma';

export const CREDIT_POLICY_KEY = 'credit_policy_v1';
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

export type CreditPolicy = {
  initial_grant: {
    enabled: boolean;
    internal_default: number;
    external_default: number;
    apply_to_self_register: boolean;
    apply_to_feishu_auto_create: boolean;
    apply_to_admin_create_default: boolean;
  };
  daily_quota: {
    enabled: boolean;
    timezone: 'Asia/Shanghai';
    internal_default: number;
    external_default: number;
    profile_overrides: Record<string, number>;
    valid_hours: number;
    clear_unused_on_expire: boolean;
  };
};

export type CreditPolicyUser = Pick<User, 'id' | 'role' | 'account_type' | 'user_profile' | 'status'>;

export type CreditFreezeAllocation = {
  source_type: 'daily_quota' | 'balance';
  amount: number;
  bucket_id?: string;
  quota_date?: string | null;
  expires_at?: string | null;
};

type Tx = Prisma.TransactionClient;

export const DEFAULT_CREDIT_POLICY: CreditPolicy = {
  initial_grant: {
    enabled: true,
    internal_default: 0,
    external_default: 0,
    apply_to_self_register: true,
    apply_to_feishu_auto_create: true,
    apply_to_admin_create_default: true,
  },
  daily_quota: {
    enabled: false,
    timezone: 'Asia/Shanghai',
    internal_default: 0,
    external_default: 0,
    profile_overrides: {
      core_video: 0,
      core_animation: 0,
      core_design: 0,
      noncore_planning: 0,
      noncore_ops: 0,
      noncore_pm: 0,
      other: 0,
    },
    valid_hours: 24,
    clear_unused_on_expire: true,
  },
};

function numberOrZero(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function normalizePolicy(value: unknown): CreditPolicy {
  const input = value && typeof value === 'object' ? value as Partial<CreditPolicy> : {};
  const initial = (input.initial_grant || {}) as Partial<CreditPolicy['initial_grant']>;
  const daily = (input.daily_quota || {}) as Partial<CreditPolicy['daily_quota']>;
  const overrides = daily.profile_overrides && typeof daily.profile_overrides === 'object'
    ? daily.profile_overrides
    : {};

  return {
    initial_grant: {
      enabled: initial.enabled !== false,
      internal_default: numberOrZero(initial.internal_default),
      external_default: numberOrZero(initial.external_default),
      apply_to_self_register: initial.apply_to_self_register !== false,
      apply_to_feishu_auto_create: initial.apply_to_feishu_auto_create !== false,
      apply_to_admin_create_default: initial.apply_to_admin_create_default !== false,
    },
    daily_quota: {
      enabled: daily.enabled === true,
      timezone: 'Asia/Shanghai',
      internal_default: numberOrZero(daily.internal_default),
      external_default: numberOrZero(daily.external_default),
      profile_overrides: {
        ...DEFAULT_CREDIT_POLICY.daily_quota.profile_overrides,
        ...Object.fromEntries(Object.entries(overrides).map(([key, amount]) => [key, numberOrZero(amount)])),
      },
      valid_hours: Math.min(168, Math.max(1, Number(daily.valid_hours) || 24)),
      clear_unused_on_expire: daily.clear_unused_on_expire !== false,
    },
  };
}

export async function getCreditPolicy(client: Tx | typeof prisma = prisma): Promise<CreditPolicy> {
  const setting = await client.platformSetting.findUnique({ where: { key: CREDIT_POLICY_KEY } });
  if (!setting) return DEFAULT_CREDIT_POLICY;

  try {
    return normalizePolicy(JSON.parse(setting.value_json));
  } catch {
    return DEFAULT_CREDIT_POLICY;
  }
}

export async function saveCreditPolicy(policy: CreditPolicy, updatedBy: string) {
  const normalized = normalizePolicy(policy);
  await prisma.platformSetting.upsert({
    where: { key: CREDIT_POLICY_KEY },
    update: {
      value_json: JSON.stringify(normalized),
      updated_by: updatedBy,
    },
    create: {
      key: CREDIT_POLICY_KEY,
      value_json: JSON.stringify(normalized),
      updated_by: updatedBy,
    },
  });
  return normalized;
}

export function resolveInitialGrantAmount(
  policy: CreditPolicy,
  user: Pick<CreditPolicyUser, 'role' | 'account_type'>,
  source: 'self_register' | 'feishu_auto_create' | 'admin_create',
) {
  if (!policy.initial_grant.enabled) return 0;
  if (user.role === 'admin') return 0;
  if (source === 'self_register' && !policy.initial_grant.apply_to_self_register) return 0;
  if (source === 'feishu_auto_create' && !policy.initial_grant.apply_to_feishu_auto_create) return 0;
  if (source === 'admin_create' && !policy.initial_grant.apply_to_admin_create_default) return 0;
  return user.account_type === 'external'
    ? policy.initial_grant.external_default
    : policy.initial_grant.internal_default;
}

function resolveDailyQuotaAmount(policy: CreditPolicy, user: CreditPolicyUser) {
  if (!policy.daily_quota.enabled) return 0;
  if (user.status !== 'active') return 0;
  if (user.role === 'admin') return 0;
  if (user.account_type === 'external') return policy.daily_quota.external_default;
  const override = policy.daily_quota.profile_overrides[user.user_profile || 'other'];
  return override && override > 0 ? override : policy.daily_quota.internal_default;
}

function shanghaiDateKey(now = new Date()) {
  return new Date(now.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

function shanghaiStartUtc(dateKey: string) {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day) - SHANGHAI_OFFSET_MS);
}

function quotaWindow(now = new Date(), validHours = 24) {
  const quotaDate = shanghaiDateKey(now);
  const startsAt = shanghaiStartUtc(quotaDate);
  return {
    quotaDate,
    startsAt,
    expiresAt: new Date(startsAt.getTime() + validHours * 60 * 60 * 1000),
  };
}

async function ensureCreditAccount(tx: Tx, userId: string) {
  return tx.creditAccount.upsert({
    where: { user_id: userId },
    update: {},
    create: {
      user_id: userId,
      balance: 0,
      frozen_credits: 0,
    },
  });
}

async function sumBucketFrozen(tx: Tx, userId: string) {
  const result = await tx.creditBucket.aggregate({
    where: { user_id: userId, frozen_amount: { gt: 0 } },
    _sum: { frozen_amount: true },
  });
  return result._sum.frozen_amount || 0;
}

export async function grantInitialCredits(
  tx: Tx,
  user: Pick<CreditPolicyUser, 'id' | 'role' | 'account_type'>,
  source: 'self_register' | 'feishu_auto_create' | 'admin_create',
  options: { amount?: number; operatorId?: string; reason?: string } = {},
) {
  const policy = await getCreditPolicy(tx);
  const amount = options.amount ?? resolveInitialGrantAmount(policy, user, source);
  if (!Number.isFinite(amount) || amount <= 0) return { amount: 0 };

  const idempotencyKey = `initial_credit:${user.id}`;
  const existing = await tx.creditLedger.findFirst({ where: { idempotency_key: idempotencyKey } });
  if (existing) return { amount: 0, skipped: true };

  const account = await ensureCreditAccount(tx, user.id);
  const balanceAfter = account.balance + amount;

  await tx.creditAccount.update({
    where: { user_id: user.id },
    data: { balance: balanceAfter },
  });

  await tx.creditLedger.create({
    data: {
      user_id: user.id,
      type: 'new_user_initial_grant',
      amount,
      balance_before: account.balance,
      balance_after: balanceAfter,
      frozen_before: account.frozen_credits,
      frozen_after: account.frozen_credits,
      operator_id: options.operatorId || user.id,
      reason: options.reason || '新用户初始点数',
      idempotency_key: idempotencyKey,
      metadata_json: JSON.stringify({
        source,
        policy_key: CREDIT_POLICY_KEY,
        policy_snapshot: policy.initial_grant,
      }),
    },
  });

  await tx.operationLog.create({
    data: {
      operator_id: options.operatorId || user.id,
      action: 'credit_initial_grant',
      target_type: 'User',
      target_id: user.id,
      detail: JSON.stringify({ source, amount, policy_key: CREDIT_POLICY_KEY }),
    },
  });

  return { amount };
}

export async function expireUserCreditBuckets(tx: Tx, userId: string, now = new Date()) {
  const expiredBuckets = await tx.creditBucket.findMany({
    where: {
      user_id: userId,
      source_type: 'daily_quota',
      status: 'active',
      expires_at: { lte: now },
      amount_remaining: { gt: 0 },
    },
    orderBy: { expires_at: 'asc' },
  });
  if (expiredBuckets.length === 0) return;

  const account = await ensureCreditAccount(tx, userId);
  const bucketFrozen = await sumBucketFrozen(tx, userId);
  const totalFrozen = account.frozen_credits + bucketFrozen;

  for (const bucket of expiredBuckets) {
    await tx.creditBucket.update({
      where: { id: bucket.id },
      data: {
        amount_remaining: 0,
        status: bucket.frozen_amount > 0 ? 'expired' : 'expired',
      },
    });

    await tx.creditLedger.create({
      data: {
        user_id: userId,
        type: 'daily_quota_expire',
        amount: -bucket.amount_remaining,
        balance_before: account.balance,
        balance_after: account.balance,
        frozen_before: totalFrozen,
        frozen_after: totalFrozen,
        reason: `每日配额过期清零 ${bucket.amount_remaining} 点`,
        idempotency_key: `daily_quota_expire:${bucket.id}`,
        metadata_json: JSON.stringify({
          bucket_id: bucket.id,
          quota_date: bucket.quota_date,
          expires_at: bucket.expires_at?.toISOString() || null,
        }),
      },
    });
  }
}

export async function ensureDailyQuotaBucket(tx: Tx, user: CreditPolicyUser, now = new Date()) {
  await expireUserCreditBuckets(tx, user.id, now);

  const policy = await getCreditPolicy(tx);
  const amount = resolveDailyQuotaAmount(policy, user);
  if (amount <= 0) return null;

  const { quotaDate, expiresAt } = quotaWindow(now, policy.daily_quota.valid_hours);
  const idempotencyKey = `daily_quota:${user.id}:${quotaDate}`;
  const existing = await tx.creditBucket.findUnique({ where: { idempotency_key: idempotencyKey } });
  if (existing) return existing;

  const account = await ensureCreditAccount(tx, user.id);
  const bucket = await tx.creditBucket.create({
    data: {
      user_id: user.id,
      source_type: 'daily_quota',
      amount_total: amount,
      amount_remaining: amount,
      frozen_amount: 0,
      quota_date: quotaDate,
      expires_at: expiresAt,
      status: 'active',
      policy_key: CREDIT_POLICY_KEY,
      policy_snapshot: JSON.stringify(policy.daily_quota),
      idempotency_key: idempotencyKey,
      metadata_json: JSON.stringify({ account_type: user.account_type, user_profile: user.user_profile }),
    },
  });

  const bucketFrozen = await sumBucketFrozen(tx, user.id);
  await tx.creditLedger.create({
    data: {
      user_id: user.id,
      type: 'daily_quota_grant',
      amount,
      balance_before: account.balance,
      balance_after: account.balance,
      frozen_before: account.frozen_credits + bucketFrozen,
      frozen_after: account.frozen_credits + bucketFrozen,
      reason: `每日配额发放 ${amount} 点`,
      idempotency_key: `daily_quota_grant:${bucket.id}`,
      metadata_json: JSON.stringify({
        bucket_id: bucket.id,
        quota_date: quotaDate,
        expires_at: expiresAt.toISOString(),
        policy_key: CREDIT_POLICY_KEY,
        policy_snapshot: policy.daily_quota,
      }),
    },
  });

  return bucket;
}

export async function getCreditSummary(tx: Tx, user: CreditPolicyUser, now = new Date()) {
  await ensureDailyQuotaBucket(tx, user, now);
  const account = await ensureCreditAccount(tx, user.id);
  const buckets = await tx.creditBucket.findMany({
    where: {
      user_id: user.id,
      source_type: 'daily_quota',
      status: 'active',
      OR: [{ expires_at: null }, { expires_at: { gt: now } }],
    },
  });
  const dailyRemaining = buckets.reduce((total, bucket) => total + bucket.amount_remaining, 0);
  const dailyFrozen = buckets.reduce((total, bucket) => total + bucket.frozen_amount, 0);
  const longAvailable = Math.max(0, account.balance - account.frozen_credits);

  return {
    account,
    daily_remaining: dailyRemaining,
    daily_frozen: dailyFrozen,
    daily_total: buckets.reduce((total, bucket) => total + bucket.amount_total, 0),
    daily_expires_at: buckets
      .map((bucket) => bucket.expires_at)
      .filter((value): value is Date => Boolean(value))
      .sort((a, b) => a.getTime() - b.getTime())[0] || null,
    long_available: longAvailable,
    available: longAvailable + dailyRemaining,
    frozen_credits: account.frozen_credits + dailyFrozen,
  };
}

export async function allocateTaskCredits(
  tx: Tx,
  user: CreditPolicyUser,
  amount: number,
  taskId: string,
) {
  await ensureDailyQuotaBucket(tx, user);
  const account = await ensureCreditAccount(tx, user.id);
  const now = new Date();
  const activeBuckets = await tx.creditBucket.findMany({
    where: {
      user_id: user.id,
      source_type: 'daily_quota',
      status: 'active',
      amount_remaining: { gt: 0 },
      OR: [{ expires_at: null }, { expires_at: { gt: now } }],
    },
    orderBy: [{ expires_at: 'asc' }, { created_at: 'asc' }],
  });

  const bucketFrozenBefore = await sumBucketFrozen(tx, user.id);
  const totalFrozenBefore = account.frozen_credits + bucketFrozenBefore;
  let remaining = amount;
  const allocations: CreditFreezeAllocation[] = [];

  for (const bucket of activeBuckets) {
    if (remaining <= 0) break;
    const used = Math.min(bucket.amount_remaining, remaining);
    if (used <= 0) continue;

    await tx.creditBucket.update({
      where: { id: bucket.id },
      data: {
        amount_remaining: bucket.amount_remaining - used,
        frozen_amount: bucket.frozen_amount + used,
      },
    });

    allocations.push({
      source_type: 'daily_quota',
      bucket_id: bucket.id,
      amount: used,
      quota_date: bucket.quota_date,
      expires_at: bucket.expires_at?.toISOString() || null,
    });
    remaining -= used;
  }

  const longAvailable = account.balance - account.frozen_credits;
  if (remaining > longAvailable) {
    throw new Error(`点数不足，需要 ${amount} 点，当前可用 ${Math.floor(amount - remaining + Math.max(0, longAvailable))} 点`);
  }

  if (remaining > 0) {
    await tx.creditAccount.update({
      where: { user_id: user.id },
      data: { frozen_credits: account.frozen_credits + remaining },
    });
    allocations.push({ source_type: 'balance', amount: remaining });
  }

  const totalFrozenAfter = totalFrozenBefore + amount;
  return {
    allocations,
    balance_before: account.balance,
    balance_after: account.balance,
    frozen_before: totalFrozenBefore,
    frozen_after: totalFrozenAfter,
    snapshot: JSON.stringify(allocations),
  };
}

function parseFreezeSnapshot(value: string | null | undefined, fallbackAmount: number): CreditFreezeAllocation[] {
  if (value) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed
          .map((item) => ({
            source_type: item?.source_type === 'daily_quota' ? 'daily_quota' as const : 'balance' as const,
            bucket_id: typeof item?.bucket_id === 'string' ? item.bucket_id : undefined,
            amount: Number(item?.amount) || 0,
            quota_date: typeof item?.quota_date === 'string' ? item.quota_date : null,
            expires_at: typeof item?.expires_at === 'string' ? item.expires_at : null,
          }))
          .filter((item) => item.amount > 0);
      }
    } catch {
      // Fall back to legacy balance settlement below.
    }
  }
  return fallbackAmount > 0 ? [{ source_type: 'balance', amount: fallbackAmount }] : [];
}

export async function settleTaskCredits(
  tx: Tx,
  input: {
    taskId: string;
    userId: string;
    terminalStatus: string;
    frozenAmount: number;
    freezeSnapshot?: string | null;
  },
) {
  const account = await ensureCreditAccount(tx, input.userId);
  const allocations = parseFreezeSnapshot(input.freezeSnapshot, input.frozenAmount);
  const bucketFrozenBefore = await sumBucketFrozen(tx, input.userId);
  const totalFrozenBefore = account.frozen_credits + bucketFrozenBefore;
  const now = new Date();
  const succeeded = input.terminalStatus === 'succeeded';

  let longAmount = 0;
  let refundedAmount = 0;
  let expiredClosedAmount = 0;
  let bucketReleasedAmount = 0;

  for (const allocation of allocations) {
    if (allocation.source_type === 'balance') {
      longAmount += allocation.amount;
      if (!succeeded) refundedAmount += allocation.amount;
      continue;
    }

    if (!allocation.bucket_id) continue;
    const bucket = await tx.creditBucket.findUnique({ where: { id: allocation.bucket_id } });
    if (!bucket) continue;

    const release = Math.min(bucket.frozen_amount, allocation.amount);
    bucketReleasedAmount += release;
    const isStillUsable = bucket.status === 'active' && (!bucket.expires_at || bucket.expires_at > now);
    const nextFrozen = Math.max(0, bucket.frozen_amount - release);
    const nextRemaining = !succeeded && isStillUsable
      ? bucket.amount_remaining + release
      : bucket.amount_remaining;

    if (!succeeded && isStillUsable) refundedAmount += release;
    if (!succeeded && !isStillUsable) expiredClosedAmount += release;

    await tx.creditBucket.update({
      where: { id: bucket.id },
      data: {
        frozen_amount: nextFrozen,
        amount_remaining: nextRemaining,
        status: nextFrozen <= 0 && nextRemaining <= 0
          ? (bucket.expires_at && bucket.expires_at <= now ? 'expired' : 'exhausted')
          : bucket.status,
      },
    });
  }

  const totalAmount = allocations.reduce((total, item) => total + item.amount, 0);
  const longFrozenAfter = Math.max(0, account.frozen_credits - longAmount);
  const balanceAfter = succeeded ? account.balance - longAmount : account.balance;
  const bucketFrozenAfter = Math.max(0, bucketFrozenBefore - bucketReleasedAmount);
  const totalFrozenAfter = longFrozenAfter + bucketFrozenAfter;

  await tx.creditAccount.update({
    where: { user_id: input.userId },
    data: succeeded
      ? {
          balance: balanceAfter,
          frozen_credits: longFrozenAfter,
          monthly_used: account.monthly_used + totalAmount,
          total_used: account.total_used + totalAmount,
        }
      : { frozen_credits: longFrozenAfter },
  });

  if (expiredClosedAmount > 0) {
    await tx.creditLedger.create({
      data: {
        user_id: input.userId,
        type: 'expired_refund_closed',
        amount: -expiredClosedAmount,
        balance_before: account.balance,
        balance_after: balanceAfter,
        frozen_before: totalFrozenBefore,
        frozen_after: totalFrozenAfter,
        related_task_id: input.taskId,
        reason: `任务失败时每日配额已过期，关闭 ${expiredClosedAmount} 点返还`,
        metadata_json: JSON.stringify({ allocations }),
      },
    });
  }

  return {
    actualCost: succeeded ? totalAmount : 0,
    refundedAmount,
    expiredClosedAmount,
    balanceBefore: account.balance,
    balanceAfter,
    frozenBefore: totalFrozenBefore,
    frozenAfter: totalFrozenAfter,
    allocations,
  };
}
