import crypto from 'crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { PricingSnapshot } from '@/lib/pricing';

type LedgerClient = Prisma.TransactionClient;

export type CostTaskSnapshot = {
  id: string;
  user_id: string | null;
  owner_user_id?: string | null;
  project_id: string | null;
  provider: string;
  provider_task_id?: string | null;
  model: string;
  resolution?: string | null;
  duration?: number | null;
  estimated_cost?: number | null;
  pricing_rule_id?: string | null;
  pricing_snapshot?: string | null;
};

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, current) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return current;
    return Object.keys(current as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = (current as Record<string, unknown>)[key];
        return acc;
      }, {});
  });
}

function hashPayload(payload: unknown) {
  return crypto.createHash('sha256').update(stableJson(payload)).digest('hex');
}

function providerName(task: Pick<CostTaskSnapshot, 'provider'>) {
  return task.provider || 'seedance';
}

export function officialChargeIdempotencyKey(provider: string | null | undefined, officialChargeId: string) {
  return `official_charge:${provider || 'seedance'}:${officialChargeId.trim()}`;
}

function costSnapshot(task: CostTaskSnapshot, pricing?: PricingSnapshot | null) {
  return {
    provider: providerName(task),
    model: pricing?.model || task.model,
    resolution: pricing?.resolution || task.resolution || null,
    duration: pricing?.duration || task.duration || null,
    internalCreditEstimate: pricing?.estimatedCost ?? task.estimated_cost ?? null,
    pricingRuleId: pricing?.pricingRuleId || task.pricing_rule_id || null,
    pricingRuleVersion: pricing?.pricingRuleVersion || null,
    formula: pricing?.formula || null,
    officialCharge: {
      status: 'pending_official_charge',
      amountMinor: null,
      currency: null,
    },
  };
}

async function ensureDefaultAllocation(
  tx: LedgerClient,
  ledgerId: string,
  task: CostTaskSnapshot,
  usageQuantity: number | null,
  reason: string,
  createdBy?: string | null,
) {
  const existing = await tx.costAllocation.findFirst({ where: { ledger_id: ledgerId } });
  if (existing) return existing;

  const allocationType = task.project_id ? 'project' : 'unallocated';
  const allocationId = task.project_id || 'unallocated';

  return tx.costAllocation.create({
    data: {
      ledger_id: ledgerId,
      allocation_type: allocationType,
      allocation_id: allocationId,
      task_id: task.id,
      user_id: task.user_id || task.owner_user_id || null,
      project_id: task.project_id,
      usage_quantity: usageQuantity,
      usage_unit: usageQuantity === null ? null : 'video_second',
      reason,
      created_by: createdBy || null,
    },
  });
}

export async function recordTaskCostEstimate(
  tx: LedgerClient,
  task: CostTaskSnapshot,
  pricing?: PricingSnapshot | null,
  createdBy?: string | null,
) {
  const snapshot = costSnapshot(task, pricing);
  const duration = pricing?.duration || task.duration || null;
  const idempotencyKey = `task:${task.id}:cost_estimate:v1`;

  const ledger = await tx.costLedger.upsert({
    where: { idempotency_key: idempotencyKey },
    update: {},
    create: {
      source_type: 'task',
      source_id: task.id,
      task_id: task.id,
      user_id: task.user_id || task.owner_user_id || null,
      project_id: task.project_id,
      provider_name: providerName(task),
      provider_task_id: task.provider_task_id || null,
      event_type: 'estimate',
      usage_quantity: duration,
      usage_unit: duration === null ? null : 'video_second',
      cost_source: 'rule',
      confidence: 'estimated',
      pricing_rule_id: pricing?.pricingRuleId || task.pricing_rule_id || null,
      pricing_snapshot: JSON.stringify(snapshot),
      reason: '任务创建时记录供应商成本预估，等待官方实际扣费确认',
      idempotency_key: idempotencyKey,
      created_by: createdBy || null,
    },
  });

  await ensureDefaultAllocation(tx, ledger.id, task, duration, '成本预估归属到任务当前项目', createdBy);

  await tx.videoTask.update({
    where: { id: task.id },
    data: {
      provider_cost_status: 'estimated_by_rule',
      provider_cost_snapshot: JSON.stringify(snapshot),
      cost_allocation_status: task.project_id ? 'allocated' : 'unallocated',
    },
  });

  return ledger;
}

export async function createProviderApiRequest(params: {
  task: CostTaskSnapshot;
  endpoint: string;
  method?: string;
  idempotencyKey?: string | null;
  requestPayload?: unknown;
}) {
  return prisma.providerApiRequest.create({
    data: {
      task_id: params.task.id,
      user_id: params.task.user_id || params.task.owner_user_id || null,
      project_id: params.task.project_id,
      provider_name: providerName(params.task),
      endpoint: params.endpoint,
      method: params.method || 'POST',
      idempotency_key: params.idempotencyKey || null,
      request_hash: params.requestPayload ? hashPayload(params.requestPayload) : null,
      status: 'pending',
    },
  });
}

export async function markProviderApiRequestAccepted(params: {
  requestId: string;
  task: CostTaskSnapshot;
  providerTaskId?: string | null;
  responseSummary?: unknown;
}) {
  await prisma.$transaction(async (tx) => {
    await tx.providerApiRequest.update({
      where: { id: params.requestId },
      data: {
        provider_task_id: params.providerTaskId || null,
        status: 'accepted',
        response_summary_json: params.responseSummary ? JSON.stringify(params.responseSummary) : null,
        completed_at: new Date(),
      },
    });

    const idempotencyKey = `provider_request:${params.requestId}:submitted:v1`;
    await tx.costLedger.upsert({
      where: { idempotency_key: idempotencyKey },
      update: {},
      create: {
        source_type: 'provider_request',
        source_id: params.requestId,
        task_id: params.task.id,
        user_id: params.task.user_id || params.task.owner_user_id || null,
        project_id: params.task.project_id,
        provider_request_id: params.requestId,
        provider_name: providerName(params.task),
        provider_task_id: params.providerTaskId || null,
        event_type: 'provider_request_submitted',
        cost_source: 'rule',
        confidence: 'unknown',
        reason: '外部生成请求已被供应商接受，等待任务完成和官方扣费',
        idempotency_key: idempotencyKey,
      },
    });
  });
}

export async function markProviderApiRequestFailed(params: {
  requestId: string;
  errorCode?: string | null;
  errorMessage?: string | null;
}) {
  await prisma.providerApiRequest.update({
    where: { id: params.requestId },
    data: {
      status: 'failed',
      error_code: params.errorCode || null,
      error_message: params.errorMessage || null,
      completed_at: new Date(),
    },
  });
}

export async function recordTaskCostSettlement(
  tx: LedgerClient,
  task: CostTaskSnapshot,
  terminalStatus: string,
  createdBy?: string | null,
) {
  const succeeded = terminalStatus === 'succeeded';
  const acceptedByProvider = Boolean(task.provider_task_id);
  const duration = task.duration || null;
  const idempotencyKey = `task:${task.id}:cost_${terminalStatus}:v1`;
  const confidence = succeeded ? 'provisional' : (acceptedByProvider ? 'unknown' : 'confirmed');
  const eventType = succeeded ? 'rule_settlement' : (acceptedByProvider ? 'failed_cost_unknown' : 'failed_no_charge');

  const ledger = await tx.costLedger.upsert({
    where: { idempotency_key: idempotencyKey },
    update: {},
    create: {
      source_type: 'task',
      source_id: task.id,
      task_id: task.id,
      user_id: task.user_id || task.owner_user_id || null,
      project_id: task.project_id,
      provider_name: providerName(task),
      provider_task_id: task.provider_task_id || null,
      event_type: eventType,
      usage_quantity: duration,
      usage_unit: duration === null ? null : 'video_second',
      cost_source: 'rule',
      confidence,
      pricing_rule_id: task.pricing_rule_id || null,
      pricing_snapshot: task.pricing_snapshot || null,
      reason: succeeded
        ? '任务成功，按内部规则先做临时成本结算，等待官方实际扣费'
        : acceptedByProvider
          ? '任务失败但供应商已接受请求，官方是否收费待确认'
          : '任务失败且未获得供应商任务，暂按未收费处理',
      idempotency_key: idempotencyKey,
      created_by: createdBy || null,
    },
  });

  await ensureDefaultAllocation(
    tx,
    ledger.id,
    task,
    duration,
    succeeded ? '规则临时成本归属到任务当前项目' : '失败成本状态归属到任务当前项目',
    createdBy,
  );

  await tx.videoTask.update({
    where: { id: task.id },
    data: {
      provider_cost_status: succeeded ? 'provisional_settled' : (acceptedByProvider ? 'unknown' : 'failed_no_charge'),
      cost_allocation_status: task.project_id ? 'allocated' : 'unallocated',
    },
  });

  return ledger;
}

export async function recordTaskProjectTransfer(
  tx: LedgerClient,
  task: CostTaskSnapshot & {
    provider_official_amount_minor?: number | null;
    provider_final_amount_minor?: number | null;
    provider_cost_currency?: string | null;
  },
  fromProjectId: string | null,
  toProjectId: string,
  reason: string,
  createdBy?: string | null,
) {
  if (fromProjectId === toProjectId) return null;

  const usageQuantity = task.duration || null;
  const amountMinor = task.provider_final_amount_minor ?? task.provider_official_amount_minor ?? null;
  const currency = task.provider_cost_currency || null;
  const transferId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const idempotencyKey = `task:${task.id}:project_transfer:${fromProjectId || 'unallocated'}:${toProjectId}:${transferId}`;

  const ledger = await tx.costLedger.create({
    data: {
      source_type: 'transfer',
      source_id: task.id,
      task_id: task.id,
      user_id: task.user_id || task.owner_user_id || null,
      project_id: toProjectId,
      provider_name: providerName(task),
      provider_task_id: task.provider_task_id || null,
      event_type: 'allocation_transfer',
      amount_minor: amountMinor,
      currency,
      usage_quantity: usageQuantity,
      usage_unit: usageQuantity === null ? null : 'video_second',
      cost_source: 'manual',
      confidence: amountMinor === null ? 'estimated' : 'confirmed',
      pricing_rule_id: task.pricing_rule_id || null,
      pricing_snapshot: task.pricing_snapshot || null,
      reason,
      idempotency_key: idempotencyKey,
      created_by: createdBy || null,
    },
  });

  await tx.costAllocation.createMany({
    data: [
      {
        ledger_id: ledger.id,
        allocation_type: fromProjectId ? 'project' : 'unallocated',
        allocation_id: fromProjectId || 'unallocated',
        task_id: task.id,
        user_id: task.user_id || task.owner_user_id || null,
        project_id: fromProjectId,
        amount_minor: amountMinor === null ? null : -amountMinor,
        currency,
        usage_quantity: usageQuantity === null ? null : -usageQuantity,
        usage_unit: usageQuantity === null ? null : 'video_second',
        reason: `移出项目：${reason}`,
        created_by: createdBy || null,
      },
      {
        ledger_id: ledger.id,
        allocation_type: 'project',
        allocation_id: toProjectId,
        task_id: task.id,
        user_id: task.user_id || task.owner_user_id || null,
        project_id: toProjectId,
        amount_minor: amountMinor,
        currency,
        usage_quantity: usageQuantity,
        usage_unit: usageQuantity === null ? null : 'video_second',
        reason: `移入项目：${reason}`,
        created_by: createdBy || null,
      },
    ],
  });

  return ledger;
}

export async function recordTaskOfficialCharge(
  tx: LedgerClient,
  task: CostTaskSnapshot,
  params: {
    amountMinor: number;
    currency: string;
    officialChargeId: string;
    reason?: string | null;
    createdBy?: string | null;
    occurredAt?: Date;
  },
) {
  const currency = params.currency.trim().toUpperCase();
  const officialChargeId = params.officialChargeId.trim();
  const provider = providerName(task);
  const usageQuantity = task.duration || null;
  const idempotencyKey = officialChargeIdempotencyKey(provider, officialChargeId);

  const existing = await tx.costLedger.findUnique({
    where: { idempotency_key: idempotencyKey },
    include: { allocations: true },
  });

  if (existing) {
    if (existing.task_id && existing.task_id !== task.id) {
      throw new Error('官方扣费 ID 已关联其他任务，不能重复用于当前任务');
    }
    return { ledger: existing, deduplicated: true };
  }

  const ledger = await tx.costLedger.create({
    data: {
      source_type: 'official_bill',
      source_id: officialChargeId,
      task_id: task.id,
      user_id: task.user_id || task.owner_user_id || null,
      project_id: task.project_id,
      provider_name: provider,
      provider_task_id: task.provider_task_id || null,
      event_type: 'official_charge',
      amount_minor: params.amountMinor,
      currency,
      usage_quantity: usageQuantity,
      usage_unit: usageQuantity === null ? null : 'video_second',
      cost_source: 'official_bill',
      confidence: 'confirmed',
      pricing_rule_id: task.pricing_rule_id || null,
      pricing_snapshot: task.pricing_snapshot || null,
      official_charge_id: officialChargeId,
      reason: params.reason || '录入官方实际扣费',
      idempotency_key: idempotencyKey,
      occurred_at: params.occurredAt || new Date(),
      created_by: params.createdBy || null,
    },
  });

  await tx.costAllocation.create({
    data: {
      ledger_id: ledger.id,
      allocation_type: task.project_id ? 'project' : 'unallocated',
      allocation_id: task.project_id || 'unallocated',
      task_id: task.id,
      user_id: task.user_id || task.owner_user_id || null,
      project_id: task.project_id,
      amount_minor: params.amountMinor,
      currency,
      usage_quantity: usageQuantity,
      usage_unit: usageQuantity === null ? null : 'video_second',
      reason: task.project_id ? '官方扣费归属到任务当前项目' : '任务暂无项目归属，官方扣费暂未归属',
      created_by: params.createdBy || null,
    },
  });

  await tx.videoTask.update({
    where: { id: task.id },
    data: {
      provider_official_amount_minor: params.amountMinor,
      provider_final_amount_minor: params.amountMinor,
      provider_cost_currency: currency,
      provider_cost_status: 'official_confirmed',
      provider_cost_confirmed_at: params.occurredAt || new Date(),
      cost_allocation_status: task.project_id ? 'allocated' : 'unallocated',
    },
  });

  return { ledger, deduplicated: false };
}
