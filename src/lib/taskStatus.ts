import type { LocalStatus } from '@/types';

/**
 * Map provider status to local status
 * TODO: Adjust mapping based on actual API documentation
 */

const PROVIDER_TO_LOCAL_STATUS_MAP: Record<string, LocalStatus> = {
  // Draft / Initial
  draft: 'draft',
  pending: 'submitted',

  // Submitted / Queued
  submitted: 'submitted',
  queued: 'submitted',
  waiting: 'submitted',
  init: 'submitted',

  // Processing / Running
  processing: 'running',
  running: 'running',
  generating: 'running',
  in_progress: 'running',
  progress: 'running',

  // Success states
  succeeded: 'succeeded',
  success: 'succeeded',
  completed: 'succeeded',
  done: 'succeeded',
  finished: 'succeeded',
  ready: 'succeeded',

  // Failed states
  failed: 'failed',
  error: 'failed',
  failure: 'failed',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  aborted: 'cancelled',

  // Timeout
  timeout: 'failed',
};

/**
 * Map provider status string to local status
 */
export function mapProviderStatus(providerStatus: string): LocalStatus {
  const normalizedStatus = providerStatus.toLowerCase().trim();
  return PROVIDER_TO_LOCAL_STATUS_MAP[normalizedStatus] ?? 'running';
}

/**
 * Check if a local status is terminal (no more updates expected)
 */
export function isTerminalStatus(status: LocalStatus): boolean {
  return ['succeeded', 'failed', 'cancelled'].includes(status);
}

/**
 * Check if task is still in progress
 */
export function isInProgress(status: LocalStatus): boolean {
  return ['submitted', 'running'].includes(status);
}

/**
 * Get status display text
 */
export function getStatusDisplayText(status: LocalStatus): string {
  const displayMap: Record<LocalStatus, string> = {
    draft: '草稿',
    submitted: '已提交',
    running: '生成中',
    succeeded: '已完成',
    failed: '失败',
    cancelled: '已取消',
  };
  return displayMap[status] ?? status;
}

/**
 * Get status color class for Tailwind (or similar)
 */
export function getStatusColor(status: LocalStatus): string {
  const colorMap: Record<LocalStatus, string> = {
    draft: 'bg-gray-100 text-gray-800',
    submitted: 'bg-blue-100 text-blue-800',
    running: 'bg-yellow-100 text-yellow-800',
    succeeded: 'bg-green-100 text-green-800',
    failed: 'bg-red-100 text-red-800',
    cancelled: 'bg-gray-100 text-gray-600',
  };
  return colorMap[status] ?? 'bg-gray-100 text-gray-800';
}
