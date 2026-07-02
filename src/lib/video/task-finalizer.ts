import type { Prisma, VideoTask } from '@prisma/client';
import { prisma } from '../prisma';
import { normalizeProviderErrorMessage } from '../provider/error-message';
import { getProviderTaskStatus } from '../provider/video-task-status';
import { recordProviderReportedCharge, recordTaskCostSettlement } from '../costs/ledger';
import { settleTaskCredits } from '../credits/policy';
import { settleProjectTaskBudget } from '../projects/budget';
import { cacheTaskVideoToLocal, type LocalVideoCacheResult } from './local-cache';
import { ensureTaskThumbnail, type EnsureTaskThumbnailResult } from './thumbnail';
import { ensurePublicVideoDelivery, type PublicVideoDeliveryResult } from './public-delivery';

const TERMINAL_LOCAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);
const FINAL_PROVIDER_COST_STATUSES = new Set(['official_confirmed', 'reconciled', 'failed_no_charge']);
const MAX_LOCAL_CACHE_CONCURRENCY = 3;

let activeLocalCacheJobs = 0;
const localCacheWaiters: Array<() => void> = [];

type ProviderCostCacheableTask = {
  local_status: string | null;
  provider_cost_status: string | null;
  provider_cost_currency: string | null;
  provider_official_amount_minor: number | null;
  provider_final_amount_minor: number | null;
  provider_official_amount_micros: number | null;
  provider_final_amount_micros: number | null;
};

type ProviderBillingStatus = {
  provider_task_id?: string | null;
  usage?: unknown;
  actual_cost?: number | string | null;
  currency_or_credit_type?: string | null;
  billing_status?: string | null;
  billing_time?: number | string | null;
  client_request_id?: string | null;
  raw?: unknown;
};

export type FinalizeVideoTaskOptions = {
  forceProviderRefresh?: boolean;
  cacheOnSuccess?: boolean;
  generateThumbnail?: boolean;
  cacheTimeoutMs?: number;
  createdBy?: string | null;
};

export type FinalizeVideoTaskResult = {
  task: VideoTask | null;
  statusRefreshed: boolean;
  terminal: boolean;
  cacheResult?: LocalVideoCacheResult;
  thumbnailResult?: EnsureTaskThumbnailResult;
  publicDeliveryResult?: PublicVideoDeliveryResult;
  providerError?: string;
  skippedReason?: string;
};

export function isTerminalLocalStatus(status: string | null) {
  return TERMINAL_LOCAL_STATUSES.has(status || '');
}

function hasPersistedProviderCharge(task: ProviderCostCacheableTask) {
  if (!task.provider_cost_currency) return false;
  return (
    task.provider_official_amount_minor !== null ||
    task.provider_final_amount_minor !== null ||
    task.provider_official_amount_micros !== null ||
    task.provider_final_amount_micros !== null
  );
}

function shouldReadLocalFinalCost(task: ProviderCostCacheableTask, forceProviderRefresh: boolean) {
  if (forceProviderRefresh) return false;
  if (!isTerminalLocalStatus(task.local_status)) return false;
  if (FINAL_PROVIDER_COST_STATUSES.has(task.provider_cost_status || '')) return true;
  return hasPersistedProviderCharge(task);
}

function normalizeCurrency(value: unknown) {
  if (typeof value !== 'string') return null;
  const currency = value.trim().toUpperCase();
  if (!currency) return null;
  if (!/^[A-Z0-9_-]{2,32}$/.test(currency)) return null;
  return currency;
}

function parseJsonRecord(value: string | null | undefined) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function normalizeActualCost(value: unknown) {
  const amount = typeof value === 'number'
    ? value
    : (typeof value === 'string' && value.trim() ? Number(value) : NaN);
  if (!Number.isFinite(amount) || amount < 0) return null;
  return amount;
}

function toAmountMicros(actualCost: number) {
  return Math.round(actualCost * 1_000_000);
}

function normalizeBillingTime(value: unknown) {
  const numericValue = typeof value === 'number'
    ? value
    : (typeof value === 'string' && value.trim() ? Number(value.trim()) : NaN);
  if (!Number.isFinite(numericValue) || numericValue <= 0) return null;
  return Math.floor(numericValue);
}

function billingTimeToDate(value: number | null) {
  if (!value) return null;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

function stringifySnapshot(value: unknown) {
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function addProviderBillingUpdate(
  updateData: Prisma.VideoTaskUncheckedUpdateInput,
  statusResult: ProviderBillingStatus,
) {
  const currency = normalizeCurrency(statusResult.currency_or_credit_type);
  const actualCost = normalizeActualCost(statusResult.actual_cost);
  const billingTime = normalizeBillingTime(statusResult.billing_time);
  const amountMicros = actualCost === null ? null : toAmountMicros(actualCost);

  if (statusResult.usage !== undefined) {
    updateData.provider_usage_snapshot = stringifySnapshot(statusResult.usage);
  }
  if (statusResult.billing_status) {
    updateData.provider_billing_status = statusResult.billing_status;
  }
  if (billingTime !== null) {
    updateData.provider_billing_time = billingTimeToDate(billingTime);
  }
  if (statusResult.client_request_id) {
    updateData.provider_client_request_id = statusResult.client_request_id;
  }
  if (currency) {
    updateData.provider_cost_currency = currency;
  }
  if (amountMicros !== null) {
    updateData.provider_official_amount_micros = amountMicros;
    updateData.provider_final_amount_micros = amountMicros;
  }
}

function buildProviderReportedCharge(statusResult: ProviderBillingStatus) {
  const actualCost = normalizeActualCost(statusResult.actual_cost);
  const currency = normalizeCurrency(statusResult.currency_or_credit_type);
  if (actualCost === null || !currency) return null;

  const billingStatus = typeof statusResult.billing_status === 'string'
    ? statusResult.billing_status
    : null;
  const billingTime = normalizeBillingTime(statusResult.billing_time);
  const clientRequestId = typeof statusResult.client_request_id === 'string'
    ? statusResult.client_request_id
    : null;
  const providerTaskId = typeof statusResult.provider_task_id === 'string'
    ? statusResult.provider_task_id
    : null;
  const billingDate = billingTimeToDate(billingTime);

  return {
    actualCost,
    currency,
    billingStatus,
    billingTime: billingDate ?? billingTime,
    usage: statusResult.usage,
    clientRequestId,
    providerTaskId,
    raw: statusResult.raw,
  };
}

async function recordOfficialProviderCharge(
  taskId: string,
  createdBy: string | null | undefined,
  statusResult: ProviderBillingStatus,
) {
  const charge = buildProviderReportedCharge(statusResult);
  if (!charge) return;

  await prisma.$transaction(async (tx) => {
    const freshTask = await tx.videoTask.findUnique({ where: { id: taskId } });
    if (!freshTask) return;

    await recordProviderReportedCharge(tx, freshTask, charge, createdBy || null);
  });
}

export async function settleTask(
  taskId: string,
  userId: string,
  frozenAmount: number,
  terminalStatus: string,
) {
  await prisma.$transaction(async (tx) => {
    const freshTask = await tx.videoTask.findUnique({ where: { id: taskId } });
    if (!freshTask || !freshTask.frozen_cost || freshTask.frozen_cost <= 0) return;

    if (freshTask.billing_scope === 'project' && freshTask.project_id) {
      const existingProjectSettlement = await tx.projectBudgetLedger.findUnique({
        where: { idempotency_key: `project_budget_settle:${taskId}` },
      });
      if (existingProjectSettlement) return;

      const settlement = await settleProjectTaskBudget(tx, {
        projectId: freshTask.project_id,
        taskId,
        terminalStatus,
        frozenAmount,
        freezeSnapshot: freshTask.credit_freeze_snapshot,
        operatorId: userId,
      });

      const settledTask = await tx.videoTask.update({
        where: { id: taskId },
        data: terminalStatus === 'succeeded'
          ? { frozen_cost: 0, actual_cost: settlement.actualCost }
          : { frozen_cost: 0, actual_cost: 0, refund_amount: settlement.refundedAmount },
      });

      await recordTaskCostSettlement(tx, settledTask, terminalStatus, userId);
      return;
    }

    const existingSettlement = await tx.creditLedger.findFirst({
      where: {
        related_task_id: taskId,
        type: { in: ['task_success_deduct', 'task_failed_refund'] },
      },
    });
    if (existingSettlement) return;

    const settlement = await settleTaskCredits(tx, {
      taskId,
      userId,
      terminalStatus,
      frozenAmount,
      freezeSnapshot: freshTask.credit_freeze_snapshot,
    });

    if (terminalStatus === 'succeeded') {
      const settledTask = await tx.videoTask.update({
        where: { id: taskId },
        data: { frozen_cost: 0, actual_cost: settlement.actualCost },
      });

      await tx.creditLedger.create({
        data: {
          user_id: userId,
          type: 'task_success_deduct',
          amount: -settlement.actualCost,
          balance_before: settlement.balanceBefore,
          balance_after: settlement.balanceAfter,
          frozen_before: settlement.frozenBefore,
          frozen_after: settlement.frozenAfter,
          related_task_id: taskId,
          reason: `任务成功，扣除 ${settlement.actualCost} 点`,
          metadata_json: JSON.stringify({
            allocations: settlement.allocations,
            source_metadata: parseJsonRecord(freshTask.source_metadata_json),
          }),
        },
      });

      await recordTaskCostSettlement(tx, settledTask, terminalStatus, userId);
    } else {
      const settledTask = await tx.videoTask.update({
        where: { id: taskId },
        data: { frozen_cost: 0, actual_cost: 0, refund_amount: settlement.refundedAmount },
      });

      await tx.creditLedger.create({
        data: {
          user_id: userId,
          type: 'task_failed_refund',
          amount: settlement.refundedAmount,
          balance_before: settlement.balanceBefore,
          balance_after: settlement.balanceAfter,
          frozen_before: settlement.frozenBefore,
          frozen_after: settlement.frozenAfter,
          related_task_id: taskId,
          reason: `任务${terminalStatus === 'failed' ? '失败' : '取消'}，返还冻结 ${settlement.refundedAmount} 点`,
          metadata_json: JSON.stringify({
            allocations: settlement.allocations,
            expired_closed: settlement.expiredClosedAmount,
            source_metadata: parseJsonRecord(freshTask.source_metadata_json),
          }),
        },
      });

      await recordTaskCostSettlement(tx, settledTask, terminalStatus, userId);
    }
  });
}

async function withLocalCacheSlot<T>(callback: () => Promise<T>) {
  if (activeLocalCacheJobs >= MAX_LOCAL_CACHE_CONCURRENCY) {
    await new Promise<void>((resolve) => {
      localCacheWaiters.push(resolve);
    });
  }

  activeLocalCacheJobs += 1;
  try {
    return await callback();
  } finally {
    activeLocalCacheJobs -= 1;
    const nextWaiter = localCacheWaiters.shift();
    if (nextWaiter) nextWaiter();
  }
}

async function cacheAndMaybeThumbnail(
  task: VideoTask,
  options: Required<Pick<FinalizeVideoTaskOptions, 'cacheOnSuccess' | 'generateThumbnail'>>
    & Pick<FinalizeVideoTaskOptions, 'cacheTimeoutMs'>,
) {
  let cacheResult: LocalVideoCacheResult | undefined;
  let thumbnailResult: EnsureTaskThumbnailResult | undefined;
  let publicDeliveryResult: PublicVideoDeliveryResult | undefined;
  let taskForThumbnail = task;

  if (options.cacheOnSuccess && task.local_status === 'succeeded' && (task.result_video_url || task.local_video_path)) {
    cacheResult = await withLocalCacheSlot(() => cacheTaskVideoToLocal({
      id: task.id,
      provider: task.provider,
      local_status: task.local_status,
      provider_task_id: task.provider_task_id,
      result_video_url: task.result_video_url,
      result_last_frame_url: task.result_last_frame_url,
      local_video_path: task.local_video_path,
    }, { timeoutMs: options.cacheTimeoutMs }));

    if (cacheResult.success && cacheResult.local_video_path) {
      taskForThumbnail = {
        ...task,
        local_video_path: cacheResult.local_video_path,
        result_video_url: cacheResult.result_video_url || task.result_video_url,
        result_last_frame_url: cacheResult.result_last_frame_url || task.result_last_frame_url,
      };

      publicDeliveryResult = await ensurePublicVideoDelivery({
        ...taskForThumbnail,
        public_video_url: task.public_video_url,
        public_video_storage_provider: task.public_video_storage_provider,
        public_video_storage_key: task.public_video_storage_key,
        public_video_file_size: task.public_video_file_size,
        public_video_cached_at: task.public_video_cached_at,
      });
      if (!publicDeliveryResult.success) {
        console.warn('[VideoFinalizer] Public video delivery not ready:', {
          taskId: task.id,
          storageProvider: publicDeliveryResult.storage_provider,
          fallback: publicDeliveryResult.fallback ?? false,
          skipped: publicDeliveryResult.skipped ?? false,
          error: publicDeliveryResult.error,
          message: publicDeliveryResult.message,
        });
      }
    } else {
      console.warn('[VideoFinalizer] Local cache skipped:', {
        taskId: task.id,
        error: cacheResult.error,
        status: cacheResult.status,
      });
    }
  }

  if (options.generateThumbnail && taskForThumbnail.local_status === 'succeeded') {
    thumbnailResult = await ensureTaskThumbnail(taskForThumbnail, { allowRemoteFallback: false });
    if (!thumbnailResult.success) {
      console.warn('[VideoFinalizer] Thumbnail skipped:', {
        taskId: task.id,
        error: thumbnailResult.error,
      });
    }
  }

  return { cacheResult, thumbnailResult, publicDeliveryResult };
}

export async function finalizeVideoTaskStatus(
  taskId: string,
  options: FinalizeVideoTaskOptions = {},
): Promise<FinalizeVideoTaskResult> {
  const forceProviderRefresh = options.forceProviderRefresh === true;
  const cacheOnSuccess = options.cacheOnSuccess !== false;
  const generateThumbnail = options.generateThumbnail !== false;
  const cacheTimeoutMs = options.cacheTimeoutMs;
  const task = await prisma.videoTask.findUnique({ where: { id: taskId } });

  if (!task) {
    return {
      task: null,
      statusRefreshed: false,
      terminal: false,
      skippedReason: 'task_not_found',
    };
  }

  if (!task.provider_task_id) {
    return {
      task,
      statusRefreshed: false,
      terminal: isTerminalLocalStatus(task.local_status),
      skippedReason: 'missing_provider_task_id',
    };
  }

  if (shouldReadLocalFinalCost(task, forceProviderRefresh)) {
    const localResult = await cacheAndMaybeThumbnail(task, { cacheOnSuccess, generateThumbnail, cacheTimeoutMs });
    const refreshedTask = await prisma.videoTask.findUnique({ where: { id: taskId } });
    return {
      task: refreshedTask || task,
      statusRefreshed: false,
      terminal: isTerminalLocalStatus((refreshedTask || task).local_status),
      cacheResult: localResult.cacheResult,
      thumbnailResult: localResult.thumbnailResult,
      publicDeliveryResult: localResult.publicDeliveryResult,
    };
  }

  try {
    const statusResult = await getProviderTaskStatus(task);

    const updateData: Prisma.VideoTaskUncheckedUpdateInput = {
      provider_status: statusResult.provider_status,
      local_status: statusResult.local_status,
      raw_status_response: JSON.stringify(statusResult.raw),
    };
    addProviderBillingUpdate(updateData, statusResult);

    if (statusResult.result_video_url) {
      updateData.result_video_url = statusResult.result_video_url;
    }
    if (statusResult.result_last_frame_url) {
      updateData.result_last_frame_url = statusResult.result_last_frame_url;
    }
    if (statusResult.provider_model) {
      updateData.model = statusResult.provider_model;
    }
    if (statusResult.seed !== undefined) {
      updateData.seed = statusResult.seed;
    }
    if (statusResult.resolution) {
      updateData.resolution = statusResult.resolution;
    }
    if (statusResult.ratio) {
      updateData.ratio = statusResult.ratio;
    }
    if (statusResult.duration !== undefined) {
      updateData.duration = statusResult.duration;
    }
    const errorMessage = normalizeProviderErrorMessage(statusResult.error_message);
    if (errorMessage) {
      updateData.error_message = errorMessage;
    } else if (statusResult.local_status === 'succeeded') {
      updateData.error_message = null;
      updateData.error_code = null;
    }

    const isTerminal = isTerminalLocalStatus(statusResult.local_status);
    if (isTerminal && !task.completed_at) {
      updateData.completed_at = new Date();
    }

    await prisma.videoTask.update({
      where: { id: taskId },
      data: updateData,
    });

    if (isTerminal && task.user_id && task.frozen_cost && task.frozen_cost > 0) {
      await settleTask(taskId, task.user_id, task.frozen_cost, statusResult.local_status);
    }

    const createdBy = options.createdBy || task.user_id || task.owner_user_id || null;
    await recordOfficialProviderCharge(taskId, createdBy, statusResult);

    const updatedTask = await prisma.videoTask.findUnique({ where: { id: taskId } });
    let cacheResult: LocalVideoCacheResult | undefined;
    let thumbnailResult: EnsureTaskThumbnailResult | undefined;
    if (updatedTask && updatedTask.local_status === 'succeeded') {
      const localResult = await cacheAndMaybeThumbnail(updatedTask, { cacheOnSuccess, generateThumbnail, cacheTimeoutMs });
      cacheResult = localResult.cacheResult;
      thumbnailResult = localResult.thumbnailResult;
      const publicDeliveryResult = localResult.publicDeliveryResult;
      const finalTask = await prisma.videoTask.findUnique({ where: { id: taskId } });
      return {
        task: finalTask || updatedTask || task,
        statusRefreshed: true,
        terminal: isTerminalLocalStatus((finalTask || updatedTask || task).local_status),
        cacheResult,
        thumbnailResult,
        publicDeliveryResult,
      };
    }

    const finalTask = await prisma.videoTask.findUnique({ where: { id: taskId } });
    return {
      task: finalTask || updatedTask || task,
      statusRefreshed: true,
      terminal: isTerminalLocalStatus((finalTask || updatedTask || task).local_status),
      cacheResult,
      thumbnailResult,
    };
  } catch (error) {
    console.error('[VideoFinalizer] Provider status query error:', {
      taskId,
      error: error instanceof Error ? error.message : String(error),
    });

    const fallbackStatus = isTerminalLocalStatus(task.local_status) ? task.local_status : 'running';
    await prisma.videoTask.update({
      where: { id: taskId },
      data: {
        provider_status: 'unknown',
        local_status: fallbackStatus,
        raw_status_response: JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
      },
    });

    const updatedTask = await prisma.videoTask.findUnique({ where: { id: taskId } });
    return {
      task: updatedTask || task,
      statusRefreshed: false,
      terminal: isTerminalLocalStatus((updatedTask || task).local_status),
      providerError: error instanceof Error ? error.message : String(error),
    };
  }
}
