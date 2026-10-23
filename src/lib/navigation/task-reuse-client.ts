import { parseTaskReuseOperationRequest, taskReuseReceiptKey, type TaskReuseContext, type TaskReuseOperationRequest, type TaskReuseOperationStatus } from './task-reuse-intent';
import type { WorkspaceInputRecovery } from '@/lib/hooks/useWorkspace';
export type TaskReuseInputBackup = { version: 1; workspace: WorkspaceInputRecovery; fields: {
  prompt: string; generationMode: string; ratio: string; duration: number; resolution: string; seed: number;
  generateAudio: boolean; returnLastFrame: boolean; watermark: boolean; resolutionApprovalConfirmed: boolean;
  model: string; provider?: string; auxiliary?: string | null; projectId?: string; videoCardId?: string; videoBranchId?: string;
} };
export type TaskReuseClientRecord = { version: 2; accountId: string; sourceTaskId: string; operation: TaskReuseOperationRequest;
  context: TaskReuseContext; backup: TaskReuseInputBackup; serverStatus?: TaskReuseOperationStatus['status'] | 'read-only' };
const backupKey = (owner: string, tab: string) => `sd2:task-reuse-backup:v2:${JSON.stringify([owner, tab])}`;
export function parseTaskReuseClientRecord(raw: string | null, owner: string, taskId: string): TaskReuseClientRecord | null {
  if (!raw || raw.length > 180000) return null;
  try {
    const value = JSON.parse(raw) as TaskReuseClientRecord, operation = parseTaskReuseOperationRequest(value.operation);
    if (value.version !== 2 || value.accountId !== owner || value.sourceTaskId !== taskId || !operation
      || value.backup?.version !== 1 || value.backup.workspace?.ownerId !== owner || value.backup.workspace.tabId !== operation.tabId
      || value.backup.workspace.workspaceId !== operation.workspaceId || !Array.isArray(value.backup.workspace.items) || value.backup.workspace.items.length > 80
      || typeof value.backup.fields?.prompt !== 'string' || value.backup.fields.prompt.length > 20000
      || typeof value.backup.fields.model !== 'string' || !value.context || value.context.accountId !== owner || value.context.tabId !== operation.tabId) return null;
    return { ...value, operation };
  } catch { return null; }
}
export function saveTaskReuseClientRecord(value: TaskReuseClientRecord) {
  const key = taskReuseReceiptKey(value.accountId, value.operation.tabId, value.sourceTaskId), raw = JSON.stringify(value);
  // Either write failing refuses a new POST; an already written fence remains safe.
  localStorage.setItem(key, raw); sessionStorage.setItem(key, raw);
}
export function readTaskReuseClientRecord(owner: string, tab: string, taskId: string) {
  const key = taskReuseReceiptKey(owner, tab, taskId);
  return parseTaskReuseClientRecord(sessionStorage.getItem(key) || localStorage.getItem(key), owner, taskId);
}
export function finishTaskReuseClientRecord(value: TaskReuseClientRecord, status: TaskReuseOperationStatus['status'] | 'read-only') {
  const completed = { ...value, serverStatus: status };
  localStorage.setItem(backupKey(value.accountId, value.operation.tabId), JSON.stringify(completed));
  const key = taskReuseReceiptKey(value.accountId, value.operation.tabId, value.sourceTaskId);
  sessionStorage.removeItem(key); localStorage.removeItem(key);
  return completed;
}
export function readTaskReuseInputBackup(owner: string, tab: string) {
  const raw = localStorage.getItem(backupKey(owner, tab));
  if (!raw) return null;
  try { const value = JSON.parse(raw); return typeof value?.sourceTaskId === 'string' ? parseTaskReuseClientRecord(raw, owner, value.sourceTaskId)?.backup || null : null; } catch { return null; }
}
export function taskReuseOperationQuery(operation: TaskReuseOperationRequest) {
  return new URLSearchParams(Object.fromEntries(['requestId', 'nonce', 'requestHash', 'surface', 'tabId', 'workspaceId'].map(key => [key, String(operation[key as keyof TaskReuseOperationRequest])])));
}
export function sameTaskReuseResultItems(expected: unknown, actual: Array<{ id: string; assetId: string; referenceImageId?: string | null; role?: string | null; sortOrder: number }>) {
  if (!Array.isArray(expected) || expected.length !== actual.length) return false;
  const project = (items: typeof actual) => [...items].sort((a, b) => a.id.localeCompare(b.id)).map(item => [item.id, item.assetId, item.referenceImageId || null, item.role || null, item.sortOrder]);
  return JSON.stringify(project(expected)) === JSON.stringify(project(actual));
}
